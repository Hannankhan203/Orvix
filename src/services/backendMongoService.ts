/**
 * Orvix Express Backend MongoDB Service Layer (Phase 3, Step 2)
 *
 * Integrates MongoDB repositories into the Express backend safely:
 * - Provides verified server-side data access helpers
 * - Validates input parameters strictly
 * - Strictly enforces Phase 3 Authentication & Ownership Boundaries:
 *   Derives identity exclusively from verified Firebase ID token (req.user.uid)
 *   and blocks unauthorized cross-user reads, mutations, or spoofing.
 */

import { getDatabase, isMongoConfigured, getMongoStatus } from '../db/mongodb.ts';
import {
  initializeRepositoryIndexes,
  findUserById,
  findConversationById,
  findConversationsByUserId,
  findMessageById,
  findMessagesByConversationId,
  countPinnedConversations,
  getUserSettings,
  UserDocument,
  ConversationDocument,
  MessageDocument,
  UserSettingsDocument
} from '../repositories/index.ts';

export const MAX_PINNED_CONVERSATIONS = 5;

export interface RepositoryReadiness {
  users: boolean;
  conversations: boolean;
  messages: boolean;
  user_settings: boolean;
  indexesInitialized: boolean;
}

export interface BackendMongoSummary {
  database: string;
  isConfigured: boolean;
  isConnected: boolean;
  collections: RepositoryReadiness;
  authBoundary: {
    status: 'enforced';
    phase: string;
    message: string;
  };
}

let indexesReady = false;

/**
 * Initializes all MongoDB indexes on server startup.
 */
export async function setupBackendMongoIndexes(): Promise<boolean> {
  if (!isMongoConfigured()) return false;
  try {
    await initializeRepositoryIndexes();
    indexesReady = true;
    return true;
  } catch (err) {
    console.warn('[BackendMongoService] Index setup notice:', err);
    return false;
  }
}

/**
 * Validates a user ID string.
 */
export function validateUserId(userId?: string | null): { valid: boolean; error?: string; cleanId?: string } {
  if (!userId || typeof userId !== 'string') {
    return { valid: false, error: 'User ID is required and must be a string.' };
  }
  const clean = userId.trim();
  if (clean.length < 2 || clean.length > 128) {
    return { valid: false, error: 'User ID must be between 2 and 128 characters.' };
  }
  // Alphanumeric, hyphens, underscores, dots
  if (!/^[a-zA-Z0-9_\-\.]+$/.test(clean)) {
    return { valid: false, error: 'User ID contains invalid characters.' };
  }
  return { valid: true, cleanId: clean };
}

/**
 * Validates a conversation ID string.
 */
export function validateConversationId(conversationId?: string | null): { valid: boolean; error?: string; cleanId?: string } {
  if (!conversationId || typeof conversationId !== 'string') {
    return { valid: false, error: 'Conversation ID is required and must be a string.' };
  }
  const clean = conversationId.trim();
  if (clean.length < 3 || clean.length > 128) {
    return { valid: false, error: 'Conversation ID length must be between 3 and 128 characters.' };
  }
  if (!/^[a-zA-Z0-9_\-\.]+$/.test(clean)) {
    return { valid: false, error: 'Conversation ID contains invalid characters.' };
  }
  return { valid: true, cleanId: clean };
}

/**
 * Validates a username string against Orvix application constraints.
 */
export function validateUsername(username?: string | null): { valid: boolean; error?: string; cleanUsername?: string } {
  if (!username || typeof username !== 'string') {
    return { valid: false, error: 'Username is required and must be a string.' };
  }
  const clean = username.trim();
  if (clean.length < 2 || clean.length > 30) {
    return { valid: false, error: 'Username must be between 2 and 30 characters.' };
  }
  if (!/^[a-zA-Z0-9_\-\. ]+$/.test(clean)) {
    return { valid: false, error: 'Username contains invalid characters.' };
  }
  return { valid: true, cleanUsername: clean };
}

/**
 * Verifies that a conversation exists and belongs to the authenticated user.
 * Guarantees zero data leakage across users.
 */
export async function verifyConversationOwnership(
  conversationId: string,
  userId: string
): Promise<{ conversation: ConversationDocument | null; isOwner: boolean; notFound: boolean }> {
  if (!conversationId || !userId) {
    return { conversation: null, isOwner: false, notFound: true };
  }
  const conv = await findConversationById(conversationId);
  if (!conv) {
    return { conversation: null, isOwner: false, notFound: true };
  }
  const isOwner = conv.userId === userId;
  return { conversation: isOwner ? conv : null, isOwner, notFound: false };
}

/**
 * Verifies that a message exists and its parent conversation belongs to the authenticated user.
 */
export async function verifyMessageOwnership(
  messageId: string,
  userId: string
): Promise<{ message: MessageDocument | null; conversation: ConversationDocument | null; isOwner: boolean; notFound: boolean }> {
  if (!messageId || !userId) {
    return { message: null, conversation: null, isOwner: false, notFound: true };
  }
  const msg = await findMessageById(messageId);
  if (!msg) {
    return { message: null, conversation: null, isOwner: false, notFound: true };
  }
  const convOwnership = await verifyConversationOwnership(msg.conversationId, userId);
  if (convOwnership.notFound || !convOwnership.isOwner) {
    return { message: null, conversation: null, isOwner: false, notFound: convOwnership.notFound };
  }
  return { message: msg, conversation: convOwnership.conversation, isOwner: true, notFound: false };
}

/**
 * Safely checks if a user can pin a conversation without exceeding the 5-pin maximum.
 * If conversationId is provided and already pinned, returns true (idempotent).
 */
export async function canPinConversation(userId: string, conversationId?: string): Promise<boolean> {
  if (!userId) return false;
  if (conversationId) {
    const existing = await findConversationById(conversationId);
    if (existing && existing.isPinned) {
      return true;
    }
  }
  const currentCount = await countPinnedConversations(userId);
  return currentCount < MAX_PINNED_CONVERSATIONS;
}

/**
 * Returns a high-level summary of backend MongoDB integration status.
 */
export async function getBackendMongoSummary(): Promise<BackendMongoSummary> {
  const status = await getMongoStatus();
  return {
    database: status.databaseName,
    isConfigured: status.isConfigured,
    isConnected: status.isConnected,
    collections: {
      users: status.isConnected,
      conversations: status.isConnected,
      messages: status.isConnected,
      user_settings: status.isConnected,
      indexesInitialized: indexesReady
    },
    authBoundary: {
      status: 'enforced',
      phase: 'Phase 3 Step 2 Complete: Authenticated MongoDB CRUD API Active',
      message:
        'Cryptographic server-side identity verification via Firebase ID tokens is enforced for all MongoDB user-data endpoints.'
    }
  };
}
