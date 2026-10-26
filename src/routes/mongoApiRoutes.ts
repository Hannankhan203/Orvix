/**
 * Orvix Authenticated MongoDB API Router (Phase 3 Step 2)
 *
 * Implements secure server-side CRUD endpoints for users, conversations,
 * messages, and user settings backed by MongoDB Atlas.
 *
 * Security Invariants Enforced:
 * 1. requireAuth is strictly mounted on every route.
 * 2. Identity is derived EXCLUSIVELY from verified Firebase token (req.user.uid).
 *    Client-supplied userIds in URLs, bodies, or query params are NEVER trusted.
 *    Any mismatch between a URL :userId and req.user.uid is rejected with HTTP 403.
 * 3. Strict ownership checks: A user can only read, update, or delete their own
 *    conversations, messages, and settings.
 * 4. Message operations verify that the parent conversation belongs to the user.
 * 5. Pinned conversation limit (maximum 5) is strictly enforced server-side.
 * 6. Conversation deletion cascades to all associated messages using repositories.
 * 7. Clients can never modify record ownership fields (userId / _id).
 */

import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/authMiddleware.ts';
import {
  findUserById,
  upsertUser,
  updateUser,
  createConversation,
  findConversationById,
  findConversationsByUserId,
  updateConversation,
  deleteConversation,
  countPinnedConversations,
  touchConversationUpdatedAt,
  createMessage,
  findMessageById,
  findMessagesByConversationId,
  updateMessage,
  deleteMessage,
  deleteMessagesByIds,
  deleteMessagesByConversationId,
  getUserSettings,
  getDefaultUserSettings,
  upsertUserSettings,
  sanitizeSettingsInput
} from '../repositories/index.ts';
import {
  validateUserId,
  validateConversationId,
  validateUsername,
  verifyConversationOwnership,
  verifyMessageOwnership,
  canPinConversation
} from '../services/backendMongoService.ts';
import {
  MongoNotConnectedError,
  connectToDatabase,
  isMongoConfigured
} from '../db/mongodb.ts';

const router = Router();

export const MONGO_USER_DATA_PREFIXES = [
  '/users',
  '/conversations',
  '/messages',
  '/user-settings'
];

/**
 * Normalizes MongoDB database errors to ensure explicit HTTP 503 DATABASE_UNAVAILABLE responses
 * when MongoDB Atlas is disconnected or unconfigured, preventing silent in-memory fallbacks or fake successes.
 */
function handleMongoApiError(
  res: Response,
  err: any,
  actionDesc: string,
  fallbackMessage: string,
  fallbackCode = 'INTERNAL_ERROR'
) {
  if (
    err instanceof MongoNotConnectedError ||
    err?.name === 'MongoNotConnectedError' ||
    err?.code === 'DATABASE_NOT_CONNECTED' ||
    err?.name === 'MongoNetworkError' ||
    err?.name === 'MongoServerSelectionError' ||
    err?.message?.includes('Database connection required') ||
    err?.message?.includes('MongoDB is not connected')
  ) {
    res.status(503).json({
      error: 'Database service is temporarily unavailable. Persistent operations require an active MongoDB connection.',
      code: 'DATABASE_UNAVAILABLE'
    });
    return;
  }
  console.error(`[API ${actionDesc}] Error:`, err?.message || err);
  res.status(500).json({ error: fallbackMessage, code: fallbackCode });
}

/**
 * Serverless Connection Lifecycle Middleware:
 * Ensures MongoDB Atlas connection is established before processing user-data routes in serverless environments.
 * - Reuses existing warm connection instantly (zero overhead on warm instances)
 * - Connects asynchronously if uninitialized and MONGODB_URI is configured
 * - Bounded and non-blocking if unconfigured or failed: getDatabase() will throw
 *   MongoNotConnectedError which handleMongoApiError maps directly to 503 DATABASE_UNAVAILABLE.
 */
async function ensureMongoConnection(_req: Request, _res: Response, next: () => void) {
  if (isMongoConfigured()) {
    try {
      await connectToDatabase();
    } catch (_) {
      // Ignored here so repository getDatabase() throws explicit MongoNotConnectedError
    }
  }
  next();
}

// Apply requireAuth and ensureMongoConnection strictly to MongoDB user-data prefixes so unrelated /api/* routes
// (e.g. /api/chat, /api/upload, /api/transcribe) mounted after mongoApiRouter pass through cleanly.
router.use(MONGO_USER_DATA_PREFIXES, requireAuth, ensureMongoConnection);

/* ==========================================================================
   1. USER PROFILE ENDPOINTS
   ========================================================================== */

/**
 * GET /api/users/me
 * GET /api/users/:userId
 * Retrieves user profile for the authenticated user.
 */
router.get(['/users/me', '/users/:userId'], async (req: Request, res: Response) => {
  const authUid = req.user!.uid;
  const requestedUserId = req.params.userId;

  // Enforce boundary: reject cross-user access attempts
  if (requestedUserId && requestedUserId !== 'me' && requestedUserId !== authUid) {
    res.status(403).json({
      error: 'Forbidden: You do not have permission to access another user\'s profile.',
      code: 'FORBIDDEN'
    });
    return;
  }

  try {
    const user = await findUserById(authUid);
    if (!user) {
      res.status(404).json({
        error: 'User profile not found in database.',
        code: 'USER_NOT_FOUND',
        uid: authUid
      });
      return;
    }

    res.json({ user });
  } catch (err: any) {
    handleMongoApiError(res, err, '/users', 'Internal server error while retrieving user profile.');
  }
});

/**
 * PUT /api/users/me
 * PUT /api/users/:userId
 * POST /api/users
 * Creates or updates user profile for the authenticated user.
 */
router.all(['/users', '/users/me', '/users/:userId'], async (req: Request, res: Response) => {
  if (req.method !== 'PUT' && req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed.', code: 'METHOD_NOT_ALLOWED' });
    return;
  }

  const authUid = req.user!.uid;
  const requestedUserId = req.params.userId;

  if (requestedUserId && requestedUserId !== 'me' && requestedUserId !== authUid) {
    res.status(403).json({
      error: 'Forbidden: You cannot modify another user\'s profile.',
      code: 'FORBIDDEN'
    });
    return;
  }

  const usernameVal = validateUsername(req.body?.username);
  if (!usernameVal.valid) {
    res.status(400).json({
      error: usernameVal.error || 'Invalid username provided.',
      code: 'INVALID_USERNAME'
    });
    return;
  }

  try {
    const cleanEmail = (typeof req.body?.email === 'string' && req.body.email.trim())
      ? req.body.email.trim()
      : (req.user?.email || '');

    const user = await upsertUser(authUid, {
      username: usernameVal.cleanUsername!,
      email: cleanEmail
    });

    res.json({ user });
  } catch (err: any) {
    handleMongoApiError(res, err, '/users', 'Internal server error while saving user profile.');
  }
});

/* ==========================================================================
   2. CONVERSATION ENDPOINTS
   ========================================================================== */

/**
 * GET /api/conversations
 * Lists all conversations belonging to the authenticated user.
 */
router.get('/conversations', async (req: Request, res: Response) => {
  const authUid = req.user!.uid;
  const modeFilter = typeof req.query.mode === 'string' ? req.query.mode.trim() : undefined;
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
  const skip = req.query.skip ? parseInt(req.query.skip as string, 10) : undefined;

  try {
    const conversations = await findConversationsByUserId(authUid, {
      mode: modeFilter,
      limit: Number.isFinite(limit) ? limit : undefined,
      skip: Number.isFinite(skip) ? skip : undefined
    });

    res.json({ conversations });
  } catch (err: any) {
    handleMongoApiError(res, err, '/conversations', 'Failed to retrieve conversations.');
  }
});

/**
 * POST /api/conversations
 * Creates a new conversation thread owned by the authenticated user.
 */
router.post('/conversations', async (req: Request, res: Response) => {
  const authUid = req.user!.uid;
  const { id, title, mode, isPinned } = req.body || {};

  // Validate ID if client explicitly provided one (e.g. for offline sync)
  if (id) {
    const validId = validateConversationId(id);
    if (!validId.valid) {
      res.status(400).json({
        error: validId.error || 'Invalid conversation ID format.',
        code: 'INVALID_CONVERSATION_ID'
      });
      return;
    }
  }

  try {
    // Validate and enforce pin limit (max 5) inside try/catch so DB errors map to 503 DATABASE_UNAVAILABLE
    if (Boolean(isPinned)) {
      const canPin = await canPinConversation(authUid);
      if (!canPin) {
        res.status(400).json({
          error: 'Maximum of 5 pinned conversations reached. Unpin another conversation first.',
          code: 'PIN_LIMIT_EXCEEDED'
        });
        return;
      }
    }

    const conversation = await createConversation({
      id: id ? id.trim() : undefined,
      userId: authUid, // Strict ownership: derived exclusively from verified token
      title: typeof title === 'string' ? title.trim().slice(0, 200) : 'New Conversation',
      mode: typeof mode === 'string' ? mode.trim().toLowerCase() : 'general',
      isPinned: Boolean(isPinned)
    });

    res.status(201).json({ conversation });
  } catch (err: any) {
    if (err?.code === 'CONVERSATION_ID_CONFLICT') {
      res.status(409).json({
        error: 'Conversation ID already belongs to another user.',
        code: 'CONVERSATION_ID_CONFLICT'
      });
      return;
    }
    handleMongoApiError(res, err, '/conversations', 'Failed to create conversation.');
  }
});

/**
 * GET /api/conversations/:id
 * Retrieves a single conversation by ID with ownership verification.
 */
router.get('/conversations/:id', async (req: Request, res: Response) => {
  const authUid = req.user!.uid;
  const convId = req.params.id;

  const validId = validateConversationId(convId);
  if (!validId.valid) {
    res.status(400).json({ error: validId.error, code: 'INVALID_CONVERSATION_ID' });
    return;
  }

  try {
    const check = await verifyConversationOwnership(convId, authUid);
    if (check.notFound) {
      res.status(404).json({ error: 'Conversation not found.', code: 'NOT_FOUND' });
      return;
    }
    if (!check.isOwner) {
      res.status(403).json({
        error: 'Forbidden: You do not have permission to access this conversation.',
        code: 'FORBIDDEN'
      });
      return;
    }

    res.json({ conversation: check.conversation });
  } catch (err: any) {
    handleMongoApiError(res, err, '/conversations/:id', 'Failed to fetch conversation.');
  }
});

/**
 * PATCH /api/conversations/:id
 * PUT /api/conversations/:id
 * Updates conversation metadata (title, mode, isPinned).
 */
router.all('/conversations/:id', async (req: Request, res: Response, next) => {
  if (req.method !== 'PATCH' && req.method !== 'PUT') {
    return next();
  }

  const authUid = req.user!.uid;
  const convId = req.params.id;

  const validId = validateConversationId(convId);
  if (!validId.valid) {
    res.status(400).json({ error: validId.error, code: 'INVALID_CONVERSATION_ID' });
    return;
  }

  try {
    const check = await verifyConversationOwnership(convId, authUid);
    if (check.notFound) {
      res.status(404).json({ error: 'Conversation not found.', code: 'NOT_FOUND' });
      return;
    }
    if (!check.isOwner) {
      res.status(403).json({
        error: 'Forbidden: You do not have permission to modify this conversation.',
        code: 'FORBIDDEN'
      });
      return;
    }

    const { title, mode, isPinned } = req.body || {};

    // Enforce pin limit if pinning
    if (isPinned === true && !check.conversation!.isPinned) {
      const canPin = await canPinConversation(authUid, check.conversation!._id);
      if (!canPin) {
        res.status(400).json({
          error: 'Maximum of 5 pinned conversations reached. Unpin another conversation first.',
          code: 'PIN_LIMIT_EXCEEDED'
        });
        return;
      }
    }

    const patch: any = {};
    if (title !== undefined) {
      if (typeof title !== 'string' || !title.trim()) {
        res.status(400).json({ error: 'Conversation title cannot be empty.', code: 'INVALID_TITLE' });
        return;
      }
      patch.title = title.trim().slice(0, 200);
    }
    if (mode !== undefined) {
      patch.mode = typeof mode === 'string' ? mode.trim().toLowerCase() : 'general';
    }
    if (isPinned !== undefined) {
      patch.isPinned = Boolean(isPinned);
    }

    const updated = await updateConversation(check.conversation!._id, patch);
    res.json({ conversation: updated });
  } catch (err: any) {
    handleMongoApiError(res, err, '/conversations/:id', 'Failed to update conversation.');
  }
});

/**
 * DELETE /api/conversations/:id
 * Deletes a conversation and cascades deletion to all associated messages.
 */
router.delete('/conversations/:id', async (req: Request, res: Response) => {
  const authUid = req.user!.uid;
  const convId = req.params.id;

  const validId = validateConversationId(convId);
  if (!validId.valid) {
    res.status(400).json({ error: validId.error, code: 'INVALID_CONVERSATION_ID' });
    return;
  }

  try {
    const check = await verifyConversationOwnership(convId, authUid);
    if (check.notFound) {
      res.status(404).json({ error: 'Conversation not found.', code: 'NOT_FOUND' });
      return;
    }
    if (!check.isOwner) {
      res.status(403).json({
        error: 'Forbidden: You do not have permission to delete this conversation.',
        code: 'FORBIDDEN'
      });
      return;
    }

    // Cascade delete associated messages first
    const deletedMessagesCount = await deleteMessagesByConversationId(check.conversation!._id);
    // Delete conversation document
    await deleteConversation(check.conversation!._id);

    res.json({
      success: true,
      deletedConversationId: check.conversation!._id,
      deletedMessagesCount
    });
  } catch (err: any) {
    handleMongoApiError(res, err, '/conversations/:id', 'Failed to delete conversation.');
  }
});

/* ==========================================================================
   3. MESSAGE ENDPOINTS
   ========================================================================== */

/**
 * GET /api/messages
 * Retrieves messages for a specific conversation.
 * Verifies that the conversation belongs to the authenticated user.
 */
router.get('/messages', async (req: Request, res: Response) => {
  const authUid = req.user!.uid;
  const convId = req.query.conversationId as string;

  if (!convId || typeof convId !== 'string') {
    res.status(400).json({
      error: 'Query parameter conversationId is required.',
      code: 'MISSING_CONVERSATION_ID'
    });
    return;
  }

  const validId = validateConversationId(convId);
  if (!validId.valid) {
    res.status(400).json({ error: validId.error, code: 'INVALID_CONVERSATION_ID' });
    return;
  }

  try {
    const check = await verifyConversationOwnership(convId, authUid);
    if (check.notFound) {
      res.status(404).json({ error: 'Conversation not found.', code: 'NOT_FOUND' });
      return;
    }
    if (!check.isOwner) {
      res.status(403).json({
        error: 'Forbidden: You do not own the conversation for these messages.',
        code: 'FORBIDDEN'
      });
      return;
    }

    const sortDir = req.query.sort === 'desc' ? 'desc' : 'asc';
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;

    const messages = await findMessagesByConversationId(check.conversation!._id, {
      sort: sortDir,
      limit: Number.isFinite(limit) ? limit : undefined
    });

    res.json({ messages });
  } catch (err: any) {
    handleMongoApiError(res, err, '/messages', 'Failed to retrieve messages.');
  }
});

/**
 * POST /api/messages
 * Saves a new message to a conversation.
 * Verifies conversation ownership and touches conversation updatedAt.
 */
router.post('/messages', async (req: Request, res: Response) => {
  const authUid = req.user!.uid;
  const { conversationId, content, sender, id } = req.body || {};

  if (!conversationId || content === undefined || content === null) {
    res.status(400).json({
      error: 'conversationId and content are required.',
      code: 'INVALID_MESSAGE_PAYLOAD'
    });
    return;
  }

  const validConvId = validateConversationId(conversationId);
  if (!validConvId.valid) {
    res.status(400).json({ error: validConvId.error, code: 'INVALID_CONVERSATION_ID' });
    return;
  }

  if (id !== undefined && id !== null) {
    if (typeof id !== 'string' || !id.trim() || id.trim().length > 128) {
      res.status(400).json({
        error: 'Message ID must be a non-empty string up to 128 characters.',
        code: 'INVALID_MESSAGE_ID'
      });
      return;
    }
  }

  try {
    const check = await verifyConversationOwnership(conversationId, authUid);
    if (check.notFound) {
      res.status(404).json({ error: 'Conversation not found.', code: 'NOT_FOUND' });
      return;
    }
    if (!check.isOwner) {
      res.status(403).json({
        error: 'Forbidden: You do not own the conversation for this message.',
        code: 'FORBIDDEN'
      });
      return;
    }

    const { _id: _ignoredMongoId, userId: _ignoredUserId, ...safeBody } = req.body || {};

    const message = await createMessage({
      ...safeBody,
      id: typeof id === 'string' && id.trim() ? id.trim() : undefined,
      conversationId: check.conversation!._id,
      userId: authUid, // Strict ownership derivation
      sender: sender === 'assistant' ? 'assistant' : 'user',
      content: String(content)
    });

    // Touch conversation updatedAt timestamp
    await touchConversationUpdatedAt(check.conversation!._id);

    res.status(201).json({ message });
  } catch (err: any) {
    if (err?.code === 'MESSAGE_ID_CONFLICT') {
      res.status(409).json({
        error: 'Conflict: Message ID already exists in another conversation.',
        code: 'MESSAGE_ID_CONFLICT'
      });
      return;
    }
    handleMongoApiError(res, err, '/messages', 'Failed to create message.');
  }
});

/**
 * DELETE /api/messages
 * Batch deletion of messages within a conversation (e.g. branch truncation during edit-and-resend).
 */
router.delete('/messages', async (req: Request, res: Response) => {
  const authUid = req.user!.uid;
  const convId = (req.query.conversationId as string) || req.body?.conversationId;
  let messageIds: string[] = [];

  if (Array.isArray(req.body?.messageIds)) {
    messageIds = req.body.messageIds;
  } else if (typeof req.query.messageIds === 'string' && req.query.messageIds.trim()) {
    messageIds = req.query.messageIds
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  } else if (Array.isArray(req.query.messageIds)) {
    messageIds = (req.query.messageIds as string[])
      .map((s) => String(s).trim())
      .filter(Boolean);
  }

  if (!convId || !Array.isArray(messageIds) || messageIds.length === 0) {
    res.status(400).json({
      error: 'conversationId and a non-empty messageIds array are required.',
      code: 'INVALID_PAYLOAD'
    });
    return;
  }

  const validConvId = validateConversationId(convId);
  if (!validConvId.valid) {
    res.status(400).json({ error: validConvId.error, code: 'INVALID_CONVERSATION_ID' });
    return;
  }

  try {
    const check = await verifyConversationOwnership(convId, authUid);
    if (check.notFound) {
      res.status(404).json({ error: 'Conversation not found.', code: 'NOT_FOUND' });
      return;
    }
    if (!check.isOwner) {
      res.status(403).json({
        error: 'Forbidden: You do not own the conversation for these messages.',
        code: 'FORBIDDEN'
      });
      return;
    }

    const deletedCount = await deleteMessagesByIds(check.conversation!._id, messageIds);
    res.json({ success: true, deletedCount });
  } catch (err: any) {
    handleMongoApiError(res, err, '/messages batch delete', 'Failed to delete messages.');
  }
});

/**
 * GET /api/messages/:id
 * Retrieves a single message by ID after verifying parent conversation ownership.
 */
router.get('/messages/:id', async (req: Request, res: Response) => {
  const authUid = req.user!.uid;
  const msgId = req.params.id;

  try {
    const check = await verifyMessageOwnership(msgId, authUid);
    if (check.notFound) {
      res.status(404).json({ error: 'Message not found.', code: 'NOT_FOUND' });
      return;
    }
    if (!check.isOwner) {
      res.status(403).json({
        error: 'Forbidden: You do not have permission to view this message.',
        code: 'FORBIDDEN'
      });
      return;
    }

    res.json({ message: check.message });
  } catch (err: any) {
    handleMongoApiError(res, err, '/messages/:id', 'Failed to retrieve message.');
  }
});

/**
 * PATCH /api/messages/:id
 * PUT /api/messages/:id
 * Updates message content, alternatives, or attachments.
 */
router.all('/messages/:id', async (req: Request, res: Response, next) => {
  if (req.method !== 'PATCH' && req.method !== 'PUT') {
    return next();
  }

  const authUid = req.user!.uid;
  const msgId = req.params.id;

  try {
    const check = await verifyMessageOwnership(msgId, authUid);
    if (check.notFound) {
      res.status(404).json({ error: 'Message not found.', code: 'NOT_FOUND' });
      return;
    }
    if (!check.isOwner) {
      res.status(403).json({
        error: 'Forbidden: You do not have permission to modify this message.',
        code: 'FORBIDDEN'
      });
      return;
    }

    // Clients cannot change ownership fields
    const { userId, conversationId, _id, id, ...allowedPatch } = req.body || {};

    const updated = await updateMessage(check.message!._id, allowedPatch);
    res.json({ message: updated });
  } catch (err: any) {
    handleMongoApiError(res, err, '/messages/:id', 'Failed to update message.');
  }
});

/**
 * DELETE /api/messages/:id
 * Deletes a single message by ID after verifying parent conversation ownership.
 */
router.delete('/messages/:id', async (req: Request, res: Response) => {
  const authUid = req.user!.uid;
  const msgId = req.params.id;

  try {
    const check = await verifyMessageOwnership(msgId, authUid);
    if (check.notFound) {
      res.status(404).json({ error: 'Message not found.', code: 'NOT_FOUND' });
      return;
    }
    if (!check.isOwner) {
      res.status(403).json({
        error: 'Forbidden: You do not have permission to delete this message.',
        code: 'FORBIDDEN'
      });
      return;
    }

    await deleteMessage(check.message!._id);
    res.json({ success: true, deletedMessageId: check.message!._id });
  } catch (err: any) {
    handleMongoApiError(res, err, '/messages/:id', 'Failed to delete message.');
  }
});

/* ==========================================================================
   4. USER SETTINGS ENDPOINTS
   ========================================================================== */

/**
 * GET /api/user-settings
 * GET /api/user-settings/me
 * GET /api/user-settings/:userId
 * Retrieves personalization preferences for the authenticated user.
 */
router.get(['/user-settings', '/user-settings/me', '/user-settings/:userId'], async (req: Request, res: Response) => {
  const authUid = req.user!.uid;
  const requestedUserId = req.params.userId;

  if (requestedUserId && requestedUserId !== 'me' && requestedUserId !== authUid) {
    res.status(403).json({
      error: 'Forbidden: You cannot access another user\'s settings.',
      code: 'FORBIDDEN'
    });
    return;
  }

  try {
    const settings = await getUserSettings(authUid);
    res.json({ settings: settings || getDefaultUserSettings(authUid) });
  } catch (err: any) {
    handleMongoApiError(res, err, '/user-settings', 'Failed to retrieve user settings.');
  }
});

/**
 * POST /api/user-settings
 * POST /api/user-settings/:userId
 * PUT /api/user-settings
 * PUT /api/user-settings/:userId
 * Upserts personalization preferences for the authenticated user.
 */
router.all(['/user-settings', '/user-settings/me', '/user-settings/:userId'], async (req: Request, res: Response) => {
  if (req.method !== 'POST' && req.method !== 'PUT') {
    res.status(405).json({ error: 'Method not allowed.', code: 'METHOD_NOT_ALLOWED' });
    return;
  }

  const authUid = req.user!.uid;
  const requestedUserId = req.params.userId;

  if (requestedUserId && requestedUserId !== 'me' && requestedUserId !== authUid) {
    res.status(403).json({
      error: 'Forbidden: You cannot modify another user\'s settings.',
      code: 'FORBIDDEN'
    });
    return;
  }

  try {
    const cleanSettings = sanitizeSettingsInput(req.body);
    const updated = await upsertUserSettings(authUid, cleanSettings);
    res.json({ settings: updated });
  } catch (err: any) {
    handleMongoApiError(res, err, '/user-settings', 'Failed to save user settings.');
  }
});

export { router as mongoApiRouter };
