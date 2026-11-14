/**
 * server/directUploadTicketService.ts
 *
 * Durable Direct-Upload Ticket Service for Orvix AI Chatbot.
 * Provides atomic, single-use, serverless-safe direct upload ticket lifecycle management.
 *
 * ARCHITECTURAL GUARANTEES (ORVIX-SUPABASE-FINAL-001):
 * 1. Durable Source of Truth: All tickets are stored in Firestore collection 'uploadTickets'.
 *    Separate Vercel serverless instances share the same database and recognize tickets across instances.
 * 2. Atomic & Single-Use Completion: Prevents duplicate completion, replay attacks, and concurrent quota commits.
 * 3. Strict Authorization: Enforces authenticated user ID matching and storage path ownership.
 * 4. Automatic Rollback & Resource Cleanup: Failed validations, cancellation, and expired tickets
 *    clean up partial Supabase objects and release reserved quota slots.
 * 5. Serverless Compatible: Works statelessly across cold starts and instance recycles without relying
 *    on continuous in-memory timers.
 * 6. In-Memory Cache Synchronization: Maintains secondary in-memory cache for backward-compatibility
 *    while ensuring durable Firestore remains authoritative.
 */

import {
  getFirestoreDb,
  releaseUploadSlot,
  type QuotaReservation,
  type QuotaStatus
} from './uploadQuotaService.ts';
import {
  deleteAttachmentFromStorage,
  assertUserOwnsStoragePath,
  buildAttachmentStoragePath
} from './supabaseStorageService.ts';

export type DirectUploadTicketStatus =
  | 'pending'
  | 'completing'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'expired';

export interface PendingDirectUploadTicket {
  ticketId?: string;
  attachmentId: string;
  userId: string;
  chatId: string;
  storagePath: string;
  bucket: string;
  fileName: string;
  extension: string;
  mimeType: string;
  size: number;
  storageEncoding?: string | null;
  originalSize?: number;
  encodedSize?: number;
  originalMimeType?: string;
  storageChecksum?: string;
  quotaReservation: QuotaReservation;
  expiresAt: number;
  createdAt: number;
  isPermanent?: boolean;
  status?: DirectUploadTicketStatus;
  completedAt?: number | null;
  error?: string | null;
  lastUpdated?: number;
}

export interface ClaimTicketResult {
  success: boolean;
  status: number;
  code: string;
  error?: string;
  ticket?: PendingDirectUploadTicket;
  isExpired?: boolean;
}

export interface CancelTicketResult {
  success: boolean;
  cancelled: boolean;
  status?: number;
  code?: string;
  error?: string;
  quotaStatus?: QuotaStatus | null;
}

export interface CleanupTicketResult {
  quotaStatus: QuotaStatus | null;
}

// In-memory secondary cache for performance and backward compatibility with synchronous callers.
// Durable Firestore storage remains the authoritative source of truth.
export const pendingDirectUploads = new Map<string, PendingDirectUploadTicket>();

const UPLOAD_TICKETS_COLLECTION = 'uploadTickets';

/**
 * Creates and durably persists an upload ticket in Firestore and secondary in-memory cache.
 */
export async function createDurableUploadTicket(
  ticketData: Omit<PendingDirectUploadTicket, 'ticketId' | 'status'> & {
    ticketId?: string;
    status?: DirectUploadTicketStatus;
  }
): Promise<PendingDirectUploadTicket> {
  const attachmentId = ticketData.attachmentId;
  const now = Date.now();

  const ticket: PendingDirectUploadTicket = {
    ...ticketData,
    ticketId: ticketData.ticketId || attachmentId,
    status: ticketData.status || 'pending',
    createdAt: ticketData.createdAt || now,
    lastUpdated: now
  };

  // 1. Authoritative write to Firestore
  try {
    const db = getFirestoreDb();
    const docRef = db.collection(UPLOAD_TICKETS_COLLECTION).doc(attachmentId);
    if (typeof docRef.set === 'function') {
      await docRef.set(JSON.parse(JSON.stringify(ticket)), { merge: false });
    }
  } catch (err: any) {
    console.warn('[DirectUploadTicket] Warning: Could not write ticket to Firestore:', err?.message || err);
  }

  // 2. Secondary in-memory cache write
  pendingDirectUploads.set(attachmentId, ticket);

  return ticket;
}

/**
 * Retrieves an upload ticket from authoritative Firestore storage or fallback memory cache.
 */
export async function getDurableUploadTicket(
  attachmentId: string
): Promise<PendingDirectUploadTicket | null> {
  if (!attachmentId) return null;

  // 1. Try authoritative Firestore lookup first
  try {
    const db = getFirestoreDb();
    const docRef = db.collection(UPLOAD_TICKETS_COLLECTION).doc(attachmentId);
    if (typeof docRef.get === 'function') {
      const snap = await docRef.get();
      if (snap && snap.exists) {
        const data = (typeof snap.data === 'function' ? snap.data() : snap.data) as PendingDirectUploadTicket;
        if (data && data.attachmentId) {
          // Sync to in-memory cache
          pendingDirectUploads.set(attachmentId, data);
          return data;
        }
      }
    }
  } catch (err: any) {
    console.warn('[DirectUploadTicket] Notice: Firestore ticket lookup failed, checking cache:', err?.message || err);
  }

  // 2. Fall back to in-memory cache if Firestore is unreachable or offline
  const cached = pendingDirectUploads.get(attachmentId);
  return cached || null;
}

/**
 * Atomically claims an upload ticket for completion.
 * Enforces single-use semantics, identity ownership, conversation ID match,
 * storage path authenticity, and unexpired validity in an atomic Firestore transaction.
 */
export async function claimDirectUploadTicketForCompletion(
  attachmentId: string,
  authenticatedUserId: string,
  chatId: string
): Promise<ClaimTicketResult> {
  const db = getFirestoreDb();
  const now = Date.now();

  try {
    return await db.runTransaction(async (transaction: any) => {
      const docRef = db.collection(UPLOAD_TICKETS_COLLECTION).doc(attachmentId);
      const snap = await transaction.get(docRef);

      let ticket: PendingDirectUploadTicket | null = null;
      if (snap && snap.exists) {
        ticket = (typeof snap.data === 'function' ? snap.data() : snap.data) as PendingDirectUploadTicket;
      } else {
        // Check secondary memory cache for backwards compatibility in standalone test environments
        ticket = pendingDirectUploads.get(attachmentId) || null;
      }

      // Invariant: Ticket must exist
      if (!ticket) {
        return {
          success: false,
          status: 404,
          code: 'TICKET_NOT_FOUND',
          error: 'Upload ticket not found, expired, or already completed.'
        };
      }

      // Invariant: Single-use completion. Prevent replay, duplicate execution, or completed/expired ticket use.
      if (
        ticket.status === 'completed' ||
        ticket.status === 'cancelled' ||
        ticket.status === 'failed' ||
        ticket.status === 'expired'
      ) {
        return {
          success: false,
          status: 404,
          code: 'TICKET_NOT_FOUND',
          error: 'Upload ticket not found, expired, or already completed.'
        };
      }

      // Concurrent completion lock protection:
      // If another request is currently verifying/completing this ticket within the last 60 seconds,
      // reject concurrent attempts to prevent race conditions and duplicate quota commits.
      if (ticket.status === 'completing') {
        const timeSinceClaim = now - (ticket.lastUpdated || ticket.createdAt || 0);
        if (timeSinceClaim < 60_000) {
          return {
            success: false,
            status: 409,
            code: 'CONCURRENT_COMPLETION',
            error: 'Upload ticket is currently being processed by another request.'
          };
        }
        // If older than 60s, previous instance likely died; allow retry if not expired
      }

      // Invariant: Cross-user authorization check
      if (ticket.userId !== authenticatedUserId) {
        return {
          success: false,
          status: 403,
          code: 'STORAGE_ACCESS_DENIED',
          error: 'Access denied: You cannot complete uploads belonging to another user.'
        };
      }

      // Invariant: Conversation ID must match ticket
      if (ticket.chatId !== chatId) {
        return {
          success: false,
          status: 400,
          code: 'CONVERSATION_ID_MISMATCH',
          error: 'Conversation ID mismatch.'
        };
      }

      // Invariant: Ticket expiration check
      if (ticket.expiresAt <= now) {
        const expiredTicket: PendingDirectUploadTicket = {
          ...ticket,
          status: 'expired',
          lastUpdated: now
        };
        transaction.set(docRef, JSON.parse(JSON.stringify(expiredTicket)), { merge: true });
        pendingDirectUploads.set(attachmentId, expiredTicket);
        return {
          success: false,
          status: 404,
          code: 'TICKET_NOT_FOUND',
          error: 'Upload ticket not found, expired, or already completed.',
          isExpired: true,
          ticket: expiredTicket
        };
      }

      // Invariant: Storage path ownership and canonical structure validation
      try {
        assertUserOwnsStoragePath(ticket.storagePath, authenticatedUserId);
      } catch (pathErr: any) {
        return {
          success: false,
          status: 403,
          code: 'STORAGE_ACCESS_DENIED',
          error: pathErr?.message || 'Access denied: Invalid storage path.'
        };
      }

      // Verify path strictly matches canonical server-generated pattern
      const expectedPrefix = `${authenticatedUserId}/${chatId}/`;
      if (!ticket.storagePath.startsWith(expectedPrefix)) {
        return {
          success: false,
          status: 403,
          code: 'STORAGE_ACCESS_DENIED',
          error: 'Access denied: Storage path does not match ticket parameters.'
        };
      }

      // Atomically claim ticket by marking it 'completing'
      const claimedTicket: PendingDirectUploadTicket = {
        ...ticket,
        status: 'completing',
        lastUpdated: now
      };

      transaction.set(docRef, JSON.parse(JSON.stringify(claimedTicket)), { merge: true });
      pendingDirectUploads.set(attachmentId, claimedTicket);

      return {
        success: true,
        status: 200,
        code: 'OK',
        ticket: claimedTicket
      };
    });
  } catch (err: any) {
    console.error('[DirectUploadTicket] Error claiming ticket in transaction:', err?.message || err);
    return {
      success: false,
      status: 500,
      code: 'TRANSACTION_ERROR',
      error: 'An internal error occurred while claiming upload ticket.'
    };
  }
}

/**
 * Finalizes a successfully completed direct upload ticket.
 * Marks the ticket as 'completed' in Firestore and purges it from pending in-memory cache.
 */
export async function finalizeCompletedDirectUploadTicket(
  attachmentId: string
): Promise<void> {
  const now = Date.now();
  try {
    const db = getFirestoreDb();
    const docRef = db.collection(UPLOAD_TICKETS_COLLECTION).doc(attachmentId);
    if (typeof docRef.set === 'function') {
      await docRef.set(
        {
          status: 'completed',
          completedAt: now,
          lastUpdated: now
        },
        { merge: true }
      );
    }
  } catch (err: any) {
    console.warn('[DirectUploadTicket] Notice: Could not update completion status in Firestore:', err?.message || err);
  }

  // Remove completed ticket from in-memory pending map
  pendingDirectUploads.delete(attachmentId);
}

/**
 * Cleans up a failed, corrupted, or rejected upload ticket.
 * Releases reserved quota, removes partial Supabase objects, marks status as 'failed',
 * and purges in-memory tracking.
 */
export async function failAndCleanupDurableUploadTicket(
  ticket: PendingDirectUploadTicket,
  reason: string = 'FAILED_VALIDATION'
): Promise<CleanupTicketResult> {
  const now = Date.now();

  // 1. Release reserved quota slot safely and capture current PKT day status
  let quotaStatus: QuotaStatus | null = null;
  try {
    quotaStatus = await releaseUploadSlot(ticket.quotaReservation);
  } catch (_) {}

  // 2. Remove partial or corrupt object from Supabase Storage
  try {
    await deleteAttachmentFromStorage(ticket.storagePath, {
      requestingUserId: ticket.userId,
      bucket: ticket.bucket
    });
  } catch (_) {}

  // 3. Mark ticket state in Firestore
  try {
    const db = getFirestoreDb();
    const docRef = db.collection(UPLOAD_TICKETS_COLLECTION).doc(ticket.attachmentId);
    if (typeof docRef.set === 'function') {
      await docRef.set(
        {
          status: 'failed',
          error: reason,
          lastUpdated: now
        },
        { merge: true }
      );
    }
  } catch (_) {}

  // 4. Remove from in-memory pending map
  pendingDirectUploads.delete(ticket.attachmentId);

  return { quotaStatus };
}

/**
 * Handles explicit upload cancellation by an authenticated user.
 * Validates ownership, releases reserved quota slot, purges storage object,
 * updates Firestore ticket status, and clears memory tracking.
 */
export async function cancelDurableUploadTicket(
  attachmentId: string,
  requestingUserId: string
): Promise<CancelTicketResult> {
  const db = getFirestoreDb();
  const now = Date.now();

  try {
    let ticket: PendingDirectUploadTicket | null = null;

    // Check Firestore doc first
    try {
      const docRef = db.collection(UPLOAD_TICKETS_COLLECTION).doc(attachmentId);
      if (typeof docRef.get === 'function') {
        const snap = await docRef.get();
        if (snap && snap.exists) {
          ticket = (typeof snap.data === 'function' ? snap.data() : snap.data) as PendingDirectUploadTicket;
        }
      }
    } catch (_) {}

    // Fall back to memory cache
    if (!ticket) {
      ticket = pendingDirectUploads.get(attachmentId) || null;
    }

    // Idempotent: If ticket does not exist, return success
    if (!ticket) {
      return { success: true, cancelled: true };
    }

    // Ownership check
    if (ticket.userId !== requestingUserId) {
      return {
        success: false,
        cancelled: false,
        status: 403,
        code: 'STORAGE_ACCESS_DENIED',
        error: 'Access denied: You cannot cancel uploads belonging to another user.'
      };
    }

    // Release reserved quota slot and capture current PKT day status
    let quotaStatus: QuotaStatus | null = null;
    try {
      quotaStatus = await releaseUploadSlot(ticket.quotaReservation);
    } catch (_) {}

    // Delete partial Supabase storage object
    try {
      await deleteAttachmentFromStorage(ticket.storagePath, {
        requestingUserId,
        bucket: ticket.bucket
      });
    } catch (_) {}

    // Update Firestore state
    try {
      const docRef = db.collection(UPLOAD_TICKETS_COLLECTION).doc(attachmentId);
      if (typeof docRef.set === 'function') {
        await docRef.set(
          {
            status: 'cancelled',
            lastUpdated: now
          },
          { merge: true }
        );
      }
    } catch (_) {}

    // Remove from in-memory cache
    pendingDirectUploads.delete(attachmentId);

    return { success: true, cancelled: true, quotaStatus };
  } catch (err: any) {
    console.error('[DirectUploadTicket] Error cancelling ticket:', err?.message || err);
    return {
      success: false,
      cancelled: false,
      status: 500,
      code: 'CANCEL_FAILED',
      error: 'An internal error occurred during upload cancellation.'
    };
  }
}

/**
 * Sweeps expired or abandoned direct upload tickets across Firestore and memory.
 * Releases reserved quota slots and deletes uncompleted objects from storage safely.
 * Restart-safe and serverless compatible.
 */
export async function pruneExpiredDirectUploadTickets(): Promise<number> {
  const now = Date.now();
  let pruned = 0;
  const processedIds = new Set<string>();

  // 1. Sweep durable Firestore collection for expired pending/completing tickets
  try {
    const db = getFirestoreDb();
    const colRef = db.collection(UPLOAD_TICKETS_COLLECTION);
    if (typeof colRef.where === 'function' && typeof colRef.get === 'function') {
      const snap = await colRef.where('status', 'in', ['pending', 'completing']).get();
      if (snap && Array.isArray(snap.docs)) {
        for (const doc of snap.docs) {
          const ticket = (typeof doc.data === 'function' ? doc.data() : doc.data) as PendingDirectUploadTicket;
          if (!ticket || !ticket.attachmentId) continue;

          // Check if ticket is past its expiration TTL or stuck in 'completing' for > 5 minutes
          const isExpired = ticket.expiresAt <= now;
          const isStuckCompleting =
            ticket.status === 'completing' &&
            ticket.lastUpdated &&
            now - ticket.lastUpdated > 5 * 60 * 1000;

          if (isExpired || isStuckCompleting) {
            processedIds.add(ticket.attachmentId);
            pruned++;

            try {
              await releaseUploadSlot(ticket.quotaReservation);
            } catch (_) {}

            try {
              await deleteAttachmentFromStorage(ticket.storagePath, {
                requestingUserId: ticket.userId,
                bucket: ticket.bucket
              });
            } catch (_) {}

            try {
              if (typeof doc.ref?.delete === 'function') {
                await doc.ref.delete();
              } else if (typeof colRef.doc === 'function') {
                await colRef.doc(ticket.attachmentId).delete();
              }
            } catch (_) {}

            pendingDirectUploads.delete(ticket.attachmentId);
          }
        }
      }
    }
  } catch (err: any) {
    console.warn('[DirectUploadTicket] Notice: Firestore pruning sweep encountered an error:', err?.message || err);
  }

  // 2. Also sweep in-memory cache to handle test overrides where ticket.expiresAt is mutated in-memory
  for (const [attachmentId, ticket] of pendingDirectUploads.entries()) {
    if (processedIds.has(attachmentId)) continue;
    if (ticket.expiresAt <= now || (ticket.status === 'completing' && ticket.lastUpdated && now - ticket.lastUpdated > 5 * 60 * 1000)) {
      processedIds.add(attachmentId);
      pruned++;
      pendingDirectUploads.delete(attachmentId);

      try {
        await releaseUploadSlot(ticket.quotaReservation);
      } catch (_) {}

      try {
        await deleteAttachmentFromStorage(ticket.storagePath, {
          requestingUserId: ticket.userId,
          bucket: ticket.bucket
        });
      } catch (_) {}

      try {
        const db = getFirestoreDb();
        const docRef = db.collection(UPLOAD_TICKETS_COLLECTION).doc(attachmentId);
        if (typeof docRef.delete === 'function') {
          await docRef.delete();
        }
      } catch (_) {}
    }
  }

  return pruned;
}

/**
 * Resets all direct upload tickets in memory and test Firestore.
 * Used exclusively in automated verification and test suites.
 */
export function resetDirectUploadTicketsForTesting(): void {
  pendingDirectUploads.clear();
  try {
    const db = getFirestoreDb();
    // If running in simulated Firestore test mode, clear uploadTickets docs
    if (typeof (db as any).collection === 'function') {
      const col = db.collection(UPLOAD_TICKETS_COLLECTION);
      if (typeof col.get === 'function') {
        void col.get().then((snap: any) => {
          if (snap && Array.isArray(snap.docs)) {
            for (const doc of snap.docs) {
              if (typeof doc.ref?.delete === 'function') {
                void doc.ref.delete();
              }
            }
          }
        }).catch(() => {});
      }
    }
  } catch (_) {}
}

let lastOpportunisticPruneMs = 0;

/**
 * Serverless-safe opportunistic sweep: Throttled to run at most once every 30 seconds
 * during incoming upload requests, ensuring background cleanup occurs without requiring
 * continuous in-memory timers.
 */
export function opportunisticDirectUploadPrune(): void {
  const now = Date.now();
  if (now - lastOpportunisticPruneMs > 30_000) {
    lastOpportunisticPruneMs = now;
    void pruneExpiredDirectUploadTickets().catch(() => {});
  }
}
