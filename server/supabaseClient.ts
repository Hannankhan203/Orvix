import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  getSupabaseUrl,
  getSupabaseSecretKey,
  getSupabaseStorageBucket,
  DEFAULT_SUPABASE_STORAGE_BUCKET,
  isValidSupabaseUrl,
  isConfiguredCredential
} from './serverConfig.ts';

export interface SupabaseConfigValidation {
  valid: boolean;
  error: string | null;
  bucket: string;
  url: string;
}

export interface SupabaseClientStatus {
  isConfigured: boolean;
  bucket: string;
  url: string;
  error: string | null;
}

let cachedClient: SupabaseClient | null = null;
let lastUrl: string | null = null;
let lastKey: string | null = null;
let isMockClient = false;

/**
 * Validates Supabase configuration without throwing exceptions.
 * Inspects SUPABASE_URL, SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY),
 * and SUPABASE_STORAGE_BUCKET safely.
 *
 * NOTE: The secret key is never included in the validation output.
 */
export function validateSupabaseConfig(): SupabaseConfigValidation {
  if (isMockClient && cachedClient) {
    return {
      valid: true,
      error: null,
      bucket: getSupabaseStorageBucket() || DEFAULT_SUPABASE_STORAGE_BUCKET,
      url: lastUrl || 'https://test-mock-url.supabase.co'
    };
  }

  const rawUrl = (process.env.SUPABASE_URL || process.env.ORVIX_SUPABASE_URL || '').trim();
  const rawKey = (
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.ORVIX_SUPABASE_SECRET_KEY ||
    process.env.ORVIX_SUPABASE_SERVICE_ROLE_KEY ||
    ''
  ).trim();

  const url = getSupabaseUrl();
  const secretKey = getSupabaseSecretKey();
  const bucket = getSupabaseStorageBucket() || DEFAULT_SUPABASE_STORAGE_BUCKET;

  if (!rawUrl && !url) {
    return {
      valid: false,
      error: 'Missing SUPABASE_URL environment variable.',
      bucket,
      url: ''
    };
  }

  if (
    rawUrl &&
    (!isConfiguredCredential(rawUrl) ||
      rawUrl.includes('your-project') ||
      rawUrl.includes('example.supabase.co') ||
      rawUrl.includes('<') ||
      rawUrl.includes('>'))
  ) {
    return {
      valid: false,
      error: 'SUPABASE_URL contains a placeholder or example value.',
      bucket,
      url: rawUrl
    };
  }

  if (!isValidSupabaseUrl(url)) {
    return {
      valid: false,
      error: `Invalid SUPABASE_URL: '${url || rawUrl}'. Must be a valid HTTP or HTTPS URL.`,
      bucket,
      url: url || rawUrl
    };
  }

  if (rawKey && !isConfiguredCredential(rawKey)) {
    return {
      valid: false,
      error: 'SUPABASE_SECRET_KEY contains a placeholder or invalid value.',
      bucket,
      url
    };
  }

  if (!secretKey) {
    return {
      valid: false,
      error: 'Missing SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY) environment variable.',
      bucket,
      url
    };
  }

  return {
    valid: true,
    error: null,
    bucket,
    url
  };
}

/**
 * Returns whether Supabase is properly configured on this server instance.
 */
export function isSupabaseConfigured(): boolean {
  return validateSupabaseConfig().valid;
}

/**
 * Returns safe status information for diagnostics or health reporting.
 * SECURITY: Never exposes SUPABASE_SECRET_KEY or sensitive credentials.
 */
export function getSupabaseStatus(): SupabaseClientStatus {
  const validation = validateSupabaseConfig();
  return {
    isConfigured: validation.valid,
    bucket: validation.bucket,
    url: validation.valid ? validation.url : '',
    error: validation.error
  };
}

/**
 * Returns the active storage bucket name (default: 'orvix-attachments').
 */
export function getSupabaseBucket(): string {
  return getSupabaseStorageBucket() || DEFAULT_SUPABASE_STORAGE_BUCKET;
}

/**
 * Creates or retrieves the singleton server-side Supabase client.
 * Uses the secret/service-role key with session persistence disabled for backend execution.
 * Returns null safely without throwing if configuration is missing or invalid.
 */
export function getSupabaseServerClient(): SupabaseClient | null {
  if (isMockClient && cachedClient) {
    return cachedClient;
  }

  const validation = validateSupabaseConfig();
  if (!validation.valid) {
    return null;
  }

  const url = getSupabaseUrl();
  const secretKey = getSupabaseSecretKey();

  // Return existing singleton if credentials have not changed
  if (cachedClient && lastUrl === url && lastKey === secretKey) {
    return cachedClient;
  }

  try {
    cachedClient = createClient(url, secretKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false
      }
    });
    lastUrl = url;
    lastKey = secretKey;
    return cachedClient;
  } catch (err: any) {
    console.warn('[Supabase] Failed to initialize Supabase server client:', err?.message || err);
    cachedClient = null;
    return null;
  }
}

/**
 * Resets the cached singleton client (used in test suites or dynamic reloads).
 */
export function resetSupabaseClientForTesting(): void {
  cachedClient = null;
  lastUrl = null;
  lastKey = null;
  isMockClient = false;
}

/**
 * Sets a mock or explicit Supabase client for unit and integration testing.
 */
export function setSupabaseServerClientForTesting(client: any, url = 'https://test-mock-url.supabase.co', key = 'test-mock-key'): void {
  cachedClient = client;
  lastUrl = url;
  lastKey = key;
  isMockClient = true;
}

// Re-export storage operations and types for unified developer access
export {
  SupabaseStorageError,
  isValidPathSegment,
  normalizeExtension,
  buildAttachmentStoragePath,
  parseStoragePath,
  assertUserOwnsStoragePath,
  uploadAttachmentToStorage,
  downloadAttachmentFromStorage,
  createAttachmentSignedUrl,
  deleteAttachmentFromStorage,
  deleteAttachmentsForChatInStorage,
  findAttachmentPathInStorage,
  isExactAttachmentMatch
} from './supabaseStorageService.ts';

export type {
  ParsedStoragePath,
  UploadAttachmentOptions,
  UploadAttachmentResult,
  DownloadAttachmentOptions,
  DownloadAttachmentResult,
  CreateSignedUrlOptions,
  CreateSignedUrlResult,
  DeleteAttachmentOptions,
  DeleteAttachmentResult,
  DeleteChatAttachmentsResult,
  FindAttachmentResult
} from './supabaseStorageService.ts';

