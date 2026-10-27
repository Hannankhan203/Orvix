import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import Tesseract from 'tesseract.js';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Detects whether running in a serverless cloud environment (Vercel, AWS Lambda)
 */
export const isServerlessRuntime = Boolean(
  process.env.VERCEL ||
  process.env.AWS_LAMBDA_FUNCTION_NAME ||
  process.env.LAMBDA_TASK_ROOT ||
  process.env.SERVERLESS
);

// Reasonable processing limits: generous locally (when CPU is shared with Ollama), bounded in serverless
const OCR_WORKER_TIMEOUT_MS = isServerlessRuntime ? 8000 : 30000;
const OCR_RECOGNIZE_TIMEOUT_MS = isServerlessRuntime ? 15000 : 60000;
const VISION_TIMEOUT_MS = 4000; // Fast 4s Gemini Vision limit so offline fallback is immediate
const MAX_PREVIEW_LENGTH = 350;
const MAX_IMAGE_FILE_SIZE = 25 * 1024 * 1024; // 25MB
const MIN_VALID_TRAINEDDATA_BYTES = 100 * 1024; // >100KB sanity check (eng.traineddata is ~5.2MB)

export const LOCAL_OCR_INIT_ERROR_MESSAGE =
  'Offline image text extraction is unavailable because the local OCR engine could not be initialized.';

let workerInstance = null;
let initializingPromise = null;
let ocrQueue = Promise.resolve();
let activeWorkerErrorReject = null;

/**
 * Resolves local traineddata file info (directory + whether file is gzipped).
 * Checks project root, parent directories, public assets, and container root.
 * Validates file size so corrupted/0-byte files are never treated as valid.
 *
 * @returns {{ dir: string, gzip: boolean } | null}
 */
export function resolveLocalTrainedDataInfo() {
  const candidateDirs = [
    process.cwd(),
    path.resolve(__dirname, '../..'),
    path.resolve(__dirname, '..'),
    path.resolve(process.cwd(), 'public'),
    '/'
  ];

  const seenDirs = new Set();
  for (const dir of candidateDirs) {
    const resolvedDir = path.resolve(dir);
    if (seenDirs.has(resolvedDir)) continue;
    seenDirs.add(resolvedDir);

    const rawPath = path.join(resolvedDir, 'eng.traineddata');
    try {
      if (fs.existsSync(rawPath)) {
        const stat = fs.statSync(rawPath);
        if (stat.isFile() && stat.size >= MIN_VALID_TRAINEDDATA_BYTES) {
          return { dir: resolvedDir, gzip: false };
        }
      }
    } catch (_) {}

    const gzPath = path.join(resolvedDir, 'eng.traineddata.gz');
    try {
      if (fs.existsSync(gzPath)) {
        const stat = fs.statSync(gzPath);
        if (stat.isFile() && stat.size >= MIN_VALID_TRAINEDDATA_BYTES) {
          return { dir: resolvedDir, gzip: true };
        }
      }
    } catch (_) {}
  }

  return null;
}

/**
 * Resolves the directory where local eng.traineddata is stored.
 * Preserved for backwards compatibility.
 */
export function findLocalTrainedDataDir() {
  const info = resolveLocalTrainedDataInfo();
  return info ? info.dir : null;
}

/**
 * Resolves and verifies all local Tesseract.js runtime assets (worker script, WASM core directory,
 * and local English traineddata) so Tesseract NEVER attempts any remote CDN or network download.
 *
 * @returns {{ workerPath: string, corePath: string, langPath: string, gzip: boolean }}
 */
export function resolveLocalTesseractAssets() {
  // 1. Resolve local language data (eng.traineddata)
  const trainedData = resolveLocalTrainedDataInfo();
  if (!trainedData) {
    const err = new Error(LOCAL_OCR_INIT_ERROR_MESSAGE);
    err.code = 'LOCAL_OCR_INIT_FAILED';
    err.cause = 'Local eng.traineddata was not found or is invalid.';
    throw err;
  }

  // 2. Resolve local Node worker script from installed tesseract.js package
  let workerPath = null;
  const workerCandidates = [];
  try {
    workerCandidates.push(require.resolve('tesseract.js/src/worker-script/node/index.js'));
  } catch (_) {}
  workerCandidates.push(
    path.resolve(process.cwd(), 'node_modules/tesseract.js/src/worker-script/node/index.js'),
    path.resolve(__dirname, '../../node_modules/tesseract.js/src/worker-script/node/index.js')
  );

  for (const candidate of workerCandidates) {
    try {
      if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        workerPath = candidate;
        break;
      }
    } catch (_) {}
  }

  if (!workerPath) {
    const err = new Error(LOCAL_OCR_INIT_ERROR_MESSAGE);
    err.code = 'LOCAL_OCR_INIT_FAILED';
    err.cause = 'Local tesseract.js worker script was not found.';
    throw err;
  }

  // 3. Resolve local WASM core directory from installed tesseract.js-core package
  let corePath = null;
  const coreCandidates = [];
  try {
    coreCandidates.push(path.dirname(require.resolve('tesseract.js-core/package.json')));
  } catch (_) {}
  coreCandidates.push(
    path.resolve(process.cwd(), 'node_modules/tesseract.js-core'),
    path.resolve(__dirname, '../../node_modules/tesseract.js-core')
  );

  for (const candidate of coreCandidates) {
    try {
      if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        const files = fs.readdirSync(candidate);
        const hasWasm = files.some((f) => f.startsWith('tesseract-core') && (f.endsWith('.wasm') || f.endsWith('.wasm.js')));
        if (hasWasm) {
          corePath = candidate;
          break;
        }
      }
    } catch (_) {}
  }

  if (!corePath) {
    const err = new Error(LOCAL_OCR_INIT_ERROR_MESSAGE);
    err.code = 'LOCAL_OCR_INIT_FAILED';
    err.cause = 'Local tesseract.js-core WASM files were not found.';
    throw err;
  }

  return {
    workerPath,
    corePath,
    langPath: trainedData.dir,
    gzip: trainedData.gzip
  };
}

/**
 * Initializes and returns a shared, managed local Tesseract worker instance with strict offline asset paths.
 * Uses local workerPath, local corePath, local langPath, gzip=false (for raw eng.traineddata),
 * and cacheMethod='none' to avoid remote CDN requests and avoid temp-cache corruption.
 */
export async function getWorker(timeoutMs = OCR_WORKER_TIMEOUT_MS) {
  if (workerInstance) {
    return workerInstance;
  }

  if (initializingPromise) {
    return initializingPromise;
  }

  const assets = resolveLocalTesseractAssets();

  initializingPromise = (async () => {
    let timeoutId = null;
    let candidateWorker = null;

    try {
      const workerErrorPromise = new Promise((_, reject) => {
        activeWorkerErrorReject = (rawErr) => {
          const initErr = new Error(LOCAL_OCR_INIT_ERROR_MESSAGE);
          initErr.code = 'LOCAL_OCR_INIT_FAILED';
          initErr.cause = rawErr?.message || String(rawErr || 'Worker reported an error during initialization');
          reject(initErr);
        };
      });

      const workerPromise = Tesseract.createWorker('eng', 1, {
        workerPath: assets.workerPath,
        corePath: assets.corePath,
        langPath: assets.langPath,
        gzip: assets.gzip,
        cacheMethod: 'none',
        errorHandler: (err) => {
          console.warn('[Image OCR Worker Error]', err?.message || err);
          if (typeof activeWorkerErrorReject === 'function') {
            const rejectFn = activeWorkerErrorReject;
            activeWorkerErrorReject = null;
            rejectFn(err);
          }
        }
      }).then(async (w) => {
        candidateWorker = w;
        try {
          await w.setParameters({
            preserve_interword_spaces: '1',
            tessjs_create_hocr: '0',
            tessjs_create_tsv: '0',
            tessjs_create_box: '0',
            tessjs_create_unlv: '0',
            tessjs_create_osd: '0'
          });
        } catch (_) {}
        return w;
      });

      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          const timeoutErr = new Error(LOCAL_OCR_INIT_ERROR_MESSAGE);
          timeoutErr.code = 'LOCAL_OCR_INIT_FAILED';
          timeoutErr.cause = `Tesseract worker initialization timed out (${timeoutMs}ms limit).`;
          reject(timeoutErr);
        }, timeoutMs);
      });

      const worker = await Promise.race([workerPromise, workerErrorPromise, timeoutPromise]);
      workerInstance = worker;
      return workerInstance;
    } catch (workerErr) {
      console.warn('[Image OCR Worker Init Error]:', workerErr?.cause || workerErr?.message || workerErr);
      if (candidateWorker) {
        try {
          await candidateWorker.terminate();
        } catch (_) {}
      }
      const wrapped = new Error(LOCAL_OCR_INIT_ERROR_MESSAGE);
      wrapped.code = 'LOCAL_OCR_INIT_FAILED';
      wrapped.cause = workerErr?.cause || workerErr?.message || String(workerErr);
      throw wrapped;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      activeWorkerErrorReject = null;
      initializingPromise = null;
    }
  })();

  return initializingPromise;
}

/**
 * Safely discards the worker instance if it becomes unresponsive or corrupted.
 */
export async function discardOcrWorker() {
  activeWorkerErrorReject = null;
  if (workerInstance) {
    const worker = workerInstance;
    workerInstance = null;
    try {
      await worker.terminate();
    } catch (_) {}
  }
}

/**
 * Counts words in a string
 * @param {string} text
 * @returns {number}
 */
export function countWords(text) {
  if (!text) return 0;
  const matches = text.trim().match(/\S+/g);
  return matches ? matches.length : 0;
}

/**
 * Generates a clean preview snippet
 * @param {string} text
 * @returns {string}
 */
export function generateSummaryPreview(text) {
  if (!text) return '';
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= MAX_PREVIEW_LENGTH) return clean;
  return clean.slice(0, MAX_PREVIEW_LENGTH).trim() + '...';
}

/**
 * Normalizes raw OCR text:
 * - Unifies newline variations (\r\n -> \n)
 * - Removes non-printable control characters except tab and newline
 * - Trims trailing whitespace on each line
 * - Collapses 3+ consecutive newlines into 2 (preserves paragraphs)
 * - Trims leading and trailing whitespace
 *
 * @param {string} rawText
 * @returns {string}
 */
/**
 * Validates that an image buffer begins with a recognized, valid image container signature.
 * Prevents feeding malformed or non-image payloads to cloud vision or Leptonica WASM.
 *
 * @param {Buffer} buffer
 * @param {string} [ext] - Optional extension hint (e.g. '.png')
 * @returns {{ valid: boolean, format?: string, error?: string }}
 */
export function validateImageBuffer(buffer, ext = '') {
  if (!Buffer.isBuffer(buffer)) {
    return { valid: false, error: 'Expected image data as a Buffer.' };
  }

  if (buffer.length < 4) {
    return { valid: false, error: 'Image file is too small or truncated (< 4 bytes).' };
  }

  // 1. JPEG: 0xFF, 0xD8, 0xFF
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { valid: true, format: 'JPEG' };
  }

  // 2. PNG: 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return { valid: true, format: 'PNG' };
  }

  // 3. GIF: GIF87a or GIF89a
  if (
    buffer.length >= 6 &&
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x38 &&
    (buffer[4] === 0x37 || buffer[4] === 0x39) &&
    buffer[5] === 0x61
  ) {
    return { valid: true, format: 'GIF' };
  }

  // 4. WebP: RIFF....WEBP
  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return { valid: true, format: 'WEBP' };
  }

  // 5. BMP: 'BM'
  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return { valid: true, format: 'BMP' };
  }

  // 6. TIFF: II*\0 or MM\0*
  if (
    buffer.length >= 4 &&
    ((buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2a && buffer[3] === 0x00) ||
      (buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00 && buffer[3] === 0x2a))
  ) {
    return { valid: true, format: 'TIFF' };
  }

  // 7. HEIC / HEIF: ISOBMFF ftyp box
  if (buffer.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp') {
    return { valid: true, format: 'HEIC' };
  }

  return {
    valid: false,
    error: 'Corrupted or unreadable image file: invalid image header signature (expected JPEG, PNG, WebP, GIF, BMP, or TIFF).'
  };
}

/**
 * Converts raw pixel data (RGB, RGBA, or Grayscale) into a valid 24-bit uncompressed BMP Buffer.
 * Fully compatible with Tesseract.js, Leptonica, and validateImageBuffer.
 *
 * @param {number} width - Image width in pixels
 * @param {number} height - Image height in pixels
 * @param {number} channels - Number of color channels (1 = grayscale, 3 = RGB, 4 = RGBA)
 * @param {Uint8Array|Uint8ClampedArray|Buffer} data - Raw pixel bytes
 * @returns {Buffer|null} 24-bit BMP Buffer or null if parameters are invalid
 */
export function rawImageDataToBmp(width, height, channels, data) {
  if (!width || !height || !data || width <= 0 || height <= 0 || data.length === 0) {
    return null;
  }

  const validChannels = [1, 3, 4].includes(channels) ? channels : Math.round(data.length / (width * height));
  if (![1, 3, 4].includes(validChannels)) {
    return null;
  }

  // Each row in 24-bit BMP must be aligned to a 4-byte boundary
  const rowSize = Math.floor((24 * width + 31) / 32) * 4;
  const pixelArraySize = rowSize * height;
  const fileSize = 54 + pixelArraySize;
  const buf = Buffer.alloc(fileSize);

  // 1. BMP File Header (14 bytes)
  buf.write('BM', 0); // 'BM' signature
  buf.writeUInt32LE(fileSize, 2); // File size
  buf.writeUInt16LE(0, 6); // Reserved 1
  buf.writeUInt16LE(0, 8); // Reserved 2
  buf.writeUInt32LE(54, 10); // Offset to pixel array

  // 2. DIB Header (BITMAPINFOHEADER - 40 bytes)
  buf.writeUInt32LE(40, 14); // Header size
  buf.writeInt32LE(width, 18); // Image width
  buf.writeInt32LE(height, 22); // Image height (positive = bottom-up)
  buf.writeUInt16LE(1, 26); // Color planes
  buf.writeUInt16LE(24, 28); // Bits per pixel (24-bit RGB)
  buf.writeUInt32LE(0, 30); // Compression (0 = BI_RGB uncompressed)
  buf.writeUInt32LE(pixelArraySize, 34); // Image size
  buf.writeInt32LE(2835, 38); // Horizontal resolution (~72 DPI)
  buf.writeInt32LE(2835, 42); // Vertical resolution (~72 DPI)
  buf.writeUInt32LE(0, 46); // Colors in palette
  buf.writeUInt32LE(0, 50); // Important colors

  // 3. Pixel Array (Bottom-up BGR scanlines)
  for (let y = 0; y < height; y++) {
    const srcY = height - 1 - y; // Bottom-up row mapping
    const destRowOffset = 54 + y * rowSize;

    for (let x = 0; x < width; x++) {
      const srcIdx = (srcY * width + x) * validChannels;
      let r, g, b;

      if (validChannels === 1) {
        r = g = b = data[srcIdx];
      } else if (validChannels === 3) {
        r = data[srcIdx];
        g = data[srcIdx + 1];
        b = data[srcIdx + 2];
      } else if (validChannels === 4) {
        const a = (data[srcIdx + 3] ?? 255) / 255;
        // Alpha blend over white background (ideal for document text OCR)
        r = Math.round(data[srcIdx] * a + 255 * (1 - a));
        g = Math.round(data[srcIdx + 1] * a + 255 * (1 - a));
        b = Math.round(data[srcIdx + 2] * a + 255 * (1 - a));
      } else {
        r = g = b = data[srcIdx] || 0;
      }

      const destIdx = destRowOffset + x * 3;
      buf[destIdx] = b; // Blue
      buf[destIdx + 1] = g; // Green
      buf[destIdx + 2] = r; // Red
    }
  }

  return buf;
}

/**
 * Normalizes raw OCR text:
 * - Unifies newline variations (\r\n -> \n)
 * - Converts form-feed (\f) to paragraph breaks
 * - Removes non-printable control characters except tab and newline
 * - Strips zero-width characters and soft hyphens
 * - Trims trailing whitespace on each line
 * - Collapses 3+ consecutive newlines into 2 (preserves paragraphs)
 * - Trims leading and trailing whitespace
 *
 * @param {string} rawText
 * @returns {string}
 */
export function normalizeOcrText(rawText) {
  if (!rawText || typeof rawText !== 'string') return '';

  // Standardize line endings and form-feed page/section breaks
  let text = rawText
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\f/g, '\n\n')
    .replace(/[\u200B\uFEFF\u00AD]/g, '');

  // Strip non-printable ASCII control codes (retain \t and \n)
  text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  // Trim trailing whitespace from each line
  const lines = text.split('\n').map((line) => line.trimEnd());

  // Collapse 3 or more consecutive newlines into 2
  const normalized = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();

  return normalized;
}

/**
 * Determines whether the extracted text represents meaningful readable content
 * rather than sparse noise, lone punctuation artifacts, or speckles.
 *
 * @param {string} text - Normalized text
 * @param {number} [confidence=0] - Confidence score (0-100)
 * @returns {boolean}
 */
export function detectReadableText(text, confidence = 0) {
  if (!text || typeof text !== 'string') return false;

  const trimmed = text.trim();
  if (trimmed.length === 0) return false;

  // Extract all alphanumeric and extended Latin/accented characters
  const alphanumericChars = trimmed.match(/[a-zA-Z0-9\u00C0-\u024F\u1E00-\u1EFF]/g);
  if (!alphanumericChars || alphanumericChars.length === 0) {
    return false;
  }

  // If only 1 alphanumeric character was detected with low confidence, treat as noise
  if (alphanumericChars.length === 1 && confidence > 0 && confidence < 40) {
    return false;
  }

  return true;
}

/**
 * Checks whether an error from Gemini Vision indicates offline / unreachable network / timeout
 * so we break immediately and fall through to local Tesseract OCR without retrying extra cloud models.
 */
function isNetworkOrOfflineVisionError(err) {
  const errMsg = String(err?.message || err || '').toLowerCase();
  const causeMsg = String(err?.cause?.message || '').toLowerCase();
  const combined = `${errMsg} ${causeMsg}`;
  const causeCode = String(err?.cause?.code || err?.code || '').toUpperCase();

  if (
    combined.includes('fetch failed') ||
    combined.includes('enotfound') ||
    combined.includes('eai_again') ||
    combined.includes('enetunreach') ||
    combined.includes('ehostunreach') ||
    combined.includes('econnrefused') ||
    combined.includes('econnreset') ||
    combined.includes('econnaborted') ||
    combined.includes('etimedout') ||
    combined.includes('err_internet_disconnected') ||
    combined.includes('timed out') ||
    combined.includes('abort') ||
    combined.includes('network') ||
    combined.includes('socket') ||
    [
      'ENOTFOUND',
      'EAI_AGAIN',
      'ENETUNREACH',
      'EHOSTUNREACH',
      'ECONNREFUSED',
      'ECONNRESET',
      'ECONNABORTED',
      'ETIMEDOUT',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_HEADERS_TIMEOUT',
      'UND_ERR_SOCKET'
    ].includes(causeCode)
  ) {
    return true;
  }
  return false;
}

/**
 * Vision-capable AI extraction using Gemini Vision.
 * Extremely fast and accurate when online; aborts immediately on offline/network errors.
 *
 * @param {Buffer} imageBuffer
 * @param {string} mimeType
 * @param {string|null} [apiKey]
 * @returns {Promise<{ hasText: boolean, text: string } | null>}
 */
export async function extractImageTextWithGeminiVision(imageBuffer, mimeType = 'image/jpeg', apiKey = null) {
  const key = apiKey || process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY;
  if (!key || key === 'MY_GEMINI_API_KEY') {
    return null;
  }

  try {
    const { GoogleGenAI } = await import('@google/genai');
    const ai = new GoogleGenAI({
      apiKey: key,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build'
        }
      }
    });

    const base64Data = imageBuffer.toString('base64');
    const cleanMime = mimeType && mimeType.startsWith('image/') ? mimeType : 'image/jpeg';

    const candidateModels = ['gemini-flash-latest', 'gemini-3.8-flash', 'gemini-3.1-flash-lite'];

    for (const model of candidateModels) {
      let timer = null;
      const abortController = new AbortController();
      try {
        const visionPromise = ai.models.generateContent({
          model,
          contents: [
            {
              parts: [
                {
                  inlineData: {
                    mimeType: cleanMime,
                    data: base64Data
                  }
                },
                {
                  text: 'Transcribe and extract all readable text, words, and numbers from this image exactly as written. Preserve line breaks. If there is no readable text or words in this image, reply with ONLY: NO_READABLE_TEXT'
                }
              ]
            }
          ],
          config: {
            abortSignal: abortController.signal
          }
        });

        const timeoutPromise = new Promise((_, reject) => {
          timer = setTimeout(() => {
            try {
              abortController.abort();
            } catch (_) {}
            reject(new Error(`Vision call timed out after ${VISION_TIMEOUT_MS / 1000}s`));
          }, VISION_TIMEOUT_MS);
        });

        const response = await Promise.race([visionPromise, timeoutPromise]);
        if (timer) clearTimeout(timer);

        const rawOutput = response?.text || '';
        if (!rawOutput || rawOutput.trim() === 'NO_READABLE_TEXT' || rawOutput.includes('NO_READABLE_TEXT')) {
          return {
            hasText: false,
            text: ''
          };
        }

        const normalized = normalizeOcrText(rawOutput);
        const hasText = detectReadableText(normalized, 95);
        return {
          hasText,
          text: normalized
        };
      } catch (err) {
        if (timer) clearTimeout(timer);
        try {
          abortController.abort();
        } catch (_) {}
        console.warn(`[Gemini Vision candidate ${model}]:`, err?.message || err);
        if (isNetworkOrOfflineVisionError(err)) {
          // Offline / DNS unreachable / connection timeout: fall through immediately to local Tesseract OCR
          break;
        }
      }
    }
    return null;
  } catch (err) {
    console.warn('[Gemini Vision Extraction Error]:', err?.message || err);
    return null;
  }
}

/**
 * Executes server-side OCR on an image file with online Gemini Vision priority and
 * fully offline-capable local Tesseract.js fallback.
 *
 * Priority:
 * 1. Online + Gemini Vision configured/reachable (and not explicitly offline) -> Gemini Vision OCR
 * 2. Offline or Gemini Vision unreachable/unavailable -> Local Tesseract.js OCR using bundled assets
 *
 * @param {string|Buffer} filePathOrBuffer - Absolute path or Buffer of image bytes
 * @param {string} originalName - Original filename for metadata
 * @param {string} ext - Extension including dot (e.g. '.png')
 * @param {string} mimeType - Declared MIME type
 * @param {string} [fileId] - Unique attachment ID
 * @param {{ width?: number, height?: number }} [dimensions] - Pre-parsed dimensions
 * @param {string|null} [apiKey] - Optional Gemini API key for vision
 * @param {{ offline?: boolean, preferLocal?: boolean }} [options] - Optional execution hints
 * @returns {Promise<Object>}
 */
export async function extractImageText(
  filePathOrBuffer,
  originalName,
  ext = '',
  mimeType = 'image/jpeg',
  fileId = '',
  dimensions = undefined,
  apiKey = null,
  options = {}
) {
  const isOfflineHint = Boolean(options?.offline || options?.preferLocal);
  const isBuf = Buffer.isBuffer(filePathOrBuffer);
  const displayFilename = isBuf
    ? originalName || 'image'
    : path.basename(typeof filePathOrBuffer === 'string' ? filePathOrBuffer : 'image');
  const normalizedExt = (ext || (isBuf ? '' : path.extname(String(filePathOrBuffer || '')))).toLowerCase();
  const formatName = normalizedExt.replace('.', '').toUpperCase() || 'IMAGE';
  const nowIso = new Date().toISOString();

  // 1. Check for formats that require native codecs (e.g. HEIC / HEIF)
  if (normalizedExt === '.heic' || normalizedExt === '.heif' || mimeType.includes('heic') || mimeType.includes('heif')) {
    return {
      fileId,
      filename: displayFilename,
      originalName,
      format: formatName,
      mimeType,
      dimensions,
      status: 'unsupported_format',
      success: false,
      isImage: true,
      hasText: false,
      text: '',
      totalCharacters: 0,
      totalWords: 0,
      error: 'HEIC/HEIF format cannot be processed for OCR offline. Please convert the image to PNG or JPEG.',
      warning: 'HEIC/HEIF uploaded. OCR text extraction requires standard JPEG/PNG/WebP format.',
      extractedAt: nowIso
    };
  }

  // 2. Resolve image buffer
  let imageBuffer = null;
  let imageSize = 0;

  if (isBuf) {
    imageBuffer = filePathOrBuffer;
    imageSize = imageBuffer.length;
  } else {
    const diskPath = String(filePathOrBuffer || '');
    try {
      imageBuffer = await fs.promises.readFile(diskPath);
      imageSize = imageBuffer.length;
    } catch (err) {
      return {
        fileId,
        filename: displayFilename,
        originalName,
        format: formatName,
        mimeType,
        dimensions,
        status: 'error',
        success: false,
        isImage: true,
        hasText: false,
        text: '',
        totalCharacters: 0,
        totalWords: 0,
        error: `Could not read image file: ${err?.message || 'File not found'}`,
        extractedAt: nowIso
      };
    }
  }

  if (!imageBuffer || imageSize === 0) {
    return {
      fileId,
      filename: displayFilename,
      originalName,
      format: formatName,
      mimeType,
      sizeBytes: 0,
      dimensions,
      status: 'error',
      success: false,
      isImage: true,
      hasText: false,
      text: '',
      totalCharacters: 0,
      totalWords: 0,
      error: 'Image file is empty (0 bytes).',
      extractedAt: nowIso
    };
  }

  if (imageSize > MAX_IMAGE_FILE_SIZE) {
    return {
      fileId,
      filename: displayFilename,
      originalName,
      format: formatName,
      mimeType,
      sizeBytes: imageSize,
      dimensions,
      status: 'error',
      success: false,
      isImage: true,
      hasText: false,
      text: '',
      totalCharacters: 0,
      totalWords: 0,
      error: `Image exceeds ${Math.round(MAX_IMAGE_FILE_SIZE / (1024 * 1024))}MB limit for OCR extraction.`,
      extractedAt: nowIso
    };
  }

  // 3. Validate image buffer header signature
  const bufferValidation = validateImageBuffer(imageBuffer, normalizedExt);
  if (!bufferValidation.valid) {
    return {
      fileId,
      filename: displayFilename,
      originalName,
      format: formatName,
      mimeType,
      sizeBytes: imageSize,
      dimensions,
      status: 'error',
      success: false,
      isImage: true,
      hasText: false,
      text: '',
      totalCharacters: 0,
      totalWords: 0,
      error: bufferValidation.error || 'Corrupted or unreadable image file: invalid image header signature.',
      message: bufferValidation.error || 'Corrupted or unreadable image file: invalid image header signature.',
      extractedAt: nowIso
    };
  }

  // 4. PRIORITY 1: Gemini Vision AI when online and configured
  // Skipped immediately when client reports offline/preferLocal so zero cloud calls are made offline.
  const geminiKey = apiKey || process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY;
  if (!isOfflineHint && geminiKey && geminiKey !== 'MY_GEMINI_API_KEY') {
    try {
      const visionResult = await extractImageTextWithGeminiVision(imageBuffer, mimeType, geminiKey);
      if (visionResult) {
        if (visionResult.hasText) {
          const vText = visionResult.text;
          return {
            fileId,
            filename: displayFilename,
            originalName,
            format: formatName,
            mimeType,
            sizeBytes: imageSize,
            dimensions,
            status: 'ready',
            success: true,
            isImage: true,
            hasText: true,
            text: vText,
            ocrEngine: 'gemini-vision',
            summaryText: generateSummaryPreview(vText),
            totalCharacters: vText.length,
            totalWords: countWords(vText),
            lineCount: vText.split('\n').filter((l) => l.trim().length > 0).length,
            confidence: 95,
            extractedAt: nowIso
          };
        } else {
          return {
            fileId,
            filename: displayFilename,
            originalName,
            format: formatName,
            mimeType,
            sizeBytes: imageSize,
            dimensions,
            status: 'NO_TEXT_DETECTED',
            success: true,
            isImage: true,
            hasText: false,
            text: '',
            ocrEngine: 'gemini-vision',
            summaryText: '',
            totalCharacters: 0,
            totalWords: 0,
            lineCount: 0,
            confidence: 0,
            message: 'No readable text detected in this image.',
            extractedAt: nowIso
          };
        }
      }
    } catch (visionErr) {
      console.warn('[Gemini Vision Priority Error, falling back to local Tesseract OCR]:', visionErr?.message || visionErr);
    }
  }

  // 5. PRIORITY 2: Local Tesseract.js OCR using strictly bundled local assets (100% offline)
  return new Promise((resolve) => {
    ocrQueue = ocrQueue
      .catch(() => {})
      .then(async () => {
        let timeoutId = null;

        try {
          const worker = await getWorker(OCR_WORKER_TIMEOUT_MS);

          const recognizeErrorPromise = new Promise((_, reject) => {
            activeWorkerErrorReject = (rawErr) => {
              reject(new Error(rawErr?.message || String(rawErr || 'Local OCR worker recognition error')));
            };
          });

          const timeoutPromise = new Promise((_, reject) => {
            timeoutId = setTimeout(() => {
              reject(new Error(`Local OCR recognition timed out (${Math.round(OCR_RECOGNIZE_TIMEOUT_MS / 1000)}s limit).`));
            }, OCR_RECOGNIZE_TIMEOUT_MS);
          });

          const recognitionPromise = worker.recognize(imageBuffer);
          const ocrResult = await Promise.race([recognitionPromise, recognizeErrorPromise, timeoutPromise]);

          if (timeoutId) clearTimeout(timeoutId);
          activeWorkerErrorReject = null;

          const rawText = ocrResult?.data?.text || '';
          const confidence = Math.round(ocrResult?.data?.confidence || 0);
          const normalizedText = normalizeOcrText(rawText);
          const hasText = detectReadableText(normalizedText, confidence);

          if (hasText) {
            const totalCharacters = normalizedText.length;
            const totalWords = countWords(normalizedText);
            const lineCount = normalizedText.split('\n').filter((l) => l.trim().length > 0).length;
            const summaryText = generateSummaryPreview(normalizedText);

            return resolve({
              fileId,
              filename: displayFilename,
              originalName,
              format: formatName,
              mimeType,
              sizeBytes: imageSize,
              dimensions,
              status: 'ready',
              success: true,
              isImage: true,
              hasText: true,
              text: normalizedText,
              ocrEngine: 'tesseract-local',
              summaryText,
              totalCharacters,
              totalWords,
              lineCount,
              confidence,
              extractedAt: nowIso
            });
          }

          // Confirmed no readable text in image
          return resolve({
            fileId,
            filename: displayFilename,
            originalName,
            format: formatName,
            mimeType,
            sizeBytes: imageSize,
            dimensions,
            status: 'NO_TEXT_DETECTED',
            success: true,
            isImage: true,
            hasText: false,
            text: '',
            ocrEngine: 'tesseract-local',
            summaryText: '',
            totalCharacters: 0,
            totalWords: 0,
            lineCount: 0,
            confidence: 0,
            message: 'No readable text detected in this image.',
            extractedAt: nowIso
          });
        } catch (ocrErr) {
          if (timeoutId) clearTimeout(timeoutId);
          activeWorkerErrorReject = null;
          await discardOcrWorker();
          console.warn('[Local Tesseract OCR Error]:', ocrErr?.cause || ocrErr?.message || ocrErr);

          // In serverless runtime when no Gemini key was configured and local OCR cannot run,
          // keep serverless image upload non-fatal while surfacing a clear OCR notice if queried.
          const isInitFailure =
            ocrErr?.code === 'LOCAL_OCR_INIT_FAILED' ||
            String(ocrErr?.message || '').includes(LOCAL_OCR_INIT_ERROR_MESSAGE);

          const isTimeout = String(ocrErr?.message || '').includes('timed out');

          let clearErrorMessage = LOCAL_OCR_INIT_ERROR_MESSAGE;
          if (isInitFailure) {
            clearErrorMessage = LOCAL_OCR_INIT_ERROR_MESSAGE;
          } else if (isTimeout) {
            clearErrorMessage = ocrErr?.message || `Local OCR recognition timed out (${Math.round(OCR_RECOGNIZE_TIMEOUT_MS / 1000)}s limit).`;
          } else {
            clearErrorMessage = `Local OCR recognition failed: ${ocrErr?.message || 'Recognition failed'}`;
          }

          return resolve({
            fileId,
            filename: displayFilename,
            originalName,
            format: formatName,
            mimeType,
            sizeBytes: imageSize,
            dimensions,
            status: 'error',
            success: false,
            isImage: true,
            hasText: false,
            text: '',
            ocrEngine: 'tesseract-local',
            summaryText: '',
            totalCharacters: 0,
            totalWords: 0,
            lineCount: 0,
            confidence: 0,
            error: clearErrorMessage,
            message: clearErrorMessage,
            extractedAt: nowIso
          });
        }
      });
  });
}
