/**
 * Transparent Storage Compression Service (Orvix Storage Envelope v1)
 *
 * Provides self-describing, lossless gzip envelope encoding/decoding via `fflate`
 * for TXT, MD, DOC, PPT, and XLS attachments:
 * - Preserves original filename, extension, MIME type, byte length, and contents.
 * - Enforces >= 10% net byte savings before accepting compression.
 * - Enforces strict streaming decompression bounds, format/MIME matching, CRC-32, and SHA-256 integrity.
 * - Safari 15.8.8 / iOS 15 compatible (zero regex lookbehinds, HTTP-safe SHA-256 fallback).
 */

import { Gzip, Gunzip } from 'fflate';
import { createAbortError } from './requestIsolationService.js';

export const ORVIX_ENVELOPE_ENCODING_ID = 'orvix-gzip-v1';
export const ORVIX_ENVELOPE_VERSION = 1;
export const ORVIX_ENVELOPE_CODEC_GZIP = 1;
export const DEFAULT_MAX_ORIGINAL_BYTES = 25 * 1024 * 1024; // 25 MB
export const MIN_SAVINGS_RATIO = 0.1; // >= 10% reduction required
export const MIN_COMPRESS_INPUT_BYTES = 128;

// 8-byte binary header magic: "ORVXENV\0"
const ORVIX_ENVELOPE_MAGIC = [0x4f, 0x52, 0x56, 0x58, 0x45, 0x4e, 0x56, 0x00];
const FIXED_HEADER_BYTES = 58;
const STREAM_ENCODE_CHUNK_BYTES = 256 * 1024;
const STREAM_DECODE_CHUNK_BYTES = 16 * 1024;

const FORMAT_SPECS = [
  {
    code: 1,
    extensions: ['.txt'],
    canonicalMime: 'text/plain',
    acceptedMimes: ['text/plain']
  },
  {
    code: 2,
    extensions: ['.md', '.markdown'],
    canonicalMime: 'text/markdown',
    acceptedMimes: ['text/markdown', 'text/plain', 'text/x-markdown']
  },
  {
    code: 3,
    extensions: ['.doc'],
    canonicalMime: 'application/msword',
    acceptedMimes: ['application/msword']
  },
  {
    code: 4,
    extensions: ['.ppt'],
    canonicalMime: 'application/vnd.ms-powerpoint',
    acceptedMimes: ['application/vnd.ms-powerpoint']
  },
  {
    code: 5,
    extensions: ['.xls'],
    canonicalMime: 'application/vnd.ms-excel',
    acceptedMimes: ['application/vnd.ms-excel']
  }
];

const SPEC_BY_CODE = new Map();
const SPEC_BY_EXT = new Map();
const SPEC_BY_CANONICAL_MIME = new Map();

for (const spec of FORMAT_SPECS) {
  SPEC_BY_CODE.set(spec.code, spec);
  SPEC_BY_CANONICAL_MIME.set(spec.canonicalMime, spec);
  for (const ext of spec.extensions) {
    SPEC_BY_EXT.set(ext, spec);
  }
}

export const TRANSPARENT_COMPRESSION_EXTENSIONS = Array.from(SPEC_BY_EXT.keys());

export class StorageEnvelopeError extends Error {
  constructor(message, code = 'INVALID_STORAGE_ENVELOPE', details = {}) {
    super(message);
    this.name = 'StorageEnvelopeError';
    this.code = code;
    this.details = details;
  }
}

// IEEE 802.3 CRC-32 lookup table
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function computeCrc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Pure-JS SHA-256 fallback (works in HTTP non-localhost Safari 15 & synchronous Node paths)
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

function rotr32(x, n) {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

export function computeSha256Sync(data) {
  const len = data.length;
  const bitLenHi = Math.floor((len * 8) / 0x100000000) >>> 0;
  const bitLenLo = (len * 8) >>> 0;

  // Pad to multiple of 64 bytes: original + 0x80 + zeros + 8-byte big-endian bit length
  const paddedLen = Math.ceil((len + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(data, 0);
  padded[len] = 0x80;

  const dv = new DataView(padded.buffer);
  dv.setUint32(paddedLen - 8, bitLenHi, false);
  dv.setUint32(paddedLen - 4, bitLenLo, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);

  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = dv.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr32(w[i - 15], 7) ^ rotr32(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr32(w[i - 2], 17) ^ rotr32(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i++) {
      const S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, h0, false);
  outView.setUint32(4, h1, false);
  outView.setUint32(8, h2, false);
  outView.setUint32(12, h3, false);
  outView.setUint32(16, h4, false);
  outView.setUint32(20, h5, false);
  outView.setUint32(24, h6, false);
  outView.setUint32(28, h7, false);
  return out;
}

export async function computeSha256(bytes) {
  try {
    if (typeof globalThis !== 'undefined' && globalThis.crypto?.subtle?.digest) {
      const slice = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
        ? bytes
        : new Uint8Array(bytes);
      const digest = await globalThis.crypto.subtle.digest('SHA-256', slice);
      return new Uint8Array(digest);
    }
  } catch (_) {
    // Fall back to deterministic pure-JS SHA-256
  }
  return computeSha256Sync(bytes);
}

export function bytesToHex(bytes) {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

function encodeAscii(str) {
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    bytes[i] = str.charCodeAt(i) & 0x7f;
  }
  return bytes;
}

function decodeAscii(bytes) {
  let str = '';
  for (let i = 0; i < bytes.length; i++) {
    str += String.fromCharCode(bytes[i]);
  }
  return str;
}

function toUint8Array(input) {
  if (input instanceof Uint8Array) {
    return input;
  }
  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new StorageEnvelopeError('Input payload must be binary Uint8Array or ArrayBuffer.', 'INVALID_INPUT_TYPE');
}

function normalizeExtensionDot(ext = '', fileName = '') {
  const candidate = typeof ext === 'string' && ext.trim()
    ? ext.trim().toLowerCase()
    : '';
  if (candidate) {
    return candidate.startsWith('.') ? candidate : `.${candidate}`;
  }
  if (typeof fileName === 'string') {
    const cleanName = fileName.trim();
    const lastDot = cleanName.lastIndexOf('.');
    if (lastDot > 0) {
      return cleanName.slice(lastDot).toLowerCase();
    }
  }
  return '';
}

function normalizeMime(mime = '') {
  if (typeof mime !== 'string') return '';
  return mime.split(';')[0].trim().toLowerCase();
}

function resolveTargetSpec(mimeType = '', extension = '', fileName = '') {
  const dotExt = normalizeExtensionDot(extension, fileName);
  const cleanMime = normalizeMime(mimeType);

  if (dotExt && SPEC_BY_EXT.has(dotExt)) {
    const extSpec = SPEC_BY_EXT.get(dotExt);
    if (
      !cleanMime ||
      cleanMime === 'application/octet-stream' ||
      cleanMime === 'binary/octet-stream' ||
      extSpec.acceptedMimes.includes(cleanMime)
    ) {
      return { spec: extSpec, dotExt };
    }
    return { spec: null, dotExt, mimeMismatch: true };
  }

  // Fallback by strict canonical MIME when extension is omitted
  if (!dotExt && cleanMime && SPEC_BY_CANONICAL_MIME.has(cleanMime)) {
    const spec = SPEC_BY_CANONICAL_MIME.get(cleanMime);
    return { spec, dotExt: spec.extensions[0] };
  }

  return { spec: null, dotExt };
}

export function isTransparentStorageCompressionSupported(fileOrDescriptor) {
  if (!fileOrDescriptor) return false;
  const mime = typeof fileOrDescriptor === 'string'
    ? fileOrDescriptor
    : (fileOrDescriptor.mimeType || fileOrDescriptor.type || '');
  const ext = typeof fileOrDescriptor === 'string'
    ? fileOrDescriptor
    : (fileOrDescriptor.extension || '');
  const name = typeof fileOrDescriptor === 'object' ? (fileOrDescriptor.name || fileOrDescriptor.originalName || '') : '';
  const resolved = resolveTargetSpec(mime, ext, name);
  return Boolean(resolved.spec);
}

export function getCanonicalMimeForExtension(extension = '') {
  const dotExt = normalizeExtensionDot(extension);
  return SPEC_BY_EXT.get(dotExt)?.canonicalMime || null;
}

export function isOrvixStorageEnvelope(input) {
  try {
    const bytes = input instanceof Uint8Array
      ? input
      : input instanceof ArrayBuffer
      ? new Uint8Array(input)
      : ArrayBuffer.isView(input)
      ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
      : null;
    if (!bytes || bytes.length < FIXED_HEADER_BYTES) {
      return false;
    }
    for (let i = 0; i < ORVIX_ENVELOPE_MAGIC.length; i++) {
      if (bytes[i] !== ORVIX_ENVELOPE_MAGIC[i]) return false;
    }
    return true;
  } catch (_) {
    return false;
  }
}

export function parseOrvixEnvelopeHeader(input) {
  const bytes = toUint8Array(input);
  if (bytes.length < FIXED_HEADER_BYTES) {
    throw new StorageEnvelopeError(
      'Malformed storage envelope: header shorter than 58 bytes.',
      'MALFORMED_ENVELOPE_HEADER'
    );
  }

  for (let i = 0; i < ORVIX_ENVELOPE_MAGIC.length; i++) {
    if (bytes[i] !== ORVIX_ENVELOPE_MAGIC[i]) {
      throw new StorageEnvelopeError(
        'Malformed storage envelope: invalid magic signature.',
        'INVALID_ENVELOPE_MAGIC'
      );
    }
  }

  const version = bytes[8];
  if (version !== ORVIX_ENVELOPE_VERSION) {
    throw new StorageEnvelopeError(
      `Unsupported storage envelope version: ${version}.`,
      'UNSUPPORTED_ENVELOPE_VERSION'
    );
  }

  const formatCode = bytes[9];
  const spec = SPEC_BY_CODE.get(formatCode);
  if (!spec) {
    throw new StorageEnvelopeError(
      `Unsupported envelope format code: ${formatCode}.`,
      'UNSUPPORTED_ENVELOPE_FORMAT'
    );
  }

  const codec = bytes[10];
  if (codec !== ORVIX_ENVELOPE_CODEC_GZIP) {
    throw new StorageEnvelopeError(
      `Unsupported storage envelope compression codec: ${codec}.`,
      'UNSUPPORTED_ENVELOPE_CODEC'
    );
  }

  const flags = bytes[11];
  if (flags !== 0) {
    throw new StorageEnvelopeError(
      `Unsupported storage envelope header flags: ${flags}.`,
      'INVALID_ENVELOPE_FLAGS'
    );
  }

  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sizeHi = dv.getUint32(12, false);
  const sizeLo = dv.getUint32(16, false);
  const originalSize = sizeHi * 0x100000000 + sizeLo;

  if (!Number.isSafeInteger(originalSize) || originalSize <= 0) {
    throw new StorageEnvelopeError(
      'Malformed storage envelope: original size must be positive.',
      'INVALID_ORIGINAL_SIZE'
    );
  }

  const expectedCrc32 = dv.getUint32(20, false);
  const expectedSha256Bytes = bytes.subarray(24, 56);
  const expectedSha256Hex = bytesToHex(expectedSha256Bytes);

  const mimeLen = dv.getUint16(56, false);
  if (mimeLen === 0 || mimeLen > 128 || bytes.length < FIXED_HEADER_BYTES + mimeLen + 18) {
    throw new StorageEnvelopeError(
      'Malformed storage envelope: invalid MIME length or truncated payload.',
      'MALFORMED_ENVELOPE_HEADER'
    );
  }

  const mimeBytes = bytes.subarray(FIXED_HEADER_BYTES, FIXED_HEADER_BYTES + mimeLen);
  const headerMime = decodeAscii(mimeBytes).trim().toLowerCase();
  if (headerMime !== spec.canonicalMime) {
    throw new StorageEnvelopeError(
      `Malformed storage envelope: format code ${formatCode} does not match MIME '${headerMime}'.`,
      'ENVELOPE_MIME_MISMATCH'
    );
  }

  const gzipOffset = FIXED_HEADER_BYTES + mimeLen;
  const gzipPayload = bytes.subarray(gzipOffset);
  if (gzipPayload.length < 18 || gzipPayload[0] !== 0x1f || gzipPayload[1] !== 0x8b) {
    throw new StorageEnvelopeError(
      'Malformed storage envelope: invalid gzip payload header.',
      'CORRUPTED_GZIP_PAYLOAD'
    );
  }

  return {
    encoding: ORVIX_ENVELOPE_ENCODING_ID,
    version,
    formatCode,
    spec,
    originalMimeType: spec.canonicalMime,
    originalSize,
    expectedCrc32,
    expectedSha256Bytes,
    expectedSha256Hex,
    gzipOffset,
    gzipPayload
  };
}

function yieldEventLoop() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function runStreamingGzipSync(rawBytes, signal) {
  const compressedChunks = [];
  let totalCompressed = 0;

  const gzip = new Gzip({ level: 6, mtime: 0 });
  gzip.ondata = (chunk) => {
    compressedChunks.push(new Uint8Array(chunk));
    totalCompressed += chunk.length;
  };

  for (let offset = 0; offset < rawBytes.length; offset += STREAM_ENCODE_CHUNK_BYTES) {
    if (signal?.aborted) {
      throw createAbortError('Storage compression cancelled.');
    }
    const end = Math.min(offset + STREAM_ENCODE_CHUNK_BYTES, rawBytes.length);
    const isFinal = end === rawBytes.length;
    gzip.push(rawBytes.subarray(offset, end), isFinal);
  }

  const out = new Uint8Array(totalCompressed);
  let pos = 0;
  for (const c of compressedChunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

async function runStreamingGzipAsync(rawBytes, signal) {
  const compressedChunks = [];
  let totalCompressed = 0;

  const gzip = new Gzip({ level: 6, mtime: 0 });
  gzip.ondata = (chunk) => {
    compressedChunks.push(new Uint8Array(chunk));
    totalCompressed += chunk.length;
  };

  for (let offset = 0; offset < rawBytes.length; offset += STREAM_ENCODE_CHUNK_BYTES) {
    if (signal?.aborted) {
      throw createAbortError('Storage compression cancelled.');
    }
    const end = Math.min(offset + STREAM_ENCODE_CHUNK_BYTES, rawBytes.length);
    const isFinal = end === rawBytes.length;
    gzip.push(rawBytes.subarray(offset, end), isFinal);
    if (!isFinal) {
      await yieldEventLoop();
    }
  }

  if (signal?.aborted) {
    throw createAbortError('Storage compression cancelled.');
  }

  const out = new Uint8Array(totalCompressed);
  let pos = 0;
  for (const c of compressedChunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

function buildEnvelopeBytes({ spec, originalSize, crc32, sha256Bytes, gzipBytes }) {
  const mimeBytes = encodeAscii(spec.canonicalMime);
  const totalBytes = FIXED_HEADER_BYTES + mimeBytes.length + gzipBytes.length;
  const envelope = new Uint8Array(totalBytes);
  const dv = new DataView(envelope.buffer);

  envelope.set(ORVIX_ENVELOPE_MAGIC, 0);
  envelope[8] = ORVIX_ENVELOPE_VERSION;
  envelope[9] = spec.code;
  envelope[10] = ORVIX_ENVELOPE_CODEC_GZIP;
  envelope[11] = 0; // reserved flags

  const sizeHi = Math.floor(originalSize / 0x100000000) >>> 0;
  const sizeLo = originalSize >>> 0;
  dv.setUint32(12, sizeHi, false);
  dv.setUint32(16, sizeLo, false);
  dv.setUint32(20, crc32 >>> 0, false);
  envelope.set(sha256Bytes, 24);
  dv.setUint16(56, mimeBytes.length, false);
  envelope.set(mimeBytes, FIXED_HEADER_BYTES);
  envelope.set(gzipBytes, FIXED_HEADER_BYTES + mimeBytes.length);

  return envelope;
}

/**
 * Decodes and strictly validates an Orvix storage envelope synchronously using bounded streaming gzip.
 * Rejects decompression bombs, truncated streams, trailing corrupt bytes, version/format/MIME mismatches,
 * size mismatches, CRC-32 mismatches, and SHA-256 mismatches.
 */
export function decodeOrvixStorageEnvelopeSync(input, options = {}) {
  const {
    maxOriginalBytes = DEFAULT_MAX_ORIGINAL_BYTES,
    expectedExtension = '',
    expectedMimeType = '',
    expectedOriginalSize = null,
    expectedChecksum = null
  } = options;

  const header = parseOrvixEnvelopeHeader(input);

  if (header.originalSize > maxOriginalBytes) {
    throw new StorageEnvelopeError(
      `Envelope declared original size (${header.originalSize} bytes) exceeds maximum allowed limit (${maxOriginalBytes} bytes).`,
      'DECOMPRESSION_BOMB_LIMIT_EXCEEDED'
    );
  }

  if (
    expectedOriginalSize !== null &&
    expectedOriginalSize !== undefined &&
    Number.isFinite(Number(expectedOriginalSize)) &&
    Number(expectedOriginalSize) !== header.originalSize
  ) {
    throw new StorageEnvelopeError(
      `Envelope original size mismatch: expected ${expectedOriginalSize}, got ${header.originalSize}.`,
      'ENVELOPE_SIZE_MISMATCH'
    );
  }

  if (expectedExtension) {
    const cleanDot = normalizeExtensionDot(expectedExtension);
    const expectedSpec = SPEC_BY_EXT.get(cleanDot);
    if (!expectedSpec || expectedSpec.code !== header.formatCode) {
      throw new StorageEnvelopeError(
        `Envelope format '${header.originalMimeType}' is not valid for extension '${cleanDot}'.`,
        'ENVELOPE_FORMAT_MISMATCH'
      );
    }
  }

  if (expectedMimeType) {
    const cleanMime = normalizeMime(expectedMimeType);
    if (
      cleanMime &&
      cleanMime !== 'application/octet-stream' &&
      cleanMime !== 'binary/octet-stream' &&
      !header.spec.acceptedMimes.includes(cleanMime)
    ) {
      throw new StorageEnvelopeError(
        `Envelope MIME '${header.originalMimeType}' does not match expected MIME '${cleanMime}'.`,
        'ENVELOPE_MIME_MISMATCH'
      );
    }
  }

  if (expectedChecksum && typeof expectedChecksum === 'string') {
    const normalizedExpected = expectedChecksum.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(normalizedExpected) || normalizedExpected !== header.expectedSha256Hex) {
      throw new StorageEnvelopeError(
        'Envelope checksum does not match declared integrity digest.',
        'ENVELOPE_CHECKSUM_MISMATCH'
      );
    }
  }

  const hardCap = Math.min(header.originalSize, maxOriginalBytes);
  const decompressedChunks = [];
  let totalOut = 0;
  let sawFinal = false;

  const gunzip = new Gunzip();
  gunzip.ondata = (chunk, final) => {
    if (totalOut + chunk.length > hardCap) {
      throw new StorageEnvelopeError(
        `Decompressed stream exceeded limit of ${hardCap} bytes.`,
        'DECOMPRESSION_BOMB_LIMIT_EXCEEDED'
      );
    }
    if (chunk.length > 0) {
      decompressedChunks.push(new Uint8Array(chunk));
      totalOut += chunk.length;
    }
    if (final) {
      sawFinal = true;
    }
  };

  const payload = header.gzipPayload;
  try {
    for (let offset = 0; offset < payload.length; offset += STREAM_DECODE_CHUNK_BYTES) {
      const end = Math.min(offset + STREAM_DECODE_CHUNK_BYTES, payload.length);
      const isFinal = end === payload.length;
      gunzip.push(payload.subarray(offset, end), isFinal);
    }
  } catch (err) {
    if (err instanceof StorageEnvelopeError) {
      throw err;
    }
    throw new StorageEnvelopeError(
      `Corrupted gzip payload inside storage envelope: ${err?.message || 'invalid stream'}`,
      'CORRUPTED_GZIP_PAYLOAD'
    );
  }

  if (!sawFinal) {
    throw new StorageEnvelopeError(
      'Corrupted storage envelope: gzip stream ended before final trailer.',
      'CORRUPTED_GZIP_PAYLOAD'
    );
  }

  if (totalOut !== header.originalSize) {
    throw new StorageEnvelopeError(
      `Decompressed byte count (${totalOut}) does not match declared original size (${header.originalSize}).`,
      'ENVELOPE_SIZE_MISMATCH'
    );
  }

  const decoded = new Uint8Array(totalOut);
  let pos = 0;
  for (const c of decompressedChunks) {
    decoded.set(c, pos);
    pos += c.length;
  }

  const actualCrc32 = computeCrc32(decoded);
  if (actualCrc32 !== header.expectedCrc32) {
    throw new StorageEnvelopeError(
      'Storage envelope integrity check failed: CRC-32 mismatch.',
      'ENVELOPE_CHECKSUM_MISMATCH'
    );
  }

  // Validate RFC 1952 gzip trailer CRC-32 and ISIZE (mod 2^32) as well, since fflate streaming Gunzip omits trailer verification
  const payloadView = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const trailerCrc32 = payloadView.getUint32(payload.length - 8, true) >>> 0;
  const trailerIsize = payloadView.getUint32(payload.length - 4, true) >>> 0;
  if (trailerCrc32 !== actualCrc32 || trailerIsize !== (totalOut >>> 0)) {
    throw new StorageEnvelopeError(
      'Corrupted gzip trailer inside storage envelope.',
      'CORRUPTED_GZIP_PAYLOAD'
    );
  }

  const actualSha256Hex = bytesToHex(computeSha256Sync(decoded));
  if (actualSha256Hex !== header.expectedSha256Hex) {
    throw new StorageEnvelopeError(
      'Storage envelope integrity check failed: SHA-256 mismatch.',
      'ENVELOPE_CHECKSUM_MISMATCH'
    );
  }

  return {
    data: decoded,
    encoding: ORVIX_ENVELOPE_ENCODING_ID,
    version: header.version,
    formatCode: header.formatCode,
    originalMimeType: header.originalMimeType,
    originalSize: header.originalSize,
    crc32: header.expectedCrc32,
    sha256: header.expectedSha256Hex,
    storedSize: toUint8Array(input).length
  };
}

export async function decodeOrvixStorageEnvelope(input, options = {}) {
  return decodeOrvixStorageEnvelopeSync(input, options);
}

/**
 * Encodes a raw buffer into an Orvix storage envelope if and only if
 * total encoded bytes decrease by >= 10% compared to original size.
 */
export async function encodeOrvixStorageEnvelope(input, metadata = {}, options = {}) {
  const rawBytes = toUint8Array(input);
  const { signal, maxOriginalBytes = DEFAULT_MAX_ORIGINAL_BYTES } = options;
  const originalSize = rawBytes.length;

  const { spec, dotExt, mimeMismatch } = resolveTargetSpec(
    metadata.mimeType || metadata.type || '',
    metadata.extension || '',
    metadata.fileName || metadata.name || ''
  );

  if (!spec || mimeMismatch) {
    return {
      compressed: false,
      encoding: null,
      envelopeBytes: null,
      originalSize,
      encodedSize: originalSize,
      originalMimeType: metadata.mimeType || null,
      reason: 'unsupported_format'
    };
  }

  if (originalSize === 0 || originalSize > maxOriginalBytes) {
    return {
      compressed: false,
      encoding: null,
      envelopeBytes: null,
      originalSize,
      encodedSize: originalSize,
      originalMimeType: spec.canonicalMime,
      reason: originalSize === 0 ? 'empty_file' : 'exceeds_max_size'
    };
  }

  if (originalSize < MIN_COMPRESS_INPUT_BYTES) {
    return {
      compressed: false,
      encoding: null,
      envelopeBytes: null,
      originalSize,
      encodedSize: originalSize,
      originalMimeType: spec.canonicalMime,
      reason: 'too_small'
    };
  }

  if (signal?.aborted) {
    throw createAbortError('Storage compression cancelled.');
  }

  const crc32 = computeCrc32(rawBytes);
  const sha256Bytes = await computeSha256(rawBytes);
  const sha256Hex = bytesToHex(sha256Bytes);
  const gzipBytes = await runStreamingGzipAsync(rawBytes, signal);
  const envelopeBytes = buildEnvelopeBytes({
    spec,
    originalSize,
    crc32,
    sha256Bytes,
    gzipBytes
  });

  if (signal?.aborted) {
    throw createAbortError('Storage compression cancelled.');
  }

  const encodedSize = envelopeBytes.length;
  const savingsBytes = originalSize - encodedSize;
  const meetsMinimumSavings = savingsBytes > 0 && savingsBytes * 10 >= originalSize;

  if (!meetsMinimumSavings) {
    return {
      compressed: false,
      encoding: null,
      envelopeBytes: null,
      originalSize,
      encodedSize: originalSize,
      originalMimeType: spec.canonicalMime,
      extension: dotExt.replace(/^\.+/, '').toUpperCase(),
      savingsBytes: 0,
      savingsRatio: 0,
      reason: 'insufficient_savings'
    };
  }

  // Round-trip self-verification before accepting envelope
  const verified = decodeOrvixStorageEnvelopeSync(envelopeBytes, {
    maxOriginalBytes,
    expectedExtension: dotExt,
    expectedOriginalSize: originalSize,
    expectedChecksum: sha256Hex
  });

  if (verified.originalSize !== originalSize || verified.sha256 !== sha256Hex) {
    return {
      compressed: false,
      encoding: null,
      envelopeBytes: null,
      originalSize,
      encodedSize: originalSize,
      originalMimeType: spec.canonicalMime,
      reason: 'verification_failed'
    };
  }

  return {
    compressed: true,
    encoding: ORVIX_ENVELOPE_ENCODING_ID,
    envelopeBytes,
    originalSize,
    encodedSize,
    originalMimeType: spec.canonicalMime,
    extension: dotExt.replace(/^\.+/, '').toUpperCase(),
    crc32,
    sha256: sha256Hex,
    savingsBytes,
    savingsRatio: Number((savingsBytes / originalSize).toFixed(4)),
    reason: 'compressed'
  };
}

/**
 * Synchronous variant useful for deterministic server/unit tests.
 */
export function encodeOrvixStorageEnvelopeSync(input, metadata = {}, options = {}) {
  const rawBytes = toUint8Array(input);
  const { maxOriginalBytes = DEFAULT_MAX_ORIGINAL_BYTES } = options;
  const originalSize = rawBytes.length;

  const { spec, dotExt, mimeMismatch } = resolveTargetSpec(
    metadata.mimeType || metadata.type || '',
    metadata.extension || '',
    metadata.fileName || metadata.name || ''
  );

  if (!spec || mimeMismatch || originalSize < MIN_COMPRESS_INPUT_BYTES || originalSize > maxOriginalBytes) {
    return {
      compressed: false,
      encoding: null,
      envelopeBytes: null,
      originalSize,
      encodedSize: originalSize,
      originalMimeType: spec?.canonicalMime || metadata.mimeType || null,
      reason: !spec || mimeMismatch ? 'unsupported_format' : originalSize > maxOriginalBytes ? 'exceeds_max_size' : 'too_small'
    };
  }

  const crc32 = computeCrc32(rawBytes);
  const sha256Bytes = computeSha256Sync(rawBytes);
  const sha256Hex = bytesToHex(sha256Bytes);
  const gzipBytes = runStreamingGzipSync(rawBytes, null);
  const envelopeBytes = buildEnvelopeBytes({
    spec,
    originalSize,
    crc32,
    sha256Bytes,
    gzipBytes
  });

  const encodedSize = envelopeBytes.length;
  const savingsBytes = originalSize - encodedSize;
  if (savingsBytes <= 0 || savingsBytes * 10 < originalSize) {
    return {
      compressed: false,
      encoding: null,
      envelopeBytes: null,
      originalSize,
      encodedSize: originalSize,
      originalMimeType: spec.canonicalMime,
      extension: dotExt.replace(/^\.+/, '').toUpperCase(),
      savingsBytes: 0,
      savingsRatio: 0,
      reason: 'insufficient_savings'
    };
  }

  return {
    compressed: true,
    encoding: ORVIX_ENVELOPE_ENCODING_ID,
    envelopeBytes,
    originalSize,
    encodedSize,
    originalMimeType: spec.canonicalMime,
    extension: dotExt.replace(/^\.+/, '').toUpperCase(),
    crc32,
    sha256: sha256Hex,
    savingsBytes,
    savingsRatio: Number((savingsBytes / originalSize).toFixed(4)),
    reason: 'compressed'
  };
}

/**
 * Compresses an eligible browser File/Blob into a separate transport envelope File
 * while ALWAYS preserving the original File untouched.
 */
export async function compressFileForTransparentStorage(file, options = {}) {
  const { signal, maxOriginalBytes = DEFAULT_MAX_ORIGINAL_BYTES } = options;

  if (!file || typeof file.arrayBuffer !== 'function') {
    return {
      compressed: false,
      encoding: null,
      encodedFile: null,
      originalFile: file || null,
      originalSize: file?.size || 0,
      encodedSize: file?.size || 0,
      originalMimeType: file?.type || null,
      reason: 'invalid_input'
    };
  }

  if (signal?.aborted) {
    throw createAbortError('Storage compression cancelled.');
  }

  const { spec, dotExt, mimeMismatch } = resolveTargetSpec(
    file.type || '',
    options.extension || '',
    file.name || ''
  );

  if (!spec || mimeMismatch) {
    return {
      compressed: false,
      encoding: null,
      encodedFile: null,
      originalFile: file,
      originalSize: file.size || 0,
      encodedSize: file.size || 0,
      originalMimeType: file.type || null,
      reason: 'unsupported_format'
    };
  }

  const originalSize = typeof file.size === 'number' ? file.size : 0;
  if (originalSize < MIN_COMPRESS_INPUT_BYTES) {
    return {
      compressed: false,
      encoding: null,
      encodedFile: null,
      originalFile: file,
      originalSize,
      encodedSize: originalSize,
      originalMimeType: spec.canonicalMime,
      extension: dotExt.replace(/^\.+/, '').toUpperCase(),
      savingsBytes: 0,
      savingsRatio: 0,
      reason: 'too_small'
    };
  }

  if (originalSize > maxOriginalBytes) {
    return {
      compressed: false,
      encoding: null,
      encodedFile: null,
      originalFile: file,
      originalSize,
      encodedSize: originalSize,
      originalMimeType: spec.canonicalMime,
      extension: dotExt.replace(/^\.+/, '').toUpperCase(),
      savingsBytes: 0,
      savingsRatio: 0,
      reason: 'exceeds_max_size'
    };
  }

  const arrayBuffer = await file.arrayBuffer();
  if (signal?.aborted) {
    throw createAbortError('Storage compression cancelled.');
  }

  const bytes = new Uint8Array(arrayBuffer);
  // If someone accidentally passed an already-encoded envelope File, never double-wrap it
  if (isOrvixStorageEnvelope(bytes)) {
    return {
      compressed: false,
      encoding: null,
      encodedFile: null,
      originalFile: file,
      originalSize: bytes.length,
      encodedSize: bytes.length,
      originalMimeType: spec.canonicalMime,
      extension: dotExt.replace(/^\.+/, '').toUpperCase(),
      savingsBytes: 0,
      savingsRatio: 0,
      reason: 'already_enveloped'
    };
  }

  const result = await encodeOrvixStorageEnvelope(
    bytes,
    {
      mimeType: file.type || spec.canonicalMime,
      extension: dotExt,
      fileName: file.name || ''
    },
    { signal, maxOriginalBytes }
  );

  if (!result.compressed || !result.envelopeBytes) {
    return {
      compressed: false,
      encoding: null,
      encodedFile: null,
      originalFile: file,
      originalSize,
      encodedSize: originalSize,
      originalMimeType: spec.canonicalMime,
      extension: dotExt.replace(/^\.+/, '').toUpperCase(),
      savingsBytes: 0,
      savingsRatio: 0,
      reason: result.reason
    };
  }

  let encodedFile = null;
  const targetName = file.name || `attachment${dotExt}`;
  if (typeof File === 'function') {
    encodedFile = new File([result.envelopeBytes], targetName, {
      type: 'application/octet-stream',
      lastModified: typeof file.lastModified === 'number' ? file.lastModified : Date.now()
    });
  } else {
    encodedFile = new Blob([result.envelopeBytes], { type: 'application/octet-stream' });
  }

  return {
    compressed: true,
    encoding: result.encoding,
    encodedFile,
    originalFile: file,
    originalSize: result.originalSize,
    encodedSize: result.encodedSize,
    originalMimeType: result.originalMimeType,
    extension: result.extension,
    crc32: result.crc32,
    sha256: result.sha256,
    savingsBytes: result.savingsBytes,
    savingsRatio: result.savingsRatio,
    reason: 'compressed'
  };
}
