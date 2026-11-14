import type express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import multer from 'multer';

import {
  getGeminiApiKey,
  isServerless,
  isSignedDecodeProductionMode,
  resolveConfiguredSignedDecodeUrlSecret,
  setForceProductionSignedUrlSecretCheckForTesting
} from './serverConfig.ts';
import { logUploadDiagnostic, sanitizeErrorLog } from './diagnosticLogger.ts';
import type { UploadedFileRecord, DocumentExtractionResult } from './serverTypes.ts';
// @ts-ignore - Document extraction JavaScript service
import { extractDocumentContent } from '../src/services/documentExtractor.js';
// @ts-ignore - Image OCR extraction JavaScript service
import { extractImageText } from '../src/services/imageOcrService.js';
// @ts-ignore - Shared attachment payload validation and vision image-part builder
import {
  buildVisionImageParts,
  MAX_VISION_IMAGE_BYTES,
  MAX_CHAT_REQUEST_BYTES
} from '../src/services/attachmentStorageService.js';
// @ts-ignore - Self-describing transparent storage envelope codec
import {
  ORVIX_ENVELOPE_ENCODING_ID,
  StorageEnvelopeError,
  decodeOrvixStorageEnvelopeSync,
  getCanonicalMimeForExtension,
  isOrvixStorageEnvelope,
  isTransparentStorageCompressionSupported
} from '../src/services/storageEnvelopeService.js';
import {
  uploadAttachmentToStorage,
  downloadAttachmentFromStorage,
  createAttachmentSignedUrl,
  createSignedUploadUrlForAttachment,
  deleteAttachmentFromStorage,
  deleteAttachmentsForChatInStorage,
  findAttachmentPathInStorage,
  buildAttachmentStoragePath,
  parseStoragePath,
  assertUserOwnsStoragePath,
  saveDurableAttachmentExpiry,
  checkDurableAttachmentExpiry,
  isValidPathSegment
} from './supabaseStorageService.ts';
import { isSupabaseConfigured, getSupabaseBucket } from './supabaseClient.ts';
import {
  verifyFirebaseIdToken,
  resolveVerifiedUserId,
  authenticateRequest,
  getConfiguredFirebaseProjectId
} from './firebaseAuthHelper.ts';
import {
  DAILY_UPLOAD_LIMIT,
  buildAuthenticatedQuotaIdentity,
  resolveAuthenticatedUploadIdentity,
  resolveUploadIdentity,
  reserveUploadSlot,
  commitUploadSlot,
  releaseUploadSlot,
  attachQuotaHeaders,
  getQuotaStatus,
  getPktDayString,
  getNextPktMidnight,
  getUtcDayString,
  type QuotaIdentity,
  type QuotaReservation,
  type QuotaStatus
} from './uploadQuotaService.ts';

export {
  verifyFirebaseIdToken,
  resolveVerifiedUserId,
  authenticateRequest,
  DAILY_UPLOAD_LIMIT,
  buildAuthenticatedQuotaIdentity,
  resolveAuthenticatedUploadIdentity,
  resolveUploadIdentity,
  reserveUploadSlot,
  commitUploadSlot,
  releaseUploadSlot,
  attachQuotaHeaders,
  getQuotaStatus,
  getPktDayString,
  getNextPktMidnight,
  getUtcDayString,
  setForceProductionSignedUrlSecretCheckForTesting
};

export type {
  QuotaIdentity,
  QuotaReservation,
  QuotaStatus
};

/**
 * Resolves the authenticated user ID exclusively from verified Firebase identity.
 *
 * Security Requirements Enforced:
 * 1. Never authorizes users by merely decoding Firebase JWT payloads.
 * 2. Derives userId exclusively from verified cryptographic Firebase identity.
 * 3. Never trusts req.body.userId or x-user-id for authorization.
 * 4. Returns null for guests or invalid/unverified requests.
 */
export async function resolveRequestUserId(req: express.Request): Promise<string | null> {
  return resolveVerifiedUserId(req);
}

/**
 * Enforces mandatory Firebase authentication for attachment upload endpoints.
 * Rejects unauthenticated, missing, expired, malformed, or forged tokens with
 * HTTP 401 and a consistent UNAUTHENTICATED error code.
 * Never trusts client-provided user IDs, guest tokens, cookies, or identity headers,
 * and never falls back to guest identity.
 */
async function requireUploadAuthentication(
  req: express.Request,
  res: express.Response,
  defaultMessage = 'Authentication is required to upload attachments. Please sign in to continue.'
): Promise<string | null> {
  const authStatus = await authenticateRequest(req);
  if (authStatus.status !== 'authenticated' || !authStatus.userId) {
    if (authStatus.status === 'invalid') {
      logUploadDiagnostic({
        stage: 'firebase_auth',
        code: authStatus.code || 'INVALID_TOKEN',
        message: authStatus.error || defaultMessage,
        details: {
          path: req.path,
          hasConfiguredProjectId: Boolean(getConfiguredFirebaseProjectId()),
          envPresence: {
            FIREBASE_PROJECT_ID: Boolean(process.env.FIREBASE_PROJECT_ID?.trim()),
            VITE_FIREBASE_PROJECT_ID: Boolean(process.env.VITE_FIREBASE_PROJECT_ID?.trim()),
            NEXT_PUBLIC_FIREBASE_PROJECT_ID: Boolean(process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID?.trim()),
            FIREBASE_SERVICE_ACCOUNT: Boolean(process.env.FIREBASE_SERVICE_ACCOUNT?.trim()),
            FIREBASE_SERVICE_ACCOUNT_KEY: Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_KEY?.trim())
          }
        }
      });
    }
    const errorMessage =
      authStatus.status === 'invalid' && authStatus.error
        ? `Authentication failed: ${authStatus.error}`
        : defaultMessage;
    res.status(401).json({
      error: errorMessage,
      code: 'UNAUTHENTICATED',
      status: 'UNAUTHENTICATED',
      ...(authStatus.status === 'invalid' && authStatus.code
        ? { authErrorCode: authStatus.code }
        : {})
    });
    return null;
  }
  return authStatus.userId;
}

const __filename =
  typeof import.meta !== 'undefined' && import.meta.url
    ? fileURLToPath(import.meta.url)
    : path.resolve(process.cwd(), 'server', 'uploadSubsystem.ts');
const __dirname = path.dirname(__filename);

/**
 * Resolves the upload directory according to runtime environment:
 * - Vercel / AWS Lambda (serverless): Uses os.tmpdir() (/tmp), the only writable filesystem location.
 * - Localhost development: Preserves project-local uploads/temp directory.
 * - Graceful fallback: If local directory is un-writable or throws EROFS, falls back to os.tmpdir().
 */
export function resolveUploadDirectory(): string {
  // 1. Explicit override via environment variable
  if (process.env.UPLOAD_DIR) {
    try {
      const resolved = path.resolve(process.env.UPLOAD_DIR);
      if (!fs.existsSync(resolved)) {
        fs.mkdirSync(resolved, { recursive: true });
      }
      return resolved;
    } catch (err) {
      console.warn('[Storage] Configured UPLOAD_DIR is not writable, falling back to temp:', err);
    }
  }

  // 2. Serverless / Vercel cloud environment:
  // Root /var/task is strictly read-only; os.tmpdir() (/tmp) is the allocated writable directory.
  if (isServerless) {
    const serverlessTmp = path.join(os.tmpdir(), 'orvix_uploads');
    try {
      if (!fs.existsSync(serverlessTmp)) {
        fs.mkdirSync(serverlessTmp, { recursive: true });
      }
      return serverlessTmp;
    } catch (err) {
      console.warn('[Storage] Error ensuring serverless tmp dir, falling back to os.tmpdir():', err);
      return os.tmpdir();
    }
  }

  // 3. Localhost development environment:
  // Default to project-local uploads/temp directory
  try {
    const localDir = path.resolve(__dirname, '..', 'uploads', 'temp');
    if (!localDir.startsWith('/var/task') && !fs.existsSync(localDir)) {
      fs.mkdirSync(localDir, { recursive: true });
    }
    return localDir;
  } catch (err: any) {
    // Defensive fallback: if local directory throws EROFS or EACCES, seamlessly fall back to os.tmpdir()
    const fallbackTmp = path.join(os.tmpdir(), 'orvix_uploads');
    try {
      if (!fs.existsSync(fallbackTmp)) {
        fs.mkdirSync(fallbackTmp, { recursive: true });
      }
      return fallbackTmp;
    } catch (_) {
      return os.tmpdir();
    }
  }
}

export const UPLOAD_DIR = resolveUploadDirectory();

// Configurable upload constraints and lifecycle bounds
export const MAX_FILE_SIZE_BYTES =
  parseInt(process.env.MAX_FILE_SIZE_BYTES || '', 10) || 25 * 1024 * 1024; // 25 MB default
export const MAX_ATTACHMENTS_PER_UPLOAD = 1; // Strictly 1 attachment per user message
export const TEMP_FILE_TTL_MS =
  parseInt(process.env.TEMP_FILE_TTL_MS || '', 10) || 2 * 60 * 60 * 1000; // 2 hours retention TTL

export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const size = (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1);
  return `${size} ${units[i]}`;
}

// Strict whitelist of permitted file extensions and their corresponding MIME types
export const ALLOWED_EXTENSIONS_MAP: Record<string, string[]> = {
  '.pdf': ['application/pdf'],
  '.docx': [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/zip',
    'application/octet-stream'
  ],
  '.doc': ['application/msword', 'application/octet-stream'],
  '.pptx': [
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/zip',
    'application/octet-stream'
  ],
  '.ppt': ['application/vnd.ms-powerpoint', 'application/octet-stream'],
  '.xlsx': [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/zip',
    'application/octet-stream'
  ],
  '.xls': ['application/vnd.ms-excel', 'application/octet-stream'],
  '.txt': ['text/plain', 'application/octet-stream'],
  '.log': ['text/plain', 'text/x-log', 'application/octet-stream'],
  '.md': ['text/markdown', 'text/plain', 'text/x-markdown', 'application/octet-stream'],
  '.markdown': ['text/markdown', 'text/plain', 'application/octet-stream'],
  '.csv': ['text/csv', 'text/plain', 'application/csv', 'application/vnd.ms-excel', 'application/octet-stream'],
  '.tsv': ['text/tab-separated-values', 'text/plain', 'application/octet-stream'],
  '.json': ['application/json', 'text/json', 'text/plain', 'application/octet-stream'],
  '.xml': ['application/xml', 'text/xml', 'text/plain', 'application/octet-stream'],
  // Common image formats (JPG, JPEG, PNG, WEBP, GIF, BMP, HEIC, HEIF)
  '.jpg': ['image/jpeg', 'image/pjpeg', 'image/jpg', 'application/octet-stream'],
  '.jpeg': ['image/jpeg', 'image/pjpeg', 'image/jpg', 'application/octet-stream'],
  '.png': ['image/png', 'image/x-png', 'application/octet-stream'],
  '.webp': ['image/webp', 'application/octet-stream'],
  '.gif': ['image/gif', 'application/octet-stream'],
  '.bmp': ['image/bmp', 'image/x-ms-bmp', 'image/x-bmp', 'application/octet-stream'],
  '.heic': ['image/heic', 'image/heif', 'application/octet-stream'],
  '.heif': ['image/heif', 'image/heic', 'application/octet-stream']
};

/**
 * Safely extracts image dimensions (width, height) from image binary headers
 * without requiring native binary dependencies.
 */
export function parseImageDimensions(
  buffer: Buffer,
  ext: string
): { width: number; height: number } | undefined {
  try {
    if (ext === '.png' && buffer.length >= 24) {
      const width = buffer.readUInt32BE(16);
      const height = buffer.readUInt32BE(20);
      if (width > 0 && height > 0) return { width, height };
    }
    if (ext === '.gif' && buffer.length >= 10) {
      const width = buffer.readUInt16LE(6);
      const height = buffer.readUInt16LE(8);
      if (width > 0 && height > 0) return { width, height };
    }
    if (ext === '.bmp' && buffer.length >= 26) {
      const width = Math.abs(buffer.readInt32LE(18));
      const height = Math.abs(buffer.readInt32LE(22));
      if (width > 0 && height > 0) return { width, height };
    }
    if (ext === '.webp' && buffer.length >= 30) {
      const tag = buffer.toString('ascii', 12, 16);
      if (tag === 'VP8 ' && buffer.length >= 30) {
        const width = buffer.readUInt16LE(26) & 0x3fff;
        const height = buffer.readUInt16LE(28) & 0x3fff;
        if (width > 0 && height > 0) return { width, height };
      } else if (tag === 'VP8L' && buffer.length >= 25) {
        const b1 = buffer[21];
        const b2 = buffer[22];
        const b3 = buffer[23];
        const b4 = buffer[24];
        const width = 1 + (((b2 & 0x3f) << 8) | b1);
        const height = 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6));
        if (width > 0 && height > 0) return { width, height };
      } else if (tag === 'VP8X' && buffer.length >= 30) {
        const width = 1 + buffer.readUIntLE(24, 3);
        const height = 1 + buffer.readUIntLE(27, 3);
        if (width > 0 && height > 0) return { width, height };
      }
    }
    if ((ext === '.jpg' || ext === '.jpeg') && buffer.length >= 4) {
      let offset = 2;
      while (offset < buffer.length - 8) {
        if (buffer[offset] !== 0xff) break;
        const marker = buffer[offset + 1];
        if (
          (marker >= 0xc0 && marker <= 0xc3) ||
          (marker >= 0xc5 && marker <= 0xc7) ||
          (marker >= 0xc9 && marker <= 0xcb) ||
          (marker >= 0xcd && marker <= 0xcf)
        ) {
          const height = buffer.readUInt16BE(offset + 5);
          const width = buffer.readUInt16BE(offset + 7);
          if (width > 0 && height > 0) return { width, height };
          break;
        }
        const blockLength = buffer.readUInt16BE(offset + 2);
        offset += 2 + blockLength;
      }
    }
  } catch (_) {}
  return undefined;
}

/**
 * Validates binary file headers and content signatures (magic numbers)
 * to prevent executable binaries or corrupted files from being accepted under false extensions.
 * Supports both direct in-memory Buffers and disk file paths.
 */
export async function verifyFileSignature(
  filePathOrBuffer: string | Buffer,
  ext: string
): Promise<{ valid: boolean; reason?: string; dimensions?: { width: number; height: number } }> {
  let fd: number | null = null;
  try {
    let buffer: Buffer;
    let size = 0;

    if (Buffer.isBuffer(filePathOrBuffer)) {
      buffer = filePathOrBuffer;
      size = buffer.length;
    } else {
      const stats = await fs.promises.stat(filePathOrBuffer);
      size = stats.size;
      const readBuf = Buffer.alloc(Math.min(4096, size));
      fd = fs.openSync(filePathOrBuffer, 'r');
      fs.readSync(fd, readBuf, 0, readBuf.length, 0);
      fs.closeSync(fd);
      fd = null;
      buffer = readBuf;
    }

    if (size === 0) {
      return { valid: false, reason: 'File is empty (0 bytes).' };
    }

    // Reject executable binary formats regardless of declared extension
    // Linux ELF binary
    if (
      buffer.length >= 4 &&
      buffer[0] === 0x7f &&
      buffer[1] === 0x45 &&
      buffer[2] === 0x4c &&
      buffer[3] === 0x46
    ) {
      return { valid: false, reason: 'Binary executable format (ELF) is not permitted.' };
    }
    // Windows PE / MZ executable
    if (buffer.length >= 2 && buffer[0] === 0x4d && buffer[1] === 0x5a) {
      return { valid: false, reason: 'Binary executable format (Windows PE) is not permitted.' };
    }
    // Mach-O binary
    if (
      buffer.length >= 4 &&
      ((buffer[0] === 0xfe && buffer[1] === 0xed && buffer[2] === 0xfa && (buffer[3] === 0xce || buffer[3] === 0xcf)) ||
       (buffer[0] === 0xcf && buffer[1] === 0xfa && buffer[2] === 0xed && buffer[3] === 0xfe))
    ) {
      return { valid: false, reason: 'Binary executable format (Mach-O) is not permitted.' };
    }

    // Format-specific verification
    if (ext === '.pdf') {
      const header = buffer.toString('utf-8', 0, Math.min(10, buffer.length));
      if (!header.startsWith('%PDF-')) {
        return { valid: false, reason: 'Invalid PDF format: missing standard %PDF- header signature.' };
      }
      return { valid: true };
    }

    if (ext === '.docx' || ext === '.pptx' || ext === '.xlsx') {
      if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b) {
        return { valid: true };
      }
      return {
        valid: false,
        reason: `Invalid ${ext.toUpperCase().slice(1)} format: missing standard OpenXML zip container signature.`
      };
    }

    if (ext === '.doc' || ext === '.ppt' || ext === '.xls') {
      if (
        buffer.length >= 8 &&
        buffer[0] === 0xd0 &&
        buffer[1] === 0xcf &&
        buffer[2] === 0x11 &&
        buffer[3] === 0xe0 &&
        buffer[4] === 0xa1 &&
        buffer[5] === 0xb1 &&
        buffer[6] === 0x1a &&
        buffer[7] === 0xe1
      ) {
        return { valid: true };
      }
      if (
        ext === '.xls' &&
        buffer.length >= 8 &&
        buffer[0] === 0x09 &&
        (buffer[1] === 0x00 || buffer[1] === 0x02 || buffer[1] === 0x04 || buffer[1] === 0x08)
      ) {
        return { valid: true };
      }
      return { valid: false, reason: 'Invalid legacy Office document: missing OLE compound binary signature.' };
    }

    // Text formats: disallow null bytes \0 to prevent disguised binary files
    if (['.txt', '.log', '.md', '.markdown', '.csv', '.tsv', '.json', '.xml'].includes(ext)) {
      for (let i = 0; i < buffer.length; i++) {
        if (buffer[i] === 0x00) {
          return { valid: false, reason: 'Text file contains unexpected null binary bytes.' };
        }
      }
      if (ext === '.json') {
        const str = buffer.toString('utf-8').trim();
        if (
          str &&
          !str.startsWith('{') &&
          !str.startsWith('[') &&
          !str.startsWith('"') &&
          !str.startsWith('true') &&
          !str.startsWith('false') &&
          !str.startsWith('null') &&
          isNaN(Number(str[0]))
        ) {
          return { valid: false, reason: 'Invalid JSON format: file does not begin with valid JSON syntax.' };
        }
      }
      return { valid: true };
    }

    // Image format verification (JPEG, PNG, GIF, WebP, BMP, HEIC/HEIF)
    if (ext === '.jpg' || ext === '.jpeg') {
      if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
        return { valid: true, dimensions: parseImageDimensions(buffer, ext) };
      }
      return { valid: false, reason: 'Invalid JPEG format: missing standard JPEG SOI signature.' };
    }

    if (ext === '.png') {
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
        return { valid: true, dimensions: parseImageDimensions(buffer, ext) };
      }
      return { valid: false, reason: 'Invalid PNG format: missing standard PNG signature.' };
    }

    if (ext === '.gif') {
      if (
        buffer.length >= 6 &&
        buffer[0] === 0x47 &&
        buffer[1] === 0x49 &&
        buffer[2] === 0x46 &&
        buffer[3] === 0x38 &&
        (buffer[4] === 0x37 || buffer[4] === 0x39) &&
        buffer[5] === 0x61
      ) {
        return { valid: true, dimensions: parseImageDimensions(buffer, ext) };
      }
      return { valid: false, reason: 'Invalid GIF format: missing standard GIF87a/GIF89a signature.' };
    }

    if (ext === '.webp') {
      if (
        buffer.length >= 12 &&
        buffer.toString('ascii', 0, 4) === 'RIFF' &&
        buffer.toString('ascii', 8, 12) === 'WEBP'
      ) {
        return { valid: true, dimensions: parseImageDimensions(buffer, ext) };
      }
      return { valid: false, reason: 'Invalid WebP format: missing standard RIFF/WEBP signature.' };
    }

    if (ext === '.bmp') {
      if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) {
        return { valid: true, dimensions: parseImageDimensions(buffer, ext) };
      }
      return { valid: false, reason: 'Invalid BMP format: missing standard BM signature.' };
    }

    if (ext === '.heic' || ext === '.heif') {
      if (buffer.length < 12) {
        return { valid: false, reason: 'Invalid HEIC/HEIF format: file is too small for an ISOBMFF container.' };
      }
      const ftypBox = buffer.toString('ascii', 4, 8);
      if (ftypBox !== 'ftyp') {
        return { valid: false, reason: 'Invalid HEIC/HEIF format: missing standard ftyp container signature.' };
      }
      const compatibleSlice = buffer.toString('ascii', 8, Math.min(64, buffer.length)).toLowerCase();
      const validBrands = ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'];
      const hasValidBrand = validBrands.some((b) => compatibleSlice.includes(b));
      if (!hasValidBrand) {
        return { valid: false, reason: 'Invalid HEIC/HEIF format: unrecognized ISOBMFF image brand.' };
      }
      return { valid: true };
    }

    return { valid: true };
  } catch (err: any) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (_) {}
    }
    return { valid: false, reason: `File inspection failed: ${err?.message || 'unknown error'}` };
  }
}

// Multer in-memory storage engine: eliminates ephemeral disk write failures on Vercel
const uploadStorage = multer.memoryStorage();

// Multer pre-upload file filter
const uploadFilter = (
  _req: express.Request,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback
) => {
  const originalName = file.originalname || '';
  const baseName = path.basename(originalName);
  const ext = path.extname(baseName).toLowerCase();

  if (!ext || !ALLOWED_EXTENSIONS_MAP[ext]) {
    return cb(
      new Error(
        `Unsupported file extension: '${ext || 'none'}'. Supported: PDF, DOCX, DOC, TXT, MD, PPT, PPTX, CSV, TSV, JSON, XML, XLSX, XLS, and Images (JPG, JPEG, PNG, WEBP, GIF, BMP, HEIC, HEIF).`
      )
    );
  }

  const allowedMimes = ALLOWED_EXTENSIONS_MAP[ext];
  const clientMime = (file.mimetype || '').toLowerCase();
  if (
    clientMime &&
    !allowedMimes.includes(clientMime) &&
    clientMime !== 'application/octet-stream'
  ) {
    return cb(
      new Error(
        `MIME type '${clientMime}' is not permitted for ${ext.toUpperCase()} files.`
      )
    );
  }

  cb(null, true);
};

export const uploadMiddleware = multer({
  storage: uploadStorage,
  limits: {
    fileSize: MAX_FILE_SIZE_BYTES,
    files: MAX_ATTACHMENTS_PER_UPLOAD
  },
  fileFilter: uploadFilter as any
});

// In-memory registry tracking uploaded temporary files and their lifecycle
export const fileRegistry = new Map<string, UploadedFileRecord>();
// Conversation to file IDs association mapping (strictly isolates documents per conversation)
export const conversationDocuments = new Map<string, Set<string>>();

// Durable Direct-Upload Ticket Service integration (ORVIX-SUPABASE-FINAL-001)
export {
  pendingDirectUploads,
  pruneExpiredDirectUploadTickets,
  resetDirectUploadTicketsForTesting,
  createDurableUploadTicket,
  getDurableUploadTicket,
  claimDirectUploadTicketForCompletion,
  finalizeCompletedDirectUploadTicket,
  failAndCleanupDurableUploadTicket,
  cancelDurableUploadTicket,
  opportunisticDirectUploadPrune,
  type PendingDirectUploadTicket
} from './directUploadTicketService.ts';

import {
  pendingDirectUploads,
  pruneExpiredDirectUploadTickets,
  createDurableUploadTicket,
  getDurableUploadTicket,
  claimDirectUploadTicketForCompletion,
  finalizeCompletedDirectUploadTicket,
  failAndCleanupDurableUploadTicket,
  cancelDurableUploadTicket,
  opportunisticDirectUploadPrune,
  type PendingDirectUploadTicket
} from './directUploadTicketService.ts';

/**
 * Automated lifecycle cleanup: Sweeps the temporary upload directory, registry,
 * and abandoned direct upload tickets.
 */
export function cleanupExpiredUploads() {
  try {
    void pruneExpiredDirectUploadTickets();
    const now = Date.now();
    for (const [id, record] of fileRegistry.entries()) {
      if (record.expiresAt <= now) {
        fileRegistry.delete(id);
        const fullPath = path.join(UPLOAD_DIR, record.diskFilename);
        fs.promises.unlink(fullPath).catch(() => {});
      }
    }

    fs.readdir(UPLOAD_DIR, (err, files) => {
      if (err || !Array.isArray(files)) return;
      for (const filename of files) {
        const filePath = path.join(UPLOAD_DIR, filename);
        fs.stat(filePath, (statErr, stats) => {
          if (statErr || !stats) return;
          if (now - stats.mtimeMs > TEMP_FILE_TTL_MS) {
            fs.unlink(filePath, () => {});
          }
        });
      }
    });
  } catch (e) {
    console.warn('[Upload Cleanup] Error during temp file cleanup:', e);
  }
}

// Run cleanup every 15 minutes
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;
const cleanupTimer = setInterval(cleanupExpiredUploads, CLEANUP_INTERVAL_MS);
if (cleanupTimer.unref) cleanupTimer.unref();

let devOnlyEphemeralSignedUrlSecret: string | null = null;

/**
 * Resolves the shared HMAC secret used to sign and verify decoding proxy URLs.
 * - Production / Serverless: MUST come from environment configuration (ORVIX_SIGNED_URL_SECRET,
 *   SIGNED_DECODE_URL_SECRET, or SESSION_SECRET) and meet validation rules. Never generates
 *   per-instance random secrets in production.
 * - Development / Test: Uses configured environment secret when present, or a process-local
 *   dev fallback secret only when not running in production mode.
 */
export function getSignedDecodeUrlSecret(options?: { forceProduction?: boolean }): string {
  const isProd = options?.forceProduction ?? isSignedDecodeProductionMode();
  const resolution = resolveConfiguredSignedDecodeUrlSecret();

  if (resolution.valid && resolution.secret) {
    return resolution.secret;
  }

  if (isProd) {
    logUploadDiagnostic({
      stage: 'signed_url_config',
      code: 'SIGNED_URL_SECRET_INVALID',
      message: resolution.errorMessage || 'ORVIX_SIGNED_URL_SECRET is missing or invalid.',
      details: {
        reason: resolution.invalidReason || 'missing',
        sourceKey: resolution.sourceKey || null,
        envPresence: {
          ORVIX_SIGNED_URL_SECRET: Boolean(process.env.ORVIX_SIGNED_URL_SECRET?.trim()),
          SIGNED_DECODE_URL_SECRET: Boolean(process.env.SIGNED_DECODE_URL_SECRET?.trim()),
          SESSION_SECRET: Boolean(process.env.SESSION_SECRET?.trim())
        }
      }
    });
    const err: any = new Error(
      `[Orvix Upload] Fatal signed-URL configuration error: ${resolution.errorMessage || 'ORVIX_SIGNED_URL_SECRET is missing or invalid.'}`
    );
    err.code = 'SIGNED_URL_SECRET_INVALID';
    err.diagnosticStage = 'signed_url_config';
    throw err;
  }

  if (!devOnlyEphemeralSignedUrlSecret) {
    devOnlyEphemeralSignedUrlSecret = crypto.randomBytes(32).toString('hex');
  }
  return devOnlyEphemeralSignedUrlSecret;
}

/**
 * Validates that signed decoding URL configuration is ready for the active runtime.
 * Throws SIGNED_URL_SECRET_INVALID in production if missing or invalid.
 */
export function validateSignedDecodeUrlConfiguration(options?: { forceProduction?: boolean }): void {
  getSignedDecodeUrlSecret(options);
}

/**
 * Test helper to clear the in-memory dev fallback secret between unit tests.
 */
export function resetDevSignedDecodeUrlSecretForTesting(): void {
  devOnlyEphemeralSignedUrlSecret = null;
}

function firstFieldValue(value: unknown): string {
  if (Array.isArray(value)) {
    return typeof value[0] === 'string' ? value[0].trim() : '';
  }
  return typeof value === 'string' ? value.trim() : '';
}

function resolveRequestOrigin(req: express.Request): string {
  const protoHeader = req.headers['x-forwarded-proto'];
  const proto =
    (Array.isArray(protoHeader) ? protoHeader[0] : protoHeader)?.split(',')[0]?.trim() ||
    req.protocol ||
    'http';
  const hostHeader = req.headers['x-forwarded-host'];
  const host =
    (Array.isArray(hostHeader) ? hostHeader[0] : hostHeader)?.split(',')[0]?.trim() ||
    req.get('host') ||
    '127.0.0.1:3000';
  return `${proto}://${host}`;
}

function computeSignedDecodeSignature(
  fileId: string,
  uid: string,
  chatId: string,
  exp: number,
  dl: string
): string {
  const secret = getSignedDecodeUrlSecret();
  const payload = `${fileId}\n${uid}\n${chatId}\n${exp}\n${dl}`;
  return crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('base64url');
}

function createSignedDecodeUrl(
  req: express.Request,
  params: {
    fileId: string;
    userId: string;
    chatId: string;
    expiresInSeconds?: number;
    forceDownload?: boolean;
  }
): { signedUrl: string; expiresInSeconds: number } {
  const expiresInSeconds = Math.max(1, Math.min(120, params.expiresInSeconds || 120));
  const exp = Date.now() + expiresInSeconds * 1000;
  const dl = params.forceDownload ? '1' : '0';
  const sig = computeSignedDecodeSignature(
    params.fileId,
    params.userId,
    params.chatId,
    exp,
    dl
  );
  const origin = resolveRequestOrigin(req);
  const routeSegment = params.forceDownload ? 'download' : 'file';
  const signedUrl =
    `${origin}/api/upload/${encodeURIComponent(params.fileId)}/${routeSegment}` +
    `?chatId=${encodeURIComponent(params.chatId)}` +
    `&uid=${encodeURIComponent(params.userId)}` +
    `&exp=${exp}` +
    `&dl=${dl}` +
    `&sig=${encodeURIComponent(sig)}`;
  return { signedUrl, expiresInSeconds };
}

function verifySignedDecodeQuery(
  req: express.Request,
  fileId: string
):
  | { hasSignature: false }
  | { hasSignature: true; valid: true; uid: string; chatId: string; dl: string }
  | { hasSignature: true; valid: false; status: number; code: string; error: string } {
  const sigRaw = typeof req.query.sig === 'string' ? req.query.sig.trim() : '';
  if (!sigRaw) {
    return { hasSignature: false };
  }

  const uid = typeof req.query.uid === 'string' ? req.query.uid.trim() : '';
  const chatId = typeof req.query.chatId === 'string' ? req.query.chatId.trim() : '';
  const expRaw = typeof req.query.exp === 'string' ? req.query.exp.trim() : '';
  const dl = typeof req.query.dl === 'string' ? req.query.dl.trim() : '0';
  const exp = Number(expRaw);

  if (!uid || !chatId || !Number.isFinite(exp) || (dl !== '0' && dl !== '1')) {
    return {
      hasSignature: true,
      valid: false,
      status: 403,
      code: 'INVALID_SIGNED_URL',
      error: 'Signed URL parameters are malformed or incomplete.'
    };
  }

  let expectedSig: string;
  try {
    expectedSig = computeSignedDecodeSignature(fileId, uid, chatId, exp, dl);
  } catch (err: any) {
    return {
      hasSignature: true,
      valid: false,
      status: 500,
      code: err?.code === 'SIGNED_URL_SECRET_INVALID' ? 'SIGNED_URL_MISCONFIGURED' : 'SIGNED_URL_FAILED',
      error: 'Signed URL verification is unavailable due to a server configuration error.'
    };
  }

  const actualBuf = Buffer.from(sigRaw, 'utf8');
  const expectedBuf = Buffer.from(expectedSig, 'utf8');
  if (
    actualBuf.length !== expectedBuf.length ||
    !crypto.timingSafeEqual(actualBuf, expectedBuf)
  ) {
    return {
      hasSignature: true,
      valid: false,
      status: 403,
      code: 'INVALID_SIGNED_URL',
      error: 'Signed URL signature is invalid.'
    };
  }

  if (Date.now() > exp) {
    return {
      hasSignature: true,
      valid: false,
      status: 403,
      code: 'SIGNED_URL_EXPIRED',
      error: 'Pre-signed attachment URL has expired.'
    };
  }

  return { hasSignature: true, valid: true, uid, chatId, dl };
}

function unwrapUploadedOrStoredPayload(params: {
  buffer: Buffer;
  ext: string;
  clientMime?: string;
  declaredEncoding?: string | null;
  declaredOriginalSize?: number | string | null;
  declaredOriginalMimeType?: string | null;
  declaredChecksum?: string | null;
  maxOriginalBytes?: number;
}): {
  encoded: boolean;
  storageEncoding: string | null;
  rawStorageBuffer: Buffer;
  decodedBuffer: Buffer;
  originalSize: number;
  storedSize: number;
  canonicalMimeType: string;
  storageChecksum?: string;
} {
  const {
    buffer,
    ext,
    clientMime = '',
    declaredEncoding = '',
    declaredOriginalSize = null,
    declaredOriginalMimeType = '',
    declaredChecksum = null,
    maxOriginalBytes = MAX_FILE_SIZE_BYTES
  } = params;

  const cleanDeclaredEncoding = typeof declaredEncoding === 'string' ? declaredEncoding.trim() : '';
  const targetSupported = isTransparentStorageCompressionSupported({ extension: ext });
  const hasEnvelope = isOrvixStorageEnvelope(buffer);

  if (cleanDeclaredEncoding) {
    if (cleanDeclaredEncoding !== ORVIX_ENVELOPE_ENCODING_ID) {
      throw new StorageEnvelopeError(
        `Unsupported storage encoding '${cleanDeclaredEncoding}'.`,
        'UNSUPPORTED_STORAGE_ENCODING'
      );
    }
    if (!targetSupported) {
      throw new StorageEnvelopeError(
        `Storage encoding '${cleanDeclaredEncoding}' is not supported for '${ext}' files.`,
        'UNSUPPORTED_STORAGE_ENCODING'
      );
    }
    if (!hasEnvelope) {
      throw new StorageEnvelopeError(
        'Declared storageEncoding does not match uploaded payload format.',
        'INVALID_STORAGE_ENVELOPE'
      );
    }
  }

  if (hasEnvelope && targetSupported) {
    let parsedOriginalSize: number | null = null;
    if (
      declaredOriginalSize !== null &&
      declaredOriginalSize !== undefined &&
      String(declaredOriginalSize).trim() !== ''
    ) {
      const n = Number(declaredOriginalSize);
      if (!Number.isFinite(n) || n <= 0) {
        throw new StorageEnvelopeError(
          'Declared originalSize must be a positive integer.',
          'ENVELOPE_SIZE_MISMATCH'
        );
      }
      parsedOriginalSize = n;
    }

    const decoded = decodeOrvixStorageEnvelopeSync(buffer, {
      maxOriginalBytes,
      expectedExtension: ext,
      expectedMimeType: declaredOriginalMimeType || clientMime || '',
      expectedOriginalSize: parsedOriginalSize,
      expectedChecksum: declaredChecksum || null
    });

    const decodedBuffer = Buffer.from(decoded.data);
    return {
      encoded: true,
      storageEncoding: decoded.encoding,
      rawStorageBuffer: buffer,
      decodedBuffer,
      originalSize: decodedBuffer.length,
      storedSize: buffer.length,
      canonicalMimeType: decoded.originalMimeType,
      storageChecksum: decoded.sha256
    };
  }

  const normalizedClientMime = (clientMime || '').split(';')[0].trim().toLowerCase();
  const fallbackMime =
    (normalizedClientMime && normalizedClientMime !== 'application/octet-stream'
      ? normalizedClientMime
      : '') ||
    (ALLOWED_EXTENSIONS_MAP[ext] && ALLOWED_EXTENSIONS_MAP[ext][0]) ||
    'application/octet-stream';

  return {
    encoded: false,
    storageEncoding: null,
    rawStorageBuffer: buffer,
    decodedBuffer: buffer,
    originalSize: buffer.length,
    storedSize: buffer.length,
    canonicalMimeType: fallbackMime
  };
}

function decodeSupabaseBufferIfEnvelope(
  rawData: Buffer,
  ext: string,
  fallbackMime?: string
): {
  encoded: boolean;
  storageEncoding: string | null;
  buffer: Buffer;
  mimeType: string;
  storedSize: number;
} {
  if (isOrvixStorageEnvelope(rawData)) {
    const decoded = decodeOrvixStorageEnvelopeSync(rawData, {
      maxOriginalBytes: MAX_FILE_SIZE_BYTES,
      expectedExtension: ext || ''
    });
    return {
      encoded: true,
      storageEncoding: decoded.encoding,
      buffer: Buffer.from(decoded.data),
      mimeType: decoded.originalMimeType,
      storedSize: rawData.length
    };
  }

  const cleanFallback = (fallbackMime || '').split(';')[0].trim().toLowerCase();
  const resolvedMime =
    (cleanFallback && cleanFallback !== 'application/octet-stream' ? cleanFallback : '') ||
    getCanonicalMimeForExtension(ext) ||
    (ALLOWED_EXTENSIONS_MAP[ext] && ALLOWED_EXTENSIONS_MAP[ext][0]) ||
    'application/octet-stream';

  return {
    encoded: false,
    storageEncoding: null,
    buffer: rawData,
    mimeType: resolvedMime,
    storedSize: rawData.length
  };
}

/**
 * Serializes an UploadedFileRecord into the canonical client-facing attachment contract
 * shared by both standard (`POST /api/upload`) and direct (`POST /api/upload/direct/complete`) uploads.
 */
export function serializeRegisteredAttachment(r: UploadedFileRecord) {
  const ext = path.extname(r.diskFilename || r.originalName || '').toLowerCase();
  const isImg =
    Boolean(r.isImage) ||
    ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.heic', '.heif'].includes(ext) ||
    (r.mimeType || '').toLowerCase().startsWith('image/');

  return {
    id: r.id,
    originalName: r.originalName,
    name: r.originalName,
    extension: r.extension,
    format: r.extraction?.format || r.extension,
    mimeType: r.mimeType,
    type: r.mimeType,
    size: r.size,
    formattedSize: r.formattedSize,
    status: r.status,
    isImage: isImg,
    dimensions: r.dimensions,
    url: `/api/upload/${r.id}/file`,
    uploadedAt: r.uploadedAt,
    expiresAt: r.expiresAt,
    storageProvider: r.storageProvider || 'local',
    storagePath: r.storagePath || null,
    storageBucket: r.storageBucket || null,
    bucket: r.storageBucket || null,
    storageEncoding: r.storageEncoding || null,
    storedSize: typeof r.storedSize === 'number' ? r.storedSize : r.size,
    userId: r.userId || null,
    chatId: r.conversationId || null,
    conversationId: r.conversationId || null,
    extraction: r.extraction
      ? {
          id: r.id,
          fileId: r.id,
          filename: r.diskFilename,
          originalName: r.originalName,
          name: r.originalName,
          status: r.extraction.status,
          success: r.extraction.success,
          format: r.extraction.format || r.extension,
          isImage: Boolean(r.extraction.isImage || isImg),
          hasText: Boolean(r.extraction.hasText),
          text: r.extraction.text || '',
          message: r.extraction.message,
          totalCharacters: r.extraction.totalCharacters ?? 0,
          totalWords: r.extraction.totalWords ?? 0,
          lineCount: r.extraction.lineCount,
          confidence: r.extraction.confidence,
          summaryText: r.extraction.summaryText,
          pageCount: r.extraction.pageCount,
          pages: r.extraction.pages,
          slideCount: r.extraction.slideCount,
          slides: r.extraction.slides,
          sectionCount: r.extraction.sectionCount,
          sections: r.extraction.sections,
          sheetCount: (r.extraction as any).sheetCount,
          sheetNames: (r.extraction as any).sheetNames,
          table: r.extraction.table,
          headings: (r.extraction as any).headings,
          metadata: (r.extraction as any).metadata,
          isScanned: r.extraction.isScanned,
          isTruncated: r.extraction.isTruncated,
          warning: r.extraction.warning,
          error: r.extraction.error
        }
      : undefined
  };
}

export interface AttachmentResolutionResult {
  status: 'ok' | 'expired' | 'not_found' | 'unauthenticated' | 'forbidden';
  record: UploadedFileRecord | null;
}

/**
 * Resolves an attachment reference for `/api/chat` by checking `fileRegistry` first,
 * enforcing expiration and Firebase UID ownership, and falling back to durable Supabase Storage
 * re-hydration when `fileRegistry` misses (e.g., across serverless function boundaries or restarts).
 */
export async function resolveRegisteredAttachmentForChat(
  att: any,
  options: {
    authenticatedUserId: string | null;
    conversationId?: string | null;
    offline?: boolean;
  }
): Promise<AttachmentResolutionResult> {
  const attId = typeof att?.id === 'string' ? att.id.trim() : '';
  const authenticatedUserId = options?.authenticatedUserId ? String(options.authenticatedUserId).trim() : null;
  const nowMs = Date.now();

  if (!attId) {
    return { status: 'not_found', record: null };
  }

  // 1. Check in-memory fileRegistry first
  const existing = fileRegistry.get(attId);
  if (existing) {
    // Deterministically enforce expiration before allowing chat submission
    if (
      !existing.isPermanent &&
      typeof existing.expiresAt === 'number' &&
      Number.isFinite(existing.expiresAt) &&
      existing.expiresAt <= nowMs
    ) {
      fileRegistry.delete(attId);
      if (existing.conversationId && conversationDocuments.has(existing.conversationId)) {
        conversationDocuments.get(existing.conversationId)!.delete(attId);
      }
      if (existing.diskFilename) {
        fs.promises.unlink(path.join(UPLOAD_DIR, existing.diskFilename)).catch(() => {});
      }
      if (existing.storageProvider === 'supabase' && existing.storagePath) {
        deleteAttachmentFromStorage(existing.storagePath, {
          requestingUserId: existing.userId,
          bucket: existing.storageBucket
        }).catch(() => {});
      }
      return { status: 'expired', record: null };
    }

    // Enforce Firebase UID ownership verification
    if (existing.userId) {
      if (!authenticatedUserId) {
        return { status: 'unauthenticated', record: existing };
      }
      if (existing.userId !== authenticatedUserId) {
        return { status: 'forbidden', record: existing };
      }
    }

    return { status: 'ok', record: existing };
  }

  // 2. When missing from in-memory fileRegistry (e.g., serverless /api/upload -> /api/chat boundary),
  //    check explicit ownership hints first to reject cross-user tampering with 403.
  if (typeof att?.storagePath === 'string' && att.storagePath.trim()) {
    const parsedClientPath = parseStoragePath(att.storagePath);
    if (parsedClientPath.valid && parsedClientPath.userId) {
      if (!authenticatedUserId) {
        return { status: 'unauthenticated', record: null };
      }
      if (parsedClientPath.userId !== authenticatedUserId) {
        return { status: 'forbidden', record: null };
      }
    }
  }

  if (typeof att?.userId === 'string' && att.userId.trim()) {
    if (!authenticatedUserId) {
      return { status: 'unauthenticated', record: null };
    }
    if (att.userId.trim() !== authenticatedUserId) {
      return { status: 'forbidden', record: null };
    }
  }

  // 3. Re-hydrate from Supabase Storage for authenticated user
  if (authenticatedUserId && isSupabaseConfigured()) {
    const rawChatCandidate =
      (typeof att?.chatId === 'string' && att.chatId.trim()) ||
      (typeof att?.conversationId === 'string' && att.conversationId.trim()) ||
      (typeof options?.conversationId === 'string' && options.conversationId.trim()) ||
      '';
    const cleanChatId = isValidPathSegment(rawChatCandidate) ? rawChatCandidate : '';

    let resolvedStoragePath: string | null = null;
    let resolvedChatId = cleanChatId;
    let resolvedExt = '';

    if (typeof att?.storagePath === 'string' && att.storagePath.trim()) {
      const parsed = parseStoragePath(att.storagePath);
      if (
        parsed.valid &&
        parsed.userId === authenticatedUserId &&
        parsed.attachmentId === attId &&
        parsed.normalizedPath
      ) {
        resolvedStoragePath = parsed.normalizedPath;
        resolvedChatId = parsed.chatId || resolvedChatId;
        resolvedExt = parsed.extension || '';
      }
    }

    if (!resolvedStoragePath && resolvedChatId) {
      const found = await findAttachmentPathInStorage(authenticatedUserId, resolvedChatId, attId);
      if (found.found && found.path) {
        const parsed = parseStoragePath(found.path);
        if (parsed.valid && parsed.userId === authenticatedUserId && parsed.attachmentId === attId) {
          resolvedStoragePath = parsed.normalizedPath || found.path;
          resolvedExt = parsed.extension || '';
        }
      }
    }

    if (resolvedStoragePath) {
      const expiryStatus = await checkDurableAttachmentExpiry({
        userId: authenticatedUserId,
        chatId: resolvedChatId || undefined,
        attachmentId: attId,
        nowMs
      });

      if (expiryStatus.expired) {
        return { status: 'expired', record: null };
      }

      const downloadRes = await downloadAttachmentFromStorage(resolvedStoragePath, {
        requestingUserId: authenticatedUserId
      });

      if (downloadRes.success && downloadRes.data && downloadRes.data.length > 0) {
        const extFromName = path.extname(att?.originalName || att?.name || '').replace(/^\.+/, '').toLowerCase();
        const cleanExt = (resolvedExt || (typeof att?.extension === 'string' ? att.extension.replace(/^\.+/, '').toLowerCase() : '') || extFromName || 'pdf').toLowerCase();
        const dotExt = `.${cleanExt}`;

        let decodedStorage: ReturnType<typeof decodeSupabaseBufferIfEnvelope>;
        try {
          decodedStorage = decodeSupabaseBufferIfEnvelope(
            downloadRes.data,
            dotExt,
            downloadRes.mimeType
          );
        } catch (decodeErr) {
          console.warn('[Upload Rehydration] Envelope decode error:', decodeErr);
          return { status: 'not_found', record: null };
        }

        const buffer = decodedStorage.buffer;
        const sigResult = await verifyFileSignature(buffer, dotExt);
        if (!sigResult.valid) {
          return { status: 'not_found', record: null };
        }

        const isImg =
          ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.heic', '.heif'].includes(dotExt) ||
          Boolean(att?.isImage) ||
          (decodedStorage.mimeType || '').toLowerCase().startsWith('image/');

        const originalName =
          (typeof att?.originalName === 'string' && att.originalName.trim()) ||
          (typeof att?.name === 'string' && att.name.trim()) ||
          `${attId}${dotExt}`;
        const clientMimeCandidate =
          (typeof att?.mimeType === 'string' && att.mimeType.trim()) ||
          (typeof att?.type === 'string' && att.type.trim()) ||
          '';
        const mimeType =
          (decodedStorage.encoded ? decodedStorage.mimeType : clientMimeCandidate || decodedStorage.mimeType) ||
          (isImg ? `image/${cleanExt === 'jpg' ? 'jpeg' : cleanExt}` : cleanExt === 'pdf' ? 'application/pdf' : 'application/octet-stream');

        const diskFilename = `${attId}${dotExt}`;
        let extraction: any =
          att?.extraction && typeof att.extraction === 'object' && (att.extraction.text || att.extraction.pages || att.extraction.slides || att.extraction.sections || att.extraction.isImage)
            ? att.extraction
            : undefined;

        if (!extraction) {
          const geminiKey = getGeminiApiKey() || null;
          try {
            if (isImg) {
              extraction = await extractImageText(
                buffer,
                originalName,
                dotExt,
                mimeType,
                attId,
                sigResult.dimensions,
                geminiKey,
                { offline: Boolean(options?.offline) }
              );
            } else {
              extraction = await extractDocumentContent(
                buffer,
                originalName,
                dotExt,
                mimeType,
                attId,
                { offline: Boolean(options?.offline), apiKey: geminiKey }
              );
            }
          } catch (extErr) {
            console.warn('[Upload Rehydration] Extraction error:', extErr);
          }
        }

        const rehydratedRecord: UploadedFileRecord = {
          id: attId,
          originalName,
          diskFilename,
          mimeType,
          extension: cleanExt.toUpperCase(),
          size: buffer.length,
          formattedSize: formatBytes(buffer.length),
          status: isImg ? 'ready' : (extraction?.success || extraction?.status === 'ready' || extraction?.status === 'scanned_or_image_only' || extraction?.status === 'NO_TEXT_DETECTED' ? 'ready' : 'uploaded'),
          uploadedAt: typeof att?.uploadedAt === 'string' ? att.uploadedAt : new Date(nowMs).toISOString(),
          expiresAt: typeof expiryStatus.expiresAt === 'number' ? expiryStatus.expiresAt : nowMs + TEMP_FILE_TTL_MS,
          conversationId: resolvedChatId || undefined,
          userId: authenticatedUserId,
          isPermanent: false,
          storageProvider: 'supabase',
          storagePath: resolvedStoragePath,
          storageBucket: getSupabaseBucket(),
          storageEncoding: decodedStorage.storageEncoding,
          storedSize: decodedStorage.storedSize,
          isImage: isImg,
          dimensions: sigResult.dimensions,
          extraction,
          buffer
        };

        fileRegistry.set(attId, rehydratedRecord);
        if (resolvedChatId) {
          let docSet = conversationDocuments.get(resolvedChatId);
          if (!docSet) {
            docSet = new Set<string>();
            conversationDocuments.set(resolvedChatId, docSet);
          }
          docSet.add(attId);
        }

        return { status: 'ok', record: rehydratedRecord };
      }
    }
  }

  return { status: 'not_found', record: null };
}

export function buildGeminiImageParts({
  attachments = [],
  availableDocs = [],
  registry = fileRegistry,
  uploadDir = UPLOAD_DIR,
  maxImageBytes = MAX_VISION_IMAGE_BYTES,
  maxRequestBytes = MAX_CHAT_REQUEST_BYTES
}: {
  attachments?: any[];
  availableDocs?: any[];
  registry?: Map<string, any>;
  uploadDir?: string;
  maxImageBytes?: number;
  maxRequestBytes?: number;
} = {}): Array<{ mimeType: string; data: string }> {
  return buildVisionImageParts({
    attachments,
    availableDocs,
    maxImageBytes,
    maxRequestBytes,
    resolveRegisteredFile: (id: string) => {
      const rec = registry?.get(id);
      if (!rec) return null;
      let buf = rec.buffer;
      if (!buf && rec.diskFilename && uploadDir) {
        const fullDiskPath = path.join(uploadDir, rec.diskFilename);
        try {
          if (fs.existsSync(fullDiskPath)) {
            buf = fs.readFileSync(fullDiskPath);
          }
        } catch (_) {}
      }
      return {
        ...rec,
        buffer: buf
      };
    }
  });
}

type OcrPackFetchResult =
  | { kind: 'file'; filePath: string; size: number }
  | { kind: 'buffer'; buffer: Buffer };

const MIN_OCR_PACK_BYTES = 50 * 1024;
const MAX_OCR_PACK_BYTES = 50 * 1024 * 1024;
const OCR_PACK_FETCH_TIMEOUT_MS = 30_000;
const inFlightOcrPackFetches = new Map<string, Promise<OcrPackFetchResult | null>>();

function hasHtmlOrXmlErrorPrefix(chunk: Uint8Array): boolean {
  const sample = Buffer.from(chunk.subarray(0, 256)).toString('utf8').trimStart().toLowerCase();
  return (
    sample.startsWith('<!doctype html') ||
    sample.startsWith('<html') ||
    sample.startsWith('<?xml')
  );
}

async function writeChunkWithBackpressure(ws: fs.WriteStream, chunk: Uint8Array): Promise<void> {
  if (ws.write(chunk)) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      ws.off('drain', onDrain);
      ws.off('error', onError);
    };
    ws.once('drain', onDrain);
    ws.once('error', onError);
  });
}

async function fetchAndCacheOcrPack(
  rawFile: string,
  localPackPath: string,
  ocrPacksDir: string
): Promise<OcrPackFetchResult | null> {
  const primaryUrl = `https://tessdata.projectnaptha.com/4.0.0_fast/${rawFile}`;
  const fallbackUrl = `https://raw.githubusercontent.com/naptha/tessdata/gh-pages/4.0.0_fast/${rawFile}`;
  const candidateUrls = [primaryUrl, fallbackUrl];

  let dirWritable = false;
  try {
    await fs.promises.mkdir(ocrPacksDir, { recursive: true });
    dirWritable = true;
  } catch (_) {}

  for (const url of candidateUrls) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), OCR_PACK_FETCH_TIMEOUT_MS);
    const tmpPath = path.join(ocrPacksDir, `.${rawFile}.${crypto.randomUUID()}.tmp`);

    try {
      const upstream = await fetch(url, { signal: controller.signal });
      if (!upstream.ok) {
        continue;
      }

      if (dirWritable && upstream.body && typeof upstream.body.getReader === 'function') {
        const reader = upstream.body.getReader();
        const ws = fs.createWriteStream(tmpPath);
        let streamError: Error | null = null;
        ws.on('error', (err) => {
          streamError = err;
        });

        let totalBytes = 0;
        let checkedPrefix = false;
        let invalidPayload = false;

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value || value.byteLength === 0) continue;

            if (!checkedPrefix) {
              checkedPrefix = true;
              if (hasHtmlOrXmlErrorPrefix(value)) {
                invalidPayload = true;
                break;
              }
            }

            totalBytes += value.byteLength;
            if (totalBytes > MAX_OCR_PACK_BYTES) {
              invalidPayload = true;
              break;
            }

            if (streamError) throw streamError;
            await writeChunkWithBackpressure(ws, value);
          }

          if (invalidPayload || totalBytes < MIN_OCR_PACK_BYTES) {
            try { await reader.cancel(); } catch (_) {}
            ws.destroy();
            await fs.promises.unlink(tmpPath).catch(() => {});
            continue;
          }

          await new Promise<void>((resolve, reject) => {
            ws.once('finish', resolve);
            ws.once('error', reject);
            ws.end();
          });

          await fs.promises.rename(tmpPath, localPackPath);
          return { kind: 'file', filePath: localPackPath, size: totalBytes };
        } catch (streamErr) {
          try { await reader.cancel(); } catch (_) {}
          ws.destroy();
          await fs.promises.unlink(tmpPath).catch(() => {});
          throw streamErr;
        }
      }

      // Fallback when disk directory is read-only or upstream body lacks getReader()
      const arrayBuf = await upstream.arrayBuffer();
      const buffer = Buffer.from(arrayBuf);
      if (
        buffer.length >= MIN_OCR_PACK_BYTES &&
        buffer.length <= MAX_OCR_PACK_BYTES &&
        !hasHtmlErrorSafe(buffer)
      ) {
        if (dirWritable) {
          try {
            await fs.promises.writeFile(tmpPath, buffer);
            await fs.promises.rename(tmpPath, localPackPath);
            return { kind: 'file', filePath: localPackPath, size: buffer.length };
          } catch (_) {
            await fs.promises.unlink(tmpPath).catch(() => {});
          }
        }
        return { kind: 'buffer', buffer };
      }
    } catch (err: any) {
      await fs.promises.unlink(tmpPath).catch(() => {});
      console.warn(`[OCR Pack Proxy] Error fetching ${rawFile} from ${url}:`, err?.message || err);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  return null;
}

function hasHtmlErrorSafe(buffer: Buffer): boolean {
  return hasHtmlOrXmlErrorPrefix(buffer);
}

/**
 * Registers all file upload and attachment serving routes onto the Express app.
 */
export function registerUploadRoutes(app: express.Express) {
  if (isSignedDecodeProductionMode()) {
    validateSignedDecodeUrlConfiguration();
  }

  // Multilingual OCR Language Pack Proxy & Local Cache Endpoint
  app.get(['/api/ocr/packs/:file', '/ocr/packs/:file'], async (req, res) => {
    const rawFile = req.params.file || '';
    if (!/^[a-z]{3}\.traineddata(\.gz)?$/i.test(rawFile)) {
      return res.status(400).json({ error: 'Invalid OCR language pack filename.', code: 'INVALID_PACK_NAME' });
    }

    const langCode = rawFile.split('.')[0].toLowerCase();
    const validLangs = ['eng', 'spa', 'fra', 'deu', 'ara', 'urd'];
    if (!validLangs.includes(langCode)) {
      return res.status(404).json({ error: `Language pack for '${langCode}' is not supported.`, code: 'UNSUPPORTED_LANGUAGE' });
    }

    if (langCode === 'eng' && (rawFile === 'eng.traineddata' || rawFile === 'eng.traineddata.gz')) {
      const rootEngPath = path.resolve(process.cwd(), 'eng.traineddata');
      if (fs.existsSync(rootEngPath)) {
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        return res.sendFile(rootEngPath);
      }
    }

    const ocrPacksDir = path.join(UPLOAD_DIR, 'ocr-packs');
    const localPackPath = path.join(ocrPacksDir, rawFile);
    if (fs.existsSync(localPackPath)) {
      try {
        const stats = await fs.promises.stat(localPackPath);
        if (stats.size >= MIN_OCR_PACK_BYTES) {
          res.setHeader('Content-Type', rawFile.endsWith('.gz') ? 'application/gzip' : 'application/octet-stream');
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          return res.sendFile(localPackPath);
        }
      } catch (_) {}
    }

    const cacheKey = rawFile.toLowerCase();
    let inFlight = inFlightOcrPackFetches.get(cacheKey);
    if (!inFlight) {
      inFlight = fetchAndCacheOcrPack(rawFile, localPackPath, ocrPacksDir).finally(() => {
        if (inFlightOcrPackFetches.get(cacheKey) === inFlight) {
          inFlightOcrPackFetches.delete(cacheKey);
        }
      });
      inFlightOcrPackFetches.set(cacheKey, inFlight);
    }

    const result = await inFlight;
    const contentType = rawFile.endsWith('.gz') ? 'application/gzip' : 'application/octet-stream';

    if (result?.kind === 'file') {
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      return res.sendFile(result.filePath);
    }

    if (result?.kind === 'buffer') {
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', String(result.buffer.length));
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      return res.send(result.buffer);
    }

    return res.status(502).json({ error: `Could not retrieve language pack for '${langCode}' from CDN.`, code: 'PACK_DOWNLOAD_FAILED' });
  });

  // Upload Configuration Endpoint (returns limits, supported formats, and active storage strategy)
  app.get(['/api/upload/config', '/upload/config'], (_req, res) => {
    res.json({
      maxFileSizeBytes: MAX_FILE_SIZE_BYTES,
      maxFileSizeFormatted: formatBytes(MAX_FILE_SIZE_BYTES),
      maxAttachments: MAX_ATTACHMENTS_PER_UPLOAD,
      dailyUploadLimit: DAILY_UPLOAD_LIMIT,
      allowedExtensions: Object.keys(ALLOWED_EXTENSIONS_MAP).map((e) =>
        e.replace('.', '').toUpperCase()
      ),
      ttlMinutes: Math.round(TEMP_FILE_TTL_MS / (60 * 1000)),
      storageMode: isServerless ? 'serverless-temp' : 'local-disk',
      isServerless,
      directUploadSupported: isSupabaseConfigured(),
      directUploadThresholdBytes: 4 * 1024 * 1024
    });
  });

  // Authenticated Read-Only Upload Quota Status Endpoint (does NOT consume or reserve an upload slot)
  app.get(['/api/upload/quota', '/upload/quota'], async (req, res) => {
    const authenticatedUserId = await requireUploadAuthentication(
      req,
      res,
      'Authentication is required to view daily upload quota.'
    );
    if (!authenticatedUserId) {
      return;
    }

    const quotaIdentity = buildAuthenticatedQuotaIdentity(authenticatedUserId);
    let status: QuotaStatus;
    try {
      status = await getQuotaStatus(quotaIdentity);
    } catch (quotaErr: any) {
      if (!quotaErr?._loggedUploadDiagnostic) {
        logUploadDiagnostic({
          stage: quotaErr?.diagnosticStage || 'quota_lookup',
          code: quotaErr?.code ? String(quotaErr.code) : 'QUOTA_SERVICE_UNAVAILABLE',
          message: quotaErr?.message || String(quotaErr)
        });
      }
      console.error(
        `[UploadQuota] Quota status lookup failed (stage=${quotaErr?.diagnosticStage || 'quota_lookup'}):`,
        sanitizeErrorLog(quotaErr?.message || String(quotaErr))
      );
      return res.status(500).json({
        error: 'Upload quota status is temporarily unavailable.',
        code: 'QUOTA_SERVICE_UNAVAILABLE',
        status: 'SERVICE_UNAVAILABLE'
      });
    }

    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    attachQuotaHeaders(res, status, quotaIdentity);

    const currentPktDay = status.pktDay || status.utcDay || getPktDayString();
    return res.status(200).json({
      limit: status.limit,
      remaining: status.remaining,
      committed: status.committed,
      activeReservations: status.activeReservations,
      resetAt: status.resetAt,
      pktDay: currentPktDay,
      utcDay: currentPktDay
    });
  });

  // Upload Attachment Metadata Endpoint
  app.get(['/api/upload/:id', '/upload/:id'], async (req, res) => {
    const fileId = req.params.id;
    if (!fileId || !/^[0-9a-fA-F-]{36}$/.test(fileId)) {
      return res.status(400).json({ error: 'Invalid attachment ID format.', code: 'INVALID_ID_FORMAT' });
    }

    const rawChatId = (typeof req.query.chatId === 'string' ? req.query.chatId : '').trim();
    const record = fileRegistry.get(fileId);

    if (!record) {
      if (rawChatId && isValidPathSegment(rawChatId) && isSupabaseConfigured()) {
        const authStatus = await authenticateRequest(req);
        if (authStatus.status === 'authenticated') {
          const lookup = await findAttachmentPathInStorage(authStatus.userId, rawChatId, fileId);
          if (lookup.found && lookup.path) {
            const ext = path.extname(lookup.filename || '').toLowerCase();
            const isImg =
              ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.heic', '.heif'].includes(ext) ||
              Boolean(ALLOWED_EXTENSIONS_MAP[ext]?.[0]?.startsWith('image/'));
            const mimeType = (ALLOWED_EXTENSIONS_MAP[ext] && ALLOWED_EXTENSIONS_MAP[ext][0]) || 'application/octet-stream';
            return res.json({
              id: fileId,
              name: lookup.filename || 'attachment',
              originalName: lookup.filename || 'attachment',
              extension: ext.replace('.', '').toUpperCase(),
              mimeType,
              type: mimeType,
              status: 'ready',
              isImage: isImg,
              storageProvider: 'supabase'
            });
          }
        }
      }

      if (isServerless) {
        return res.json({
          id: fileId,
          status: 'ready',
          serverless: true,
          message: 'Attachment active in client session.'
        });
      }
      return res.status(404).json({ error: 'Attachment not found or has expired.', code: 'ATTACHMENT_NOT_FOUND' });
    }

    // For every Supabase-backed attachment, require a non-empty record.userId and successful Firebase authentication.
    if (record.storageProvider === 'supabase' && !record.userId) {
      return res.status(403).json({
        error: 'Access denied: Attachment is missing required ownership metadata.',
        code: 'STORAGE_ACCESS_DENIED'
      });
    }

    if (record.storageProvider === 'supabase' || record.userId) {
      const authStatus = await authenticateRequest(req);
      if (authStatus.status === 'invalid') {
        return res.status(401).json({
          error: `Authentication failed: ${authStatus.error}`,
          code: authStatus.code || 'INVALID_TOKEN'
        });
      }
      if (authStatus.status === 'guest') {
        return res.status(401).json({
          error: 'Authentication required to access this attachment.',
          code: 'AUTH_REQUIRED'
        });
      }
      if (authStatus.userId !== record.userId) {
        return res.status(403).json({
          error: 'Access denied: You do not have permission to access attachments belonging to another user.',
          code: 'STORAGE_ACCESS_DENIED'
        });
      }
    }

    const ext = path.extname(record.diskFilename).toLowerCase();
    const isImg =
      ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.heic', '.heif'].includes(ext) ||
      record.mimeType.startsWith('image/');

    return res.json({
      id: record.id,
      name: record.originalName,
      originalName: record.originalName,
      extension: record.extension,
      mimeType: record.mimeType,
      type: record.mimeType,
      size: record.size,
      formattedSize: record.formattedSize,
      status: record.status,
      isImage: isImg,
      dimensions: record.dimensions,
      uploadedAt: record.uploadedAt,
      expiresAt: record.expiresAt,
      extraction: record.extraction,
      storageProvider: record.storageProvider || 'local'
    });
  });

  // Dedicated Document Extraction Detail Endpoint
  app.get(['/api/upload/:id/extraction', '/upload/:id/extraction'], async (req, res) => {
    const fileId = req.params.id;
    if (!fileId || !/^[0-9a-fA-F-]{36}$/.test(fileId)) {
      return res.status(400).json({ error: 'Invalid attachment ID format.', code: 'INVALID_ID_FORMAT' });
    }

    const rawChatId = (typeof req.query.chatId === 'string' ? req.query.chatId : '').trim();
    const record = fileRegistry.get(fileId);

    if (record) {
      // For every Supabase-backed attachment, require a non-empty record.userId and successful Firebase authentication.
      if (record.storageProvider === 'supabase' && !record.userId) {
        return res.status(403).json({
          error: 'Access denied: Attachment is missing required ownership metadata.',
          code: 'STORAGE_ACCESS_DENIED'
        });
      }

      let authenticatedUserId: string | null = null;
      if (record.storageProvider === 'supabase' || record.userId) {
        const authStatus = await authenticateRequest(req);
        if (authStatus.status === 'invalid') {
          return res.status(401).json({
            error: `Authentication failed: ${authStatus.error}`,
            code: authStatus.code || 'INVALID_TOKEN'
          });
        }
        if (authStatus.status === 'guest') {
          return res.status(401).json({
            error: 'Authentication required to access this attachment.',
            code: 'AUTH_REQUIRED'
          });
        }
        if (authStatus.userId !== record.userId) {
          return res.status(403).json({
            error: 'Access denied: You do not have permission to access attachments belonging to another user.',
            code: 'STORAGE_ACCESS_DENIED'
          });
        }
        authenticatedUserId = authStatus.userId;
      }

      const rawLang = String(req.query.lang || req.query.language || 'eng').toLowerCase().trim();
      const validLangs = ['eng', 'spa', 'fra', 'deu', 'ara', 'urd'];
      const lang = validLangs.includes(rawLang) ? rawLang : 'eng';

      record.extractionsByLang = record.extractionsByLang || {};
      if (record.extractionsByLang[lang]) {
        return res.json(record.extractionsByLang[lang]);
      }
      if (lang === 'eng' && record.extraction) {
        record.extractionsByLang['eng'] = record.extraction;
        return res.json(record.extraction);
      }

      const ext = path.extname(record.diskFilename).toLowerCase();
      const isImg =
        ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.heic', '.heif'].includes(ext) ||
        record.mimeType.startsWith('image/');

      const filePath = path.join(UPLOAD_DIR, path.basename(record.diskFilename));
      let inputSource: Buffer | string | null = record.buffer || (fs.existsSync(filePath) ? filePath : null);

      // If local source is absent but stored in Supabase, retrieve file from private bucket for on-demand extraction
      if (!inputSource && record.storageProvider === 'supabase' && record.storagePath) {
        try {
          const downloadResult = await downloadAttachmentFromStorage(record.storagePath, {
            requestingUserId: authenticatedUserId || undefined,
            bucket: record.storageBucket
          });
          if (downloadResult.success && downloadResult.data) {
            const decoded = decodeSupabaseBufferIfEnvelope(
              downloadResult.data,
              ext,
              downloadResult.mimeType || record.mimeType
            );
            inputSource = decoded.buffer;
            record.buffer = decoded.buffer;
            record.storageEncoding = decoded.storageEncoding || record.storageEncoding;
            record.storedSize = decoded.storedSize;
          }
        } catch (err: any) {
          if (err instanceof StorageEnvelopeError) {
            return res.status(422).json({
              error: err.message,
              code: err.code
            });
          }
          console.warn(`[Extraction] Failed to retrieve file from Supabase for ${record.id}:`, err?.message || err);
        }
      }

      if (inputSource) {
        if (isImg) {
          const isOfflineReq = req.query?.offline === 'true';
          const geminiKey = getGeminiApiKey() || null;
          const imgExtraction = await extractImageText(
            inputSource,
            record.originalName,
            ext,
            record.mimeType,
            record.id,
            record.dimensions,
            geminiKey,
            { offline: isOfflineReq, language: lang }
          );
          record.extractionsByLang[lang] = imgExtraction;
          if (lang === 'eng' || !record.extraction) {
            record.extraction = imgExtraction;
          }
          return res.json(imgExtraction);
        }

        const extraction = (await extractDocumentContent(
          inputSource,
          record.originalName,
          ext,
          record.mimeType,
          record.id
        )) as DocumentExtractionResult;
        record.extraction = extraction;
        record.extractionsByLang[lang] = extraction;
        return res.json(extraction);
      }

      return res.status(404).json({ error: 'Attachment file not found or has expired.', code: 'ATTACHMENT_NOT_FOUND' });
    }

    // When record is missing from fileRegistry (e.g. server restart):
    // Fail closed for unauthenticated requests
    const authStatus = await authenticateRequest(req);
    if (authStatus.status === 'invalid') {
      return res.status(401).json({
        error: `Authentication failed: ${authStatus.error}`,
        code: authStatus.code || 'INVALID_TOKEN'
      });
    }
    if (authStatus.status === 'guest') {
      if (rawChatId) {
        return res.status(401).json({
          error: 'Authentication required to access this attachment.',
          code: 'AUTH_REQUIRED'
        });
      }
      return res.status(404).json({
        error: 'Attachment not found or has expired.',
        code: 'ATTACHMENT_NOT_FOUND'
      });
    }

    const authenticatedUserId = authStatus.userId;

    if (!rawChatId) {
      if (req.query.chatId !== undefined) {
        return res.status(400).json({
          error: 'Missing required chatId parameter for extraction.',
          code: 'MISSING_CHAT_ID'
        });
      }
      return res.status(404).json({
        error: 'Attachment not found or has expired.',
        code: 'ATTACHMENT_NOT_FOUND'
      });
    }
    if (!isValidPathSegment(rawChatId)) {
      return res.status(400).json({
        error: 'Invalid chatId format.',
        code: 'INVALID_PATH_SEGMENT'
      });
    }

    if (!isSupabaseConfigured()) {
      return res.status(404).json({
        error: 'Attachment not found or has expired.',
        code: 'ATTACHMENT_NOT_FOUND'
      });
    }

    const lookup = await findAttachmentPathInStorage(authenticatedUserId, rawChatId, fileId);
    if (lookup.error && lookup.status && lookup.status !== 404) {
      return res.status(lookup.status).json({
        error: lookup.error,
        code: lookup.code || 'LOOKUP_FAILED'
      });
    }

    if (!lookup.found || !lookup.path) {
      return res.status(404).json({
        error: 'Attachment not found or has expired.',
        code: 'ATTACHMENT_NOT_FOUND'
      });
    }

    const downloadResult = await downloadAttachmentFromStorage(lookup.path, {
      requestingUserId: authenticatedUserId
    });

    if (!downloadResult.success || !downloadResult.data) {
      if (downloadResult.status === 403 || downloadResult.code === 'STORAGE_ACCESS_DENIED') {
        return res.status(403).json({
          error: 'Access denied: You do not have permission to access attachments belonging to another user.',
          code: 'STORAGE_ACCESS_DENIED'
        });
      }
      return res.status(404).json({
        error: 'Attachment not found or has expired.',
        code: 'ATTACHMENT_NOT_FOUND'
      });
    }

    const ext = path.extname(lookup.filename || '').toLowerCase();
    let decodedStorage: ReturnType<typeof decodeSupabaseBufferIfEnvelope>;
    try {
      decodedStorage = decodeSupabaseBufferIfEnvelope(
        downloadResult.data,
        ext,
        downloadResult.mimeType
      );
    } catch (decodeErr: any) {
      return res.status(422).json({
        error: decodeErr?.message || 'Stored attachment envelope is invalid.',
        code: decodeErr?.code || 'CORRUPTED_STORAGE_OBJECT'
      });
    }

    const decodedBuffer = decodedStorage.buffer;
    const mimeType =
      decodedStorage.mimeType ||
      (ALLOWED_EXTENSIONS_MAP[ext] && ALLOWED_EXTENSIONS_MAP[ext][0]) ||
      'application/octet-stream';
    const isImg =
      ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.heic', '.heif'].includes(ext) ||
      Boolean(mimeType.startsWith('image/'));
    const originalName = lookup.filename || 'attachment';
    const isOfflineReq = req.query?.offline === 'true';
    const geminiKey = getGeminiApiKey() || null;

    const rawLang = String(req.query.lang || req.query.language || 'eng').toLowerCase().trim();
    const validLangs = ['eng', 'spa', 'fra', 'deu', 'ara', 'urd'];
    const lang = validLangs.includes(rawLang) ? rawLang : 'eng';

    if (isImg) {
      const imgExtraction = await extractImageText(
        decodedBuffer,
        originalName,
        ext,
        mimeType,
        fileId,
        undefined,
        geminiKey,
        { offline: isOfflineReq, language: lang }
      );
      return res.json(imgExtraction);
    }

    const extraction = (await extractDocumentContent(
      decodedBuffer,
      originalName,
      ext,
      mimeType,
      fileId,
      { offline: isOfflineReq, apiKey: geminiKey }
    )) as DocumentExtractionResult;
    return res.json(extraction);
  });

  // Dedicated Attachment File Serving, Preview & Download Endpoint
  app.get(
    [
      '/api/upload/:id/file',
      '/upload/:id/file',
      '/api/upload/:id/download',
      '/upload/:id/download',
      '/api/upload/:id/preview',
      '/upload/:id/preview'
    ],
    async (req, res) => {
      const fileId = req.params.id;
      if (!fileId || (!/^[0-9a-fA-F-]{36}$/.test(fileId) && !/^gen-[a-zA-Z0-9_-]{10,80}$/.test(fileId))) {
        return res.status(400).json({ error: 'Invalid attachment ID format.', code: 'INVALID_ID_FORMAT' });
      }

      const signedCheck = verifySignedDecodeQuery(req, fileId);
      if (signedCheck.hasSignature && !signedCheck.valid) {
        return res.status(signedCheck.status).json({
          error: signedCheck.error,
          code: signedCheck.code
        });
      }

      const rawChatId = (
        signedCheck.hasSignature && signedCheck.valid
          ? signedCheck.chatId
          : (typeof req.query.chatId === 'string' ? req.query.chatId : '')
      ).trim();
      const record = fileRegistry.get(fileId);

      if (record) {
        // For every Supabase-backed attachment, require a non-empty record.userId and valid authorization.
        if (record.storageProvider === 'supabase' && !record.userId) {
          return res.status(403).json({
            error: 'Access denied: Attachment is missing required ownership metadata.',
            code: 'STORAGE_ACCESS_DENIED'
          });
        }

        let authenticatedUserId: string | null = null;
        if (signedCheck.hasSignature && signedCheck.valid) {
          if (req.headers.authorization) {
            const authStatus = await authenticateRequest(req);
            if (authStatus.status !== 'authenticated' || authStatus.userId !== signedCheck.uid) {
              return res.status(403).json({
                error: 'Access denied: Signed URL does not belong to authenticated user.',
                code: 'STORAGE_ACCESS_DENIED'
              });
            }
          }
          if (record.userId && record.userId !== signedCheck.uid) {
            return res.status(403).json({
              error: 'Access denied: You do not have permission to access attachments belonging to another user.',
              code: 'STORAGE_ACCESS_DENIED'
            });
          }
          if (record.conversationId && record.conversationId !== signedCheck.chatId) {
            return res.status(403).json({
              error: 'Access denied: Signed URL conversation mismatch.',
              code: 'STORAGE_ACCESS_DENIED'
            });
          }
          authenticatedUserId = signedCheck.uid;
        } else if (record.storageProvider === 'supabase' || record.userId) {
          const authStatus = await authenticateRequest(req);
          if (authStatus.status === 'invalid') {
            return res.status(401).json({
              error: `Authentication failed: ${authStatus.error}`,
              code: authStatus.code || 'INVALID_TOKEN'
            });
          }
          if (authStatus.status === 'guest') {
            return res.status(401).json({
              error: 'Authentication required to access this attachment.',
              code: 'AUTH_REQUIRED'
            });
          }
          if (authStatus.userId !== record.userId) {
            return res.status(403).json({
              error: 'Access denied: You do not have permission to access attachments belonging to another user.',
              code: 'STORAGE_ACCESS_DENIED'
            });
          }
          authenticatedUserId = authStatus.userId;
        }

        const diskFilename = record.diskFilename;
        const ext = path.extname(diskFilename || record.originalName || '').toLowerCase();
        const originalName = record.originalName || 'document';
        let mimeType = record.mimeType || 'application/octet-stream';

        const forceDownload =
          req.query.download === 'true' ||
          req.path.includes('/download') ||
          req.query.action === 'download' ||
          (signedCheck.hasSignature && signedCheck.valid && signedCheck.dl === '1');

        const isInline =
          !forceDownload &&
          (mimeType === 'application/pdf' ||
            mimeType.startsWith('text/') ||
            mimeType.startsWith('image/'));

        const safeFilename = path.basename(originalName).replace(/[/\\?%*:|"<>]/g, '_');
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('Content-Type', mimeType);
        res.setHeader(
          'Content-Disposition',
          `${isInline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(safeFilename)}"; filename*=UTF-8''${encodeURIComponent(safeFilename)}`
        );

        // 1. Retrieve authenticated users' files from private Supabase Storage if configured and stored in cloud
        if (record.storageProvider === 'supabase' && record.storagePath) {
          try {
            const downloadResult = await downloadAttachmentFromStorage(record.storagePath, {
              requestingUserId: authenticatedUserId || undefined,
              bucket: record.storageBucket
            });

            if (downloadResult.success && downloadResult.data) {
              let decodedStorage: ReturnType<typeof decodeSupabaseBufferIfEnvelope>;
              try {
                decodedStorage = decodeSupabaseBufferIfEnvelope(
                  downloadResult.data,
                  ext,
                  downloadResult.mimeType || record.mimeType
                );
              } catch (decodeErr: any) {
                return res.status(422).json({
                  error: decodeErr?.message || 'Stored attachment envelope is corrupted or invalid.',
                  code: decodeErr?.code || 'CORRUPTED_STORAGE_OBJECT'
                });
              }

              const finalMime =
                (decodedStorage.encoded ? decodedStorage.mimeType : null) ||
                (downloadResult.mimeType && downloadResult.mimeType !== 'application/octet-stream'
                  ? downloadResult.mimeType
                  : null) ||
                mimeType;
              res.setHeader('Content-Type', finalMime);
              res.setHeader('Content-Length', String(decodedStorage.buffer.length));
              return res.send(decodedStorage.buffer);
            }

            if (downloadResult.status === 403 || downloadResult.code === 'STORAGE_ACCESS_DENIED') {
              return res.status(403).json({
                error: 'Access denied: You do not have permission to access attachments belonging to another user.',
                code: 'STORAGE_ACCESS_DENIED'
              });
            }

            console.warn(`[Storage] Supabase download unsuccessful for ${record.id}:`, downloadResult.error);
          } catch (storageErr: any) {
            console.warn(`[Storage] Exception downloading attachment from Supabase (${record.id}):`, storageErr?.message || storageErr);
          }
        }

        // 2. Direct in-memory buffer serving (guest/offline or local fallback)
        if (record.buffer) {
          res.setHeader('Content-Length', String(record.buffer.length));
          return res.send(record.buffer);
        }

        // 3. Disk-based fallback: strictly for verified in-registry records
        if (diskFilename) {
          const resolvedUploadDir = path.resolve(UPLOAD_DIR);
          const resolvedFilePath = path.resolve(UPLOAD_DIR, path.basename(diskFilename));
          if (!resolvedFilePath.startsWith(resolvedUploadDir + path.sep)) {
            return res.status(403).json({ error: 'Access denied: invalid file path.', code: 'INVALID_PATH' });
          }

          if (fs.existsSync(resolvedFilePath)) {
            return res.sendFile(resolvedFilePath);
          }
        }

        return res.status(404).json({ error: 'Attachment file not found or has expired.', code: 'ATTACHMENT_NOT_FOUND' });
      }

      // When record is NOT found in fileRegistry (e.g. server restart or signed decoding link)
      let authenticatedUserId: string;
      if (signedCheck.hasSignature && signedCheck.valid) {
        if (req.headers.authorization) {
          const authStatus = await authenticateRequest(req);
          if (authStatus.status !== 'authenticated' || authStatus.userId !== signedCheck.uid) {
            return res.status(403).json({
              error: 'Access denied: Signed URL does not belong to authenticated user.',
              code: 'STORAGE_ACCESS_DENIED'
            });
          }
        }
        authenticatedUserId = signedCheck.uid;
      } else {
        const authStatus = await authenticateRequest(req);
        if (authStatus.status === 'invalid') {
          return res.status(401).json({
            error: `Authentication failed: ${authStatus.error}`,
            code: authStatus.code || 'INVALID_TOKEN'
          });
        }
        if (authStatus.status === 'guest') {
          if (rawChatId) {
            return res.status(401).json({
              error: 'Authentication required to access this attachment.',
              code: 'AUTH_REQUIRED'
            });
          }
          return res.status(404).json({
            error: 'Attachment file not found or has expired.',
            code: 'ATTACHMENT_NOT_FOUND'
          });
        }
        authenticatedUserId = authStatus.userId;
      }

      if (!rawChatId) {
        if (req.query.chatId !== undefined) {
          return res.status(400).json({
            error: 'Missing required chatId parameter to retrieve attachment.',
            code: 'MISSING_CHAT_ID'
          });
        }
        return res.status(404).json({
          error: 'Attachment file not found or has expired.',
          code: 'ATTACHMENT_NOT_FOUND'
        });
      }
      if (!isValidPathSegment(rawChatId)) {
        return res.status(400).json({
          error: 'Invalid chatId format.',
          code: 'INVALID_PATH_SEGMENT'
        });
      }

      if (!isSupabaseConfigured()) {
        return res.status(404).json({
          error: 'Attachment file not found or has expired.',
          code: 'ATTACHMENT_NOT_FOUND'
        });
      }

      const lookup = await findAttachmentPathInStorage(authenticatedUserId, rawChatId, fileId);
      if (lookup.error && lookup.status && lookup.status !== 404) {
        return res.status(lookup.status).json({
          error: lookup.error,
          code: lookup.code || 'LOOKUP_FAILED'
        });
      }

      if (!lookup.found || !lookup.path) {
        return res.status(404).json({
          error: 'Attachment file not found or has expired.',
          code: 'ATTACHMENT_NOT_FOUND'
        });
      }

      const downloadResult = await downloadAttachmentFromStorage(lookup.path, {
        requestingUserId: authenticatedUserId
      });

      if (!downloadResult.success || !downloadResult.data) {
        if (downloadResult.status === 403 || downloadResult.code === 'STORAGE_ACCESS_DENIED') {
          return res.status(403).json({
            error: 'Access denied: You do not have permission to access attachments belonging to another user.',
            code: 'STORAGE_ACCESS_DENIED'
          });
        }
        return res.status(404).json({
          error: 'Attachment file not found or has expired.',
          code: 'ATTACHMENT_NOT_FOUND'
        });
      }

      const ext = path.extname(lookup.filename || '').toLowerCase();
      let decodedStorage: ReturnType<typeof decodeSupabaseBufferIfEnvelope>;
      try {
        decodedStorage = decodeSupabaseBufferIfEnvelope(
          downloadResult.data,
          ext,
          downloadResult.mimeType
        );
      } catch (decodeErr: any) {
        return res.status(422).json({
          error: decodeErr?.message || 'Stored attachment envelope is corrupted or invalid.',
          code: decodeErr?.code || 'CORRUPTED_STORAGE_OBJECT'
        });
      }

      const mimeType = decodedStorage.mimeType;
      const forceDownload =
        req.query.download === 'true' ||
        req.path.includes('/download') ||
        req.query.action === 'download' ||
        (signedCheck.hasSignature && signedCheck.valid && signedCheck.dl === '1');

      const isInline =
        !forceDownload &&
        (mimeType === 'application/pdf' ||
          mimeType.startsWith('text/') ||
          mimeType.startsWith('image/'));

      const originalName = lookup.filename || 'attachment';
      const safeFilename = path.basename(originalName).replace(/[/\\?%*:|"<>]/g, '_');
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Content-Type', mimeType);
      res.setHeader('Content-Length', String(decodedStorage.buffer.length));
      res.setHeader(
        'Content-Disposition',
        `${isInline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(safeFilename)}"; filename*=UTF-8''${encodeURIComponent(safeFilename)}`
      );

      return res.send(decodedStorage.buffer);
    }
  );

  // Dedicated Pre-Signed URL Generation Endpoint (Short-lived, max 120s)
  app.get(['/api/upload/:id/signed-url', '/upload/:id/signed-url'], async (req, res) => {
    const fileId = req.params.id;
    if (!fileId || !/^[0-9a-fA-F-]{36}$/.test(fileId)) {
      return res.status(400).json({ error: 'Invalid attachment ID format.', code: 'INVALID_ID_FORMAT' });
    }

    const rawChatId = (typeof req.query.chatId === 'string' ? req.query.chatId : '').trim();
    const record = fileRegistry.get(fileId);

    if (record) {
      if (record.storageProvider !== 'supabase' || !record.storagePath) {
        return res.status(400).json({
          error: 'Pre-signed URLs are only available for attachments stored in Supabase cloud storage.',
          code: 'NOT_CLOUD_STORAGE'
        });
      }

      // For every Supabase-backed attachment, require a non-empty record.userId and successful Firebase authentication.
      if (!record.userId) {
        return res.status(403).json({
          error: 'Access denied: Attachment is missing required ownership metadata.',
          code: 'STORAGE_ACCESS_DENIED'
        });
      }

      const authStatus = await authenticateRequest(req);
      if (authStatus.status === 'invalid') {
        return res.status(401).json({
          error: `Authentication failed: ${authStatus.error}`,
          code: authStatus.code || 'INVALID_TOKEN'
        });
      }
      if (authStatus.status === 'guest') {
        return res.status(401).json({
          error: 'Authentication required to generate signed URL.',
          code: 'AUTH_REQUIRED'
        });
      }
      if (authStatus.userId !== record.userId) {
        return res.status(403).json({
          error: 'Access denied: You do not have permission to access attachments belonging to another user.',
          code: 'STORAGE_ACCESS_DENIED'
        });
      }
      const authenticatedUserId = authStatus.userId;
      const forceDownload = req.query.download === 'true' || req.query.action === 'download';

      // Encoded objects must NEVER expose raw Supabase storage URLs; return a short-lived signed decoding URL instead.
      if (record.storageEncoding === ORVIX_ENVELOPE_ENCODING_ID) {
        const parsed = parseStoragePath(record.storagePath);
        const effectiveChat = record.conversationId || parsed.chatId || rawChatId;
        if (!effectiveChat) {
          return res.status(400).json({
            error: 'Missing required chatId parameter to generate decoding signed URL.',
            code: 'MISSING_CHAT_ID'
          });
        }
        try {
          const safeSigned = createSignedDecodeUrl(req, {
            fileId,
            userId: authenticatedUserId,
            chatId: effectiveChat,
            expiresInSeconds: 120,
            forceDownload
          });
          return res.json({
            success: true,
            signedUrl: safeSigned.signedUrl,
            expiresInSeconds: safeSigned.expiresInSeconds,
            decodingProxy: true
          });
        } catch (signErr: any) {
          return res.status(500).json({
            error: 'Signed URL generation is unavailable due to a server configuration error.',
            code: signErr?.code === 'SIGNED_URL_SECRET_INVALID' ? 'SIGNED_URL_MISCONFIGURED' : 'SIGNED_URL_FAILED'
          });
        }
      }

      const signedResult = await createAttachmentSignedUrl(record.storagePath, {
        requestingUserId: authenticatedUserId || undefined,
        expiresInSeconds: 120,
        download: forceDownload ? record.originalName : undefined,
        bucket: record.storageBucket
      });

      if (!signedResult.success || !signedResult.signedUrl) {
        return res.status(signedResult.status || 500).json({
          error: 'Failed to generate pre-signed URL for attachment.',
          code: signedResult.code || 'SIGNED_URL_FAILED'
        });
      }

      return res.json({
        success: true,
        signedUrl: signedResult.signedUrl,
        expiresInSeconds: 120
      });
    }

    // When record is missing from fileRegistry (e.g. server restart)
    const authStatus = await authenticateRequest(req);
    if (authStatus.status === 'invalid') {
      return res.status(401).json({
        error: `Authentication failed: ${authStatus.error}`,
        code: authStatus.code || 'INVALID_TOKEN'
      });
    }
    if (authStatus.status === 'guest') {
      return res.status(401).json({
        error: 'Authentication required to generate signed URL.',
        code: 'AUTH_REQUIRED'
      });
    }

    const authenticatedUserId = authStatus.userId;

    if (!rawChatId) {
      return res.status(400).json({
        error: 'Missing required chatId parameter to generate signed URL.',
        code: 'MISSING_CHAT_ID'
      });
    }
    if (!isValidPathSegment(rawChatId)) {
      return res.status(400).json({
        error: 'Invalid chatId format.',
        code: 'INVALID_PATH_SEGMENT'
      });
    }

    if (!isSupabaseConfigured()) {
      return res.status(503).json({
        error: 'Supabase storage is not configured on this server.',
        code: 'STORAGE_UNCONFIGURED'
      });
    }

    const lookup = await findAttachmentPathInStorage(authenticatedUserId, rawChatId, fileId);
    if (lookup.error && lookup.status && lookup.status !== 404) {
      return res.status(lookup.status).json({
        error: lookup.error,
        code: lookup.code || 'LOOKUP_FAILED'
      });
    }

    if (!lookup.found || !lookup.path) {
      return res.status(404).json({
        error: 'Attachment not found or has expired.',
        code: 'ATTACHMENT_NOT_FOUND'
      });
    }

    const forceDownload = req.query.download === 'true' || req.query.action === 'download';
    const ext = path.extname(lookup.filename || lookup.path || '').toLowerCase();

    // Post-restart safety check: inspect target formats in Supabase before issuing a direct URL so encoded objects never leak raw envelopes
    if (isTransparentStorageCompressionSupported({ extension: ext })) {
      const probeDownload = await downloadAttachmentFromStorage(lookup.path, {
        requestingUserId: authenticatedUserId
      });
      if (probeDownload.success && probeDownload.data && isOrvixStorageEnvelope(probeDownload.data)) {
        try {
          decodeOrvixStorageEnvelopeSync(probeDownload.data, {
            maxOriginalBytes: MAX_FILE_SIZE_BYTES,
            expectedExtension: ext
          });
        } catch (decodeErr: any) {
          return res.status(422).json({
            error: decodeErr?.message || 'Stored attachment envelope is corrupted or invalid.',
            code: decodeErr?.code || 'CORRUPTED_STORAGE_OBJECT'
          });
        }
        try {
          const safeSigned = createSignedDecodeUrl(req, {
            fileId,
            userId: authenticatedUserId,
            chatId: rawChatId,
            expiresInSeconds: 120,
            forceDownload
          });
          return res.json({
            success: true,
            signedUrl: safeSigned.signedUrl,
            expiresInSeconds: safeSigned.expiresInSeconds,
            decodingProxy: true
          });
        } catch (signErr: any) {
          return res.status(500).json({
            error: 'Signed URL generation is unavailable due to a server configuration error.',
            code: signErr?.code === 'SIGNED_URL_SECRET_INVALID' ? 'SIGNED_URL_MISCONFIGURED' : 'SIGNED_URL_FAILED'
          });
        }
      }
    }

    const signedResult = await createAttachmentSignedUrl(lookup.path, {
      requestingUserId: authenticatedUserId,
      expiresInSeconds: 120,
      download: forceDownload ? (lookup.filename || 'attachment') : undefined
    });

    if (!signedResult.success || !signedResult.signedUrl) {
      return res.status(signedResult.status || 500).json({
        error: 'Failed to generate pre-signed URL for attachment.',
        code: signedResult.code || 'SIGNED_URL_FAILED'
      });
    }

    return res.json({
      success: true,
      signedUrl: signedResult.signedUrl,
      expiresInSeconds: 120
    });
  });

  
  // Helper to unlink local disk attachment files matching fileId exactly or with extension
  async function unlinkLocalAttachmentFiles(fileId: string) {
    try {
      const files = await fs.promises.readdir(UPLOAD_DIR);
      for (const fname of files) {
        if (fname === fileId || fname.startsWith(`${fileId}.`)) {
          const safePath = path.resolve(UPLOAD_DIR, path.basename(fname));
          if (safePath.startsWith(path.resolve(UPLOAD_DIR) + path.sep)) {
            await fs.promises.unlink(safePath).catch(() => {});
          }
        }
      }
    } catch (_) {}
  }

  // Conversation Attachments Bulk Deletion Endpoint
  app.delete(['/api/upload/conversations/:chatId', '/upload/conversations/:chatId'], async (req, res) => {
    const chatId = req.params.chatId;
    if (!chatId || !isValidPathSegment(chatId)) {
      return res.status(400).json({ error: 'Invalid chatId format.', code: 'INVALID_PATH_SEGMENT' });
    }

    // 1. Authenticate request using authenticateRequest and verified Firebase identity
    const authStatus = await authenticateRequest(req);
    if (authStatus.status === 'invalid') {
      return res.status(401).json({
        error: `Authentication failed: ${authStatus.error}`,
        code: authStatus.code || 'INVALID_TOKEN'
      });
    }
    if (authStatus.status === 'guest') {
      return res.status(401).json({
        error: 'Authentication required to delete conversation attachments.',
        code: 'AUTH_REQUIRED'
      });
    }

    const authenticatedUserId = authStatus.userId;

    // 2. Clear conversation records from in-memory maps and disk for this user
    if (conversationDocuments.has(chatId)) {
      const fileIds = conversationDocuments.get(chatId)!;
      for (const fileId of fileIds) {
        const rec = fileRegistry.get(fileId);
        if (rec && (!rec.userId || rec.userId === authenticatedUserId)) {
          fileRegistry.delete(fileId);
          await unlinkLocalAttachmentFiles(fileId);
        }
      }
      conversationDocuments.delete(chatId);
    }

    // 3. Delete from Supabase Storage with pagination support
    let deletedCount = 0;
    if (isSupabaseConfigured()) {
      const deleteResult = await deleteAttachmentsForChatInStorage(
        authenticatedUserId,
        chatId,
        authenticatedUserId
      );

      if (!deleteResult.success) {
        if (deleteResult.code === 'STORAGE_ACCESS_DENIED' || deleteResult.status === 403) {
          return res.status(403).json({
            error: deleteResult.error || 'Access denied: You do not have permission to delete these attachments.',
            code: 'STORAGE_ACCESS_DENIED'
          });
        }
        return res.status(deleteResult.status || 500).json({
          error: deleteResult.error || 'Failed to delete conversation attachments from storage.',
          code: deleteResult.code || 'DELETE_FAILED',
          deletedCount: deleteResult.deletedCount
        });
      }

      deletedCount = deleteResult.deletedCount;
    }

    return res.status(200).json({
      success: true,
      chatId,
      deletedCount
    });
  });

  // Upload Deletion Endpoint (Individual Attachment)
  app.delete(['/api/upload/:id', '/upload/:id'], async (req, res) => {
    const fileId = req.params.id;
    if (!fileId || !/^[0-9a-fA-F-]{36}$/.test(fileId)) {
      return res.status(400).json({ error: 'Invalid attachment ID format.', code: 'INVALID_ID_FORMAT' });
    }

    const record = fileRegistry.get(fileId);
    const rawChatId = (typeof req.query.chatId === 'string' ? req.query.chatId : typeof req.body?.chatId === 'string' ? req.body.chatId : '').trim();
    const rawStoragePath = (typeof req.query.storagePath === 'string' ? req.query.storagePath : typeof req.body?.storagePath === 'string' ? req.body.storagePath : '').trim();

    // Check if this is a cloud deletion request
    const isCloudTarget = Boolean(
      (record && (record.storageProvider === 'supabase' || record.userId)) ||
      rawStoragePath ||
      rawChatId
    );

    if (isCloudTarget) {
      // 1. Authenticate request using cryptographically verified Firebase ID token
      const authStatus = await authenticateRequest(req);
      if (authStatus.status === 'invalid') {
        return res.status(401).json({
          error: `Authentication failed: ${authStatus.error}`,
          code: authStatus.code || 'INVALID_TOKEN'
        });
      }
      if (authStatus.status === 'guest') {
        return res.status(401).json({
          error: 'Authentication required to delete cloud attachment.',
          code: 'AUTH_REQUIRED'
        });
      }

      const authenticatedUserId = authStatus.userId;

      // 2. Ownership check if record exists in memory with a userId
      if (record?.userId && record.userId !== authenticatedUserId) {
        return res.status(403).json({
          error: 'Access denied: You do not have permission to delete attachments belonging to another user.',
          code: 'STORAGE_ACCESS_DENIED'
        });
      }

      // 3. Supabase deletion (if Supabase is configured)
      if (isSupabaseConfigured()) {
        const storagePath = record?.storagePath || rawStoragePath;

        if (storagePath) {
          try {
            const deleteResult = await deleteAttachmentFromStorage(storagePath, {
              requestingUserId: authenticatedUserId
            });
            if (!deleteResult.success) {
              if (deleteResult.code === 'STORAGE_ACCESS_DENIED' || deleteResult.status === 403) {
                return res.status(403).json({
                  error: deleteResult.error || 'Access denied.',
                  code: 'STORAGE_ACCESS_DENIED'
                });
              }
              return res.status(deleteResult.status || 500).json({
                error: deleteResult.error || 'Failed to delete attachment from storage.',
                code: deleteResult.code || 'DELETE_FAILED'
              });
            }
          } catch (err: any) {
            return res.status(err?.status || 500).json({
              error: err?.message || 'Storage deletion error.',
              code: err?.code || 'DELETE_ERROR'
            });
          }
        } else if (rawChatId) {
          // Empty fileRegistry fallback: resolve attachment through authenticated user's own folder
          if (!isValidPathSegment(rawChatId)) {
            return res.status(400).json({ error: 'Invalid chatId format.', code: 'INVALID_PATH_SEGMENT' });
          }

          const lookup = await findAttachmentPathInStorage(authenticatedUserId, rawChatId, fileId);
          if (lookup.error && lookup.status && lookup.status !== 404) {
            return res.status(lookup.status).json({
              error: lookup.error,
              code: lookup.code || 'LOOKUP_FAILED'
            });
          }

          if (lookup.found && lookup.path) {
            const deleteResult = await deleteAttachmentFromStorage(lookup.path, {
              requestingUserId: authenticatedUserId
            });
            if (!deleteResult.success) {
              return res.status(deleteResult.status || 500).json({
                error: deleteResult.error || 'Failed to delete attachment from storage.',
                code: deleteResult.code || 'DELETE_FAILED'
              });
            }
          }
          // Idempotent: if lookup.found is false, file was already deleted or not present
        }
      }

      // Clean local in-memory registry & disk
      fileRegistry.delete(fileId);
      if (record?.conversationId && conversationDocuments.has(record.conversationId)) {
        conversationDocuments.get(record.conversationId)!.delete(fileId);
      }
      await unlinkLocalAttachmentFiles(fileId);

      return res.status(200).json({ success: true, id: fileId });
    }

    // Unauthenticated local/guest deletion path (preserves existing local behavior)
    // If an Authorization header is provided anyway, check ownership if record has a userId
    if (req.headers.authorization) {
      const authStatus = await authenticateRequest(req);
      if (authStatus.status === 'authenticated' && record?.userId && record.userId !== authStatus.userId) {
        return res.status(403).json({
          error: 'Access denied: You do not have permission to delete attachments belonging to another user.',
          code: 'STORAGE_ACCESS_DENIED'
        });
      }
    }

    fileRegistry.delete(fileId);
    if (record?.conversationId && conversationDocuments.has(record.conversationId)) {
      conversationDocuments.get(record.conversationId)!.delete(fileId);
    }
    await unlinkLocalAttachmentFiles(fileId);

    return res.status(200).json({ success: true, id: fileId });
  });

  // Enforce authentication across all /api/upload/direct/* and /upload/direct/* endpoints
  app.use(['/api/upload/direct', '/upload/direct'], async (req, res, next) => {
    const authenticatedUserId = await requireUploadAuthentication(
      req,
      res,
      'Authentication required for direct cloud upload.'
    );
    if (!authenticatedUserId) {
      return;
    }
    (req as any).authenticatedUploadUserId = authenticatedUserId;
    next();
  });

  // Direct Supabase Upload: Create Short-Lived Signed Upload URL
  app.post(['/api/upload/direct/signed-url', '/upload/direct/signed-url'], async (req, res) => {
    opportunisticDirectUploadPrune();

    const authenticatedUserId =
      (req as any).authenticatedUploadUserId ||
      (await requireUploadAuthentication(req, res, 'Authentication required for direct cloud upload.'));
    if (!authenticatedUserId) {
      return;
    }

    if (!isSupabaseConfigured()) {
      return res.status(503).json({
        error: 'Cloud storage is not configured on this server.',
        code: 'STORAGE_UNCONFIGURED'
      });
    }

    const rawChatId = req.body?.chatId ?? req.body?.conversationId;
    const chatId = typeof rawChatId === 'string' ? rawChatId.trim() : '';
    if (!chatId || !isValidPathSegment(chatId) || chatId.toLowerCase() === 'staging') {
      return res.status(400).json({
        error: 'A valid conversationId is required for direct upload.',
        code: 'INVALID_CONVERSATION_ID'
      });
    }

    const rawFileName = req.body?.fileName ?? req.body?.filename ?? req.body?.name;
    if (typeof rawFileName !== 'string' || !rawFileName.trim()) {
      return res.status(400).json({
        error: 'A valid fileName is required.',
        code: 'MISSING_FILENAME'
      });
    }
    const safeBaseName = path.basename(rawFileName)
      .replace(/[\0\r\n\t]/g, '')
      .replace(/[/\\?%*:|"<>]/g, '_')
      .trim()
      .slice(0, 150) || 'attachment';

    const ext = path.extname(safeBaseName).toLowerCase();
    if (!ext || !ALLOWED_EXTENSIONS_MAP[ext]) {
      return res.status(400).json({
        error: `File '${safeBaseName}' has an unsupported file format.`,
        code: 'INVALID_FILE_TYPE'
      });
    }

    const mimeType = typeof req.body?.mimeType === 'string' ? req.body.mimeType.trim().toLowerCase() : '';
    if (mimeType) {
      if (
        mimeType.includes('javascript') ||
        mimeType.includes('executable') ||
        mimeType.includes('x-sh') ||
        mimeType.includes('x-msdownload') ||
        mimeType.includes('x-dosexec')
      ) {
        return res.status(400).json({
          error: `MIME type '${mimeType}' is not permitted.`,
          code: 'INVALID_MIME_TYPE'
        });
      }
    }

    const rawSize = req.body?.fileSize ?? req.body?.size;
    const fileSize = Number(rawSize);
    if (!Number.isFinite(fileSize) || fileSize <= 0) {
      return res.status(400).json({
        error: 'File size must be greater than 0 bytes.',
        code: 'EMPTY_FILE'
      });
    }
    if (fileSize > MAX_FILE_SIZE_BYTES) {
      return res.status(400).json({
        error: `File exceeds maximum allowed size of ${formatBytes(MAX_FILE_SIZE_BYTES)}.`,
        code: 'FILE_TOO_LARGE'
      });
    }

    const rawStorageEncoding = firstFieldValue(req.body?.storageEncoding);
    const rawOriginalSize = req.body?.originalSize;
    const rawOriginalMimeType = firstFieldValue(req.body?.originalMimeType);
    const rawStorageChecksum = firstFieldValue(req.body?.storageChecksum);

    let validatedOriginalSize: number | undefined;
    if (rawStorageEncoding) {
      if (rawStorageEncoding !== ORVIX_ENVELOPE_ENCODING_ID) {
        return res.status(400).json({
          error: `Unsupported storage encoding '${rawStorageEncoding}'.`,
          code: 'UNSUPPORTED_STORAGE_ENCODING'
        });
      }
      if (!isTransparentStorageCompressionSupported({ extension: ext })) {
        return res.status(400).json({
          error: `Storage encoding '${rawStorageEncoding}' is not supported for '${ext}' files.`,
          code: 'UNSUPPORTED_STORAGE_ENCODING'
        });
      }
      if (rawOriginalSize !== undefined && rawOriginalSize !== null && String(rawOriginalSize).trim() !== '') {
        const parsedOriginalSize = Number(rawOriginalSize);
        if (!Number.isFinite(parsedOriginalSize) || parsedOriginalSize <= 0) {
          return res.status(400).json({
            error: 'Original file size must be greater than 0 bytes.',
            code: 'INVALID_ORIGINAL_SIZE'
          });
        }
        if (parsedOriginalSize > MAX_FILE_SIZE_BYTES) {
          return res.status(400).json({
            error: `Original file exceeds maximum allowed size of ${formatBytes(MAX_FILE_SIZE_BYTES)}.`,
            code: 'FILE_TOO_LARGE'
          });
        }
        validatedOriginalSize = parsedOriginalSize;
      }
    }

    const quotaIdentity = buildAuthenticatedQuotaIdentity(authenticatedUserId);
    let quotaReservation: any;
    try {
      quotaReservation = await reserveUploadSlot(quotaIdentity);
    } catch (quotaErr: any) {
      console.error('[DirectUpload] Quota reservation failed:', quotaErr?.message || quotaErr);
      return res.status(500).json({
        error: 'Upload service temporarily unavailable due to storage configuration error.',
        code: 'QUOTA_SERVICE_UNAVAILABLE',
        status: 'SERVICE_UNAVAILABLE'
      });
    }

    if (!quotaReservation.allowed) {
      attachQuotaHeaders(
        res,
        {
          limit: quotaReservation.limit,
          remaining: quotaReservation.remaining,
          resetAt: quotaReservation.resetAt
        },
        quotaIdentity
      );
      return res.status(429).json({
        error: quotaReservation.error,
        code: 'QUOTA_EXCEEDED',
        status: 'QUOTA_EXCEEDED',
        limit: quotaReservation.limit,
        remaining: quotaReservation.remaining,
        resetAt: quotaReservation.resetAt
      });
    }

    const attachmentId = crypto.randomUUID();
    const extension = ext.replace('.', '').toLowerCase();
    const storagePath = buildAttachmentStoragePath(authenticatedUserId, chatId, attachmentId, extension);
    const bucket = getSupabaseBucket();

    const signRes = await createSignedUploadUrlForAttachment({
      userId: authenticatedUserId,
      chatId,
      attachmentId,
      extension,
      bucket,
      upsert: false
    });

    if (!signRes.success || !signRes.signedUrl) {
      let releasedStatus: QuotaStatus | null = null;
      try {
        releasedStatus = await releaseUploadSlot(quotaReservation.reservation);
      } catch (_) {}
      if (releasedStatus) {
        attachQuotaHeaders(res, releasedStatus, quotaIdentity);
      }
      return res.status(503).json({
        error: signRes.error || 'Failed to generate signed upload URL.',
        code: signRes.code || 'SIGNED_URL_FAILED'
      });
    }

    const defaultMime =
      ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.heic', '.heif'].includes(ext)
        ? `image/${extension}`
        : (ALLOWED_EXTENSIONS_MAP[ext]?.[0] || 'application/octet-stream');

    const ticket: PendingDirectUploadTicket = {
      ticketId: attachmentId,
      attachmentId,
      userId: authenticatedUserId,
      chatId,
      storagePath: signRes.path || storagePath,
      bucket: signRes.bucket || bucket,
      fileName: safeBaseName,
      extension: extension.toUpperCase(),
      mimeType: rawOriginalMimeType || mimeType || defaultMime,
      size: fileSize,
      ...(rawStorageEncoding
        ? {
            storageEncoding: rawStorageEncoding,
            originalSize: validatedOriginalSize,
            encodedSize: fileSize,
            originalMimeType: rawOriginalMimeType || mimeType || defaultMime,
            ...(rawStorageChecksum ? { storageChecksum: rawStorageChecksum } : {})
          }
        : {}),
      quotaReservation: quotaReservation.reservation,
      expiresAt: Date.now() + 15 * 60 * 1000,
      createdAt: Date.now(),
      isPermanent: String(req.body?.isPermanent || req.body?.permanent || '').toLowerCase() === 'true',
      status: 'pending'
    };
    try {
      await createDurableUploadTicket(ticket);
    } catch (ticketErr: any) {
      console.error('[DirectUpload] Durable ticket persistence failed:', ticketErr?.message || ticketErr);
      try {
        await releaseUploadSlot(quotaReservation.reservation);
      } catch (_) {}
      return res.status(503).json({
        error: 'Upload ticket persistence unavailable. Please try again later.',
        code: 'TICKET_PERSISTENCE_UNAVAILABLE',
        status: 'SERVICE_UNAVAILABLE'
      });
    }
    opportunisticDirectUploadPrune();

    attachQuotaHeaders(
      res,
      {
        limit: quotaReservation.limit,
        remaining: quotaReservation.remaining,
        resetAt: quotaReservation.resetAt
      },
      quotaIdentity
    );

    return res.status(200).json({
      success: true,
      signedUrl: signRes.signedUrl,
      token: signRes.token,
      storagePath: signRes.path || storagePath,
      attachmentId,
      bucket: signRes.bucket || bucket,
      expiresIn: 7200
    });
  });

  // Direct Supabase Upload: Authenticated Completion & Object Verification
  app.post(['/api/upload/direct/complete', '/upload/direct/complete'], async (req, res) => {
    const authenticatedUserId =
      (req as any).authenticatedUploadUserId ||
      (await requireUploadAuthentication(req, res, 'Authentication required to complete upload.'));
    if (!authenticatedUserId) {
      return;
    }

    const attachmentId = typeof req.body?.attachmentId === 'string' ? req.body.attachmentId.trim() : '';
    const rawChatId = req.body?.chatId ?? req.body?.conversationId;
    const chatId = typeof rawChatId === 'string' ? rawChatId.trim() : '';

    if (!attachmentId || !isValidPathSegment(attachmentId)) {
      return res.status(400).json({
        error: 'A valid attachmentId is required.',
        code: 'INVALID_ATTACHMENT_ID'
      });
    }

    if (!chatId || !isValidPathSegment(chatId)) {
      return res.status(400).json({
        error: 'A valid conversationId is required.',
        code: 'INVALID_CONVERSATION_ID'
      });
    }

    const quotaIdentity = buildAuthenticatedQuotaIdentity(authenticatedUserId);

    try {
    const claimResult = await claimDirectUploadTicketForCompletion(attachmentId, authenticatedUserId, chatId);
    if (!claimResult.success) {
      if (claimResult.isExpired && claimResult.ticket) {
        try {
          const cleanupRes = await failAndCleanupDurableUploadTicket(claimResult.ticket, 'EXPIRED');
          if (cleanupRes.quotaStatus) {
            attachQuotaHeaders(res, cleanupRes.quotaStatus, quotaIdentity);
          }
        } catch (cleanupErr: any) {
          console.error('[DirectUpload] Expired ticket durable cleanup failed:', cleanupErr?.message || cleanupErr);
          return res.status(503).json({
            error: 'Upload ticket persistence unavailable during expiration cleanup.',
            code: 'TICKET_PERSISTENCE_UNAVAILABLE',
            status: 'SERVICE_UNAVAILABLE'
          });
        }
      }
      return res.status(claimResult.status).json({
        error: claimResult.error,
        code: claimResult.code
      });
    }

    const ticket = claimResult.ticket!;

    // Verify object in Supabase Storage by downloading
    const downloadRes = await downloadAttachmentFromStorage(ticket.storagePath, {
      requestingUserId: authenticatedUserId,
      bucket: ticket.bucket
    });

    if (!downloadRes.success || !downloadRes.data) {
      const cleanupRes = await failAndCleanupDurableUploadTicket(ticket, 'OBJECT_NOT_FOUND');
      if (cleanupRes.quotaStatus) {
        attachQuotaHeaders(res, cleanupRes.quotaStatus, quotaIdentity);
      }
      return res.status(400).json({
        error: 'Uploaded object was not found in storage. Ensure the upload to the signed URL finished successfully before completing.',
        code: 'OBJECT_NOT_FOUND'
      });
    }

    const uploadedBuffer = downloadRes.data;
    const storedSize = uploadedBuffer.length;

    if (storedSize === 0) {
      const cleanupRes = await failAndCleanupDurableUploadTicket(ticket, 'EMPTY_FILE');
      if (cleanupRes.quotaStatus) {
        attachQuotaHeaders(res, cleanupRes.quotaStatus, quotaIdentity);
      }
      return res.status(400).json({
        error: 'Uploaded file is empty (0 bytes).',
        code: 'EMPTY_FILE'
      });
    }

    if (storedSize > MAX_FILE_SIZE_BYTES) {
      const cleanupRes = await failAndCleanupDurableUploadTicket(ticket, 'FILE_TOO_LARGE');
      if (cleanupRes.quotaStatus) {
        attachQuotaHeaders(res, cleanupRes.quotaStatus, quotaIdentity);
      }
      return res.status(400).json({
        error: `Uploaded file exceeds maximum allowed size of ${formatBytes(MAX_FILE_SIZE_BYTES)}.`,
        code: 'FILE_TOO_LARGE'
      });
    }

    const ext = '.' + ticket.extension.toLowerCase();
    const declaredEncoding = ticket.storageEncoding || firstFieldValue(req.body?.storageEncoding);
    const declaredOriginalSize = ticket.originalSize ?? req.body?.originalSize ?? null;
    const declaredOriginalMime = ticket.originalMimeType || firstFieldValue(req.body?.originalMimeType) || ticket.mimeType;
    const declaredChecksum = ticket.storageChecksum || firstFieldValue(req.body?.storageChecksum) || null;

    let unwrapped: ReturnType<typeof unwrapUploadedOrStoredPayload>;
    try {
      unwrapped = unwrapUploadedOrStoredPayload({
        buffer: uploadedBuffer,
        ext,
        clientMime: ticket.mimeType,
        declaredEncoding,
        declaredOriginalSize,
        declaredOriginalMimeType: declaredOriginalMime,
        declaredChecksum,
        maxOriginalBytes: MAX_FILE_SIZE_BYTES
      });
    } catch (envErr: any) {
      const errCode = envErr?.code || 'INVALID_STORAGE_ENVELOPE';
      const cleanupRes = await failAndCleanupDurableUploadTicket(ticket, errCode);
      if (cleanupRes.quotaStatus) {
        attachQuotaHeaders(res, cleanupRes.quotaStatus, quotaIdentity);
      }
      return res.status(400).json({
        error: envErr?.message || 'Invalid storage compression envelope.',
        code: errCode
      });
    }

    const decodedBuffer = unwrapped.decodedBuffer;
    const verifiedSize = decodedBuffer.length;
    const canonicalMime = unwrapped.canonicalMimeType || ticket.mimeType;

    const sigResult = await verifyFileSignature(decodedBuffer, ext);
    if (!sigResult.valid) {
      const cleanupRes = await failAndCleanupDurableUploadTicket(ticket, 'INVALID_FILE_SIGNATURE');
      if (cleanupRes.quotaStatus) {
        attachQuotaHeaders(res, cleanupRes.quotaStatus, quotaIdentity);
      }
      return res.status(400).json({
        error: sigResult.reason || 'Invalid file signature.',
        code: 'INVALID_FILE_SIGNATURE'
      });
    }

    let committedStatus: QuotaStatus;
    try {
      committedStatus = await commitUploadSlot(ticket.quotaReservation);
    } catch (commitErr: any) {
      const cleanupRes = await failAndCleanupDurableUploadTicket(ticket, 'QUOTA_EXCEEDED');
      if (commitErr?.code === 'QUOTA_EXCEEDED') {
        const statusForHeader = commitErr.currentDayStatus || cleanupRes.quotaStatus || {
          limit: DAILY_UPLOAD_LIMIT,
          remaining: typeof commitErr.remaining === 'number' ? commitErr.remaining : 0,
          resetAt: commitErr.resetAt || getNextPktMidnight().toISOString()
        };
        attachQuotaHeaders(res, statusForHeader, quotaIdentity);
        return res.status(429).json({
          error: commitErr.message || 'Daily attachment upload limit exceeded.',
          code: 'QUOTA_EXCEEDED',
          status: 'QUOTA_EXCEEDED',
          limit: statusForHeader.limit,
          remaining: statusForHeader.remaining,
          resetAt: statusForHeader.resetAt
        });
      }
      throw commitErr;
    }
    attachQuotaHeaders(res, committedStatus, quotaIdentity);

    const expiresAt = Date.now() + TEMP_FILE_TTL_MS;
    if (!ticket.isPermanent) {
      try {
        await saveDurableAttachmentExpiry({
          userId: authenticatedUserId,
          chatId: ticket.chatId,
          attachmentId: ticket.attachmentId,
          extension: ticket.extension.toLowerCase(),
          expiresAt,
          isPermanent: false,
          bucket: ticket.bucket
        });
      } catch (durableErr) {
        console.warn('[DirectUpload] Notice: Could not save durable expiry metadata:', durableErr);
      }
    }

    const isImg =
      ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.heic', '.heif'].includes(ext) ||
      canonicalMime.startsWith('image/');

    let extraction: any = null;
    const geminiKey = getGeminiApiKey() || null;
    try {
      if (isImg) {
        extraction = await extractImageText(
          decodedBuffer,
          ticket.fileName,
          ext,
          canonicalMime,
          ticket.attachmentId,
          sigResult.dimensions,
          geminiKey,
          { offline: false }
        );
      } else {
        extraction = await extractDocumentContent(
          decodedBuffer,
          ticket.fileName,
          ext,
          canonicalMime,
          ticket.attachmentId,
          { offline: false, apiKey: geminiKey }
        );
      }
    } catch (extErr) {
      console.warn('[DirectUpload] Extraction error:', extErr);
    }

    const diskFilename = `${ticket.attachmentId}${ext}`;
    try {
      const fullDiskPath = path.join(UPLOAD_DIR, diskFilename);
      fs.writeFile(fullDiskPath, decodedBuffer, () => {});
    } catch (_) {}

    const record: UploadedFileRecord = {
      id: ticket.attachmentId,
      originalName: ticket.fileName,
      diskFilename,
      mimeType: canonicalMime,
      extension: ticket.extension,
      size: verifiedSize,
      formattedSize: formatBytes(verifiedSize),
      status: isImg ? 'ready' : (extraction?.success || extraction?.status === 'ready' || extraction?.status === 'scanned_or_image_only' || extraction?.status === 'NO_TEXT_DETECTED' ? 'ready' : 'uploaded'),
      uploadedAt: new Date().toISOString(),
      expiresAt,
      conversationId: ticket.chatId,
      userId: authenticatedUserId,
      isPermanent: ticket.isPermanent,
      storageProvider: 'supabase',
      storagePath: ticket.storagePath,
      storageBucket: ticket.bucket,
      storageEncoding: unwrapped.storageEncoding,
      storedSize: unwrapped.storedSize,
      ...(unwrapped.storageChecksum ? { storageChecksum: unwrapped.storageChecksum } : {}),
      isImage: isImg,
      dimensions: sigResult.dimensions,
      extraction,
      buffer: decodedBuffer
    };

    fileRegistry.set(ticket.attachmentId, record);
    let docSet = conversationDocuments.get(ticket.chatId);
    if (!docSet) {
      docSet = new Set<string>();
      conversationDocuments.set(ticket.chatId, docSet);
    }
    docSet.add(ticket.attachmentId);

    try {
      await finalizeCompletedDirectUploadTicket(attachmentId);
    } catch (finalizeErr: any) {
      console.error('[DirectUpload] Failed to finalize durable ticket in Firestore:', finalizeErr?.message || finalizeErr);
      return res.status(503).json({
        error: 'Upload ticket persistence unavailable while finalizing upload.',
        code: 'TICKET_PERSISTENCE_UNAVAILABLE',
        status: 'SERVICE_UNAVAILABLE'
      });
    }

    const serializedAtt = serializeRegisteredAttachment(record);

    return res.status(200).json({
      success: true,
      count: 1,
      attachments: [serializedAtt],
      attachment: serializedAtt,
      quota: committedStatus
    });
    } catch (routeErr: any) {
      console.error('[DirectUpload] Complete failed due to persistence/service error:', routeErr?.message || routeErr);
      if (res.headersSent) return;
      return res.status(503).json({
        error: 'Upload ticket persistence unavailable. Please try again later.',
        code: 'TICKET_PERSISTENCE_UNAVAILABLE',
        status: 'SERVICE_UNAVAILABLE'
      });
    }
  });

  // Direct Supabase Upload: Cancel & Rollback Upload Ticket
  app.post(['/api/upload/direct/cancel', '/upload/direct/cancel'], async (req, res) => {
    const authenticatedUserId =
      (req as any).authenticatedUploadUserId ||
      (await requireUploadAuthentication(req, res, 'Authentication required to cancel upload.'));
    if (!authenticatedUserId) {
      return;
    }
    const attachmentId = typeof req.body?.attachmentId === 'string' ? req.body.attachmentId.trim() : '';
    const cancelRes = await cancelDurableUploadTicket(attachmentId, authenticatedUserId);
    if (!cancelRes.success) {
      return res.status(cancelRes.status || 500).json({
        error: cancelRes.error || 'An internal error occurred during upload cancellation.',
        code: cancelRes.code || 'CANCEL_FAILED'
      });
    }

    const quotaIdentity = buildAuthenticatedQuotaIdentity(authenticatedUserId);
    let quotaStatus: QuotaStatus | null | undefined = cancelRes.quotaStatus;
    if (!quotaStatus) {
      try {
        quotaStatus = await getQuotaStatus(quotaIdentity);
      } catch (_) {}
    }

    if (quotaStatus) {
      attachQuotaHeaders(res, quotaStatus, quotaIdentity);
    }

    const resolvedPktDay = quotaStatus ? (quotaStatus.pktDay || quotaStatus.utcDay || getPktDayString()) : undefined;
    return res.status(200).json({
      success: true,
      cancelled: true,
      ...(quotaStatus
        ? {
            quota: quotaStatus,
            limit: quotaStatus.limit,
            remaining: quotaStatus.remaining,
            committed: quotaStatus.committed,
            activeReservations: quotaStatus.activeReservations,
            resetAt: quotaStatus.resetAt,
            pktDay: resolvedPktDay,
            utcDay: resolvedPktDay
          }
        : {})
    });
  });

  app.post(['/api/upload', '/upload'], async (req, res) => {
    // P3 Security Enforcement: Require valid Firebase authentication BEFORE parsing multipart upload payload.
    // Never trust client-provided userIds, guest tokens, cookies, or identity headers.
    const authenticatedUserId = await requireUploadAuthentication(
      req,
      res,
      'Authentication is required to upload attachments. Please sign in to continue.'
    );
    if (!authenticatedUserId) {
      return;
    }

    uploadMiddleware.array('files', MAX_ATTACHMENTS_PER_UPLOAD)(req as any, res as any, async (err: any) => {
      if (err) {
        if (err instanceof multer.MulterError) {
          if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({
              error: `File exceeds maximum allowed size of ${formatBytes(MAX_FILE_SIZE_BYTES)}.`,
              code: 'FILE_TOO_LARGE'
            });
          }
          if (err.code === 'LIMIT_FILE_COUNT') {
            return res.status(400).json({
              error: 'Only one attachment can be added per message.',
              code: 'TOO_MANY_FILES'
            });
          }
          if (err.code === 'LIMIT_UNEXPECTED_FILE') {
            return res.status(400).json({
              error: "Unexpected field in upload. Expected field name 'files'.",
              code: 'UNEXPECTED_FIELD'
            });
          }
        }
        return res.status(400).json({
          error: err.message || 'File upload failed.',
          code: 'UPLOAD_ERROR'
        });
      }

      const files = req.files as Express.Multer.File[] | undefined;
      if (!files || files.length === 0) {
        return res.status(400).json({
          error: 'No files provided for upload.',
          code: 'NO_FILES'
        });
      }

      if (files.length > 1) {
        return res.status(400).json({
          error: 'Only one attachment can be added per message.',
          code: 'TOO_MANY_FILES'
        });
      }

      const rawConvId = req.body?.conversationId !== undefined ? String(req.body.conversationId).trim() : undefined;
      const conversationId = rawConvId && rawConvId.length > 0 ? rawConvId : undefined;
      const isOfflineUpload = String(req.body?.offline || '').toLowerCase() === 'true';

      // Authenticated uploads require a valid conversation ID to prevent orphaned staging storage
      if (!conversationId) {
        return res.status(400).json({
          error: 'A valid conversationId is required for authenticated uploads.',
          code: 'MISSING_CONVERSATION_ID'
        });
      }
      if (!isValidPathSegment(conversationId) || conversationId.toLowerCase() === 'staging') {
        return res.status(400).json({
          error: 'Invalid conversationId provided. Must contain only alphanumeric characters, dashes, and underscores.',
          code: 'INVALID_CONVERSATION_ID'
        });
      }

      // Enforce secure, persistent daily upload quota of 5 per verified Firebase UID per UTC calendar day
      const quotaIdentity = buildAuthenticatedQuotaIdentity(authenticatedUserId);
      let quotaReservation: any;
      try {
        quotaReservation = await reserveUploadSlot(quotaIdentity);
      } catch (quotaErr: any) {
        console.error('[UploadQuota] Quota reservation failed:', quotaErr?.message || quotaErr);
        return res.status(500).json({
          error: 'Upload service temporarily unavailable due to storage configuration error.',
          code: 'QUOTA_SERVICE_UNAVAILABLE',
          status: 'SERVICE_UNAVAILABLE'
        });
      }

      if (!quotaReservation.allowed) {
        attachQuotaHeaders(
          res,
          {
            limit: quotaReservation.limit,
            remaining: quotaReservation.remaining,
            resetAt: quotaReservation.resetAt
          },
          quotaIdentity
        );
        return res.status(429).json({
          error: quotaReservation.error,
          code: 'QUOTA_EXCEEDED',
          status: 'QUOTA_EXCEEDED',
          limit: quotaReservation.limit,
          remaining: quotaReservation.remaining,
          resetAt: quotaReservation.resetAt
        });
      }

      const reservation = quotaReservation.reservation;
      let isReservationSettled = false;

      const releaseQuotaReservationSafely = async (): Promise<QuotaStatus | null> => {
        if (!isReservationSettled) {
          isReservationSettled = true;
          try {
            return await releaseUploadSlot(reservation);
          } catch (_) {}
        }
        return null;
      };

      res.on('close', () => {
        if (!res.writableEnded) {
          void releaseQuotaReservationSafely();
        }
      });

      const uploadedResults: UploadedFileRecord[] = [];
      const validationErrors: string[] = [];
      let validationErrorCode = 'INVALID_FILE_CONTENT';
      const rawStoragePayloads = new Map<string, { rawBuffer: Buffer; storageMimeType: string }>();

      const declaredEncoding = firstFieldValue(req.body?.storageEncoding);
      const declaredOriginalSize = req.body?.originalSize ?? null;
      const declaredOriginalMime = firstFieldValue(req.body?.originalMimeType);
      const declaredChecksum = firstFieldValue(req.body?.storageChecksum);

      for (const file of files) {
        const ext = path.extname(file.originalname).toLowerCase();
        const rawBase = path.basename(file.originalname || 'attachment');
        const safeBaseName = rawBase
          .replace(/[\0\r\n\t]/g, '')
          .replace(/[/\\?%*:|"<>]/g, '_')
          .trim()
          .slice(0, 150) || 'attachment';

        const fileBuffer = file.buffer;
        const wireSize = fileBuffer ? fileBuffer.length : file.size;

        if (!fileBuffer || wireSize === 0) {
          validationErrors.push(`File '${safeBaseName}' is empty (0 bytes).`);
          continue;
        }

        let unwrapped: ReturnType<typeof unwrapUploadedOrStoredPayload>;
        try {
          unwrapped = unwrapUploadedOrStoredPayload({
            buffer: fileBuffer,
            ext,
            clientMime: file.mimetype || '',
            declaredEncoding,
            declaredOriginalSize,
            declaredOriginalMimeType: declaredOriginalMime,
            declaredChecksum,
            maxOriginalBytes: MAX_FILE_SIZE_BYTES
          });
        } catch (envErr: any) {
          validationErrorCode = envErr?.code || 'INVALID_STORAGE_ENVELOPE';
          validationErrors.push(`File '${safeBaseName}': ${envErr?.message || 'Invalid storage compression envelope.'}`);
          continue;
        }

        const decodedBuffer = unwrapped.decodedBuffer;
        const decodedSize = decodedBuffer.length;
        const canonicalMime = unwrapped.canonicalMimeType;

        const sigResult = await verifyFileSignature(decodedBuffer, ext);
        if (!sigResult.valid) {
          validationErrors.push(`File '${safeBaseName}': ${sigResult.reason}`);
          continue;
        }

        const isImg =
          ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.heic', '.heif'].includes(ext) ||
          canonicalMime.toLowerCase().startsWith('image/');

        const fileId = crypto.randomUUID();
        const diskFilename = `${fileId}${ext}`;
        const nowIso = new Date().toISOString();

        try {
          const fullDiskPath = path.join(UPLOAD_DIR, diskFilename);
          fs.writeFile(fullDiskPath, decodedBuffer, () => {});
        } catch (_) {}

        rawStoragePayloads.set(fileId, {
          rawBuffer: unwrapped.rawStorageBuffer,
          storageMimeType: unwrapped.encoded ? 'application/octet-stream' : canonicalMime
        });

        const record: UploadedFileRecord = {
          id: fileId,
          originalName: safeBaseName,
          diskFilename,
          mimeType: canonicalMime || (isImg ? `image/${ext.replace('.', '')}` : 'application/octet-stream'),
          extension: ext.replace('.', '').toUpperCase(),
          size: decodedSize,
          formattedSize: formatBytes(decodedSize),
          status: isImg ? 'ready' : 'uploaded',
          uploadedAt: nowIso,
          expiresAt: Date.now() + TEMP_FILE_TTL_MS,
          conversationId,
          userId: authenticatedUserId || undefined,
          isPermanent: String(req.body?.isPermanent || req.body?.permanent || '').toLowerCase() === 'true',
          storageProvider: 'local',
          storageEncoding: unwrapped.storageEncoding,
          storedSize: unwrapped.storedSize,
          ...(unwrapped.storageChecksum ? { storageChecksum: unwrapped.storageChecksum } : {}),
          isImage: isImg,
          dimensions: sigResult.dimensions,
          buffer: decodedBuffer
        };

        fileRegistry.set(fileId, record);
        if (conversationId) {
          let docSet = conversationDocuments.get(conversationId);
          if (!docSet) {
            docSet = new Set<string>();
            conversationDocuments.set(conversationId, docSet);
          }
          docSet.add(fileId);
        }
        uploadedResults.push(record);
      }

      if (validationErrors.length > 0) {
        const releasedStatus = await releaseQuotaReservationSafely();
        if (releasedStatus) {
          attachQuotaHeaders(res, releasedStatus, quotaIdentity);
        }
        for (const rec of uploadedResults) {
          fileRegistry.delete(rec.id);
          if (conversationId && conversationDocuments.has(conversationId)) {
            conversationDocuments.get(conversationId)!.delete(rec.id);
          }
          try {
            await fs.promises.unlink(path.join(UPLOAD_DIR, rec.diskFilename));
          } catch (_) {}
        }
        return res.status(400).json({
          error: validationErrors.join(' '),
          code: validationErrorCode
        });
      }

      for (const rec of uploadedResults) {
        try {
          const fullDiskPath = path.join(UPLOAD_DIR, rec.diskFilename);
          const ext = path.extname(rec.diskFilename).toLowerCase();
          const isImg =
            ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.heic', '.heif'].includes(ext) ||
            rec.mimeType.startsWith('image/');

          const inputSource = rec.buffer || fullDiskPath;

          if (isImg) {
            rec.isImage = true;
            const isOfflineUpload = String(req.body?.offline || '').toLowerCase() === 'true';
            const geminiKey = getGeminiApiKey() || null;
            const imgExtraction = (await extractImageText(
              inputSource,
              rec.originalName,
              ext,
              rec.mimeType,
              rec.id,
              rec.dimensions,
              geminiKey,
              { offline: isOfflineUpload }
            )) as any;
            rec.extraction = imgExtraction;
            rec.status = imgExtraction?.status === 'error' ? 'error' : 'ready';
          } else {
            const isOfflineUpload = String(req.body?.offline || '').toLowerCase() === 'true';
            const geminiKey = getGeminiApiKey() || null;
            const extraction = (await extractDocumentContent(
              inputSource,
              rec.originalName,
              ext,
              rec.mimeType,
              rec.id,
              { offline: isOfflineUpload, apiKey: geminiKey }
            )) as DocumentExtractionResult;
            rec.extraction = extraction;
            rec.status = extraction.success || extraction.status === 'scanned_or_image_only' || extraction.status === 'NO_TEXT_DETECTED' ? 'ready' : 'uploaded';
          }
        } catch (err: any) {
          console.warn(`[Document Extraction] Extraction error for ${rec.originalName}:`, err);
        }
      }

      // Upload authenticated users' files to private Supabase Storage if configured and online
      if (authenticatedUserId && isSupabaseConfigured() && !isOfflineUpload) {
        const cleanChatId = conversationId!;
        const uploadedToSupabase: { path: string; bucket?: string }[] = [];

        for (const rec of uploadedResults) {
          const storagePayload = rawStoragePayloads.get(rec.id);
          const bufferForCloud = storagePayload?.rawBuffer || rec.buffer;
          const mimeForCloud = storagePayload?.storageMimeType || rec.mimeType;
          if (bufferForCloud && bufferForCloud.length > 0) {
            const rawExt = path.extname(rec.diskFilename).replace(/^\.+/, '').toLowerCase();
            let supaRes;
            try {
              supaRes = await uploadAttachmentToStorage({
                userId: authenticatedUserId,
                chatId: cleanChatId,
                attachmentId: rec.id,
                extension: rawExt,
                buffer: bufferForCloud,
                mimeType: mimeForCloud,
                expiresAt: rec.expiresAt,
                isPermanent: rec.isPermanent
              });
            } catch (supaErr: any) {
              supaRes = {
                success: false,
                error: supaErr?.message || 'Unexpected exception during Supabase storage upload.',
                code: 'STORAGE_UPLOAD_EXCEPTION',
                status: 503,
                retryable: true
              };
            }

            if (!supaRes || !supaRes.success) {
              const errorMessage = supaRes?.error || 'Failed to upload attachment to cloud storage. Please try again.';
              const isRetryable =
                typeof supaRes?.retryable === 'boolean'
                  ? supaRes.retryable
                  : (supaRes?.status ? (supaRes.status >= 500 || supaRes.status === 429) : true);

              console.error(
                `[Upload] Supabase cloud upload failed for attachment ${rec.id}:`,
                errorMessage
              );

              // 1. Rollback local temporary files written to disk and in-memory registry during this request
              for (const toClean of uploadedResults) {
                fileRegistry.delete(toClean.id);
                if (cleanChatId && conversationDocuments.has(cleanChatId)) {
                  conversationDocuments.get(cleanChatId)!.delete(toClean.id);
                }
                try {
                  const fullDiskPath = path.join(UPLOAD_DIR, toClean.diskFilename);
                  if (fs.existsSync(fullDiskPath)) {
                    await fs.promises.unlink(fullDiskPath);
                  }
                } catch (_) {}
              }

              // 2. Rollback any files from this batch that succeeded uploading to Supabase
              for (const uploadedSupa of uploadedToSupabase) {
                try {
                  await deleteAttachmentFromStorage(uploadedSupa.path, {
                    requestingUserId: authenticatedUserId,
                    bucket: uploadedSupa.bucket
                  });
                } catch (delErr) {
                  console.warn(
                    `[Upload] Failed to rollback partial Supabase upload at ${uploadedSupa.path}:`,
                    delErr
                  );
                }
              }

              // 3. Fail securely: Return HTTP 503 without silent fallback to local disk
              const releasedStatus = await releaseQuotaReservationSafely();
              if (releasedStatus) {
                attachQuotaHeaders(res, releasedStatus, quotaIdentity);
              }
              return res.status(503).json({
                error: errorMessage,
                code: 'STORAGE_UPLOAD_FAILED',
                status: 503,
                retryable: isRetryable
              });
            }

            rec.storageProvider = 'supabase';
            rec.storagePath = supaRes.path;
            rec.storageBucket = supaRes.bucket;
            rec.userId = authenticatedUserId;
            if (supaRes.path) {
              uploadedToSupabase.push({ path: supaRes.path, bucket: supaRes.bucket });
            }
          }
        }
      }

      isReservationSettled = true;
      let committedStatus: QuotaStatus;
      try {
        committedStatus = await commitUploadSlot(reservation);
      } catch (commitErr: any) {
        if (commitErr?.code === 'QUOTA_EXCEEDED') {
          const statusForHeader = commitErr.currentDayStatus || {
            limit: DAILY_UPLOAD_LIMIT,
            remaining: typeof commitErr.remaining === 'number' ? commitErr.remaining : 0,
            resetAt: commitErr.resetAt || getNextPktMidnight().toISOString()
          };
          attachQuotaHeaders(res, statusForHeader, quotaIdentity);
          return res.status(429).json({
            error: commitErr.message || 'Daily attachment upload limit exceeded.',
            code: 'QUOTA_EXCEEDED',
            status: 'QUOTA_EXCEEDED',
            limit: statusForHeader.limit,
            remaining: statusForHeader.remaining,
            resetAt: statusForHeader.resetAt
          });
        }
        throw commitErr;
      }
      attachQuotaHeaders(res, committedStatus, quotaIdentity);

      const serializedAttachments = uploadedResults.map((r) => serializeRegisteredAttachment(r));

      return res.status(200).json({
        success: true,
        count: serializedAttachments.length,
        attachments: serializedAttachments,
        attachment: serializedAttachments[0] || null,
        quota: committedStatus
      });
    });
  });
}
