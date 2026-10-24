import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import Tesseract from 'tesseract.js';

// Reasonable processing limits
const OCR_WORKER_TIMEOUT_MS = 4000; // 4s worker initialization limit
const OCR_RECOGNIZE_TIMEOUT_MS = 6000; // 6s recognition limit
const VISION_TIMEOUT_MS = 6000; // 6s Gemini Vision limit
const MAX_PREVIEW_LENGTH = 350;
const MAX_IMAGE_FILE_SIZE = 25 * 1024 * 1024; // 25MB

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let workerInstance = null;
let initializingPromise = null;
let ocrQueue = Promise.resolve();

/**
 * Detects whether running in a serverless cloud environment (Vercel, AWS Lambda)
 */
export const isServerlessRuntime = Boolean(
  process.env.VERCEL ||
  process.env.AWS_LAMBDA_FUNCTION_NAME ||
  process.env.LAMBDA_TASK_ROOT ||
  process.env.SERVERLESS
);

/**
 * Resolves the directory where local eng.traineddata is stored.
 * Checks project root, parent directories, and common container paths.
 */
export function findLocalTrainedDataDir() {
  const possiblePaths = [
    path.resolve(process.cwd(), 'eng.traineddata'),
    path.resolve(__dirname, '../../eng.traineddata'),
    path.resolve(__dirname, '../eng.traineddata'),
    '/eng.traineddata'
  ];
  for (const p of possiblePaths) {
    try {
      if (fs.existsSync(p)) {
        return path.dirname(p);
      }
    } catch (_) {}
  }
  return null;
}

/**
 * Initializes and returns a shared, managed Tesseract worker instance with strict timeout.
 * Points to local eng.traineddata if present to avoid remote network downloads.
 */
export async function getWorker(timeoutMs = OCR_WORKER_TIMEOUT_MS) {
  if (workerInstance) {
    return workerInstance;
  }

  if (initializingPromise) {
    return initializingPromise;
  }

  const localDir = findLocalTrainedDataDir();

  // If in serverless and no local trained data is present, do not attempt to download
  // a 15MB file over the network inside a serverless lambda with strict execution limits
  if (isServerlessRuntime && !localDir) {
    throw new Error('Local OCR trained data not found in serverless environment.');
  }

  initializingPromise = (async () => {
    let timeoutId = null;
    try {
      const tessCacheDir = path.join(os.tmpdir(), 'tess_cache');
      try {
        if (!fs.existsSync(tessCacheDir)) {
          fs.mkdirSync(tessCacheDir, { recursive: true });
        }
      } catch (_) {}

      const localFile = localDir ? path.join(localDir, 'eng.traineddata') : null;
      const targetInCache = path.join(tessCacheDir, 'eng.traineddata');

      if (localFile && fs.existsSync(localFile) && !fs.existsSync(targetInCache)) {
        try {
          fs.copyFileSync(localFile, targetInCache);
        } catch (_) {}
      }

      const langPath = fs.existsSync(targetInCache)
        ? tessCacheDir
        : (localDir || undefined);

      const workerPromise = Tesseract.createWorker('eng', 1, {
        langPath,
        cachePath: tessCacheDir,
        errorHandler: (err) => {
          console.warn('[Image OCR Worker Warning]', err?.message || err);
        }
      });

      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`Tesseract worker initialization timed out (${timeoutMs}ms limit).`));
        }, timeoutMs);
      });

      const worker = await Promise.race([workerPromise, timeoutPromise]);
      workerInstance = worker;
      return workerInstance;
    } catch (workerErr) {
      console.warn('[Image OCR Worker Init Error]:', workerErr?.message || workerErr);
      throw workerErr;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      initializingPromise = null;
    }
  })();

  return initializingPromise;
}

/**
 * Safely discards the worker instance if it becomes unresponsive or corrupted.
 */
export async function discardOcrWorker() {
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
export function normalizeOcrText(rawText) {
  if (!rawText || typeof rawText !== 'string') return '';

  // Standardize line endings
  let text = rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

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

  // If only 1 alphanumeric character was detected with very low confidence, treat as noise
  if (alphanumericChars.length === 1 && confidence < 40) {
    return false;
  }

  return true;
}

/**
 * Vision-capable AI extraction using Gemini Vision.
 * Extremely fast, highly accurate, and eliminates native WebAssembly/worker_threads constraints in serverless.
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
          ]
        });

        const timeoutPromise = new Promise((_, reject) => {
          timer = setTimeout(() => {
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
        const errMsg = String(err?.message || err || '').toLowerCase();
        const causeCode = String(err?.cause?.code || err?.code || '').toUpperCase();
        console.warn(`[Gemini Vision candidate ${model}]:`, err?.message || err);
        if (
          errMsg.includes('fetch failed') ||
          errMsg.includes('enotfound') ||
          errMsg.includes('eai_again') ||
          errMsg.includes('econnrefused') ||
          errMsg.includes('network') ||
          ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT'].includes(causeCode)
        ) {
          // Offline / DNS unreachable: fall through immediately to local Tesseract OCR
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
 * Executes server-side OCR on an image file with intelligent Vision priority and graceful fallback.
 *
 * Guarantees:
 * - Never hangs or exceeds serverless execution limits
 * - Always succeeds for valid JPG, JPEG, and PNG images (returns status: 'ready', hasText: boolean)
 * - Returns structured ImageOcrResult matching Orvix document context architecture
 *
 * @param {string|Buffer} filePathOrBuffer - Absolute path or Buffer of image bytes
 * @param {string} originalName - Original filename for metadata
 * @param {string} ext - Extension including dot (e.g. '.png')
 * @param {string} mimeType - Declared MIME type
 * @param {string} [fileId] - Unique attachment ID
 * @param {{ width?: number, height?: number }} [dimensions] - Pre-parsed dimensions
 * @param {string|null} [apiKey] - Optional Gemini API key for vision
 * @returns {Promise<Object>}
 */
export async function extractImageText(
  filePathOrBuffer,
  originalName,
  ext = '',
  mimeType = 'image/jpeg',
  fileId = '',
  dimensions = undefined,
  apiKey = null
) {
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
      status: 'ready',
      success: true,
      isImage: true,
      hasText: false,
      text: '',
      totalCharacters: 0,
      totalWords: 0,
      warning: 'HEIC/HEIF uploaded. OCR text extraction requires standard JPEG/PNG format.',
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
        status: 'ready',
        success: true,
        isImage: true,
        hasText: false,
        text: '',
        totalCharacters: 0,
        totalWords: 0,
        warning: `Could not read image file: ${err?.message || 'File not found'}`,
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
      status: 'ready',
      success: true,
      isImage: true,
      hasText: false,
      text: '',
      totalCharacters: 0,
      totalWords: 0,
      warning: `Image exceeds ${Math.round(MAX_IMAGE_FILE_SIZE / (1024 * 1024))}MB limit for OCR extraction.`,
      extractedAt: nowIso
    };
  }

  // 3. PRIORITY 1: Gemini Vision AI (fastest, serverless-native, < 1s execution)
  const geminiKey = apiKey || process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY;
  if (geminiKey && geminiKey !== 'MY_GEMINI_API_KEY') {
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
            status: 'ready',
            success: true,
            isImage: true,
            hasText: false,
            text: '',
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
      console.warn('[Gemini Vision Priority Error, continuing to OCR]:', visionErr?.message || visionErr);
    }
  }

  // 4. PRIORITY 2: Local Tesseract OCR with strict timeout safeguards
  return new Promise((resolve) => {
    ocrQueue = ocrQueue
      .catch(() => {})
      .then(async () => {
        let timeoutId = null;

        try {
          const worker = await getWorker(OCR_WORKER_TIMEOUT_MS);

          const timeoutPromise = new Promise((_, reject) => {
            timeoutId = setTimeout(() => {
              reject(new Error(`Tesseract recognition timed out (${OCR_RECOGNIZE_TIMEOUT_MS / 1000}s limit).`));
            }, OCR_RECOGNIZE_TIMEOUT_MS);
          });

          const recognitionPromise = worker.recognize(imageBuffer);
          const ocrResult = await Promise.race([recognitionPromise, timeoutPromise]);

          if (timeoutId) clearTimeout(timeoutId);

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
              summaryText,
              totalCharacters,
              totalWords,
              lineCount,
              confidence,
              extractedAt: nowIso
            });
          }

          // Confirmed no text in image
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
            hasText: false,
            text: '',
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
          await discardOcrWorker();
          console.warn('[Image OCR Fallback Notice]:', ocrErr?.message || ocrErr);

          // If Tesseract worker failed or timed out, attempt Gemini Vision fallback if available
          if (geminiKey && geminiKey !== 'MY_GEMINI_API_KEY') {
            try {
              const visionResult = await extractImageTextWithGeminiVision(imageBuffer, mimeType, geminiKey);
              if (visionResult && visionResult.hasText) {
                const vText = visionResult.text;
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
                  text: vText,
                  summaryText: generateSummaryPreview(vText),
                  totalCharacters: vText.length,
                  totalWords: countWords(vText),
                  lineCount: vText.split('\n').filter((l) => l.trim().length > 0).length,
                  confidence: 95,
                  extractedAt: nowIso
                });
              }
            } catch (_) {}
          }

          // The image upload must ALWAYS succeed cleanly for valid images
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
            hasText: false,
            text: '',
            summaryText: '',
            totalCharacters: 0,
            totalWords: 0,
            lineCount: 0,
            confidence: 0,
            message: 'Image uploaded successfully.',
            extractedAt: nowIso
          });
        }
      });
  });
}
