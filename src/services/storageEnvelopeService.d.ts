export const ORVIX_ENVELOPE_ENCODING_ID: string;
export const ORVIX_ENVELOPE_VERSION: number;
export const ORVIX_ENVELOPE_CODEC_GZIP: number;
export const DEFAULT_MAX_ORIGINAL_BYTES: number;
export const MIN_SAVINGS_RATIO: number;
export const MIN_COMPRESS_INPUT_BYTES: number;
export const TRANSPARENT_COMPRESSION_EXTENSIONS: string[];

export class StorageEnvelopeError extends Error {
  code: string;
  details: Record<string, any>;
  constructor(message: string, code?: string, details?: Record<string, any>);
}

export interface StorageEnvelopeHeader {
  encoding: string;
  version: number;
  formatCode: number;
  spec: {
    code: number;
    extensions: string[];
    canonicalMime: string;
    acceptedMimes: string[];
  };
  originalMimeType: string;
  originalSize: number;
  expectedCrc32: number;
  expectedSha256Bytes: Uint8Array;
  expectedSha256Hex: string;
  gzipOffset: number;
  gzipPayload: Uint8Array;
}

export interface DecodedStorageEnvelope {
  data: Uint8Array;
  encoding: string;
  version: number;
  formatCode: number;
  originalMimeType: string;
  originalSize: number;
  crc32: number;
  sha256: string;
  storedSize: number;
}

export interface EncodedStorageEnvelopeResult {
  compressed: boolean;
  encoding: string | null;
  envelopeBytes: Uint8Array | null;
  originalSize: number;
  encodedSize: number;
  originalMimeType: string | null;
  extension?: string;
  crc32?: number;
  sha256?: string;
  savingsBytes?: number;
  savingsRatio?: number;
  reason: string;
}

export function computeCrc32(bytes: Uint8Array): number;
export function computeSha256Sync(data: Uint8Array): Uint8Array;
export function computeSha256(bytes: Uint8Array): Promise<Uint8Array>;
export function bytesToHex(bytes: Uint8Array): string;

export function isTransparentStorageCompressionSupported(
  fileOrDescriptor:
    | string
    | { mimeType?: string; type?: string; extension?: string; name?: string; originalName?: string }
    | null
    | undefined
): boolean;

export function getCanonicalMimeForExtension(extension?: string): string | null;
export function isOrvixStorageEnvelope(input: Uint8Array | ArrayBuffer | ArrayBufferView | null | undefined): boolean;
export function parseOrvixEnvelopeHeader(input: Uint8Array | ArrayBuffer | ArrayBufferView): StorageEnvelopeHeader;

export function decodeOrvixStorageEnvelopeSync(
  input: Uint8Array | ArrayBuffer | ArrayBufferView,
  options?: {
    maxOriginalBytes?: number;
    expectedExtension?: string;
    expectedMimeType?: string;
    expectedOriginalSize?: number | null;
    expectedChecksum?: string | null;
  }
): DecodedStorageEnvelope;

export function decodeOrvixStorageEnvelope(
  input: Uint8Array | ArrayBuffer | ArrayBufferView,
  options?: {
    maxOriginalBytes?: number;
    expectedExtension?: string;
    expectedMimeType?: string;
    expectedOriginalSize?: number | null;
    expectedChecksum?: string | null;
  }
): Promise<DecodedStorageEnvelope>;

export function encodeOrvixStorageEnvelope(
  input: Uint8Array | ArrayBuffer | ArrayBufferView,
  metadata?: { mimeType?: string; type?: string; extension?: string; fileName?: string; name?: string },
  options?: { signal?: AbortSignal; maxOriginalBytes?: number }
): Promise<EncodedStorageEnvelopeResult>;

export function encodeOrvixStorageEnvelopeSync(
  input: Uint8Array | ArrayBuffer | ArrayBufferView,
  metadata?: { mimeType?: string; type?: string; extension?: string; fileName?: string; name?: string },
  options?: { maxOriginalBytes?: number }
): EncodedStorageEnvelopeResult;

export function compressFileForTransparentStorage(
  file: File | Blob,
  options?: { signal?: AbortSignal; maxOriginalBytes?: number; extension?: string }
): Promise<{
  compressed: boolean;
  encoding: string | null;
  encodedFile: File | Blob | null;
  originalFile: File | Blob | null;
  originalSize: number;
  encodedSize: number;
  originalMimeType: string | null;
  extension?: string;
  crc32?: number;
  sha256?: string;
  savingsBytes?: number;
  savingsRatio?: number;
  reason: string;
}>;
