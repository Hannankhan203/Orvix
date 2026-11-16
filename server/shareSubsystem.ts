import type express from 'express';
import {
  authenticateRequest,
  type AuthVerificationResult
} from './firebaseAuthHelper.ts';
import { getFirestoreDb } from './uploadQuotaService.ts';
import { FieldValue } from 'firebase-admin/firestore';
import { buildValidatedSharedSnapshot, ShareChatError } from '../src/services/shareChatService.js';

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

    // Run rigorous validation and sanitization on EVERY message using buildValidatedSharedSnapshot
    let validationResult;
    try {
      validationResult = buildValidatedSharedSnapshot({
        shareId: shareId.trim(),
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

    // Attach server-side timestamp sentinel for Firestore Admin SDK
    const snapshotPayload = {
      ...documentData,
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

    const shareDocRef = db.collection('sharedChats').doc(shareId);
    await shareDocRef.set(snapshotPayload);

    const docData = documentData as any;
    return res.status(200).json({
      success: true,
      shareId: docData.id,
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
 * Registers share routes on the Express app.
 */
export function registerShareRoutes(app: express.Express) {
  app.post(['/api/share', '/share'], handleShareChatRequest);
}
