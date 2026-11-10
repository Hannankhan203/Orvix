/**
 * Server-Side Supabase Storage Attachment Expiry Cleanup Service
 *
 * Responsibilities:
 * 1. Safely sweep and remove expired staging/guest attachments from Supabase Storage.
 * 2. Strictly protect authenticated permanent user attachments from accidental deletion.
 * 3. Execute deletions in controlled batches to prevent API rate limits or timeout spikes.
 * 4. Guarantee idempotency and prevent overlapping concurrent executions.
 * 5. Handle partial failures resiliently without dropping tracking for remaining work.
 * 6. Synchronize storage deletion with in-memory fileRegistry and local disk cache.
 * 7. Provide graceful scheduler lifecycle management (start, stop, status).
 * 8. Never expose Supabase credentials, tokens, or private paths in logs.
 */

import fs from 'fs';
import path from 'path';
import {
  getSupabaseServerClient,
  getSupabaseBucket,
  isSupabaseConfigured
} from './supabaseClient.ts';
import {
  listDurableExpiredAttachments
} from './supabaseStorageService.ts';
import {
  fileRegistry as defaultRegistry,
  conversationDocuments as defaultConversationDocs,
  UPLOAD_DIR
} from './uploadSubsystem.ts';
import {
  isSupabaseAttachmentCleanupEnabled,
  getSupabaseAttachmentCleanupIntervalMs,
  getSupabaseAttachmentCleanupBatchSize
} from './serverConfig.ts';
import type { UploadedFileRecord } from './serverTypes.ts';

export interface SupabaseAttachmentCleanupOptions {
  registry?: Map<string, UploadedFileRecord>;
  conversationDocs?: Map<string, Set<string>>;
  batchSize?: number;
  nowMs?: number;
  client?: any;
  bucket?: string;
  uploadDir?: string;
}

export interface SupabaseAttachmentCleanupResult {
  success: boolean;
  scannedCount: number;
  expiredCount: number;
  deletedCount: number;
  failedCount: number;
  skippedPermanentCount: number;
  skippedNonSupabaseCount: number;
  skippedFutureCount: number;
  batchCount: number;
  error?: string | null;
}

export interface SchedulerStatus {
  running: boolean;
  enabled: boolean;
  intervalMs: number;
  lastRunTimestamp: number | null;
  lastResult: SupabaseAttachmentCleanupResult | null;
}

let activeSchedulerTimer: NodeJS.Timeout | null = null;
let isCleanupInProgress = false;
let lastRunTimestamp: number | null = null;
let lastCleanupResult: SupabaseAttachmentCleanupResult | null = null;

/**
 * Checks whether an attachment record is eligible for automatic expiry cleanup.
 *
 * Security & Integrity Invariants:
 * - Must be stored in Supabase ('supabase' storageProvider).
 * - Must possess a valid storage path.
 * - MUST NOT be marked permanent (isPermanent === true).
 * - Must have a valid numeric expiresAt timestamp that has passed (expiresAt <= nowMs).
 */
export function isAttachmentEligibleForExpiryCleanup(
  record: UploadedFileRecord,
  nowMs: number = Date.now()
): { eligible: boolean; reason: 'eligible' | 'permanent' | 'non_supabase' | 'future' | 'invalid_path' } {
  if (!record || typeof record !== 'object') {
    return { eligible: false, reason: 'non_supabase' };
  }

  // Only Supabase-backed storage records are managed by this cleanup service
  if (record.storageProvider !== 'supabase' || !record.storagePath) {
    return { eligible: false, reason: 'non_supabase' };
  }

  // Strict protection: permanent attachments must NEVER be automatically pruned
  if (record.isPermanent === true) {
    return { eligible: false, reason: 'permanent' };
  }

  // Records with missing, non-numeric, or zero expiresAt are treated as permanent
  if (typeof record.expiresAt !== 'number' || !Number.isFinite(record.expiresAt) || record.expiresAt <= 0) {
    return { eligible: false, reason: 'permanent' };
  }

  // Not yet expired
  if (record.expiresAt > nowMs) {
    return { eligible: false, reason: 'future' };
  }

  return { eligible: true, reason: 'eligible' };
}

/**
 * Executes a single sweep of expired Supabase attachments across the registry.
 * Idempotent, concurrency-guarded, and executed in bounded batches.
 */
export async function runExpiredSupabaseAttachmentCleanup(
  options?: SupabaseAttachmentCleanupOptions
): Promise<SupabaseAttachmentCleanupResult> {
  const nowMs = typeof options?.nowMs === 'number' ? options.nowMs : Date.now();
  const registry = options?.registry || defaultRegistry;
  const convDocs = options?.conversationDocs || defaultConversationDocs;
  const targetUploadDir = options?.uploadDir || UPLOAD_DIR;
  const effectiveBatchSize = Math.max(
    1,
    Math.min(100, typeof options?.batchSize === 'number' ? options.batchSize : getSupabaseAttachmentCleanupBatchSize())
  );

  // If Supabase is unconfigured and no test client override is provided, exit safely
  if (!isSupabaseConfigured() && !options?.client) {
    const unconfiguredResult: SupabaseAttachmentCleanupResult = {
      success: false,
      scannedCount: 0,
      expiredCount: 0,
      deletedCount: 0,
      failedCount: 0,
      skippedPermanentCount: 0,
      skippedNonSupabaseCount: 0,
      skippedFutureCount: 0,
      batchCount: 0,
      error: 'Supabase storage is not configured on this server.'
    };
    lastCleanupResult = unconfiguredResult;
    return unconfiguredResult;
  }

  // Prevent overlapping concurrent executions
  if (isCleanupInProgress) {
    return {
      success: true,
      scannedCount: 0,
      expiredCount: 0,
      deletedCount: 0,
      failedCount: 0,
      skippedPermanentCount: 0,
      skippedNonSupabaseCount: 0,
      skippedFutureCount: 0,
      batchCount: 0,
      error: 'Cleanup already in progress; skipped overlapping run.'
    };
  }

  isCleanupInProgress = true;
  lastRunTimestamp = nowMs;

  const result: SupabaseAttachmentCleanupResult = {
    success: true,
    scannedCount: 0,
    expiredCount: 0,
    deletedCount: 0,
    failedCount: 0,
    skippedPermanentCount: 0,
    skippedNonSupabaseCount: 0,
    skippedFutureCount: 0,
    batchCount: 0,
    error: null
  };

  try {
    const client = options?.client || getSupabaseServerClient();
    if (!client || !client.storage) {
      result.success = false;
      result.error = 'Supabase storage client is unavailable.';
      lastCleanupResult = result;
      return result;
    }

    const activeBucket = options?.bucket || getSupabaseBucket();
    const eligibleRecords: Array<{
      id: string;
      storagePath: string;
      diskFilename?: string;
      conversationId?: string;
      expiryRecordPath?: string;
    }> = [];
    const seenStoragePaths = new Set<string>();

    // 1. Identify eligible expired Supabase attachments from in-memory registry
    for (const [id, record] of registry.entries()) {
      result.scannedCount++;
      const check = isAttachmentEligibleForExpiryCleanup(record, nowMs);
      if (check.eligible) {
        result.expiredCount++;
        eligibleRecords.push({
          id,
          storagePath: record.storagePath!,
          diskFilename: record.diskFilename,
          conversationId: record.conversationId
        });
        seenStoragePaths.add(record.storagePath!);
      } else {
        if (check.reason === 'permanent') result.skippedPermanentCount++;
        else if (check.reason === 'non_supabase') result.skippedNonSupabaseCount++;
        else if (check.reason === 'future') result.skippedFutureCount++;
      }
    }

    // 2. Discover durable expired attachments from Supabase Storage (_expiry_records/)
    // Guarantees expired temporary attachments are discovered and deleted even when fileRegistry is empty
    try {
      const durableExpired = await listDurableExpiredAttachments({
        nowMs,
        bucket: activeBucket,
        client
      });

      for (const durable of durableExpired) {
        if (seenStoragePaths.has(durable.storagePath)) {
          // Attach expiryRecordPath to the matching item in eligibleRecords
          const match = eligibleRecords.find((r) => r.storagePath === durable.storagePath);
          if (match) {
            match.expiryRecordPath = durable.expiryRecordPath;
          }
        } else {
          // Discovered from durable storage (e.g. post-restart)
          result.scannedCount++;
          result.expiredCount++;
          seenStoragePaths.add(durable.storagePath);
          eligibleRecords.push({
            id: durable.id,
            storagePath: durable.storagePath,
            conversationId: durable.chatId,
            expiryRecordPath: durable.expiryRecordPath
          });
        }
      }
    } catch (durableErr) {
      console.warn('[Supabase Cleanup] Notice: Could not list durable expired attachments:', durableErr);
    }

    if (eligibleRecords.length === 0) {
      lastCleanupResult = result;
      return result;
    }

    // 3. Process deletions in controlled batches
    for (let i = 0; i < eligibleRecords.length; i += effectiveBatchSize) {
      result.batchCount++;
      const currentBatch = eligibleRecords.slice(i, i + effectiveBatchSize);
      const pathsToDelete = currentBatch.map((item) => item.storagePath);

      try {
        const { data: removeData, error: removeErr } = await client.storage
          .from(activeBucket)
          .remove(pathsToDelete);

        if (removeErr) {
          result.failedCount += currentBatch.length;
          console.warn(`[Supabase Cleanup] Batch ${result.batchCount} removal notice: ${removeErr.message || removeErr}`);
          // On failure, do not prune from registry or delete expiry records so they remain eligible for retry
          continue;
        }

        // Successfully deleted items
        const successfullyDeletedPaths = new Set<string>();
        if (Array.isArray(removeData)) {
          for (const item of removeData) {
            if (item?.name) successfullyDeletedPaths.add(item.name);
          }
        }

        const confirmedExpiryPathsToRemove: string[] = [];

        for (const item of currentBatch) {
          // If Supabase returned explicit removed data, verify; otherwise assume batch succeeded
          const isConfirmedDeleted =
            !Array.isArray(removeData) ||
            removeData.length === currentBatch.length ||
            successfullyDeletedPaths.has(item.storagePath) ||
            successfullyDeletedPaths.has(path.basename(item.storagePath));

          if (isConfirmedDeleted) {
            result.deletedCount++;
            // Synchronize with fileRegistry
            registry.delete(item.id);

            // Synchronize with conversationDocuments if applicable
            if (item.conversationId && convDocs.has(item.conversationId)) {
              convDocs.get(item.conversationId)!.delete(item.id);
            }

            // Clean up temporary local disk cache file
            if (item.diskFilename) {
              const localPath = path.join(targetUploadDir, item.diskFilename);
              fs.promises.unlink(localPath).catch(() => {});
            }

            // Track durable expiry record for removal
            if (item.expiryRecordPath) {
              confirmedExpiryPathsToRemove.push(item.expiryRecordPath);
            }
          } else {
            result.failedCount++;
          }
        }

        // Remove confirmed expiry records from durable storage
        if (confirmedExpiryPathsToRemove.length > 0) {
          try {
            await client.storage.from(activeBucket).remove(confirmedExpiryPathsToRemove);
          } catch (expRemErr) {
            console.warn('[Supabase Cleanup] Notice: Could not remove confirmed expiry records:', expRemErr);
          }
        }
      } catch (batchErr: any) {
        result.failedCount += currentBatch.length;
        console.warn(`[Supabase Cleanup] Batch ${result.batchCount} exception: ${batchErr?.message || batchErr}`);
      }
    }

    if (result.deletedCount > 0) {
      console.log(
        `[Supabase Cleanup] Pruned ${result.deletedCount} expired attachment(s) in ${result.batchCount} batch(es).`
      );
    }
  } catch (err: any) {
    result.success = false;
    result.error = err?.message || 'Unexpected exception during Supabase attachment expiry cleanup.';
    console.warn('[Supabase Cleanup] Unexpected cleanup error:', result.error);
  } finally {
    isCleanupInProgress = false;
    lastCleanupResult = result;
  }

  return result;
}

/**
 * Starts the recurring Supabase attachment expiry cleanup scheduler.
 * Safe against multiple calls (clears any existing timer before starting).
 */
export function startSupabaseAttachmentCleanupScheduler(
  intervalMsOverride?: number
): NodeJS.Timeout | null {
  if (!isSupabaseAttachmentCleanupEnabled()) {
    console.log('[Supabase Cleanup] Automatic attachment cleanup scheduler is disabled via configuration.');
    return null;
  }

  // Clear existing timer if already running
  stopSupabaseAttachmentCleanupScheduler();

  const intervalMs =
    typeof intervalMsOverride === 'number' && intervalMsOverride >= 1000
      ? intervalMsOverride
      : getSupabaseAttachmentCleanupIntervalMs();

  activeSchedulerTimer = setInterval(() => {
    runExpiredSupabaseAttachmentCleanup().catch((err) => {
      console.warn('[Supabase Cleanup] Scheduled cleanup error:', err?.message || err);
    });
  }, intervalMs);

  if (activeSchedulerTimer.unref) {
    activeSchedulerTimer.unref();
  }

  console.log(`[Supabase Cleanup] Scheduled automatic attachment expiry cleanup every ${Math.round(intervalMs / 1000)}s.`);
  return activeSchedulerTimer;
}

/**
 * Gracefully stops the Supabase attachment expiry cleanup scheduler.
 */
export function stopSupabaseAttachmentCleanupScheduler(): void {
  if (activeSchedulerTimer) {
    clearInterval(activeSchedulerTimer);
    activeSchedulerTimer = null;
  }
}

/**
 * Retrieves the current runtime status of the cleanup scheduler (for diagnostics and health checks).
 */
export function getSupabaseAttachmentCleanupSchedulerStatus(): SchedulerStatus {
  return {
    running: activeSchedulerTimer !== null,
    enabled: isSupabaseAttachmentCleanupEnabled(),
    intervalMs: getSupabaseAttachmentCleanupIntervalMs(),
    lastRunTimestamp,
    lastResult: lastCleanupResult
  };
}

/**
 * Resets cleanup state for testing purposes.
 */
export function resetCleanupStateForTesting(): void {
  stopSupabaseAttachmentCleanupScheduler();
  isCleanupInProgress = false;
  lastRunTimestamp = null;
  lastCleanupResult = null;
}
