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
  deleteDoc,
  getDocs,
  query,
  orderBy,
  writeBatch
} from 'firebase/firestore';
import {
  auth,
  db,
  isFirebaseConfigured,
  isBrowserOnline
} from '../config/firebaseConfig.js';
import { getIdToken } from './authService.js';
import {
  normalizeAssistantMessage,
  ensureConversationAlternatives
} from './alternativeResponseService.js';

const FIRESTORE_OP_TIMEOUT_MS = 4500;
const activeSyncPromises = new Map();
const activeSubscriptions = new Map();

export {
  setAuthTokenProviderForTesting,
  resolveAuthToken,
  getApiEndpoint,
  authorizedApiFetch
} from './mongoApiClient.js';
import {
  setAuthTokenProviderForTesting,
  resolveAuthToken,
  getApiEndpoint,
  authorizedApiFetch
} from './mongoApiClient.js';

let customLegacyFirestoreLoader = null;
let customLegacyFirestoreChatsLoader = null;
let customLegacyFirestoreDeleteHandler = null;
let customFirestoreOpTimeoutMs = null;

function getFirestoreTimeoutMs() {
  return customFirestoreOpTimeoutMs || FIRESTORE_OP_TIMEOUT_MS;
}

/**
 * Testing hook allowing unit and integration tests to simulate read-only legacy Firestore message loading.
 * @param {((userId: string, chatId: string) => Promise<Array>)|null} loader
 */
export function setLegacyFirestoreMessagesLoaderForTesting(loader) {
  customLegacyFirestoreLoader = loader;
}

/**
 * Testing hook allowing unit and integration tests to simulate read-only legacy Firestore conversation discovery.
 * @param {((userId: string) => Promise<Array>)|null} loader
 */
export function setLegacyFirestoreChatsLoaderForTesting(loader) {
  customLegacyFirestoreChatsLoader = loader;
}

/**
 * Testing hook allowing unit and integration tests to observe/simulate Firestore cleanup during deleteConversation.
 * @param {((userId: string, chatId: string) => Promise<void>|void)|null} handler
 */
export function setLegacyFirestoreDeleteHandlerForTesting(handler) {
  customLegacyFirestoreDeleteHandler = handler;
}

/**
 * Testing hook allowing tests to override the bounded Firestore timeout duration.
 * @param {number|null} timeoutMs
 */
export function setFirestoreTimeoutMsForTesting(timeoutMs) {
  customFirestoreOpTimeoutMs =
    typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : null;
}

/**
 * Maps a MongoDB conversation document to the frontend conversation UI model.
 * @param {any} conv
 * @returns {any}
 */
export function mapMongoConversationToChat(conv) {
  if (!conv) return null;
  const updatedMs = conv.updatedAt ? new Date(conv.updatedAt).getTime() : Date.now();
  const pinnedMs = conv.pinnedAt ? new Date(conv.pinnedAt).getTime() : null;
  return {
    id: conv.id || conv._id,
    title: conv.title || 'Untitled Chat',
    mode: conv.mode || 'general',
    timestamp: formatChatDateLabel(updatedMs),
    rawUpdatedAt: updatedMs,
    isPinned: Boolean(conv.isPinned),
    pinnedAt: pinnedMs
  };
}

function parseLegacyTimestampMs(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'number') {
    return Number.isFinite(val) ? val : null;
  }
  if (typeof val?.toMillis === 'function') {
    const ms = val.toMillis();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof val?.seconds === 'number') {
    const ns = typeof val.nanoseconds === 'number' ? val.nanoseconds : 0;
    return val.seconds * 1000 + Math.floor(ns / 1e6);
  }
  if (val instanceof Date) {
    const ms = val.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof val === 'string' && val.trim()) {
    const ms = new Date(val).getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/**
 * Maps a legacy Cloud Firestore conversation document (`users/{uid}/chats/{chatId}`)
 * to the frontend conversation UI model using existing Orvix defaults.
 *
 * @param {string} docId
 * @param {any} [data]
 * @returns {any}
 */
export function mapLegacyFirestoreConversationToChat(docId, data = {}) {
  const resolvedId = String(docId || data?.id || '').trim();
  if (!resolvedId) return null;

  const createdMs =
    parseLegacyTimestampMs(data?.createdAt) ??
    parseLegacyTimestampMs(data?.createdAtMs);
  const updatedMs =
    parseLegacyTimestampMs(data?.updatedAt) ??
    parseLegacyTimestampMs(data?.rawUpdatedAt) ??
    createdMs ??
    0;
  const isPinned = Boolean(data?.isPinned);
  const pinnedMs = isPinned ? parseLegacyTimestampMs(data?.pinnedAt) : null;
  const cleanTitle =
    typeof data?.title === 'string' && data.title.trim()
      ? data.title.trim()
      : 'Untitled Chat';
  const cleanMode =
    typeof data?.mode === 'string' && data.mode.trim()
      ? data.mode.trim().toLowerCase()
      : 'general';

  return {
    id: resolvedId,
    title: cleanTitle,
    mode: cleanMode,
    timestamp: formatChatDateLabel(updatedMs),
    rawUpdatedAt: updatedMs,
    ...(createdMs !== null ? { createdAtMs: createdMs } : {}),
    isPinned,
    pinnedAt: pinnedMs,
    storageSource: 'legacy-firestore',
    hasLegacyFirestore: true
  };
}

/**
 * Notifies all active subscribers for a user with the latest cached conversations.
 * @param {string} userId
 */
function notifyConversationListeners(userId) {
  if (!userId) return;
  const listeners = activeSubscriptions.get(userId);
  if (listeners && listeners.size > 0) {
    const cached = getCachedUserChats(userId);
    listeners.forEach((callback) => {
      try {
        callback(cached);
      } catch (err) {
        console.warn('Error in conversation subscriber listener:', err);
      }
    });
  }
}

if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('storage', (event) => {
    if (event.key && event.key.startsWith('orvix_user_chats_')) {
      const uid = event.key.replace('orvix_user_chats_', '');
      notifyConversationListeners(uid);
    }
  });
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

function getUserDeletedMessagesKey(userId, chatId) {
  return `orvix_user_deleted_messages_${userId}_${chatId}`;
}

function getUserPendingDeletedMessagesKey(userId) {
  return `orvix_user_pending_deleted_msgs_${userId}`;
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
    localStorage.setItem(getUserMessagesCacheKey(userId, chatId), JSON.stringify(messages));
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

function getDeletedMessageTombstones(userId, chatId) {
  if (!userId || !chatId || typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(getUserDeletedMessagesKey(userId, chatId));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function saveDeletedMessageTombstones(userId, chatId, ids) {
  if (!userId || !chatId || typeof window === 'undefined') return;
  try {
    const unique = Array.from(new Set((ids || []).filter(Boolean)));
    if (unique.length === 0) {
      localStorage.removeItem(getUserDeletedMessagesKey(userId, chatId));
    } else {
      localStorage.setItem(getUserDeletedMessagesKey(userId, chatId), JSON.stringify(unique));
    }
  } catch (_) {}
}

function getPendingDeletedMessagesMap(userId) {
  if (!userId || typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(getUserPendingDeletedMessagesKey(userId));
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function savePendingDeletedMessagesMap(userId, mapObj) {
  if (!userId || typeof window === 'undefined') return;
  try {
    const cleaned = {};
    for (const [cid, arr] of Object.entries(mapObj || {})) {
      if (Array.isArray(arr) && arr.length > 0) {
        cleaned[cid] = Array.from(new Set(arr.filter(Boolean)));
      }
    }
    if (Object.keys(cleaned).length === 0) {
      localStorage.removeItem(getUserPendingDeletedMessagesKey(userId));
    } else {
      localStorage.setItem(getUserPendingDeletedMessagesKey(userId), JSON.stringify(cleaned));
    }
  } catch (_) {}
}

function addPendingDeletedMessages(userId, chatId, messageIds) {
  if (!userId || !chatId || !Array.isArray(messageIds) || messageIds.length === 0) return;
  const current = getPendingDeletedMessagesMap(userId);
  const existing = Array.isArray(current[chatId]) ? current[chatId] : [];
  current[chatId] = Array.from(new Set([...existing, ...messageIds]));
  savePendingDeletedMessagesMap(userId, current);
}

function removePendingDeletedMessages(userId, chatId, messageIds = null) {
  if (!userId || !chatId) return;
  const current = getPendingDeletedMessagesMap(userId);
  if (!current[chatId]) return;
  if (messageIds === null) {
    delete current[chatId];
  } else {
    const removeSet = new Set(messageIds);
    const remaining = current[chatId].filter((id) => !removeSet.has(id));
    if (remaining.length === 0) {
      delete current[chatId];
    } else {
      current[chatId] = remaining;
    }
  }
  savePendingDeletedMessagesMap(userId, current);
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
  saveCachedChatMessages(userId, chatId, next);
  return next;
}

function serializeAttachmentForStorage(att) {
  if (!att || typeof att !== 'object') return att;
  const { file, base64, dataUrl, previewUrl, ...rest } = att;
  return {
    ...rest,
    id: att.id,
    name: att.name || att.originalName || 'document',
    originalName: att.originalName || att.name || 'document',
    size: att.size || 0,
    formattedSize: att.formattedSize || '',
    type: att.type || att.mimeType || '',
    extension: att.extension || '',
    isImage: Boolean(att.isImage),
    status: att.status || 'uploaded',
    extraction: att.extraction ?? null
  };
}

function sanitizeMessageForStorage(targetMessage, clientTimestamp, createdAtMs, flags = {}) {
  const sanitizedAlternatives = Array.isArray(targetMessage.alternatives)
    ? targetMessage.alternatives.map((alt) => {
        const {
          isStreaming: _ignoreAltStreaming,
          requestStartTime: _ignoreAltStart,
          ...cleanAlt
        } = alt || {};
        return {
          ...cleanAlt,
          id: alt.id,
          parentMessageId: alt.parentMessageId || targetMessage.parentMessageId || null,
          sender: 'assistant',
          content: typeof alt.content === 'string' ? alt.content : '',
          provider: alt.provider || targetMessage.provider || 'gemini',
          modelUsed: alt.modelUsed || null,
          responseTimeMs: typeof alt.responseTimeMs === 'number' ? alt.responseTimeMs : null,
          timestamp: alt.timestamp || '',
          createdAt: typeof alt.createdAt === 'number' ? alt.createdAt : createdAtMs,
          referencedAttachments: Array.isArray(alt.referencedAttachments)
            ? alt.referencedAttachments.map(serializeAttachmentForStorage)
            : [],
          isError: Boolean(alt.isError),
          isStopped: Boolean(alt.isStopped)
        };
      })
    : [];

  const {
    isStreaming: _ignoreStreaming,
    requestStartTime: _ignoreRequestStart,
    ...cleanTarget
  } = targetMessage || {};

  return {
    ...cleanTarget,
    id: targetMessage.id,
    sender: targetMessage.sender,
    content: typeof targetMessage.content === 'string' ? targetMessage.content : '',
    modelUsed: targetMessage.modelUsed || null,
    provider: targetMessage.provider || null,
    mode: targetMessage.mode || undefined,
    responseTimeMs: typeof targetMessage.responseTimeMs === 'number' ? targetMessage.responseTimeMs : null,
    parentMessageId: targetMessage.parentMessageId || null,
    activeAlternativeId: targetMessage.activeAlternativeId || null,
    alternatives: sanitizedAlternatives,
    attachments: Array.isArray(targetMessage.attachments)
      ? targetMessage.attachments.map(serializeAttachmentForStorage)
      : [],
    referencedAttachments: Array.isArray(targetMessage.referencedAttachments)
      ? targetMessage.referencedAttachments.map(serializeAttachmentForStorage)
      : [],
    isStreaming: false,
    isStopped: Boolean(targetMessage.isStopped),
    isInterrupted: Boolean(targetMessage.isInterrupted),
    timestamp: clientTimestamp,
    createdAtMs,
    pendingSync: Boolean(flags.pendingSync),
    syncedToMongo: Boolean(flags.syncedToMongo)
  };
}

function buildMongoMessagePayload(chatId, record) {
  return {
    id: record.id,
    conversationId: chatId,
    sender: record.sender,
    content: typeof record.content === 'string' ? record.content : '',
    modelUsed: record.modelUsed || null,
    provider: record.provider || null,
    mode: record.mode || null,
    responseTimeMs: typeof record.responseTimeMs === 'number' ? record.responseTimeMs : null,
    parentMessageId: record.parentMessageId || null,
    activeAlternativeId: record.activeAlternativeId || null,
    alternatives: Array.isArray(record.alternatives) ? record.alternatives : [],
    attachments: Array.isArray(record.attachments) ? record.attachments : [],
    referencedAttachments: Array.isArray(record.referencedAttachments) ? record.referencedAttachments : [],
    isStopped: Boolean(record.isStopped),
    isInterrupted: Boolean(record.isInterrupted),
    clientTimestamp: record.timestamp || '',
    createdAtMs: typeof record.createdAtMs === 'number' ? record.createdAtMs : Date.now()
  };
}

/**
 * Maps a MongoDB message document to the frontend message UI model.
 * @param {any} docItem
 * @returns {any}
 */
export function mapMongoMessageToUiMessage(docItem) {
  if (!docItem) return null;
  const parsedCreatedMs = docItem.createdAt ? new Date(docItem.createdAt).getTime() : NaN;
  const createdAtMs = Number.isFinite(parsedCreatedMs)
    ? parsedCreatedMs
    : typeof docItem.createdAtMs === 'number'
      ? docItem.createdAtMs
      : undefined;
  const fallbackTimeLabel = Number.isFinite(parsedCreatedMs)
    ? new Date(parsedCreatedMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';

  const mapped = {
    id: docItem.id || docItem._id,
    sender: docItem.sender,
    content: typeof docItem.content === 'string' ? docItem.content : '',
    modelUsed: docItem.modelUsed || null,
    provider: docItem.provider || null,
    mode: docItem.mode || undefined,
    responseTimeMs: typeof docItem.responseTimeMs === 'number' ? docItem.responseTimeMs : null,
    parentMessageId: docItem.parentMessageId || null,
    activeAlternativeId: docItem.activeAlternativeId || null,
    alternatives: Array.isArray(docItem.alternatives) ? docItem.alternatives : [],
    attachments: Array.isArray(docItem.attachments) ? docItem.attachments : [],
    referencedAttachments: Array.isArray(docItem.referencedAttachments) ? docItem.referencedAttachments : [],
    isStreaming: false,
    isStopped: Boolean(docItem.isStopped),
    isInterrupted: Boolean(docItem.isInterrupted),
    createdAtMs,
    timestamp: docItem.clientTimestamp || fallbackTimeLabel,
    pendingSync: false,
    syncedToMongo: true
  };

  return mapped.sender === 'assistant' ? normalizeAssistantMessage(mapped) : mapped;
}

/**
 * Deterministically sorts messages in chronological order (oldest -> newest)
 * with tie-breaking by parentMessageId link, user-before-assistant role, and original index.
 * @param {Array} messages
 * @returns {Array}
 */
function sortMessagesChronologically(messages) {
  if (!Array.isArray(messages) || messages.length <= 1) return messages || [];
  const indexed = messages.map((msg, idx) => ({ msg, idx }));
  indexed.sort((a, b) => {
    const aTime =
      typeof a.msg?.createdAtMs === 'number' && Number.isFinite(a.msg.createdAtMs)
        ? a.msg.createdAtMs
        : null;
    const bTime =
      typeof b.msg?.createdAtMs === 'number' && Number.isFinite(b.msg.createdAtMs)
        ? b.msg.createdAtMs
        : null;

    if (aTime !== null && bTime !== null && aTime !== bTime) {
      return aTime - bTime;
    }
    if (a.msg?.parentMessageId && a.msg.parentMessageId === b.msg?.id) return 1;
    if (b.msg?.parentMessageId && b.msg.parentMessageId === a.msg?.id) return -1;
    if (aTime !== null && bTime !== null && aTime === bTime && a.msg?.sender !== b.msg?.sender) {
      return a.msg?.sender === 'user' ? -1 : 1;
    }
    return a.idx - b.idx;
  });
  return indexed.map((entry) => entry.msg);
}

/**
 * Ensures a user's locally known conversation metadata exists in MongoDB before writing messages
 * (e.g. for offline-created conversations or pre-migration legacy conversations).
 */
async function ensureParentConversationInMongo(chatMeta, fallbackMode = 'general') {
  if (!chatMeta?.id) return false;
  const payload = {
    id: chatMeta.id,
    title: chatMeta.title || 'New Conversation',
    mode: chatMeta.mode || fallbackMode || 'general',
    isPinned: Boolean(chatMeta.isPinned)
  };

  const { res } = await authorizedApiFetch('/api/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!res) return false;
  if (res.ok) return true;

  if (res.status === 400 && payload.isPinned) {
    const errBody = await res.json().catch(() => ({}));
    if (errBody?.code === 'PIN_LIMIT_EXCEEDED') {
      const retry = await authorizedApiFetch('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, isPinned: false })
      });
      return Boolean(retry.res?.ok);
    }
  }

  return false;
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
 * Generates a valid chat ID locally without requiring network connectivity or Firestore.
 * @param {string} [_userId]
 * @returns {string}
 */
export function generateLocalChatId(_userId = '') {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `local-${crypto.randomUUID()}`;
  }
  return `local-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 10)}`;
}

/**
 * Creates a new chat conversation document via authenticated Express/MongoDB API
 * with automatic offline local fallback and user isolation.
 *
 * @param {string} userId - Authenticated user UID
 * @param {string} [initialTitle='New Conversation']
 * @param {string} [mode='general'] - Active chat mode (general | coding | writing | learning)
 * @returns {Promise<string>} The generated chatId
 */
export async function createChatDocument(userId, initialTitle = 'New Conversation', mode = 'general') {
  if (!userId) {
    throw new Error('Valid userId is required to create a conversation.');
  }

  const isGuest = String(userId).startsWith('guest-');
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
    ...(isGuest ? {} : { storageSource: 'mongodb', hasLegacyFirestore: false }),
    pendingSync: !isGuest,
    createdOffline: !isBrowserOnline()
  });

  notifyConversationListeners(userId);

  // Guests persist strictly to local storage without authentication or database access
  if (isGuest) {
    return chatId;
  }

  if (!isBrowserOnline()) {
    return chatId;
  }

  try {
    const { res } = await authorizedApiFetch('/api/conversations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        id: chatId,
        title: initialTitle,
        mode: cleanMode,
        isPinned: false
      })
    });

    if (res) {
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || `Failed to create conversation (${res.status})`);
      }

      const resData = await res.json().catch(() => ({}));
      if (resData?.conversation) {
        const mapped = mapMongoConversationToChat(resData.conversation);
        upsertCachedUserChat(userId, {
          ...mapped,
          storageSource: 'mongodb',
          hasLegacyFirestore: false,
          pendingSync: false,
          createdOffline: false
        });
      } else {
        upsertCachedUserChat(userId, {
          id: chatId,
          storageSource: 'mongodb',
          hasLegacyFirestore: false,
          pendingSync: false,
          createdOffline: false
        });
      }
      notifyConversationListeners(userId);
    }
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
 * Updates the active mode of an existing conversation via authenticated Express/MongoDB API (and local cache).
 * @param {string} userId
 * @param {string} chatId
 * @param {string} mode
 */
export async function updateChatMode(userId, chatId, mode) {
  if (!userId || !chatId) return;
  const cleanMode = mode || 'general';
  const isGuest = String(userId).startsWith('guest-');
  const existingLocalChat = getCachedUserChats(userId).find((c) => c.id === chatId);

  upsertCachedUserChat(userId, {
    id: chatId,
    mode: cleanMode,
    rawUpdatedAt: Date.now(),
    pendingMetaSync: !isBrowserOnline() && !isGuest
  });
  notifyConversationListeners(userId);

  if (isGuest || !isBrowserOnline()) {
    return;
  }

  try {
    const { res } = await authorizedApiFetch(
      `/api/conversations/${encodeURIComponent(chatId)}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ mode: cleanMode })
      }
    );

    if (res) {
      if (res.status === 404 && existingLocalChat?.storageSource === 'legacy-firestore') {
        const promoted = await ensureParentConversationInMongo(
          { ...existingLocalChat, mode: cleanMode },
          cleanMode
        );
        if (promoted) {
          upsertCachedUserChat(userId, {
            id: chatId,
            mode: cleanMode,
            storageSource: 'hybrid',
            hasLegacyFirestore: true,
            pendingMetaSync: false
          });
          notifyConversationListeners(userId);
          return;
        }
      }

      if (res.ok) {
        upsertCachedUserChat(userId, { id: chatId, mode: cleanMode, pendingMetaSync: false });
        notifyConversationListeners(userId);
      } else {
        upsertCachedUserChat(userId, { id: chatId, pendingMetaSync: true });
      }
    }
  } catch (err) {
    upsertCachedUserChat(userId, { id: chatId, pendingMetaSync: true });
    console.warn('Could not update conversation mode in MongoDB API (saved locally):', err?.message || err);
  }
}

/**
 * Persists a user or assistant message via the authenticated Express/MongoDB API (/api/messages)
 * and updates the parent conversation's updatedAt timestamp on the server.
 * Preserves guest isolation, local caching, idempotent updates/retries, and offline queueing.
 *
 * @param {string} userId - Authenticated user UID (or guest session ID)
 * @param {string} chatId - Conversation ID
 * @param {Object} message - Message object
 */
export async function saveChatMessage(userId, chatId, message) {
  if (!userId || !chatId || !message?.id) {
    return;
  }

  // Never persist temporary mock messages, loading states, or failed pure-error messages
  if (message.isError || (message.sender !== 'user' && message.sender !== 'assistant')) {
    return;
  }

  const isGuest = String(userId).startsWith('guest-');
  const targetMessage =
    message.sender === 'assistant'
      ? normalizeAssistantMessage(message)
      : message;

  const prevLocalMessages = getCachedChatMessages(userId, chatId);
  const prevLocalChats = getCachedUserChats(userId);
  const existingLocalMsg = prevLocalMessages.find((m) => m.id === targetMessage.id);
  const existingLocalChat = prevLocalChats.find((c) => c.id === chatId);

  const clientTimestamp =
    targetMessage.timestamp ||
    existingLocalMsg?.timestamp ||
    new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const nowMs = Date.now();
  const createdAtMs =
    typeof targetMessage.createdAtMs === 'number' && Number.isFinite(targetMessage.createdAtMs)
      ? targetMessage.createdAtMs
      : typeof existingLocalMsg?.createdAtMs === 'number' && Number.isFinite(existingLocalMsg.createdAtMs)
        ? existingLocalMsg.createdAtMs
        : nowMs;

  const localRecord = sanitizeMessageForStorage(targetMessage, clientTimestamp, createdAtMs, {
    pendingSync: !isGuest,
    syncedToMongo: false
  });

  // Guest isolation: persist strictly to guest-scoped local storage with zero cloud/token traffic
  if (isGuest) {
    upsertCachedChatMessage(userId, chatId, localRecord);
    upsertCachedUserChat(userId, {
      id: chatId,
      title: existingLocalChat?.title || 'Conversation',
      mode: existingLocalChat?.mode || targetMessage.mode || 'general',
      timestamp: formatChatDateLabel(nowMs),
      rawUpdatedAt: nowMs,
      isPinned: Boolean(existingLocalChat?.isPinned),
      pinnedAt: existingLocalChat?.pinnedAt || null,
      pendingSync: false
    });
    return;
  }

  // 1. Optimistically persist locally first so messages survive refreshes while offline
  upsertCachedChatMessage(userId, chatId, localRecord);
  upsertCachedUserChat(userId, {
    id: chatId,
    title: existingLocalChat?.title || 'Conversation',
    mode: existingLocalChat?.mode || targetMessage.mode || 'general',
    timestamp: formatChatDateLabel(nowMs),
    rawUpdatedAt: nowMs,
    isPinned: Boolean(existingLocalChat?.isPinned),
    pinnedAt: existingLocalChat?.pinnedAt || null,
    pendingSync: true
  });

  if (!isBrowserOnline()) {
    return;
  }

  const payload = buildMongoMessagePayload(chatId, localRecord);

  try {
    let { res, token } = await authorizedApiFetch('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!token || !res) {
      return;
    }

    // If the parent conversation only existed locally/offline or in legacy storage, create it first and retry once
    if (res.status === 404 && existingLocalChat) {
      const parentCreated = await ensureParentConversationInMongo(
        existingLocalChat,
        localRecord.mode || 'general'
      );
      if (parentCreated) {
        const retryResult = await authorizedApiFetch('/api/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (retryResult.res) {
          res = retryResult.res;
        }
      }
    }

    if (!res.ok) {
      // Transient 5xx errors stay safely queued in local cache for later sync
      if (res.status >= 500) {
        console.warn(`MongoDB API returned ${res.status} while saving message; retained in local sync queue:`, localRecord.id);
        return;
      }

      // Authorization, ownership, conflict, or validation failure: roll back optimistic local cache and surface error
      saveCachedChatMessages(userId, chatId, prevLocalMessages);
      saveCachedUserChats(userId, prevLocalChats);

      const errorData = await res.json().catch(() => ({}));
      const apiErr = new Error(errorData.error || `Failed to save message (${res.status})`);
      apiErr.status = res.status;
      apiErr.code = errorData.code || 'MESSAGE_SAVE_FAILED';
      throw apiErr;
    }

    const resData = await res.json().catch(() => ({}));
    const savedDoc = resData?.message;
    const savedCreatedMs = savedDoc?.createdAt ? new Date(savedDoc.createdAt).getTime() : NaN;

    // Clear any prior deletion tombstones for this ID if re-saved
    const tombstones = getDeletedMessageTombstones(userId, chatId);
    if (tombstones.includes(localRecord.id)) {
      saveDeletedMessageTombstones(
        userId,
        chatId,
        tombstones.filter((id) => id !== localRecord.id)
      );
    }
    removePendingDeletedMessages(userId, chatId, [localRecord.id]);

    upsertCachedChatMessage(userId, chatId, {
      ...localRecord,
      createdAtMs: Number.isFinite(savedCreatedMs) ? savedCreatedMs : localRecord.createdAtMs,
      pendingSync: false,
      syncedToMongo: true
    });

    const remainingPending = getCachedChatMessages(userId, chatId).some((m) => m.pendingSync);
    upsertCachedUserChat(userId, {
      id: chatId,
      ...(existingLocalChat?.storageSource === 'legacy-firestore'
        ? { storageSource: 'hybrid', hasLegacyFirestore: true }
        : {}),
      pendingSync: remainingPending,
      createdOffline: false
    });
  } catch (err) {
    if (isOfflineOrNetworkError(err)) {
      console.warn('MongoDB API unreachable while saving message; retained in local sync queue:', localRecord.id);
      return;
    }
    throw err;
  }
}

/**
 * Renames an existing conversation via authenticated Express/MongoDB API (and local cache).
 * @param {string} userId
 * @param {string} chatId
 * @param {string} newTitle
 */
export async function renameConversation(userId, chatId, newTitle) {
  const sanitized = (newTitle || '').trim();
  if (!sanitized) {
    throw new Error('Conversation title cannot be empty.');
  }

  const isGuest = !userId || String(userId).startsWith('guest-');
  const existingLocalChat = userId && chatId
    ? getCachedUserChats(userId).find((c) => c.id === chatId)
    : null;

  if (userId && chatId) {
    upsertCachedUserChat(userId, {
      id: chatId,
      title: sanitized,
      rawUpdatedAt: Date.now(),
      pendingMetaSync: !isBrowserOnline() && !isGuest
    });
    notifyConversationListeners(userId);
  }

  if (isGuest || !isBrowserOnline()) {
    return;
  }

  try {
    const { res } = await authorizedApiFetch(
      `/api/conversations/${encodeURIComponent(chatId)}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ title: sanitized })
      }
    );

    if (res) {
      if (res.status === 404 && existingLocalChat?.storageSource === 'legacy-firestore') {
        const promoted = await ensureParentConversationInMongo(
          { ...existingLocalChat, title: sanitized },
          existingLocalChat.mode || 'general'
        );
        if (promoted) {
          upsertCachedUserChat(userId, {
            id: chatId,
            title: sanitized,
            storageSource: 'hybrid',
            hasLegacyFirestore: true,
            pendingMetaSync: false
          });
          notifyConversationListeners(userId);
          return;
        }
      }

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || `Failed to rename conversation (${res.status})`);
      }

      upsertCachedUserChat(userId, { id: chatId, title: sanitized, pendingMetaSync: false });
      notifyConversationListeners(userId);
    }
  } catch (err) {
    if (isOfflineOrNetworkError(err)) {
      upsertCachedUserChat(userId, { id: chatId, pendingMetaSync: true });
      return;
    }
    throw err;
  }
}

/**
 * Toggles or updates the pinned status of a conversation via authenticated Express/MongoDB API (with offline local fallback).
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

  const isGuest = String(userId).startsWith('guest-');
  const cachedChats = getCachedUserChats(userId);
  const existingLocalChat = cachedChats.find((c) => c.id === chatId);
  if (isPinned) {
    const localPinnedCount = cachedChats.filter((c) => c.isPinned && c.id !== chatId).length;
    if (localPinnedCount >= 5) {
      throw new Error('Maximum of 5 pinned conversations reached. Unpin another conversation first.');
    }
  }

  const nowMs = Date.now();

  // If guest or offline, persist to local cache immediately
  if (isGuest || !isBrowserOnline()) {
    upsertCachedUserChat(userId, {
      id: chatId,
      isPinned: Boolean(isPinned),
      pinnedAt: isPinned ? nowMs : null,
      rawUpdatedAt: nowMs,
      pendingMetaSync: !isGuest
    });
    notifyConversationListeners(userId);
    return Boolean(isPinned);
  }

  try {
    let { res } = await authorizedApiFetch(
      `/api/conversations/${encodeURIComponent(chatId)}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ isPinned: Boolean(isPinned) })
      }
    );

    if (res) {
      let promotedFromLegacy = false;
      if (res.status === 404 && existingLocalChat?.storageSource === 'legacy-firestore') {
        const createRes = await authorizedApiFetch('/api/conversations', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            id: chatId,
            title: existingLocalChat.title || 'Untitled Chat',
            mode: existingLocalChat.mode || 'general',
            isPinned: Boolean(isPinned)
          })
        });
        if (createRes.res) {
          res = createRes.res;
          promotedFromLegacy = res.ok;
        }
      }

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        // If pin limit was exceeded on server, throw the specific error message
        if (res.status === 400 && errorData.code === 'PIN_LIMIT_EXCEEDED') {
          throw new Error(errorData.error || 'Maximum of 5 pinned conversations reached. Unpin another conversation first.');
        }
        throw new Error(errorData.error || `Failed to update pin status (${res.status})`);
      }

      const data = await res.json().catch(() => ({}));
      const resultingPinned = data?.conversation?.isPinned ?? Boolean(isPinned);
      upsertCachedUserChat(userId, {
        id: chatId,
        isPinned: resultingPinned,
        pinnedAt: resultingPinned ? (data?.conversation?.pinnedAt ? new Date(data.conversation.pinnedAt).getTime() : nowMs) : null,
        rawUpdatedAt: nowMs,
        ...(promotedFromLegacy ? { storageSource: 'hybrid', hasLegacyFirestore: true } : {}),
        pendingMetaSync: false
      });
      notifyConversationListeners(userId);
      return resultingPinned;
    }
  } catch (err) {
    if (err.message && err.message.includes('5 pinned')) {
      throw err;
    }
    if (isOfflineOrNetworkError(err)) {
      upsertCachedUserChat(userId, {
        id: chatId,
        isPinned: Boolean(isPinned),
        pinnedAt: isPinned ? nowMs : null,
        rawUpdatedAt: nowMs,
        pendingMetaSync: true
      });
      notifyConversationListeners(userId);
      return Boolean(isPinned);
    }
    throw err;
  }

  return Boolean(isPinned);
}

/**
 * Deletes a conversation via authenticated Express/MongoDB API (cascading to MongoDB messages)
 * and cleans up associated unmigrated Firestore messages and local cache.
 *
 * @param {string} userId - Authenticated user UID
 * @param {string} chatId - Chat document ID
 */
export async function deleteConversation(userId, chatId) {
  if (!userId || !chatId) {
    throw new Error('Valid userId and chatId are required.');
  }

  const isGuest = String(userId).startsWith('guest-');
  const existingLocal = getCachedUserChats(userId);
  const targetLocal = existingLocal.find((c) => c.id === chatId);

  saveCachedUserChats(
    userId,
    existingLocal.filter((c) => c.id !== chatId)
  );
  if (typeof window !== 'undefined') {
    try {
      localStorage.removeItem(getUserMessagesCacheKey(userId, chatId));
      localStorage.removeItem(getUserDeletedMessagesKey(userId, chatId));
    } catch (_) {}
  }
  removePendingDeletedMessages(userId, chatId, null);
  notifyConversationListeners(userId);

  if (isGuest) {
    return;
  }

  if (!isBrowserOnline()) {
    if (!targetLocal?.createdOffline) {
      savePendingDeletedChatIds(userId, [...getPendingDeletedChatIds(userId), chatId]);
    }
    return;
  }

  try {
    const { res } = await authorizedApiFetch(
      `/api/conversations/${encodeURIComponent(chatId)}`,
      {
        method: 'DELETE'
      }
    );

    if (res && !res.ok && res.status !== 404) {
      const errorData = await res.json().catch(() => ({}));
      throw new Error(errorData.error || `Failed to delete conversation (${res.status})`);
    }
  } catch (err) {
    if (isOfflineOrNetworkError(err)) {
      if (!targetLocal?.createdOffline) {
        savePendingDeletedChatIds(userId, [...getPendingDeletedChatIds(userId), chatId]);
      }
      return;
    }
    throw err;
  }

  const timeoutMs = getFirestoreTimeoutMs();

  if (customLegacyFirestoreDeleteHandler && isBrowserOnline()) {
    try {
      await withBoundedTimeout(
        Promise.resolve().then(() => customLegacyFirestoreDeleteHandler(userId, chatId)),
        timeoutMs,
        'deleteLegacyFirestoreChat'
      );
    } catch (err) {
      console.warn('Could not clean up simulated Firestore documents during conversation deletion:', err?.message || err);
    }
  }

  // Clean up unmigrated Firestore messages and parent doc for this specific conversation
  if (db && isFirebaseConfigured() && isBrowserOnline()) {
    try {
      const messagesRef = collection(db, 'users', userId, 'chats', chatId, 'messages');
      const snapshot = await withBoundedTimeout(getDocs(messagesRef), timeoutMs, 'loadMessagesForDelete');

      const docs = snapshot.docs;
      const CHUNK_SIZE = 400;

      for (let i = 0; i < docs.length; i += CHUNK_SIZE) {
        const chunk = docs.slice(i, i + CHUNK_SIZE);
        const batch = writeBatch(db);
        chunk.forEach((docSnap) => {
          batch.delete(docSnap.ref);
        });
        await withBoundedTimeout(batch.commit(), timeoutMs, 'deleteMessagesBatch');
      }

      const chatDocRef = doc(db, 'users', userId, 'chats', chatId);
      await withBoundedTimeout(deleteDoc(chatDocRef), timeoutMs, 'deleteChatDoc');
    } catch (err) {
      console.warn('Could not clean up Firestore documents during conversation deletion:', err?.message || err);
    }
  }
}

/**
 * Deletes specific messages belonging to a single conversation via the authenticated
 * Express/MongoDB API (/api/messages) and updates local cache/tombstones.
 * Used when truncating conversation branches during Edit and Resend.
 * Does not modify or delete legacy Firestore documents.
 *
 * @param {string} userId - Authenticated user UID (or guest session ID)
 * @param {string} chatId - Conversation ID
 * @param {string[]} messageIds - Array of message IDs to delete
 */
export async function deleteChatMessages(userId, chatId, messageIds = []) {
  if (!userId || !chatId || !Array.isArray(messageIds) || messageIds.length === 0) {
    return;
  }

  const validIds = Array.from(
    new Set(messageIds.filter((id) => typeof id === 'string' && id.trim().length > 0))
  );
  if (validIds.length === 0) return;

  const isGuest = String(userId).startsWith('guest-');
  const prevLocalMessages = getCachedChatMessages(userId, chatId);
  const prevTombstones = getDeletedMessageTombstones(userId, chatId);

  const removeSet = new Set(validIds);
  const remainingLocal = prevLocalMessages.filter((m) => !removeSet.has(m.id));
  saveCachedChatMessages(userId, chatId, remainingLocal);

  if (isGuest) {
    return;
  }

  saveDeletedMessageTombstones(userId, chatId, [...prevTombstones, ...validIds]);

  if (!isBrowserOnline()) {
    addPendingDeletedMessages(userId, chatId, validIds);
    return;
  }

  try {
    const { res, token } = await authorizedApiFetch(
      `/api/messages?conversationId=${encodeURIComponent(chatId)}`,
      {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: chatId,
          messageIds: validIds
        })
      }
    );

    if (!token || !res) {
      addPendingDeletedMessages(userId, chatId, validIds);
      return;
    }

    if (!res.ok && res.status !== 404) {
      if (res.status >= 500) {
        addPendingDeletedMessages(userId, chatId, validIds);
        return;
      }

      // Authorization or validation failure: restore local state and throw
      saveCachedChatMessages(userId, chatId, prevLocalMessages);
      saveDeletedMessageTombstones(userId, chatId, prevTombstones);

      const errorData = await res.json().catch(() => ({}));
      const apiErr = new Error(errorData.error || `Failed to delete messages (${res.status})`);
      apiErr.status = res.status;
      apiErr.code = errorData.code || 'MESSAGE_DELETE_FAILED';
      throw apiErr;
    }

    removePendingDeletedMessages(userId, chatId, validIds);
  } catch (err) {
    if (isOfflineOrNetworkError(err)) {
      addPendingDeletedMessages(userId, chatId, validIds);
      console.warn('Offline/network fallback: queued message deletions for sync:', validIds.length);
      return;
    }
    throw err;
  }
}

/**
 * Deterministically merges authoritative MongoDB conversation metadata, read-only legacy
 * Firestore conversations, and locally cached pending conversations/tombstones.
 *
 * Precedence: Legacy Firestore < MongoDB < Pending Local Changes / Deletion Tombstones.
 */
function mergeCloudAndLocalChats(
  userId,
  cloudChats,
  legacyResult = { loaded: false, chats: [] },
  options = { persistCache: true }
) {
  const localChats = getCachedUserChats(userId);
  const deletedSet = new Set(getPendingDeletedChatIds(userId));
  const legacyMap = new Map();

  if (Array.isArray(legacyResult?.chats)) {
    for (const leg of legacyResult.chats) {
      if (!leg?.id || deletedSet.has(leg.id)) continue;
      if (!legacyMap.has(leg.id)) {
        legacyMap.set(leg.id, leg);
      }
    }
  }

  const mergedMap = new Map();

  // 1. Seed legacy Firestore conversations as lowest-priority compatibility baseline
  for (const leg of legacyMap.values()) {
    const localMatch = localChats.find((l) => l.id === leg.id);
    if (localMatch && (localMatch.pendingSync || localMatch.pendingMetaSync)) {
      const newerRawUpdated = Math.max(leg.rawUpdatedAt || 0, localMatch.rawUpdatedAt || 0);
      mergedMap.set(leg.id, {
        ...leg,
        title: localMatch.pendingMetaSync ? localMatch.title : (leg.title || localMatch.title),
        mode: localMatch.pendingMetaSync ? localMatch.mode : (leg.mode || localMatch.mode),
        isPinned: localMatch.pendingMetaSync ? Boolean(localMatch.isPinned) : Boolean(leg.isPinned),
        pinnedAt: localMatch.pendingMetaSync ? localMatch.pinnedAt : leg.pinnedAt,
        rawUpdatedAt: newerRawUpdated,
        timestamp: formatChatDateLabel(newerRawUpdated),
        storageSource: 'legacy-firestore',
        hasLegacyFirestore: true,
        pendingSync: Boolean(localMatch.pendingSync),
        pendingMetaSync: Boolean(localMatch.pendingMetaSync),
        createdOffline: false
      });
    } else {
      mergedMap.set(leg.id, {
        ...leg,
        storageSource: 'legacy-firestore',
        hasLegacyFirestore: true,
        pendingSync: false,
        pendingMetaSync: false,
        createdOffline: false
      });
    }
  }

  // 2. Apply authoritative MongoDB conversations (strictly overrides legacy Firestore on same chatId)
  for (const c of cloudChats) {
    if (!c?.id || deletedSet.has(c.id)) continue;
    const localMatch = localChats.find((l) => l.id === c.id);
    const inLegacy = legacyMap.has(c.id);
    const resolvedHasLegacy = inLegacy
      ? true
      : legacyResult?.loaded
        ? false
        : typeof localMatch?.hasLegacyFirestore === 'boolean'
          ? localMatch.hasLegacyFirestore
          : undefined;
    const resolvedSource =
      resolvedHasLegacy === true
        ? 'hybrid'
        : resolvedHasLegacy === false
          ? 'mongodb'
          : localMatch?.storageSource || 'mongodb';

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
        storageSource: resolvedSource,
        ...(typeof resolvedHasLegacy === 'boolean' ? { hasLegacyFirestore: resolvedHasLegacy } : {}),
        pendingSync: Boolean(localMatch.pendingSync),
        pendingMetaSync: Boolean(localMatch.pendingMetaSync),
        createdOffline: false
      });
    } else {
      mergedMap.set(c.id, {
        ...c,
        storageSource: resolvedSource,
        ...(typeof resolvedHasLegacy === 'boolean' ? { hasLegacyFirestore: resolvedHasLegacy } : {}),
        pendingSync: false,
        pendingMetaSync: false,
        createdOffline: false
      });
    }
  }

  // 3. Preserve unsynced local pending conversations (and cached legacy items if Firestore transiently failed)
  for (const localChat of localChats) {
    if (!localChat?.id || deletedSet.has(localChat.id)) continue;
    if (!mergedMap.has(localChat.id)) {
      if (localChat.pendingSync || localChat.createdOffline || localChat.pendingMetaSync) {
        mergedMap.set(localChat.id, localChat);
      } else if (!legacyResult?.loaded && localChat.storageSource === 'legacy-firestore') {
        mergedMap.set(localChat.id, localChat);
      }
    }
  }

  const merged = Array.from(mergedMap.values()).sort((a, b) => {
    const diff = (b.rawUpdatedAt || 0) - (a.rawUpdatedAt || 0);
    if (diff !== 0) return diff;
    return String(a.id || '').localeCompare(String(b.id || ''));
  });

  if (options?.persistCache !== false) {
    saveCachedUserChats(userId, merged);
  }
  return merged;
}

/**
 * Synchronizes any offline-created or offline-updated conversations, message deletions,
 * and pending messages to the authenticated Express/MongoDB API idempotently once
 * internet connectivity returns, without duplicating or losing messages.
 *
 * @param {string} userId
 * @returns {Promise<{ syncedChats: number, syncedMessages: number }>}
 */
export async function syncOfflineUserChatsToFirestore(userId) {
  if (!userId || String(userId).startsWith('guest-') || !isBrowserOnline()) {
    return { syncedChats: 0, syncedMessages: 0 };
  }

  if (activeSyncPromises.has(userId)) {
    return activeSyncPromises.get(userId);
  }

  const syncTask = (async () => {
    let syncedChats = 0;
    let syncedMessages = 0;

    try {
      // 1. Replay any pending offline conversation deletions via MongoDB API
      const pendingDeleted = getPendingDeletedChatIds(userId);
      if (pendingDeleted.length > 0) {
        const remainingDeletes = [];
        for (const delChatId of pendingDeleted) {
          try {
            await deleteConversation(userId, delChatId);
            syncedChats++;
          } catch (_) {
            remainingDeletes.push(delChatId);
          }
        }
        savePendingDeletedChatIds(userId, remainingDeletes);
      }

      const token = await resolveAuthToken();
      if (!token) {
        return { syncedChats, syncedMessages };
      }

      // 2. Replay any pending offline message deletions via MongoDB API
      const pendingMsgDeletes = getPendingDeletedMessagesMap(userId);
      for (const [delChatId, msgIds] of Object.entries(pendingMsgDeletes)) {
        if (!isBrowserOnline()) break;
        if (!Array.isArray(msgIds) || msgIds.length === 0) continue;
        try {
          const { res } = await authorizedApiFetch(
            `/api/messages?conversationId=${encodeURIComponent(delChatId)}`,
            {
              method: 'DELETE',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ conversationId: delChatId, messageIds: msgIds })
            }
          );
          if (res && (res.ok || res.status === 404 || res.status === 403)) {
            removePendingDeletedMessages(userId, delChatId, msgIds);
          }
        } catch (delErr) {
          console.warn('Deferred syncing message deletions to MongoDB:', delChatId, delErr?.message || delErr);
        }
      }

      // 3. Sync pending conversation metadata and pending messages to MongoDB API
      const localChats = getCachedUserChats(userId);

      for (const localChat of localChats) {
        if (!isBrowserOnline()) break;

        const localMessages = getCachedChatMessages(userId, localChat.id);
        const pendingMessages = sortMessagesChronologically(
          localMessages.filter(
            (m) => m && m.pendingSync && !m.isError && (m.sender === 'user' || m.sender === 'assistant')
          )
        );

        const needsMetaSync = Boolean(
          localChat.pendingSync ||
          localChat.pendingMetaSync ||
          localChat.createdOffline
        );

        if (needsMetaSync) {
          try {
            if (localChat.createdOffline || localChat.pendingSync) {
              const ok = await ensureParentConversationInMongo(localChat, localChat.mode || 'general');
              if (ok) {
                syncedChats++;
                upsertCachedUserChat(userId, {
                  id: localChat.id,
                  ...(localChat.storageSource === 'legacy-firestore'
                    ? { storageSource: 'hybrid', hasLegacyFirestore: true }
                    : {}),
                  pendingSync: pendingMessages.length > 0,
                  createdOffline: false,
                  pendingMetaSync: false
                });
              }
            } else if (localChat.pendingMetaSync) {
              const { res } = await authorizedApiFetch(
                `/api/conversations/${encodeURIComponent(localChat.id)}`,
                {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    title: localChat.title,
                    mode: localChat.mode,
                    isPinned: Boolean(localChat.isPinned)
                  })
                }
              );
              if (res?.status === 404 && localChat.storageSource === 'legacy-firestore') {
                const promoted = await ensureParentConversationInMongo(localChat, localChat.mode || 'general');
                if (promoted) {
                  syncedChats++;
                  upsertCachedUserChat(userId, {
                    id: localChat.id,
                    storageSource: 'hybrid',
                    hasLegacyFirestore: true,
                    pendingMetaSync: false
                  });
                }
              } else if (res?.ok) {
                syncedChats++;
                upsertCachedUserChat(userId, {
                  id: localChat.id,
                  pendingMetaSync: false
                });
              }
            }
          } catch (chatErr) {
            console.warn('Deferred syncing conversation metadata to MongoDB:', localChat.id, chatErr?.message || chatErr);
          }
        }

        // 4. Replay pending messages for this conversation via POST /api/messages (idempotent by message ID)
        if (pendingMessages.length > 0 && isBrowserOnline()) {
          for (const msg of pendingMessages) {
            if (!isBrowserOnline()) break;
            try {
              const targetMsg = msg.sender === 'assistant' ? normalizeAssistantMessage(msg) : msg;
              const clientTs =
                targetMsg.timestamp ||
                new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
              const createdAtMs =
                typeof targetMsg.createdAtMs === 'number' && Number.isFinite(targetMsg.createdAtMs)
                  ? targetMsg.createdAtMs
                  : Date.now();
              const sanitized = sanitizeMessageForStorage(targetMsg, clientTs, createdAtMs, {
                pendingSync: true,
                syncedToMongo: false
              });
              const payload = buildMongoMessagePayload(localChat.id, sanitized);

              let { res } = await authorizedApiFetch('/api/messages', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
              });

              if (res && res.status === 404) {
                const parentOk = await ensureParentConversationInMongo(localChat, sanitized.mode || 'general');
                if (parentOk) {
                  const retryRes = await authorizedApiFetch('/api/messages', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                  });
                  res = retryRes.res;
                }
              }

              if (res?.ok) {
                const resData = await res.json().catch(() => ({}));
                const savedCreatedMs = resData?.message?.createdAt
                  ? new Date(resData.message.createdAt).getTime()
                  : NaN;
                upsertCachedChatMessage(userId, localChat.id, {
                  ...sanitized,
                  createdAtMs: Number.isFinite(savedCreatedMs) ? savedCreatedMs : sanitized.createdAtMs,
                  pendingSync: false,
                  syncedToMongo: true
                });
                syncedMessages++;
              } else {
                console.warn('Deferred syncing message until next online cycle:', msg?.id, res?.status);
              }
            } catch (msgErr) {
              console.warn('Deferred syncing message until next online cycle:', msg?.id, msgErr?.message || msgErr);
            }
          }

          const stillPending = getCachedChatMessages(userId, localChat.id).some((m) => m.pendingSync);
          upsertCachedUserChat(userId, {
            id: localChat.id,
            ...(localChat.storageSource === 'legacy-firestore'
              ? { storageSource: 'hybrid', hasLegacyFirestore: true }
              : {}),
            pendingSync: stillPending,
            createdOffline: false
          });
        }
      }

      notifyConversationListeners(userId);
    } finally {
      activeSyncPromises.delete(userId);
    }

    return { syncedChats, syncedMessages };
  })();

  activeSyncPromises.set(userId, syncTask);
  return syncTask;
}

/**
 * Reads unmigrated legacy conversation metadata (`users/{userId}/chats`) from Cloud Firestore
 * in strictly READ-ONLY mode. Never creates, updates, pins, renames, or deletes Firestore docs.
 *
 * @param {string} userId
 * @returns {Promise<{ loaded: boolean, chats: Array }>}
 */
async function readLegacyFirestoreConversations(userId) {
  if (!userId || String(userId).startsWith('guest-')) {
    return { loaded: false, chats: [] };
  }

  const timeoutMs = getFirestoreTimeoutMs();

  if (customLegacyFirestoreChatsLoader) {
    try {
      const rawList = await withBoundedTimeout(
        Promise.resolve().then(() => customLegacyFirestoreChatsLoader(userId)),
        timeoutMs,
        'loadLegacyFirestoreChats'
      );
      if (!Array.isArray(rawList)) {
        return { loaded: true, chats: [] };
      }
      const mapped = rawList
        .map((item) => {
          if (!item || typeof item !== 'object') return null;
          return mapLegacyFirestoreConversationToChat(item.id || item._id, item);
        })
        .filter(Boolean);
      return { loaded: true, chats: mapped };
    } catch (err) {
      console.warn('Read-only legacy Firestore conversation discovery skipped:', err?.message || err);
      return { loaded: false, chats: [] };
    }
  }

  if (!db || !isFirebaseConfigured() || !isBrowserOnline()) {
    return { loaded: false, chats: [] };
  }

  try {
    const chatsRef = collection(db, 'users', userId, 'chats');
    const snapshot = await withBoundedTimeout(
      getDocs(chatsRef),
      timeoutMs,
      'loadLegacyFirestoreChats'
    );
    const legacyChats = [];

    snapshot.forEach((docSnap) => {
      const mapped = mapLegacyFirestoreConversationToChat(docSnap.id, docSnap.data());
      if (mapped) {
        legacyChats.push(mapped);
      }
    });

    return { loaded: true, chats: legacyChats };
  } catch (err) {
    console.warn('Read-only legacy Firestore conversation discovery skipped:', err?.message || err);
    return { loaded: false, chats: [] };
  }
}

/**
 * Lists conversations for the authenticated user from MongoDB API, deterministically merged
 * with read-only legacy Firestore conversations and local cache fallback.
 * @param {string} userId
 * @param {Object} [options]
 * @returns {Promise<Array>}
 */
export async function listConversations(userId, options = {}) {
  if (!userId) return [];
  const isGuest = String(userId).startsWith('guest-');
  if (isGuest || !isBrowserOnline()) {
    return getCachedUserChats(userId);
  }

  try {
    const initialToken = await resolveAuthToken(false);
    if (!initialToken) {
      return getCachedUserChats(userId);
    }

    const hasFilterOrSlice = Boolean(options?.mode || options?.limit || options?.skip);
    const queryParams = new URLSearchParams();
    if (options.mode) queryParams.set('mode', options.mode);
    const qs = queryParams.toString();

    const [{ res }, legacyOutcome] = await Promise.all([
      authorizedApiFetch(`/api/conversations${qs ? '?' + qs : ''}`, { method: 'GET' }),
      readLegacyFirestoreConversations(userId)
    ]);

    if (!res) {
      return getCachedUserChats(userId);
    }

    if (!res.ok) {
      throw new Error(`Failed to list conversations (${res.status})`);
    }

    const data = await res.json();
    if (Array.isArray(data?.conversations)) {
      const mapped = data.conversations.map(mapMongoConversationToChat).filter(Boolean);
      if (!hasFilterOrSlice) {
        return mergeCloudAndLocalChats(userId, mapped, legacyOutcome, { persistCache: true });
      }

      const modeFilter = options.mode ? String(options.mode).trim().toLowerCase() : null;
      const filteredLegacy = modeFilter
        ? legacyOutcome.chats.filter((c) => (c.mode || 'general') === modeFilter)
        : legacyOutcome.chats;
      let merged = mergeCloudAndLocalChats(
        userId,
        mapped,
        { loaded: legacyOutcome.loaded, chats: filteredLegacy },
        { persistCache: false }
      );
      if (modeFilter) {
        merged = merged.filter((c) => (c.mode || 'general') === modeFilter);
      }
      const skipCount =
        Number.isFinite(Number(options.skip)) && Number(options.skip) > 0
          ? Number(options.skip)
          : 0;
      const limitCount =
        Number.isFinite(Number(options.limit)) && Number(options.limit) > 0
          ? Number(options.limit)
          : 0;
      if (skipCount > 0) merged = merged.slice(skipCount);
      if (limitCount > 0) merged = merged.slice(0, limitCount);
      return merged;
    }
    return getCachedUserChats(userId);
  } catch (err) {
    if (isOfflineOrNetworkError(err)) {
      return getCachedUserChats(userId);
    }
    throw err;
  }
}

/**
 * Subscribes in real-time to the authenticated user's conversations list.
 * Hydrates immediately from local cache and syncs with the authenticated MongoDB API
 * alongside read-only legacy Firestore conversation discovery.
 *
 * @param {string} userId
 * @param {(chats: Array) => void} onUpdate
 * @param {(err: Error) => void} onError
 * @returns {() => void} Unsubscribe function
 */
export function subscribeToUserChats(userId, onUpdate, onError = null) {
  if (!userId) {
    if (onUpdate) onUpdate([]);
    return () => {};
  }

  const isGuest = String(userId).startsWith('guest-');
  const cached = getCachedUserChats(userId);

  // Emit cached conversations immediately so offline/slow startups never show an empty or stuck sidebar
  if (cached.length > 0) {
    onUpdate(cached);
  }

  if (isGuest || !isBrowserOnline()) {
    if (cached.length === 0) {
      onUpdate([]);
    }
    return () => {};
  }

  if (!activeSubscriptions.has(userId)) {
    activeSubscriptions.set(userId, new Set());
  }
  const listenerSet = activeSubscriptions.get(userId);
  listenerSet.add(onUpdate);

  let isSubscribed = true;

  async function fetchFromMongo() {
    try {
      const initialToken = await resolveAuthToken(false);
      if (!initialToken || !isSubscribed) return;

      const [{ res }, legacyOutcome] = await Promise.all([
        authorizedApiFetch('/api/conversations', { method: 'GET' }),
        readLegacyFirestoreConversations(userId)
      ]);

      if (!res || !isSubscribed) return;

      if (!res.ok) {
        throw new Error(`Failed to fetch conversations (${res.status})`);
      }

      const data = await res.json();
      if (!isSubscribed) return;

      if (Array.isArray(data?.conversations)) {
        const mapped = data.conversations.map(mapMongoConversationToChat).filter(Boolean);
        const merged = mergeCloudAndLocalChats(userId, mapped, legacyOutcome, { persistCache: true });
        onUpdate(merged);
      }
    } catch (err) {
      if (isOfflineOrNetworkError(err)) {
        if (isSubscribed) onUpdate(getCachedUserChats(userId));
        return;
      }
      console.warn('Error fetching user conversations from MongoDB API:', err?.message || err);
      if (onError && isSubscribed) onError(err);
    }
  }

  void fetchFromMongo();

  return () => {
    isSubscribed = false;
    listenerSet.delete(onUpdate);
    if (listenerSet.size === 0) {
      activeSubscriptions.delete(userId);
    }
  };
}

/**
 * Reads unmigrated legacy messages for a conversation from Cloud Firestore in read-only mode.
 * Never modifies, deletes, or bulk-migrates Firestore documents.
 *
 * @param {string} userId
 * @param {string} chatId
 * @returns {Promise<{ loaded: boolean, messages: Array }>}
 */
async function readLegacyFirestoreMessages(userId, chatId) {
  if (!userId || !chatId || String(userId).startsWith('guest-')) {
    return { loaded: false, messages: [] };
  }

  const timeoutMs = getFirestoreTimeoutMs();

  if (customLegacyFirestoreLoader) {
    try {
      const rawList = await withBoundedTimeout(
        Promise.resolve().then(() => customLegacyFirestoreLoader(userId, chatId)),
        timeoutMs,
        'loadLegacyFirestoreMessages'
      );
      if (!Array.isArray(rawList)) {
        return { loaded: true, messages: [] };
      }
      const mapped = rawList
        .filter((item) => item && item.id)
        .map((data) => {
          const createdAtMs =
            typeof data.createdAtMs === 'number'
              ? data.createdAtMs
              : data.createdAt?.toMillis
                ? data.createdAt.toMillis()
                : typeof data.createdAt === 'number'
                  ? data.createdAt
                  : data.createdAt
                    ? new Date(data.createdAt).getTime()
                    : undefined;
          const msg = {
            id: data.id,
            sender: data.sender,
            content: typeof data.content === 'string' ? data.content : '',
            modelUsed: data.modelUsed || null,
            provider: data.provider || null,
            mode: data.mode || undefined,
            responseTimeMs: typeof data.responseTimeMs === 'number' ? data.responseTimeMs : null,
            parentMessageId: data.parentMessageId || null,
            activeAlternativeId: data.activeAlternativeId || null,
            alternatives: Array.isArray(data.alternatives) ? data.alternatives : [],
            attachments: Array.isArray(data.attachments) ? data.attachments : [],
            referencedAttachments: Array.isArray(data.referencedAttachments) ? data.referencedAttachments : [],
            isStopped: Boolean(data.isStopped),
            isInterrupted: Boolean(data.isInterrupted),
            createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : undefined,
            timestamp:
              data.clientTimestamp ||
              data.timestamp ||
              (Number.isFinite(createdAtMs)
                ? new Date(createdAtMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                : ''),
            pendingSync: false,
            syncedToMongo: false
          };
          return msg.sender === 'assistant' ? normalizeAssistantMessage(msg) : msg;
        });
      return { loaded: true, messages: mapped };
    } catch (err) {
      console.warn('Legacy Firestore loader warning:', err?.message || err);
      return { loaded: false, messages: [] };
    }
  }

  if (!db || !isFirebaseConfigured() || !isBrowserOnline()) {
    return { loaded: false, messages: [] };
  }

  try {
    const messagesRef = collection(db, 'users', userId, 'chats', chatId, 'messages');
    const q = query(messagesRef, orderBy('createdAt', 'asc'));
    const snapshot = await withBoundedTimeout(
      getDocs(q),
      timeoutMs,
      'loadLegacyFirestoreMessages'
    );
    const legacyMessages = [];

    snapshot.forEach((docSnap) => {
      const data = docSnap.data();
      const createdAtMs = data.createdAt?.toMillis
        ? data.createdAt.toMillis()
        : typeof data.createdAtMs === 'number'
          ? data.createdAtMs
          : undefined;
      const msg = {
        id: docSnap.id,
        sender: data.sender,
        content: typeof data.content === 'string' ? data.content : '',
        modelUsed: data.modelUsed || null,
        provider: data.provider || null,
        mode: data.mode || undefined,
        responseTimeMs: typeof data.responseTimeMs === 'number' ? data.responseTimeMs : null,
        parentMessageId: data.parentMessageId || null,
        activeAlternativeId: data.activeAlternativeId || null,
        alternatives: Array.isArray(data.alternatives) ? data.alternatives : [],
        attachments: Array.isArray(data.attachments) ? data.attachments : [],
        referencedAttachments: Array.isArray(data.referencedAttachments) ? data.referencedAttachments : [],
        isStopped: Boolean(data.isStopped),
        isInterrupted: Boolean(data.isInterrupted),
        createdAtMs,
        timestamp:
          data.clientTimestamp ||
          (data.createdAt?.toDate
            ? data.createdAt.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            : ''),
        pendingSync: false,
        syncedToMongo: false
      };
      legacyMessages.push(msg.sender === 'assistant' ? normalizeAssistantMessage(msg) : msg);
    });

    return { loaded: true, messages: legacyMessages };
  } catch (err) {
    console.warn('Read-only legacy Firestore message fallback skipped:', err?.message || err);
    return { loaded: false, messages: [] };
  }
}

/**
 * Loads all messages for a specific conversation via the authenticated Express/MongoDB API
 * (/api/messages), ordered chronologically.
 * Safely merges unmigrated legacy Firestore messages (read-only) and unsynced local messages
 * by deterministic message ID without duplicates, and preserves guest/offline local behavior.
 *
 * @param {string} userId
 * @param {string} chatId
 * @returns {Promise<Array>}
 */
export async function loadConversationMessages(userId, chatId) {
  if (!userId || !chatId) {
    return [];
  }

  const isGuest = String(userId).startsWith('guest-');
  const localMessages = getCachedChatMessages(userId, chatId);

  if (isGuest || !isBrowserOnline()) {
    return ensureConversationAlternatives(sortMessagesChronologically(localMessages));
  }

  const deletedSet = new Set(getDeletedMessageTombstones(userId, chatId));
  let mongoMessages = [];
  let mongoLoaded = false;
  let mongoNotFound = false;
  let mongoNetworkFallback = false;

  try {
    const { res, token } = await authorizedApiFetch(
      `/api/messages?conversationId=${encodeURIComponent(chatId)}&sort=asc`,
      { method: 'GET' }
    );

    if (!token || !res) {
      return ensureConversationAlternatives(sortMessagesChronologically(localMessages));
    }

    if (res.status === 401 || res.status === 403 || res.status === 400) {
      const errorData = await res.json().catch(() => ({}));
      const apiErr = new Error(errorData.error || `Access denied while loading messages (${res.status})`);
      apiErr.status = res.status;
      apiErr.code = errorData.code || 'MESSAGE_LOAD_DENIED';
      throw apiErr;
    }

    if (res.status === 404) {
      mongoNotFound = true;
    } else if (res.ok) {
      const data = await res.json().catch(() => ({}));
      if (Array.isArray(data?.messages)) {
        mongoMessages = data.messages.map(mapMongoMessageToUiMessage).filter(Boolean);
      }
      mongoLoaded = true;
    } else {
      mongoNetworkFallback = true;
    }
  } catch (err) {
    if (err?.status === 400 || err?.status === 401 || err?.status === 403) {
      throw err;
    }
    if (isOfflineOrNetworkError(err)) {
      mongoNetworkFallback = true;
    } else {
      throw err;
    }
  }

  // Skip legacy Firestore message lookup when conversation is reliably confirmed MongoDB-only
  const cachedChat = getCachedUserChats(userId).find((c) => c.id === chatId);
  const canSkipLegacyMessages =
    mongoLoaded &&
    cachedChat?.hasLegacyFirestore === false &&
    !(customLegacyFirestoreLoader && !customLegacyFirestoreChatsLoader);

  // Read-only compatibility merge with any legacy messages still stored in Firestore
  const legacyResult = canSkipLegacyMessages
    ? { loaded: true, messages: [] }
    : await readLegacyFirestoreMessages(userId, chatId);

  if (mongoNetworkFallback && !legacyResult.loaded) {
    console.warn('Offline/network fallback: loaded conversation messages from local cache:', chatId);
    return ensureConversationAlternatives(
      sortMessagesChronologically(localMessages.filter((m) => m?.id && !deletedSet.has(m.id)))
    );
  }

  // Deterministic merge by message ID (MongoDB overrides legacy Firestore; pendingSync local overrides cloud)
  const byId = new Map();

  for (const legacyMsg of legacyResult.messages) {
    if (!legacyMsg?.id || deletedSet.has(legacyMsg.id)) continue;
    byId.set(legacyMsg.id, legacyMsg);
  }

  for (const mongoMsg of mongoMessages) {
    if (!mongoMsg?.id || deletedSet.has(mongoMsg.id)) continue;
    byId.set(mongoMsg.id, mongoMsg);
  }

  for (const lm of localMessages) {
    if (!lm?.id || deletedSet.has(lm.id)) continue;
    if (lm.pendingSync) {
      byId.set(lm.id, lm);
    } else if (!byId.has(lm.id)) {
      if (
        mongoNetworkFallback ||
        (!lm.syncedToMongo && !legacyResult.loaded && mongoNotFound)
      ) {
        byId.set(lm.id, lm);
      }
    }
  }

  const sorted = sortMessagesChronologically(Array.from(byId.values()));
  const normalized = ensureConversationAlternatives(sorted);
  saveCachedChatMessages(userId, chatId, normalized);
  return normalized;
}
