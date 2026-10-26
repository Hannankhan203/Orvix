/**
 * Orvix Message Repository (MongoDB Atlas)
 *
 * Handles persistence and queries for the 'messages' collection in database 'Orvix'.
 * Replaces Firebase Firestore /users/{userId}/chats/{chatId}/messages/{messageId} subcollection.
 */

import { Collection, ObjectId } from 'mongodb';
import { getDatabase } from '../db/mongodb.ts';

export interface MessageAttachment {
  id?: string;
  name?: string;
  originalName?: string;
  size?: number;
  formattedSize?: string;
  type?: string;
  extension?: string;
  isImage?: boolean;
  status?: string;
  extraction?: any;
}

export interface MessageAlternative {
  id: string;
  parentMessageId?: string | null;
  sender: 'assistant';
  content: string;
  provider?: string;
  modelUsed?: string | null;
  responseTimeMs?: number | null;
  timestamp?: string;
  createdAt?: number | Date;
  referencedAttachments?: MessageAttachment[];
  isError?: boolean;
  isStopped?: boolean;
}

export interface MessageDocument {
  _id: string; // Stable Message ID (e.g. 'msg-...' or ObjectId string)
  id: string; // Parity with _id for frontend compatibility
  conversationId: string; // Foreign key referencing conversation._id
  userId?: string; // Optional user owner reference
  sender: 'user' | 'assistant';
  content: string;
  modelUsed?: string | null;
  provider?: string | null;
  mode?: string | null;
  responseTimeMs?: number | null;
  parentMessageId?: string | null;
  activeAlternativeId?: string | null;
  alternatives?: MessageAlternative[];
  attachments?: MessageAttachment[];
  referencedAttachments?: MessageAttachment[];
  isStopped?: boolean;
  isInterrupted?: boolean;
  clientTimestamp?: string;
  createdAt: Date;
  updatedAt?: Date;
}

export interface CreateMessageInput {
  id?: string;
  conversationId: string;
  userId?: string;
  sender: 'user' | 'assistant';
  content: string;
  modelUsed?: string | null;
  provider?: string | null;
  mode?: string | null;
  responseTimeMs?: number | null;
  parentMessageId?: string | null;
  activeAlternativeId?: string | null;
  alternatives?: MessageAlternative[];
  attachments?: MessageAttachment[];
  referencedAttachments?: MessageAttachment[];
  isStopped?: boolean;
  isInterrupted?: boolean;
  clientTimestamp?: string;
  createdAt?: Date | string | number;
  createdAtMs?: number;
}

export interface UpdateMessageInput {
  content?: string;
  modelUsed?: string | null;
  provider?: string | null;
  mode?: string | null;
  responseTimeMs?: number | null;
  parentMessageId?: string | null;
  activeAlternativeId?: string | null;
  alternatives?: MessageAlternative[];
  attachments?: MessageAttachment[];
  referencedAttachments?: MessageAttachment[];
  isStopped?: boolean;
  isInterrupted?: boolean;
  clientTimestamp?: string;
}

/**
 * Normalizes flexible timestamp inputs (Date, ISO string, or epoch ms) into a valid Date instance.
 */
function resolveValidCreatedAt(
  createdAt?: Date | string | number,
  createdAtMs?: number
): Date {
  if (createdAt instanceof Date && !isNaN(createdAt.getTime())) {
    return createdAt;
  }
  if (typeof createdAt === 'string' || typeof createdAt === 'number') {
    const parsed = new Date(createdAt);
    if (!isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  if (typeof createdAtMs === 'number' && Number.isFinite(createdAtMs)) {
    const parsed = new Date(createdAtMs);
    if (!isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return new Date();
}

/**
 * Returns the MongoDB collection for messages.
 */
export function getMessagesCollection(): Collection<MessageDocument> {
  const db = getDatabase();
  return db.collection<MessageDocument>('messages');
}

/**
 * Ensures optimal indexes for the 'messages' collection.
 */
export async function ensureMessageIndexes(): Promise<void> {
  try {
    const col = getMessagesCollection();
    await col.createIndex({ conversationId: 1, createdAt: 1 });
    await col.createIndex({ id: 1 }, { unique: true, sparse: true });
    await col.createIndex({ userId: 1, createdAt: -1 });
  } catch (err: any) {
    console.warn('[MessageRepository] Index creation notice:', err?.message || err);
  }
}

/**
 * Creates or idempotently updates a message document in MongoDB.
 * Preserves original createdAt on retries/in-place updates (regenerate, alternatives, edit-and-resend)
 * and prevents cross-conversation message ID collisions.
 */
export async function createMessage(input: CreateMessageInput): Promise<MessageDocument> {
  if (!input.conversationId || !input.conversationId.trim()) {
    throw new Error('Valid conversationId is required to save a message.');
  }
  if (input.content === undefined || input.content === null) {
    throw new Error('Message content must be provided.');
  }

  const col = getMessagesCollection();
  const cleanConvId = input.conversationId.trim();
  const hasExplicitId = Boolean(input.id && input.id.trim());
  const cleanId = hasExplicitId
    ? input.id!.trim()
    : `msg-${Date.now()}-${new ObjectId().toHexString().slice(-6)}`;
  const now = new Date();
  const createdDate = resolveValidCreatedAt(input.createdAt, input.createdAtMs);
  const formattedClientTime =
    input.clientTimestamp ||
    createdDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const upsertExisting = async (existing: MessageDocument): Promise<MessageDocument> => {
    if (existing.conversationId !== cleanConvId) {
      const conflictErr: any = new Error('Message ID already belongs to a different conversation.');
      conflictErr.code = 'MESSAGE_ID_CONFLICT';
      throw conflictErr;
    }

    const updateFields: Record<string, any> = {
      sender: input.sender,
      content: String(input.content),
      modelUsed: input.modelUsed !== undefined ? (input.modelUsed || null) : (existing.modelUsed ?? null),
      provider: input.provider !== undefined ? (input.provider || null) : (existing.provider ?? null),
      mode: input.mode !== undefined ? (input.mode || null) : (existing.mode ?? null),
      responseTimeMs:
        typeof input.responseTimeMs === 'number'
          ? input.responseTimeMs
          : input.responseTimeMs === null
            ? null
            : (existing.responseTimeMs ?? null),
      parentMessageId:
        input.parentMessageId !== undefined ? (input.parentMessageId || null) : (existing.parentMessageId ?? null),
      activeAlternativeId:
        input.activeAlternativeId !== undefined
          ? (input.activeAlternativeId || null)
          : (existing.activeAlternativeId ?? null),
      alternatives: Array.isArray(input.alternatives) ? input.alternatives : (existing.alternatives || []),
      attachments: Array.isArray(input.attachments) ? input.attachments : (existing.attachments || []),
      referencedAttachments: Array.isArray(input.referencedAttachments)
        ? input.referencedAttachments
        : (existing.referencedAttachments || []),
      isStopped: typeof input.isStopped === 'boolean' ? input.isStopped : Boolean(existing.isStopped),
      isInterrupted:
        typeof input.isInterrupted === 'boolean' ? input.isInterrupted : Boolean(existing.isInterrupted),
      clientTimestamp: input.clientTimestamp || existing.clientTimestamp || formattedClientTime,
      updatedAt: now
    };

    const updated = await col.findOneAndUpdate(
      { $or: [{ _id: existing._id }, { id: existing.id }] },
      { $set: updateFields },
      { returnDocument: 'after' }
    );

    return (updated || { ...existing, ...updateFields }) as MessageDocument;
  };

  if (hasExplicitId) {
    const existing = await col.findOne({
      $or: [{ _id: cleanId }, { id: cleanId }]
    });
    if (existing) {
      return upsertExisting(existing);
    }
  }

  const doc: MessageDocument = {
    _id: cleanId,
    id: cleanId,
    conversationId: cleanConvId,
    userId: input.userId?.trim() || undefined,
    sender: input.sender,
    content: String(input.content),
    modelUsed: input.modelUsed || null,
    provider: input.provider || null,
    mode: input.mode || null,
    responseTimeMs: typeof input.responseTimeMs === 'number' ? input.responseTimeMs : null,
    parentMessageId: input.parentMessageId || null,
    activeAlternativeId: input.activeAlternativeId || null,
    alternatives: Array.isArray(input.alternatives) ? input.alternatives : [],
    attachments: Array.isArray(input.attachments) ? input.attachments : [],
    referencedAttachments: Array.isArray(input.referencedAttachments) ? input.referencedAttachments : [],
    isStopped: Boolean(input.isStopped),
    isInterrupted: Boolean(input.isInterrupted),
    clientTimestamp: formattedClientTime,
    createdAt: createdDate,
    updatedAt: now
  };

  try {
    await col.insertOne(doc);
    return doc;
  } catch (err: any) {
    if (hasExplicitId && err?.code === 11000) {
      const raced = await col.findOne({
        $or: [{ _id: cleanId }, { id: cleanId }]
      });
      if (raced) {
        return upsertExisting(raced);
      }
    }
    throw err;
  }
}

/**
 * Finds a single message by ID.
 */
export async function findMessageById(id: string): Promise<MessageDocument | null> {
  if (!id || !id.trim()) return null;
  const col = getMessagesCollection();
  const cleanId = id.trim();
  return col.findOne({
    $or: [{ _id: cleanId }, { id: cleanId }]
  });
}

/**
 * Loads all messages for a conversation, ordered chronologically (oldest to newest by default).
 * Applies deterministic parent/role tie-breaking when two messages share an identical millisecond timestamp.
 */
export async function findMessagesByConversationId(
  conversationId: string,
  options: { sort?: 'asc' | 'desc'; limit?: number } = {}
): Promise<MessageDocument[]> {
  if (!conversationId || !conversationId.trim()) return [];

  const col = getMessagesCollection();
  const isDesc = options.sort === 'desc';
  const sortDirection = isDesc ? -1 : 1;
  const cursor = col
    .find({ conversationId: conversationId.trim() })
    .sort({ createdAt: sortDirection });

  if (options.limit && options.limit > 0) {
    cursor.limit(options.limit);
  }

  const docs = await cursor.toArray();
  docs.sort((a, b) => {
    const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    if (ta !== tb) {
      return (ta - tb) * sortDirection;
    }
    if (b.parentMessageId && b.parentMessageId === a.id) {
      return -1 * sortDirection;
    }
    if (a.parentMessageId && a.parentMessageId === b.id) {
      return 1 * sortDirection;
    }
    if (a.sender !== b.sender) {
      return (a.sender === 'user' ? -1 : 1) * sortDirection;
    }
    return 0;
  });

  return docs;
}

/**
 * Finds the latest message in a conversation.
 */
export async function findLatestMessageByConversationId(conversationId: string): Promise<MessageDocument | null> {
  if (!conversationId || !conversationId.trim()) return null;
  const col = getMessagesCollection();
  return col.findOne(
    { conversationId: conversationId.trim() },
    { sort: { createdAt: -1 } }
  );
}

/**
 * Counts total messages in a conversation.
 */
export async function countMessagesByConversationId(conversationId: string): Promise<number> {
  if (!conversationId || !conversationId.trim()) return 0;
  const col = getMessagesCollection();
  return col.countDocuments({ conversationId: conversationId.trim() });
}

/**
 * Updates a specific message by ID.
 */
export async function updateMessage(id: string, patch: UpdateMessageInput): Promise<MessageDocument | null> {
  if (!id || !id.trim()) {
    throw new Error('Valid message id is required.');
  }

  const col = getMessagesCollection();
  const cleanId = id.trim();
  const updateFields: any = {
    updatedAt: new Date()
  };

  if (patch.content !== undefined) updateFields.content = patch.content;
  if (patch.modelUsed !== undefined) updateFields.modelUsed = patch.modelUsed;
  if (patch.provider !== undefined) updateFields.provider = patch.provider;
  if (patch.mode !== undefined) updateFields.mode = patch.mode;
  if (patch.responseTimeMs !== undefined) updateFields.responseTimeMs = patch.responseTimeMs;
  if (patch.parentMessageId !== undefined) updateFields.parentMessageId = patch.parentMessageId;
  if (patch.activeAlternativeId !== undefined) updateFields.activeAlternativeId = patch.activeAlternativeId;
  if (patch.alternatives !== undefined) updateFields.alternatives = patch.alternatives;
  if (patch.attachments !== undefined) updateFields.attachments = patch.attachments;
  if (patch.referencedAttachments !== undefined) updateFields.referencedAttachments = patch.referencedAttachments;
  if (patch.isStopped !== undefined) updateFields.isStopped = Boolean(patch.isStopped);
  if (patch.isInterrupted !== undefined) updateFields.isInterrupted = Boolean(patch.isInterrupted);
  if (patch.clientTimestamp !== undefined) updateFields.clientTimestamp = patch.clientTimestamp;

  return col.findOneAndUpdate(
    { $or: [{ _id: cleanId }, { id: cleanId }] },
    { $set: updateFields },
    { returnDocument: 'after' }
  );
}

/**
 * Deletes a single message by ID.
 */
export async function deleteMessage(id: string): Promise<boolean> {
  if (!id || !id.trim()) return false;
  const col = getMessagesCollection();
  const cleanId = id.trim();
  const result = await col.deleteOne({
    $or: [{ _id: cleanId }, { id: cleanId }]
  });
  return result.deletedCount > 0;
}

/**
 * Deletes specific messages by their IDs within a conversation.
 * Used when truncating conversation branches during Edit and Resend.
 */
export async function deleteMessagesByIds(conversationId: string, messageIds: string[]): Promise<number> {
  if (!conversationId || !conversationId.trim() || !Array.isArray(messageIds) || messageIds.length === 0) {
    return 0;
  }

  const cleanIds = messageIds.filter((id) => typeof id === 'string' && id.trim().length > 0);
  if (cleanIds.length === 0) return 0;

  const col = getMessagesCollection();
  const result = await col.deleteMany({
    conversationId: conversationId.trim(),
    $or: [{ _id: { $in: cleanIds } }, { id: { $in: cleanIds } }]
  });

  return result.deletedCount;
}

/**
 * Deletes all messages belonging to a conversation.
 * Used during conversation deletion.
 */
export async function deleteMessagesByConversationId(conversationId: string): Promise<number> {
  if (!conversationId || !conversationId.trim()) return 0;
  const col = getMessagesCollection();
  const result = await col.deleteMany({ conversationId: conversationId.trim() });
  return result.deletedCount;
}
