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

export interface EnsureBucketOptions {
  forceRefresh?: boolean;
  client?: any;
}

export interface EnsureBucketResult {
  success: boolean;
  bucket: string;
  created: boolean;
  alreadyExisted: boolean;
  isConfigured: boolean;
  error?: string | null;
  code?: string;
  status?: number;
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

const verifiedBuckets = new Set<string>();
const inFlightBucketPromises = new Map<string, Promise<EnsureBucketResult>>();

/**
 * Resets bucket provisioning tracking state (used in automated test suites).
 */
export function resetBucketProvisioningForTesting(): void {
  verifiedBuckets.clear();
  inFlightBucketPromises.clear();
}

/**
 * Idempotently verifies or auto-provisions the configured Supabase Storage bucket.
 *
 * Rules:
 * 1. Checks whether the bucket already exists.
 * 2. If missing, creates it as a PRIVATE bucket ({ public: false }).
 * 3. Never modifies privacy settings or configuration of an existing bucket.
 * 4. Deduplicates concurrent in-flight requests and handles already-exists / 409 responses gracefully.
 * 5. Returns a structured result without exposing credentials.
 * 6. Preserves optional-storage behavior if Supabase is unconfigured (returns status 503 without throwing).
 */
export async function ensureSupabaseBucketExists(
  targetBucket?: string,
  options?: EnsureBucketOptions
): Promise<EnsureBucketResult> {
  const bucketName = (targetBucket || getSupabaseBucket()).trim() || DEFAULT_SUPABASE_STORAGE_BUCKET;

  // If Supabase is not configured, exit gracefully without throwing
  if (!isSupabaseConfigured() && !options?.client && (!isMockClient || !cachedClient)) {
    return {
      success: false,
      bucket: bucketName,
      created: false,
      alreadyExisted: false,
      isConfigured: false,
      error: 'Supabase storage is not configured on this server.',
      code: 'STORAGE_UNCONFIGURED',
      status: 503
    };
  }

  const client = options?.client || getSupabaseServerClient();
  if (!client || !client.storage) {
    return {
      success: false,
      bucket: bucketName,
      created: false,
      alreadyExisted: false,
      isConfigured: false,
      error: 'Supabase client storage is unavailable.',
      code: 'CLIENT_UNAVAILABLE',
      status: 503
    };
  }

  // If already verified during this server lifecycle and not forced, return cached status
  if (!options?.forceRefresh && verifiedBuckets.has(bucketName)) {
    return {
      success: true,
      bucket: bucketName,
      created: false,
      alreadyExisted: true,
      isConfigured: true,
      error: null
    };
  }

  // Deduplicate concurrent in-flight provisioning calls for the same bucket
  if (!options?.forceRefresh && inFlightBucketPromises.has(bucketName)) {
    return inFlightBucketPromises.get(bucketName)!;
  }

  const provisioningPromise = (async (): Promise<EnsureBucketResult> => {
    try {
      // 1. Check if bucket exists
      let bucketFound = false;
      if (typeof client.storage.getBucket === 'function') {
        const { data: bucketData, error: getErr } = await client.storage.getBucket(bucketName);
        if (!getErr && bucketData && (bucketData.name === bucketName || bucketData.id === bucketName)) {
          bucketFound = true;
        }
      } else if (typeof client.storage.listBuckets === 'function') {
        const { data: buckets, error: listErr } = await client.storage.listBuckets();
        if (!listErr && Array.isArray(buckets) && buckets.some((b: any) => b?.name === bucketName || b?.id === bucketName)) {
          bucketFound = true;
        }
      }

      if (bucketFound) {
        verifiedBuckets.add(bucketName);
        return {
          success: true,
          bucket: bucketName,
          created: false,
          alreadyExisted: true,
          isConfigured: true,
          error: null
        };
      }

      // 2. Bucket is missing: create it as PRIVATE ({ public: false })
      if (typeof client.storage.createBucket !== 'function') {
        return {
          success: false,
          bucket: bucketName,
          created: false,
          alreadyExisted: false,
          isConfigured: true,
          error: 'Supabase createBucket method is not available on this client.',
          code: 'METHOD_NOT_SUPPORTED',
          status: 500
        };
      }

      const { data: _createData, error: createErr } = await client.storage.createBucket(bucketName, {
        public: false
      });

      if (createErr) {
        const errMsg = createErr.message || String(createErr);
        const errStatus = (createErr as any).status || (createErr as any).statusCode || 500;

        // Handle race conditions: if bucket was created concurrently by another process
        if (
          /already exists|duplicate|conflict/i.test(errMsg) ||
          errStatus === 409 ||
          (errStatus === 400 && /exists/i.test(errMsg))
        ) {
          verifiedBuckets.add(bucketName);
          return {
            success: true,
            bucket: bucketName,
            created: false,
            alreadyExisted: true,
            isConfigured: true,
            error: null
          };
        }

        return {
          success: false,
          bucket: bucketName,
          created: false,
          alreadyExisted: false,
          isConfigured: true,
          error: errMsg,
          code: createErr.name || 'BUCKET_CREATION_FAILED',
          status: errStatus
        };
      }

      verifiedBuckets.add(bucketName);
      return {
        success: true,
        bucket: bucketName,
        created: true,
        alreadyExisted: false,
        isConfigured: true,
        error: null
      };
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      const errStatus = err?.status || err?.statusCode || 500;
      return {
        success: false,
        bucket: bucketName,
        created: false,
        alreadyExisted: false,
        isConfigured: true,
        error: errMsg,
        code: err?.code || 'PROVISIONING_EXCEPTION',
        status: errStatus
      };
    } finally {
      inFlightBucketPromises.delete(bucketName);
    }
  })();

  inFlightBucketPromises.set(bucketName, provisioningPromise);
  return provisioningPromise;
}

/**
 * Resets the cached singleton client (used in test suites or dynamic reloads).
 */
export function resetSupabaseClientForTesting(): void {
  cachedClient = null;
  lastUrl = null;
  lastKey = null;
  isMockClient = false;
  resetBucketProvisioningForTesting();
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
  isExactAttachmentMatch,
  EXPIRY_RECORDS_PREFIX,
  getDurableExpiryRecordPath,
  parseDurableExpiryRecordPath,
  saveDurableAttachmentExpiry,
  deleteDurableAttachmentExpiry,
  deleteDurableExpiryForChatInStorage,
  listDurableExpiredAttachments
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
  DeleteChatAttachmentsOptions,
  FindAttachmentResult,
  FindAttachmentOptions,
  ParsedDurableExpiryRecord,
  DurableExpiredAttachmentRecord,
  ListDurableExpiredOptions
} from './supabaseStorageService.ts';

