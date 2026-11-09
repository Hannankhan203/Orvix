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
import {
  deleteAttachmentsForConversation,
  deleteAttachmentRecords,
  fetchWithAuth
} from './attachmentStorageService.js';
import { getIdToken, getAuthUserId, onAuthChange } from './authService.js';

const FIRESTORE_OP_TIMEOUT_MS = 4500;
const MAX_DELETION_RETRIES = 5;
const BASE_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 30000;
const activeSyncPromises = new Map();
const activeDeletionPromises = new Map();
const activeReplayPromises = new Map();
const activeAttachmentDeletionPromises = new Map();
const activeAttachmentReplayPromises = new Map();

let testDbOverride = null;

/**
 * Sets a test Firestore database instance for test verification suites.
 * @param {Object|null} mockDb
 */
export function setFirestoreInstanceForTesting(mockDb) {
  testDbOverride = mockDb;
}

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

/**
 * Normalizes a queue item to a consistent pending deletion entry object.
 * @param {string|Object} item
 * @param {string} userId
 * @returns {Object}
 */
function normalizeDeletionQueueEntry(item, userId) {
  if (typeof item === 'string') {
    return {
      chatId: item,
      userId,
      attempts: 0,
      lastAttemptMs: 0,
      nextRetryMs: 0,
      storageDeleted: false,
      firestoreDeleted: false,
      error: null
    };
  }
  return {
    chatId: item.chatId,
    userId: item.userId || userId,
    attempts: typeof item.attempts === 'number' ? item.attempts : 0,
    lastAttemptMs: typeof item.lastAttemptMs === 'number' ? item.lastAttemptMs : 0,
    nextRetryMs: typeof item.nextRetryMs === 'number' ? item.nextRetryMs : 0,
    storageDeleted: Boolean(item.storageDeleted),
    firestoreDeleted: Boolean(item.firestoreDeleted),
    error: item.error || null
  };
}

/**
 * Returns the durable queue of pending deletion entries for a user.
 * @param {string} userId
 * @returns {Array<Object>}
 */
export function getPendingDeletedQueue(userId) {
  if (!userId || typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(getUserDeletedChatsKey(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => (typeof item === 'string' && item.trim().length > 0) || (item && typeof item.chatId === 'string' && item.chatId.trim().length > 0))
      .map((item) => normalizeDeletionQueueEntry(item, userId));
  } catch (_) {
    return [];
  }
}

/**
 * Durably saves the pending deletion queue to localStorage.
 * @param {string} userId
 * @param {Array<Object>} queue
 */
export function savePendingDeletedQueue(userId, queue) {
  if (!userId || typeof window === 'undefined') return;
  try {
    if (!Array.isArray(queue) || queue.length === 0) {
      localStorage.removeItem(getUserDeletedChatsKey(userId));
      return;
    }
    const seen = new Map();
    for (const entry of queue) {
      if (entry?.chatId) {
        seen.set(entry.chatId, entry);
      }
    }
    localStorage.setItem(getUserDeletedChatsKey(userId), JSON.stringify(Array.from(seen.values())));
  } catch (_) {}
}

/**
 * Returns array of pending deleted chat IDs (preserves existing API contract).
 * @param {string} userId
 * @returns {string[]}
 */
export function getPendingDeletedChatIds(userId) {
  const queue = getPendingDeletedQueue(userId);
  return Array.from(new Set(queue.map((e) => e.chatId)));
}

/**
 * Saves array of pending deleted chat IDs or entries (preserves existing API contract).
 * @param {string} userId
 * @param {Array<string|Object>} idsOrEntries
 */
export function savePendingDeletedChatIds(userId, idsOrEntries) {
  if (!userId || typeof window === 'undefined') return;
  if (!Array.isArray(idsOrEntries)) {
    savePendingDeletedQueue(userId, []);
    return;
  }
  const currentQueue = getPendingDeletedQueue(userId);
  const currentMap = new Map(currentQueue.map((e) => [e.chatId, e]));

  const nextQueue = idsOrEntries.map((item) => {
    if (typeof item === 'string') {
      return currentMap.get(item) || normalizeDeletionQueueEntry(item, userId);
    }
    return normalizeDeletionQueueEntry(item, userId);
  });

  savePendingDeletedQueue(userId, nextQueue);
}

/**
 * Adds or updates a chat in the durable deletion queue with exponential backoff.
 * @param {string} userId
 * @param {string} chatId
 * @param {Object} [patch={}]
 */
export function enqueuePendingDeletion(userId, chatId, patch = {}) {
  if (!userId || !chatId || typeof window === 'undefined') return;
  const queue = getPendingDeletedQueue(userId);
  const existingIndex = queue.findIndex((e) => e.chatId === chatId);
  const existing = existingIndex >= 0 ? queue[existingIndex] : null;

  const now = Date.now();
  const currentAttempts = existing ? (existing.attempts || 0) : 0;
  const newAttempts = patch.attempts !== undefined ? patch.attempts : currentAttempts + 1;
  const backoffDelay = Math.min(
    BASE_RETRY_DELAY_MS * Math.pow(2, Math.max(0, newAttempts - 1)),
    MAX_RETRY_DELAY_MS
  );

  const updatedEntry = {
    chatId,
    userId,
    attempts: newAttempts,
    lastAttemptMs: now,
    nextRetryMs: patch.nextRetryMs !== undefined ? patch.nextRetryMs : now + backoffDelay,
    storageDeleted: patch.storageDeleted !== undefined ? Boolean(patch.storageDeleted) : Boolean(existing?.storageDeleted),
    firestoreDeleted: patch.firestoreDeleted !== undefined ? Boolean(patch.firestoreDeleted) : Boolean(existing?.firestoreDeleted),
    error: patch.error !== undefined ? patch.error : (existing?.error || null)
  };

  let nextQueue;
  if (existingIndex >= 0) {
    nextQueue = queue.map((e, idx) => (idx === existingIndex ? updatedEntry : e));
  } else {
    nextQueue = [...queue, updatedEntry];
  }

  savePendingDeletedQueue(userId, nextQueue);
}

/**
 * Removes a chat from the durable deletion queue.
 * @param {string} userId
 * @param {string} chatId
 */
export function removePendingDeletion(userId, chatId) {
  if (!userId || !chatId || typeof window === 'undefined') return;
  const queue = getPendingDeletedQueue(userId);
  const nextQueue = queue.filter((e) => e.chatId !== chatId);
  savePendingDeletedQueue(userId, nextQueue);
}

// --- Orphaned Attachment Deletion Durable Queue ---

/**
 * Returns pending orphaned attachment deletion queue for a given user.
 * Reads both user-scoped key and fallback global key.
 * @param {string} userId
 * @returns {Array<{ attachmentId: string, chatId: string, userId: string, attempts: number, lastAttemptMs: number, nextRetryMs: number, error?: string|null, status?: number|null }>}
 */
export function getPendingOrphanedAttachmentDeletions(userId) {
  if (!userId || userId === 'guest' || typeof window === 'undefined') return [];
  try {
    const userKey = `pendingOrphanedAttachmentDeletions_${userId}`;
    const rawUser = localStorage.getItem(userKey);
    if (rawUser) {
      const parsed = JSON.parse(rawUser);
      if (Array.isArray(parsed)) {
        return parsed.filter((e) => e && e.attachmentId && (!e.userId || e.userId === userId));
      }
    }

    const rawGlobal = localStorage.getItem('pendingOrphanedAttachmentDeletions');
    if (rawGlobal) {
      const parsed = JSON.parse(rawGlobal);
      if (Array.isArray(parsed)) {
        return parsed.filter((e) => e && e.attachmentId && e.userId === userId);
      }
    }

    return [];
  } catch (_) {
    return [];
  }
}

/**
 * Saves pending orphaned attachment deletions for a user to localStorage,
 * updating both per-user and global keys while deduplicating by attachmentId.
 * @param {string} userId
 * @param {Array<Object>} queue
 */
export function savePendingOrphanedAttachmentDeletions(userId, queue) {
  if (!userId || userId === 'guest' || typeof window === 'undefined') return;
  try {
    const seen = new Map();
    if (Array.isArray(queue)) {
      for (const entry of queue) {
        if (entry?.attachmentId) {
          seen.set(entry.attachmentId, {
            ...entry,
            userId: entry.userId || userId
          });
        }
      }
    }
    const userEntries = Array.from(seen.values());

    const userKey = `pendingOrphanedAttachmentDeletions_${userId}`;
    if (userEntries.length === 0) {
      localStorage.removeItem(userKey);
    } else {
      localStorage.setItem(userKey, JSON.stringify(userEntries));
    }

    const globalKey = 'pendingOrphanedAttachmentDeletions';
    let globalQueue = [];
    try {
      const rawGlobal = localStorage.getItem(globalKey);
      if (rawGlobal) {
        const parsed = JSON.parse(rawGlobal);
        if (Array.isArray(parsed)) {
          globalQueue = parsed.filter((e) => e && e.userId !== userId && e.attachmentId);
        }
      }
    } catch (_) {}

    const combined = [...globalQueue, ...userEntries];
    if (combined.length === 0) {
      localStorage.removeItem(globalKey);
    } else {
      localStorage.setItem(globalKey, JSON.stringify(combined));
    }
  } catch (_) {}
}

/**
 * Enqueues a failed orphaned attachment deletion with exponential backoff and deduplication.
 * @param {string} userId
 * @param {string} chatId
 * @param {string} attachmentId
 * @param {Object} [patch={}]
 */
export function enqueuePendingOrphanedAttachmentDeletion(userId, chatId, attachmentId, patch = {}) {
  if (!userId || userId === 'guest' || !attachmentId || typeof window === 'undefined') return;

  const queue = getPendingOrphanedAttachmentDeletions(userId);
  const existingIndex = queue.findIndex((e) => e.attachmentId === attachmentId);
  const existing = existingIndex >= 0 ? queue[existingIndex] : null;

  const now = Date.now();
  const currentAttempts = existing ? (existing.attempts || 0) : 0;
  const newAttempts = patch.attempts !== undefined ? patch.attempts : currentAttempts + 1;
  const backoffDelay = Math.min(
    BASE_RETRY_DELAY_MS * Math.pow(2, Math.max(0, newAttempts - 1)),
    MAX_RETRY_DELAY_MS
  );

  const updatedEntry = {
    attachmentId,
    chatId: chatId || existing?.chatId || '',
    userId,
    attempts: newAttempts,
    lastAttemptMs: now,
    nextRetryMs: patch.nextRetryMs !== undefined ? patch.nextRetryMs : now + backoffDelay,
    error: patch.error !== undefined ? patch.error : (existing?.error || null),
    status: patch.status !== undefined ? patch.status : (existing?.status || null)
  };

  let nextQueue;
  if (existingIndex >= 0) {
    nextQueue = queue.map((e, idx) => (idx === existingIndex ? updatedEntry : e));
  } else {
    nextQueue = [...queue, updatedEntry];
  }

  savePendingOrphanedAttachmentDeletions(userId, nextQueue);
}

/**
 * Removes a successfully deleted attachment from the durable queue.
 * @param {string} userId
 * @param {string} attachmentId
 */
export function removePendingOrphanedAttachmentDeletion(userId, attachmentId) {
  if (!userId || userId === 'guest' || !attachmentId || typeof window === 'undefined') return;
  const queue = getPendingOrphanedAttachmentDeletions(userId);
  const nextQueue = queue.filter((e) => e.attachmentId !== attachmentId);
  savePendingOrphanedAttachmentDeletions(userId, nextQueue);
}

/**
 * Replays pending orphaned attachment deletions for a given user using exponential backoff.
 * Retains entries that still fail, prevents duplicate concurrent replays, and enforces user isolation.
 * @param {string} userId
 * @param {Object} [options={}]
 * @param {boolean} [options.force=false]
 * @returns {Promise<{ replayed: number, remaining: number }>}
 */
export async function replayPendingOrphanedAttachmentDeletions(userId, options = {}) {
  const { force = false } = options;
  if (!userId || userId === 'guest' || typeof window === 'undefined') {
    return { replayed: 0, remaining: 0 };
  }

  if (activeAttachmentReplayPromises.has(userId)) {
    return activeAttachmentReplayPromises.get(userId);
  }

  const replayTask = (async () => {
    if (!isBrowserOnline()) {
      return { replayed: 0, remaining: getPendingOrphanedAttachmentDeletions(userId).length };
    }

    const token = await getIdToken().catch(() => null);
    if (!token) {
      return { replayed: 0, remaining: getPendingOrphanedAttachmentDeletions(userId).length };
    }

    const queue = getPendingOrphanedAttachmentDeletions(userId);
    if (!queue || queue.length === 0) {
      return { replayed: 0, remaining: 0 };
    }

    const now = Date.now();
    let replayedCount = 0;

    for (const entry of queue) {
      if (!isBrowserOnline()) break;
      if (!entry?.attachmentId || !entry?.chatId) continue;
      // Cross-account isolation: strictly process entries matching this userId
      if (entry.userId && entry.userId !== userId) continue;

      const opKey = `${userId}:${entry.chatId}:${entry.attachmentId}`;
      if (activeAttachmentDeletionPromises.has(opKey)) {
        continue;
      }

      // Check exponential backoff window unless forced
      if (!force && entry.nextRetryMs && now < entry.nextRetryMs) {
        continue;
      }

      try {
        const res = await cleanUpSingleAttachmentStorage(entry.attachmentId, entry.chatId, userId);
        if (res.success) {
          removePendingOrphanedAttachmentDeletion(userId, entry.attachmentId);
          replayedCount++;
        } else {
          // Retain entries that still fail, updating attempts and next retry timestamp
          enqueuePendingOrphanedAttachmentDeletion(userId, entry.chatId, entry.attachmentId, {
            attempts: (entry.attempts || 0) + 1,
            error: res.error || 'Retry failed',
            status: res.status
          });
        }
      } catch (err) {
        enqueuePendingOrphanedAttachmentDeletion(userId, entry.chatId, entry.attachmentId, {
          attempts: (entry.attempts || 0) + 1,
          error: err?.message || 'Exception during replay'
        });
      }
    }

    const finalQueue = getPendingOrphanedAttachmentDeletions(userId);
    return { replayed: replayedCount, remaining: finalQueue.length };
  })();

  activeAttachmentReplayPromises.set(userId, replayTask);
  try {
    return await replayTask;
  } finally {
    activeAttachmentReplayPromises.delete(userId);
  }
}

export function upsertCachedUserChat(userId, chatPatch) {
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

export function buildFirestoreMessagePayload(targetMessage) {
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

function cleanTitleText(str) {
  if (!str) return '';
  return str
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^[\s#*`>"'\-–—:•]+/, '')
    .replace(/[#*`>"'\r\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const PRESERVED_ACRONYMS = {
  api: 'API',
  apis: 'APIs',
  sql: 'SQL',
  pto: 'PTO',
  json: 'JSON',
  csv: 'CSV',
  html: 'HTML',
  css: 'CSS',
  ui: 'UI',
  ux: 'UX',
  id: 'ID',
  ids: 'IDs',
  url: 'URL',
  urls: 'URLs',
  http: 'HTTP',
  https: 'HTTPS',
  rest: 'REST',
  sdk: 'SDK',
  ai: 'AI',
  llm: 'LLM',
  devops: 'DevOps',
  react: 'React',
  vue: 'Vue',
  python: 'Python',
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  docker: 'Docker',
  kubernetes: 'Kubernetes',
  postgres: 'PostgreSQL',
  postgresql: 'PostgreSQL',
  mongodb: 'MongoDB',
  sqlite: 'SQLite',
  github: 'GitHub',
  typeerror: 'TypeError',
  beautifulsoup: 'BeautifulSoup'
};

function toTitleCase(str) {
  const minorWords = new Set([
    'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'nor', 'of', 'on', 'or', 'so', 'the', 'to', 'up', 'yet', 'with'
  ]);

  return str
    .split(' ')
    .filter(Boolean)
    .map((rawWord, idx, arr) => {
      const cleanWord = rawWord.replace(/^[^\w]+|[^\w]+$/g, '').toLowerCase();
      if (PRESERVED_ACRONYMS[cleanWord]) {
        const replacement = PRESERVED_ACRONYMS[cleanWord];
        return rawWord.replace(new RegExp(cleanWord, 'i'), replacement);
      }

      if (/^[A-Z0-9_\-\.]+$/.test(rawWord) && rawWord.length > 1) {
        return rawWord;
      }

      const lower = rawWord.toLowerCase();
      if (idx > 0 && idx < arr.length - 1 && minorWords.has(lower)) {
        return lower;
      }
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');
}

function truncateToWords(text, minWords = 3, maxWords = 6) {
  const words = text
    .replace(/[.,:;!?]+$/g, '')
    .split(/\s+/)
    .filter(Boolean);

  if (words.length <= maxWords) {
    return words.join(' ');
  }

  let slice = words.slice(0, maxWords);
  const trailingHanging = new Set([
    'and', 'or', 'the', 'a', 'an', 'of', 'for', 'in', 'with', 'to', 'by', 'at', 'on', 'from', 'about', 'that', 'which', 'who'
  ]);
  while (slice.length > minWords && trailingHanging.has(slice[slice.length - 1].toLowerCase().replace(/[^\w]/g, ''))) {
    slice.pop();
  }
  return slice.join(' ');
}

/**
 * Generates a concise, descriptive conversation title (ideally 3–6 words)
 * using the completed AI response and the initial user prompt.
 * Operates purely locally and synchronously without any additional model call or network request.
 *
 * @param {string} promptText - User's first prompt text
 * @param {string} [aiResponseText=''] - Completed AI response text
 * @returns {string}
 */
export function generateMeaningfulChatTitle(promptText, aiResponseText = '') {
  const cleanPrompt = cleanTitleText(promptText);
  const cleanAi = cleanTitleText(aiResponseText);

  // Conversational prompts
  if (/^(?:hello|hi|hey|good (?:morning|afternoon|evening)|greetings|howdy)(?:\s+(?:there|friend|everyone|bot|assistant))?[\s!.]*$/i.test(cleanPrompt)) {
    return 'New Conversation';
  }

  // 1. Check for email Subject: line in AI response
  if (aiResponseText) {
    const subjectMatch = aiResponseText.match(/^(?:Subject:\s*)([^\n\r]{3,60})/im);
    if (subjectMatch) {
      const subject = cleanTitleText(subjectMatch[1])
        .replace(/^re:\s*/i, '')
        .replace(/[–—\-]\s*/g, ' ')
        .trim();
      const words = subject.split(/\s+/).filter(Boolean);
      if (words.length >= 2) {
        return toTitleCase(truncateToWords(subject, 3, 6));
      }
    }

    // 2. Check for markdown headings in AI response (e.g. # Title, ## Subtitle)
    const headingMatch = aiResponseText.match(/^(?:#{1,3}\s+)([^\n\r#]{3,70})/m);
    if (headingMatch) {
      let heading = cleanTitleText(headingMatch[1]);
      const lowerHeading = heading.toLowerCase();
      const genericWords = ['introduction', 'summary', 'overview', 'solution', 'steps', 'step 1', 'guide', 'here is'];
      const isGeneric = genericWords.some((g) => lowerHeading === g || lowerHeading.startsWith(`${g}:`));
      if (!isGeneric) {
        const words = heading.split(/\s+/).filter(Boolean);
        if (words.length >= 2 && words.length <= 10) {
          return toTitleCase(truncateToWords(heading, 3, 6));
        }
      }
    }

    // 3. Check for bold title header at the very beginning: **Title**
    const boldHeaderMatch = aiResponseText.match(/^\*\*([A-Za-z0-9\s\-_:]{4,50})\*\*/m);
    if (boldHeaderMatch) {
      const boldCandidate = cleanTitleText(boldHeaderMatch[1]);
      const lowerBold = boldCandidate.toLowerCase();
      if (!lowerBold.includes('note:') && !lowerBold.includes('warning:') && !lowerBold.includes('tip:')) {
        const words = boldCandidate.split(/\s+/).filter(Boolean);
        if (words.length >= 2 && words.length <= 8) {
          return toTitleCase(truncateToWords(boldCandidate, 3, 6));
        }
      }
    }

    // 4. Check for introductory list/idea phrasing:
    // "Here are 5 catchy slogans for Aqualux..."
    // "Here are three outstanding science fiction books..."
    const listIntroMatch = aiResponseText.match(
      /^(?:here (?:is|are)\s+(?:a\s+|an\s+|the\s+|some\s+|\d+\s+)?(?:catchy\s+|creative\s+|great\s+|top\s+|outstanding\s+|simple\s+|recommended\s+)?)([^:\n.?!]{4,60})/i
    );
    if (listIntroMatch) {
      let topic = cleanTitleText(listIntroMatch[1])
        .replace(/^(?:list of\s+)/i, '')
        .replace(/\b(?:that explore|which explore|to read|to check out|you might like)\b.*$/i, '')
        .trim();
      const words = topic.split(/\s+/).filter(Boolean);
      if (words.length >= 2 && words.length <= 8) {
        return toTitleCase(truncateToWords(topic, 3, 6));
      }
    }

    // 5. Check for definition/explanation pattern in AI response:
    // "[Subject] is the process by which..." or "[Subject] are lightweight packages..."
    const defMatch = aiResponseText.match(/^([A-Z][a-zA-Z0-9_\-\s]{2,35})\s+(?:is|are)\s+(?:a|an|the|lightweight|defined|designed|used|essentially|often|primarily)/i);
    if (defMatch) {
      const subject = cleanTitleText(defMatch[1]);
      const words = subject.split(/\s+/).filter(Boolean);
      if (words.length >= 1 && words.length <= 4) {
        // Look for domain/context in prompt
        if (/\bdevops\b/i.test(cleanPrompt)) {
          return toTitleCase(`${subject} in DevOps`);
        }
        const plantOrBio = cleanPrompt.match(/\b(?:in|for)\s+(plants|biology|python|react|javascript|node)\b/i);
        if (plantOrBio) {
          return toTitleCase(`${subject} in ${toTitleCase(plantOrBio[1])}`);
        }
        if (/how|why|explain|work|understand/i.test(cleanPrompt)) {
          return toTitleCase(`${subject} Explained`);
        }
        return toTitleCase(truncateToWords(`${subject} Overview`, 3, 5));
      }
    }
  }

  // 6. Synthesize topic from prompt intent
  let promptSubject = cleanPrompt
    // Strip conversational lead-ins
    .replace(/^(?:can you (?:please )?(?:help me (?:with |to )?|explain (?:to me )?|write (?:me )?|show me |tell me |give me |suggest |recommend )?)/i, '')
    .replace(/^(?:could you (?:please )?(?:help me |explain |write |show me |tell me )?)/i, '')
    .replace(/^(?:how (?:do i|can i|does|to|would i)\s+)/i, '')
    .replace(/^(?:what (?:is|are) (?:the |a )?)/i, '')
    .replace(/^(?:i (?:need|want) (?:to )?(?:know |create |build |write |a |some )?)/i, '')
    .replace(/^(?:please )/i, '')
    .replace(/^(?:debug(?:ging)? (?:a |an |the )?)/i, 'Fixing ')
    .replace(/[?!.]+$/g, '')
    .trim();

  // Handle programming/error patterns
  if (/^Fixing\s+TypeError/i.test(promptSubject)) {
    const errorProp = promptSubject.match(/reading\s+(\w+)/i);
    const framework = promptSubject.match(/(?:in|with)\s+(\w+)/i);
    if (errorProp && framework) {
      return toTitleCase(`Fixing ${framework[1]} TypeError ${errorProp[1]}`);
    }
  }

  // Handle email/letter prompts
  const emailMatch = cleanPrompt.match(/(?:email|letter|message)\s+(?:to\s+[a-z\s]+?\s+)?(?:requesting|asking for|about)\s+([^.?!]+)/i);
  if (emailMatch) {
    return toTitleCase(truncateToWords(`Requesting ${emailMatch[1]}`, 3, 6));
  }

  if (promptSubject) {
    const words = promptSubject.split(/\s+/).filter(Boolean);
    if (words.length <= 2) {
      if (/script|code|program/i.test(cleanPrompt)) {
        promptSubject = `${promptSubject} Script`;
      } else {
        promptSubject = `${promptSubject} Overview`;
      }
    }
    return toTitleCase(truncateToWords(promptSubject, 3, 6));
  }

  return 'New Conversation';
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
 * @param {Object} [extraMetadata={}] - Optional metadata or settings
 * @param {string} [targetChatId=null] - Optional pre-generated chatId to reuse
 * @returns {Promise<string>} The generated or reused chatId
 */
export async function createChatDocument(
  userId,
  initialTitle = 'New Conversation',
  mode = 'general',
  extraMetadata = {},
  targetChatId = null
) {
  if (!userId) {
    throw new Error('Valid userId is required to create a conversation.');
  }

  const nowMs = Date.now();
  // Support pre-generated conversation ID passed directly as 5th argument, or in extraMetadata.chatId,
  // or as 4th argument if extraMetadata is a string. If not provided, generate a new valid ID.
  const resolvedChatId =
    targetChatId ||
    (typeof extraMetadata === 'string' ? extraMetadata : extraMetadata?.chatId) ||
    generateLocalChatId(userId);

  const cleanMode = mode || 'general';
  const metaObj = extraMetadata && typeof extraMetadata === 'object' ? extraMetadata : {};

  // Always record locally first so offline mode or interrupted connections never lose the chat
  upsertCachedUserChat(userId, {
    id: resolvedChatId,
    title: initialTitle,
    mode: cleanMode,
    timestamp: 'Just now',
    rawUpdatedAt: nowMs,
    createdAtMs: nowMs,
    isPinned: false,
    pinnedAt: null,
    isImported: Boolean(metaObj.isImported),
    importedFromShareId: metaObj.importedFromShareId || null,
    pendingSync: true,
    createdOffline: !isBrowserOnline()
  });

  if (!db || !isFirebaseConfigured() || !isBrowserOnline()) {
    return resolvedChatId;
  }

  const newChatDoc = doc(db, 'users', userId, 'chats', resolvedChatId);
  const chatData = {
    id: resolvedChatId,
    title: initialTitle,
    mode: cleanMode,
    userId,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    isPinned: false,
    pinnedAt: null,
    ...(metaObj.isImported ? { isImported: true } : {}),
    ...(metaObj.importedFromShareId ? { importedFromShareId: metaObj.importedFromShareId } : {})
  };

  try {
    await withBoundedTimeout(setDoc(newChatDoc, chatData), FIRESTORE_OP_TIMEOUT_MS, 'createChatDocument');
    upsertCachedUserChat(userId, {
      id: resolvedChatId,
      pendingSync: false,
      createdOffline: false
    });
  } catch (err) {
    if (isOfflineOrNetworkError(err)) {
      console.warn('Offline/network fallback: created conversation locally for later sync:', resolvedChatId);
      return resolvedChatId;
    }
    throw err;
  }

  return resolvedChatId;
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
 * @param {boolean} [isManual=false] - Whether this rename was manually triggered by the user
 */
export async function renameConversation(userId, chatId, newTitle, isManual = false) {
  const sanitized = (newTitle || '').trim();
  if (!sanitized) {
    throw new Error('Conversation title cannot be empty.');
  }

  const metaUpdate = {
    id: chatId,
    title: sanitized,
    rawUpdatedAt: Date.now(),
    pendingMetaSync: !isBrowserOnline(),
    ...(isManual ? { hasCustomTitle: true } : {})
  };

  if (userId && chatId) {
    upsertCachedUserChat(userId, metaUpdate);
  }

  if (!db || !isFirebaseConfigured() || !isBrowserOnline()) {
    return;
  }

  try {
    const chatDocRef = doc(db, 'users', userId, 'chats', chatId);
    await withBoundedTimeout(
      updateDoc(chatDocRef, {
        title: sanitized,
        updatedAt: serverTimestamp(),
        ...(isManual ? { hasCustomTitle: true } : {})
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
  const targetChat = cachedChats.find((c) => c.id === chatId);
  const targetPinnedState = typeof isPinned === 'boolean' ? isPinned : !targetChat?.isPinned;

  if (targetPinnedState) {
    const localPinnedCount = cachedChats.filter((c) => c.isPinned && c.id !== chatId).length;
    if (localPinnedCount >= 5) {
      throw new Error('You can pin up to 5 chats. Unpin a chat before pinning another.');
    }
  }

  const nowMs = Date.now();

  if (!db || !isFirebaseConfigured() || !isBrowserOnline()) {
    upsertCachedUserChat(userId, {
      id: chatId,
      isPinned: Boolean(targetPinnedState),
      pinnedAt: targetPinnedState ? nowMs : null,
      rawUpdatedAt: nowMs,
      pendingMetaSync: true
    });
    return Boolean(targetPinnedState);
  }

  const chatDocRef = doc(db, 'users', userId, 'chats', chatId);

  try {
    if (targetPinnedState) {
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
 * Calls the authenticated DELETE /api/upload/conversations/:chatId endpoint
 * to clean up Supabase storage attachments for the conversation.
 * Uses existing Firebase authentication to obtain a valid ID token.
 * Never exposes Supabase credentials.
 *
 * @param {string} chatId
 * @returns {Promise<{ success: boolean, status?: number, code?: string, retryable?: boolean, error?: string, deletedCount?: number }>}
 */
export async function cleanUpSupabaseConversationStorage(chatId) {
  if (!chatId) {
    return { success: false, retryable: false, error: 'Chat ID required' };
  }

  if (!isBrowserOnline()) {
    return {
      success: false,
      status: 0,
      code: 'OFFLINE',
      retryable: true,
      offline: true,
      error: 'Browser is offline.'
    };
  }

  try {
    const token = await getIdToken().catch(() => null);
    if (!token) {
      return {
        success: false,
        status: 401,
        code: 'AUTH_REQUIRED',
        retryable: true,
        error: 'Authentication required to delete conversation attachments.'
      };
    }

    const res = await fetchWithAuth(`/api/upload/conversations/${encodeURIComponent(chatId)}`, {
      method: 'DELETE'
    });

    if (res.ok || res.status === 404) {
      const data = await res.json().catch(() => ({}));
      return {
        success: true,
        status: res.status,
        deletedCount: typeof data?.deletedCount === 'number' ? data.deletedCount : 0
      };
    }

    if (res.status === 401) {
      return {
        success: false,
        status: 401,
        code: 'UNAUTHORIZED',
        retryable: true,
        error: 'Authentication failed or token expired.'
      };
    }

    if (res.status === 403) {
      return {
        success: false,
        status: 403,
        code: 'STORAGE_ACCESS_DENIED',
        retryable: false,
        error: 'Access denied: You do not have permission to delete these attachments.'
      };
    }

    const is5xx = res.status >= 500;
    let errMsg = `HTTP ${res.status}`;
    try {
      const errData = await res.json().catch(() => null);
      if (errData?.error) errMsg = errData.error;
    } catch (_) {}

    return {
      success: false,
      status: res.status,
      code: is5xx ? 'SERVER_ERROR' : 'DELETE_FAILED',
      retryable: is5xx,
      error: errMsg
    };
  } catch (err) {
    const isTimeout = err?.name === 'AbortError' || String(err?.message || '').toLowerCase().includes('timeout');
    return {
      success: false,
      status: isTimeout ? 408 : 0,
      code: isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR',
      retryable: true,
      error: isTimeout
        ? 'Storage deletion request timed out.'
        : (err?.message || 'Network error during storage deletion.')
    };
  }
}

/**
 * Replays all queued conversation deletions for a user using bounded retries
 * and exponential backoff, preventing duplicate concurrent runs.
 *
 * @param {string} userId
 * @param {Object} [options={}]
 * @param {boolean} [options.force=false] - Force retry ignoring nextRetryMs backoff window
 * @returns {Promise<{ replayed: number, remaining: number }>}
 */
export async function replayPendingDeletions(userId, options = {}) {
  const { force = false } = options;
  if (!userId || typeof window === 'undefined') {
    return { replayed: 0, remaining: 0 };
  }

  // Prevent duplicate concurrent replay runs for the same user
  if (activeReplayPromises.has(userId)) {
    return activeReplayPromises.get(userId);
  }

  const replayTask = (async () => {
    if (!isBrowserOnline()) {
      return { replayed: 0, remaining: getPendingDeletedQueue(userId).length };
    }

    const queue = getPendingDeletedQueue(userId);
    if (!queue || queue.length === 0) {
      return { replayed: 0, remaining: 0 };
    }

    const now = Date.now();
    let replayedCount = 0;

    for (const entry of queue) {
      if (!isBrowserOnline()) break;
      const chatId = entry.chatId;

      // Skip if this specific chat deletion is currently in-flight
      const opKey = `${userId}:${chatId}`;
      if (activeDeletionPromises.has(opKey)) {
        continue;
      }

      // Check bounded retries: drop if exceeded maximum attempts
      if ((entry.attempts || 0) >= MAX_DELETION_RETRIES && !force) {
        console.warn(`[Chat Storage] Max deletion retries (${MAX_DELETION_RETRIES}) exceeded for chat ${chatId}. Discarding from queue.`);
        removePendingDeletion(userId, chatId);
        continue;
      }

      // Check exponential backoff window
      if (!force && entry.nextRetryMs && now < entry.nextRetryMs) {
        continue;
      }

      try {
        await deleteConversation(userId, chatId);
        replayedCount++;
      } catch (err) {
        console.warn(`[Chat Storage] Failed to replay deletion for chat ${chatId}:`, err?.message || err);
      }
    }

    // Also replay any pending orphaned attachment deletions for this user
    try {
      await replayPendingOrphanedAttachmentDeletions(userId, options);
    } catch (err) {
      console.warn('[Chat Storage] Failed to replay orphaned attachment deletions:', err?.message || err);
    }

    const finalQueue = getPendingDeletedQueue(userId);
    return { replayed: replayedCount, remaining: finalQueue.length };
  })();

  activeReplayPromises.set(userId, replayTask);
  try {
    return await replayTask;
  } finally {
    activeReplayPromises.delete(userId);
  }
}

/**
 * Deletes a conversation following the safe order:
 * 1. Supabase Storage cleanup via DELETE /api/upload/conversations/:chatId
 * 2. Local cache cleanup (IndexedDB blobs and localStorage)
 * 3. Cloud Firestore deletion (messages subcollection and parent chat doc)
 *
 * If Supabase cleanup fails (offline, 5xx, timeout), the deletion is durably queued
 * with bounded retries and exponential backoff, without permanently losing the request.
 *
 * @param {string} userId - Authenticated user UID (or 'guest')
 * @param {string} chatId - Chat document ID
 */
export async function deleteConversation(userId, chatId) {
  if (!userId || !chatId) {
    throw new Error('Valid userId and chatId are required.');
  }

  const opKey = `${userId}:${chatId}`;
  if (activeDeletionPromises.has(opKey)) {
    return activeDeletionPromises.get(opKey);
  }

  const deletionTask = (async () => {
    // 0. Inspect current pending queue entry (if replaying or previously failed)
    const queue = getPendingDeletedQueue(userId);
    const existingEntry = queue.find((e) => e.chatId === chatId);

    let storageDeleted = Boolean(existingEntry?.storageDeleted);
    let firestoreDeleted = Boolean(existingEntry?.firestoreDeleted);
    let storageError = null;

    // 1. SUPABASE STORAGE CLEANUP FIRST (Requirement 1, 2, 7, 8)
    if (userId && userId !== 'guest' && !storageDeleted) {
      const storageResult = await cleanUpSupabaseConversationStorage(chatId);
      if (storageResult.success) {
        storageDeleted = true;
      } else {
        storageError = storageResult;
        if (storageResult.status === 403) {
          // Cross-user / forbidden: non-retryable permission error
          storageDeleted = true;
        }
      }
    } else {
      // Guest or already cleaned
      storageDeleted = true;
    }

    // 2. LOCAL CACHE CLEANUP SECOND (Requirement 7)
    // Purge associated attachment blobs from IndexedDB to prevent orphan buildup
    void deleteAttachmentsForConversation(chatId).catch(() => {});
    try {
      const cachedMessages = getCachedChatMessages(userId, chatId);
      const attIds = [];
      cachedMessages.forEach((m) => {
        if (Array.isArray(m?.attachments)) {
          m.attachments.forEach((a) => a?.id && attIds.push(a.id));
        }
        if (Array.isArray(m?.referencedAttachments)) {
          m.referencedAttachments.forEach((a) => a?.id && attIds.push(a.id));
        }
      });
      if (attIds.length > 0) {
        void deleteAttachmentRecords(attIds).catch(() => {});
      }
    } catch (_) {}

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

    // 3. FIRESTORE DELETION THIRD (Requirement 1, 7)
    // If Supabase storage cleanup failed with a retryable error, queue immediately and do not delete Firestore yet!
    if (!storageDeleted && storageError?.retryable) {
      if (!targetLocal?.createdOffline || existingEntry) {
        enqueuePendingDeletion(userId, chatId, {
          storageDeleted: false,
          firestoreDeleted: false,
          error: storageError.error
        });
      }
      return;
    }

    // If storage is deleted (or guest), proceed with Firestore deletion if not already firestoreDeleted
    if (!firestoreDeleted) {
      const effectiveDb = testDbOverride !== null ? testDbOverride : db;
      if (!effectiveDb || (!isFirebaseConfigured() && !testDbOverride) || !isBrowserOnline()) {
        if (!targetLocal?.createdOffline || existingEntry) {
          enqueuePendingDeletion(userId, chatId, {
            storageDeleted: true,
            firestoreDeleted: false,
            error: 'Offline / Firebase unconfigured'
          });
        }
        return;
      }

      try {
        if (testDbOverride && typeof testDbOverride.deleteConversation === 'function') {
          await testDbOverride.deleteConversation(userId, chatId);
          firestoreDeleted = true;
        } else {
          const messagesRef = collection(effectiveDb, 'users', userId, 'chats', chatId, 'messages');
          const snapshot = await withBoundedTimeout(getDocs(messagesRef), FIRESTORE_OP_TIMEOUT_MS, 'loadMessagesForDelete');

          const docs = snapshot.docs;
          const CHUNK_SIZE = 400;

          for (let i = 0; i < docs.length; i += CHUNK_SIZE) {
            const chunk = docs.slice(i, i + CHUNK_SIZE);
            const batch = writeBatch(effectiveDb);
            chunk.forEach((docSnap) => {
              batch.delete(docSnap.ref);
            });
            await withBoundedTimeout(batch.commit(), FIRESTORE_OP_TIMEOUT_MS, 'deleteMessagesBatch');
          }

          const chatDocRef = doc(effectiveDb, 'users', userId, 'chats', chatId);
          await withBoundedTimeout(deleteDoc(chatDocRef), FIRESTORE_OP_TIMEOUT_MS, 'deleteChatDoc');
          firestoreDeleted = true;
        }
      } catch (err) {
        if (isOfflineOrNetworkError(err)) {
          if (!targetLocal?.createdOffline || existingEntry) {
            enqueuePendingDeletion(userId, chatId, {
              storageDeleted: true,
              firestoreDeleted: false,
              error: err.message
            });
          }
          return;
        }
        throw err;
      }
    }

    // 4. Completed both cleanup stages successfully
    if (storageDeleted && firestoreDeleted) {
      removePendingDeletion(userId, chatId);
    }
  })();

  activeDeletionPromises.set(opKey, deletionTask);
  try {
    return await deletionTask;
  } finally {
    activeDeletionPromises.delete(opKey);
  }
}

/**
 * Deletes an individual attachment from Supabase cloud storage using the authenticated
 * DELETE /api/upload/:id?chatId=... endpoint.
 *
 * @param {string} attachmentId - Unique attachment UUID
 * @param {string} chatId - Parent conversation document ID
 * @returns {Promise<{ success: boolean, status?: number, code?: string, retryable?: boolean, error?: string }>}
 */
/**
 * Deletes an individual attachment from Supabase cloud storage using the authenticated
 * DELETE /api/upload/:id?chatId=... endpoint.
 *
 * @param {string} attachmentId - Unique attachment UUID
 * @param {string} chatId - Parent conversation document ID
 * @param {string} [userId=null] - Optional authenticated user UID
 * @returns {Promise<{ success: boolean, status?: number, code?: string, retryable?: boolean, error?: string }>}
 */
export async function cleanUpSingleAttachmentStorage(attachmentId, chatId, userId = null) {
  if (!attachmentId) {
    return { success: false, retryable: false, error: 'Attachment ID required' };
  }

  const effectiveUserId = (userId && userId !== 'guest') ? userId : getAuthUserId();
  const opKey = `${effectiveUserId || 'anon'}:${chatId || 'no-chat'}:${attachmentId}`;

  // Prevent concurrent duplicate deletion attempts for the same attachment
  if (activeAttachmentDeletionPromises.has(opKey)) {
    return activeAttachmentDeletionPromises.get(opKey);
  }

  const deletionTask = (async () => {
    if (!isBrowserOnline()) {
      const offlineResult = { success: false, status: 0, code: 'OFFLINE', retryable: true, offline: true, error: 'Browser is offline.' };
      if (effectiveUserId && effectiveUserId !== 'guest') {
        enqueuePendingOrphanedAttachmentDeletion(effectiveUserId, chatId, attachmentId, {
          error: offlineResult.error,
          status: 0
        });
      }
      return offlineResult;
    }

    try {
      const token = await getIdToken().catch(() => null);
      if (!token) {
        const authErr = {
          success: false,
          status: 401,
          code: 'AUTH_REQUIRED',
          retryable: true,
          error: 'Authentication required to delete cloud attachment.'
        };
        if (effectiveUserId && effectiveUserId !== 'guest') {
          enqueuePendingOrphanedAttachmentDeletion(effectiveUserId, chatId, attachmentId, {
            error: authErr.error,
            status: 401
          });
        }
        return authErr;
      }

      const query = chatId ? `?chatId=${encodeURIComponent(chatId)}` : '';
      const endpoint = `/api/upload/${encodeURIComponent(attachmentId)}${query}`;

      const res = await fetchWithAuth(endpoint, {
        method: 'DELETE'
      });

      if (res.ok || res.status === 404) {
        if (effectiveUserId && effectiveUserId !== 'guest') {
          removePendingOrphanedAttachmentDeletion(effectiveUserId, attachmentId);
        }
        return { success: true, status: res.status };
      }

      if (res.status === 401) {
        const unauthErr = { success: false, status: 401, code: 'UNAUTHORIZED', retryable: true, error: 'Unauthorized.' };
        if (effectiveUserId && effectiveUserId !== 'guest') {
          enqueuePendingOrphanedAttachmentDeletion(effectiveUserId, chatId, attachmentId, {
            error: unauthErr.error,
            status: 401
          });
        }
        return unauthErr;
      }

      if (res.status === 403) {
        return { success: false, status: 403, code: 'STORAGE_ACCESS_DENIED', retryable: false, error: 'Access denied.' };
      }

      const is5xx = res.status >= 500;
      let errMsg = `HTTP ${res.status}`;
      try {
        const errData = await res.json().catch(() => null);
        if (errData?.error) errMsg = errData.error;
      } catch (_) {}

      const failResult = {
        success: false,
        status: res.status,
        code: is5xx ? 'SERVER_ERROR' : 'DELETE_FAILED',
        retryable: is5xx,
        error: errMsg
      };

      if (effectiveUserId && effectiveUserId !== 'guest') {
        enqueuePendingOrphanedAttachmentDeletion(effectiveUserId, chatId, attachmentId, {
          error: errMsg,
          status: res.status
        });
      }

      return failResult;
    } catch (err) {
      const isTimeout = err?.name === 'AbortError' || String(err?.message || '').toLowerCase().includes('timeout');
      const networkResult = {
        success: false,
        status: isTimeout ? 408 : 0,
        code: isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR',
        retryable: true,
        error: isTimeout ? 'Storage deletion request timed out.' : (err?.message || 'Network error during storage deletion.')
      };

      if (effectiveUserId && effectiveUserId !== 'guest') {
        enqueuePendingOrphanedAttachmentDeletion(effectiveUserId, chatId, attachmentId, {
          error: networkResult.error,
          status: networkResult.status
        });
      }

      return networkResult;
    }
  })();

  activeAttachmentDeletionPromises.set(opKey, deletionTask);
  try {
    return await deletionTask;
  } finally {
    activeAttachmentDeletionPromises.delete(opKey);
  }
}

/**
 * Deletes specific messages from a chat's messages subcollection in Firestore (and local cache)
 * when truncating conversation branches during Edit and Resend.
 * Safely calculates retained attachment references across both `attachments` and `referencedAttachments`,
 * and only deletes orphaned attachments from Supabase storage and IndexedDB.
 *
 * @param {string} userId - Authenticated user UID (or 'guest')
 * @param {string} chatId - Chat document ID
 * @param {string[]} messageIds - Array of message document IDs to delete
 * @param {Object} [options={}] - Optional overrides (e.g., allMessages)
 * @returns {Promise<{ deletedCount: number, orphanedAttachments: string[] }>}
 */
export async function deleteChatMessages(userId, chatId, messageIds = [], options = {}) {
  if (!userId || !chatId || !Array.isArray(messageIds) || messageIds.length === 0) {
    return { deletedCount: 0, orphanedAttachments: [] };
  }

  const validIds = messageIds.filter((id) => typeof id === 'string' && id.trim().length > 0);
  if (validIds.length === 0) return { deletedCount: 0, orphanedAttachments: [] };

  const removeSet = new Set(validIds);

  // 1. Resolve conversation messages: options.allMessages if provided, or from local cache
  let allMessages = Array.isArray(options.allMessages) && options.allMessages.length > 0
    ? options.allMessages
    : getCachedChatMessages(userId, chatId);

  // If cached was empty but guest chats exist, check guest chats in localStorage
  if (allMessages.length === 0 && (userId === 'guest' || typeof window !== 'undefined')) {
    try {
      const guestRaw = localStorage.getItem('orvix_guest_chats') || localStorage.getItem('chatora_guest_chats');
      if (guestRaw) {
        const guestChats = JSON.parse(guestRaw);
        if (Array.isArray(guestChats)) {
          const chat = guestChats.find((c) => c.id === chatId);
          if (Array.isArray(chat?.messages)) {
            allMessages = chat.messages;
          }
        }
      }
    } catch (_) {}
  }

  const remainingLocal = allMessages.filter((m) => !removeSet.has(m.id));
  if (userId !== 'guest') {
    saveCachedChatMessages(userId, chatId, remainingLocal);
  }

  // 2. Collect all attachment IDs still referenced by retained messages (Requirement 2 & 3)
  const retainedAttachmentIds = new Set();
  remainingLocal.forEach((m) => {
    if (Array.isArray(m?.attachments)) {
      m.attachments.forEach((a) => {
        if (a?.id) retainedAttachmentIds.add(String(a.id));
      });
    }
    if (Array.isArray(m?.referencedAttachments)) {
      m.referencedAttachments.forEach((a) => {
        if (a?.id) retainedAttachmentIds.add(String(a.id));
      });
    }
  });

  // 3. Collect candidate attachments from deleted messages (Requirement 3)
  const candidateAttachmentMap = new Map();
  const deletedMessages = allMessages.filter((m) => removeSet.has(m.id));
  deletedMessages.forEach((m) => {
    if (Array.isArray(m?.attachments)) {
      m.attachments.forEach((a) => {
        if (a?.id) candidateAttachmentMap.set(String(a.id), a);
      });
    }
    if (Array.isArray(m?.referencedAttachments)) {
      m.referencedAttachments.forEach((a) => {
        if (a?.id) candidateAttachmentMap.set(String(a.id), a);
      });
    }
  });

  // 4. Identify orphaned attachments no longer referenced by any retained message (Requirement 4 & 7)
  const orphanedAttachmentIds = [];
  for (const [attId] of candidateAttachmentMap.entries()) {
    if (!retainedAttachmentIds.has(attId)) {
      orphanedAttachmentIds.push(attId);
    }
  }

  // 5. Clean up local IndexedDB records for orphaned attachments (Requirement 6)
  if (orphanedAttachmentIds.length > 0) {
    void deleteAttachmentRecords(orphanedAttachmentIds).catch(() => {});
  }

  // 6. For authenticated cloud attachments, call authenticated DELETE /api/upload/:id?chatId=... (Requirement 5)
  if (userId && userId !== 'guest' && orphanedAttachmentIds.length > 0) {
    await Promise.allSettled(
      orphanedAttachmentIds.map((attId) => cleanUpSingleAttachmentStorage(attId, chatId, userId))
    );
  }

  // 7. Delete truncated message documents from Cloud Firestore
  const effectiveDb = testDbOverride !== null ? testDbOverride : db;
  if (!effectiveDb || (!isFirebaseConfigured() && !testDbOverride) || !isBrowserOnline() || userId === 'guest') {
    return { deletedCount: validIds.length, orphanedAttachments: orphanedAttachmentIds };
  }

  try {
    if (testDbOverride && typeof testDbOverride.deleteChatMessages === 'function') {
      await testDbOverride.deleteChatMessages(userId, chatId, validIds);
    } else {
      const CHUNK_SIZE = 400;
      for (let i = 0; i < validIds.length; i += CHUNK_SIZE) {
        const chunk = validIds.slice(i, i + CHUNK_SIZE);
        const batch = writeBatch(effectiveDb);
        chunk.forEach((msgId) => {
          const msgRef = doc(effectiveDb, 'users', userId, 'chats', chatId, 'messages', msgId);
          batch.delete(msgRef);
        });
        await withBoundedTimeout(batch.commit(), FIRESTORE_OP_TIMEOUT_MS, 'deleteChatMessages');
      }
    }
  } catch (err) {
    console.warn('Could not delete truncated messages in Firestore (updated locally):', err?.message || err);
  }

  return { deletedCount: validIds.length, orphanedAttachments: orphanedAttachmentIds };
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
        hasCustomTitle: Boolean(localMatch.hasCustomTitle || c.hasCustomTitle),
        rawUpdatedAt: newerRawUpdated,
        timestamp: formatChatDateLabel(newerRawUpdated),
        pendingSync: Boolean(localMatch.pendingSync),
        pendingMetaSync: Boolean(localMatch.pendingMetaSync),
        createdOffline: false
      });
    } else {
      mergedMap.set(c.id, {
        ...c,
        hasCustomTitle: Boolean(c.hasCustomTitle),
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

      // 1. Replay any pending offline deletions (Supabase storage + Firestore)
      await replayPendingDeletions(userId);

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
                  pinnedAt: localChat.isPinned ? serverTimestamp() : null,
                  ...(localChat.hasCustomTitle ? { hasCustomTitle: true } : {}),
                  ...(localChat.isImported ? { isImported: true } : {}),
                  ...(localChat.importedFromShareId ? { importedFromShareId: localChat.importedFromShareId } : {})
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
                ...(localChat.hasCustomTitle ? { hasCustomTitle: true } : {}),
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
          pinnedAt: data.pinnedAt?.toMillis ? data.pinnedAt.toMillis() : (data.pinnedAt || null),
          hasCustomTitle: Boolean(data.hasCustomTitle),
          isImported: Boolean(data.isImported),
          importedFromShareId: data.importedFromShareId || null
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

/**
 * Subscribes in real-time to the messages of an active conversation in Cloud Firestore.
 * Hydrates immediately from local cache, ensures zero duplicates, and falls back to local cache when offline.
 *
 * @param {string} userId - Authenticated user UID
 * @param {string} chatId - Chat document ID
 * @param {(messages: Array) => void} onUpdate - Snapshot update callback receiving canonically ordered messages
 * @param {(err: Error) => void} [onError] - Optional error handler callback
 * @returns {() => void} Unsubscribe function
 */
export function subscribeToChatMessages(userId, chatId, onUpdate, onError) {
  if (!userId || !chatId) {
    onUpdate([]);
    return () => {};
  }

  const local = getCachedChatMessages(userId, chatId);
  if (local.length > 0) {
    onUpdate(orderConversationMessages(ensureConversationAlternatives(local)));
  }

  if (!db || !isFirebaseConfigured()) {
    if (local.length === 0) onUpdate([]);
    return () => {};
  }

  if (!isBrowserOnline()) {
    return () => {};
  }

  const messagesRef = collection(db, 'users', userId, 'chats', chatId, 'messages');
  const q = query(messagesRef, orderBy('createdAt', 'asc'));

  return onSnapshot(
    q,
    (snapshot) => {
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
          createdAtMs:
            typeof data.createdAtMs === 'number'
              ? data.createdAtMs
              : data.createdAt?.toMillis
              ? data.createdAt.toMillis()
              : undefined,
          timestamp:
            data.clientTimestamp ||
            (data.createdAt?.toDate
              ? data.createdAt.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
              : ''),
          pendingSync: false
        });
      });

      const currentLocal = getCachedChatMessages(userId, chatId);
      const byId = new Map();
      for (const cm of cloudMessages) {
        byId.set(cm.id, cm);
      }
      for (const lm of currentLocal) {
        if (!lm?.id) continue;
        if (!byId.has(lm.id)) {
          if (lm.pendingSync || cloudMessages.length === 0) {
            byId.set(lm.id, lm);
          }
        } else if (lm.pendingSync) {
          byId.set(lm.id, lm);
        }
      }

      const merged = Array.from(byId.values());
      const normalized = orderConversationMessages(ensureConversationAlternatives(merged));
      saveCachedChatMessages(userId, chatId, normalized);
      onUpdate(normalized);
    },
    (err) => {
      if (isOfflineOrNetworkError(err)) {
        onUpdate(orderConversationMessages(ensureConversationAlternatives(getCachedChatMessages(userId, chatId))));
        return;
      }
      console.warn('Error subscribing to conversation messages:', err);
      if (onError) onError(err);
    }
  );
}

// Background auto-replay: Trigger pending deletions replay when browser goes online or auth changes
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('online', () => {
    const uid = getAuthUserId();
    if (uid && uid !== 'guest') {
      void replayPendingDeletions(uid).catch(() => {});
      void replayPendingOrphanedAttachmentDeletions(uid).catch(() => {});
    }
  });
}

if (typeof window !== 'undefined') {
  try {
    onAuthChange((user) => {
      if (user?.uid && isBrowserOnline()) {
        void replayPendingDeletions(user.uid).catch(() => {});
        void replayPendingOrphanedAttachmentDeletions(user.uid).catch(() => {});
      }
    });
  } catch (_) {}
}
