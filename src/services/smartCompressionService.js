/**
 * Orvix Smart Compression Service (Standalone)
 *
 * Provides safe, quality-first client-side optimization for images and PDFs:
 * - Images (PNG, JPEG, WebP): Browser-native decode/canvas optimization that preserves
 *   transparency, avoids aggressive downscaling, and protects text, diagrams, screenshots,
 *   and OCR readability.
 * - PDFs: Lossless structural optimization via `pdf-lib` (object streams & xref cleanup)
 *   without rasterizing pages or altering text, fonts, layout, or selectable content.
 * - Safety Gates: Skips lightweight files, animated images, unsupported formats, and
 *   encrypted/protected PDFs; enforces >= 10% storage savings; validates output signatures,
 *   dimensions, and PDF page counts; preserves MIME types and filename extensions;
 *   supports AbortSignal, timeouts, and stage callbacks; and always returns the untouched
 *   original File object on any failure, abort, timeout, or insufficient savings.
 *
 * NOTE: Intentionally standalone — not wired into ChatArea, ChatPage, or upload routes yet.
 */

export const COMPRESSION_STAGES = Object.freeze({
  ANALYZING: 'analyzing',
  OPTIMIZING: 'optimizing',
  VALIDATING: 'validating',
  COMPLETE: 'complete',
  SKIPPED: 'skipped',
  ABORTED: 'aborted',
  ERROR: 'error'
});

export const COMPRESSION_REASONS = Object.freeze({
  COMPRESSED: 'compressed',
  INVALID_INPUT: 'invalid_input',
  LIGHTWEIGHT_FILE: 'lightweight_file',
  UNSUPPORTED_FORMAT: 'unsupported_format',
  ANIMATED_IMAGE: 'animated_image',
  PROTECTED_PDF: 'protected_pdf',
  PROTECTED_PACKAGE: 'protected_package',
  CORRUPTED_OR_UNREADABLE: 'corrupted_or_unreadable',
  INSUFFICIENT_SAVINGS: 'insufficient_savings',
  VALIDATION_FAILED: 'validation_failed',
  ABORTED: 'aborted',
  TIMEOUT: 'timeout',
  UNSUPPORTED_ENVIRONMENT: 'unsupported_environment',
  ERROR: 'error'
});

export const SMART_COMPRESSION_DEFAULTS = Object.freeze({
  MIN_IMAGE_BYTES: 80 * 1024, // 80 KB
  MIN_PDF_BYTES: 64 * 1024, // 64 KB
  MIN_OPENXML_BYTES: 64 * 1024, // 64 KB
  MIN_SAVINGS_RATIO: 0.1, // Minimum 10% size reduction required
  TIMEOUT_MS: 20_000, // 20s per-file safety timeout
  MAX_PHOTO_DIMENSION: 3072, // Conservative cap only for very large non-text camera photos
  MAX_PHOTO_PIXELS: 12_000_000, // 12 MP threshold before considering gentle scaling
  JPEG_PHOTO_QUALITY: 0.85,
  JPEG_TEXT_QUALITY: 0.91,
  WEBP_PHOTO_QUALITY: 0.86,
  WEBP_TEXT_QUALITY: 0.92
});

const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif'
]);
const SUPPORTED_PDF_MIME_TYPE = 'application/pdf';
const OPENXML_DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const OPENXML_PPTX_MIME =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const OPENXML_XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const SUPPORTED_OPENXML_MIME_TYPES = new Set([
  OPENXML_DOCX_MIME,
  OPENXML_PPTX_MIME,
  OPENXML_XLSX_MIME
]);
const GENERIC_MIME_TYPES = new Set([
  'application/octet-stream',
  'binary/octet-stream',
  'application/binary',
  'application/unknown',
  'unknown/unknown'
]);

const EXTENSION_TO_MIME = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
  '.docx': OPENXML_DOCX_MIME,
  '.pptx': OPENXML_PPTX_MIME,
  '.xlsx': OPENXML_XLSX_MIME
});

const MIME_TO_EXTENSIONS = Object.freeze({
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/webp': ['.webp'],
  'image/gif': ['.gif'],
  'application/pdf': ['.pdf'],
  [OPENXML_DOCX_MIME]: ['.docx'],
  [OPENXML_PPTX_MIME]: ['.pptx'],
  [OPENXML_XLSX_MIME]: ['.xlsx']
});

const OPENXML_CORE_PARTS = Object.freeze({
  [OPENXML_DOCX_MIME]: { partPath: 'word/document.xml', rootMarker: '<w:document' },
  [OPENXML_PPTX_MIME]: { partPath: 'ppt/presentation.xml', rootMarker: '<p:presentation' },
  [OPENXML_XLSX_MIME]: { partPath: 'xl/workbook.xml', rootMarker: '<workbook' }
});

let customImageAdapterForTesting = null;
let customPngOptimizerForTesting = null;
let customGifOptimizerForTesting = null;

/**
 * Allows unit tests running outside a full browser DOM (e.g. Node.js) to inject
 * a deterministic image decode/encode adapter. Never required in browser runtimes.
 * @param {Object|null} adapter
 */
export function setImageCompressionAdapterForTesting(adapter) {
  customImageAdapterForTesting = adapter || null;
}

/**
 * Allows automated tests to inject or override the lossless PNG optimizer
 * (e.g. to simulate an oxipng failure and verify safe Canvas fallback).
 * @param {((bytes: Uint8Array, options?: Object) => Promise<Uint8Array|ArrayBuffer>)|null} optimizer
 */
export function setPngOptimizerForTesting(optimizer) {
  customPngOptimizerForTesting = typeof optimizer === 'function' ? optimizer : null;
}

/**
 * Allows automated tests to inject or override the lossless GIF optimizer
 * (e.g. to verify validation gates, timeout, or safe original-file fallback).
 * @param {((bytes: Uint8Array, options?: Object) => Promise<Uint8Array|ArrayBuffer>)|null} optimizer
 */
export function setGifOptimizerForTesting(optimizer) {
  customGifOptimizerForTesting = typeof optimizer === 'function' ? optimizer : null;
}

function readUint16BE(bytes, offset) {
  return ((bytes[offset] << 8) | bytes[offset + 1]) >>> 0;
}

function readUint16LE(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8)) >>> 0;
}

function readUint32BE(bytes, offset) {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

function readUint32LE(bytes, offset) {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  );
}

function readAscii(bytes, offset, length) {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += String.fromCharCode(bytes[offset + i]);
  }
  return out;
}

function extractExtension(filename) {
  if (typeof filename !== 'string') return '';
  const trimmed = filename.trim().toLowerCase();
  const lastDot = trimmed.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === trimmed.length - 1) return '';
  return trimmed.slice(lastDot);
}

function normalizeMimeType(mime) {
  if (typeof mime !== 'string') return '';
  const clean = mime.split(';')[0].trim().toLowerCase();
  if (clean === 'image/jpg' || clean === 'image/pjpeg') return 'image/jpeg';
  if (clean === 'application/x-pdf') return 'application/pdf';
  return clean;
}

export function isGenericMimeType(mime) {
  const normalized = normalizeMimeType(mime);
  return !normalized || GENERIC_MIME_TYPES.has(normalized);
}

function buildResult(file, compressed, originalSize, finalSize, reason) {
  return {
    file,
    compressed: Boolean(compressed),
    originalSize: Number.isFinite(originalSize) ? originalSize : 0,
    finalSize: Number.isFinite(finalSize) ? finalSize : 0,
    reason
  };
}

function emitStage(onStage, stage, details = {}) {
  if (typeof onStage !== 'function') return;
  try {
    onStage({
      stage,
      timestamp: Date.now(),
      ...details
    });
  } catch (_) {
    // User callback errors must never disrupt compression
  }
}

function createAbortError(message = 'Compression aborted') {
  const err = new Error(message);
  err.name = 'AbortError';
  err.code = 'ABORT_ERR';
  return err;
}

function createTimeoutError(timeoutMs) {
  const err = new Error(`Compression timed out after ${timeoutMs}ms`);
  err.name = 'TimeoutError';
  err.code = 'TIMEOUT_ERR';
  return err;
}

/**
 * Inspects binary magic bytes to identify true file format.
 * @param {Uint8Array} bytes
 * @returns {'image/png'|'image/jpeg'|'image/webp'|'image/gif'|'application/pdf'|null}
 */
export function detectFormatFromSignature(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 4) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }

  // JPEG: FF D8 FF
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }

  // WEBP: RIFF....WEBP
  if (
    bytes.length >= 12 &&
    readAscii(bytes, 0, 4) === 'RIFF' &&
    readAscii(bytes, 8, 4) === 'WEBP'
  ) {
    return 'image/webp';
  }

  // GIF: GIF87a / GIF89a
  if (
    bytes.length >= 6 &&
    (readAscii(bytes, 0, 6) === 'GIF87a' || readAscii(bytes, 0, 6) === 'GIF89a')
  ) {
    return 'image/gif';
  }

  // PDF: %PDF- within first 1024 bytes (standard PDF header window)
  const scanLimit = Math.min(bytes.length - 4, 1024);
  for (let i = 0; i <= scanLimit; i++) {
    if (
      bytes[i] === 0x25 && // %
      bytes[i + 1] === 0x50 && // P
      bytes[i + 2] === 0x44 && // D
      bytes[i + 3] === 0x46 && // F
      bytes[i + 4] === 0x2d // -
    ) {
      return 'application/pdf';
    }
  }

  // ZIP / OpenXML container inspection (PK\x03\x04 or PK\x05\x06)
  if (
    bytes.length >= 22 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    ((bytes[2] === 0x03 && bytes[3] === 0x04) || (bytes[2] === 0x05 && bytes[3] === 0x06))
  ) {
    const zipInfo = inspectOpenXmlZipContainer(bytes);
    if (zipInfo.openXmlMime) {
      return zipInfo.openXmlMime;
    }
    return 'application/zip';
  }

  return null;
}

/**
 * Checks whether binary bytes contain a UTF-16LE ASCII string (used in OLE2 directory streams
 * such as `EncryptedPackage` or `EncryptionInfo` inside encrypted Office documents).
 */
function containsUtf16LeAscii(bytes, asciiTarget) {
  if (!(bytes instanceof Uint8Array) || !asciiTarget) return false;
  const needLen = asciiTarget.length * 2;
  if (bytes.length < needLen) return false;
  const limit = bytes.length - needLen;
  const firstLo = asciiTarget.charCodeAt(0);
  for (let i = 0; i <= limit; i++) {
    if (bytes[i] !== firstLo || bytes[i + 1] !== 0) continue;
    let match = true;
    for (let j = 1; j < asciiTarget.length; j++) {
      if (bytes[i + j * 2] !== asciiTarget.charCodeAt(j) || bytes[i + j * 2 + 1] !== 0) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

/**
 * Detects Microsoft OLE2 Compound Binary encrypted OOXML wrapper (`D0 CF 11 E0 A1 B1 1A E1`)
 * containing `EncryptedPackage` or `EncryptionInfo`.
 */
export function isEncryptedOle2OpenXml(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 512) return false;
  if (
    bytes[0] !== 0xd0 ||
    bytes[1] !== 0xcf ||
    bytes[2] !== 0x11 ||
    bytes[3] !== 0xe0 ||
    bytes[4] !== 0xa1 ||
    bytes[5] !== 0xb1 ||
    bytes[6] !== 0x1a ||
    bytes[7] !== 0xe1
  ) {
    return false;
  }
  return containsUtf16LeAscii(bytes, 'EncryptedPackage') || containsUtf16LeAscii(bytes, 'EncryptionInfo');
}

/**
 * Inspects raw ZIP Central Directory headers synchronously to identify OpenXML package type,
 * encryption flags, and digital signature entry names without decompressing payloads.
 */
export function inspectOpenXmlZipContainer(bytes) {
  const result = {
    isZip: false,
    openXmlMime: null,
    hasEncryptedEntry: false,
    hasProtectionEntry: false,
    entryNames: []
  };

  if (
    !(bytes instanceof Uint8Array) ||
    bytes.length < 22 ||
    bytes[0] !== 0x50 ||
    bytes[1] !== 0x4b
  ) {
    return result;
  }

  result.isZip = true;
  const eocdMinOffset = Math.max(0, bytes.length - 65557);
  let eocdOffset = -1;
  for (let i = bytes.length - 22; i >= eocdMinOffset; i--) {
    if (
      bytes[i] === 0x50 &&
      bytes[i + 1] === 0x4b &&
      bytes[i + 2] === 0x05 &&
      bytes[i + 3] === 0x06
    ) {
      const commentLen = readUint16LE(bytes, i + 20);
      if (i + 22 + commentLen <= bytes.length) {
        eocdOffset = i;
        break;
      }
    }
  }

  if (eocdOffset === -1) {
    return result;
  }

  const cdSize = readUint32LE(bytes, eocdOffset + 12);
  const cdOffset = readUint32LE(bytes, eocdOffset + 16);
  const decoder = new TextDecoder('utf-8');

  if (cdOffset + cdSize <= eocdOffset) {
    let pos = cdOffset;
    const cdEnd = cdOffset + cdSize;
    while (pos + 46 <= cdEnd) {
      if (
        bytes[pos] !== 0x50 ||
        bytes[pos + 1] !== 0x4b ||
        bytes[pos + 2] !== 0x01 ||
        bytes[pos + 3] !== 0x02
      ) {
        break;
      }
      const gpFlag = readUint16LE(bytes, pos + 8);
      const compMethod = readUint16LE(bytes, pos + 10);
      if ((gpFlag & 0x0001) !== 0 || compMethod === 99) {
        result.hasEncryptedEntry = true;
      }
      const nameLen = readUint16LE(bytes, pos + 28);
      const extraLen = readUint16LE(bytes, pos + 30);
      const commentLen = readUint16LE(bytes, pos + 32);
      if (pos + 46 + nameLen + extraLen + commentLen > cdEnd) {
        break;
      }
      const name = decoder.decode(bytes.subarray(pos + 46, pos + 46 + nameLen));
      result.entryNames.push(name);
      pos += 46 + nameLen + extraLen + commentLen;
    }
  }

  const lowerNames = new Set(result.entryNames.map((n) => n.toLowerCase()));
  for (const name of lowerNames) {
    if (
      name.startsWith('_xmlsignatures/') ||
      name.endsWith('.sigs') ||
      name.includes('vbaprojectsignature.bin') ||
      name === 'encryptioninfo' ||
      name === 'encryptedpackage' ||
      name.includes('drmcontent') ||
      name.includes('dataspaces') ||
      name.includes('rightsmanagement')
    ) {
      result.hasProtectionEntry = true;
    }
  }

  if (lowerNames.has('[content_types].xml')) {
    if (lowerNames.has('word/document.xml')) {
      result.openXmlMime = OPENXML_DOCX_MIME;
    } else if (lowerNames.has('ppt/presentation.xml')) {
      result.openXmlMime = OPENXML_PPTX_MIME;
    } else if (lowerNames.has('xl/workbook.xml')) {
      result.openXmlMime = OPENXML_XLSX_MIME;
    }
  }

  return result;
}

/**
 * Extracts image dimensions and structural metadata from binary headers.
 * @param {Uint8Array} bytes
 * @param {string} mimeType
 * @returns {{ valid: boolean, width: number, height: number, hasAlphaMetadata?: boolean }}
 */
export function parseImageHeaderInfo(bytes, mimeType) {
  if (!(bytes instanceof Uint8Array)) return { valid: false, width: 0, height: 0 };

  if (mimeType === 'image/png') {
    if (detectFormatFromSignature(bytes) !== 'image/png' || bytes.length < 33) {
      return { valid: false, width: 0, height: 0 };
    }
    const ihdrLength = readUint32BE(bytes, 8);
    const ihdrType = readAscii(bytes, 12, 4);
    if (ihdrType !== 'IHDR' || ihdrLength < 13) {
      return { valid: false, width: 0, height: 0 };
    }
    const width = readUint32BE(bytes, 16);
    const height = readUint32BE(bytes, 20);
    const colorType = bytes[25];
    let hasTrns = false;
    let hasIend = false;

    let offset = 8;
    while (offset + 12 <= bytes.length) {
      const len = readUint32BE(bytes, offset);
      const type = readAscii(bytes, offset + 4, 4);
      if (offset + 12 + len > bytes.length) break;
      if (type === 'tRNS') hasTrns = true;
      if (type === 'IEND') {
        hasIend = true;
        break;
      }
      offset += 12 + len;
    }

    return {
      valid: width > 0 && height > 0 && hasIend,
      width,
      height,
      hasAlphaMetadata: colorType === 4 || colorType === 6 || hasTrns
    };
  }

  if (mimeType === 'image/webp') {
    if (detectFormatFromSignature(bytes) !== 'image/webp' || bytes.length < 20) {
      return { valid: false, width: 0, height: 0 };
    }
    const declaredRiffSize = readUint32LE(bytes, 4);
    if (declaredRiffSize + 8 > bytes.length) {
      return { valid: false, width: 0, height: 0 };
    }

    let offset = 12;
    let width = 0;
    let height = 0;
    let hasAlphaMetadata = false;

    while (offset + 8 <= bytes.length) {
      const chunkId = readAscii(bytes, offset, 4);
      const chunkSize = readUint32LE(bytes, offset + 4);
      const payloadOffset = offset + 8;
      if (payloadOffset + chunkSize > bytes.length) break;

      if (chunkId === 'VP8X' && chunkSize >= 10) {
        const flags = bytes[payloadOffset];
        hasAlphaMetadata = (flags & 0x10) !== 0;
        width =
          1 +
          (bytes[payloadOffset + 4] |
            (bytes[payloadOffset + 5] << 8) |
            (bytes[payloadOffset + 6] << 16));
        height =
          1 +
          (bytes[payloadOffset + 7] |
            (bytes[payloadOffset + 8] << 8) |
            (bytes[payloadOffset + 9] << 16));
      } else if (chunkId === 'VP8L' && chunkSize >= 5 && bytes[payloadOffset] === 0x2f) {
        const packed = readUint32LE(bytes, payloadOffset + 1);
        width = (packed & 0x3fff) + 1;
        height = ((packed >> 14) & 0x3fff) + 1;
        hasAlphaMetadata = ((packed >> 28) & 0x01) !== 0;
      } else if (chunkId === 'VP8 ' && chunkSize >= 10) {
        if (
          bytes[payloadOffset + 3] === 0x9d &&
          bytes[payloadOffset + 4] === 0x01 &&
          bytes[payloadOffset + 5] === 0x2a
        ) {
          width = readUint16LE(bytes, payloadOffset + 6) & 0x3fff;
          height = readUint16LE(bytes, payloadOffset + 8) & 0x3fff;
        }
      } else if (chunkId === 'ALPH') {
        hasAlphaMetadata = true;
      }

      offset += 8 + chunkSize + (chunkSize % 2);
    }

    return {
      valid: width > 0 && height > 0,
      width,
      height,
      hasAlphaMetadata
    };
  }

  if (mimeType === 'image/jpeg') {
    if (detectFormatFromSignature(bytes) !== 'image/jpeg' || bytes.length < 4) {
      return { valid: false, width: 0, height: 0 };
    }
    let pos = 2;
    let width = 0;
    let height = 0;

    while (pos + 1 < bytes.length) {
      while (pos < bytes.length && bytes[pos] !== 0xff) pos++;
      while (pos < bytes.length && bytes[pos] === 0xff) pos++;
      if (pos >= bytes.length) break;

      const marker = bytes[pos];
      pos++;

      if (marker === 0xd9 || marker === 0xda) break; // EOI or SOS
      if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
        continue;
      }
      if (pos + 2 > bytes.length) break;
      const segLen = readUint16BE(bytes, pos);
      if (segLen < 2 || pos + segLen > bytes.length) break;

      const isSof =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);

      if (isSof && segLen >= 7) {
        height = readUint16BE(bytes, pos + 3);
        width = readUint16BE(bytes, pos + 5);
        break;
      }

      pos += segLen;
    }

    return {
      valid: width > 0 && height > 0,
      width,
      height,
      hasAlphaMetadata: false
    };
  }

  if (mimeType === 'image/gif') {
    const gifMeta = parseGifMetadata(bytes);
    return {
      valid: gifMeta.valid,
      width: gifMeta.width,
      height: gifMeta.height,
      hasAlphaMetadata: gifMeta.hasAlphaMetadata
    };
  }

  return { valid: false, width: 0, height: 0 };
}

/**
 * Parses GIF87a/GIF89a binary container structure:
 * - Logical screen dimensions, version, GCT size
 * - Every frame descriptor & Graphic Control Extension (delayCs, disposalMethod, transparency)
 * - NETSCAPE2.0 / ANIMEXTS1.0 animation loop count
 * - Structural completeness and trailer (`0x3B`) termination
 * @param {Uint8Array} bytes
 */
export function parseGifMetadata(bytes) {
  const empty = {
    valid: false,
    width: 0,
    height: 0,
    frameCount: 0,
    frames: [],
    loopCount: null,
    hasLoopExtension: false,
    hasAlphaMetadata: false,
    headerVersion: ''
  };

  if (!(bytes instanceof Uint8Array) || bytes.length < 14) {
    return empty;
  }

  if (detectFormatFromSignature(bytes) !== 'image/gif') {
    return empty;
  }

  const headerVersion = readAscii(bytes, 0, 6);
  const width = readUint16LE(bytes, 6);
  const height = readUint16LE(bytes, 8);
  if (width <= 0 || height <= 0) {
    return empty;
  }

  const packed = bytes[10];
  let offset = 13;
  if ((packed & 0x80) !== 0) {
    const gctSize = 3 * (1 << ((packed & 0x07) + 1));
    if (offset + gctSize > bytes.length) {
      return empty;
    }
    offset += gctSize;
  }

  let pendingGce = null;
  let loopCount = null;
  let hasLoopExtension = false;
  let hasTrailer = false;
  let truncated = false;
  const frames = [];

  while (offset < bytes.length) {
    const introducer = bytes[offset++];

    if (introducer === 0x3b) {
      hasTrailer = true;
      break;
    }

    if (introducer === 0x21) {
      if (offset >= bytes.length) {
        truncated = true;
        break;
      }
      const label = bytes[offset++];
      const subBlocks = [];

      while (true) {
        if (offset >= bytes.length) {
          truncated = true;
          break;
        }
        const subLen = bytes[offset++];
        if (subLen === 0) break;
        if (offset + subLen > bytes.length) {
          truncated = true;
          break;
        }
        subBlocks.push(bytes.subarray(offset, offset + subLen));
        offset += subLen;
      }
      if (truncated) break;

      if (label === 0xf9 && subBlocks.length > 0 && subBlocks[0].length >= 4) {
        const gceData = subBlocks[0];
        const gcePacked = gceData[0];
        pendingGce = {
          disposalMethod: (gcePacked >> 2) & 0x07,
          hasTransparency: (gcePacked & 0x01) !== 0,
          delayCs: readUint16LE(gceData, 1),
          transparentColorIndex: gceData[3]
        };
      } else if (label === 0xff && subBlocks.length >= 2 && subBlocks[0].length >= 11) {
        const appId = readAscii(subBlocks[0], 0, 11);
        if (
          (appId === 'NETSCAPE2.0' || appId === 'ANIMEXTS1.0') &&
          subBlocks[1].length >= 3 &&
          subBlocks[1][0] === 0x01
        ) {
          hasLoopExtension = true;
          loopCount = readUint16LE(subBlocks[1], 1);
        }
      }
      continue;
    }

    if (introducer === 0x2c) {
      if (offset + 9 > bytes.length) {
        truncated = true;
        break;
      }
      const left = readUint16LE(bytes, offset);
      const top = readUint16LE(bytes, offset + 2);
      const frameWidth = readUint16LE(bytes, offset + 4);
      const frameHeight = readUint16LE(bytes, offset + 6);
      const localPacked = bytes[offset + 8];
      offset += 9;

      if (frameWidth <= 0 || frameHeight <= 0) {
        truncated = true;
        break;
      }

      const hasLocalColorTable = (localPacked & 0x80) !== 0;
      if (hasLocalColorTable) {
        const lctSize = 3 * (1 << ((localPacked & 0x07) + 1));
        if (offset + lctSize > bytes.length) {
          truncated = true;
          break;
        }
        offset += lctSize;
      }

      if (offset >= bytes.length) {
        truncated = true;
        break;
      }
      const lzwMinCodeSize = bytes[offset++];
      if (lzwMinCodeSize < 2 || lzwMinCodeSize > 11) {
        truncated = true;
        break;
      }

      while (true) {
        if (offset >= bytes.length) {
          truncated = true;
          break;
        }
        const subLen = bytes[offset++];
        if (subLen === 0) break;
        if (offset + subLen > bytes.length) {
          truncated = true;
          break;
        }
        offset += subLen;
      }
      if (truncated) break;

      frames.push({
        left,
        top,
        width: frameWidth,
        height: frameHeight,
        delayCs: pendingGce ? pendingGce.delayCs : 0,
        disposalMethod: pendingGce ? pendingGce.disposalMethod : 0,
        hasTransparency: pendingGce ? pendingGce.hasTransparency : false,
        transparentColorIndex: pendingGce ? pendingGce.transparentColorIndex : 0,
        hasLocalColorTable
      });
      pendingGce = null;
      continue;
    }

    // Any unexpected block introducer before trailer indicates corrupt/malformed stream
    truncated = true;
    break;
  }

  const valid = !truncated && hasTrailer && frames.length >= 1;
  return {
    valid,
    width,
    height,
    frameCount: frames.length,
    frames,
    loopCount,
    hasLoopExtension,
    hasAlphaMetadata: frames.some((f) => f.hasTransparency),
    headerVersion
  };
}

/**
 * Detects animated images (APNG, animated WebP, animated GIF) from binary chunks.
 * @param {Uint8Array} bytes
 * @param {string} mimeType
 * @returns {boolean}
 */
export function detectAnimatedImage(bytes, mimeType) {
  if (!(bytes instanceof Uint8Array)) return false;

  if (mimeType === 'image/png') {
    // APNG contains an `acTL` chunk before `IDAT`
    let offset = 8;
    while (offset + 12 <= bytes.length) {
      const len = readUint32BE(bytes, offset);
      const type = readAscii(bytes, offset + 4, 4);
      if (offset + 12 + len > bytes.length) break;
      if (type === 'acTL') return true;
      if (type === 'IDAT') return false;
      offset += 12 + len;
    }
    return false;
  }

  if (mimeType === 'image/webp') {
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const chunkId = readAscii(bytes, offset, 4);
      const chunkSize = readUint32LE(bytes, offset + 4);
      const payloadOffset = offset + 8;
      if (payloadOffset + chunkSize > bytes.length) break;

      if (chunkId === 'VP8X' && chunkSize >= 1) {
        const flags = bytes[payloadOffset];
        if ((flags & 0x02) !== 0) return true;
      }
      if (chunkId === 'ANIM' || chunkId === 'ANMF') {
        return true;
      }
      offset += 8 + chunkSize + (chunkSize % 2);
    }
    return false;
  }

  if (mimeType === 'image/gif') {
    // Count image descriptor separators (0x2C) outside extension sub-blocks (heuristic scan)
    let offset = 6;
    if (offset + 7 > bytes.length) return false;
    const packed = bytes[offset + 4];
    offset += 7;
    if ((packed & 0x80) !== 0) {
      const gctSize = 3 * (1 << ((packed & 0x07) + 1));
      offset += gctSize;
    }

    let frameCount = 0;
    while (offset < bytes.length) {
      const introducer = bytes[offset++];
      if (introducer === 0x3b) break; // Trailer
      if (introducer === 0x2c) {
        frameCount++;
        if (frameCount > 1) return true;
        if (offset + 9 > bytes.length) break;
        const localPacked = bytes[offset + 8];
        offset += 9;
        if ((localPacked & 0x80) !== 0) {
          offset += 3 * (1 << ((localPacked & 0x07) + 1));
        }
        if (offset >= bytes.length) break;
        offset++; // LZW minimum code size
        while (offset < bytes.length) {
          const subLen = bytes[offset++];
          if (subLen === 0) break;
          offset += subLen;
        }
      } else if (introducer === 0x21) {
        if (offset >= bytes.length) break;
        offset++; // label
        while (offset < bytes.length) {
          const subLen = bytes[offset++];
          if (subLen === 0) break;
          offset += subLen;
        }
      } else {
        break;
      }
    }
    return frameCount > 1;
  }

  return false;
}

/**
 * Inspects decoded RGBA pixel buffer to detect transparency and whether the image
 * contains text, screenshots, diagrams, or high-contrast UI regions.
 * @param {Uint8ClampedArray} data
 * @param {number} width
 * @param {number} height
 * @returns {{ hasTransparentPixels: boolean, isTextOrDiagramLikely: boolean }}
 */
export function analyzeImagePixels(data, width, height) {
  if (!data || !width || !height) {
    return { hasTransparentPixels: false, isTextOrDiagramLikely: false };
  }

  const totalPixels = width * height;
  const stride = Math.max(1, Math.floor(totalPixels / 16000));
  let sampled = 0;
  let transparentCount = 0;
  let flatTransitions = 0;
  let sharpContrastTransitions = 0;
  let transitionSamples = 0;

  for (let idx = 0; idx < totalPixels; idx += stride) {
    const p = idx * 4;
    if (p + 3 >= data.length) break;
    sampled++;
    if (data[p + 3] < 255) {
      transparentCount++;
    }

    const col = idx % width;
    if (col + 1 < width && p + 7 < data.length) {
      const lum1 = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000;
      const lum2 = (data[p + 4] * 299 + data[p + 5] * 587 + data[p + 6] * 114) / 1000;
      const diff = Math.abs(lum1 - lum2);
      transitionSamples++;
      if (diff <= 1.5) {
        flatTransitions++;
      } else if (diff >= 55) {
        sharpContrastTransitions++;
      }
    }
  }

  const flatRatio = transitionSamples > 0 ? flatTransitions / transitionSamples : 0;
  const sharpRatio = transitionSamples > 0 ? sharpContrastTransitions / transitionSamples : 0;

  // Screenshots, diagrams, and scanned pages typically have large flat background areas
  // combined with crisp high-contrast edges.
  const isTextOrDiagramLikely =
    (flatRatio >= 0.48 && sharpRatio >= 0.015) || flatRatio >= 0.72;

  return {
    hasTransparentPixels: sampled > 0 && transparentCount > 0,
    isTextOrDiagramLikely
  };
}

/**
 * Computes safe target dimensions without ever aggressively downscaling or hurting OCR/text.
 * Text, diagrams, screenshots, PNGs, and images under 12MP / 3072px are always kept 1:1.
 */
export function computeSafeTargetDimensions(
  width,
  height,
  { isTextOrDiagramLikely = false, mimeType = '' } = {}
) {
  if (!width || !height) return { targetWidth: width, targetHeight: height, scaled: false };

  // Never downscale screenshots, diagrams, text-heavy images, or PNGs
  if (isTextOrDiagramLikely || mimeType === 'image/png') {
    return { targetWidth: width, targetHeight: height, scaled: false };
  }

  const maxDim = SMART_COMPRESSION_DEFAULTS.MAX_PHOTO_DIMENSION;
  const maxPixels = SMART_COMPRESSION_DEFAULTS.MAX_PHOTO_PIXELS;
  const longestEdge = Math.max(width, height);
  const pixelCount = width * height;

  // Keep native 1:1 unless both extraordinarily large and photographic
  if (longestEdge <= maxDim && pixelCount <= maxPixels) {
    return { targetWidth: width, targetHeight: height, scaled: false };
  }

  // Never aggressively downscale extreme aspect-ratio tall documents or wide banners
  const aspectRatio = longestEdge / Math.min(width, height);
  if (aspectRatio > 2.5) {
    return { targetWidth: width, targetHeight: height, scaled: false };
  }

  const scaleByEdge = maxDim / longestEdge;
  const scaleByPixels = Math.sqrt(maxPixels / pixelCount);
  const scale = Math.min(1, Math.max(scaleByEdge, scaleByPixels));

  // Only scale if we stay >= 0.5x to guarantee we never aggressively downscale
  if (scale >= 0.99 || scale < 0.5) {
    return { targetWidth: width, targetHeight: height, scaled: false };
  }

  return {
    targetWidth: Math.max(1, Math.round(width * scale)),
    targetHeight: Math.max(1, Math.round(height * scale)),
    scaled: true
  };
}

/**
 * Default browser-native image decode/analyze/encode pipeline.
 */
function getBrowserImageAdapter() {
  if (customImageAdapterForTesting) return customImageAdapterForTesting;

  const hasCanvas =
    typeof OffscreenCanvas !== 'undefined' ||
    (typeof document !== 'undefined' && typeof document.createElement === 'function');
  const hasDecode =
    typeof createImageBitmap === 'function' ||
    (typeof Image !== 'undefined' &&
      typeof URL !== 'undefined' &&
      typeof URL.createObjectURL === 'function');

  if (!hasCanvas || !hasDecode) return null;

  return {
    async decodeAndAnalyze(blob) {
      let bitmap = null;
      let objectUrl = null;
      try {
        let source;
        let width;
        let height;

        if (typeof createImageBitmap === 'function') {
          bitmap = await createImageBitmap(blob);
          source = bitmap;
          width = bitmap.width;
          height = bitmap.height;
        } else {
          objectUrl = URL.createObjectURL(blob);
          const img = await new Promise((resolve, reject) => {
            const el = new Image();
            el.onload = () => resolve(el);
            el.onerror = () => reject(new Error('Failed to decode image'));
            el.src = objectUrl;
          });
          source = img;
          width = img.naturalWidth || img.width;
          height = img.naturalHeight || img.height;
        }

        if (!width || !height) {
          throw new Error('Invalid decoded image dimensions');
        }

        const analysisCanvas =
          typeof OffscreenCanvas !== 'undefined'
            ? new OffscreenCanvas(width, height)
            : document.createElement('canvas');
        analysisCanvas.width = width;
        analysisCanvas.height = height;

        const ctx = analysisCanvas.getContext('2d', { willReadFrequently: true, alpha: true });
        if (!ctx) {
          throw new Error('2D canvas context unavailable');
        }
        ctx.clearRect(0, 0, width, height);
        ctx.drawImage(source, 0, 0, width, height);

        let pixelStats = { hasTransparentPixels: false, isTextOrDiagramLikely: false };
        try {
          const imgData = ctx.getImageData(0, 0, width, height);
          pixelStats = analyzeImagePixels(imgData.data, width, height);
        } catch (_) {
          // Non-fatal if canvas pixel readback is blocked
        }

        return {
          width,
          height,
          ...pixelStats,
          source,
          release() {
            try {
              bitmap?.close?.();
            } catch (_) {}
            if (objectUrl) {
              try {
                URL.revokeObjectURL(objectUrl);
              } catch (_) {}
            }
          }
        };
      } catch (err) {
        try {
          bitmap?.close?.();
        } catch (_) {}
        if (objectUrl) {
          try {
            URL.revokeObjectURL(objectUrl);
          } catch (_) {}
        }
        throw err;
      }
    },

    async encode(decoded, { targetWidth, targetHeight, mimeType, quality }) {
      const useOffscreen =
        typeof OffscreenCanvas !== 'undefined' &&
        typeof OffscreenCanvas.prototype.convertToBlob === 'function';

      const canvas = useOffscreen
        ? new OffscreenCanvas(targetWidth, targetHeight)
        : document.createElement('canvas');
      canvas.width = targetWidth;
      canvas.height = targetHeight;

      const ctx = canvas.getContext('2d', { alpha: true });
      if (!ctx) {
        throw new Error('2D canvas context unavailable for encoding');
      }

      ctx.clearRect(0, 0, targetWidth, targetHeight);
      if (targetWidth !== decoded.width || targetHeight !== decoded.height) {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
      }
      ctx.drawImage(decoded.source, 0, 0, targetWidth, targetHeight);

      if (useOffscreen) {
        const opts = mimeType === 'image/png' ? { type: mimeType } : { type: mimeType, quality };
        return await canvas.convertToBlob(opts);
      }

      return await new Promise((resolve, reject) => {
        try {
          canvas.toBlob(
            (outBlob) => {
              if (!outBlob) {
                reject(new Error(`Canvas failed to encode ${mimeType}`));
              } else {
                resolve(outBlob);
              }
            },
            mimeType,
            mimeType === 'image/png' ? undefined : quality
          );
        } catch (err) {
          reject(err);
        }
      });
    }
  };
}

/**
 * Checks raw PDF bytes across the full document (including incremental updates)
 * for encryption (/Encrypt) or digital signature (/Sig, /ByteRange) indicators.
 */
export function hasRawPdfProtectionMarkers(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) return false;

  const decoder = new TextDecoder('latin1');
  const chunkSize = 512 * 1024;
  const overlap = 256;
  const encryptPattern = /\/Encrypt\s+\d+\s+\d+\s+R\b|\/Encrypt\s*<</;
  const sigPattern = /\/Sig(?=$|[\s\[\]<>()/{}%])/;
  const byteRangePattern = /\/ByteRange(?=$|[\s\[\]<>()/{}%])/;

  for (let offset = 0; offset < bytes.length; offset += chunkSize - overlap) {
    const end = Math.min(bytes.length, offset + chunkSize);
    const text = decoder.decode(bytes.subarray(offset, end));
    if (encryptPattern.test(text) || sigPattern.test(text) || byteRangePattern.test(text)) {
      return true;
    }
    if (end >= bytes.length) break;
  }

  return false;
}

/**
 * Inspects parsed pdf-lib indirect objects (including decompressed object streams)
 * for digital signature dictionaries, /ByteRange entries, AcroForm SigFlags, or Perms.
 */
function hasParsedPdfProtectionMarkers(pdfDoc, pdfLibModule) {
  try {
    const { PDFDict, PDFStream, PDFName, PDFNumber } = pdfLibModule || {};
    if (!pdfDoc?.context || typeof pdfDoc.context.enumerateIndirectObjects !== 'function') {
      return false;
    }

    const sigName = PDFName?.of ? PDFName.of('Sig') : null;
    const docTsName = PDFName?.of ? PDFName.of('DocTimeStamp') : null;
    const typeKey = PDFName?.of ? PDFName.of('Type') : null;
    const ftKey = PDFName?.of ? PDFName.of('FT') : null;
    const byteRangeKey = PDFName?.of ? PDFName.of('ByteRange') : null;
    const sigFlagsKey = PDFName?.of ? PDFName.of('SigFlags') : null;
    const permsKey = PDFName?.of ? PDFName.of('Perms') : null;

    for (const [, obj] of pdfDoc.context.enumerateIndirectObjects()) {
      const dict =
        PDFDict && obj instanceof PDFDict
          ? obj
          : PDFStream && obj instanceof PDFStream
          ? obj.dict
          : null;
      if (!dict || typeof dict.get !== 'function') continue;

      if (byteRangeKey && dict.has(byteRangeKey)) {
        return true;
      }
      if (permsKey && dict.has(permsKey)) {
        return true;
      }
      if (sigName && typeKey && dict.get(typeKey) === sigName) {
        return true;
      }
      if (docTsName && typeKey && dict.get(typeKey) === docTsName) {
        return true;
      }
      if (sigName && ftKey && dict.get(ftKey) === sigName) {
        return true;
      }
      if (sigFlagsKey && dict.has(sigFlagsKey)) {
        const flags = dict.get(sigFlagsKey);
        if (PDFNumber && flags instanceof PDFNumber && flags.asNumber() > 0) {
          return true;
        }
      }
    }
  } catch (_) {
    // Non-fatal; fall through safely
  }
  return false;
}

/**
 * Checks whether an error thrown by pdf-lib indicates encryption / password protection.
 */
function isPdfEncryptionError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  return (
    msg.includes('encrypt') ||
    msg.includes('password') ||
    msg.includes('protected')
  );
}

/**
 * Validates that a PDF buffer has a valid %PDF- header, %%EOF trailer,
 * loadable structure, matching page count, and matching page dimensions.
 */
async function validateOptimizedPdf(bytes, expectedPageCount, expectedPageSizes, PDFDocument) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 16) {
    return { valid: false, reason: 'empty_or_truncated_pdf' };
  }
  if (detectFormatFromSignature(bytes) !== 'application/pdf') {
    return { valid: false, reason: 'invalid_pdf_signature' };
  }

  const tailSlice = new TextDecoder('latin1').decode(
    bytes.subarray(Math.max(0, bytes.length - 1024))
  );
  if (!tailSlice.includes('%%EOF')) {
    return { valid: false, reason: 'missing_pdf_eof' };
  }

  const verifyDoc = await PDFDocument.load(bytes, { updateMetadata: false });
  const actualCount = verifyDoc.getPageCount();
  if (actualCount !== expectedPageCount || actualCount <= 0) {
    return { valid: false, reason: 'page_count_mismatch' };
  }

  const pages = verifyDoc.getPages();
  for (let i = 0; i < pages.length; i++) {
    const size = pages[i].getSize();
    const expected = expectedPageSizes[i];
    if (
      Math.abs(size.width - expected.width) > 0.5 ||
      Math.abs(size.height - expected.height) > 0.5
    ) {
      return { valid: false, reason: 'page_dimensions_mismatch' };
    }
  }

  return { valid: true };
}

/**
 * Races an async operation against an AbortSignal and a shared deadline.
 */
async function runWithCancellation(promiseOrFn, { signal, deadlineAt, timeoutMs }) {
  if (signal?.aborted) {
    throw createAbortError();
  }
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) {
    throw createTimeoutError(timeoutMs);
  }

  let timerId = null;
  let onAbort = null;

  const guardPromise = new Promise((_, reject) => {
    timerId = setTimeout(() => {
      reject(createTimeoutError(timeoutMs));
    }, remainingMs);

    if (signal) {
      onAbort = () => reject(createAbortError());
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });

  try {
    const workPromise = typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn;
    return await Promise.race([workPromise, guardPromise]);
  } finally {
    if (timerId !== null) clearTimeout(timerId);
    if (signal && onAbort) {
      signal.removeEventListener('abort', onAbort);
    }
  }
}

/**
 * Resolves the canonical MIME type for an input File.
 * - Treats generic MIME types (`application/octet-stream`, etc.) as non-definitive.
 * - Resolves actual format using filename extension and validated binary signature.
 * - Never trusts extension (or declared MIME) alone when the binary signature conflicts or is missing.
 */
export function resolveInputFormat(file, inputBytes) {
  const ext = extractExtension(file?.name);
  const rawDeclaredMime = normalizeMimeType(file?.type);
  const declaredMime =
    rawDeclaredMime && !GENERIC_MIME_TYPES.has(rawDeclaredMime) ? rawDeclaredMime : '';
  const extMime = ext ? EXTENSION_TO_MIME[ext] || '' : '';

  // Check OLE2-wrapped encrypted OpenXML (.docx / .pptx / .xlsx) before generic ZIP matching
  if (
    isEncryptedOle2OpenXml(inputBytes) &&
    ((declaredMime && SUPPORTED_OPENXML_MIME_TYPES.has(declaredMime)) ||
      (extMime && SUPPORTED_OPENXML_MIME_TYPES.has(extMime)) ||
      (!declaredMime && !ext))
  ) {
    return {
      ok: true,
      mimeType: declaredMime || extMime || OPENXML_DOCX_MIME,
      sigMime: null,
      extension: ext,
      encryptedOle2: true
    };
  }

  const sigMime = detectFormatFromSignature(inputBytes);

  const targetMime = declaredMime || extMime || sigMime || '';
  if (!targetMime) {
    return { ok: false, mimeType: '', sigMime };
  }

  // Verify extension matches targetMime if extension is present
  if (ext) {
    if (MIME_TO_EXTENSIONS[targetMime]) {
      if (!MIME_TO_EXTENSIONS[targetMime].includes(ext)) {
        return { ok: false, mimeType: targetMime, sigMime, mismatch: true };
      }
    } else if (extMime && extMime !== targetMime) {
      return { ok: false, mimeType: targetMime, sigMime, mismatch: true };
    }
  }

  // Verify binary signature matches targetMime (never trust extension or declared MIME alone)
  if (!sigMime || sigMime !== targetMime) {
    return { ok: false, mimeType: targetMime, sigMime, mismatch: true };
  }

  return { ok: true, mimeType: targetMime, sigMime, extension: ext };
}

/**
 * Losslessly optimizes PNG bytes using `@jsquash/oxipng` in browser environments
 * (or an injected test optimizer), preserving transparency, dimensions, and color accuracy.
 */
async function runOxipngOptimization(inputBytes, { signal, deadlineAt, timeoutMs }) {
  if (customPngOptimizerForTesting) {
    const out = await runWithCancellation(
      () => customPngOptimizerForTesting(inputBytes, { level: 2, interlace: false, optimiseAlpha: false }),
      { signal, deadlineAt, timeoutMs }
    );
    return out instanceof Uint8Array ? out : new Uint8Array(out);
  }

  const oxipngModule = await runWithCancellation(() => import('@jsquash/oxipng'), {
    signal,
    deadlineAt,
    timeoutMs
  });
  const optimise = oxipngModule?.optimise || oxipngModule?.default;
  if (typeof optimise !== 'function') {
    throw new Error('@jsquash/oxipng optimise function is unavailable');
  }

  const exactBuffer = inputBytes.buffer.slice(
    inputBytes.byteOffset,
    inputBytes.byteOffset + inputBytes.byteLength
  );
  const optimizedBuffer = await runWithCancellation(
    () =>
      optimise(exactBuffer, {
        level: 2,
        interlace: false,
        optimiseAlpha: false
      }),
    { signal, deadlineAt, timeoutMs }
  );

  if (!(optimizedBuffer instanceof ArrayBuffer) && !(optimizedBuffer instanceof Uint8Array)) {
    throw new Error('@jsquash/oxipng returned an unexpected buffer type');
  }
  return optimizedBuffer instanceof Uint8Array
    ? optimizedBuffer
    : new Uint8Array(optimizedBuffer);
}

/**
 * Verifies in browser DOM/Worker runtimes (when ImageBitmap/Image is available)
 * that an optimized PNG decodes cleanly at exact original dimensions and preserves
 * actual transparency when present.
 */
async function verifyPngDecodeAndAlpha(inputBytes, outBytes, inputHeader, outHeader, { signal, deadlineAt, timeoutMs }) {
  const canDecodeBitmap = typeof createImageBitmap === 'function';
  const canUseImage =
    typeof Image !== 'undefined' &&
    typeof URL !== 'undefined' &&
    typeof URL.createObjectURL === 'function';

  if (!canDecodeBitmap && !canUseImage) {
    // Non-DOM environments rely on strict binary PNG header + IEND + animated validation
    return true;
  }

  const decodeDimensionsAndAlpha = async (bytes, checkAlphaPixels) => {
    const blob = new Blob([bytes], { type: 'image/png' });
    let bitmap = null;
    let objectUrl = null;
    try {
      let source;
      let width;
      let height;
      if (canDecodeBitmap) {
        bitmap = await createImageBitmap(blob);
        source = bitmap;
        width = bitmap.width;
        height = bitmap.height;
      } else {
        objectUrl = URL.createObjectURL(blob);
        const img = await new Promise((resolve, reject) => {
          const el = new Image();
          el.onload = () => resolve(el);
          el.onerror = () => reject(new Error('PNG decode failed'));
          el.src = objectUrl;
        });
        source = img;
        width = img.naturalWidth || img.width;
        height = img.naturalHeight || img.height;
      }

      let hasTransparentPixels = false;
      if (checkAlphaPixels) {
        const hasCanvas =
          typeof OffscreenCanvas !== 'undefined' ||
          (typeof document !== 'undefined' && typeof document.createElement === 'function');
        if (hasCanvas) {
          const canvas =
            typeof OffscreenCanvas !== 'undefined'
              ? new OffscreenCanvas(width, height)
              : document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: true });
          if (ctx) {
            ctx.clearRect(0, 0, width, height);
            ctx.drawImage(source, 0, 0, width, height);
            try {
              const imgData = ctx.getImageData(0, 0, width, height);
              hasTransparentPixels = analyzeImagePixels(imgData.data, width, height).hasTransparentPixels;
            } catch (_) {
              hasTransparentPixels = false;
            }
          }
        }
      }

      return { width, height, hasTransparentPixels };
    } finally {
      try {
        bitmap?.close?.();
      } catch (_) {}
      if (objectUrl) {
        try {
          URL.revokeObjectURL(objectUrl);
        } catch (_) {}
      }
    }
  };

  const outDecoded = await runWithCancellation(
    () => decodeDimensionsAndAlpha(outBytes, Boolean(inputHeader.hasAlphaMetadata)),
    { signal, deadlineAt, timeoutMs }
  );

  if (outDecoded.width !== inputHeader.width || outDecoded.height !== inputHeader.height) {
    return false;
  }

  // If original PNG has alpha metadata and actual transparent pixels, output must preserve alpha
  if (inputHeader.hasAlphaMetadata && !outHeader.hasAlphaMetadata) {
    const origDecoded = await runWithCancellation(
      () => decodeDimensionsAndAlpha(inputBytes, true),
      { signal, deadlineAt, timeoutMs }
    );
    if (origDecoded.hasTransparentPixels && !outDecoded.hasTransparentPixels) {
      return false;
    }
  }

  return true;
}

/**
 * Losslessly optimizes static or animated GIF bytes using `@fe-daily/gifsicle-wasm-browser`
 * inside a dedicated Web Worker (with immediate AbortSignal & timeout termination),
 * or an injected test optimizer in Node tests.
 */
async function runGifsicleOptimization(inputBytes, { signal, deadlineAt, timeoutMs }) {
  const command = ['-O2 --no-warnings input.gif -o /out/output.gif'];

  if (customGifOptimizerForTesting) {
    const out = await runWithCancellation(
      () => customGifOptimizerForTesting(inputBytes, { command }),
      { signal, deadlineAt, timeoutMs }
    );
    return out instanceof Uint8Array ? out : new Uint8Array(out);
  }

  if (typeof Worker === 'undefined') {
    const envErr = new Error('Web Worker runtime unavailable for WASM GIF optimization');
    envErr.code = 'UNSUPPORTED_ENVIRONMENT';
    throw envErr;
  }

  if (signal?.aborted) {
    throw createAbortError();
  }

  let workerUrl = '';
  try {
    const workerUrlMod = await runWithCancellation(
      () => import('@fe-daily/gifsicle-wasm-browser/worker?url'),
      { signal, deadlineAt, timeoutMs }
    );
    workerUrl = workerUrlMod?.default || '';
  } catch (err) {
    if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
      throw err;
    }
  }

  // Copy slice so transferring buffer to Worker never mutates or detaches caller's bytes
  const transferBuffer = inputBytes.buffer.slice(
    inputBytes.byteOffset,
    inputBytes.byteOffset + inputBytes.byteLength
  );

  if (!workerUrl) {
    const gifsicleMod = await runWithCancellation(() => import('@fe-daily/gifsicle-wasm-browser'), {
      signal,
      deadlineAt,
      timeoutMs
    });
    const run = gifsicleMod?.run || gifsicleMod?.default?.run;
    if (typeof run !== 'function') {
      throw new Error('@fe-daily/gifsicle-wasm-browser run function is unavailable');
    }
    const remainingMs = Math.max(1, deadlineAt - Date.now());
    const files = await runWithCancellation(
      () =>
        run({
          input: [{ name: 'input.gif', file: transferBuffer }],
          command,
          isStrict: false,
          timeoutMs: remainingMs
        }),
      { signal, deadlineAt, timeoutMs }
    );
    const outFile = Array.isArray(files) ? files[0] : null;
    if (!outFile || typeof outFile.arrayBuffer !== 'function') {
      throw new Error('gifsicle returned no output file');
    }
    const outBuf = await runWithCancellation(() => outFile.arrayBuffer(), {
      signal,
      deadlineAt,
      timeoutMs
    });
    return new Uint8Array(outBuf);
  }

  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) {
    throw createTimeoutError(timeoutMs);
  }

  return await new Promise((resolve, reject) => {
    let settled = false;
    let timerId = null;
    let onAbort = null;
    let worker = null;

    const cleanup = () => {
      if (timerId !== null) {
        clearTimeout(timerId);
        timerId = null;
      }
      if (signal && onAbort) {
        signal.removeEventListener('abort', onAbort);
        onAbort = null;
      }
      if (worker) {
        try {
          worker.terminate();
        } catch (_) {}
        worker = null;
      }
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    try {
      worker = new Worker(workerUrl);
    } catch (err) {
      fail(err);
      return;
    }

    timerId = setTimeout(() => {
      fail(createTimeoutError(timeoutMs));
    }, remainingMs);

    if (signal) {
      onAbort = () => fail(createAbortError());
      signal.addEventListener('abort', onAbort, { once: true });
    }

    worker.onmessage = (event) => {
      if (settled) return;
      const payload = event?.data;
      if (!payload?.success || !Array.isArray(payload.files) || payload.files.length === 0) {
        fail(new Error(payload?.error || 'gifsicle worker produced no output'));
        return;
      }
      const outEntry =
        payload.files.find((f) => typeof f?.name === 'string' && f.name.toLowerCase().endsWith('.gif')) ||
        payload.files[0];
      const view = outEntry?.file;
      if (!(view instanceof Uint8Array) || view.byteLength === 0) {
        fail(new Error('gifsicle worker returned invalid GIF bytes'));
        return;
      }
      settled = true;
      cleanup();
      resolve(new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength)));
    };

    worker.onerror = (event) => {
      fail(event?.error || new Error(event?.message || 'gifsicle worker error'));
    };

    try {
      worker.postMessage(
        {
          data: [{ name: 'input.gif', file: transferBuffer }],
          command,
          folder: [],
          isStrict: false
        },
        [transferBuffer]
      );
    } catch (err) {
      fail(err);
    }
  });
}

/**
 * Verifies decoded GIF dimensions, transparency parity, and multi-frame WebCodecs integrity
 * in browser environments without failing when ImageDecoder is absent (e.g., iOS 15 Safari).
 */
async function verifyGifDecode(inputBytes, outBytes, inputMeta, outMeta, { signal, deadlineAt, timeoutMs }) {
  const canDecodeBitmap = typeof createImageBitmap === 'function';
  const canUseImage =
    typeof Image !== 'undefined' &&
    typeof URL !== 'undefined' &&
    typeof URL.createObjectURL === 'function';

  if (canDecodeBitmap || canUseImage) {
    const decodeFirstFrame = async (bytes, checkAlphaPixels) => {
      const blob = new Blob([bytes], { type: 'image/gif' });
      let bitmap = null;
      let objectUrl = null;
      try {
        let source;
        let width;
        let height;
        if (canDecodeBitmap) {
          bitmap = await createImageBitmap(blob);
          source = bitmap;
          width = bitmap.width;
          height = bitmap.height;
        } else {
          objectUrl = URL.createObjectURL(blob);
          const img = await new Promise((resolve, reject) => {
            const el = new Image();
            el.onload = () => resolve(el);
            el.onerror = () => reject(new Error('GIF decode failed'));
            el.src = objectUrl;
          });
          source = img;
          width = img.naturalWidth || img.width;
          height = img.naturalHeight || img.height;
        }

        let hasTransparentPixels = false;
        if (checkAlphaPixels) {
          const hasCanvas =
            typeof OffscreenCanvas !== 'undefined' ||
            (typeof document !== 'undefined' && typeof document.createElement === 'function');
          if (hasCanvas) {
            const canvas =
              typeof OffscreenCanvas !== 'undefined'
                ? new OffscreenCanvas(width, height)
                : document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: true });
            if (ctx) {
              ctx.clearRect(0, 0, width, height);
              ctx.drawImage(source, 0, 0, width, height);
              try {
                const imgData = ctx.getImageData(0, 0, width, height);
                hasTransparentPixels = analyzeImagePixels(imgData.data, width, height).hasTransparentPixels;
              } catch (_) {
                hasTransparentPixels = false;
              }
            }
          }
        }

        return { width, height, hasTransparentPixels };
      } finally {
        try {
          bitmap?.close?.();
        } catch (_) {}
        if (objectUrl) {
          try {
            URL.revokeObjectURL(objectUrl);
          } catch (_) {}
        }
      }
    };

    const outDecoded = await runWithCancellation(
      () => decodeFirstFrame(outBytes, Boolean(inputMeta.hasAlphaMetadata)),
      { signal, deadlineAt, timeoutMs }
    );
    if (outDecoded.width !== inputMeta.width || outDecoded.height !== inputMeta.height) {
      return false;
    }
    if (inputMeta.hasAlphaMetadata && !outMeta.hasAlphaMetadata) {
      const origDecoded = await runWithCancellation(() => decodeFirstFrame(inputBytes, true), {
        signal,
        deadlineAt,
        timeoutMs
      });
      if (origDecoded.hasTransparentPixels && !outDecoded.hasTransparentPixels) {
        return false;
      }
    }
  }

  // If browser exposes WebCodecs ImageDecoder, verify full track metadata and frame decodability
  if (typeof ImageDecoder === 'function' && typeof ImageDecoder.isTypeSupported === 'function') {
    let supported = false;
    try {
      supported = await runWithCancellation(() => ImageDecoder.isTypeSupported('image/gif'), {
        signal,
        deadlineAt,
        timeoutMs
      });
    } catch (err) {
      if (err?.name === 'AbortError' || err?.name === 'TimeoutError') throw err;
      supported = false;
    }

    if (supported) {
      let outDecoder = null;
      try {
        outDecoder = new ImageDecoder({ data: outBytes, type: 'image/gif' });
        await runWithCancellation(() => outDecoder.tracks.ready, { signal, deadlineAt, timeoutMs });
        const track = outDecoder.tracks.selectedTrack;
        if (track && track.frameCount !== inputMeta.frameCount) {
          return false;
        }
        if (
          inputMeta.hasLoopExtension &&
          typeof track?.repetitionCount === 'number' &&
          Number.isFinite(track.repetitionCount)
        ) {
          const expectedReps = inputMeta.loopCount === 0 ? Infinity : inputMeta.loopCount;
          if (track.repetitionCount !== expectedReps && inputMeta.loopCount !== 0) {
            return false;
          }
        }
        // Decode first and last frame to verify image bitstream integrity
        const indicesToVerify = inputMeta.frameCount > 1 ? [0, inputMeta.frameCount - 1] : [0];
        for (const frameIndex of indicesToVerify) {
          const decoded = await runWithCancellation(() => outDecoder.decode({ frameIndex }), {
            signal,
            deadlineAt,
            timeoutMs
          });
          const frameW = decoded?.image?.displayWidth || decoded?.image?.codedWidth || 0;
          const frameH = decoded?.image?.displayHeight || decoded?.image?.codedHeight || 0;
          try {
            decoded?.image?.close?.();
          } catch (_) {}
          if (frameW !== inputMeta.width || frameH !== inputMeta.height) {
            return false;
          }
        }
      } catch (err) {
        if (err?.name === 'AbortError' || err?.name === 'TimeoutError') throw err;
        return false;
      } finally {
        try {
          outDecoder?.close?.();
        } catch (_) {}
      }
    }
  }

  return true;
}

/**
 * Validates that a candidate optimized GIF strictly preserves dimensions, frame count/order,
 * frame delays, animation loop count, transparency, valid disposal methods, and decodability.
 */
async function validateOptimizedGif(inputBytes, outBytes, inputMeta, ctx) {
  if (!(outBytes instanceof Uint8Array) || outBytes.byteLength === 0) {
    return { valid: false };
  }
  if (detectFormatFromSignature(outBytes) !== 'image/gif') {
    return { valid: false };
  }

  const outMeta = parseGifMetadata(outBytes);
  if (!outMeta.valid) {
    return { valid: false };
  }

  if (outMeta.width !== inputMeta.width || outMeta.height !== inputMeta.height) {
    return { valid: false };
  }

  if (outMeta.frameCount !== inputMeta.frameCount || outMeta.frameCount <= 0) {
    return { valid: false };
  }

  // Loop count parity (handles null vs 0 infinite vs finite N)
  if (inputMeta.hasLoopExtension !== outMeta.hasLoopExtension || inputMeta.loopCount !== outMeta.loopCount) {
    return { valid: false };
  }

  // Strict per-frame timing & valid disposal check in exact frame order
  for (let i = 0; i < inputMeta.frameCount; i++) {
    const inFrame = inputMeta.frames[i];
    const outFrame = outMeta.frames[i];
    if (!inFrame || !outFrame) {
      return { valid: false };
    }
    if (outFrame.delayCs !== inFrame.delayCs) {
      return { valid: false };
    }
    if (outFrame.disposalMethod < 0 || outFrame.disposalMethod > 3) {
      return { valid: false };
    }
  }

  // Static GIF transparency parity (when no browser pixel verifier runs, metadata must match;
  // in browser runtimes verifyGifDecode also checks actual transparent pixels)
  const hasDomDecode =
    typeof createImageBitmap === 'function' ||
    (typeof Image !== 'undefined' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function');
  if (inputMeta.hasAlphaMetadata && !outMeta.hasAlphaMetadata && !hasDomDecode) {
    return { valid: false };
  }

  const decodeOk = await verifyGifDecode(inputBytes, outBytes, inputMeta, outMeta, ctx);
  if (!decodeOk) {
    return { valid: false };
  }

  return { valid: true, outMeta };
}

/**
 * Losslessly optimizes static and animated GIF files via WASM gifsicle (`-O2`),
 * preserving frame count, frame order, frame delays, loop count, transparency,
 * dimensions, and visual content, and returning the untouched original File on any
 * error, timeout, cancellation, validation failure, or < 10% byte savings.
 */
async function optimizeGifFile(file, inputBytes, _options, ctx) {
  const { signal, deadlineAt, timeoutMs, onStage, minSavingsRatio } = ctx;

  const inputMeta = parseGifMetadata(inputBytes);
  if (!inputMeta.valid) {
    emitStage(onStage, COMPRESSION_STAGES.SKIPPED, {
      fileName: file.name,
      reason: COMPRESSION_REASONS.CORRUPTED_OR_UNREADABLE
    });
    return buildResult(
      file,
      false,
      file.size,
      file.size,
      COMPRESSION_REASONS.CORRUPTED_OR_UNREADABLE
    );
  }

  emitStage(onStage, COMPRESSION_STAGES.OPTIMIZING, {
    fileName: file.name,
    mimeType: 'image/gif',
    originalSize: file.size,
    optimizer: 'gifsicle',
    frameCount: inputMeta.frameCount
  });

  let outBytes;
  try {
    outBytes = await runGifsicleOptimization(inputBytes, { signal, deadlineAt, timeoutMs });
  } catch (err) {
    if (err?.name === 'AbortError' || err?.name === 'TimeoutError' || signal?.aborted) {
      throw err;
    }
    const reason =
      err?.code === 'UNSUPPORTED_ENVIRONMENT'
        ? COMPRESSION_REASONS.UNSUPPORTED_ENVIRONMENT
        : COMPRESSION_REASONS.ERROR;
    emitStage(onStage, COMPRESSION_STAGES.SKIPPED, {
      fileName: file.name,
      reason
    });
    return buildResult(file, false, file.size, file.size, reason);
  }

  emitStage(onStage, COMPRESSION_STAGES.VALIDATING, {
    fileName: file.name,
    mimeType: 'image/gif',
    originalSize: file.size,
    candidateSize: outBytes?.byteLength || 0
  });

  const validation = await validateOptimizedGif(inputBytes, outBytes, inputMeta, {
    signal,
    deadlineAt,
    timeoutMs
  });
  if (!validation.valid) {
    emitStage(onStage, COMPRESSION_STAGES.SKIPPED, {
      fileName: file.name,
      reason: COMPRESSION_REASONS.VALIDATION_FAILED
    });
    return buildResult(file, false, file.size, file.size, COMPRESSION_REASONS.VALIDATION_FAILED);
  }

  const encodedSize = outBytes.byteLength;
  const savingsRatio = encodedSize > 0 ? (file.size - encodedSize) / file.size : 0;
  if (!encodedSize || encodedSize >= file.size || savingsRatio < minSavingsRatio) {
    emitStage(onStage, COMPRESSION_STAGES.SKIPPED, {
      fileName: file.name,
      reason: COMPRESSION_REASONS.INSUFFICIENT_SAVINGS
    });
    return buildResult(file, false, file.size, file.size, COMPRESSION_REASONS.INSUFFICIENT_SAVINGS);
  }

  const compressedFile = new File([outBytes], file.name, {
    type: 'image/gif',
    lastModified: file.lastModified
  });

  emitStage(onStage, COMPRESSION_STAGES.COMPLETE, {
    fileName: compressedFile.name,
    mimeType: 'image/gif',
    originalSize: file.size,
    finalSize: compressedFile.size
  });

  return buildResult(
    compressedFile,
    true,
    file.size,
    compressedFile.size,
    COMPRESSION_REASONS.COMPRESSED
  );
}

/**
 * Optimizes an image File while preserving quality, transparency, MIME type, and extension.
 * - For PNGs (in real browser/runtime without a mock adapter): uses `@jsquash/oxipng` lossless
 *   optimization first, keeping Canvas only as a safe fallback if oxipng fails or produces invalid output.
 * - For JPEG/WebP (and Canvas fallback): uses browser-native Canvas decode/encode.
 */
async function optimizeImageFile(file, inputBytes, mimeType, options, ctx) {
  const { signal, deadlineAt, timeoutMs, onStage, minSavingsRatio } = ctx;

  // 1. Check animated image first (APNG, animated WebP)
  if (detectAnimatedImage(inputBytes, mimeType)) {
    emitStage(onStage, COMPRESSION_STAGES.SKIPPED, {
      fileName: file.name,
      reason: COMPRESSION_REASONS.ANIMATED_IMAGE
    });
    return buildResult(file, false, file.size, file.size, COMPRESSION_REASONS.ANIMATED_IMAGE);
  }

  // 2. Validate input binary header & dimensions
  const inputHeader = parseImageHeaderInfo(inputBytes, mimeType);
  if (!inputHeader.valid) {
    emitStage(onStage, COMPRESSION_STAGES.SKIPPED, {
      fileName: file.name,
      reason: COMPRESSION_REASONS.CORRUPTED_OR_UNREADABLE
    });
    return buildResult(
      file,
      false,
      file.size,
      file.size,
      COMPRESSION_REASONS.CORRUPTED_OR_UNREADABLE
    );
  }

  // 3. Primary PNG lossless optimization via @jsquash/oxipng (unless test adapter overrides)
  let oxipngAttempted = false;
  let oxipngInvalidOutput = false;
  if (mimeType === 'image/png' && !customImageAdapterForTesting) {
    oxipngAttempted = true;
    emitStage(onStage, COMPRESSION_STAGES.OPTIMIZING, {
      fileName: file.name,
      mimeType,
      originalSize: file.size,
      optimizer: 'oxipng'
    });

    try {
      const outBytes = await runOxipngOptimization(inputBytes, { signal, deadlineAt, timeoutMs });

      emitStage(onStage, COMPRESSION_STAGES.VALIDATING, {
        fileName: file.name,
        mimeType,
        originalSize: file.size,
        candidateSize: outBytes?.byteLength || 0
      });

      const outHeader =
        outBytes instanceof Uint8Array ? parseImageHeaderInfo(outBytes, 'image/png') : { valid: false };
      const isValidStructure =
        outBytes instanceof Uint8Array &&
        outBytes.byteLength > 0 &&
        detectFormatFromSignature(outBytes) === 'image/png' &&
        !detectAnimatedImage(outBytes, 'image/png') &&
        outHeader.valid &&
        outHeader.width === inputHeader.width &&
        outHeader.height === inputHeader.height;

      const isDecodeValid = isValidStructure
        ? await verifyPngDecodeAndAlpha(inputBytes, outBytes, inputHeader, outHeader, {
            signal,
            deadlineAt,
            timeoutMs
          })
        : false;

      if (!isValidStructure || !isDecodeValid) {
        oxipngInvalidOutput = true;
      } else {
        const encodedSize = outBytes.byteLength;
        const savingsRatio = encodedSize > 0 ? (file.size - encodedSize) / file.size : 0;
        if (!encodedSize || encodedSize >= file.size || savingsRatio < minSavingsRatio) {
          // Valid lossless oxipng optimization did not reach >= 10% savings.
          // Do not force lossy/premultiplied-alpha Canvas re-encoding over valid lossless PNG.
          emitStage(onStage, COMPRESSION_STAGES.SKIPPED, {
            fileName: file.name,
            reason: COMPRESSION_REASONS.INSUFFICIENT_SAVINGS
          });
          return buildResult(
            file,
            false,
            file.size,
            file.size,
            COMPRESSION_REASONS.INSUFFICIENT_SAVINGS
          );
        }

        const compressedFile = new File([outBytes], file.name, {
          type: 'image/png',
          lastModified: file.lastModified
        });

        emitStage(onStage, COMPRESSION_STAGES.COMPLETE, {
          fileName: compressedFile.name,
          mimeType: 'image/png',
          originalSize: file.size,
          finalSize: compressedFile.size
        });

        return buildResult(
          compressedFile,
          true,
          file.size,
          compressedFile.size,
          COMPRESSION_REASONS.COMPRESSED
        );
      }
    } catch (oxipngErr) {
      if (oxipngErr?.name === 'AbortError' || oxipngErr?.name === 'TimeoutError' || signal?.aborted) {
        throw oxipngErr;
      }
      // Fall through to safe Canvas fallback when oxipng fails or is unavailable
    }
  }

  // 4. Acquire browser-native Canvas image adapter (primary for JPEG/WebP, safe fallback for PNG)
  const adapter = getBrowserImageAdapter();
  if (!adapter) {
    const fallbackReason = oxipngInvalidOutput
      ? COMPRESSION_REASONS.VALIDATION_FAILED
      : COMPRESSION_REASONS.UNSUPPORTED_ENVIRONMENT;
    emitStage(onStage, COMPRESSION_STAGES.SKIPPED, {
      fileName: file.name,
      reason: fallbackReason
    });
    return buildResult(file, false, file.size, file.size, fallbackReason);
  }

  if (!oxipngAttempted) {
    emitStage(onStage, COMPRESSION_STAGES.OPTIMIZING, {
      fileName: file.name,
      mimeType,
      originalSize: file.size
    });
  }

  let decoded = null;
  try {
    const sourceBlob =
      file.type === mimeType
        ? file
        : new Blob([inputBytes], { type: mimeType });
    decoded = await runWithCancellation(() => adapter.decodeAndAnalyze(sourceBlob), {
      signal,
      deadlineAt,
      timeoutMs
    });

    if (!decoded || !decoded.width || !decoded.height) {
      return buildResult(
        file,
        false,
        file.size,
        file.size,
        COMPRESSION_REASONS.CORRUPTED_OR_UNREADABLE
      );
    }

    const { targetWidth, targetHeight } = computeSafeTargetDimensions(
      decoded.width,
      decoded.height,
      {
        isTextOrDiagramLikely: Boolean(decoded.isTextOrDiagramLikely),
        mimeType
      }
    );

    const quality =
      mimeType === 'image/jpeg'
        ? decoded.isTextOrDiagramLikely
          ? SMART_COMPRESSION_DEFAULTS.JPEG_TEXT_QUALITY
          : SMART_COMPRESSION_DEFAULTS.JPEG_PHOTO_QUALITY
        : mimeType === 'image/webp'
        ? decoded.isTextOrDiagramLikely
          ? SMART_COMPRESSION_DEFAULTS.WEBP_TEXT_QUALITY
          : SMART_COMPRESSION_DEFAULTS.WEBP_PHOTO_QUALITY
        : undefined;

    const encodedBlob = await runWithCancellation(
      () =>
        adapter.encode(decoded, {
          targetWidth,
          targetHeight,
          mimeType,
          quality,
          preserveTransparency: Boolean(
            decoded.hasTransparentPixels || inputHeader.hasAlphaMetadata
          )
        }),
      { signal, deadlineAt, timeoutMs }
    );

    if (!encodedBlob || typeof encodedBlob.arrayBuffer !== 'function') {
      return buildResult(file, false, file.size, file.size, COMPRESSION_REASONS.VALIDATION_FAILED);
    }

    // 5. Validate output MIME, signature, dimensions, and >= 10% savings
    emitStage(onStage, COMPRESSION_STAGES.VALIDATING, {
      fileName: file.name,
      mimeType,
      originalSize: file.size,
      candidateSize: encodedBlob.size
    });

    const outMime = normalizeMimeType(encodedBlob.type);
    if (outMime && outMime !== mimeType) {
      return buildResult(file, false, file.size, file.size, COMPRESSION_REASONS.VALIDATION_FAILED);
    }

    const encodedSize = encodedBlob.size;
    if (!encodedSize || encodedSize >= file.size) {
      emitStage(onStage, COMPRESSION_STAGES.SKIPPED, {
        fileName: file.name,
        reason: COMPRESSION_REASONS.INSUFFICIENT_SAVINGS
      });
      return buildResult(file, false, file.size, file.size, COMPRESSION_REASONS.INSUFFICIENT_SAVINGS);
    }

    const savingsRatio = (file.size - encodedSize) / file.size;
    if (savingsRatio < minSavingsRatio) {
      emitStage(onStage, COMPRESSION_STAGES.SKIPPED, {
        fileName: file.name,
        reason: COMPRESSION_REASONS.INSUFFICIENT_SAVINGS
      });
      return buildResult(file, false, file.size, file.size, COMPRESSION_REASONS.INSUFFICIENT_SAVINGS);
    }

    const outBytes = new Uint8Array(
      await runWithCancellation(() => encodedBlob.arrayBuffer(), {
        signal,
        deadlineAt,
        timeoutMs
      })
    );

    const outHeader = parseImageHeaderInfo(outBytes, mimeType);
    if (
      !outHeader.valid ||
      outHeader.width !== targetWidth ||
      outHeader.height !== targetHeight
    ) {
      return buildResult(file, false, file.size, file.size, COMPRESSION_REASONS.VALIDATION_FAILED);
    }

    const compressedFile = new File([outBytes], file.name, {
      type: mimeType,
      lastModified: file.lastModified
    });

    emitStage(onStage, COMPRESSION_STAGES.COMPLETE, {
      fileName: compressedFile.name,
      mimeType,
      originalSize: file.size,
      finalSize: compressedFile.size
    });

    return buildResult(
      compressedFile,
      true,
      file.size,
      compressedFile.size,
      COMPRESSION_REASONS.COMPRESSED
    );
  } finally {
    try {
      decoded?.release?.();
    } catch (_) {}
  }
}

/**
 * Losslessly optimizes a PDF File via `pdf-lib` structural object-stream compaction.
 * Never rasterizes pages or modifies text, fonts, layout, or selectable content.
 * Protects encrypted and digitally signed PDFs (/Sig, /ByteRange) by skipping untouched.
 */
async function optimizePdfFile(file, inputBytes, options, ctx) {
  const { signal, deadlineAt, timeoutMs, onStage, minSavingsRatio } = ctx;

  // Quick pre-check for PDF encryption or digital signature markers before parsing
  if (hasRawPdfProtectionMarkers(inputBytes)) {
    emitStage(onStage, COMPRESSION_STAGES.SKIPPED, {
      fileName: file.name,
      reason: COMPRESSION_REASONS.PROTECTED_PDF
    });
    return buildResult(file, false, file.size, file.size, COMPRESSION_REASONS.PROTECTED_PDF);
  }

  emitStage(onStage, COMPRESSION_STAGES.OPTIMIZING, {
    fileName: file.name,
    mimeType: SUPPORTED_PDF_MIME_TYPE,
    originalSize: file.size
  });

  const pdfLibModule = await runWithCancellation(() => import('pdf-lib'), {
    signal,
    deadlineAt,
    timeoutMs
  });
  const { PDFDocument } = pdfLibModule;

  let pdfDoc;
  try {
    pdfDoc = await runWithCancellation(
      () => PDFDocument.load(inputBytes, { updateMetadata: false, ignoreEncryption: false }),
      { signal, deadlineAt, timeoutMs }
    );
  } catch (err) {
    if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
      throw err;
    }
    const reason = isPdfEncryptionError(err)
      ? COMPRESSION_REASONS.PROTECTED_PDF
      : COMPRESSION_REASONS.CORRUPTED_OR_UNREADABLE;
    emitStage(onStage, COMPRESSION_STAGES.SKIPPED, { fileName: file.name, reason });
    return buildResult(file, false, file.size, file.size, reason);
  }

  if (pdfDoc.isEncrypted || hasParsedPdfProtectionMarkers(pdfDoc, pdfLibModule)) {
    emitStage(onStage, COMPRESSION_STAGES.SKIPPED, {
      fileName: file.name,
      reason: COMPRESSION_REASONS.PROTECTED_PDF
    });
    return buildResult(file, false, file.size, file.size, COMPRESSION_REASONS.PROTECTED_PDF);
  }

  const originalPageCount = pdfDoc.getPageCount();
  if (!originalPageCount || originalPageCount <= 0) {
    return buildResult(
      file,
      false,
      file.size,
      file.size,
      COMPRESSION_REASONS.CORRUPTED_OR_UNREADABLE
    );
  }

  const originalPageSizes = pdfDoc.getPages().map((page) => page.getSize());

  const optimizedBytes = await runWithCancellation(
    () =>
      pdfDoc.save({
        useObjectStreams: true,
        addDefaultPage: false,
        objectsPerTick: 50
      }),
    { signal, deadlineAt, timeoutMs }
  );

  // Check >= 10% storage savings before further validation
  if (!(optimizedBytes instanceof Uint8Array) || optimizedBytes.byteLength >= file.size) {
    emitStage(onStage, COMPRESSION_STAGES.SKIPPED, {
      fileName: file.name,
      reason: COMPRESSION_REASONS.INSUFFICIENT_SAVINGS
    });
    return buildResult(file, false, file.size, file.size, COMPRESSION_REASONS.INSUFFICIENT_SAVINGS);
  }

  const savingsRatio = (file.size - optimizedBytes.byteLength) / file.size;
  if (savingsRatio < minSavingsRatio) {
    emitStage(onStage, COMPRESSION_STAGES.SKIPPED, {
      fileName: file.name,
      reason: COMPRESSION_REASONS.INSUFFICIENT_SAVINGS
    });
    return buildResult(file, false, file.size, file.size, COMPRESSION_REASONS.INSUFFICIENT_SAVINGS);
  }

  // Validate output PDF signature, structure, page count, and page dimensions
  emitStage(onStage, COMPRESSION_STAGES.VALIDATING, {
    fileName: file.name,
    mimeType: SUPPORTED_PDF_MIME_TYPE,
    originalSize: file.size,
    candidateSize: optimizedBytes.byteLength
  });

  const validation = await runWithCancellation(
    () => validateOptimizedPdf(optimizedBytes, originalPageCount, originalPageSizes, PDFDocument),
    { signal, deadlineAt, timeoutMs }
  );

  if (!validation.valid) {
    return buildResult(file, false, file.size, file.size, COMPRESSION_REASONS.VALIDATION_FAILED);
  }

  const compressedFile = new File([optimizedBytes], file.name, {
    type: SUPPORTED_PDF_MIME_TYPE,
    lastModified: file.lastModified
  });

  emitStage(onStage, COMPRESSION_STAGES.COMPLETE, {
    fileName: compressedFile.name,
    mimeType: SUPPORTED_PDF_MIME_TYPE,
    originalSize: file.size,
    finalSize: compressedFile.size
  });

  return buildResult(
    compressedFile,
    true,
    file.size,
    compressedFile.size,
    COMPRESSION_REASONS.COMPRESSED
  );
}

const OPENXML_OPTIMIZABLE_MEDIA_REGEX = /^(word|ppt|xl)\/media\/.+\.(png|jpe?g|webp)$/i;
const OPENXML_PRESERVE_ASSET_EXTENSIONS = new Set([
  '.gif',
  '.svg',
  '.emf',
  '.wmf',
  '.emz',
  '.wmz'
]);

/**
 * Checks whether an already-loaded JSZip OpenXML package contains digital signatures,
 * encryption streams, IRM/DRM streams, or password/enforcement protection markers.
 */
async function detectOpenXmlProtection(zip, mimeType, rawZipInfo, { signal, deadlineAt, timeoutMs }) {
  if (rawZipInfo?.hasEncryptedEntry || rawZipInfo?.hasProtectionEntry) {
    return true;
  }

  const entries = Object.values(zip.files || {}).filter((e) => e && !e.dir);
  for (const entry of entries) {
    const lower = entry.name.toLowerCase();
    if (
      lower.startsWith('_xmlsignatures/') ||
      lower.endsWith('.sigs') ||
      lower.includes('vbaprojectsignature.bin') ||
      lower === 'encryptioninfo' ||
      lower === 'encryptedpackage' ||
      lower.includes('drmcontent') ||
      lower.includes('dataspaces') ||
      lower.includes('rightsmanagement')
    ) {
      return true;
    }
  }

  const readTextEntry = async (pathName) => {
    const foundKey = Object.keys(zip.files).find(
      (k) => !zip.files[k].dir && k.toLowerCase() === pathName.toLowerCase()
    );
    if (!foundKey) return '';
    return await runWithCancellation(() => zip.files[foundKey].async('string'), {
      signal,
      deadlineAt,
      timeoutMs
    });
  };

  const relsXml = await readTextEntry('_rels/.rels');
  if (
    relsXml &&
    (/relationships\/digital-signature\//i.test(relsXml) || /<\s*(?:ds:)?Signature\b/i.test(relsXml))
  ) {
    return true;
  }

  const contentTypesXml = await readTextEntry('[Content_Types].xml');
  if (
    contentTypesXml &&
    (/digital-signature-xmlsignature|digital-signature-origin|application\/vnd\.openxmlformats-package\.digital-signature/i.test(
      contentTypesXml
    ))
  ) {
    return true;
  }

  if (mimeType === OPENXML_DOCX_MIME) {
    const settingsXml = await readTextEntry('word/settings.xml');
    if (
      settingsXml &&
      /<w:documentProtection\b[^>]*(?:w:enforcement=["'](?:1|true)["']|w:hash=|w:cryptProviderType=|w:algorithmName=)/i.test(
        settingsXml
      )
    ) {
      return true;
    }
  } else if (mimeType === OPENXML_PPTX_MIME) {
    const presXml = await readTextEntry('ppt/presentation.xml');
    if (presXml && /<p:modifyVerifier\b/i.test(presXml)) {
      return true;
    }
  } else if (mimeType === OPENXML_XLSX_MIME) {
    const wbXml = await readTextEntry('xl/workbook.xml');
    if (
      wbXml &&
      (/<workbookProtection\b[^>]*(?:workbookPassword=|workbookAlgorithmName=|workbookHashValue=)/i.test(
        wbXml
      ) ||
        /<fileSharing\b[^>]*(?:reservationPassword=|algorithmName=|hashValue=)/i.test(wbXml))
    ) {
      return true;
    }
  }

  return false;
}

function bytesEqualExact(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Reopens the candidate OpenXML archive via JSZip and validates:
 * - ZIP container decodes cleanly
 * - Exact entry path set matches original archive (no dropped or injected parts)
 * - Required OpenXML core parts exist (`[Content_Types].xml`, `_rels/.rels`, document/presentation/workbook root)
 * - Every unmodified part (XML, rels, worksheets, formulas, slides, notes, macros, GIFs, SVGs, EMFs, WMFs)
 *   decompresses with 100% byte-for-byte parity
 * - Every optimized embedded raster image decompresses with valid binary signature
 */
async function validateOptimizedOpenXml(
  JSZip,
  outBytes,
  mimeType,
  originalEntriesMap,
  optimizedMediaSignatures,
  { signal, deadlineAt, timeoutMs }
) {
  if (!(outBytes instanceof Uint8Array) || outBytes.byteLength < 22) {
    return false;
  }
  if (outBytes[0] !== 0x50 || outBytes[1] !== 0x4b) {
    return false;
  }

  let verifyZip;
  try {
    verifyZip = await runWithCancellation(() => JSZip.loadAsync(outBytes), {
      signal,
      deadlineAt,
      timeoutMs
    });
  } catch (err) {
    if (err?.name === 'AbortError' || err?.name === 'TimeoutError') throw err;
    return false;
  }

  const verifyFileKeys = Object.keys(verifyZip.files).filter((k) => !verifyZip.files[k].dir);
  if (verifyFileKeys.length !== originalEntriesMap.size) {
    return false;
  }
  for (const origPath of originalEntriesMap.keys()) {
    const outEntry = verifyZip.files[origPath];
    if (!outEntry || outEntry.dir) {
      return false;
    }
  }

  const findCaseInsensitive = (targetPath) => {
    const lower = targetPath.toLowerCase();
    return verifyFileKeys.find((k) => k.toLowerCase() === lower) || '';
  };

  const contentTypesKey = findCaseInsensitive('[Content_Types].xml');
  const rootRelsKey = findCaseInsensitive('_rels/.rels');
  const coreMeta = OPENXML_CORE_PARTS[mimeType];
  const coreKey = coreMeta ? findCaseInsensitive(coreMeta.partPath) : '';

  if (!contentTypesKey || !rootRelsKey || !coreKey) {
    return false;
  }

  // Decompress every entry to verify CRC/stream integrity and exact untouched parity
  for (const entryPath of verifyFileKeys) {
    if (signal?.aborted) throw createAbortError();
    if (deadlineAt <= Date.now()) throw createTimeoutError(timeoutMs);

    let verifyBytes;
    try {
      verifyBytes = await runWithCancellation(() => verifyZip.files[entryPath].async('uint8array'), {
        signal,
        deadlineAt,
        timeoutMs
      });
    } catch (err) {
      if (err?.name === 'AbortError' || err?.name === 'TimeoutError') throw err;
      return false;
    }

    if (!(verifyBytes instanceof Uint8Array)) {
      return false;
    }

    const expectedOptMime = optimizedMediaSignatures.get(entryPath);
    if (expectedOptMime) {
      if (verifyBytes.byteLength === 0 || detectFormatFromSignature(verifyBytes) !== expectedOptMime) {
        return false;
      }
    } else {
      const origBytes = originalEntriesMap.get(entryPath);
      if (!bytesEqualExact(verifyBytes, origBytes)) {
        return false;
      }
    }
  }

  // Verify core XML markers parse cleanly
  const decoder = new TextDecoder('utf-8');
  const contentTypesText = decoder.decode(
    await verifyZip.files[contentTypesKey].async('uint8array')
  );
  const rootRelsText = decoder.decode(await verifyZip.files[rootRelsKey].async('uint8array'));
  const coreText = decoder.decode(await verifyZip.files[coreKey].async('uint8array'));

  if (
    !contentTypesText.includes('<Types') ||
    !rootRelsText.includes('<Relationships') ||
    !coreText.includes(coreMeta.rootMarker)
  ) {
    return false;
  }

  return true;
}

/**
 * Inspects a RIFF/WEBP container's top-level chunks without modifying bytes.
 * @param {Uint8Array} bytes
 */
export function parseWebpContainerInfo(bytes) {
  const empty = {
    valid: false,
    hasVp8x: false,
    hasVp8: false,
    hasVp8l: false,
    isLosslessBitstream: false,
    hasAlpha: false,
    hasAnim: false,
    hasIccp: false,
    hasExif: false,
    hasXmp: false,
    chunks: []
  };
  if (!(bytes instanceof Uint8Array) || bytes.length < 20) return empty;
  if (readAscii(bytes, 0, 4) !== 'RIFF' || readAscii(bytes, 8, 4) !== 'WEBP') return empty;
  const declaredSize = readUint32LE(bytes, 4);
  if (declaredSize + 8 > bytes.length) return empty;

  const chunks = [];
  let offset = 12;
  let hasVp8x = false;
  let hasVp8 = false;
  let hasVp8l = false;
  let hasAlpha = false;
  let hasAnim = false;
  let hasIccp = false;
  let hasExif = false;
  let hasXmp = false;

  while (offset + 8 <= bytes.length) {
    const id = readAscii(bytes, offset, 4);
    const size = readUint32LE(bytes, offset + 4);
    const paddedSize = size + (size % 2);
    const payloadOffset = offset + 8;
    if (payloadOffset + paddedSize > bytes.length) {
      return empty;
    }
    chunks.push({ id, offset, size, paddedSize, payloadOffset });

    if (id === 'VP8X' && size >= 10) {
      hasVp8x = true;
      const flags = bytes[payloadOffset];
      if ((flags & 0x10) !== 0) hasAlpha = true;
      if ((flags & 0x02) !== 0) hasAnim = true;
      if ((flags & 0x20) !== 0) hasIccp = true;
      if ((flags & 0x08) !== 0) hasExif = true;
      if ((flags & 0x04) !== 0) hasXmp = true;
    } else if (id === 'VP8 ') {
      hasVp8 = true;
    } else if (id === 'VP8L' && size >= 5 && bytes[payloadOffset] === 0x2f) {
      hasVp8l = true;
      const packed = readUint32LE(bytes, payloadOffset + 1);
      if (((packed >> 28) & 0x01) !== 0) hasAlpha = true;
    } else if (id === 'ALPH') {
      hasAlpha = true;
    } else if (id === 'ANIM' || id === 'ANMF') {
      hasAnim = true;
    } else if (id === 'ICCP') {
      hasIccp = true;
    } else if (id === 'EXIF') {
      hasExif = true;
    } else if (id === 'XMP ') {
      hasXmp = true;
    }

    offset = payloadOffset + paddedSize;
  }

  const valid = chunks.length > 0 && (hasVp8 || hasVp8l || hasAnim);
  return {
    valid,
    hasVp8x,
    hasVp8,
    hasVp8l,
    isLosslessBitstream: hasVp8l && !hasVp8,
    hasAlpha,
    hasAnim,
    hasIccp,
    hasExif,
    hasXmp,
    chunks
  };
}

/**
 * Losslessly strips redundant non-visual metadata chunks (EXIF, XMP ) from a WebP RIFF
 * container while keeping VP8/VP8L bitstreams, ALPH, ICCP, and dimensions bit-for-bit intact.
 * Returns null if nothing can be stripped or container is invalid.
 * @param {Uint8Array} bytes
 * @returns {Uint8Array|null}
 */
export function optimizeWebpMetadataLossless(bytes) {
  const info = parseWebpContainerInfo(bytes);
  if (!info.valid || (!info.hasExif && !info.hasXmp)) {
    return null;
  }

  const keptParts = [];
  let strippedAny = false;
  let bodyLen = 4; // 'WEBP'

  for (const chunk of info.chunks) {
    if (chunk.id === 'EXIF' || chunk.id === 'XMP ') {
      strippedAny = true;
      continue;
    }
    const rawChunk = bytes.subarray(chunk.offset, chunk.offset + 8 + chunk.paddedSize);
    if (chunk.id === 'VP8X' && chunk.size >= 10) {
      const cloned = new Uint8Array(rawChunk);
      // Clear only EXIF (0x08) and XMP (0x04) metadata bits; preserve ICCP (0x20), ALPH (0x10), ANIM (0x02)
      cloned[8] &= ~(0x08 | 0x04);
      keptParts.push(cloned);
      bodyLen += cloned.length;
    } else {
      keptParts.push(rawChunk);
      bodyLen += rawChunk.length;
    }
  }

  if (!strippedAny) return null;

  const out = new Uint8Array(8 + bodyLen);
  out[0] = 0x52; // R
  out[1] = 0x49; // I
  out[2] = 0x46; // F
  out[3] = 0x46; // F
  out[4] = bodyLen & 0xff;
  out[5] = (bodyLen >>> 8) & 0xff;
  out[6] = (bodyLen >>> 16) & 0xff;
  out[7] = (bodyLen >>> 24) & 0xff;
  out[8] = 0x57; // W
  out[9] = 0x45; // E
  out[10] = 0x42; // B
  out[11] = 0x50; // P

  let cursor = 12;
  for (const part of keptParts) {
    out.set(part, cursor);
    cursor += part.length;
  }

  if (out.byteLength >= bytes.byteLength) return null;
  const verified = parseImageHeaderInfo(out, 'image/webp');
  const origHeader = parseImageHeaderInfo(bytes, 'image/webp');
  if (!verified.valid || verified.width !== origHeader.width || verified.height !== origHeader.height) {
    return null;
  }
  return out;
}

/**
 * Inspects an EXIF APP1 payload (`Exif\0\0...`) and confirms whether stripping it
 * cannot alter pixel orientation (Orientation tag `0x0112` absent or `1`).
 */
function isExifPayloadSafeToStrip(payload) {
  if (!(payload instanceof Uint8Array) || payload.length < 16) return false;
  if (readAscii(payload, 0, 4) !== 'Exif' || payload[4] !== 0 || payload[5] !== 0) {
    return false;
  }
  const tiffStart = 6;
  const endian = readAscii(payload, tiffStart, 2);
  const le = endian === 'II' ? true : endian === 'MM' ? false : null;
  if (le === null) return false;

  const u16 = (off) => (le ? readUint16LE(payload, off) : readUint16BE(payload, off));
  const u32 = (off) => (le ? readUint32LE(payload, off) : readUint32BE(payload, off));

  if (u16(tiffStart + 2) !== 0x002a) return false;
  const ifd0Rel = u32(tiffStart + 4);
  const ifd0 = tiffStart + ifd0Rel;
  if (ifd0 + 2 > payload.length) return false;

  const entryCount = u16(ifd0);
  if (entryCount > 256 || ifd0 + 2 + entryCount * 12 > payload.length) return false;

  for (let i = 0; i < entryCount; i++) {
    const entryOffset = ifd0 + 2 + i * 12;
    const tag = u16(entryOffset);
    if (tag === 0x0112) {
      // Orientation tag: only safe to strip when Orientation === 1 (normal)
      const val = u16(entryOffset + 8);
      if (val !== 1) return false;
    }
  }
  return true;
}

/**
 * Losslessly removes redundant non-image JPEG metadata markers (COM, APP12, APP13, XMP APP1,
 * and Orientation=1 EXIF APP1) while keeping SOF, DQT, DHT, DRI, ICC_PROFILE (APP2),
 * Adobe color transform (APP14), and the entropy-coded SOS scan bitstream bit-for-bit intact.
 * Returns null if no metadata can be safely removed or the JPEG is malformed.
 * @param {Uint8Array} bytes
 * @returns {Uint8Array|null}
 */
export function optimizeJpegMetadataLossless(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 8) return null;
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

  const parts = [bytes.subarray(0, 2)];
  let pos = 2;
  let strippedAny = false;
  let reachedSos = false;

  while (pos + 1 < bytes.length) {
    if (bytes[pos] !== 0xff) {
      return null;
    }
    const markerStart = pos;
    while (pos < bytes.length && bytes[pos] === 0xff) pos++;
    if (pos >= bytes.length) return null;
    const marker = bytes[pos++];

    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      parts.push(bytes.subarray(markerStart, pos));
      continue;
    }

    if (marker === 0xd9) {
      // EOI before SOS is unusual; stop copying here
      parts.push(bytes.subarray(markerStart, pos));
      break;
    }

    if (marker === 0xda) {
      // Start of Scan: copy scan header, compressed DCT stream, any progressive scans, and EOI verbatim
      parts.push(bytes.subarray(markerStart));
      reachedSos = true;
      break;
    }

    if (pos + 2 > bytes.length) return null;
    const segLen = readUint16BE(bytes, pos);
    if (segLen < 2 || pos + segLen > bytes.length) return null;

    const segEnd = pos + segLen;
    const payload = bytes.subarray(pos + 2, segEnd);
    let dropSegment = false;

    if (marker === 0xfe || marker === 0xec || marker === 0xed) {
      // COM, APP12, APP13 (Photoshop IPTC/IRB)
      dropSegment = true;
    } else if (marker === 0xe1) {
      // APP1: XMP or EXIF (Orientation === 1/absent)
      const head = readAscii(payload, 0, Math.min(payload.length, 36));
      if (
        head.startsWith('http://ns.adobe.com/xap/1.0/\0') ||
        head.startsWith('http://ns.adobe.com/xmp/extension/\0')
      ) {
        dropSegment = true;
      } else if (isExifPayloadSafeToStrip(payload)) {
        dropSegment = true;
      }
    }

    if (dropSegment) {
      strippedAny = true;
    } else {
      parts.push(bytes.subarray(markerStart, segEnd));
    }
    pos = segEnd;
  }

  if (!reachedSos || !strippedAny) return null;

  let totalLen = 0;
  for (const p of parts) totalLen += p.length;
  if (totalLen >= bytes.byteLength) return null;

  const out = new Uint8Array(totalLen);
  let cursor = 0;
  for (const p of parts) {
    out.set(p, cursor);
    cursor += p.length;
  }

  const origInfo = parseImageHeaderInfo(bytes, 'image/jpeg');
  const outInfo = parseImageHeaderInfo(out, 'image/jpeg');
  if (
    !origInfo.valid ||
    !outInfo.valid ||
    outInfo.width !== origInfo.width ||
    outInfo.height !== origInfo.height
  ) {
    return null;
  }

  return out;
}

/**
 * Inspects decoded RGBA pixel data for text, diagrams, transparency, thin 1-2px borders,
 * and sharp high-contrast chromatic details that suffer visible artifacts under lossy compression.
 * @param {Uint8ClampedArray} data
 * @param {number} width
 * @param {number} height
 */
export function detectFineDetailAndText(data, width, height) {
  const base = analyzeImagePixels(data, width, height);
  if (!data || width < 4 || height < 4) {
    return {
      ...base,
      hasFineTextOrHairlines: false,
      hairlinePulseRatio: 0,
      sharpTransitionRatio: 0
    };
  }

  const totalPixels = width * height;
  const rowStep = height > 400 ? Math.max(1, Math.floor(height / 320)) : 1;
  const colStep = width > 600 ? Math.max(1, Math.floor(width / 480)) : 1;
  let checked = 0;
  let hairlinePulses = 0;
  let flatCount = 0;
  let sharpCount = 0;

  for (let y = 0; y < height; y += rowStep) {
    const rowBase = y * width;
    for (let x = 1; x + 2 < width; x += colStep) {
      const p0 = (rowBase + x - 1) * 4;
      const p1 = (rowBase + x) * 4;
      const p2 = (rowBase + x + 1) * 4;
      const p3 = (rowBase + x + 2) * 4;
      if (p3 + 3 >= data.length) break;

      checked++;
      const l0 = data[p0] * 0.299 + data[p0 + 1] * 0.587 + data[p0 + 2] * 0.114;
      const l1 = data[p1] * 0.299 + data[p1 + 1] * 0.587 + data[p1 + 2] * 0.114;
      const l2 = data[p2] * 0.299 + data[p2 + 1] * 0.587 + data[p2 + 2] * 0.114;
      const l3 = data[p3] * 0.299 + data[p3 + 1] * 0.587 + data[p3 + 2] * 0.114;

      const stepDiff = Math.abs(l1 - l0);
      if (stepDiff <= 1.0) {
        flatCount++;
      } else if (stepDiff >= 45) {
        sharpCount++;
      }

      // Also track strong per-channel chromatic pulses (e.g. colored small text or gridlines)
      const cDiff01 = Math.max(
        Math.abs(data[p0] - data[p1]),
        Math.abs(data[p0 + 1] - data[p1 + 1]),
        Math.abs(data[p0 + 2] - data[p1 + 2])
      );
      const is1PxSpike = Math.abs(l1 - l0) >= 35 && Math.abs(l1 - l2) >= 35 && Math.abs(l0 - l2) <= 25;
      const is2PxStroke = Math.abs(l1 - l0) >= 35 && Math.abs(l2 - l3) >= 35 && Math.abs(l0 - l3) <= 25;
      const isChromaticThin =
        cDiff01 >= 45 &&
        Math.max(
          Math.abs(data[p0] - data[p2]),
          Math.abs(data[p0 + 1] - data[p2 + 1]),
          Math.abs(data[p0 + 2] - data[p2 + 2])
        ) <= 30;

      if (is1PxSpike || is2PxStroke || isChromaticThin) {
        hairlinePulses++;
      }
    }
  }

  const hairlinePulseRatio = checked > 0 ? hairlinePulses / checked : 0;
  const flatRatio = checked > 0 ? flatCount / checked : 0;
  const sharpTransitionRatio = checked > 0 ? sharpCount / checked : 0;

  // Text, UI screenshots, diagrams, and crisp line art combine solid flat runs with sharp edges
  // or thin 1-2px strokes; smooth bokeh/gradients alone are evaluated by PSNR/SSIM/edge-sharpness gates.
  const isTrueTextOrDiagram =
    (flatRatio >= 0.42 && sharpTransitionRatio >= 0.012) ||
    flatRatio >= 0.88 ||
    (totalPixels >= 16_000 && hairlinePulseRatio >= 0.006);

  return {
    ...base,
    isTextOrDiagramLikely: isTrueTextOrDiagram,
    hasFineTextOrHairlines: isTrueTextOrDiagram,
    hairlinePulseRatio,
    sharpTransitionRatio
  };
}

/**
 * Measures decoded RGBA pixel fidelity between original and candidate images:
 * - PSNR (dB)
 * - Mean 8x8 block luminance SSIM
 * - Mean absolute RGB error & peak channel deviation
 * - Alpha channel preservation
 * - Percentage of pixels with channel error > 10
 * - Edge sharpness retention ratio (%)
 * @param {Uint8ClampedArray} origRgba
 * @param {Uint8ClampedArray} candRgba
 * @param {number} width
 * @param {number} height
 */
export function measureDecodedImageQuality(origRgba, candRgba, width, height) {
  if (
    !origRgba ||
    !candRgba ||
    !width ||
    !height ||
    origRgba.length !== candRgba.length ||
    origRgba.length < width * height * 4
  ) {
    return {
      valid: false,
      psnrDb: 0,
      ssim: 0,
      meanAbsDiff: 255,
      maxChannelDiff: 255,
      alphaMaxDiff: 255,
      pctPixelsDiffGt10: 100,
      edgeSharpnessRetentionPct: 0
    };
  }

  const n = width * height;
  let maxChannelDiff = 0;
  let alphaMaxDiff = 0;
  let sumAbs = 0;
  let sumSq = 0;
  let gt10Count = 0;
  let origEdgeSum = 0;
  let candEdgeSum = 0;

  const origLum = new Float32Array(n);
  const candLum = new Float32Array(n);

  for (let y = 0; y < height; y++) {
    const rowOff = y * width;
    for (let x = 0; x < width; x++) {
      const px = rowOff + x;
      const i = px * 4;

      const dR = Math.abs(origRgba[i] - candRgba[i]);
      const dG = Math.abs(origRgba[i + 1] - candRgba[i + 1]);
      const dB = Math.abs(origRgba[i + 2] - candRgba[i + 2]);
      const dA = Math.abs(origRgba[i + 3] - candRgba[i + 3]);

      const rgbMax = dR > dG ? (dR > dB ? dR : dB) : dG > dB ? dG : dB;
      if (rgbMax > maxChannelDiff) maxChannelDiff = rgbMax;
      if (dA > alphaMaxDiff) alphaMaxDiff = dA;
      if (rgbMax > 10) gt10Count++;

      sumAbs += dR + dG + dB;
      sumSq += dR * dR + dG * dG + dB * dB;

      const lA = origRgba[i] * 0.299 + origRgba[i + 1] * 0.587 + origRgba[i + 2] * 0.114;
      const lB = candRgba[i] * 0.299 + candRgba[i + 1] * 0.587 + candRgba[i + 2] * 0.114;
      origLum[px] = lA;
      candLum[px] = lB;

      if (x > 0) {
        const gA = Math.abs(lA - origLum[px - 1]);
        if (gA >= 20) {
          origEdgeSum += gA;
          candEdgeSum += Math.abs(lB - candLum[px - 1]);
        }
      }
      if (y > 0) {
        const gA = Math.abs(lA - origLum[px - width]);
        if (gA >= 20) {
          origEdgeSum += gA;
          candEdgeSum += Math.abs(lB - candLum[px - width]);
        }
      }
    }
  }

  const mse = sumSq / (n * 3);
  const psnrDb = mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
  const meanAbsDiff = sumAbs / (n * 3);
  const pctPixelsDiffGt10 = (gt10Count / n) * 100;
  const edgeSharpnessRetentionPct =
    origEdgeSum > 0 ? (candEdgeSum / origEdgeSum) * 100 : 100;

  // Mean 8x8 block luminance SSIM across entire image
  const C1 = 6.5025;
  const C2 = 58.5225;
  let ssimSum = 0;
  let ssimBlocks = 0;
  const bxEnd = width - (width % 8);
  const byEnd = height - (height % 8);

  for (let by = 0; by + 8 <= byEnd; by += 8) {
    for (let bx = 0; bx + 8 <= bxEnd; bx += 8) {
      let sX = 0;
      let sY = 0;
      let sXX = 0;
      let sYY = 0;
      let sXY = 0;
      for (let dy = 0; dy < 8; dy++) {
        const row = (by + dy) * width + bx;
        for (let dx = 0; dx < 8; dx++) {
          const vx = origLum[row + dx];
          const vy = candLum[row + dx];
          sX += vx;
          sY += vy;
          sXX += vx * vx;
          sYY += vy * vy;
          sXY += vx * vy;
        }
      }
      const muX = sX / 64;
      const muY = sY / 64;
      const varX = Math.max(0, sXX / 64 - muX * muX);
      const varY = Math.max(0, sYY / 64 - muY * muY);
      const covXY = sXY / 64 - muX * muY;
      const num = (2 * muX * muY + C1) * (2 * covXY + C2);
      const den = (muX * muX + muY * muY + C1) * (varX + varY + C2);
      ssimSum += den > 0 ? num / den : 1;
      ssimBlocks++;
    }
  }

  const ssim = ssimBlocks > 0 ? ssimSum / ssimBlocks : mse === 0 ? 1 : 0;

  return {
    valid: true,
    psnrDb,
    ssim,
    meanAbsDiff,
    maxChannelDiff,
    alphaMaxDiff,
    pctPixelsDiffGt10,
    edgeSharpnessRetentionPct
  };
}

/**
 * Decodes image bytes into full-resolution RGBA pixel data in browser DOM/Worker runtimes.
 * Returns null if DOM/Canvas decoding APIs are unavailable (e.g., plain Node.js).
 */
async function decodeImageBytesToRgba(bytes, mimeType, { signal, deadlineAt, timeoutMs }) {
  const hasCanvas =
    typeof OffscreenCanvas !== 'undefined' ||
    (typeof document !== 'undefined' && typeof document.createElement === 'function');
  const canBitmap = typeof createImageBitmap === 'function';
  const canImage =
    typeof Image !== 'undefined' &&
    typeof URL !== 'undefined' &&
    typeof URL.createObjectURL === 'function';

  if (!hasCanvas || (!canBitmap && !canImage)) {
    return null;
  }

  return await runWithCancellation(
    async () => {
      const blob = new Blob([bytes], { type: mimeType });
      let bitmap = null;
      let objectUrl = null;
      try {
        let source;
        let width;
        let height;
        if (canBitmap) {
          bitmap = await createImageBitmap(blob);
          source = bitmap;
          width = bitmap.width;
          height = bitmap.height;
        } else {
          objectUrl = URL.createObjectURL(blob);
          const img = await new Promise((resolve, reject) => {
            const el = new Image();
            el.onload = () => resolve(el);
            el.onerror = () => reject(new Error(`Failed to decode ${mimeType}`));
            el.src = objectUrl;
          });
          source = img;
          width = img.naturalWidth || img.width;
          height = img.naturalHeight || img.height;
        }

        if (!width || !height) {
          throw new Error('Decoded image has zero dimensions');
        }

        const canvas =
          typeof OffscreenCanvas !== 'undefined'
            ? new OffscreenCanvas(width, height)
            : document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: true });
        if (!ctx) throw new Error('2D canvas context unavailable');
        ctx.clearRect(0, 0, width, height);
        ctx.drawImage(source, 0, 0, width, height);
        const imgData = ctx.getImageData(0, 0, width, height);
        return { width, height, rgba: imgData.data };
      } finally {
        try {
          bitmap?.close?.();
        } catch (_) {}
        if (objectUrl) {
          try {
            URL.revokeObjectURL(objectUrl);
          } catch (_) {}
        }
      }
    },
    { signal, deadlineAt, timeoutMs }
  );
}

/**
 * Re-encodes an image 1:1 via browser Canvas at an explicit quality without downscaling.
 */
async function encodeCanvasImageExact(bytes, mimeType, quality, { signal, deadlineAt, timeoutMs }) {
  const adapter = getBrowserImageAdapter();
  if (!adapter) return null;
  let decoded = null;
  try {
    decoded = await runWithCancellation(
      () => adapter.decodeAndAnalyze(new Blob([bytes], { type: mimeType })),
      { signal, deadlineAt, timeoutMs }
    );
    if (!decoded || !decoded.width || !decoded.height) return null;
    const outBlob = await runWithCancellation(
      () =>
        adapter.encode(decoded, {
          targetWidth: decoded.width,
          targetHeight: decoded.height,
          mimeType,
          quality,
          preserveTransparency: Boolean(decoded.hasTransparentPixels)
        }),
      { signal, deadlineAt, timeoutMs }
    );
    if (!outBlob || normalizeMimeType(outBlob.type) !== mimeType) return null;
    return new Uint8Array(
      await runWithCancellation(() => outBlob.arrayBuffer(), { signal, deadlineAt, timeoutMs })
    );
  } finally {
    try {
      decoded?.release?.();
    } catch (_) {}
  }
}

const OPENXML_QUALITY_THRESHOLDS = Object.freeze({
  MIN_PSNR_DB: 41.0,
  MIN_SSIM: 0.985,
  MAX_MEAN_ABS_DIFF: 1.8,
  MAX_JPEG_CHANNEL_DIFF: 26,
  MAX_WEBP_CHANNEL_DIFF: 24,
  MAX_PCT_DIFF_GT10: 0.8,
  MIN_EDGE_SHARPNESS_PCT: 95.0,
  MAX_EDGE_SHARPNESS_PCT: 104.0,
  EMBEDDED_JPEG_QUALITY: 0.93,
  EMBEDDED_WEBP_QUALITY: 0.93
});

function passesOpenXmlLossyQualityGate(metrics, mimeType) {
  if (!metrics?.valid) return false;
  const maxChanAllowed =
    mimeType === 'image/webp'
      ? OPENXML_QUALITY_THRESHOLDS.MAX_WEBP_CHANNEL_DIFF
      : OPENXML_QUALITY_THRESHOLDS.MAX_JPEG_CHANNEL_DIFF;
  return (
    metrics.alphaMaxDiff === 0 &&
    metrics.psnrDb >= OPENXML_QUALITY_THRESHOLDS.MIN_PSNR_DB &&
    metrics.ssim >= OPENXML_QUALITY_THRESHOLDS.MIN_SSIM &&
    metrics.meanAbsDiff <= OPENXML_QUALITY_THRESHOLDS.MAX_MEAN_ABS_DIFF &&
    metrics.maxChannelDiff <= maxChanAllowed &&
    metrics.pctPixelsDiffGt10 <= OPENXML_QUALITY_THRESHOLDS.MAX_PCT_DIFF_GT10 &&
    metrics.edgeSharpnessRetentionPct >= OPENXML_QUALITY_THRESHOLDS.MIN_EDGE_SHARPNESS_PCT &&
    metrics.edgeSharpnessRetentionPct <= OPENXML_QUALITY_THRESHOLDS.MAX_EDGE_SHARPNESS_PCT
  );
}

/**
 * Quality-first optimizer for embedded OpenXML PNG/JPEG/WebP media:
 * - Prefers 100% lossless optimization (oxipng for PNG, metadata-preserving lossless stripping for JPEG & WebP).
 * - Never converts lossless WebP (VP8L), transparent images, text, diagrams, or hairline graphics to lossy formats.
 * - For opaque continuous-tone photos where lossless stripping alone does not save >= 10%, allows high-quality
 *   re-encoding ONLY when decoded RGBA comparisons prove imperceptible difference (PSNR >= 41 dB, SSIM >= 0.985,
 *   edge sharpness >= 95%, alpha unchanged). Otherwise retains the exact original embedded image.
 */
export async function optimizeEmbeddedOpenXmlMedia(
  origMediaBytes,
  expectedMediaMime,
  baseName,
  options,
  ctx
) {
  const { signal, deadlineAt, timeoutMs } = ctx;
  const minRatio = Number.isFinite(Number(options?.minEmbeddedSavingsRatio))
    ? Math.max(0, Number(options.minEmbeddedSavingsRatio))
    : SMART_COMPRESSION_DEFAULTS.MIN_SAVINGS_RATIO;

  const origSize = origMediaBytes?.byteLength || 0;
  if (!origSize) return null;

  // 1. Embedded PNG: lossless-only (@jsquash/oxipng); never allow lossy/premultiplied Canvas fallback
  if (expectedMediaMime === 'image/png') {
    const origHeader = parseImageHeaderInfo(origMediaBytes, 'image/png');
    if (!origHeader.valid) return null;
    let outBytes;
    try {
      outBytes = await runOxipngOptimization(origMediaBytes, { signal, deadlineAt, timeoutMs });
    } catch (err) {
      if (err?.name === 'AbortError' || err?.name === 'TimeoutError' || signal?.aborted) {
        throw err;
      }
      return null;
    }
    if (!(outBytes instanceof Uint8Array) || outBytes.byteLength === 0) return null;
    if ((origSize - outBytes.byteLength) / origSize < minRatio) return null;

    const outHeader = parseImageHeaderInfo(outBytes, 'image/png');
    if (
      detectFormatFromSignature(outBytes) !== 'image/png' ||
      detectAnimatedImage(outBytes, 'image/png') ||
      !outHeader.valid ||
      outHeader.width !== origHeader.width ||
      outHeader.height !== origHeader.height
    ) {
      return null;
    }

    // Verify decoded 0-diff pixel parity in browser runtimes
    const origDecoded = await decodeImageBytesToRgba(origMediaBytes, 'image/png', {
      signal,
      deadlineAt,
      timeoutMs
    });
    if (origDecoded) {
      const candDecoded = await decodeImageBytesToRgba(outBytes, 'image/png', {
        signal,
        deadlineAt,
        timeoutMs
      });
      if (
        !candDecoded ||
        candDecoded.width !== origDecoded.width ||
        candDecoded.height !== origDecoded.height
      ) {
        return null;
      }
      const metrics = measureDecodedImageQuality(
        origDecoded.rgba,
        candDecoded.rgba,
        origDecoded.width,
        origDecoded.height
      );
      if (metrics.maxChannelDiff !== 0 || metrics.alphaMaxDiff !== 0) {
        return null;
      }
    }

    return { bytes: outBytes, mode: 'lossless-oxipng' };
  }

  // 2. Embedded JPEG & WebP: prefer lossless metadata optimization first
  if (expectedMediaMime === 'image/jpeg' || expectedMediaMime === 'image/webp') {
    const losslessCandidate =
      expectedMediaMime === 'image/jpeg'
        ? optimizeJpegMetadataLossless(origMediaBytes)
        : optimizeWebpMetadataLossless(origMediaBytes);

    if (
      losslessCandidate instanceof Uint8Array &&
      losslessCandidate.byteLength > 0 &&
      (origSize - losslessCandidate.byteLength) / origSize >= minRatio
    ) {
      const origDecoded = await decodeImageBytesToRgba(origMediaBytes, expectedMediaMime, {
        signal,
        deadlineAt,
        timeoutMs
      });
      if (!origDecoded) {
        return { bytes: losslessCandidate, mode: `lossless-${expectedMediaMime}-metadata` };
      }
      const candDecoded = await decodeImageBytesToRgba(losslessCandidate, expectedMediaMime, {
        signal,
        deadlineAt,
        timeoutMs
      });
      if (
        candDecoded &&
        candDecoded.width === origDecoded.width &&
        candDecoded.height === origDecoded.height
      ) {
        const metrics = measureDecodedImageQuality(
          origDecoded.rgba,
          candDecoded.rgba,
          origDecoded.width,
          origDecoded.height
        );
        if (metrics.maxChannelDiff === 0 && metrics.alphaMaxDiff === 0) {
          return {
            bytes: losslessCandidate,
            mode: `lossless-${expectedMediaMime}-metadata`,
            metrics
          };
        }
      }
    }

    // Never allow lossy recompression on lossless VP8L or transparent WebP bitstreams
    if (expectedMediaMime === 'image/webp') {
      const webpInfo = parseWebpContainerInfo(origMediaBytes);
      if (!webpInfo.valid || webpInfo.isLosslessBitstream || webpInfo.hasAlpha || webpInfo.hasAnim) {
        return null;
      }
    }

    // Decode original 1:1 RGBA to protect text, diagrams, transparency, and fine details
    const origDecoded = await decodeImageBytesToRgba(origMediaBytes, expectedMediaMime, {
      signal,
      deadlineAt,
      timeoutMs
    });
    if (!origDecoded) {
      // Without DOM pixel verification, do not risk blind lossy re-encoding inside OpenXML packages
      return null;
    }

    const detailInfo = detectFineDetailAndText(
      origDecoded.rgba,
      origDecoded.width,
      origDecoded.height
    );
    if (
      detailInfo.hasTransparentPixels ||
      detailInfo.isTextOrDiagramLikely ||
      detailInfo.hasFineTextOrHairlines
    ) {
      // Retain untouched original to protect text, diagrams, transparency, and crisp hairlines
      return null;
    }

    // Photo-only conservative high-quality check with strict pixel-diff verification
    const quality =
      expectedMediaMime === 'image/webp'
        ? OPENXML_QUALITY_THRESHOLDS.EMBEDDED_WEBP_QUALITY
        : OPENXML_QUALITY_THRESHOLDS.EMBEDDED_JPEG_QUALITY;
    let candidateBytes = null;
    try {
      candidateBytes = await encodeCanvasImageExact(origMediaBytes, expectedMediaMime, quality, {
        signal,
        deadlineAt,
        timeoutMs
      });
    } catch (err) {
      if (err?.name === 'AbortError' || err?.name === 'TimeoutError' || signal?.aborted) {
        throw err;
      }
      return null;
    }

    if (
      !(candidateBytes instanceof Uint8Array) ||
      candidateBytes.byteLength === 0 ||
      (origSize - candidateBytes.byteLength) / origSize < minRatio
    ) {
      return null;
    }

    const candHeader = parseImageHeaderInfo(candidateBytes, expectedMediaMime);
    if (
      !candHeader.valid ||
      candHeader.width !== origDecoded.width ||
      candHeader.height !== origDecoded.height
    ) {
      return null;
    }

    const candDecoded = await decodeImageBytesToRgba(candidateBytes, expectedMediaMime, {
      signal,
      deadlineAt,
      timeoutMs
    });
    if (
      !candDecoded ||
      candDecoded.width !== origDecoded.width ||
      candDecoded.height !== origDecoded.height
    ) {
      return null;
    }

    const metrics = measureDecodedImageQuality(
      origDecoded.rgba,
      candDecoded.rgba,
      origDecoded.width,
      origDecoded.height
    );
    if (!passesOpenXmlLossyQualityGate(metrics, expectedMediaMime)) {
      // Meaningful quality loss detected -> retain original embedded image
      return null;
    }

    return {
      bytes: candidateBytes,
      mode: 'verified-high-quality-photo',
      metrics
    };
  }

  return null;
}

/**
 * Losslessly recompresses OpenXML (DOCX, PPTX, XLSX) ZIP containers via JSZip DEFLATE level 9,
 * optionally optimizing eligible embedded PNG/JPEG/WebP media when safe while leaving GIFs,
 * SVG/EMF/WMF vectors, XML, relationships, formulas, slides, notes, and macros untouched.
 */
async function optimizeOpenXmlFile(file, inputBytes, mimeType, formatInfo, options, ctx) {
  const { signal, deadlineAt, timeoutMs, onStage, minSavingsRatio } = ctx;

  if (formatInfo.encryptedOle2 || isEncryptedOle2OpenXml(inputBytes)) {
    emitStage(onStage, COMPRESSION_STAGES.SKIPPED, {
      fileName: file.name,
      reason: COMPRESSION_REASONS.PROTECTED_PACKAGE
    });
    return buildResult(file, false, file.size, file.size, COMPRESSION_REASONS.PROTECTED_PACKAGE);
  }

  const rawZipInfo = inspectOpenXmlZipContainer(inputBytes);
  if (!rawZipInfo.isZip || rawZipInfo.openXmlMime !== mimeType) {
    emitStage(onStage, COMPRESSION_STAGES.SKIPPED, {
      fileName: file.name,
      reason: COMPRESSION_REASONS.CORRUPTED_OR_UNREADABLE
    });
    return buildResult(
      file,
      false,
      file.size,
      file.size,
      COMPRESSION_REASONS.CORRUPTED_OR_UNREADABLE
    );
  }

  if (rawZipInfo.hasEncryptedEntry || rawZipInfo.hasProtectionEntry) {
    emitStage(onStage, COMPRESSION_STAGES.SKIPPED, {
      fileName: file.name,
      reason: COMPRESSION_REASONS.PROTECTED_PACKAGE
    });
    return buildResult(file, false, file.size, file.size, COMPRESSION_REASONS.PROTECTED_PACKAGE);
  }

  const jszipModule = await runWithCancellation(() => import('jszip'), {
    signal,
    deadlineAt,
    timeoutMs
  });
  const JSZip = jszipModule?.default || jszipModule;
  if (!JSZip || typeof JSZip.loadAsync !== 'function') {
    return buildResult(
      file,
      false,
      file.size,
      file.size,
      COMPRESSION_REASONS.UNSUPPORTED_ENVIRONMENT
    );
  }

  let zip;
  try {
    zip = await runWithCancellation(() => JSZip.loadAsync(inputBytes), {
      signal,
      deadlineAt,
      timeoutMs
    });
  } catch (err) {
    if (err?.name === 'AbortError' || err?.name === 'TimeoutError') throw err;
    emitStage(onStage, COMPRESSION_STAGES.SKIPPED, {
      fileName: file.name,
      reason: COMPRESSION_REASONS.CORRUPTED_OR_UNREADABLE
    });
    return buildResult(
      file,
      false,
      file.size,
      file.size,
      COMPRESSION_REASONS.CORRUPTED_OR_UNREADABLE
    );
  }

  const isProtected = await detectOpenXmlProtection(zip, mimeType, rawZipInfo, {
    signal,
    deadlineAt,
    timeoutMs
  });
  if (isProtected) {
    emitStage(onStage, COMPRESSION_STAGES.SKIPPED, {
      fileName: file.name,
      reason: COMPRESSION_REASONS.PROTECTED_PACKAGE
    });
    return buildResult(file, false, file.size, file.size, COMPRESSION_REASONS.PROTECTED_PACKAGE);
  }

  // Snapshot all non-directory entries and validate core parts before modifying anything
  const fileEntryKeys = Object.keys(zip.files).filter((k) => !zip.files[k].dir);
  const lowerKeys = new Set(fileEntryKeys.map((k) => k.toLowerCase()));
  const coreMeta = OPENXML_CORE_PARTS[mimeType];
  if (
    !lowerKeys.has('[content_types].xml') ||
    !lowerKeys.has('_rels/.rels') ||
    !coreMeta ||
    !lowerKeys.has(coreMeta.partPath.toLowerCase())
  ) {
    emitStage(onStage, COMPRESSION_STAGES.SKIPPED, {
      fileName: file.name,
      reason: COMPRESSION_REASONS.CORRUPTED_OR_UNREADABLE
    });
    return buildResult(
      file,
      false,
      file.size,
      file.size,
      COMPRESSION_REASONS.CORRUPTED_OR_UNREADABLE
    );
  }

  const originalEntriesMap = new Map();
  try {
    for (const entryPath of fileEntryKeys) {
      const bytes = await runWithCancellation(() => zip.files[entryPath].async('uint8array'), {
        signal,
        deadlineAt,
        timeoutMs
      });
      originalEntriesMap.set(entryPath, bytes);
    }
  } catch (err) {
    if (err?.name === 'AbortError' || err?.name === 'TimeoutError') throw err;
    emitStage(onStage, COMPRESSION_STAGES.SKIPPED, {
      fileName: file.name,
      reason: COMPRESSION_REASONS.CORRUPTED_OR_UNREADABLE
    });
    return buildResult(
      file,
      false,
      file.size,
      file.size,
      COMPRESSION_REASONS.CORRUPTED_OR_UNREADABLE
    );
  }

  emitStage(onStage, COMPRESSION_STAGES.OPTIMIZING, {
    fileName: file.name,
    mimeType,
    originalSize: file.size,
    optimizer: 'jszip-deflate-9'
  });

  // Optimize eligible embedded PNG/JPEG/WebP assets inside word/media/, ppt/media/, xl/media/
  const embeddedMinBytes = Number.isFinite(Number(options?.minEmbeddedImageBytes))
    ? Math.max(0, Number(options.minEmbeddedImageBytes))
    : 8 * 1024;
  const optimizedMediaSignatures = new Map();

  for (const entryPath of fileEntryKeys) {
    if (signal?.aborted) throw createAbortError();
    if (deadlineAt <= Date.now()) throw createTimeoutError(timeoutMs);

    const ext = extractExtension(entryPath);
    if (OPENXML_PRESERVE_ASSET_EXTENSIONS.has(ext)) {
      continue;
    }
    if (!OPENXML_OPTIMIZABLE_MEDIA_REGEX.test(entryPath)) {
      continue;
    }

    const expectedMediaMime = EXTENSION_TO_MIME[ext];
    if (!expectedMediaMime || expectedMediaMime === 'image/gif') {
      continue;
    }

    const origMediaBytes = originalEntriesMap.get(entryPath);
    if (!(origMediaBytes instanceof Uint8Array) || origMediaBytes.byteLength < embeddedMinBytes) {
      continue;
    }

    const sigMediaMime = detectFormatFromSignature(origMediaBytes);
    if (sigMediaMime !== expectedMediaMime) {
      continue;
    }
    if (detectAnimatedImage(origMediaBytes, sigMediaMime)) {
      continue;
    }

    const baseName = entryPath.slice(entryPath.lastIndexOf('/') + 1) || `image${ext}`;
    const optMediaResult = await optimizeEmbeddedOpenXmlMedia(
      origMediaBytes,
      expectedMediaMime,
      baseName,
      {
        ...options,
        minEmbeddedImageBytes: embeddedMinBytes
      },
      ctx
    );

    if (
      optMediaResult?.bytes instanceof Uint8Array &&
      optMediaResult.bytes.byteLength > 0 &&
      optMediaResult.bytes.byteLength < origMediaBytes.byteLength &&
      detectFormatFromSignature(optMediaResult.bytes) === expectedMediaMime
    ) {
      const origEntry = zip.files[entryPath];
      zip.file(entryPath, optMediaResult.bytes, {
        binary: true,
        date: origEntry?.date,
        unixPermissions: origEntry?.unixPermissions,
        dosPermissions: origEntry?.dosPermissions
      });
      optimizedMediaSignatures.set(entryPath, expectedMediaMime);
    }
  }

  // Recompress the OpenXML package with DEFLATE level 9
  const outBytes = await runWithCancellation(
    () =>
      zip.generateAsync({
        type: 'uint8array',
        compression: 'DEFLATE',
        compressionOptions: { level: 9 }
      }),
    { signal, deadlineAt, timeoutMs }
  );

  if (!(outBytes instanceof Uint8Array) || outBytes.byteLength >= file.size) {
    emitStage(onStage, COMPRESSION_STAGES.SKIPPED, {
      fileName: file.name,
      reason: COMPRESSION_REASONS.INSUFFICIENT_SAVINGS
    });
    return buildResult(file, false, file.size, file.size, COMPRESSION_REASONS.INSUFFICIENT_SAVINGS);
  }

  const savingsRatio = (file.size - outBytes.byteLength) / file.size;
  if (savingsRatio < minSavingsRatio) {
    emitStage(onStage, COMPRESSION_STAGES.SKIPPED, {
      fileName: file.name,
      reason: COMPRESSION_REASONS.INSUFFICIENT_SAVINGS
    });
    return buildResult(file, false, file.size, file.size, COMPRESSION_REASONS.INSUFFICIENT_SAVINGS);
  }

  emitStage(onStage, COMPRESSION_STAGES.VALIDATING, {
    fileName: file.name,
    mimeType,
    originalSize: file.size,
    candidateSize: outBytes.byteLength
  });

  const valid = await validateOptimizedOpenXml(
    JSZip,
    outBytes,
    mimeType,
    originalEntriesMap,
    optimizedMediaSignatures,
    { signal, deadlineAt, timeoutMs }
  );
  if (!valid) {
    emitStage(onStage, COMPRESSION_STAGES.SKIPPED, {
      fileName: file.name,
      reason: COMPRESSION_REASONS.VALIDATION_FAILED
    });
    return buildResult(file, false, file.size, file.size, COMPRESSION_REASONS.VALIDATION_FAILED);
  }

  const compressedFile = new File([outBytes], file.name, {
    type: mimeType,
    lastModified: file.lastModified
  });

  emitStage(onStage, COMPRESSION_STAGES.COMPLETE, {
    fileName: compressedFile.name,
    mimeType,
    originalSize: file.size,
    finalSize: compressedFile.size
  });

  return buildResult(
    compressedFile,
    true,
    file.size,
    compressedFile.size,
    COMPRESSION_REASONS.COMPRESSED
  );
}

/**
 * Safely optimizes a File (supported image or PDF) while enforcing strict quality,
 * validation, >= 10% savings, AbortSignal, and fail-safe fallback guarantees.
 *
 * @param {File} file
 * @param {Object} [options={}]
 * @param {AbortSignal} [options.signal]
 * @param {(info: { stage: string, timestamp: number, [key: string]: any }) => void} [options.onStage]
 * @param {number} [options.timeoutMs=20000]
 * @param {number} [options.minImageBytes=81920]
 * @param {number} [options.minPdfBytes=65536]
 * @param {number} [options.minSavingsRatio=0.10]
 * @returns {Promise<{ file: File, compressed: boolean, originalSize: number, finalSize: number, reason: string }>}
 */
export async function compressFile(file, options = {}) {
  const onStage = typeof options?.onStage === 'function' ? options.onStage : null;
  const signal = options?.signal || null;

  if (
    !file ||
    typeof file !== 'object' ||
    typeof file.arrayBuffer !== 'function' ||
    typeof file.size !== 'number'
  ) {
    emitStage(onStage, COMPRESSION_STAGES.SKIPPED, {
      reason: COMPRESSION_REASONS.INVALID_INPUT
    });
    return buildResult(file, false, 0, 0, COMPRESSION_REASONS.INVALID_INPUT);
  }

  const originalSize = file.size;

  if (signal?.aborted) {
    emitStage(onStage, COMPRESSION_STAGES.ABORTED, {
      fileName: file.name,
      reason: COMPRESSION_REASONS.ABORTED
    });
    return buildResult(file, false, originalSize, originalSize, COMPRESSION_REASONS.ABORTED);
  }

  const timeoutMs =
    Number.isFinite(Number(options?.timeoutMs)) && Number(options.timeoutMs) > 0
      ? Number(options.timeoutMs)
      : SMART_COMPRESSION_DEFAULTS.TIMEOUT_MS;

  const minSavingsRatio = Math.max(
    SMART_COMPRESSION_DEFAULTS.MIN_SAVINGS_RATIO,
    Number.isFinite(Number(options?.minSavingsRatio))
      ? Number(options.minSavingsRatio)
      : SMART_COMPRESSION_DEFAULTS.MIN_SAVINGS_RATIO
  );

  const deadlineAt = Date.now() + timeoutMs;

  try {
    emitStage(onStage, COMPRESSION_STAGES.ANALYZING, {
      fileName: file.name,
      originalSize
    });

    // Quick extension/MIME pre-check before reading bytes for clearly unsupported formats.
    // Generic MIME types (e.g. application/octet-stream) are NOT definitive and defer to extension + signature.
    const ext = extractExtension(file.name);
    const rawDeclaredMime = normalizeMimeType(file.type);
    const declaredMime =
      rawDeclaredMime && !GENERIC_MIME_TYPES.has(rawDeclaredMime) ? rawDeclaredMime : '';
    const candidateMime = declaredMime || EXTENSION_TO_MIME[ext] || '';

    if (
      candidateMime &&
      !SUPPORTED_IMAGE_MIME_TYPES.has(candidateMime) &&
      candidateMime !== SUPPORTED_PDF_MIME_TYPE &&
      !SUPPORTED_OPENXML_MIME_TYPES.has(candidateMime)
    ) {
      emitStage(onStage, COMPRESSION_STAGES.SKIPPED, {
        fileName: file.name,
        reason: COMPRESSION_REASONS.UNSUPPORTED_FORMAT
      });
      return buildResult(
        file,
        false,
        originalSize,
        originalSize,
        COMPRESSION_REASONS.UNSUPPORTED_FORMAT
      );
    }

    // Lightweight file gate
    const minImageBytes = Number.isFinite(Number(options?.minImageBytes))
      ? Math.max(0, Number(options.minImageBytes))
      : SMART_COMPRESSION_DEFAULTS.MIN_IMAGE_BYTES;
    const minPdfBytes = Number.isFinite(Number(options?.minPdfBytes))
      ? Math.max(0, Number(options.minPdfBytes))
      : SMART_COMPRESSION_DEFAULTS.MIN_PDF_BYTES;
    const minOpenXmlBytes = Number.isFinite(Number(options?.minOpenXmlBytes))
      ? Math.max(0, Number(options.minOpenXmlBytes))
      : SMART_COMPRESSION_DEFAULTS.MIN_OPENXML_BYTES;
    const minThreshold =
      candidateMime === SUPPORTED_PDF_MIME_TYPE
        ? minPdfBytes
        : SUPPORTED_OPENXML_MIME_TYPES.has(candidateMime)
        ? minOpenXmlBytes
        : SUPPORTED_IMAGE_MIME_TYPES.has(candidateMime)
        ? minImageBytes
        : Math.min(minImageBytes, minPdfBytes, minOpenXmlBytes);

    if (originalSize <= 0 || originalSize < minThreshold) {
      emitStage(onStage, COMPRESSION_STAGES.SKIPPED, {
        fileName: file.name,
        reason: COMPRESSION_REASONS.LIGHTWEIGHT_FILE
      });
      return buildResult(
        file,
        false,
        originalSize,
        originalSize,
        COMPRESSION_REASONS.LIGHTWEIGHT_FILE
      );
    }

    // Read file bytes safely with cancellation support
    const arrayBuf = await runWithCancellation(() => file.arrayBuffer(), {
      signal,
      deadlineAt,
      timeoutMs
    });
    const inputBytes = new Uint8Array(arrayBuf);

    // Resolve and verify matching MIME, extension, and binary signature
    const formatInfo = resolveInputFormat(file, inputBytes);

    if (!formatInfo.ok) {
      const reason = formatInfo.mismatch
        ? COMPRESSION_REASONS.CORRUPTED_OR_UNREADABLE
        : COMPRESSION_REASONS.UNSUPPORTED_FORMAT;
      emitStage(onStage, COMPRESSION_STAGES.SKIPPED, {
        fileName: file.name,
        reason
      });
      return buildResult(file, false, originalSize, originalSize, reason);
    }

    // Enforce exact format-specific lightweight gate when resolved via signature (e.g. extensionless octet-stream)
    const resolvedMinThreshold =
      formatInfo.mimeType === SUPPORTED_PDF_MIME_TYPE
        ? minPdfBytes
        : SUPPORTED_OPENXML_MIME_TYPES.has(formatInfo.mimeType)
        ? minOpenXmlBytes
        : minImageBytes;
    if (originalSize < resolvedMinThreshold) {
      emitStage(onStage, COMPRESSION_STAGES.SKIPPED, {
        fileName: file.name,
        reason: COMPRESSION_REASONS.LIGHTWEIGHT_FILE
      });
      return buildResult(
        file,
        false,
        originalSize,
        originalSize,
        COMPRESSION_REASONS.LIGHTWEIGHT_FILE
      );
    }

    const ctx = {
      signal,
      deadlineAt,
      timeoutMs,
      onStage,
      minSavingsRatio
    };

    if (formatInfo.mimeType === SUPPORTED_PDF_MIME_TYPE) {
      return await optimizePdfFile(file, inputBytes, options, ctx);
    }

    if (SUPPORTED_OPENXML_MIME_TYPES.has(formatInfo.mimeType)) {
      return await optimizeOpenXmlFile(file, inputBytes, formatInfo.mimeType, formatInfo, options, ctx);
    }

    if (formatInfo.mimeType === 'image/gif') {
      return await optimizeGifFile(file, inputBytes, options, ctx);
    }

    if (SUPPORTED_IMAGE_MIME_TYPES.has(formatInfo.mimeType)) {
      return await optimizeImageFile(file, inputBytes, formatInfo.mimeType, options, ctx);
    }

    emitStage(onStage, COMPRESSION_STAGES.SKIPPED, {
      fileName: file.name,
      reason: COMPRESSION_REASONS.UNSUPPORTED_FORMAT
    });
    return buildResult(
      file,
      false,
      originalSize,
      originalSize,
      COMPRESSION_REASONS.UNSUPPORTED_FORMAT
    );
  } catch (err) {
    if (err?.name === 'AbortError' || signal?.aborted) {
      emitStage(onStage, COMPRESSION_STAGES.ABORTED, {
        fileName: file.name,
        reason: COMPRESSION_REASONS.ABORTED
      });
      return buildResult(file, false, originalSize, originalSize, COMPRESSION_REASONS.ABORTED);
    }

    if (err?.name === 'TimeoutError') {
      emitStage(onStage, COMPRESSION_STAGES.ERROR, {
        fileName: file.name,
        reason: COMPRESSION_REASONS.TIMEOUT
      });
      return buildResult(file, false, originalSize, originalSize, COMPRESSION_REASONS.TIMEOUT);
    }

    emitStage(onStage, COMPRESSION_STAGES.ERROR, {
      fileName: file.name,
      reason: COMPRESSION_REASONS.ERROR,
      error: err?.message || 'Unknown compression error'
    });
    return buildResult(file, false, originalSize, originalSize, COMPRESSION_REASONS.ERROR);
  }
}

export const smartCompressFile = compressFile;
