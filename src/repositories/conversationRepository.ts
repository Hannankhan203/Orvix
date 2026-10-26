/**
 * Orvix Conversation Repository (MongoDB Atlas)
 *
 * Handles persistence and queries for the 'conversations' collection in database 'Orvix'.
 * Replaces Firebase Firestore /users/{userId}/chats/{chatId} collection.
 */

import { Collection, ObjectId } from 'mongodb';
import { getDatabase } from '../db/mongodb.ts';

export interface ConversationDocument {
  _id: string; // Chat ID (e.g. 'local-...' or UUID or ObjectId string)
  id: string; // Duplicate of _id for frontend API parity
  userId: string; // Authenticated owner user ID
  title: string;
  mode: string; // 'general' | 'coding' | 'writing' | 'learning'
  isPinned: boolean;
  pinnedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateConversationInput {
  id?: string;
  userId: string;
  title?: string;
  mode?: string;
  isPinned?: boolean;
  pinnedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface UpdateConversationInput {
  title?: string;
  mode?: string;
  isPinned?: boolean;
  pinnedAt?: Date | null;
  updatedAt?: Date;
}

export interface ListConversationsOptions {
  limit?: number;
  skip?: number;
  mode?: string;
}

/**
 * Returns the MongoDB collection for conversations.
 */
export function getConversationsCollection(): Collection<ConversationDocument> {
  const db = getDatabase();
  return db.collection<ConversationDocument>('conversations');
}

/**
 * Ensures optimal indexes for the 'conversations' collection.
 */
export async function ensureConversationIndexes(): Promise<void> {
  try {
    const col = getConversationsCollection();
    await col.createIndex({ userId: 1, updatedAt: -1 });
    await col.createIndex({ userId: 1, isPinned: 1, pinnedAt: -1 });
    await col.createIndex({ id: 1 }, { unique: true, sparse: true });
  } catch (err: any) {
    console.warn('[ConversationRepository] Index creation notice:', err?.message || err);
  }
}

/**
 * Creates a new conversation thread in MongoDB.
 */
export async function createConversation(input: CreateConversationInput): Promise<ConversationDocument> {
  if (!input.userId || !input.userId.trim()) {
    throw new Error('Valid userId is required to create a conversation.');
  }

  const col = getConversationsCollection();
  const cleanId = (input.id && input.id.trim()) ? input.id.trim() : new ObjectId().toHexString();
  const now = input.createdAt || new Date();

  if (input.id && input.id.trim()) {
    const existing = await col.findOne({ _id: cleanId });
    if (existing) {
      if (existing.userId === input.userId.trim()) {
        return existing;
      }
      const conflictErr: any = new Error('Conversation ID already belongs to a different user.');
      conflictErr.code = 'CONVERSATION_ID_CONFLICT';
      throw conflictErr;
    }
  }

  const doc: ConversationDocument = {
    _id: cleanId,
    id: cleanId,
    userId: input.userId.trim(),
    title: (input.title || '').trim() || 'New Conversation',
    mode: (input.mode || 'general').trim().toLowerCase(),
    isPinned: Boolean(input.isPinned),
    pinnedAt: input.isPinned ? (input.pinnedAt || now) : null,
    createdAt: now,
    updatedAt: input.updatedAt || now
  };

  await col.insertOne(doc);
  return doc;
}

/**
 * Finds a single conversation by ID.
 */
export async function findConversationById(id: string): Promise<ConversationDocument | null> {
  if (!id || !id.trim()) return null;
  const col = getConversationsCollection();
  const cleanId = id.trim();
  return col.findOne({
    $or: [{ _id: cleanId }, { id: cleanId }]
  });
}

/**
 * Finds conversations belonging to a specific user, ordered chronologically by most recently active.
 */
export async function findConversationsByUserId(
  userId: string,
  options: ListConversationsOptions = {}
): Promise<ConversationDocument[]> {
  if (!userId || !userId.trim()) return [];

  const col = getConversationsCollection();
  const filter: any = { userId: userId.trim() };
  if (options.mode) {
    filter.mode = options.mode.trim().toLowerCase();
  }

  const cursor = col
    .find(filter)
    .sort({ updatedAt: -1 })
    .skip(options.skip || 0);

  if (options.limit && options.limit > 0) {
    cursor.limit(options.limit);
  }

  return cursor.toArray();
}

/**
 * Counts how many conversations are currently pinned by a user (max 5 enforced).
 */
export async function countPinnedConversations(userId: string): Promise<number> {
  if (!userId || !userId.trim()) return 0;
  const col = getConversationsCollection();
  return col.countDocuments({
    userId: userId.trim(),
    isPinned: true
  });
}

/**
 * Finds all pinned conversations for a user.
 */
export async function findPinnedConversations(userId: string): Promise<ConversationDocument[]> {
  if (!userId || !userId.trim()) return [];
  const col = getConversationsCollection();
  return col
    .find({
      userId: userId.trim(),
      isPinned: true
    })
    .sort({ pinnedAt: -1, updatedAt: -1 })
    .toArray();
}

/**
 * Updates the title of an existing conversation.
 */
export async function updateConversationTitle(id: string, newTitle: string): Promise<boolean> {
  if (!id || !id.trim()) {
    throw new Error('Valid conversation id is required.');
  }
  const cleanTitle = (newTitle || '').trim();
  if (!cleanTitle) {
    throw new Error('Conversation title cannot be empty.');
  }

  const col = getConversationsCollection();
  const cleanId = id.trim();
  const result = await col.updateOne(
    { $or: [{ _id: cleanId }, { id: cleanId }] },
    {
      $set: {
        title: cleanTitle,
        updatedAt: new Date()
      }
    }
  );

  return result.matchedCount > 0;
}

/**
 * Updates the active mode (general, coding, writing, learning) of a conversation.
 */
export async function updateConversationMode(id: string, mode: string): Promise<boolean> {
  if (!id || !id.trim()) {
    throw new Error('Valid conversation id is required.');
  }
  const cleanMode = (mode || 'general').trim().toLowerCase();

  const col = getConversationsCollection();
  const cleanId = id.trim();
  const result = await col.updateOne(
    { $or: [{ _id: cleanId }, { id: cleanId }] },
    {
      $set: {
        mode: cleanMode,
        updatedAt: new Date()
      }
    }
  );

  return result.matchedCount > 0;
}

/**
 * Pins or unpins a conversation.
 */
export async function setConversationPinned(
  id: string,
  isPinned: boolean,
  pinnedAt: Date | null = null
): Promise<boolean> {
  if (!id || !id.trim()) {
    throw new Error('Valid conversation id is required.');
  }

  const col = getConversationsCollection();
  const cleanId = id.trim();
  const now = new Date();

  const result = await col.updateOne(
    { $or: [{ _id: cleanId }, { id: cleanId }] },
    {
      $set: {
        isPinned: Boolean(isPinned),
        pinnedAt: isPinned ? (pinnedAt || now) : null,
        updatedAt: now
      }
    }
  );

  return result.matchedCount > 0;
}

/**
 * Touches a conversation's updatedAt timestamp to reflect new message activity.
 */
export async function touchConversationUpdatedAt(id: string): Promise<boolean> {
  if (!id || !id.trim()) return false;
  const col = getConversationsCollection();
  const cleanId = id.trim();
  const result = await col.updateOne(
    { $or: [{ _id: cleanId }, { id: cleanId }] },
    { $set: { updatedAt: new Date() } }
  );
  return result.matchedCount > 0;
}

/**
 * Updates arbitrary fields on a conversation.
 */
export async function updateConversation(
  id: string,
  patch: UpdateConversationInput
): Promise<ConversationDocument | null> {
  if (!id || !id.trim()) {
    throw new Error('Valid conversation id is required.');
  }

  const col = getConversationsCollection();
  const cleanId = id.trim();
  const updateFields: any = {
    updatedAt: patch.updatedAt || new Date()
  };

  if (patch.title !== undefined) updateFields.title = patch.title.trim();
  if (patch.mode !== undefined) updateFields.mode = patch.mode.trim().toLowerCase();
  if (patch.isPinned !== undefined) {
    updateFields.isPinned = Boolean(patch.isPinned);
    updateFields.pinnedAt = patch.isPinned ? (patch.pinnedAt || new Date()) : null;
  }

  return col.findOneAndUpdate(
    { $or: [{ _id: cleanId }, { id: cleanId }] },
    { $set: updateFields },
    { returnDocument: 'after' }
  );
}

/**
 * Deletes a single conversation document by ID.
 */
export async function deleteConversation(id: string): Promise<boolean> {
  if (!id || !id.trim()) return false;
  const col = getConversationsCollection();
  const cleanId = id.trim();
  const result = await col.deleteOne({
    $or: [{ _id: cleanId }, { id: cleanId }]
  });
  return result.deletedCount > 0;
}

/**
 * Deletes all conversations belonging to a user (account cleanup).
 */
export async function deleteConversationsByUserId(userId: string): Promise<number> {
  if (!userId || !userId.trim()) return 0;
  const col = getConversationsCollection();
  const result = await col.deleteMany({ userId: userId.trim() });
  return result.deletedCount;
}
