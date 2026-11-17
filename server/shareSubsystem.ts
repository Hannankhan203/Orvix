import type express from 'express';
import {
  authenticateRequest,
  type AuthVerificationResult
} from './firebaseAuthHelper.ts';
import { getFirestoreDb } from './uploadQuotaService.ts';
import { FieldValue } from 'firebase-admin/firestore';
import { buildValidatedSharedSnapshot, ShareChatError } from '../src/services/shareChatService.js';
import {
  createRateLimiterMiddleware,
  type CreateRateLimiterOptions
} from './rateLimiter.ts';

/**
 * Checks if a verified Firebase user is non-anonymous and eligible to publish shared chats.
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
 * Rigorously validates every message in the conversation on the server side
 * and persists the immutable shared snapshot to Firestore using Firebase Admin SDK.
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

    const { shareId, chat, messages } = req.body || {};

    if (!shareId || typeof shareId !== 'string' || !shareId.trim()) {
      return res.status(400).json({
        error: 'Invalid or missing share ID.',
        code: 'INVALID_SHARE_ID'
      });
    }

    const canonicalInputShareId = shareId.trim();

    // Run rigorous validation and sanitization on EVERY message using buildValidatedSharedSnapshot
    let validationResult;
    try {
      validationResult = buildValidatedSharedSnapshot({
        shareId: canonicalInputShareId,
        chat,
        messages
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

    // Attach server-side timestamp sentinel for Firestore Admin SDK
    const snapshotPayload = {
      ...documentData,
      id: canonicalShareId,
      createdAt: FieldValue.serverTimestamp()
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
      byteSize
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
 * Registers share routes on the Express app with distributed rate limiting (10 requests/minute per user/IP).
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
}
