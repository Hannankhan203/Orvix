import type express from 'express';
import {
  authenticateRequest,
  type AuthVerificationResult
} from './firebaseAuthHelper.ts';
import { getFirestoreDb } from './uploadQuotaService.ts';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import {
  buildValidatedSharedSnapshot,
  extractShareTimestampMs,
  isShareSnapshotExpired,
  isValidShareId,
  ShareChatError,
  validateSharedSnapshotPayload
} from '../src/services/shareChatService.js';
import {
  createRateLimiterMiddleware,
  type CreateRateLimiterOptions
} from './rateLimiter.ts';

/**
 * Checks if a verified Firebase user is non-anonymous and eligible to publish or revoke shared chats.
 */
function isEligibleServerShareUser(user: any): boolean {
  if (!user || typeof user !== 'object') return false;
  const claims = user.claims || {};
  const firebaseInfo = claims.firebase || {};
  if (claims.isAnonymous === true || firebaseInfo.sign_in_provider === 'anonymous') {
    return false;
  }
  return typeof user.uid === 'string' && user.uid.trim().length > 0;
}

/**
 * Detects Firestore ALREADY_EXISTS errors across Firebase Admin SDK, gRPC status codes,
 * and simulated test adapters.
 */
function isFirestoreAlreadyExistsError(err: any): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = err.code;
  if (code === 6 || code === '6') return true;
  if (typeof code === 'string') {
    const normalized = code.trim().toLowerCase();
    if (normalized === 'already_exists' || normalized === 'already-exists') {
      return true;
    }
  }
  const message = typeof err.message === 'string' ? err.message : '';
  const details = typeof err.details === 'string' ? err.details : '';
  return /\bALREADY_EXISTS\b/i.test(message) || /\bALREADY_EXISTS\b/i.test(details);
}

/**
 * Express handler for POST /api/share
 * Rigorously validates every message and optional expiration timestamp on the server side
 * and persists the shared snapshot with authoritative `ownerId` to Firestore.
 */
export async function handleShareChatRequest(req: express.Request, res: express.Response) {
  try {
    const authResult = await authenticateRequest(req);
    if (authResult.status === 'invalid') {
      return res.status(401).json({
        error: authResult.error,
        code: authResult.code
      });
    }

    if (authResult.status === 'guest') {
      return res.status(401).json({
        error: 'Please sign in with an Orvix account to share conversations.',
        code: 'AUTH_REQUIRED'
      });
    }

    if (!isEligibleServerShareUser(authResult.user)) {
      return res.status(401).json({
        error: 'Anonymous users are not permitted to share conversations. Please upgrade your account.',
        code: 'ANONYMOUS_SHARE_DENIED'
      });
    }

    const {
      shareId,
      chat,
      messages,
      expirationPreset,
      expiresInSeconds,
      expiresAt
    } = req.body || {};

    if (!shareId || typeof shareId !== 'string' || !shareId.trim()) {
      return res.status(400).json({
        error: 'Invalid or missing share ID.',
        code: 'INVALID_SHARE_ID'
      });
    }

    const canonicalInputShareId = shareId.trim();

    // Run rigorous validation and sanitization on EVERY message & expiration setting
    let validationResult;
    try {
      validationResult = buildValidatedSharedSnapshot({
        shareId: canonicalInputShareId,
        chat,
        messages,
        expirationPreset,
        expiresInSeconds,
        expiresAt
      });
    } catch (err: any) {
      if (err instanceof ShareChatError) {
        const statusCode = err.code === 'SNAPSHOT_TOO_LARGE' || err.code === 'SNAPSHOT_TOO_MANY_MESSAGES' ? 413 : 400;
        return res.status(statusCode).json({
          error: err.message,
          code: err.code || 'VALIDATION_FAILED'
        });
      }
      return res.status(400).json({
        error: err?.message || 'Invalid conversation share payload.',
        code: 'INVALID_PAYLOAD'
      });
    }

    const { documentData, byteSize } = validationResult;
    const docData = documentData as any;
    const canonicalShareId =
      typeof docData?.id === 'string' && docData.id.trim()
        ? docData.id.trim()
        : canonicalInputShareId;

    const resolvedExpiresAtMs =
      typeof docData?.expiresAtMs === 'number' && Number.isFinite(docData.expiresAtMs)
        ? Math.trunc(docData.expiresAtMs)
        : null;
    const expiresAtTimestamp =
      resolvedExpiresAtMs !== null ? Timestamp.fromMillis(resolvedExpiresAtMs) : null;

    // Authoritative ownerId MUST come strictly from verified Firebase token UID
    const snapshotPayload = {
      ...documentData,
      id: canonicalShareId,
      ownerId: authResult.user.uid,
      revoked: false,
      revokedAt: null,
      revokedAtMs: null,
      expiresAt: expiresAtTimestamp,
      expiresAtMs: resolvedExpiresAtMs,
      createdAt: FieldValue.serverTimestamp(),
      createdAtMs: Date.now()
    };

    let db;
    try {
      db = getFirestoreDb();
    } catch (dbErr: any) {
      console.error('[ShareSubsystem] Failed to initialize Firestore Admin client:', dbErr);
      return res.status(503).json({
        error: 'Cloud sharing database is currently unavailable.',
        code: 'DATABASE_UNAVAILABLE'
      });
    }

    const shareDocRef = db.collection('sharedChats').doc(canonicalShareId);
    try {
      if (typeof shareDocRef.create === 'function') {
        await shareDocRef.create(snapshotPayload);
      } else if (typeof db.runTransaction === 'function') {
        await db.runTransaction(async (transaction: any) => {
          const existingSnap = await transaction.get(shareDocRef);
          if (existingSnap?.exists) {
            const existsErr: any = new Error(`Document already exists: sharedChats/${canonicalShareId}`);
            existsErr.code = 6;
            throw existsErr;
          }
          transaction.set(shareDocRef, snapshotPayload);
        });
      } else {
        const existingSnap = await shareDocRef.get();
        if (existingSnap?.exists) {
          const existsErr: any = new Error(`Document already exists: sharedChats/${canonicalShareId}`);
          existsErr.code = 6;
          throw existsErr;
        }
        await shareDocRef.set(snapshotPayload);
      }
    } catch (writeErr: any) {
      if (isFirestoreAlreadyExistsError(writeErr)) {
        return res.status(409).json({
          error: 'A shared conversation with this share ID already exists.',
          code: 'SHARE_ID_ALREADY_EXISTS'
        });
      }
      throw writeErr;
    }

    return res.status(200).json({
      success: true,
      shareId: canonicalShareId,
      title: docData.title,
      mode: docData.mode,
      messageCount: docData.messageCount,
      byteSize,
      expiresAtMs: resolvedExpiresAtMs,
      revoked: false
    });
  } catch (err: any) {
    console.error('[ShareSubsystem] Error processing share request:', err);
    return res.status(500).json({
      error: err?.message || 'Failed to publish shared conversation snapshot.',
      code: 'PUBLISH_FAILED'
    });
  }
}

/**
 * Constructs a strictly allowlisted public shared-chat payload for GET /api/share/:shareId.
 * Guarantees internal ownership and revocation-audit fields (`ownerId`, `revokedAt`, `revokedAtMs`,
 * `userId`, etc.) can never be exposed to unauthenticated or third-party visitors.
 */
function buildPublicSharedSnapshotResponse(sanitizedSnapshot: any, createdAtMs: number | null) {
  return {
    id: sanitizedSnapshot.id,
    title: sanitizedSnapshot.title,
    mode: sanitizedSnapshot.mode,
    createdAt: createdAtMs !== null && Number.isFinite(createdAtMs) ? createdAtMs : null,
    expiresAtMs:
      typeof sanitizedSnapshot.expiresAtMs === 'number' && Number.isFinite(sanitizedSnapshot.expiresAtMs)
        ? sanitizedSnapshot.expiresAtMs
        : null,
    revoked: false,
    messageCount: sanitizedSnapshot.messageCount,
    messages: sanitizedSnapshot.messages,
    isSharedSnapshot: true
  };
}

/**
 * Express handler for GET /api/share/:shareId
 * Retrieves an active shared conversation snapshot while enforcing revocation and expiration.
 * Never leaks `ownerId` or private owner fields in the public response.
 */
export async function handleGetShareChatRequest(req: express.Request, res: express.Response) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  try {
    const shareId = typeof req.params?.shareId === 'string' ? req.params.shareId.trim() : '';
    if (!isValidShareId(shareId)) {
      return res.status(400).json({
        error: 'The shared conversation link is invalid or malformed.',
        code: 'INVALID_SHARE_ID'
      });
    }

    let db;
    try {
      db = getFirestoreDb();
    } catch (dbErr: any) {
      console.error('[ShareSubsystem] Failed to initialize Firestore Admin client for GET:', dbErr);
      return res.status(503).json({
        error: 'Cloud sharing database is currently unavailable.',
        code: 'DATABASE_UNAVAILABLE'
      });
    }

    const shareDocRef = db.collection('sharedChats').doc(shareId);
    const snap = await shareDocRef.get();
    if (!snap?.exists) {
      return res.status(404).json({
        error: 'This shared conversation no longer exists or the link is invalid.',
        code: 'NOT_FOUND'
      });
    }

    const data = snap.data() || {};
    if (data.revoked === true) {
      return res.status(410).json({
        error: 'This shared conversation link has been revoked by its owner.',
        code: 'SHARE_REVOKED'
      });
    }

    if (isShareSnapshotExpired(data)) {
      return res.status(410).json({
        error: 'This shared conversation link has expired.',
        code: 'SHARE_EXPIRED'
      });
    }

    let sanitizedSnapshot;
    try {
      sanitizedSnapshot = validateSharedSnapshotPayload(data, shareId);
    } catch (err: any) {
      if (err instanceof ShareChatError) {
        const statusCode =
          err.code === 'SHARE_REVOKED' || err.code === 'SHARE_EXPIRED' ? 410 : 400;
        return res.status(statusCode).json({
          error: err.message,
          code: err.code
        });
      }
      return res.status(500).json({
        error: 'Shared conversation payload is corrupted.',
        code: 'MALFORMED_SNAPSHOT'
      });
    }

    const createdAtMs = extractShareTimestampMs(data.createdAtMs ?? data.createdAt);

    return res.status(200).json(
      buildPublicSharedSnapshotResponse(sanitizedSnapshot, createdAtMs)
    );
  } catch (err: any) {
    console.error('[ShareSubsystem] Error retrieving shared conversation:', err);
    return res.status(500).json({
      error: err?.message || 'Failed to retrieve shared conversation.',
      code: 'LOAD_FAILED'
    });
  }
}

/**
 * Express handler for DELETE /api/share/:shareId and POST /api/share/:shareId/revoke
 * Enforces Firebase authentication and server-side ownership (`ownerId === auth.uid`)
 * before marking a share link as revoked.
 */
export async function handleRevokeShareChatRequest(req: express.Request, res: express.Response) {
  try {
    const authResult = await authenticateRequest(req);
    if (authResult.status === 'invalid') {
      return res.status(401).json({
        error: authResult.error,
        code: authResult.code
      });
    }

    if (authResult.status === 'guest') {
      return res.status(401).json({
        error: 'Please sign in with your Orvix account to revoke share links.',
        code: 'AUTH_REQUIRED'
      });
    }

    if (!isEligibleServerShareUser(authResult.user)) {
      return res.status(401).json({
        error: 'Anonymous users are not permitted to revoke shared links.',
        code: 'ANONYMOUS_SHARE_DENIED'
      });
    }

    const shareId = typeof req.params?.shareId === 'string' ? req.params.shareId.trim() : '';
    if (!isValidShareId(shareId)) {
      return res.status(400).json({
        error: 'Invalid or missing share ID.',
        code: 'INVALID_SHARE_ID'
      });
    }

    let db;
    try {
      db = getFirestoreDb();
    } catch (dbErr: any) {
      console.error('[ShareSubsystem] Failed to initialize Firestore Admin client for revoke:', dbErr);
      return res.status(503).json({
        error: 'Cloud sharing database is currently unavailable.',
        code: 'DATABASE_UNAVAILABLE'
      });
    }

    const shareDocRef = db.collection('sharedChats').doc(shareId);
    const nowMs = Date.now();
    const revokePatch = {
      revoked: true,
      revokedAt: FieldValue.serverTimestamp(),
      revokedAtMs: nowMs
    };

    const applyRevokeInState = async (existingSnap: any, writer: { update?: Function; set: Function }) => {
      if (!existingSnap?.exists) {
        return { outcome: 'not_found' as const };
      }
      const data = existingSnap.data() || {};
      const docOwnerId = typeof data.ownerId === 'string' ? data.ownerId.trim() : '';
      if (!docOwnerId || docOwnerId !== authResult.user.uid) {
        return { outcome: 'forbidden' as const };
      }
      if (data.revoked === true) {
        return {
          outcome: 'already_revoked' as const,
          revokedAtMs: typeof data.revokedAtMs === 'number' ? data.revokedAtMs : nowMs
        };
      }
      if (typeof writer.update === 'function') {
        await writer.update(revokePatch);
      } else {
        await writer.set({ ...data, ...revokePatch }, { merge: true });
      }
      return {
        outcome: 'revoked' as const,
        revokedAtMs: nowMs
      };
    };

    let result;
    if (typeof db.runTransaction === 'function') {
      result = await db.runTransaction(async (transaction: any) => {
        const snap = await transaction.get(shareDocRef);
        return applyRevokeInState(snap, {
          update: typeof transaction.update === 'function'
            ? (patch: any) => transaction.update(shareDocRef, patch)
            : undefined,
          set: (data: any, opts?: any) => transaction.set(shareDocRef, data, opts)
        });
      });
    } else {
      const snap = await shareDocRef.get();
      result = await applyRevokeInState(snap, {
        update: typeof shareDocRef.update === 'function'
          ? (patch: any) => shareDocRef.update(patch)
          : undefined,
        set: (data: any, opts?: any) => shareDocRef.set(data, opts)
      });
    }

    if (result.outcome === 'not_found') {
      return res.status(404).json({
        error: 'Shared conversation link not found.',
        code: 'NOT_FOUND'
      });
    }

    if (result.outcome === 'forbidden') {
      return res.status(403).json({
        error: 'You do not have permission to revoke this shared conversation link.',
        code: 'FORBIDDEN'
      });
    }

    return res.status(200).json({
      success: true,
      shareId,
      revoked: true,
      alreadyRevoked: result.outcome === 'already_revoked',
      revokedAtMs: result.revokedAtMs
    });
  } catch (err: any) {
    console.error('[ShareSubsystem] Error revoking share link:', err);
    return res.status(500).json({
      error: err?.message || 'Failed to revoke shared conversation link.',
      code: 'REVOKE_FAILED'
    });
  }
}

/**
 * Registers share routes on the Express app with distributed rate limiting (10 requests/minute per user/IP)
 * for mutating endpoints (`POST` creation and `DELETE`/`POST .../revoke` revocation).
 */
export function registerShareRoutes(
  app: express.Express,
  rateLimitOptions?: Partial<CreateRateLimiterOptions>
) {
  const shareRateLimiter = createRateLimiterMiddleware({
    policy: 'share',
    ...rateLimitOptions
  });
  app.post(['/api/share', '/share'], shareRateLimiter, handleShareChatRequest);
  app.get('/api/share/:shareId', handleGetShareChatRequest);
  app.delete('/api/share/:shareId', shareRateLimiter, handleRevokeShareChatRequest);
  app.post('/api/share/:shareId/revoke', shareRateLimiter, handleRevokeShareChatRequest);
}
