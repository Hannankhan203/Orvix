/**
 * Orvix Client-Side Attachment Storage & Retrieval Service
 * Provides IndexedDB persistence for original file blobs, graceful availability checks,
 * in-browser previews for supported formats (PDF, text, markdown, images), and downloads.
 */

import { isVisionCapableProvider } from './documentContextService.js';

const DB_NAME = 'orvix_attachments_db';
const DB_VERSION = 1;
const STORE_NAME = 'attachments';

let dbPromise = null;

/**
 * Initializes and returns the IndexedDB database instance
 * @returns {Promise<IDBDatabase|null>}
 */
function getDB() {
  const idb =
    typeof indexedDB !== 'undefined'
      ? indexedDB
      : typeof window !== 'undefined' && window.indexedDB
      ? window.indexedDB
      : null;

  if (!idb) {
    return Promise.resolve(null);
  }

  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve) => {
    try {
      const request = idb.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
          store.createIndex('conversationId', 'conversationId', { unique: false });
          store.createIndex('createdAt', 'createdAt', { unique: false });
        }
      };

      request.onsuccess = (event) => {
        resolve(event.target.result);
      };

      request.onerror = (err) => {
        console.warn('[Attachment Storage] IndexedDB open error:', err);
        resolve(null);
      };
    } catch (e) {
      console.warn('[Attachment Storage] IndexedDB unsupported or blocked:', e);
      resolve(null);
    }
  });

  return dbPromise;
}

let lastStorageError = null;

/**
 * Returns the most recent IndexedDB storage error, if any.
 * @returns {DOMException|Error|null}
 */
export function getLastStorageError() {
  return lastStorageError;
}

/**
 * Clears the stored last storage error.
 */
export function clearLastStorageError() {
  lastStorageError = null;
}

/**
 * Resets the cached IndexedDB database promise for testing purposes.
 */
export function resetAttachmentDBForTesting() {
  dbPromise = null;
  lastStorageError = null;
}

/**
 * Identifies whether an error represents a browser storage quota exhaustion.
 * Distinguishes QuotaExceededError from other IndexedDB or DOM exceptions.
 * @param {any} err
 * @returns {boolean}
 */
export function isQuotaExceededError(err) {
  if (!err) return false;
  const candidate = err.target?.error || err.error || err.cause || err;
  const name = candidate.name || err.name || '';
  const code = candidate.code || err.code;
  const message = String(candidate.message || err.message || candidate || err || '').toLowerCase();

  return (
    name === 'QuotaExceededError' ||
    name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    code === 22 ||
    code === 1014 ||
    message.includes('quotaexceedederror') ||
    message.includes('quota exceeded') ||
    message.includes('storage quota')
  );
}

/**
 * Saves a file Blob/File to browser IndexedDB storage for offline & persistent message access.
 * Safely handles storage quota exhaustion (QuotaExceededError) and transaction-level aborts,
 * returning false without throwing unhandled exceptions so callers can gracefully retain in-memory data.
 *
 * @param {string} id - Stable attachment UUID
 * @param {Blob|File} fileOrBlob - The actual binary file data
 * @param {Object} [metadata={}] - File metadata (name, size, type, etc.)
 * @returns {Promise<boolean>}
 */
export async function saveAttachmentBlob(id, fileOrBlob, metadata = {}) {
  if (!id || !fileOrBlob) return false;

  try {
    const db = await getDB();
    if (!db) return false;

    return new Promise((resolve) => {
      let resolved = false;
      const finish = (success, err = null) => {
        if (resolved) return;
        resolved = true;
        if (success) {
          lastStorageError = null;
          resolve(true);
        } else {
          lastStorageError = err || lastStorageError;
          if (isQuotaExceededError(lastStorageError)) {
            console.warn(
              '[Attachment Storage] IndexedDB storage quota exceeded (QuotaExceededError). Attachment retained in memory.'
            );
          } else if (lastStorageError) {
            console.warn('[Attachment Storage] Failed to store attachment in IndexedDB:', lastStorageError);
          }
          resolve(false);
        }
      };

      try {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);

        const record = {
          id,
          name: metadata.name || metadata.originalName || fileOrBlob.name || 'document',
          originalName: metadata.originalName || metadata.name || fileOrBlob.name || 'document',
          size: metadata.size || fileOrBlob.size || 0,
          formattedSize: metadata.formattedSize || '',
          type: metadata.type || metadata.mimeType || fileOrBlob.type || 'application/octet-stream',
          extension: metadata.extension || '',
          conversationId: metadata.conversationId || null,
          createdAt: Date.now(),
          blob: fileOrBlob
        };

        const putRequest = store.put(record);

        let requestSucceeded = false;
        putRequest.onsuccess = () => {
          requestSucceeded = true;
          // In standard IndexedDB, transaction.oncomplete finalizes the write.
          // For lightweight testing shims that do not emit transaction.oncomplete, fallback after microtask:
          setTimeout(() => {
            if (requestSucceeded) finish(true);
          }, 0);
        };

        putRequest.onerror = (event) => {
          event?.preventDefault?.();
          const domErr = putRequest.error || event?.target?.error || event;
          finish(false, domErr);
        };

        transaction.oncomplete = () => {
          finish(true);
        };

        transaction.onerror = (event) => {
          event?.preventDefault?.();
          const domErr = transaction.error || putRequest.error || event?.target?.error || event;
          finish(false, domErr);
        };

        transaction.onabort = (event) => {
          const domErr = transaction.error || putRequest.error || event?.target?.error;
          finish(false, domErr);
        };
      } catch (syncErr) {
        finish(false, syncErr);
      }
    });
  } catch (err) {
    lastStorageError = err;
    if (isQuotaExceededError(err)) {
      console.warn(
        '[Attachment Storage] IndexedDB storage quota exceeded (QuotaExceededError). Attachment retained in memory.'
      );
    } else {
      console.warn('[Attachment Storage] saveAttachmentBlob error:', err);
    }
    return false;
  }
}

/**
 * Removes an attachment record from browser IndexedDB storage.
 * @param {string} id
 * @returns {Promise<boolean>}
 */
export async function deleteAttachmentRecord(id) {
  if (!id) return false;
  try {
    const db = await getDB();
    if (!db) return false;
    return new Promise((resolve) => {
      let resolved = false;
      const finish = (val) => {
        if (!resolved) {
          resolved = true;
          resolve(val);
        }
      };
      try {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const req = store.delete(id);
        req.onsuccess = () => {
          setTimeout(() => finish(true), 0);
        };
        req.onerror = () => finish(false);
        transaction.oncomplete = () => finish(true);
        transaction.onerror = () => finish(false);
        transaction.onabort = () => finish(false);
      } catch (_) {
        finish(false);
      }
    });
  } catch (_) {
    return false;
  }
}

/**
 * Retrieves a stored attachment record and its binary Blob from IndexedDB
 * @param {string} id
 * @returns {Promise<Object|null>}
 */
export async function getAttachmentRecord(id) {
  if (!id) return null;

  try {
    const db = await getDB();
    if (!db) return null;

    return new Promise((resolve) => {
      const transaction = db.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const getRequest = store.get(id);

      getRequest.onsuccess = () => {
        resolve(getRequest.result || null);
      };

      getRequest.onerror = () => {
        resolve(null);
      };
    });
  } catch (err) {
    console.warn('[Attachment Storage] getAttachmentRecord error:', err);
    return null;
  }
}

/**
 * Retrieves a stored attachment's binary Blob from IndexedDB
 * @param {string} id
 * @returns {Promise<Blob|null>}
 */
export async function getAttachmentBlob(id) {
  if (!id) return null;
  const record = await getAttachmentRecord(id);
  return record?.blob || null;
}

/**
 * Per-image binary byte limit for multimodal chat requests (3 MiB binary -> ~4.0 MiB base64).
 * Sized so a single maximum-size image plus JSON/prompt/history overhead fits safely within
 * Vercel's 4.5 MB serverless request body limit as well as /api/chat's 10 MB bodyParser limit.
 */
export const MAX_VISION_IMAGE_BYTES = 3 * 1024 * 1024;

/**
 * Complete serialized UTF-8 JSON request budget for /api/chat (~4.20 MiB / 4,400,000 bytes),
 * accounting for base64 expansion (~4/3x), all carried-forward images, conversation history,
 * prompt text, and JSON framing safely below Vercel's 4,500,000-byte payload limit.
 */
export const MAX_CHAT_REQUEST_BYTES = 4_400_000;

/**
 * Reserved byte budget for outer JSON request envelope, prompt, and history metadata
 * when hydrating attachments prior to final JSON.stringify validation.
 */
export const JSON_REQUEST_OVERHEAD_RESERVE_BYTES = 32 * 1024;

/**
 * Explicitly supported raster image MIME types for multimodal vision providers.
 * Arbitrary image/* values (e.g. image/svg+xml, image/tiff) are NOT trusted.
 */
export const SUPPORTED_VISION_IMAGE_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/heic',
  'image/heif'
]);

const RASTER_MIME_ALIASES = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/x-citrix-jpeg': 'image/jpeg',
  'image/x-png': 'image/png',
  'image/x-citrix-png': 'image/png',
  'image/x-bmp': 'image/bmp',
  'image/x-ms-bmp': 'image/bmp',
  'image/heic-sequence': 'image/heic',
  'image/heif-sequence': 'image/heif'
};

const SUPPORTED_RASTER_EXT_TO_MIME = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  heic: 'image/heic',
  heif: 'image/heif'
};

const UNSUPPORTED_IMAGE_EXTENSIONS = new Set([
  'svg',
  'svgz',
  'tif',
  'tiff',
  'ico',
  'cur',
  'avif',
  'psd',
  'raw',
  'cr2',
  'nef',
  'dng'
]);

export class ImagePayloadLimitError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ImagePayloadLimitError';
    this.code = details.code || 413;
    this.status = details.status || 'PAYLOAD_TOO_LARGE';
    this.retryable = false;
    this.canFallback = false;
    this.isPayloadError = true;
    Object.assign(this, details);
  }
}

export class ImagePayloadValidationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ImagePayloadValidationError';
    this.code = details.code || 400;
    this.status = details.status || 'INVALID_ARGUMENT';
    this.retryable = false;
    this.canFallback = false;
    this.isPayloadError = true;
    Object.assign(this, details);
  }
}

function formatMegabytes(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function utf8ByteLength(str) {
  const s = String(str || '');
  if (typeof Buffer !== 'undefined') {
    return Buffer.byteLength(s, 'utf8');
  }
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(s).byteLength;
  }
  return s.length;
}

function base64ToBytes(rawBase64) {
  if (typeof rawBase64 !== 'string' || !rawBase64) return null;
  let normalized = rawBase64.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!normalized || normalized.length % 4 === 1) return null;
  while (normalized.length % 4 !== 0) {
    normalized += '=';
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    return null;
  }
  try {
    if (typeof Buffer !== 'undefined') {
      const buf = Buffer.from(normalized, 'base64');
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    }
    if (typeof atob === 'function') {
      const binStr = atob(normalized);
      const out = new Uint8Array(binStr.length);
      for (let i = 0; i < binStr.length; i++) {
        out[i] = binStr.charCodeAt(i);
      }
      return out;
    }
  } catch (_) {
    return null;
  }
  return null;
}

function bytesToBase64(bytes) {
  if (!bytes || bytes.length === 0) return '';
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('base64');
  }
  if (typeof btoa === 'function') {
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < u8.length; i += chunkSize) {
      const sub = u8.subarray(i, i + chunkSize);
      binary += String.fromCharCode.apply(null, sub);
    }
    return btoa(binary);
  }
  return '';
}

function extractCleanExtension(value) {
  if (!value || typeof value !== 'string') return '';
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return '';
  if (!trimmed.includes('.') && !trimmed.includes('/') && trimmed.length <= 8) {
    return trimmed;
  }
  const lastDot = trimmed.lastIndexOf('.');
  if (lastDot === -1 || lastDot === trimmed.length - 1) return '';
  return trimmed.slice(lastDot + 1);
}

/**
 * Normalizes a declared MIME type against the supported vision raster whitelist.
 * Returns canonical MIME string if supported, or null otherwise.
 * @param {string} [mime]
 * @returns {string|null}
 */
export function normalizeSupportedRasterMime(mime) {
  if (!mime || typeof mime !== 'string') return null;
  const clean = mime.split(';')[0].trim().toLowerCase();
  if (!clean) return null;
  if (SUPPORTED_VISION_IMAGE_MIMES.has(clean)) return clean;
  if (RASTER_MIME_ALIASES[clean]) return RASTER_MIME_ALIASES[clean];
  return null;
}

function isExplicitlyUnsupportedImageMime(mime) {
  if (!mime || typeof mime !== 'string') return false;
  const clean = mime.split(';')[0].trim().toLowerCase();
  if (!clean.startsWith('image/')) return false;
  return normalizeSupportedRasterMime(clean) === null;
}

/**
 * Inspects binary magic-byte headers to detect the actual image format.
 * Explicitly identifies unsupported formats (SVG, TIFF, ICO, AVIF) so they cannot enter vision parts.
 * @param {Uint8Array|Buffer|null} bytes
 * @returns {{ mime: string|null, unsupportedMime: string|null }}
 */
export function detectImageMimeFromBytes(bytes) {
  if (!bytes || bytes.length < 2) {
    return { mime: null, unsupportedMime: null };
  }
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

  // TIFF (little-endian II*\0 or big-endian MM\0*)
  if (
    u8.length >= 4 &&
    ((u8[0] === 0x49 && u8[1] === 0x49 && u8[2] === 0x2a && u8[3] === 0x00) ||
      (u8[0] === 0x4d && u8[1] === 0x4d && u8[2] === 0x00 && u8[3] === 0x2a))
  ) {
    return { mime: null, unsupportedMime: 'image/tiff' };
  }

  // ICO
  if (u8.length >= 4 && u8[0] === 0x00 && u8[1] === 0x00 && u8[2] === 0x01 && u8[3] === 0x00) {
    return { mime: null, unsupportedMime: 'image/x-icon' };
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    u8.length >= 8 &&
    u8[0] === 0x89 &&
    u8[1] === 0x50 &&
    u8[2] === 0x4e &&
    u8[3] === 0x47 &&
    u8[4] === 0x0d &&
    u8[5] === 0x0a &&
    u8[6] === 0x1a &&
    u8[7] === 0x0a
  ) {
    return { mime: 'image/png', unsupportedMime: null };
  }

  // JPEG: FF D8 FF
  if (u8.length >= 3 && u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff) {
    return { mime: 'image/jpeg', unsupportedMime: null };
  }

  // GIF: GIF87a or GIF89a
  if (
    u8.length >= 6 &&
    u8[0] === 0x47 &&
    u8[1] === 0x49 &&
    u8[2] === 0x46 &&
    u8[3] === 0x38 &&
    (u8[4] === 0x37 || u8[4] === 0x39) &&
    u8[5] === 0x61
  ) {
    return { mime: 'image/gif', unsupportedMime: null };
  }

  // WEBP: RIFF....WEBP
  if (
    u8.length >= 12 &&
    u8[0] === 0x52 &&
    u8[1] === 0x49 &&
    u8[2] === 0x46 &&
    u8[3] === 0x46 &&
    u8[8] === 0x57 &&
    u8[9] === 0x45 &&
    u8[10] === 0x42 &&
    u8[11] === 0x50
  ) {
    return { mime: 'image/webp', unsupportedMime: null };
  }

  // BMP: BM
  if (u8.length >= 2 && u8[0] === 0x42 && u8[1] === 0x4d) {
    return { mime: 'image/bmp', unsupportedMime: null };
  }

  // ISO BMFF (ftyp at offset 4..7): HEIC / HEIF / AVIF
  if (
    u8.length >= 12 &&
    u8[4] === 0x66 &&
    u8[5] === 0x74 &&
    u8[6] === 0x79 &&
    u8[7] === 0x70
  ) {
    const brand = String.fromCharCode(u8[8], u8[9], u8[10], u8[11]).toLowerCase();
    if (['heic', 'heix', 'hevc', 'hevx'].includes(brand)) {
      return { mime: 'image/heic', unsupportedMime: null };
    }
    if (['mif1', 'msf1', 'heif'].includes(brand)) {
      return { mime: 'image/heif', unsupportedMime: null };
    }
    if (['avif', 'avis'].includes(brand)) {
      return { mime: null, unsupportedMime: 'image/avif' };
    }
  }

  // SVG XML header check in leading text bytes
  const headLen = Math.min(u8.length, 512);
  let headStr = '';
  for (let i = 0; i < headLen; i++) {
    headStr += String.fromCharCode(u8[i]);
  }
  const trimmedHead = headStr.replace(/^\uFEFF/, '').trimStart();
  if (/^(?:<\?xml[\s\S]*?)?<svg[\s>]/i.test(trimmedHead) || /^<!doctype\s+svg/i.test(trimmedHead)) {
    return { mime: null, unsupportedMime: 'image/svg+xml' };
  }

  return { mime: null, unsupportedMime: null };
}

/**
 * Resolves a validated supported raster MIME type using actual image bytes first,
 * followed by explicit supported MIME hints and filename/extension hints.
 * Rejects SVG, TIFF, and arbitrary unknown image/* types.
 */
export function resolveSupportedImageMime(meta = {}, bytes = null) {
  if (bytes && bytes.length > 0) {
    const detected = detectImageMimeFromBytes(bytes);
    if (detected.unsupportedMime) {
      return { mimeType: null, unsupportedMime: detected.unsupportedMime };
    }
    if (detected.mime) {
      return { mimeType: detected.mime, unsupportedMime: null };
    }
  }

  const mimeCandidates = [
    meta.dataUrlMime,
    meta.mimeType,
    meta.type,
    meta.recordType,
    meta.blobType
  ];

  for (const candidate of mimeCandidates) {
    if (!candidate) continue;
    if (isExplicitlyUnsupportedImageMime(candidate)) {
      return {
        mimeType: null,
        unsupportedMime: String(candidate).split(';')[0].trim().toLowerCase()
      };
    }
    const normalized = normalizeSupportedRasterMime(candidate);
    if (normalized) {
      return { mimeType: normalized, unsupportedMime: null };
    }
  }

  const extCandidates = [
    meta.extension,
    meta.format,
    meta.diskFilename,
    meta.originalName,
    meta.name,
    meta.filename
  ];

  for (const raw of extCandidates) {
    const ext = extractCleanExtension(raw);
    if (!ext) continue;
    if (UNSUPPORTED_IMAGE_EXTENSIONS.has(ext)) {
      return { mimeType: null, unsupportedMime: ext === 'svg' || ext === 'svgz' ? 'image/svg+xml' : `image/${ext}` };
    }
    if (SUPPORTED_RASTER_EXT_TO_MIME[ext]) {
      return { mimeType: SUPPORTED_RASTER_EXT_TO_MIME[ext], unsupportedMime: null };
    }
  }

  return { mimeType: null, unsupportedMime: null };
}

function classifyImageCandidate(att = {}) {
  const resolved = resolveSupportedImageMime(att, null);
  if (resolved.unsupportedMime) {
    return { isCandidateImage: true, isSupportedRaster: false, unsupportedMime: resolved.unsupportedMime, mimeHint: null };
  }
  if (resolved.mimeType) {
    return { isCandidateImage: true, isSupportedRaster: true, unsupportedMime: null, mimeHint: resolved.mimeType };
  }
  if (att.isImage) {
    return { isCandidateImage: true, isSupportedRaster: false, unsupportedMime: null, mimeHint: null };
  }
  return { isCandidateImage: false, isSupportedRaster: false, unsupportedMime: null, mimeHint: null };
}

/**
 * Robustly parses either a Data URL (`data:<mime>;...;base64,<payload>`) or raw base64 string,
 * strips any Data URL prefix cleanly without corrupting image bytes, decodes binary bytes,
 * and validates the image MIME type against binary headers and supported raster formats.
 */
export function parseEncodedImagePayload(rawInput, meta = {}) {
  if (typeof rawInput !== 'string' || !rawInput.trim()) {
    return { valid: false, reason: 'empty_input' };
  }

  let dataUrlMime = '';
  let rawBase64 = '';
  const trimmed = rawInput.trim();

  if (/^data:/i.test(trimmed)) {
    const commaIdx = trimmed.indexOf(',');
    if (commaIdx === -1) {
      return { valid: false, reason: 'malformed_data_url' };
    }
    const header = trimmed.slice(5, commaIdx);
    const headerParts = header.split(';').map((s) => s.trim().toLowerCase());
    if (!headerParts.includes('base64')) {
      const maybeMime = headerParts[0] || '';
      if (isExplicitlyUnsupportedImageMime(maybeMime)) {
        return { valid: false, reason: 'unsupported_mime', unsupportedMime: maybeMime };
      }
      return { valid: false, reason: 'non_base64_data_url' };
    }
    dataUrlMime = headerParts[0] || '';
    rawBase64 = trimmed.slice(commaIdx + 1);
  } else {
    rawBase64 = trimmed;
  }

  const bytes = base64ToBytes(rawBase64);
  if (!bytes || bytes.length === 0) {
    return { valid: false, reason: 'invalid_base64' };
  }

  // If the Data URL header had a generic fallback like application/octet-stream or empty MIME
  // (e.g. from browser FileReader on an untyped Blob), prefer explicit caller metadata over dataUrlMime.
  const effectiveDataUrlMime =
    dataUrlMime && dataUrlMime !== 'application/octet-stream' ? dataUrlMime : '';

  const mimeResolution = resolveSupportedImageMime(
    {
      ...meta,
      dataUrlMime: normalizeSupportedRasterMime(meta.mimeType || meta.type)
        ? undefined
        : effectiveDataUrlMime,
      mimeType: meta.mimeType || meta.type || effectiveDataUrlMime
    },
    bytes
  );

  // Also reject if dataUrlMime itself explicitly declared an unsupported image/* and bytes did not prove a supported raster header
  if (!mimeResolution.mimeType && isExplicitlyUnsupportedImageMime(effectiveDataUrlMime)) {
    return {
      valid: false,
      reason: 'unsupported_mime',
      unsupportedMime: effectiveDataUrlMime
    };
  }

  if (mimeResolution.unsupportedMime || !mimeResolution.mimeType) {
    return {
      valid: false,
      reason: 'unsupported_mime',
      unsupportedMime: mimeResolution.unsupportedMime || effectiveDataUrlMime || meta.mimeType || meta.type || 'unknown'
    };
  }

  return {
    valid: true,
    base64: bytesToBase64(bytes),
    mimeType: mimeResolution.mimeType,
    byteLength: bytes.length,
    bytes
  };
}

/**
 * Converts a Blob or File to a validated canonical base64 Data URL (`data:<validatedMime>;base64,<data>`).
 * Supports both browser environments (FileReader) and Node.js environments (blob.arrayBuffer).
 * Ensures the emitted MIME type matches the validated raster image format even when `blob.type`
 * is empty, `application/octet-stream`, or inconsistent with actual image bytes.
 * Returns null for empty blobs or unsupported formats (e.g. SVG, TIFF).
 *
 * @param {Blob|File} blob
 * @param {string} [mimeType]
 * @returns {Promise<string|null>}
 */
export async function convertBlobToDataUrl(blob, mimeType = '') {
  if (!blob) return null;
  if (typeof blob.size === 'number' && blob.size <= 0) return null;

  const meta = {
    mimeType,
    blobType: blob.type || '',
    name: blob.name || ''
  };

  if (typeof FileReader !== 'undefined') {
    const rawDataUrl = await new Promise((resolve) => {
      try {
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      } catch (_) {
        resolve(null);
      }
    });

    if (!rawDataUrl) return null;
    const parsed = parseEncodedImagePayload(rawDataUrl, meta);
    if (!parsed.valid) return null;
    return `data:${parsed.mimeType};base64,${parsed.base64}`;
  }

  if (typeof blob.arrayBuffer === 'function') {
    try {
      const u8 = new Uint8Array(await blob.arrayBuffer());
      if (u8.length === 0) return null;
      const resolved = resolveSupportedImageMime(meta, u8);
      if (resolved.unsupportedMime || !resolved.mimeType) return null;
      return `data:${resolved.mimeType};base64,${bytesToBase64(u8)}`;
    } catch (_) {
      return null;
    }
  }

  return null;
}

function stripTransientFieldsFromAttachment(att) {
  if (!att || typeof att !== 'object') return att;
  const { dataUrl, data, file, blob, ...rest } = att;
  if (typeof rest.previewUrl === 'string' && rest.previewUrl.startsWith('data:')) {
    delete rest.previewUrl;
  }
  return rest;
}

function buildOversizedImageError(label, actualBytes, maxImageBytes) {
  return new ImagePayloadLimitError(
    `Image '${label}' (${formatMegabytes(actualBytes)}) exceeds the ${formatMegabytes(maxImageBytes)} per-image limit for AI chat requests. Please resize or compress the image and try again.`,
    {
      attachmentName: label,
      actualBytes,
      maxImageBytes
    }
  );
}

function buildCumulativeBudgetError(imageCount, estimatedBytes, maxRequestBytes) {
  return new ImagePayloadLimitError(
    `The combined payload for ${imageCount} image${imageCount === 1 ? '' : 's'} (${formatMegabytes(estimatedBytes)} encoded with request metadata) exceeds the ${formatMegabytes(maxRequestBytes)} chat request budget. Please use smaller images or start a new conversation.`,
    {
      imageCount,
      estimatedBytes,
      maxRequestBytes
    }
  );
}

/**
 * Restores original image bytes from in-memory Blob or IndexedDB for attachments before request dispatch.
 * - Emits ONE canonical encoded field (`base64`: raw base64 without Data URL prefix) and preserves
 *   validated `mimeType` and `type` separately, eliminating `base64`/`dataUrl` payload duplication.
 * - Enforces the exact same per-image binary limit across pre-encoded payloads, `att.file`, and IndexedDB Blobs.
 * - Tracks cumulative base64 + JSON request overhead across all attachments carried forward in the request.
 * - Throws `ImagePayloadLimitError` when a required image exceeds per-image or cumulative request limits
 *   instead of silently omitting the image.
 * - Does not mutate the caller's attachment objects.
 *
 * @param {Array<Object>} attachments
 * @param {Object} [options={}]
 * @param {string} [options.provider]
 * @param {string|null} [options.model]
 * @param {number} [options.maxImageBytes=MAX_VISION_IMAGE_BYTES]
 * @param {number} [options.maxRequestBytes=MAX_CHAT_REQUEST_BYTES]
 * @param {number} [options.jsonOverheadBytes=JSON_REQUEST_OVERHEAD_RESERVE_BYTES]
 * @returns {Promise<Array<Object>>}
 */
export async function hydrateAttachmentsWithImageBytes(attachments, options = {}) {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return [];
  }

  // Provider-gated hydration: if a target provider is specified and does not consume raw image bytes,
  // skip all File/Blob/IndexedDB reads and return lightweight metadata + OCR/document extraction only.
  if (options.provider !== undefined && !isVisionCapableProvider(options.provider, options.model)) {
    return attachments.map((att) => sanitizeAttachmentForNetwork(att, { includeImageBytes: false }));
  }

  const maxImageBytes =
    typeof options.maxImageBytes === 'number' && options.maxImageBytes > 0
      ? options.maxImageBytes
      : MAX_VISION_IMAGE_BYTES;
  const maxRequestBytes =
    typeof options.maxRequestBytes === 'number' && options.maxRequestBytes > 0
      ? options.maxRequestBytes
      : MAX_CHAT_REQUEST_BYTES;
  const jsonOverheadBytes =
    typeof options.jsonOverheadBytes === 'number' && options.jsonOverheadBytes >= 0
      ? options.jsonOverheadBytes
      : JSON_REQUEST_OVERHEAD_RESERVE_BYTES;

  let cumulativeBytes = jsonOverheadBytes;
  let hydratedImageCount = 0;
  const results = [];

  for (const att of attachments) {
    if (!att || typeof att !== 'object') {
      results.push(att);
      continue;
    }

    const label = att.originalName || att.name || att.filename || att.id || 'image';
    const classification = classifyImageCandidate(att);

    // Non-image documents (PDF, DOCX, PPTX, TXT, CSV, JSON, XML, etc.): preserve as-is
    if (!classification.isCandidateImage) {
      cumulativeBytes += utf8ByteLength(JSON.stringify(stripTransientFieldsFromAttachment(att))) + 2;
      results.push(att);
      continue;
    }

    // Unsupported image formats (e.g. SVG, TIFF): never inject into the raster vision path
    if (classification.unsupportedMime) {
      const cleaned = stripTransientFieldsFromAttachment(att);
      delete cleaned.base64;
      cumulativeBytes += utf8ByteLength(JSON.stringify(cleaned)) + 2;
      results.push(cleaned);
      continue;
    }

    let resolvedPayload = null;

    // 1. Pre-existing base64 / dataUrl / data on attachment: normalize without re-reading IndexedDB
    const existingEncoded = att.base64 || att.dataUrl || att.data;
    if (typeof existingEncoded === 'string' && existingEncoded.trim()) {
      const parsed = parseEncodedImagePayload(existingEncoded, att);
      if (parsed.valid) {
        if (parsed.byteLength > maxImageBytes) {
          throw buildOversizedImageError(label, parsed.byteLength, maxImageBytes);
        }
        resolvedPayload = parsed;
      } else {
        const cleaned = stripTransientFieldsFromAttachment(att);
        delete cleaned.base64;
        results.push(cleaned);
        continue;
      }
    }

    // 2. In-memory File / Blob (enforces the exact same per-image limit as IndexedDB)
    if (!resolvedPayload && att.file && (att.file instanceof Blob || typeof att.file.arrayBuffer === 'function')) {
      const fileSize = typeof att.file.size === 'number' ? att.file.size : 0;
      if (fileSize > maxImageBytes) {
        throw buildOversizedImageError(label, fileSize, maxImageBytes);
      }
      if (fileSize > 0) {
        const dataUrl = await convertBlobToDataUrl(
          att.file,
          att.mimeType || att.type || att.file.type || classification.mimeHint || ''
        );
        if (dataUrl) {
          const parsed = parseEncodedImagePayload(dataUrl, {
            ...att,
            blobType: att.file.type || ''
          });
          if (parsed.valid) {
            if (parsed.byteLength > maxImageBytes) {
              throw buildOversizedImageError(label, parsed.byteLength, maxImageBytes);
            }
            resolvedPayload = parsed;
          }
        }
      }
    }

    // 3. IndexedDB stored Blob (enforces the exact same per-image limit as in-memory Blob)
    const attId = att.id || att.fileId;
    if (!resolvedPayload && attId) {
      let record = null;
      try {
        record = await getAttachmentRecord(attId);
      } catch (err) {
        console.warn('[Attachment Storage] Graceful hydration fallback:', err);
      }

      const blob = record?.blob;
      if (blob && (blob instanceof Blob || typeof blob.arrayBuffer === 'function')) {
        const blobSize = typeof blob.size === 'number' ? blob.size : 0;
        if (blobSize > maxImageBytes) {
          throw buildOversizedImageError(label, blobSize, maxImageBytes);
        }
        if (blobSize > 0) {
          const dataUrl = await convertBlobToDataUrl(
            blob,
            att.mimeType || att.type || record?.type || blob.type || classification.mimeHint || ''
          );
          if (dataUrl) {
            const parsed = parseEncodedImagePayload(dataUrl, {
              ...att,
              recordType: record?.type || '',
              blobType: blob.type || '',
              extension: att.extension || record?.extension || '',
              name: att.name || record?.name || '',
              originalName: att.originalName || record?.originalName || ''
            });
            if (parsed.valid) {
              if (parsed.byteLength > maxImageBytes) {
                throw buildOversizedImageError(label, parsed.byteLength, maxImageBytes);
              }
              resolvedPayload = parsed;
            }
          }
        }
      } else if (typeof att.size === 'number' && att.size > maxImageBytes) {
        throw buildOversizedImageError(label, att.size, maxImageBytes);
      }
    } else if (!resolvedPayload && typeof att.size === 'number' && att.size > maxImageBytes) {
      throw buildOversizedImageError(label, att.size, maxImageBytes);
    }

    if (resolvedPayload) {
      const cleanBase = stripTransientFieldsFromAttachment(att);
      delete cleanBase.previewUrl;
      const hydratedAtt = {
        ...cleanBase,
        isImage: true,
        type: resolvedPayload.mimeType,
        mimeType: resolvedPayload.mimeType,
        base64: resolvedPayload.base64
      };

      hydratedImageCount += 1;
      const serializedAttBytes = utf8ByteLength(JSON.stringify(hydratedAtt)) + 2;
      cumulativeBytes += serializedAttBytes;

      if (cumulativeBytes > maxRequestBytes) {
        throw buildCumulativeBudgetError(hydratedImageCount, cumulativeBytes, maxRequestBytes);
      }

      results.push(hydratedAtt);
      continue;
    }

    // Missing IndexedDB record or empty 0-byte blob: degrade gracefully without fabricating bytes
    const fallbackClean = stripTransientFieldsFromAttachment(att);
    delete fallbackClean.base64;
    cumulativeBytes += utf8ByteLength(JSON.stringify(fallbackClean)) + 2;
    results.push(fallbackClean);
  }

  return results;
}

/**
 * Normalizes a single attachment for outgoing /api/chat JSON serialization so an image payload
 * is encoded at most once (`base64` + `mimeType` + `type`) and transient `dataUrl`, `data`,
 * `file`, `blob`, and `previewUrl` fields are stripped. When `includeImageBytes` is false,
 * `base64` is also omitted so text-only providers receive lightweight metadata and OCR text only.
 *
 * @param {any} att
 * @param {Object} [options={}]
 * @param {number} [options.maxImageBytes]
 * @param {boolean} [options.includeImageBytes=true]
 */
export function sanitizeAttachmentForNetwork(att, options = {}) {
  if (!att || typeof att !== 'object') return att;
  const includeImageBytes = options.includeImageBytes !== false;
  const maxImageBytes =
    typeof options.maxImageBytes === 'number' && options.maxImageBytes > 0
      ? options.maxImageBytes
      : MAX_VISION_IMAGE_BYTES;

  const { dataUrl, data, file, blob, previewUrl, ...rest } = att;

  if (!includeImageBytes) {
    delete rest.base64;
    return rest;
  }

  const rawEncoded = rest.base64 || dataUrl || data;

  if (typeof rawEncoded === 'string' && rawEncoded.trim()) {
    const label = rest.originalName || rest.name || rest.filename || rest.id || 'image';
    const parsed = parseEncodedImagePayload(rawEncoded, rest);
    if (!parsed.valid) {
      delete rest.base64;
      return rest;
    }
    if (parsed.byteLength > maxImageBytes) {
      throw buildOversizedImageError(label, parsed.byteLength, maxImageBytes);
    }
    return {
      ...rest,
      isImage: true,
      type: parsed.mimeType,
      mimeType: parsed.mimeType,
      base64: parsed.base64
    };
  }

  delete rest.base64;
  return rest;
}

function sanitizeHistoryMessageForNetwork(msg) {
  if (!msg || typeof msg !== 'object') return msg;
  const next = { ...msg };
  if (Array.isArray(next.attachments)) {
    next.attachments = next.attachments.map((att) => {
      if (!att || typeof att !== 'object') return att;
      const { base64, dataUrl, data, file, blob, previewUrl, ...metaOnly } = att;
      return metaOnly;
    });
  }
  if (Array.isArray(next.referencedAttachments)) {
    next.referencedAttachments = next.referencedAttachments.map((att) => {
      if (!att || typeof att !== 'object') return att;
      const { base64, dataUrl, data, file, blob, previewUrl, ...metaOnly } = att;
      return metaOnly;
    });
  }
  if (Array.isArray(next.alternatives)) {
    next.alternatives = next.alternatives.map((alt) => {
      if (!alt || typeof alt !== 'object' || !Array.isArray(alt.referencedAttachments)) return alt;
      return {
        ...alt,
        referencedAttachments: alt.referencedAttachments.map((att) => {
          if (!att || typeof att !== 'object') return att;
          const { base64, dataUrl, data, file, blob, previewUrl, ...metaOnly } = att;
          return metaOnly;
        })
      };
    });
  }
  return next;
}

/**
 * Normalizes a /api/chat request payload, ensures zero base64/dataUrl duplication,
 * strips raw image bytes for non-vision providers, and validates the complete UTF-8 JSON
 * byte length against the deployed /api/chat budget.
 *
 * @param {any} payload
 * @param {Object} [options={}]
 * @param {number} [options.maxImageBytes]
 * @param {number} [options.maxRequestBytes]
 * @param {boolean} [options.includeImageBytes]
 * @returns {string} Validated JSON body string
 */
export function prepareChatRequestBody(payload, options = {}) {
  const maxImageBytes =
    typeof options.maxImageBytes === 'number' && options.maxImageBytes > 0
      ? options.maxImageBytes
      : MAX_VISION_IMAGE_BYTES;
  const maxRequestBytes =
    typeof options.maxRequestBytes === 'number' && options.maxRequestBytes > 0
      ? options.maxRequestBytes
      : MAX_CHAT_REQUEST_BYTES;
  const includeImageBytes =
    typeof options.includeImageBytes === 'boolean'
      ? options.includeImageBytes
      : payload?.provider !== undefined
        ? isVisionCapableProvider(payload.provider, payload.model)
        : true;

  const normalizedAttachments = Array.isArray(payload?.attachments)
    ? payload.attachments.map((att) =>
        sanitizeAttachmentForNetwork(att, { maxImageBytes, includeImageBytes })
      )
    : [];

  const normalizedHistory = Array.isArray(payload?.history)
    ? payload.history.map(sanitizeHistoryMessageForNetwork)
    : [];

  const normalizedPayload = {
    ...payload,
    history: normalizedHistory,
    attachments: normalizedAttachments
  };

  const jsonBody = JSON.stringify(normalizedPayload);
  const totalBytes = utf8ByteLength(jsonBody);

  if (totalBytes > maxRequestBytes) {
    const imageCount = normalizedAttachments.filter((a) => a && a.base64).length;
    throw new ImagePayloadLimitError(
      imageCount > 0
        ? `The complete chat request (${formatMegabytes(totalBytes)} including ${imageCount} encoded image${imageCount === 1 ? '' : 's'} and conversation context) exceeds the ${formatMegabytes(maxRequestBytes)} serverless request limit. Please resize or compress the image or start a new conversation.`
        : `The chat request payload (${formatMegabytes(totalBytes)}) exceeds the ${formatMegabytes(maxRequestBytes)} request limit.`,
      {
        imageCount,
        totalBytes,
        maxRequestBytes
      }
    );
  }

  return jsonBody;
}

/**
 * Server-side helper that constructs validated Gemini multimodal `imageParts` (`{ mimeType, data }[]`)
 * from incoming `attachments` and `availableDocs`, using an optional server registry resolver first
 * and falling back to client-hydrated `base64` / `dataUrl`.
 * - Strips any Data URL prefixes cleanly without corrupting bytes.
 * - Verifies actual image bytes and supported raster MIME types (rejects SVG, TIFF, and arbitrary image/*).
 * - Enforces per-image and cumulative payload limits instead of silently dropping oversized images.
 *
 * @param {Object} [options={}]
 * @param {Array<any>} [options.attachments=[]]
 * @param {Array<any>} [options.availableDocs=[]]
 * @param {((id: string) => any) | null} [options.resolveRegisteredFile=null]
 * @param {number} [options.maxImageBytes]
 * @param {number} [options.maxRequestBytes]
 * @returns {Array<{ mimeType: string, data: string }>}
 */
export function buildVisionImageParts({
  attachments = [],
  availableDocs = [],
  resolveRegisteredFile = null,
  maxImageBytes = MAX_VISION_IMAGE_BYTES,
  maxRequestBytes = MAX_CHAT_REQUEST_BYTES
} = {}) {
  const imageParts = [];
  const seenIds = new Set();
  const seenData = new Set();
  let cumulativeBytes = JSON_REQUEST_OVERHEAD_RESERVE_BYTES;

  const processCandidate = (item) => {
    if (!item || typeof item !== 'object') return;
    const itemId = item.id || item.fileId || null;
    if (itemId && seenIds.has(itemId)) return;

    const reg = itemId && typeof resolveRegisteredFile === 'function' ? resolveRegisteredFile(itemId) : null;
    const mergedMeta = {
      id: itemId,
      name: item.name || item.originalName || reg?.originalName || '',
      originalName: item.originalName || item.name || reg?.originalName || '',
      filename: item.filename || reg?.diskFilename || item.name || '',
      diskFilename: reg?.diskFilename || '',
      extension: item.extension || reg?.extension || '',
      format: item.format || '',
      mimeType: item.mimeType || item.type || reg?.mimeType || '',
      type: item.type || item.mimeType || reg?.mimeType || '',
      isImage: Boolean(item.isImage || reg?.isImage)
    };

    const classification = classifyImageCandidate(mergedMeta);
    const rawClientEncoded = item.base64 || item.dataUrl || item.data;

    if (!classification.isCandidateImage && !(typeof rawClientEncoded === 'string' && rawClientEncoded.trim())) {
      return;
    }

    const label = mergedMeta.originalName || mergedMeta.name || mergedMeta.filename || itemId || 'image';

    if (classification.unsupportedMime) {
      if (typeof rawClientEncoded === 'string' && rawClientEncoded.trim()) {
        throw new ImagePayloadValidationError(
          `Image '${label}' uses an unsupported format (${classification.unsupportedMime}). Supported vision image formats are JPEG, PNG, WEBP, GIF, BMP, HEIC, and HEIF.`
        );
      }
      return;
    }

    // 1. Prefer server-registered binary buffer if present
    if (reg?.buffer && reg.buffer.length > 0) {
      const u8 = reg.buffer instanceof Uint8Array ? reg.buffer : new Uint8Array(reg.buffer);
      if (u8.length > maxImageBytes) {
        throw buildOversizedImageError(label, u8.length, maxImageBytes);
      }
      const resolvedMime = resolveSupportedImageMime(mergedMeta, u8);
      if (resolvedMime.unsupportedMime || !resolvedMime.mimeType) {
        throw new ImagePayloadValidationError(
          `Image '${label}' uses an unsupported or unrecognized image format (${resolvedMime.unsupportedMime || mergedMeta.mimeType || 'unknown'}). Supported vision image formats are JPEG, PNG, WEBP, GIF, BMP, HEIC, and HEIF.`
        );
      }
      const b64 = bytesToBase64(u8);
      cumulativeBytes += b64.length + 256;
      if (cumulativeBytes > maxRequestBytes) {
        throw buildCumulativeBudgetError(imageParts.length + 1, cumulativeBytes, maxRequestBytes);
      }
      if (itemId) seenIds.add(itemId);
      if (!seenData.has(b64)) {
        seenData.add(b64);
        imageParts.push({ mimeType: resolvedMime.mimeType, data: b64 });
      }
      return;
    }

    // 2. Decode and validate client-supplied base64 / Data URL payload
    if (typeof rawClientEncoded === 'string' && rawClientEncoded.trim()) {
      const parsed = parseEncodedImagePayload(rawClientEncoded, mergedMeta);
      if (!parsed.valid) {
        throw new ImagePayloadValidationError(
          parsed.reason === 'unsupported_mime'
            ? `Image '${label}' uses an unsupported format (${parsed.unsupportedMime}). Supported vision image formats are JPEG, PNG, WEBP, GIF, BMP, HEIC, and HEIF.`
            : `Image '${label}' contains invalid or corrupted base64 image data.`
        );
      }
      if (parsed.byteLength > maxImageBytes) {
        throw buildOversizedImageError(label, parsed.byteLength, maxImageBytes);
      }
      cumulativeBytes += parsed.base64.length + 256;
      if (cumulativeBytes > maxRequestBytes) {
        throw buildCumulativeBudgetError(imageParts.length + 1, cumulativeBytes, maxRequestBytes);
      }
      if (itemId) seenIds.add(itemId);
      if (!seenData.has(parsed.base64)) {
        seenData.add(parsed.base64);
        imageParts.push({ mimeType: parsed.mimeType, data: parsed.base64 });
      }
      return;
    }

    // 3. No binary bytes available: check if an oversized image was omitted so we never silently claim success
    const declaredSize = Number(item.size || item.sizeBytes || reg?.size || 0);
    if (declaredSize > maxImageBytes) {
      throw buildOversizedImageError(label, declaredSize, maxImageBytes);
    }
  };

  if (Array.isArray(attachments)) {
    for (const att of attachments) {
      processCandidate(att);
    }
  }

  if (Array.isArray(availableDocs)) {
    for (const doc of availableDocs) {
      processCandidate(doc);
    }
  }

  return imageParts;
}

/**
 * Checks whether an attachment is available either in browser IndexedDB or on the backend server.
 * @param {Object} attachment
 * @returns {Promise<{ available: boolean, source?: 'indexeddb' | 'server', reason?: string }>}
 */
export async function checkAttachmentStatus(attachment) {
  if (!attachment || !attachment.id) {
    return { available: false, reason: 'invalid_attachment' };
  }

  // 0. Check in-memory Blob or direct dataUrl
  if (attachment.file instanceof Blob || (typeof (attachment.previewUrl || attachment.dataUrl) === 'string' && (attachment.previewUrl || attachment.dataUrl).startsWith('data:'))) {
    return { available: true, source: 'memory' };
  }

  // 1. Check local IndexedDB first (near-instantaneous)
  const localRecord = await getAttachmentRecord(attachment.id);
  if (localRecord && localRecord.blob) {
    return { available: true, source: 'indexeddb', record: localRecord };
  }

  // 2. Check server upload registry
  try {
    const res = await fetch(`/api/upload/${attachment.id}`, { method: 'GET' });
    if (res.ok) {
      return { available: true, source: 'server' };
    }
    if (res.status === 404) {
      return { available: false, reason: 'expired' };
    }
  } catch (e) {
    // If network check fails, fallback to unavailable
  }

  return { available: false, reason: 'unavailable' };
}

/**
 * Determines whether a file format can be natively rendered / previewed in the browser.
 * @param {string} [extension='']
 * @param {string} [mimeType='']
 * @returns {boolean}
 */
export function isFormatPreviewable(extension = '', mimeType = '') {
  const ext = (extension || '').replace('.', '').toLowerCase();
  const mime = (mimeType || '').toLowerCase();

  const previewableExts = ['pdf', 'txt', 'md', 'markdown', 'json', 'xml', 'csv', 'tsv', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'heic', 'heif', 'svg'];
  if (previewableExts.includes(ext)) return true;

  if (
    mime === 'application/pdf' ||
    mime.startsWith('text/') ||
    mime.startsWith('image/') ||
    mime === 'application/json' ||
    mime === 'application/xml'
  ) {
    return true;
  }

  return false;
}

/**
 * Opens an attachment in a new browser tab for preview if supported,
 * or triggers a direct download if the format is not previewable.
 * @param {Object} attachment
 * @returns {Promise<{ success: boolean, action: 'preview' | 'download' | 'unavailable', error?: string }>}
 */
export async function openOrPreviewAttachment(attachment) {
  if (!attachment || !attachment.id) {
    return { success: false, action: 'unavailable', error: 'Missing attachment ID.' };
  }

  const filename = attachment.name || attachment.originalName || 'document';
  const ext = attachment.extension || '';
  const mime = attachment.type || attachment.mimeType || '';
  const canPreview = isFormatPreviewable(ext, mime);

  // 0. Check in-memory File or Blob
  if (attachment.file instanceof Blob) {
    const blobUrl = URL.createObjectURL(attachment.file);
    if (canPreview && typeof window !== 'undefined' && typeof window.open === 'function') {
      const win = window.open(blobUrl, '_blank');
      if (win) {
        setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
        return { success: true, action: 'preview' };
      }
    }
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
    return { success: true, action: 'download' };
  }

  // Direct dataUrl or previewUrl
  const directDataUri = attachment.previewUrl || attachment.dataUrl;
  if (typeof directDataUri === 'string' && (directDataUri.startsWith('data:') || directDataUri.startsWith('blob:'))) {
    if (canPreview && typeof window !== 'undefined' && typeof window.open === 'function') {
      const win = window.open(directDataUri, '_blank');
      if (win) return { success: true, action: 'preview' };
    }
    const link = document.createElement('a');
    link.href = directDataUri;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    return { success: true, action: 'download' };
  }

  // 1. Check IndexedDB
  const localRecord = await getAttachmentRecord(attachment.id);
  if (localRecord && localRecord.blob) {
    const blobUrl = URL.createObjectURL(localRecord.blob);

    if (canPreview && typeof window !== 'undefined' && typeof window.open === 'function') {
      const win = window.open(blobUrl, '_blank');
      if (win) {
        setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
        return { success: true, action: 'preview' };
      }
    }

    // Direct download if preview is not supported or popup blocked
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
    return { success: true, action: 'download' };
  }

  // 2. Fetch from backend server
  try {
    const endpoint = canPreview
      ? `/api/upload/${attachment.id}/file`
      : `/api/upload/${attachment.id}/download`;

    // Test availability first
    const checkRes = await fetch(`/api/upload/${attachment.id}`, { method: 'GET' });
    if (!checkRes.ok) {
      return {
        success: false,
        action: 'unavailable',
        error: 'This attachment has expired or is no longer stored on the server.'
      };
    }

    if (canPreview) {
      try {
        const win = window.open(endpoint, '_blank');
        if (win) {
          return { success: true, action: 'preview' };
        }
      } catch (_) {}
    }
    const link = document.createElement('a');
    link.href = endpoint;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    return { success: true, action: 'download' };
  } catch (err) {
    console.warn('[Attachment Storage] openOrPreviewAttachment error:', err);
    return {
      success: false,
      action: 'unavailable',
      error: 'Unable to open attachment due to a network error.'
    };
  }
}

/**
 * Downloads the original attachment file with its exact original filename.
 * @param {Object} attachment
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
export async function downloadAttachmentFile(attachment) {
  if (!attachment || !attachment.id) {
    return { success: false, error: 'Missing attachment ID.' };
  }

  const filename = attachment.name || attachment.originalName || 'download';

  // 0. Check in-memory Blob
  if (attachment.file instanceof Blob) {
    const blobUrl = URL.createObjectURL(attachment.file);
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
    return { success: true };
  }

  // Direct dataUrl or previewUrl
  const directDataUri = attachment.previewUrl || attachment.dataUrl;
  if (typeof directDataUri === 'string' && (directDataUri.startsWith('data:') || directDataUri.startsWith('blob:'))) {
    const link = document.createElement('a');
    link.href = directDataUri;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    return { success: true };
  }

  // 1. Check IndexedDB
  const localRecord = await getAttachmentRecord(attachment.id);
  if (localRecord && localRecord.blob) {
    const blobUrl = URL.createObjectURL(localRecord.blob);
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
    return { success: true };
  }

  // 2. Use server download endpoint
  try {
    const endpoint = `/api/upload/${attachment.id}/download`;
    const checkRes = await fetch(`/api/upload/${attachment.id}`, { method: 'GET' });
    if (!checkRes.ok) {
      // If server does not have the binary but extraction text is available for textual document
      if (attachment.extraction?.text) {
        const textBlob = new Blob([attachment.extraction.text], { type: 'text/plain;charset=utf-8' });
        const textUrl = URL.createObjectURL(textBlob);
        const link = document.createElement('a');
        link.href = textUrl;
        link.download = filename.endsWith('.txt') ? filename : `${filename}.txt`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(textUrl), 10000);
        return { success: true };
      }

      return {
        success: false,
        error: 'This attachment has expired or is no longer stored on the server.'
      };
    }

    const link = document.createElement('a');
    link.href = endpoint;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: 'Unable to download attachment due to a network error.'
    };
  }
}
