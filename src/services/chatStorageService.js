/**
 * Orvix Firestore Chat Storage Service
 * Handles conversation metadata, message subcollections, title auto-generation,
 * renaming, and deep subcollection deletion in Cloud Firestore.
 *
 * Schema:
 *   users/{userId}/chats/{chatId}
 *     - id: string
 *     - title: string
 *     - userId: string
 *     - createdAt: timestamp
 *     - updatedAt: timestamp
 *
 *   users/{userId}/chats/{chatId}/messages/{messageId}
 *     - id: string
 *     - sender: 'user' | 'assistant'
 *     - content: string
 *     - modelUsed: string | null
 *     - createdAt: timestamp
 *     - clientTimestamp: string
 */

import {
  collection,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  getDocs,
  query,
  where,
  orderBy,
  onSnapshot,
  serverTimestamp,
  writeBatch
} from 'firebase/firestore';
import {
  db,
  isFirebaseConfigured,
  isBrowserOnline,
  syncFirestoreNetworkState
} from '../config/firebaseConfig.js';
import {
  normalizeAssistantMessage,
  ensureConversationAlternatives,
  orderConversationMessages
} from './alternativeResponseService.js';

const FIRESTORE_OP_TIMEOUT_MS = 4500;
const activeSyncPromises = new Map();

function getUserChatsCacheKey(userId) {
  return `orvix_user_chats_${userId}`;
}

function getUserMessagesCacheKey(userId, chatId) {
  return `orvix_user_messages_${userId}_${chatId}`;
}

function getUserDeletedChatsKey(userId) {
  return `orvix_user_deleted_chats_${userId}`;
}

function formatChatDateLabel(ms) {
  if (!ms || !Number.isFinite(ms)) return 'Recently';
  try {
    return new Date(ms).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric'
    });
  } catch (_) {
    return 'Recently';
  }
}

function withBoundedTimeout(promise, timeoutMs = FIRESTORE_OP_TIMEOUT_MS, label = 'Firestore operation') {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} timed out after ${timeoutMs}ms`);
      err.code = 'unavailable';
      reject(err);
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function isOfflineOrNetworkError(err) {
  if (!isBrowserOnline()) return true;
  const code = String(err?.code || '').toLowerCase();
  const msg = String(err?.message || err || '').toLowerCase();
  return (
    code === 'unavailable' ||
    code.includes('unavailable') ||
    code.includes('network-request-failed') ||
    code.includes('deadline-exceeded') ||
    msg.includes('offline') ||
    msg.includes('timed out') ||
    msg.includes('failed to get document') ||
    msg.includes('network') ||
    msg.includes('fetch') ||
    msg.includes('internet_disconnected')
  );
}

/**
 * Reads cached conversation metadata for a signed-in user from localStorage.
 * @param {string} userId
 * @returns {Array}
 */
export function getCachedUserChats(userId) {
  if (!userId || typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(getUserChatsCacheKey(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn('Could not read cached user chats:', err);
    return [];
  }
}

/**
 * Persists conversation metadata list for a signed-in user to localStorage.
 * @param {string} userId
 * @param {Array} chats
 */
export function saveCachedUserChats(userId, chats) {
  if (!userId || typeof window === 'undefined' || !Array.isArray(chats)) return;
  try {
    const sorted = [...chats].sort((a, b) => (b.rawUpdatedAt || 0) - (a.rawUpdatedAt || 0));
    localStorage.setItem(getUserChatsCacheKey(userId), JSON.stringify(sorted));
  } catch (err) {
    console.warn('Could not save cached user chats:', err);
  }
}

/**
 * Reads cached messages for a specific signed-in user's conversation from localStorage.
 * @param {string} userId
 * @param {string} chatId
 * @returns {Array}
 */
export function getCachedChatMessages(userId, chatId) {
  if (!userId || !chatId || typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(getUserMessagesCacheKey(userId, chatId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn('Could not read cached chat messages:', err);
    return [];
  }
}

/**
 * Persists messages for a specific signed-in user's conversation to localStorage.
 * @param {string} userId
 * @param {string} chatId
 * @param {Array} messages
 */
export function saveCachedChatMessages(userId, chatId, messages) {
  if (!userId || !chatId || typeof window === 'undefined' || !Array.isArray(messages)) return;
  try {
    const sanitizedMessages = messages.map((msg) => sanitizeMessageForStorage(msg));
    localStorage.setItem(getUserMessagesCacheKey(userId, chatId), JSON.stringify(sanitizedMessages));
  } catch (err) {
    console.warn('Could not save cached chat messages:', err);
  }
}

function getPendingDeletedChatIds(userId) {
  if (!userId || typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(getUserDeletedChatsKey(userId));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function savePendingDeletedChatIds(userId, ids) {
  if (!userId || typeof window === 'undefined') return;
  try {
    localStorage.setItem(getUserDeletedChatsKey(userId), JSON.stringify(Array.from(new Set(ids))));
  } catch (_) {}
}

function upsertCachedUserChat(userId, chatPatch) {
  if (!userId || !chatPatch?.id) return [];
  const existing = getCachedUserChats(userId);
  const idx = existing.findIndex((c) => c.id === chatPatch.id);
  let next;
  if (idx >= 0) {
    next = existing.map((c, i) => (i === idx ? { ...c, ...chatPatch } : c));
  } else {
    next = [chatPatch, ...existing];
  }
  saveCachedUserChats(userId, next);
  return getCachedUserChats(userId);
}

function upsertCachedChatMessage(userId, chatId, messageObj) {
  if (!userId || !chatId || !messageObj?.id) return [];
  const existing = getCachedChatMessages(userId, chatId);
  const idx = existing.findIndex((m) => m.id === messageObj.id);
  let next;
  if (idx >= 0) {
    next = existing.map((m, i) => (i === idx ? { ...m, ...messageObj } : m));
  } else {
    next = [...existing, messageObj];
  }
  const orderedNext = orderConversationMessages(next);
  saveCachedChatMessages(userId, chatId, orderedNext);
  return orderedNext;
}

function sanitizeExtractionForStorage(extraction) {
  if (!extraction || typeof extraction !== 'object') return null;
  const { base64, dataUrl, data, previewUrl, file, blob, ...cleanExtraction } = extraction;
  return cleanExtraction;
}

export function serializeAttachmentForStorage(att) {
  if (!att || typeof att !== 'object') return att;
  const resolvedType = att.type || att.mimeType || '';
  return {
    id: att.id,
    name: att.name || att.originalName || 'document',
    originalName: att.originalName || att.name || 'document',
    size: att.size || 0,
    formattedSize: att.formattedSize || '',
    type: resolvedType,
    mimeType: att.mimeType || resolvedType,
    extension: att.extension || '',
    isImage: Boolean(att.isImage),
    status: att.status || 'uploaded',
    extraction: sanitizeExtractionForStorage(att.extraction)
  };
}

export function sanitizeMessageForStorage(msg) {
  if (!msg || typeof msg !== 'object') return msg;
  const next = { ...msg };
  if (Array.isArray(next.attachments)) {
    next.attachments = next.attachments.map(serializeAttachmentForStorage);
  }
  if (Array.isArray(next.referencedAttachments)) {
    next.referencedAttachments = next.referencedAttachments.map(serializeAttachmentForStorage);
  }
  if (Array.isArray(next.alternatives)) {
    next.alternatives = next.alternatives.map((alt) => {
      if (!alt || typeof alt !== 'object') return alt;
      const sanitizedAlt = { ...alt };
      if (Array.isArray(sanitizedAlt.attachments)) {
        sanitizedAlt.attachments = sanitizedAlt.attachments.map(serializeAttachmentForStorage);
      }
      if (Array.isArray(sanitizedAlt.referencedAttachments)) {
        sanitizedAlt.referencedAttachments = sanitizedAlt.referencedAttachments.map(serializeAttachmentForStorage);
      }
      return sanitizedAlt;
    });
  }
  return next;
}

function buildFirestoreMessagePayload(targetMessage) {
  return {
    id: targetMessage.id,
    sender: targetMessage.sender,
    content: targetMessage.content,
    modelUsed: targetMessage.modelUsed || null,
    provider: targetMessage.provider || null,
    responseTimeMs: typeof targetMessage.responseTimeMs === 'number' ? targetMessage.responseTimeMs : null,
    parentMessageId: targetMessage.parentMessageId || null,
    interactionId: targetMessage.interactionId || null,
    createdAtMs: typeof targetMessage.createdAtMs === 'number' ? targetMessage.createdAtMs : Date.now(),
    activeAlternativeId: targetMessage.activeAlternativeId || null,
    alternatives: Array.isArray(targetMessage.alternatives)
      ? targetMessage.alternatives.map((alt) => ({
          id: alt.id,
          parentMessageId: alt.parentMessageId || targetMessage.parentMessageId || null,
          sender: 'assistant',
          content: typeof alt.content === 'string' ? alt.content : '',
          provider: alt.provider || targetMessage.provider || 'gemini',
          modelUsed: alt.modelUsed || null,
          responseTimeMs: typeof alt.responseTimeMs === 'number' ? alt.responseTimeMs : null,
          timestamp: alt.timestamp || '',
          createdAt: typeof alt.createdAt === 'number' ? alt.createdAt : Date.now(),
          referencedAttachments: Array.isArray(alt.referencedAttachments)
            ? alt.referencedAttachments.map(serializeAttachmentForStorage)
            : [],
          isError: Boolean(alt.isError),
          isStopped: Boolean(alt.isStopped)
        }))
      : [],
    attachments: Array.isArray(targetMessage.attachments)
      ? targetMessage.attachments.map(serializeAttachmentForStorage)
      : [],
    referencedAttachments: Array.isArray(targetMessage.referencedAttachments)
      ? targetMessage.referencedAttachments.map(serializeAttachmentForStorage)
      : [],
    createdAt: serverTimestamp(),
    clientTimestamp:
      targetMessage.timestamp ||
      new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  };
}

/**
 * Generates a clean, readable conversation title from the initial user prompt.
 * @param {string} promptText
 * @param {number} [maxLength=36]
 * @returns {string}
 */
export function generateChatTitle(promptText, maxLength = 36) {
  if (!promptText || !promptText.trim()) {
    return 'New Conversation';
  }

  // Clean markdown symbols, quotes, and excessive whitespace
  let clean = promptText
    .replace(/^[#*`>"'\s]+/, '')
    .replace(/[#*`>"'\n\r\t]+/g, ' ')
    .trim();

  if (!clean) {
    return 'New Conversation';
  }

  if (clean.length <= maxLength) {
    return clean;
  }

  // Truncate at last space before maxLength
  const truncated = clean.substring(0, maxLength);
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > 16) {
    return truncated.substring(0, lastSpace) + '...';
  }

  return truncated + '...';
}

/**
 * Generates a valid chat ID without requiring network connectivity.
 * @param {string} [userId]
 * @returns {string}
 */
export function generateLocalChatId(userId = '') {
  if (db && userId) {
    try {
      return doc(collection(db, 'users', userId, 'chats')).id;
    } catch (_) {}
  }
  return `local-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 8)}`;
}

/**
 * Creates a new chat conversation document in Firestore with automatic offline local fallback.
 * @param {string} userId - Authenticated user UID
 * @param {string} [initialTitle='New Conversation']
 * @param {string} [mode='general'] - Active chat mode (general | coding | writing | learning)
 * @returns {Promise<string>} The generated chatId
 */
export async function createChatDocument(userId, initialTitle = 'New Conversation', mode = 'general') {
  if (!userId) {
    throw new Error('Valid userId is required to create a conversation.');
  }

  const nowMs = Date.now();
  const chatId = generateLocalChatId(userId);
  const cleanMode = mode || 'general';

  // Always record locally first so offline mode or interrupted connections never lose the chat
  upsertCachedUserChat(userId, {
    id: chatId,
    title: initialTitle,
    mode: cleanMode,
    timestamp: 'Just now',
    rawUpdatedAt: nowMs,
    createdAtMs: nowMs,
    isPinned: false,
    pinnedAt: null,
    pendingSync: true,
    createdOffline: !isBrowserOnline()
  });

  if (!db || !isFirebaseConfigured() || !isBrowserOnline()) {
    return chatId;
  }

  const newChatDoc = doc(db, 'users', userId, 'chats', chatId);
  const chatData = {
    id: chatId,
    title: initialTitle,
    mode: cleanMode,
    userId,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    isPinned: false,
    pinnedAt: null
  };

  try {
    await withBoundedTimeout(setDoc(newChatDoc, chatData), FIRESTORE_OP_TIMEOUT_MS, 'createChatDocument');
    upsertCachedUserChat(userId, {
      id: chatId,
      pendingSync: false,
      createdOffline: false
    });
  } catch (err) {
    if (isOfflineOrNetworkError(err)) {
      console.warn('Offline/network fallback: created conversation locally for later sync:', chatId);
      return chatId;
    }
    throw err;
  }

  return chatId;
}

/**
 * Updates the active mode of an existing conversation in Firestore (and local cache).
 * @param {string} userId
 * @param {string} chatId
 * @param {string} mode
 */
export async function updateChatMode(userId, chatId, mode) {
  if (!userId || !chatId) return;
  const cleanMode = mode || 'general';

  upsertCachedUserChat(userId, {
    id: chatId,
    mode: cleanMode,
    rawUpdatedAt: Date.now(),
    pendingMetaSync: !isBrowserOnline()
  });

  if (!db || !isFirebaseConfigured() || !isBrowserOnline()) {
    return;
  }
  const chatDocRef = doc(db, 'users', userId, 'chats', chatId);
  try {
    await withBoundedTimeout(
      updateDoc(chatDocRef, {
        mode: cleanMode,
        updatedAt: serverTimestamp()
      }),
      FIRESTORE_OP_TIMEOUT_MS,
      'updateChatMode'
    );
    upsertCachedUserChat(userId, { id: chatId, pendingMetaSync: false });
  } catch (err) {
    upsertCachedUserChat(userId, { id: chatId, pendingMetaSync: true });
    console.warn('Could not update conversation mode in Firestore (saved locally):', err?.message || err);
  }
}

/**
 * Appends a message to a chat's messages subcollection and updates parent chat's updatedAt.
 * Always writes to user-scoped local cache first and falls back gracefully when offline.
 *
 * @param {string} userId - Authenticated user UID
 * @param {string} chatId - Chat document ID
 * @param {Object} message - Message object
 */
export async function saveChatMessage(userId, chatId, message) {
  if (!userId || !chatId || !message?.id) {
    return;
  }

  // Never persist temporary mock messages, loading states, or failed error messages
  if (message.isError || (message.sender !== 'user' && message.sender !== 'assistant')) {
    return;
  }

  const targetMessage = sanitizeMessageForStorage(
    message.sender === 'assistant'
      ? normalizeAssistantMessage(message)
      : message
  );

  const clientTimestamp =
    targetMessage.timestamp ||
    new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const nowMs = Date.now();

  const localRecord = {
    ...targetMessage,
    timestamp: clientTimestamp,
    createdAtMs: typeof targetMessage.createdAtMs === 'number' ? targetMessage.createdAtMs : nowMs,
    pendingSync: true
  };

  // 1. Always persist locally first so messages survive refreshes while offline
  upsertCachedChatMessage(userId, chatId, localRecord);
  const cachedChat = getCachedUserChats(userId).find((c) => c.id === chatId);
  upsertCachedUserChat(userId, {
    id: chatId,
    title: cachedChat?.title || 'Conversation',
    mode: cachedChat?.mode || targetMessage.mode || 'general',
    timestamp: formatChatDateLabel(nowMs),
    rawUpdatedAt: nowMs,
    isPinned: Boolean(cachedChat?.isPinned),
    pinnedAt: cachedChat?.pinnedAt || null,
    pendingSync: true
  });

  if (!db || !isFirebaseConfigured() || !isBrowserOnline()) {
    return;
  }

  const messageDocRef = doc(db, 'users', userId, 'chats', chatId, 'messages', targetMessage.id);
  const chatDocRef = doc(db, 'users', userId, 'chats', chatId);
  const payload = buildFirestoreMessagePayload({
    ...targetMessage,
    timestamp: clientTimestamp
  });

  try {
    // Ensure parent chat exists in Firestore if it was originally created offline
    if (cachedChat?.createdOffline) {
      await withBoundedTimeout(
        setDoc(
          chatDocRef,
          {
            id: chatId,
            title: cachedChat.title || 'New Conversation',
            mode: cachedChat.mode || 'general',
            userId,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
            isPinned: Boolean(cachedChat.isPinned),
            pinnedAt: cachedChat.pinnedAt || null
          },
          { merge: true }
        ),
        FIRESTORE_OP_TIMEOUT_MS,
        'ensureParentChatDoc'
      );
    }

    // Write message document idempotently by stable ID
    await withBoundedTimeout(setDoc(messageDocRef, payload), FIRESTORE_OP_TIMEOUT_MS, 'saveChatMessage');

    // Touch parent chat's updatedAt timestamp
    try {
      await withBoundedTimeout(
        updateDoc(chatDocRef, {
          updatedAt: serverTimestamp()
        }),
        FIRESTORE_OP_TIMEOUT_MS,
        'touchParentChatUpdatedAt'
      );
    } catch (_) {}

    upsertCachedChatMessage(userId, chatId, {
      ...localRecord,
      pendingSync: false
    });

    // Clear chat-level pendingSync if no other messages in this chat are still pending
    const remainingPending = getCachedChatMessages(userId, chatId).some((m) => m.pendingSync);
    upsertCachedUserChat(userId, {
      id: chatId,
      pendingSync: remainingPending,
      createdOffline: false
    });
  } catch (err) {
    if (isOfflineOrNetworkError(err)) {
      console.warn('Firestore unreachable while saving message; retained in local sync queue:', targetMessage.id);
      return;
    }
    throw err;
  }
}

/**
 * Renames an existing conversation
 * @param {string} userId
 * @param {string} chatId
 * @param {string} newTitle
 */
export async function renameConversation(userId, chatId, newTitle) {
  const sanitized = (newTitle || '').trim();
  if (!sanitized) {
    throw new Error('Conversation title cannot be empty.');
  }

  if (userId && chatId) {
    upsertCachedUserChat(userId, {
      id: chatId,
      title: sanitized,
      rawUpdatedAt: Date.now(),
      pendingMetaSync: !isBrowserOnline()
    });
  }

  if (!db || !isFirebaseConfigured() || !isBrowserOnline()) {
    return;
  }

  try {
    const chatDocRef = doc(db, 'users', userId, 'chats', chatId);
    await withBoundedTimeout(
      updateDoc(chatDocRef, {
        title: sanitized,
        updatedAt: serverTimestamp()
      }),
      FIRESTORE_OP_TIMEOUT_MS,
      'renameConversation'
    );
    upsertCachedUserChat(userId, { id: chatId, pendingMetaSync: false });
  } catch (err) {
    if (isOfflineOrNetworkError(err)) {
      upsertCachedUserChat(userId, { id: chatId, pendingMetaSync: true });
      return;
    }
    throw err;
  }
}

/**
 * Toggles or updates the pinned status of a conversation in Firestore (with offline local fallback).
 * Enforces a strict limit of maximum 5 pinned chats per user.
 *
 * @param {string} userId - Authenticated user UID
 * @param {string} chatId - Chat document ID
 * @param {boolean} isPinned - Target pinned status
 * @returns {Promise<boolean>} Resulting pinned state
 */
export async function toggleChatPinned(userId, chatId, isPinned) {
  if (!userId || !chatId) {
    throw new Error('Valid userId and chatId are required.');
  }

  const cachedChats = getCachedUserChats(userId);
  if (isPinned) {
    const localPinnedCount = cachedChats.filter((c) => c.isPinned && c.id !== chatId).length;
    if (localPinnedCount >= 5) {
      throw new Error('You can pin up to 5 chats. Unpin a chat before pinning another.');
    }
  }

  const nowMs = Date.now();

  if (!db || !isFirebaseConfigured() || !isBrowserOnline()) {
    upsertCachedUserChat(userId, {
      id: chatId,
      isPinned: Boolean(isPinned),
      pinnedAt: isPinned ? nowMs : null,
      rawUpdatedAt: nowMs,
      pendingMetaSync: true
    });
    return Boolean(isPinned);
  }

  const chatDocRef = doc(db, 'users', userId, 'chats', chatId);

  try {
    if (isPinned) {
      const chatsRef = collection(db, 'users', userId, 'chats');
      const pinnedQuery = query(chatsRef, where('isPinned', '==', true));
      const snapshot = await withBoundedTimeout(getDocs(pinnedQuery), FIRESTORE_OP_TIMEOUT_MS, 'checkPinnedLimit');

      const alreadyPinned = snapshot.docs.some((d) => d.id === chatId);
      if (!alreadyPinned && snapshot.docs.length >= 5) {
        throw new Error('You can pin up to 5 chats. Unpin a chat before pinning another.');
      }

      await withBoundedTimeout(
        updateDoc(chatDocRef, {
          isPinned: true,
          pinnedAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        }),
        FIRESTORE_OP_TIMEOUT_MS,
        'pinChat'
      );
      upsertCachedUserChat(userId, {
        id: chatId,
        isPinned: true,
        pinnedAt: nowMs,
        rawUpdatedAt: nowMs,
        pendingMetaSync: false
      });
      return true;
    } else {
      await withBoundedTimeout(
        updateDoc(chatDocRef, {
          isPinned: false,
          pinnedAt: null,
          updatedAt: serverTimestamp()
        }),
        FIRESTORE_OP_TIMEOUT_MS,
        'unpinChat'
      );
      upsertCachedUserChat(userId, {
        id: chatId,
        isPinned: false,
        pinnedAt: null,
        rawUpdatedAt: nowMs,
        pendingMetaSync: false
      });
      return false;
    }
  } catch (err) {
    if (isOfflineOrNetworkError(err)) {
      upsertCachedUserChat(userId, {
        id: chatId,
        isPinned: Boolean(isPinned),
        pinnedAt: isPinned ? nowMs : null,
        rawUpdatedAt: nowMs,
        pendingMetaSync: true
      });
      return Boolean(isPinned);
    }
    throw err;
  }
}

/**
 * Deletes a conversation and all its subcollection messages reliably
 * @param {string} userId - Authenticated user UID
 * @param {string} chatId - Chat document ID
 */
export async function deleteConversation(userId, chatId) {
  if (!userId || !chatId) {
    throw new Error('Valid userId and chatId are required.');
  }

  const existingLocal = getCachedUserChats(userId);
  const targetLocal = existingLocal.find((c) => c.id === chatId);
  saveCachedUserChats(
    userId,
    existingLocal.filter((c) => c.id !== chatId)
  );
  if (typeof window !== 'undefined') {
    try {
      localStorage.removeItem(getUserMessagesCacheKey(userId, chatId));
    } catch (_) {}
  }

  if (!db || !isFirebaseConfigured() || !isBrowserOnline()) {
    // Only queue cloud deletion if the chat wasn't strictly created offline and never synced
    if (!targetLocal?.createdOffline) {
      savePendingDeletedChatIds(userId, [...getPendingDeletedChatIds(userId), chatId]);
    }
    return;
  }

  try {
    const messagesRef = collection(db, 'users', userId, 'chats', chatId, 'messages');
    const snapshot = await withBoundedTimeout(getDocs(messagesRef), FIRESTORE_OP_TIMEOUT_MS, 'loadMessagesForDelete');

    const docs = snapshot.docs;
    const CHUNK_SIZE = 400;

    for (let i = 0; i < docs.length; i += CHUNK_SIZE) {
      const chunk = docs.slice(i, i + CHUNK_SIZE);
      const batch = writeBatch(db);
      chunk.forEach((docSnap) => {
        batch.delete(docSnap.ref);
      });
      await withBoundedTimeout(batch.commit(), FIRESTORE_OP_TIMEOUT_MS, 'deleteMessagesBatch');
    }

    const chatDocRef = doc(db, 'users', userId, 'chats', chatId);
    await withBoundedTimeout(deleteDoc(chatDocRef), FIRESTORE_OP_TIMEOUT_MS, 'deleteChatDoc');
  } catch (err) {
    if (isOfflineOrNetworkError(err)) {
      if (!targetLocal?.createdOffline) {
        savePendingDeletedChatIds(userId, [...getPendingDeletedChatIds(userId), chatId]);
      }
      return;
    }
    throw err;
  }
}

/**
 * Deletes specific messages from a chat's messages subcollection in Firestore (and local cache).
 * Used when truncating conversation branches during Edit and Resend.
 *
 * @param {string} userId - Authenticated user UID
 * @param {string} chatId - Chat document ID
 * @param {string[]} messageIds - Array of message document IDs to delete
 */
export async function deleteChatMessages(userId, chatId, messageIds = []) {
  if (!userId || !chatId || !Array.isArray(messageIds) || messageIds.length === 0) {
    return;
  }

  const validIds = messageIds.filter((id) => typeof id === 'string' && id.trim().length > 0);
  if (validIds.length === 0) return;

  const removeSet = new Set(validIds);
  const remainingLocal = getCachedChatMessages(userId, chatId).filter((m) => !removeSet.has(m.id));
  saveCachedChatMessages(userId, chatId, remainingLocal);

  if (!db || !isFirebaseConfigured() || !isBrowserOnline()) {
    return;
  }

  try {
    const CHUNK_SIZE = 400;
    for (let i = 0; i < validIds.length; i += CHUNK_SIZE) {
      const chunk = validIds.slice(i, i + CHUNK_SIZE);
      const batch = writeBatch(db);
      chunk.forEach((msgId) => {
        const msgRef = doc(db, 'users', userId, 'chats', chatId, 'messages', msgId);
        batch.delete(msgRef);
      });
      await withBoundedTimeout(batch.commit(), FIRESTORE_OP_TIMEOUT_MS, 'deleteChatMessages');
    }
  } catch (err) {
    console.warn('Could not delete truncated messages in Firestore (updated locally):', err?.message || err);
  }
}

/**
 * Merges cloud conversation metadata with locally cached pending conversations
 * so offline-created or unsynced chats are never overwritten or hidden.
 */
function mergeCloudAndLocalChats(userId, cloudChats) {
  const localChats = getCachedUserChats(userId);
  const deletedSet = new Set(getPendingDeletedChatIds(userId));
  const mergedMap = new Map();

  for (const c of cloudChats) {
    if (deletedSet.has(c.id)) continue;
    const localMatch = localChats.find((l) => l.id === c.id);
    if (localMatch && (localMatch.pendingSync || localMatch.pendingMetaSync)) {
      const newerRawUpdated = Math.max(c.rawUpdatedAt || 0, localMatch.rawUpdatedAt || 0);
      mergedMap.set(c.id, {
        ...c,
        title: localMatch.pendingMetaSync ? localMatch.title : (c.title || localMatch.title),
        mode: localMatch.pendingMetaSync ? localMatch.mode : (c.mode || localMatch.mode),
        isPinned: localMatch.pendingMetaSync ? Boolean(localMatch.isPinned) : Boolean(c.isPinned),
        pinnedAt: localMatch.pendingMetaSync ? localMatch.pinnedAt : c.pinnedAt,
        rawUpdatedAt: newerRawUpdated,
        timestamp: formatChatDateLabel(newerRawUpdated),
        pendingSync: Boolean(localMatch.pendingSync),
        pendingMetaSync: Boolean(localMatch.pendingMetaSync),
        createdOffline: false
      });
    } else {
      mergedMap.set(c.id, {
        ...c,
        pendingSync: false,
        pendingMetaSync: false,
        createdOffline: false
      });
    }
  }

  for (const localChat of localChats) {
    if (deletedSet.has(localChat.id)) continue;
    if (!mergedMap.has(localChat.id) && (localChat.pendingSync || localChat.createdOffline || localChat.pendingMetaSync)) {
      mergedMap.set(localChat.id, localChat);
    }
  }

  const merged = Array.from(mergedMap.values()).sort(
    (a, b) => (b.rawUpdatedAt || 0) - (a.rawUpdatedAt || 0)
  );
  saveCachedUserChats(userId, merged);
  return merged;
}

/**
 * Synchronizes any offline-created or offline-updated chats and messages to Cloud Firestore
 * idempotently once internet connectivity returns, without duplicating or losing messages.
 *
 * @param {string} userId
 * @returns {Promise<{ syncedChats: number, syncedMessages: number }>}
 */
export async function syncOfflineUserChatsToFirestore(userId) {
  if (!userId || !db || !isFirebaseConfigured() || !isBrowserOnline()) {
    return { syncedChats: 0, syncedMessages: 0 };
  }

  if (activeSyncPromises.has(userId)) {
    return activeSyncPromises.get(userId);
  }

  const syncTask = (async () => {
    let syncedChats = 0;
    let syncedMessages = 0;

    try {
      await syncFirestoreNetworkState(true);

      // 1. Replay any pending offline deletions
      const pendingDeleted = getPendingDeletedChatIds(userId);
      if (pendingDeleted.length > 0) {
        const remainingDeletes = [];
        for (const delChatId of pendingDeleted) {
          try {
            await deleteConversation(userId, delChatId);
          } catch (_) {
            remainingDeletes.push(delChatId);
          }
        }
        savePendingDeletedChatIds(userId, remainingDeletes);
      }

      // 2. Sync pending chat metadata and pending messages
      const localChats = getCachedUserChats(userId);
      for (const localChat of localChats) {
        if (!isBrowserOnline()) break;

        const localMessages = getCachedChatMessages(userId, localChat.id);
        const pendingMessages = localMessages.filter(
          (m) => m && m.pendingSync && !m.isError && (m.sender === 'user' || m.sender === 'assistant')
        );

        const needsChatSync = Boolean(
          localChat.pendingSync ||
          localChat.pendingMetaSync ||
          localChat.createdOffline ||
          pendingMessages.length > 0
        );

        if (!needsChatSync) continue;

        const chatDocRef = doc(db, 'users', userId, 'chats', localChat.id);

        try {
          const existingSnap = await withBoundedTimeout(
            getDoc(chatDocRef),
            FIRESTORE_OP_TIMEOUT_MS,
            'syncCheckChatDoc'
          );

          if (!existingSnap.exists()) {
            await withBoundedTimeout(
              setDoc(
                chatDocRef,
                {
                  id: localChat.id,
                  title: localChat.title || 'New Conversation',
                  mode: localChat.mode || 'general',
                  userId,
                  createdAt: serverTimestamp(),
                  updatedAt: serverTimestamp(),
                  isPinned: Boolean(localChat.isPinned),
                  pinnedAt: localChat.isPinned ? serverTimestamp() : null
                },
                { merge: true }
              ),
              FIRESTORE_OP_TIMEOUT_MS,
              'syncCreateChatDoc'
            );
            syncedChats++;
          } else if (localChat.pendingMetaSync) {
            await withBoundedTimeout(
              updateDoc(chatDocRef, {
                title: localChat.title || existingSnap.data()?.title || 'Untitled Chat',
                mode: localChat.mode || existingSnap.data()?.mode || 'general',
                isPinned: Boolean(localChat.isPinned),
                pinnedAt: localChat.isPinned
                  ? (existingSnap.data()?.pinnedAt || serverTimestamp())
                  : null,
                updatedAt: serverTimestamp()
              }),
              FIRESTORE_OP_TIMEOUT_MS,
              'syncUpdateChatMeta'
            );
            syncedChats++;
          }

          let allMessagesSynced = true;
          for (const msg of pendingMessages) {
            try {
              const targetMsg =
                msg.sender === 'assistant' ? normalizeAssistantMessage(msg) : msg;
              const msgRef = doc(db, 'users', userId, 'chats', localChat.id, 'messages', targetMsg.id);
              const payload = buildFirestoreMessagePayload(targetMsg);
              await withBoundedTimeout(
                setDoc(msgRef, payload, { merge: true }),
                FIRESTORE_OP_TIMEOUT_MS,
                'syncMessageDoc'
              );
              upsertCachedChatMessage(userId, localChat.id, {
                ...msg,
                pendingSync: false
              });
              syncedMessages++;
            } catch (msgErr) {
              allMessagesSynced = false;
              console.warn('Deferred syncing message until next online cycle:', msg?.id, msgErr?.message || msgErr);
            }
          }

          if (pendingMessages.length > 0 && allMessagesSynced) {
            try {
              await withBoundedTimeout(
                updateDoc(chatDocRef, { updatedAt: serverTimestamp() }),
                FIRESTORE_OP_TIMEOUT_MS,
                'syncTouchUpdatedAt'
              );
            } catch (_) {}
          }

          upsertCachedUserChat(userId, {
            id: localChat.id,
            pendingSync: !allMessagesSynced,
            pendingMetaSync: false,
            createdOffline: false
          });
        } catch (chatErr) {
          console.warn('Deferred syncing conversation until next online cycle:', localChat.id, chatErr?.message || chatErr);
        }
      }
    } finally {
      activeSyncPromises.delete(userId);
    }

    return { syncedChats, syncedMessages };
  })();

  activeSyncPromises.set(userId, syncTask);
  return syncTask;
}

/**
 * Subscribes in real-time to the authenticated user's conversations list.
 * Hydrates immediately from local cache and skips WebChannel listeners while offline.
 *
 * @param {string} userId
 * @param {(chats: Array) => void} onUpdate
 * @param {(err: Error) => void} onError
 * @returns {() => void} Unsubscribe function
 */
export function subscribeToUserChats(userId, onUpdate, onError) {
  const cached = getCachedUserChats(userId);

  if (!db || !isFirebaseConfigured()) {
    onUpdate(cached);
    return () => {};
  }

  // Emit cached conversations immediately so offline/slow startups never show an empty or stuck sidebar
  if (cached.length > 0) {
    onUpdate(cached);
  }

  if (!isBrowserOnline()) {
    if (cached.length === 0) {
      onUpdate([]);
    }
    return () => {};
  }

  const chatsRef = collection(db, 'users', userId, 'chats');
  const q = query(chatsRef, orderBy('updatedAt', 'desc'));

  return onSnapshot(
    q,
    (snapshot) => {
      const cloudChats = [];
      snapshot.forEach((docSnap) => {
        const data = docSnap.data();
        let formattedDate = 'Recently';
        if (data.updatedAt?.toDate) {
          formattedDate = data.updatedAt.toDate().toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric'
          });
        }
        cloudChats.push({
          id: docSnap.id,
          title: data.title || 'Untitled Chat',
          mode: data.mode || 'general',
          timestamp: formattedDate,
          rawUpdatedAt: data.updatedAt?.toMillis ? data.updatedAt.toMillis() : Date.now(),
          isPinned: Boolean(data.isPinned),
          pinnedAt: data.pinnedAt?.toMillis ? data.pinnedAt.toMillis() : (data.pinnedAt || null)
        });
      });

      const merged = mergeCloudAndLocalChats(userId, cloudChats);
      onUpdate(merged);
    },
    (err) => {
      if (isOfflineOrNetworkError(err)) {
        onUpdate(getCachedUserChats(userId));
        return;
      }
      console.error('Error fetching user chats:', err);
      if (onError) onError(err);
    }
  );
}

/**
 * Loads all messages for a specific conversation, ordered chronologically.
 * Falls back cleanly to user-scoped local cache when offline, and merges any unsynced local messages when online.
 *
 * @param {string} userId
 * @param {string} chatId
 * @returns {Promise<Array>}
 */
export async function loadConversationMessages(userId, chatId) {
  const localMessages = getCachedChatMessages(userId, chatId);

  if (!db || !isFirebaseConfigured() || !isBrowserOnline()) {
    return orderConversationMessages(ensureConversationAlternatives(localMessages));
  }

  const messagesRef = collection(db, 'users', userId, 'chats', chatId, 'messages');
  const q = query(messagesRef, orderBy('createdAt', 'asc'));

  try {
    const snapshot = await withBoundedTimeout(getDocs(q), FIRESTORE_OP_TIMEOUT_MS, 'loadConversationMessages');
    const cloudMessages = [];

    snapshot.forEach((docSnap) => {
      const data = docSnap.data();
      cloudMessages.push({
        id: docSnap.id,
        sender: data.sender,
        content: data.content,
        modelUsed: data.modelUsed || null,
        provider: data.provider || null,
        responseTimeMs: typeof data.responseTimeMs === 'number' ? data.responseTimeMs : null,
        parentMessageId: data.parentMessageId || null,
        interactionId: data.interactionId || null,
        activeAlternativeId: data.activeAlternativeId || null,
        alternatives: Array.isArray(data.alternatives) ? data.alternatives : [],
        attachments: Array.isArray(data.attachments) ? data.attachments : [],
        referencedAttachments: Array.isArray(data.referencedAttachments) ? data.referencedAttachments : [],
        createdAtMs: typeof data.createdAtMs === 'number' ? data.createdAtMs : (data.createdAt?.toMillis ? data.createdAt.toMillis() : undefined),
        timestamp:
          data.clientTimestamp ||
          (data.createdAt?.toDate
            ? data.createdAt.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            : ''),
        pendingSync: false
      });
    });

    // Merge cloud messages with any unsynced local messages by deterministic message ID (zero duplicates)
    const byId = new Map();
    for (const cm of cloudMessages) {
      byId.set(cm.id, cm);
    }
    for (const lm of localMessages) {
      if (!lm?.id) continue;
      if (!byId.has(lm.id)) {
        if (lm.pendingSync || cloudMessages.length === 0) {
          byId.set(lm.id, lm);
        }
      } else if (lm.pendingSync) {
        // Prefer locally updated version until sync completes
        byId.set(lm.id, lm);
      }
    }

    const merged = Array.from(byId.values());
    const normalized = orderConversationMessages(ensureConversationAlternatives(merged));
    saveCachedChatMessages(userId, chatId, normalized);
    return normalized;
  } catch (err) {
    if (isOfflineOrNetworkError(err)) {
      console.warn('Offline fallback: loaded conversation messages from local cache:', chatId);
      return orderConversationMessages(ensureConversationAlternatives(localMessages));
    }
    throw err;
  }
}
