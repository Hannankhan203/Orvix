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
  '.pdf': 'application/pdf'
});

const MIME_TO_EXTENSIONS = Object.freeze({
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/webp': ['.webp'],
  'image/gif': ['.gif'],
  'application/pdf': ['.pdf']
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

  return null;
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
      candidateMime !== SUPPORTED_PDF_MIME_TYPE
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
    const minThreshold =
      candidateMime === SUPPORTED_PDF_MIME_TYPE
        ? minPdfBytes
        : SUPPORTED_IMAGE_MIME_TYPES.has(candidateMime)
        ? minImageBytes
        : Math.min(minImageBytes, minPdfBytes);

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
      formatInfo.mimeType === SUPPORTED_PDF_MIME_TYPE ? minPdfBytes : minImageBytes;
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
