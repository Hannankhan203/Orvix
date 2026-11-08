import type express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import multer from 'multer';

import { isServerless } from './serverConfig.ts';
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
import {
  uploadAttachmentToStorage,
  downloadAttachmentFromStorage,
  createAttachmentSignedUrl,
  isValidPathSegment
} from './supabaseStorageService.ts';
import { isSupabaseConfigured } from './supabaseClient.ts';
import {
  verifyFirebaseIdToken,
  resolveVerifiedUserId,
  authenticateRequest
} from './firebaseAuthHelper.ts';

export {
  verifyFirebaseIdToken,
  resolveVerifiedUserId,
  authenticateRequest
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

const __filename = fileURLToPath(import.meta.url);
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

/**
 * Automated lifecycle cleanup: Sweeps the temporary upload directory and registry,
 * unlinking files exceeding the TTL (default: 2 hours).
 */
export function cleanupExpiredUploads() {
  try {
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

/**
 * Registers all file upload and attachment serving routes onto the Express app.
 */
export function registerUploadRoutes(app: express.Express) {
  // Upload Configuration Endpoint (returns limits, supported formats, and active storage strategy)
  app.get(['/api/upload/config', '/upload/config'], (_req, res) => {
    res.json({
      maxFileSizeBytes: MAX_FILE_SIZE_BYTES,
      maxFileSizeFormatted: formatBytes(MAX_FILE_SIZE_BYTES),
      maxAttachments: MAX_ATTACHMENTS_PER_UPLOAD,
      allowedExtensions: Object.keys(ALLOWED_EXTENSIONS_MAP).map((e) =>
        e.replace('.', '').toUpperCase()
      ),
      ttlMinutes: Math.round(TEMP_FILE_TTL_MS / (60 * 1000)),
      storageMode: isServerless ? 'serverless-temp' : 'local-disk',
      isServerless
    });
  });

  // Upload Attachment Metadata Endpoint
  app.get(['/api/upload/:id', '/upload/:id'], async (req, res) => {
    const fileId = req.params.id;
    if (!fileId || !/^[0-9a-fA-F-]{36}$/.test(fileId)) {
      return res.status(400).json({ error: 'Invalid attachment ID format.', code: 'INVALID_ID_FORMAT' });
    }

    const record = fileRegistry.get(fileId);
    if (!record) {
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

    const record = fileRegistry.get(fileId);
    if (!record) {
      if (isServerless) {
        return res.json({
          id: fileId,
          fileId,
          status: 'ready',
          success: true,
          hasText: false,
          text: '',
          message: 'Extraction metadata stored in client session.'
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

    if (record.extraction) {
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
          inputSource = downloadResult.data;
          record.buffer = downloadResult.data;
        }
      } catch (err: any) {
        console.warn(`[Extraction] Failed to retrieve file from Supabase for ${record.id}:`, err?.message || err);
      }
    }

    if (inputSource) {
      if (isImg) {
        const isOfflineReq = req.query?.offline === 'true';
        const geminiKey = process.env.GEMINI_API_KEY || null;
        const imgExtraction = await extractImageText(
          inputSource,
          record.originalName,
          ext,
          record.mimeType,
          record.id,
          record.dimensions,
          geminiKey,
          { offline: isOfflineReq }
        );
        record.extraction = imgExtraction;
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
      return res.json(extraction);
    }

    return res.status(404).json({ error: 'Attachment file not found or has expired.', code: 'ATTACHMENT_NOT_FOUND' });
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
      if (!fileId || !/^[0-9a-fA-F-]{36}$/.test(fileId)) {
        return res.status(400).json({ error: 'Invalid attachment ID format.', code: 'INVALID_ID_FORMAT' });
      }

      const record = fileRegistry.get(fileId);

      // For every Supabase-backed attachment, require a non-empty record.userId and successful Firebase authentication.
      if (record?.storageProvider === 'supabase' && !record?.userId) {
        return res.status(403).json({
          error: 'Access denied: Attachment is missing required ownership metadata.',
          code: 'STORAGE_ACCESS_DENIED'
        });
      }

      let authenticatedUserId: string | null = null;
      if (record?.storageProvider === 'supabase' || record?.userId) {
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

      let diskFilename = record?.diskFilename;
      let originalName = record?.originalName || 'document';
      let mimeType = record?.mimeType || 'application/octet-stream';

      const forceDownload =
        req.query.download === 'true' ||
        req.path.includes('/download') ||
        req.query.action === 'download';

      const isInline =
        !forceDownload &&
        (mimeType === 'application/pdf' ||
          mimeType.startsWith('text/') ||
          mimeType.startsWith('image/'));

      const safeFilename = path.basename(originalName).replace(/[/\\?%*:|"<>]/g, '_');
      res.setHeader('Content-Type', mimeType);
      res.setHeader(
        'Content-Disposition',
        `${isInline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(safeFilename)}"; filename*=UTF-8''${encodeURIComponent(safeFilename)}`
      );

      // 1. Retrieve authenticated users' files from private Supabase Storage if configured and stored in cloud
      if (record?.storageProvider === 'supabase' && record.storagePath) {
        try {
          const downloadResult = await downloadAttachmentFromStorage(record.storagePath, {
            requestingUserId: authenticatedUserId || undefined,
            bucket: record.storageBucket
          });

          if (downloadResult.success && downloadResult.data) {
            if (downloadResult.mimeType && downloadResult.mimeType !== 'application/octet-stream') {
              res.setHeader('Content-Type', downloadResult.mimeType);
            }
            return res.send(downloadResult.data);
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
      if (record?.buffer) {
        return res.send(record.buffer);
      }

      // 3. Disk-based fallback
      if (!diskFilename) {
        try {
          const files = await fs.promises.readdir(UPLOAD_DIR);
          const match = files.find((f) => f.startsWith(fileId));
          if (match) {
            diskFilename = match;
            const ext = path.extname(match).toLowerCase();
            mimeType = (ALLOWED_EXTENSIONS_MAP[ext] && ALLOWED_EXTENSIONS_MAP[ext][0]) || mimeType;
            res.setHeader('Content-Type', mimeType);
          }
        } catch (_) {}
      }

      if (!diskFilename) {
        return res.status(404).json({ error: 'Attachment file not found or has expired.', code: 'ATTACHMENT_NOT_FOUND' });
      }

      // Path traversal containment check
      const resolvedUploadDir = path.resolve(UPLOAD_DIR);
      const resolvedFilePath = path.resolve(UPLOAD_DIR, path.basename(diskFilename));
      if (!resolvedFilePath.startsWith(resolvedUploadDir + path.sep)) {
        return res.status(403).json({ error: 'Access denied: invalid file path.', code: 'INVALID_PATH' });
      }

      if (!fs.existsSync(resolvedFilePath)) {
        return res.status(404).json({ error: 'Attachment file not found or has expired.', code: 'ATTACHMENT_NOT_FOUND' });
      }

      return res.sendFile(resolvedFilePath);
    }
  );

  // Dedicated Pre-Signed URL Generation Endpoint (Short-lived, max 120s)
  app.get(['/api/upload/:id/signed-url', '/upload/:id/signed-url'], async (req, res) => {
    const fileId = req.params.id;
    if (!fileId || !/^[0-9a-fA-F-]{36}$/.test(fileId)) {
      return res.status(400).json({ error: 'Invalid attachment ID format.', code: 'INVALID_ID_FORMAT' });
    }

    const record = fileRegistry.get(fileId);
    if (!record) {
      return res.status(404).json({ error: 'Attachment not found or has expired.', code: 'ATTACHMENT_NOT_FOUND' });
    }

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
  });

  
  // Upload Deletion Endpoint
  app.delete(['/api/upload/:id', '/upload/:id'], async (req, res) => {
    const fileId = req.params.id;
    if (!fileId || !/^[0-9a-fA-F-]{36}$/.test(fileId)) {
      return res.status(400).json({ error: 'Invalid attachment ID format.' });
    }

    const record = fileRegistry.get(fileId);
    fileRegistry.delete(fileId);

    if (record?.conversationId && conversationDocuments.has(record.conversationId)) {
      conversationDocuments.get(record.conversationId)!.delete(fileId);
    }

    try {
      const files = await fs.promises.readdir(UPLOAD_DIR);
      for (const fname of files) {
        if (fname.startsWith(fileId)) {
          const safePath = path.resolve(UPLOAD_DIR, path.basename(fname));
          if (safePath.startsWith(path.resolve(UPLOAD_DIR) + path.sep)) {
            await fs.promises.unlink(safePath);
          }
        }
      }
    } catch (_) {}

    return res.json({ success: true, id: fileId });
  });


  // Dedicated Multipart File Upload Endpoint
  app.post(['/api/upload', '/upload'], (req, res) => {
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

      const conversationId = req.body?.conversationId ? String(req.body.conversationId).trim() : undefined;
      const authStatus = await authenticateRequest(req);
      if (authStatus.status === 'invalid') {
        return res.status(401).json({
          error: `Authentication failed: ${authStatus.error}`,
          code: authStatus.code || 'INVALID_TOKEN'
        });
      }
      const authenticatedUserId = authStatus.userId;
      const isOfflineUpload = String(req.body?.offline || '').toLowerCase() === 'true';
      const uploadedResults: UploadedFileRecord[] = [];
      const validationErrors: string[] = [];

      for (const file of files) {
        const ext = path.extname(file.originalname).toLowerCase();
        const rawBase = path.basename(file.originalname || 'attachment');
        const safeBaseName = rawBase
          .replace(/[\0\r\n\t]/g, '')
          .replace(/[/\\?%*:|"<>]/g, '_')
          .trim()
          .slice(0, 150) || 'attachment';

        const fileBuffer = file.buffer;
        const fileSize = fileBuffer ? fileBuffer.length : file.size;

        if (!fileBuffer || fileSize === 0) {
          validationErrors.push(`File '${safeBaseName}' is empty (0 bytes).`);
          continue;
        }

        const sigResult = await verifyFileSignature(fileBuffer, ext);
        if (!sigResult.valid) {
          validationErrors.push(`File '${safeBaseName}': ${sigResult.reason}`);
          continue;
        }

        const isImg =
          ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.heic', '.heif'].includes(ext) ||
          (file.mimetype || '').toLowerCase().startsWith('image/');

        const fileId = crypto.randomUUID();
        const diskFilename = `${fileId}${ext}`;
        const nowIso = new Date().toISOString();

        try {
          const fullDiskPath = path.join(UPLOAD_DIR, diskFilename);
          fs.writeFile(fullDiskPath, fileBuffer, () => {});
        } catch (_) {}

        const record: UploadedFileRecord = {
          id: fileId,
          originalName: safeBaseName,
          diskFilename,
          mimeType: file.mimetype || (isImg ? `image/${ext.replace('.', '')}` : 'application/octet-stream'),
          extension: ext.replace('.', '').toUpperCase(),
          size: fileSize,
          formattedSize: formatBytes(fileSize),
          status: isImg ? 'ready' : 'uploaded',
          uploadedAt: nowIso,
          expiresAt: Date.now() + TEMP_FILE_TTL_MS,
          conversationId,
          userId: authenticatedUserId || undefined,
          storageProvider: 'local',
          isImage: isImg,
          dimensions: sigResult.dimensions,
          buffer: fileBuffer
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
          code: 'INVALID_FILE_CONTENT'
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
            const geminiKey = process.env.GEMINI_API_KEY || null;
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
            const geminiKey = process.env.GEMINI_API_KEY || null;
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
        const cleanChatId =
          conversationId && isValidPathSegment(conversationId)
            ? conversationId
            : 'staging';

        for (const rec of uploadedResults) {
          if (rec.buffer && rec.buffer.length > 0) {
            const rawExt = path.extname(rec.diskFilename).replace(/^\.+/, '').toLowerCase();
            try {
              const supaRes = await uploadAttachmentToStorage({
                userId: authenticatedUserId,
                chatId: cleanChatId,
                attachmentId: rec.id,
                extension: rawExt,
                buffer: rec.buffer,
                mimeType: rec.mimeType
              });

              if (supaRes.success) {
                rec.storageProvider = 'supabase';
                rec.storagePath = supaRes.path;
                rec.storageBucket = supaRes.bucket;
                rec.userId = authenticatedUserId;
              } else {
                console.warn(
                  `[Upload] Supabase upload failed for attachment ${rec.id}, maintaining local file:`,
                  supaRes.error
                );
                rec.storageProvider = 'local';
              }
            } catch (supaErr: any) {
              console.warn(`[Upload] Supabase exception for attachment ${rec.id}:`, supaErr?.message || supaErr);
              rec.storageProvider = 'local';
            }
          }
        }
      }

      return res.status(200).json({
        success: true,
        count: uploadedResults.length,
        attachments: uploadedResults.map((r) => {
          const ext = path.extname(r.diskFilename).toLowerCase();
          const isImg =
            ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.heic', '.heif'].includes(ext) ||
            r.mimeType.startsWith('image/');
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
            storageProvider: r.storageProvider || 'local',
            storagePath: r.storagePath || null,
            bucket: r.storageBucket || null,
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
        })
      });
    });
  });
}
