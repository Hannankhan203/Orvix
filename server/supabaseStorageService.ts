/**
 * Server-Side Supabase Storage Service for Orvix
 *
 * Responsibilities:
 * 1. Upload file buffers to the private 'orvix-attachments' bucket.
 * 2. Enforce structured, partitioned storage paths: {userId}/{chatId}/{attachmentId}.{extension}.
 * 3. Support file downloads, deletions, and short-lived pre-signed URL generation.
 * 4. Validate storage paths, prevent directory traversal, and enforce cross-user access boundaries.
 * 5. Handle missing configuration and upstream Supabase API errors gracefully.
 */

import {
  getSupabaseServerClient,
  getSupabaseBucket,
  isSupabaseConfigured
} from './supabaseClient.ts';

export class SupabaseStorageError extends Error {
  status: number;
  code: string;
  storagePath?: string;

  constructor(message: string, status = 500, code = 'STORAGE_ERROR', storagePath?: string) {
    super(message);
    this.name = 'SupabaseStorageError';
    this.status = status;
    this.code = code;
    this.storagePath = storagePath;
  }
}

export interface ParsedStoragePath {
  valid: boolean;
  userId?: string;
  chatId?: string;
  attachmentId?: string;
  extension?: string;
  filename?: string;
  normalizedPath?: string;
  error?: string;
}

export interface UploadAttachmentOptions {
  userId: string;
  chatId: string;
  attachmentId: string;
  extension?: string;
  buffer: Buffer | Uint8Array;
  mimeType?: string;
  upsert?: boolean;
  bucket?: string;
}

export interface UploadAttachmentResult {
  success: boolean;
  path?: string;
  fullPath?: string;
  bucket?: string;
  error?: string;
  code?: string;
  status?: number;
}

export interface DownloadAttachmentOptions {
  requestingUserId?: string;
  bucket?: string;
}

export interface DownloadAttachmentResult {
  success: boolean;
  data?: Buffer;
  mimeType?: string;
  size?: number;
  error?: string;
  code?: string;
  status?: number;
}

export interface CreateSignedUrlOptions {
  requestingUserId?: string;
  expiresInSeconds?: number;
  download?: boolean | string;
  bucket?: string;
}

export interface CreateSignedUrlResult {
  success: boolean;
  signedUrl?: string;
  error?: string;
  code?: string;
  status?: number;
}

export interface DeleteAttachmentOptions {
  requestingUserId?: string;
  bucket?: string;
}

export interface DeleteAttachmentResult {
  success: boolean;
  error?: string;
  code?: string;
  status?: number;
}

export interface DeleteChatAttachmentsResult {
  success: boolean;
  deletedCount: number;
  error?: string;
  code?: string;
  status?: number;
}

/**
 * Validates that an individual path segment (userId, chatId, attachmentId) contains
 * only safe alphanumeric characters, dashes, and underscores without traversal sequences.
 */
export function isValidPathSegment(segment: unknown): boolean {
  if (typeof segment !== 'string') return false;
  const trimmed = segment.trim();
  if (!trimmed || trimmed.length > 128) return false;
  // Strictly disallow relative traversal or special chars
  if (trimmed === '.' || trimmed === '..' || trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('\0')) {
    return false;
  }
  return /^[a-zA-Z0-9_-]+$/.test(trimmed);
}

/**
 * Normalizes file extension, stripping leading dots and whitespace.
 */
export function normalizeExtension(extension?: string): string {
  if (!extension || typeof extension !== 'string') return '';
  return extension.trim().replace(/^\.+/, '').toLowerCase();
}

/**
 * Builds a canonical storage path: {userId}/{chatId}/{attachmentId}.{extension}
 * Throws SupabaseStorageError if any component fails security validation.
 */
export function buildAttachmentStoragePath(
  userId: string,
  chatId: string,
  attachmentId: string,
  extension: string = ''
): string {
  const cleanUser = String(userId || '').trim();
  const cleanChat = String(chatId || '').trim();
  const cleanAtt = String(attachmentId || '').trim();
  const cleanExt = normalizeExtension(extension);

  if (!isValidPathSegment(cleanUser)) {
    throw new SupabaseStorageError(
      `Invalid userId for storage path: '${userId}'. Must be alphanumeric with dashes/underscores.`,
      400,
      'INVALID_PATH_SEGMENT'
    );
  }

  if (!isValidPathSegment(cleanChat)) {
    throw new SupabaseStorageError(
      `Invalid chatId for storage path: '${chatId}'. Must be alphanumeric with dashes/underscores.`,
      400,
      'INVALID_PATH_SEGMENT'
    );
  }

  if (!isValidPathSegment(cleanAtt)) {
    throw new SupabaseStorageError(
      `Invalid attachmentId for storage path: '${attachmentId}'. Must be alphanumeric with dashes/underscores.`,
      400,
      'INVALID_PATH_SEGMENT'
    );
  }

  if (cleanExt && !/^[a-zA-Z0-9]{1,16}$/.test(cleanExt)) {
    throw new SupabaseStorageError(
      `Invalid file extension for storage path: '${extension}'. Must be 1-16 alphanumeric characters.`,
      400,
      'INVALID_PATH_SEGMENT'
    );
  }

  const filename = cleanExt ? `${cleanAtt}.${cleanExt}` : cleanAtt;
  return `${cleanUser}/${cleanChat}/${filename}`;
}

/**
 * Parses and validates an existing storage path.
 * Checks for path traversal (..), null bytes, and verifies the 3-part structure.
 */
export function parseStoragePath(storagePath: unknown): ParsedStoragePath {
  if (typeof storagePath !== 'string' || !storagePath.trim()) {
    return { valid: false, error: 'Storage path must be a non-empty string.' };
  }

  const normalized = storagePath.trim().replace(/^\/+|\/+$/g, '');
  if (
    !normalized ||
    normalized.includes('..') ||
    normalized.includes('\\') ||
    normalized.includes('//') ||
    normalized.includes('\0') ||
    normalized.toLowerCase().includes('%2f') ||
    normalized.toLowerCase().includes('%5c')
  ) {
    return { valid: false, error: 'Path traversal or invalid characters detected in storage path.' };
  }

  const parts = normalized.split('/');
  if (parts.length !== 3) {
    return {
      valid: false,
      error: `Invalid storage path format: '${storagePath}'. Expected '{userId}/{chatId}/{attachmentId}.{ext}'.`
    };
  }

  const [userId, chatId, filename] = parts;

  if (!isValidPathSegment(userId)) {
    return { valid: false, error: `Invalid userId in storage path: '${userId}'.` };
  }

  if (!isValidPathSegment(chatId)) {
    return { valid: false, error: `Invalid chatId in storage path: '${chatId}'.` };
  }

  const dotIndex = filename.lastIndexOf('.');
  const attachmentId = dotIndex > 0 ? filename.slice(0, dotIndex) : filename;
  const extension = dotIndex > 0 ? filename.slice(dotIndex + 1).toLowerCase() : '';

  if (!isValidPathSegment(attachmentId)) {
    return { valid: false, error: `Invalid attachmentId in storage path: '${attachmentId}'.` };
  }

  if (extension && !/^[a-zA-Z0-9]{1,16}$/.test(extension)) {
    return { valid: false, error: `Invalid file extension in storage path: '${extension}'.` };
  }

  return {
    valid: true,
    userId,
    chatId,
    attachmentId,
    extension,
    filename,
    normalizedPath: normalized
  };
}

/**
 * Enforces ownership boundary: verifies that the requesting user matches the userId
 * encoded in the storage path. Prevents cross-user data tampering or unauthorized access.
 */
export function assertUserOwnsStoragePath(storagePath: string, requestingUserId?: string): ParsedStoragePath {
  const parsed = parseStoragePath(storagePath);
  if (!parsed.valid) {
    throw new SupabaseStorageError(
      parsed.error || 'Invalid storage path.',
      400,
      'INVALID_STORAGE_PATH',
      storagePath
    );
  }

  if (requestingUserId !== undefined && requestingUserId !== null) {
    const cleanRequestingUser = String(requestingUserId).trim();
    if (!cleanRequestingUser || cleanRequestingUser !== parsed.userId) {
      throw new SupabaseStorageError(
        'Access denied: You do not have permission to access attachments belonging to another user.',
        403,
        'STORAGE_ACCESS_DENIED',
        storagePath
      );
    }
  }

  return parsed;
}

/**
 * Uploads a file buffer to the private Supabase Storage bucket.
 * Uses the canonical {userId}/{chatId}/{attachmentId}.{ext} path format.
 */
export async function uploadAttachmentToStorage(
  options: UploadAttachmentOptions
): Promise<UploadAttachmentResult> {
  try {
    if (!options || typeof options !== 'object') {
      return {
        success: false,
        error: 'Upload options must be provided.',
        code: 'INVALID_OPTIONS',
        status: 400
      };
    }

    if (!options.buffer || (options.buffer.length !== undefined && options.buffer.length === 0)) {
      return {
        success: false,
        error: 'File buffer cannot be empty (0 bytes).',
        code: 'EMPTY_BUFFER',
        status: 400
      };
    }

    const storagePath = buildAttachmentStoragePath(
      options.userId,
      options.chatId,
      options.attachmentId,
      options.extension
    );

    const client = getSupabaseServerClient();
    if (!client) {
      return {
        success: false,
        path: storagePath,
        error: 'Supabase storage is not configured on this server.',
        code: 'STORAGE_UNCONFIGURED',
        status: 503
      };
    }

    const bucket = options.bucket || getSupabaseBucket();
    const contentType = options.mimeType || 'application/octet-stream';

    const { data, error } = await client.storage.from(bucket).upload(storagePath, options.buffer, {
      contentType,
      upsert: Boolean(options.upsert)
    });

    if (error) {
      return {
        success: false,
        path: storagePath,
        bucket,
        error: error.message || 'Supabase storage upload failed.',
        code: error.name || 'UPLOAD_FAILED',
        status: (error as any).status || 500
      };
    }

    return {
      success: true,
      path: data?.path || storagePath,
      fullPath: data?.fullPath || `${bucket}/${storagePath}`,
      bucket,
      status: 200
    };
  } catch (err: any) {
    return {
      success: false,
      error: err?.message || 'Unexpected error during attachment upload.',
      code: err?.code || 'UNEXPECTED_ERROR',
      status: err?.status || 500
    };
  }
}

/**
 * Downloads an attachment file from Supabase Storage.
 * Verifies path validity and cross-user ownership before fetching.
 */
export async function downloadAttachmentFromStorage(
  storagePath: string,
  options?: DownloadAttachmentOptions
): Promise<DownloadAttachmentResult> {
  try {
    const parsed = assertUserOwnsStoragePath(storagePath, options?.requestingUserId);
    const client = getSupabaseServerClient();

    if (!client) {
      return {
        success: false,
        error: 'Supabase storage is not configured on this server.',
        code: 'STORAGE_UNCONFIGURED',
        status: 503
      };
    }

    const bucket = options?.bucket || getSupabaseBucket();
    const path = parsed.normalizedPath!;

    const { data, error } = await client.storage.from(bucket).download(path);

    if (error || !data) {
      return {
        success: false,
        error: error?.message || 'Attachment file not found or download failed.',
        code: error?.name || 'DOWNLOAD_FAILED',
        status: (error as any).status || 404
      };
    }

    const arrayBuffer = await data.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    return {
      success: true,
      data: buffer,
      mimeType: data.type || 'application/octet-stream',
      size: buffer.length,
      status: 200
    };
  } catch (err: any) {
    return {
      success: false,
      error: err?.message || 'Failed to download attachment from storage.',
      code: err?.code || 'DOWNLOAD_ERROR',
      status: err?.status || 500
    };
  }
}

/**
 * Generates a short-lived pre-signed URL for private attachment access (preview or download).
 * Default expiration is 120 seconds (2 minutes).
 * Verifies cross-user ownership before signing the URL.
 */
export async function createAttachmentSignedUrl(
  storagePath: string,
  options?: CreateSignedUrlOptions
): Promise<CreateSignedUrlResult> {
  try {
    const parsed = assertUserOwnsStoragePath(storagePath, options?.requestingUserId);
    const client = getSupabaseServerClient();

    if (!client) {
      return {
        success: false,
        error: 'Supabase storage is not configured on this server.',
        code: 'STORAGE_UNCONFIGURED',
        status: 503
      };
    }

    const bucket = options?.bucket || getSupabaseBucket();
    const path = parsed.normalizedPath!;

    // Clamp expiration between 10s and 3600s (1 hr)
    const rawTtl = typeof options?.expiresInSeconds === 'number' ? options.expiresInSeconds : 120;
    const ttlSeconds = Math.max(10, Math.min(3600, Math.floor(rawTtl)));

    const signOptions: { download?: string | boolean } = {};
    if (options?.download !== undefined) {
      signOptions.download = options.download;
    }

    const { data, error } = await client.storage.from(bucket).createSignedUrl(path, ttlSeconds, signOptions);

    if (error || !data?.signedUrl) {
      return {
        success: false,
        error: error?.message || 'Failed to generate signed URL for attachment.',
        code: error?.name || 'SIGNED_URL_FAILED',
        status: (error as any).status || 500
      };
    }

    return {
      success: true,
      signedUrl: data.signedUrl,
      status: 200
    };
  } catch (err: any) {
    return {
      success: false,
      error: err?.message || 'Failed to create signed attachment URL.',
      code: err?.code || 'SIGNED_URL_ERROR',
      status: err?.status || 500
    };
  }
}

/**
 * Deletes a single attachment file from Supabase Storage.
 * Verifies path validity and cross-user ownership before removal.
 */
export async function deleteAttachmentFromStorage(
  storagePath: string,
  options?: DeleteAttachmentOptions
): Promise<DeleteAttachmentResult> {
  try {
    const parsed = assertUserOwnsStoragePath(storagePath, options?.requestingUserId);
    const client = getSupabaseServerClient();

    if (!client) {
      return {
        success: false,
        error: 'Supabase storage is not configured on this server.',
        code: 'STORAGE_UNCONFIGURED',
        status: 503
      };
    }

    const bucket = options?.bucket || getSupabaseBucket();
    const path = parsed.normalizedPath!;

    const { error } = await client.storage.from(bucket).remove([path]);

    if (error) {
      return {
        success: false,
        error: error.message || 'Failed to delete attachment from storage.',
        code: error.name || 'DELETE_FAILED',
        status: (error as any).status || 500
      };
    }

    return {
      success: true,
      status: 200
    };
  } catch (err: any) {
    return {
      success: false,
      error: err?.message || 'Failed to delete attachment from storage.',
      code: err?.code || 'DELETE_ERROR',
      status: err?.status || 500
    };
  }
}

/**
 * Deletes all attachments associated with a specific conversation ({userId}/{chatId}/*).
 * Verifies that the requesting user owns the conversation before pruning.
 */
export async function deleteAttachmentsForChatInStorage(
  userId: string,
  chatId: string,
  requestingUserId?: string,
  bucket?: string
): Promise<DeleteChatAttachmentsResult> {
  try {
    const cleanUser = String(userId || '').trim();
    const cleanChat = String(chatId || '').trim();

    if (!isValidPathSegment(cleanUser)) {
      return {
        success: false,
        deletedCount: 0,
        error: `Invalid userId: '${userId}'`,
        code: 'INVALID_PATH_SEGMENT',
        status: 400
      };
    }

    if (!isValidPathSegment(cleanChat)) {
      return {
        success: false,
        deletedCount: 0,
        error: `Invalid chatId: '${chatId}'`,
        code: 'INVALID_PATH_SEGMENT',
        status: 400
      };
    }

    if (requestingUserId !== undefined && requestingUserId !== null) {
      const cleanReqUser = String(requestingUserId).trim();
      if (!cleanReqUser || cleanReqUser !== cleanUser) {
        return {
          success: false,
          deletedCount: 0,
          error: 'Access denied: You cannot delete attachments belonging to another user.',
          code: 'STORAGE_ACCESS_DENIED',
          status: 403
        };
      }
    }

    const client = getSupabaseServerClient();
    if (!client) {
      return {
        success: false,
        deletedCount: 0,
        error: 'Supabase storage is not configured on this server.',
        code: 'STORAGE_UNCONFIGURED',
        status: 503
      };
    }

    const activeBucket = bucket || getSupabaseBucket();
    const folderPath = `${cleanUser}/${cleanChat}`;

    const { data: fileList, error: listError } = await client.storage
      .from(activeBucket)
      .list(folderPath);

    if (listError) {
      return {
        success: false,
        deletedCount: 0,
        error: listError.message || 'Failed to list conversation attachments.',
        code: listError.name || 'LIST_FAILED',
        status: (listError as any).status || 500
      };
    }

    if (!fileList || fileList.length === 0) {
      return {
        success: true,
        deletedCount: 0,
        status: 200
      };
    }

    const pathsToDelete = fileList
      .filter((item) => item?.name)
      .map((item) => `${folderPath}/${item.name}`);

    if (pathsToDelete.length === 0) {
      return {
        success: true,
        deletedCount: 0,
        status: 200
      };
    }

    const { error: removeError } = await client.storage
      .from(activeBucket)
      .remove(pathsToDelete);

    if (removeError) {
      return {
        success: false,
        deletedCount: 0,
        error: removeError.message || 'Failed to remove conversation attachments.',
        code: removeError.name || 'DELETE_FAILED',
        status: (removeError as any).status || 500
      };
    }

    return {
      success: true,
      deletedCount: pathsToDelete.length,
      status: 200
    };
  } catch (err: any) {
    return {
      success: false,
      deletedCount: 0,
      error: err?.message || 'Failed to delete conversation attachments from storage.',
      code: err?.code || 'DELETE_ERROR',
      status: err?.status || 500
    };
  }
}
