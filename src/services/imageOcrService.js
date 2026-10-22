import fs from 'fs';
import path from 'path';
import Tesseract from 'tesseract.js';

// Reasonable processing limits
const OCR_TIMEOUT_MS = 25000; // 25 seconds safety timeout
const MAX_PREVIEW_LENGTH = 350;
const MAX_IMAGE_FILE_SIZE = 25 * 1024 * 1024; // 25MB

let workerInstance = null;
let initializingPromise = null;
let ocrQueue = Promise.resolve();

/**
 * Initializes and returns a shared, managed Tesseract worker instance.
 */
async function getWorker() {
  if (workerInstance) {
    return workerInstance;
  }

  if (initializingPromise) {
    return initializingPromise;
  }

  initializingPromise = (async () => {
    try {
      const worker = await Tesseract.createWorker('eng', 1, {
        errorHandler: (err) => {
          console.warn('[Image OCR Worker Warning]', err?.message || err);
        }
      });
      workerInstance = worker;
      return workerInstance;
    } finally {
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
 * @param {number} [confidence=0] - Tesseract confidence score (0-100)
 * @returns {boolean}
 */
export function detectReadableText(text, confidence = 0) {
  if (!text || typeof text !== 'string') return false;

  const trimmed = text.trim();
  if (trimmed.length === 0) return false;

  // Extract all alphanumeric and extended Latin/accented characters
  const alphanumericChars = trimmed.match(/[a-zA-Z0-9\u00C0-\u024F\u1E00-\u1EFF]/g);
  if (!alphanumericChars || alphanumericChars.length === 0) {
    // Only punctuation or symbols (e.g., '.', '~', '|', '_')
    return false;
  }

  // If only 1 alphanumeric character was detected with very low confidence, treat as noise
  if (alphanumericChars.length === 1 && confidence < 40) {
    return false;
  }

  return true;
}

/**
 * Executes server-side OCR on an image file.
 *
 * Returns a structured ImageOcrResult:
 * - status: 'ready' (text detected) | 'NO_TEXT_DETECTED' (success, no text) | 'unsupported_format' | 'error'
 * - success: true for 'ready' and 'NO_TEXT_DETECTED', false for 'error' and 'unsupported_format'
 * - hasText: boolean
 * - text: normalized readable text (or empty string)
 * - message: user-facing message when no readable text is detected
 *
 * @param {string} filePath - Absolute path to the image on disk
 * @param {string} originalName - Original filename for metadata
 * @param {string} ext - Extension including dot (e.g. '.png')
 * @param {string} mimeType - Declared MIME type
 * @param {string} [fileId] - Unique attachment ID
 * @param {{ width?: number, height?: number }} [dimensions] - Pre-parsed dimensions
 * @returns {Promise<Object>}
 */
export async function extractImageText(
  filePath,
  originalName,
  ext = '',
  mimeType = 'image/jpeg',
  fileId = '',
  dimensions = undefined
) {
  const normalizedExt = (ext || path.extname(filePath || '')).toLowerCase();
  const formatName = normalizedExt.replace('.', '').toUpperCase() || 'IMAGE';
  const nowIso = new Date().toISOString();

  // 1. Check for formats that require native codecs not available to Tesseract WebWorker (e.g. HEIC / HEIF)
  if (normalizedExt === '.heic' || normalizedExt === '.heif' || mimeType.includes('heic') || mimeType.includes('heif')) {
    return {
      fileId,
      filename: path.basename(filePath),
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
      error: 'OCR text extraction is not supported for HEIC/HEIF images in this environment without native HEVC codecs.',
      extractedAt: nowIso
    };
  }

  // 2. Validate file existence and size
  let fileStats;
  try {
    fileStats = await fs.promises.stat(filePath);
  } catch (err) {
    return {
      fileId,
      filename: path.basename(filePath),
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
      error: `Failed to access image file on disk: ${err?.message || 'File not found'}`,
      extractedAt: nowIso
    };
  }

  if (fileStats.size === 0) {
    return {
      fileId,
      filename: path.basename(filePath),
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

  if (fileStats.size > MAX_IMAGE_FILE_SIZE) {
    return {
      fileId,
      filename: path.basename(filePath),
      originalName,
      format: formatName,
      mimeType,
      sizeBytes: fileStats.size,
      dimensions,
      status: 'error',
      success: false,
      isImage: true,
      hasText: false,
      text: '',
      totalCharacters: 0,
      totalWords: 0,
      error: `Image exceeds maximum allowed size of ${Math.round(MAX_IMAGE_FILE_SIZE / (1024 * 1024))}MB for OCR extraction.`,
      extractedAt: nowIso
    };
  }

  // Read image buffer from disk
  let imageBuffer;
  try {
    imageBuffer = await fs.promises.readFile(filePath);
  } catch (err) {
    return {
      fileId,
      filename: path.basename(filePath),
      originalName,
      format: formatName,
      mimeType,
      sizeBytes: fileStats.size,
      dimensions,
      status: 'error',
      success: false,
      isImage: true,
      hasText: false,
      text: '',
      totalCharacters: 0,
      totalWords: 0,
      error: `Failed to read image bytes: ${err?.message}`,
      extractedAt: nowIso
    };
  }

  // 3. Queue OCR execution to prevent runaway concurrency and CPU saturation
  return new Promise((resolve) => {
    ocrQueue = ocrQueue.then(async () => {
      let timeoutId = null;
      let timedOut = false;

      try {
        const worker = await getWorker();

        const timeoutPromise = new Promise((_, reject) => {
          timeoutId = setTimeout(() => {
            timedOut = true;
            reject(new Error(`OCR processing timed out after ${OCR_TIMEOUT_MS / 1000} seconds.`));
          }, OCR_TIMEOUT_MS);
        });

        const recognitionPromise = worker.recognize(imageBuffer);
        const ocrResult = await Promise.race([recognitionPromise, timeoutPromise]);

        if (timeoutId) clearTimeout(timeoutId);

        const rawText = ocrResult?.data?.text || '';
        const confidence = Math.round(ocrResult?.data?.confidence || 0);
        const normalizedText = normalizeOcrText(rawText);
        const hasText = detectReadableText(normalizedText, confidence);

        if (!hasText) {
          // Requirement 7 & 8: No readable text is NOT an error.
          // Return a successful result with status 'NO_TEXT_DETECTED'.
          // Requirement 9: Tell the user clearly "No readable text detected in this image."
          // Requirement 10: Do not fabricate text.
          return resolve({
            fileId,
            filename: path.basename(filePath),
            originalName,
            format: formatName,
            mimeType,
            sizeBytes: fileStats.size,
            dimensions,
            status: 'NO_TEXT_DETECTED',
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
        }

        // Readable text detected
        const totalCharacters = normalizedText.length;
        const totalWords = countWords(normalizedText);
        const lineCount = normalizedText.split('\n').filter((l) => l.trim().length > 0).length;
        const summaryText = generateSummaryPreview(normalizedText);

        return resolve({
          fileId,
          filename: path.basename(filePath),
          originalName,
          format: formatName,
          mimeType,
          sizeBytes: fileStats.size,
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
      } catch (err) {
        if (timeoutId) clearTimeout(timeoutId);

        // Discard worker on crash/timeout to ensure next operation starts cleanly
        await discardOcrWorker();

        // Important Behavior: corrupted or unprocessable images return an actual processing error
        const isTimeout = timedOut || (err?.message || '').includes('timed out');
        return resolve({
          fileId,
          filename: path.basename(filePath),
          originalName,
          format: formatName,
          mimeType,
          sizeBytes: fileStats.size,
          dimensions,
          status: 'error',
          success: false,
          isImage: true,
          hasText: false,
          text: '',
          totalCharacters: 0,
          totalWords: 0,
          error: isTimeout
            ? 'Image OCR processing timed out. The image may be too large or complex.'
            : `Failed to process image: ${err?.message || 'invalid or corrupt image data.'}`,
          extractedAt: nowIso
        });
      }
    });
  });
}
