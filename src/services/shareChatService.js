import {
  doc,
  setDoc,
  getDoc,
  writeBatch,
  serverTimestamp,
} from 'firebase/firestore';
import { db, auth, isFirebaseConfigured, isBrowserOnline } from '../config/firebaseConfig.js';
import {
  orderConversationMessages,
  ensureConversationAlternatives,
} from './alternativeResponseService.js';
import {
  upsertCachedUserChat,
  saveCachedChatMessages,
  getCachedUserChats,
  getCachedChatMessages,
  generateLocalChatId,
  buildFirestoreMessagePayload,
} from './chatStorageService.js';

/**
 * Firestore hard limit is 1,048,576 bytes (1 MiB).
 * We enforce a conservative 900 KB safety ceiling to account for Firestore
 * document key paths, index entries, and serverTimestamp representation.
 */
export const FIRESTORE_MAX_DOCUMENT_BYTES = 1048576;
export const MAX_SHARED_SNAPSHOT_BYTES = 900 * 1024; // 921,600 bytes
export const MAX_SHARED_MESSAGE_COUNT = 500;
export const MAX_SHARED_MESSAGE_CONTENT_LENGTH = 100000;
export const MAX_SHARED_TITLE_LENGTH = 120;
export const SHARE_ID_LENGTH = 24;

export const ALLOWED_CHAT_MODES = ['general', 'coding', 'writing', 'learning'];

export const ALLOWED_SHARED_MESSAGE_KEYS = [
  'id',
  'sender',
  'content',
  'modelUsed',
  'provider',
  'mode',
  'responseTimeMs',
  'parentMessageId',
  'interactionId',
  'activeAlternativeId',
  'alternatives',
  'attachments',
  'referencedAttachments',
  'createdAtMs',
  'clientTimestamp',
  'timestamp',
];

const ALLOWED_SHARED_MESSAGE_KEY_SET = new Set(ALLOWED_SHARED_MESSAGE_KEYS);

const URL_SAFE_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

const SHARE_ID_REGEX = /^[a-zA-Z0-9_-]{12,128}$/;

// Track in-flight publication requests by chat ID to prevent duplicate concurrent writes
const inFlightShareRequests = new Set();

/**
 * Custom error class for Share Chat validation and publication failures.
 */
export class ShareChatError extends Error {
  constructor(message, code = 'SHARE_CHAT_ERROR') {
    super(message);
    this.name = 'ShareChatError';
    this.code = code;
  }
}

/**
 * Generates a cryptographically strong, URL-safe share identifier.
 * Uses Web Crypto API (`crypto.getRandomValues`) with 64-character URL-safe alphabet
 * (unbiased bitmask `byte & 63`). Never uses `Math.random()`.
 *
 * @param {number} [length=SHARE_ID_LENGTH]
 * @returns {string}
 */
export function generateShareId(length = SHARE_ID_LENGTH) {
  const safeLength =
    Number.isInteger(length) && length >= 12 && length <= 128
      ? length
      : SHARE_ID_LENGTH;

  const cryptoObj =
    typeof globalThis !== 'undefined' && globalThis.crypto
      ? globalThis.crypto
      : null;

  if (!cryptoObj || typeof cryptoObj.getRandomValues !== 'function') {
    throw new ShareChatError(
      'Cryptographic random number generator is unavailable in this environment.',
      'CRYPTO_UNAVAILABLE'
    );
  }

  const randomBytes = new Uint8Array(safeLength);
  cryptoObj.getRandomValues(randomBytes);

  let shareId = '';
  for (let i = 0; i < safeLength; i += 1) {
    // 64 is an exact power of 2, so `randomBytes[i] & 63` has zero modulo bias
    shareId += URL_SAFE_ALPHABET[randomBytes[i] & 63];
  }

  if (!SHARE_ID_REGEX.test(shareId)) {
    throw new ShareChatError(
      'Generated share ID failed format validation.',
      'INVALID_SHARE_ID'
    );
  }

  return shareId;
}

/**
 * Validates whether a share ID matches the canonical Firestore rule format.
 *
 * @param {string} shareId
 * @returns {boolean}
 */
export function isValidShareId(shareId) {
  return typeof shareId === 'string' && SHARE_ID_REGEX.test(shareId);
}

/**
 * Checks whether a user is eligible to create a shared chat link.
 * Requires a signed-in, non-anonymous Firebase user (rejects Guest Mode,
 * anonymous Firebase sessions, and unauthenticated visitors).
 *
 * @param {Object|null} user
 * @returns {boolean}
 */
export function isEligibleShareUser(user) {
  if (!user || typeof user !== 'object') return false;
  const uid = typeof user.uid === 'string' ? user.uid.trim() : '';
  if (!uid) return false;
  if (user.isAnonymous === true) return false;
  if (uid.startsWith('guest-')) return false;
  return true;
}

/**
 * Checks whether a specific conversation and user state can currently be shared.
 *
 * @param {Object} params
 * @param {Object|null} params.user
 * @param {Object|null} params.chat
 * @param {Array} params.messages
 * @param {boolean} [params.isLoading=false]
 * @param {boolean} [params.isSharedPreview=false]
 * @returns {{ eligible: boolean, reason: string|null }}
 */
export function evaluateShareEligibility({
  user,
  chat,
  messages,
  isLoading = false,
  isSharedPreview = false,
} = {}) {
  if (isSharedPreview || chat?.isSharedPreview === true) {
    return {
      eligible: false,
      reason: 'Shared conversation previews cannot be re-shared until imported into your account.',
    };
  }

  if (!isEligibleShareUser(user)) {
    return {
      eligible: false,
      reason: 'Please sign in with an Orvix account to share conversations. Guest Mode cannot create public links.',
    };
  }

  if (!chat || typeof chat !== 'object' || typeof chat.id !== 'string' || !chat.id.trim()) {
    return {
      eligible: false,
      reason: 'Conversation must be saved before it can be shared.',
    };
  }

  if (String(chat.id).startsWith('temp-') || String(chat.id).startsWith('shared-preview-')) {
    return {
      eligible: false,
      reason: 'Temporary conversations cannot be shared until saved to your chat history.',
    };
  }

  if (isLoading) {
    return {
      eligible: false,
      reason: 'Please wait for the current AI response to finish before sharing.',
    };
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    return {
      eligible: false,
      reason: 'Cannot share an empty conversation.',
    };
  }

  const hasStreamingMessage = messages.some((m) => m && m.isStreaming === true);
  if (hasStreamingMessage) {
    return {
      eligible: false,
      reason: 'Please wait for the current AI response to finish before sharing.',
    };
  }

  const shareableMessages = messages.filter(
    (m) => m && typeof m === 'object' && !m.isError && m.sender !== 'error'
  );
  if (shareableMessages.length === 0) {
    return {
      eligible: false,
      reason: 'Cannot share a conversation containing only error messages.',
    };
  }

  return { eligible: true, reason: null };
}

/**
 * Resolves the canonical base URL for share links.
 * Checks configured Vite environment variables first, then `window.location.origin`.
 *
 * @param {string} [overrideBaseUrl]
 * @returns {string}
 */
export function resolveShareBaseUrl(overrideBaseUrl) {
  if (typeof overrideBaseUrl === 'string' && overrideBaseUrl.trim()) {
    return overrideBaseUrl.trim().replace(/\/+$/, '');
  }

  let envUrl = '';
  try {
    envUrl =
      import.meta.env?.VITE_PUBLIC_APP_URL ||
      import.meta.env?.VITE_APP_URL ||
      import.meta.env?.VITE_SITE_URL ||
      '';
  } catch {
    envUrl = '';
  }

  if (typeof envUrl === 'string' && envUrl.trim()) {
    return envUrl.trim().replace(/\/+$/, '');
  }

  if (typeof window !== 'undefined' && window.location?.origin) {
    return String(window.location.origin).replace(/\/+$/, '');
  }

  return 'https://orvix.ai';
}

/**
 * Builds the canonical shareable URL for a given shareId.
 * Format: {baseUrl}/share/{shareId}
 *
 * @param {string} shareId
 * @param {string} [baseUrl]
 * @returns {string}
 */
export function buildShareChatUrl(shareId, baseUrl) {
  if (!isValidShareId(shareId)) {
    throw new ShareChatError('Cannot build share URL: invalid share ID.', 'INVALID_SHARE_ID');
  }
  const resolvedBase = resolveShareBaseUrl(baseUrl);
  return `${resolvedBase}/share/${shareId}`;
}

/**
 * Sanitizes an attachment extraction record so only safe plain-text extraction
 * metadata is retained and any binary/local fields are stripped.
 *
 * @param {Object|null} extraction
 * @returns {Object|null}
 */
function sanitizeAttachmentExtraction(extraction) {
  if (!extraction || typeof extraction !== 'object' || Array.isArray(extraction)) {
    return null;
  }

  const clean = {};

  if (typeof extraction.status === 'string') {
    clean.status = extraction.status.slice(0, 64);
  }
  if (typeof extraction.type === 'string') {
    clean.type = extraction.type.slice(0, 64);
  }
  if (typeof extraction.format === 'string') {
    clean.format = extraction.format.slice(0, 32);
  }
  if (typeof extraction.text === 'string') {
    clean.text = extraction.text.slice(0, 50000);
  }
  if (typeof extraction.charCount === 'number' && Number.isFinite(extraction.charCount)) {
    clean.charCount = Math.max(0, Math.trunc(extraction.charCount));
  }
  if (typeof extraction.wordCount === 'number' && Number.isFinite(extraction.wordCount)) {
    clean.wordCount = Math.max(0, Math.trunc(extraction.wordCount));
  }
  if (typeof extraction.totalWords === 'number' && Number.isFinite(extraction.totalWords)) {
    clean.totalWords = Math.max(0, Math.trunc(extraction.totalWords));
  }
  if (typeof extraction.totalCharacters === 'number' && Number.isFinite(extraction.totalCharacters)) {
    clean.totalCharacters = Math.max(0, Math.trunc(extraction.totalCharacters));
  }
  if (typeof extraction.lineCount === 'number' && Number.isFinite(extraction.lineCount)) {
    clean.lineCount = Math.max(0, Math.trunc(extraction.lineCount));
  }
  if (typeof extraction.confidence === 'number' && Number.isFinite(extraction.confidence)) {
    clean.confidence = Math.round(extraction.confidence * 100) / 100;
  }
  if (typeof extraction.hasText === 'boolean') {
    clean.hasText = extraction.hasText;
  }
  if (typeof extraction.truncated === 'boolean') {
    clean.truncated = extraction.truncated;
  }
  if (Array.isArray(extraction.warnings)) {
    clean.warnings = extraction.warnings
      .filter((w) => typeof w === 'string')
      .slice(0, 10)
      .map((w) => w.slice(0, 200));
  }

  return Object.keys(clean).length > 0 ? clean : null;
}

/**
 * Sanitizes a single attachment metadata item for public sharing.
 * Strictly strips `Blob`, `File`, `ArrayBuffer`, `base64`, `dataUrl`, `previewUrl`,
 * `url`, local filesystem paths, IndexedDB references, or private tokens.
 *
 * @param {Object} att
 * @param {number} index
 * @returns {Object|null}
 */
export function sanitizeAttachmentForShare(att, index = 0) {
  if (!att || typeof att !== 'object' || Array.isArray(att)) {
    return null;
  }

  // Never serialize raw Blob or File instances directly
  if (typeof Blob !== 'undefined' && att instanceof Blob) {
    return null;
  }

  const rawId = typeof att.id === 'string' && att.id.trim() ? att.id.trim() : `att_${index}`;
  const rawName =
    (typeof att.name === 'string' && att.name.trim()) ||
    (typeof att.originalName === 'string' && att.originalName.trim()) ||
    (typeof att.filename === 'string' && att.filename.trim()) ||
    'Attachment';

  const clean = {
    id: rawId.slice(0, 128),
    name: rawName.slice(0, 255),
    originalName: (typeof att.originalName === 'string' && att.originalName.trim()
      ? att.originalName.trim()
      : rawName
    ).slice(0, 255),
    size:
      typeof att.size === 'number' && Number.isFinite(att.size) && att.size >= 0
        ? Math.trunc(att.size)
        : 0,
    type:
      typeof att.type === 'string' && att.type.trim()
        ? att.type.trim().slice(0, 128)
        : typeof att.mimeType === 'string' && att.mimeType.trim()
        ? att.mimeType.trim().slice(0, 128)
        : 'application/octet-stream',
  };

  if (typeof att.extension === 'string' && att.extension.trim()) {
    clean.extension = att.extension.trim().slice(0, 32);
  }
  if (typeof att.format === 'string' && att.format.trim()) {
    clean.format = att.format.trim().slice(0, 32);
  }
  if (typeof att.category === 'string' && att.category.trim()) {
    clean.category = att.category.trim().slice(0, 32);
  }
  if (typeof att.uploadedAt === 'string' && att.uploadedAt.trim()) {
    clean.uploadedAt = att.uploadedAt.trim().slice(0, 64);
  }

  const sanitizedExtraction = sanitizeAttachmentExtraction(att.extraction);
  if (sanitizedExtraction) {
    clean.extraction = sanitizedExtraction;
  }

  return clean;
}

/**
 * Sanitizes an assistant alternative response entry for public sharing.
 *
 * @param {Object} alt
 * @param {number} index
 * @param {string} fallbackMode
 * @returns {Object|null}
 */
function sanitizeAlternativeForShare(alt, index = 0, fallbackMode = 'general') {
  if (!alt || typeof alt !== 'object' || Array.isArray(alt)) {
    return null;
  }
  if (typeof alt.content !== 'string') {
    return null;
  }
  if (alt.content.length > MAX_SHARED_MESSAGE_CONTENT_LENGTH) {
    throw new ShareChatError(
      `Alternative response #${index + 1} exceeds the maximum allowed message length.`,
      'MESSAGE_CONTENT_TOO_LARGE'
    );
  }

  const rawId = typeof alt.id === 'string' && alt.id.trim() ? alt.id.trim() : `alt_${index}`;
  const cleanAlt = {
    id: rawId.slice(0, 128),
    content: alt.content,
    modelUsed:
      typeof alt.modelUsed === 'string' && alt.modelUsed.trim()
        ? alt.modelUsed.trim().slice(0, 120)
        : null,
    provider:
      typeof alt.provider === 'string' && alt.provider.trim()
        ? alt.provider.trim().slice(0, 64)
        : null,
    mode: ALLOWED_CHAT_MODES.includes(alt.mode) ? alt.mode : fallbackMode,
    responseTimeMs:
      typeof alt.responseTimeMs === 'number' &&
      Number.isFinite(alt.responseTimeMs) &&
      alt.responseTimeMs >= 0
        ? Math.round(alt.responseTimeMs)
        : null,
    createdAtMs:
      typeof alt.createdAtMs === 'number' && Number.isFinite(alt.createdAtMs)
        ? Math.trunc(alt.createdAtMs)
        : null,
    clientTimestamp:
      typeof alt.clientTimestamp === 'string' && alt.clientTimestamp.trim()
        ? alt.clientTimestamp.trim().slice(0, 64)
        : typeof alt.timestamp === 'string' && alt.timestamp.trim()
        ? alt.timestamp.trim().slice(0, 64)
        : null,
  };

  return cleanAlt;
}

/**
 * Validates and sanitizes a single conversation message for the shared snapshot.
 * Enforces strict alignment with `isValidSharedMessageItem` in `firestore.rules`.
 * Rejects malformed messages rather than silently truncating or dropping them.
 *
 * @param {Object} msg
 * @param {number} index
 * @param {string} fallbackMode
 * @returns {Object}
 */
export function sanitizeMessageForShare(msg, index = 0, fallbackMode = 'general') {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    throw new ShareChatError(
      `Message at position ${index + 1} is invalid.`,
      'INVALID_MESSAGE_STRUCTURE'
    );
  }

  if (msg.isStreaming === true) {
    throw new ShareChatError(
      'Cannot share while an AI response is still streaming.',
      'STREAMING_IN_PROGRESS'
    );
  }

  // Validate sender
  const sender = msg.sender;
  if (sender !== 'user' && sender !== 'assistant') {
    throw new ShareChatError(
      `Message at position ${index + 1} has an invalid sender ("${String(sender)}"). Only "user" and "assistant" messages are permitted.`,
      'INVALID_MESSAGE_SENDER'
    );
  }

  // Validate id
  const rawId = typeof msg.id === 'string' ? msg.id.trim() : '';
  if (!rawId || rawId.length > 128) {
    throw new ShareChatError(
      `Message at position ${index + 1} is missing a valid message ID.`,
      'INVALID_MESSAGE_ID'
    );
  }

  // Validate content
  if (typeof msg.content !== 'string') {
    throw new ShareChatError(
      `Message at position ${index + 1} has non-string content.`,
      'INVALID_MESSAGE_CONTENT'
    );
  }

  if (msg.content.length > MAX_SHARED_MESSAGE_CONTENT_LENGTH) {
    throw new ShareChatError(
      `Message at position ${index + 1} exceeds the 100,000-character limit and cannot be shared without truncation.`,
      'MESSAGE_CONTENT_TOO_LARGE'
    );
  }

  const sanitizedAttachments = Array.isArray(msg.attachments)
    ? msg.attachments
        .map((att, attIdx) => sanitizeAttachmentForShare(att, attIdx))
        .filter(Boolean)
        .slice(0, 20)
    : null;

  const sanitizedReferencedAttachments = Array.isArray(msg.referencedAttachments)
    ? msg.referencedAttachments
        .map((att, attIdx) => sanitizeAttachmentForShare(att, attIdx))
        .filter(Boolean)
        .slice(0, 20)
    : null;

  const hasAttachments =
    (Array.isArray(sanitizedAttachments) && sanitizedAttachments.length > 0) ||
    (Array.isArray(sanitizedReferencedAttachments) && sanitizedReferencedAttachments.length > 0);

  if (msg.content.trim().length === 0 && !hasAttachments) {
    throw new ShareChatError(
      `Message at position ${index + 1} has empty content and no attachments.`,
      'EMPTY_MESSAGE_CONTENT'
    );
  }

  const resolvedMode = ALLOWED_CHAT_MODES.includes(msg.mode)
    ? msg.mode
    : ALLOWED_CHAT_MODES.includes(fallbackMode)
    ? fallbackMode
    : 'general';

  const sanitizedAlternatives =
    sender === 'assistant' && Array.isArray(msg.alternatives)
      ? msg.alternatives
          .map((alt, altIdx) => sanitizeAlternativeForShare(alt, altIdx, resolvedMode))
          .filter(Boolean)
          .slice(0, 20)
      : null;

  const clientTimestamp =
    typeof msg.clientTimestamp === 'string' && msg.clientTimestamp.trim()
      ? msg.clientTimestamp.trim().slice(0, 64)
      : typeof msg.timestamp === 'string' && msg.timestamp.trim()
      ? msg.timestamp.trim().slice(0, 64)
      : null;

  const createdAtMs =
    typeof msg.createdAtMs === 'number' && Number.isFinite(msg.createdAtMs)
      ? Math.trunc(msg.createdAtMs)
      : clientTimestamp && Number.isFinite(Date.parse(clientTimestamp))
      ? Date.parse(clientTimestamp)
      : null;

  const sanitizedMessage = {
    id: rawId,
    sender,
    content: msg.content,
    modelUsed:
      typeof msg.modelUsed === 'string' && msg.modelUsed.trim()
        ? msg.modelUsed.trim().slice(0, 120)
        : null,
    provider:
      typeof msg.provider === 'string' && msg.provider.trim()
        ? msg.provider.trim().slice(0, 64)
        : null,
    mode: resolvedMode,
    responseTimeMs:
      typeof msg.responseTimeMs === 'number' &&
      Number.isFinite(msg.responseTimeMs) &&
      msg.responseTimeMs >= 0
        ? Math.round(msg.responseTimeMs)
        : null,
    parentMessageId:
      typeof msg.parentMessageId === 'string' && msg.parentMessageId.trim()
        ? msg.parentMessageId.trim().slice(0, 128)
        : null,
    interactionId:
      typeof msg.interactionId === 'string' && msg.interactionId.trim()
        ? msg.interactionId.trim().slice(0, 128)
        : null,
    activeAlternativeId:
      typeof msg.activeAlternativeId === 'string' && msg.activeAlternativeId.trim()
        ? msg.activeAlternativeId.trim().slice(0, 128)
        : null,
    alternatives:
      sanitizedAlternatives && sanitizedAlternatives.length > 0
        ? sanitizedAlternatives
        : null,
    attachments:
      sanitizedAttachments && sanitizedAttachments.length > 0
        ? sanitizedAttachments
        : null,
    referencedAttachments:
      sanitizedReferencedAttachments && sanitizedReferencedAttachments.length > 0
        ? sanitizedReferencedAttachments
        : null,
    createdAtMs,
    clientTimestamp,
    timestamp: clientTimestamp,
  };

  // Final defensive check: ensure only whitelisted keys exist and no undefined values remain
  for (const key of Object.keys(sanitizedMessage)) {
    if (!ALLOWED_SHARED_MESSAGE_KEY_SET.has(key)) {
      delete sanitizedMessage[key];
    } else if (sanitizedMessage[key] === undefined) {
      sanitizedMessage[key] = null;
    }
  }

  return sanitizedMessage;
}

/**
 * Calculates the UTF-8 serialized byte size of a snapshot document payload.
 * Replaces Firestore `serverTimestamp()` sentinel with an ISO timestamp placeholder
 * for accurate byte measurement.
 *
 * @param {Object} snapshotPayload
 * @returns {number}
 */
export function calculateSnapshotByteSize(snapshotPayload) {
  const measurablePayload = {
    ...snapshotPayload,
    createdAt: new Date().toISOString(),
  };
  const jsonString = JSON.stringify(measurablePayload);
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(jsonString).length;
  }
  if (typeof Buffer !== 'undefined') {
    return Buffer.byteLength(jsonString, 'utf8');
  }
  return jsonString.length * 2;
}

/**
 * Normalizes and validates the complete conversation payload before writing to Firestore.
 * Pure helper that can be unit tested independently of Firestore network calls.
 *
 * @param {Object} params
 * @param {string} params.shareId
 * @param {Object} params.chat
 * @param {Array} params.messages
 * @returns {{ documentData: Object, byteSize: number }}
 */
export function buildValidatedSharedSnapshot({ shareId, chat, messages }) {
  if (!isValidShareId(shareId)) {
    throw new ShareChatError('Invalid share ID.', 'INVALID_SHARE_ID');
  }

  if (!chat || typeof chat !== 'object' || typeof chat.id !== 'string' || !chat.id.trim()) {
    throw new ShareChatError(
      'Conversation must be saved before sharing.',
      'INVALID_CHAT'
    );
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    throw new ShareChatError(
      'Cannot share an empty conversation.',
      'EMPTY_CONVERSATION'
    );
  }

  // Reject if any message is actively streaming
  if (messages.some((m) => m && m.isStreaming === true)) {
    throw new ShareChatError(
      'Please wait for the current AI response to finish before sharing.',
      'STREAMING_IN_PROGRESS'
    );
  }

  // Filter out transient UI error banners while keeping all real user & assistant messages
  const nonErrorMessages = messages.filter(
    (m) => m && typeof m === 'object' && !m.isError && m.sender !== 'error'
  );

  if (nonErrorMessages.length === 0) {
    throw new ShareChatError(
      'Cannot share a conversation containing only error messages.',
      'EMPTY_CONVERSATION'
    );
  }

  if (nonErrorMessages.length > MAX_SHARED_MESSAGE_COUNT) {
    throw new ShareChatError(
      `This conversation has ${nonErrorMessages.length} messages, exceeding the maximum limit of ${MAX_SHARED_MESSAGE_COUNT} messages per shared link. Please share a shorter conversation.`,
      'SNAPSHOT_TOO_MANY_MESSAGES'
    );
  }

  const safeMode = ALLOWED_CHAT_MODES.includes(chat.mode) ? chat.mode : 'general';
  const rawTitle = typeof chat.title === 'string' && chat.title.trim() ? chat.title.trim() : 'Shared Chat';
  const safeTitle = rawTitle.slice(0, MAX_SHARED_TITLE_LENGTH);

  // Pre-validate every raw message before normalization so non-string content or invalid senders are never coerced
  nonErrorMessages.forEach((rawMsg, idx) => {
    if (!rawMsg || typeof rawMsg !== 'object' || Array.isArray(rawMsg)) {
      throw new ShareChatError(
        `Message at position ${idx + 1} is invalid.`,
        'INVALID_MESSAGE_STRUCTURE'
      );
    }
    if (rawMsg.sender !== 'user' && rawMsg.sender !== 'assistant') {
      throw new ShareChatError(
        `Message at position ${idx + 1} has an invalid sender ("${String(rawMsg.sender)}"). Only "user" and "assistant" messages are permitted.`,
        'INVALID_MESSAGE_SENDER'
      );
    }
    if (typeof rawMsg.content !== 'string') {
      throw new ShareChatError(
        `Message at position ${idx + 1} has non-string content.`,
        'INVALID_MESSAGE_CONTENT'
      );
    }
  });

  // Order messages chronologically and normalize alternatives
  const orderedMessages = orderConversationMessages(
    ensureConversationAlternatives(nonErrorMessages)
  );

  // Validate and sanitize EVERY message in the conversation
  const sanitizedMessages = orderedMessages.map((msg, idx) =>
    sanitizeMessageForShare(msg, idx, safeMode)
  );

  if (sanitizedMessages.length === 0) {
    throw new ShareChatError(
      'No valid messages available to share.',
      'EMPTY_CONVERSATION'
    );
  }

  const documentData = {
    id: shareId,
    title: safeTitle,
    mode: safeMode,
    createdAt: serverTimestamp(),
    messageCount: sanitizedMessages.length,
    messages: sanitizedMessages,
  };

  const byteSize = calculateSnapshotByteSize(documentData);
  if (byteSize > MAX_SHARED_SNAPSHOT_BYTES) {
    throw new ShareChatError(
      'This conversation is too large to share as a single link. Please try sharing a shorter conversation.',
      'SNAPSHOT_TOO_LARGE'
    );
  }

  return { documentData, byteSize };
}

/**
 * Bounded timeout wrapper for Firestore operations.
 */
function withPublishTimeout(promise, ms = 12000) {
  let timerId;
  const timeoutPromise = new Promise((_, reject) => {
    timerId = setTimeout(() => {
      reject(
        new ShareChatError(
          'Publishing the shared link timed out. Please check your connection and try again.',
          'PUBLISH_TIMEOUT'
        )
      );
    }, ms);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timerId);
  });
}

/**
 * Publishes the entire active conversation as an immutable shared snapshot
 * at `sharedChats/{shareId}` and returns the generated share metadata.
 *
 * @param {Object} chat - Active chat metadata object (`{ id, title, mode, ... }`)
 * @param {Array} messages - Complete list of messages in the active conversation
 * @param {Object} [options]
 * @param {Object} [options.user] - Current authenticated user (defaults to `auth.currentUser`)
 * @param {Object} [options.firestoreDb] - Optional Firestore instance override for testing
 * @param {Function} [options.setDocImpl] - Optional `setDoc` override for testing
 * @param {Function} [options.docImpl] - Optional `doc` override for testing
 * @param {string} [options.baseUrl] - Optional base URL override
 * @param {boolean} [options.isSharedPreview=false] - Whether currently viewing a temporary shared preview
 * @returns {Promise<{ shareId: string, shareUrl: string, title: string, mode: string, messageCount: number, byteSize: number }>}
 */
export async function createSharedChatSnapshot(chat, messages, options = {}) {
  const effectiveUser = options.user !== undefined ? options.user : auth?.currentUser;
  const eligibility = evaluateShareEligibility({
    user: effectiveUser,
    chat,
    messages,
    isLoading: Boolean(options.isLoading),
    isSharedPreview: Boolean(options.isSharedPreview),
  });

  if (!eligibility.eligible) {
    throw new ShareChatError(
      eligibility.reason || 'You are not eligible to share this conversation.',
      'NOT_ELIGIBLE'
    );
  }

  // Also ensure Firebase Auth session matches when using live Firebase
  if (!options.setDocImpl) {
    if (!isFirebaseConfigured || !db) {
      throw new ShareChatError(
        'Cloud sharing is currently unavailable because Firebase is not configured.',
        'FIREBASE_UNAVAILABLE'
      );
    }
    const liveAuthUser = auth?.currentUser;
    if (!isEligibleShareUser(liveAuthUser)) {
      throw new ShareChatError(
        'Please sign in with an Orvix account to share conversations.',
        'AUTH_REQUIRED'
      );
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      throw new ShareChatError(
        'You appear to be offline. Please reconnect to the internet to generate a shareable link.',
        'OFFLINE'
      );
    }
  }

  const lockKey = String(chat.id);
  if (inFlightShareRequests.has(lockKey)) {
    throw new ShareChatError(
      'A share link is already being generated for this conversation.',
      'DUPLICATE_IN_FLIGHT'
    );
  }

  inFlightShareRequests.add(lockKey);

  try {
    const shareId = generateShareId();
    const { documentData, byteSize } = buildValidatedSharedSnapshot({
      shareId,
      chat,
      messages,
    });

    const targetDb = options.firestoreDb !== undefined ? options.firestoreDb : db;
    const docFn = options.docImpl || doc;
    const setDocFn = options.setDocImpl || setDoc;

    const shareDocRef = docFn(targetDb, 'sharedChats', shareId);
    await withPublishTimeout(setDocFn(shareDocRef, documentData));

    const shareUrl = buildShareChatUrl(shareId, options.baseUrl);

    return {
      shareId,
      shareUrl,
      title: documentData.title,
      mode: documentData.mode,
      messageCount: documentData.messageCount,
      byteSize,
    };
  } catch (err) {
    if (err instanceof ShareChatError) {
      throw err;
    }
    const rawMsg = String(err?.message || '');
    if (rawMsg.includes('permission-denied') || err?.code === 'permission-denied') {
      throw new ShareChatError(
        'Unable to publish shared conversation due to security permissions. Please ensure you are signed in with a full account.',
        'PERMISSION_DENIED'
      );
    }
    throw new ShareChatError(
      'Failed to generate share link. Please check your connection and try again.',
      'PUBLISH_FAILED'
    );
  } finally {
    inFlightShareRequests.delete(lockKey);
  }
}

/**
 * Copies the generated share URL to the clipboard with a reliable fallback
 * for browsers/iframes where `navigator.clipboard.writeText` is restricted.
 *
 * @param {string} shareUrl
 * @returns {Promise<boolean>}
 */
export async function copyShareUrlToClipboard(shareUrl) {
  if (typeof shareUrl !== 'string' || !shareUrl.trim()) {
    return false;
  }

  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(shareUrl);
      return true;
    } catch {
      // Fall through to textarea fallback
    }
  }

  if (typeof document !== 'undefined') {
    try {
      const textArea = document.createElement('textarea');
      textArea.value = shareUrl;
      textArea.setAttribute('readonly', '');
      textArea.style.position = 'fixed';
      textArea.style.top = '-9999px';
      textArea.style.left = '-9999px';
      textArea.style.opacity = '0';
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      const copied = document.execCommand('copy');
      document.body.removeChild(textArea);
      return Boolean(copied);
    } catch {
      return false;
    }
  }

  return false;
}

/**
 * Builds a WhatsApp share URL (`https://wa.me/?text=...`) containing the
 * conversation title and shareable link.
 *
 * @param {string} shareUrl
 * @param {string} [title]
 * @returns {string}
 */
export function buildWhatsAppShareUrl(shareUrl, title = 'Shared Chat') {
  const cleanTitle =
    typeof title === 'string' && title.trim() ? title.trim() : 'Shared Chat';
  const shareText = `${cleanTitle} — Shared conversation on Orvix AI:\n${shareUrl}`;
  return `https://wa.me/?text=${encodeURIComponent(shareText)}`;
}

/**
 * Checks whether the browser supports the native Web Share API (`navigator.share`).
 *
 * @returns {boolean}
 */
export function canUseNativeShare() {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.share === 'function'
  );
}

/**
 * Invokes the browser's native Web Share sheet (`navigator.share`).
 * Returns `{ shared: true }` on completion, `{ shared: false, cancelled: true }`
 * if dismissed by the user, or throws on unexpected error.
 *
 * @param {Object} params
 * @param {string} params.shareUrl
 * @param {string} [params.title]
 * @returns {Promise<{ shared: boolean, cancelled?: boolean }>}
 */
export async function triggerNativeShare({ shareUrl, title = 'Shared Chat' }) {
  if (!canUseNativeShare()) {
    return { shared: false };
  }

  const cleanTitle =
    typeof title === 'string' && title.trim() ? title.trim() : 'Shared Chat';

  try {
    await navigator.share({
      title: `${cleanTitle} — Orvix AI`,
      text: `Check out this AI conversation on Orvix AI: "${cleanTitle}"`,
      url: shareUrl,
    });
    return { shared: true };
  } catch (err) {
    if (err?.name === 'AbortError') {
      return { shared: false, cancelled: true };
    }
    throw err;
  }
}

/**
 * Extracts and parses a share ID from a window pathname (e.g. '/share/abc123_456').
 * Returns the shareId string if matched, or null otherwise.
 *
 * @param {string} [pathname]
 * @returns {string|null}
 */
export function parseSharePath(pathname) {
  const target =
    typeof pathname === 'string'
      ? pathname.trim()
      : typeof window !== 'undefined'
      ? window.location?.pathname || ''
      : '';

  if (!target) return null;
  const match = target.match(/^\/share\/([a-zA-Z0-9_-]+)\/?$/);
  return match ? match[1] : null;
}

/**
 * Analyzes whether a given pathname represents a /share route and evaluates ID validity.
 *
 * @param {string} [pathname]
 * @returns {{ isShareRoute: boolean, shareId: string|null, rawShareId: string|null, isValid: boolean, isMalformed: boolean }}
 */
export function getShareRouteDetails(pathname) {
  const target =
    typeof pathname === 'string'
      ? pathname.trim()
      : typeof window !== 'undefined'
      ? window.location?.pathname || ''
      : '';

  if (!target || !target.startsWith('/share')) {
    return { isShareRoute: false, shareId: null, rawShareId: null, isValid: false, isMalformed: false };
  }

  // Handle bare /share or /share/
  if (target === '/share' || target === '/share/') {
    return { isShareRoute: true, shareId: null, rawShareId: '', isValid: false, isMalformed: true };
  }

  const match = target.match(/^\/share\/([^/?#]+)\/?$/);
  if (!match) {
    return { isShareRoute: true, shareId: null, rawShareId: null, isValid: false, isMalformed: true };
  }

  const rawShareId = match[1];
  const isValid = isValidShareId(rawShareId);

  return {
    isShareRoute: true,
    shareId: isValid ? rawShareId : null,
    rawShareId,
    isValid,
    isMalformed: !isValid
  };
}

function getSessionStorageInstance() {
  if (typeof window !== 'undefined' && window.sessionStorage) {
    return window.sessionStorage;
  }
  if (typeof sessionStorage !== 'undefined') {
    return sessionStorage;
  }
  return null;
}

/**
 * Reads a cached validated shared snapshot from sessionStorage for reload resilience.
 *
 * @param {string} shareId
 * @returns {Object|null}
 */
export function getSharedSnapshotSession(shareId) {
  const storage = getSessionStorageInstance();
  if (!isValidShareId(shareId) || !storage) {
    return null;
  }
  try {
    const raw = storage.getItem(`orvix_shared_snapshot_${shareId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return validateSharedSnapshotPayload(parsed, shareId);
  } catch {
    return null;
  }
}

/**
 * Stores a validated shared snapshot in sessionStorage under a share-specific key.
 * Never touches orvix_active_chat, orvix_guest_chats, or orvix_user_chats.
 *
 * @param {string} shareId
 * @param {Object} snapshot
 */
export function setSharedSnapshotSession(shareId, snapshot) {
  const storage = getSessionStorageInstance();
  if (!isValidShareId(shareId) || !snapshot || !storage) {
    return;
  }
  try {
    storage.setItem(
      `orvix_shared_snapshot_${shareId}`,
      JSON.stringify(snapshot)
    );
  } catch {
    // Non-fatal if session storage is full
  }
}

/**
 * Removes a shared snapshot cache entry from sessionStorage.
 *
 * @param {string} shareId
 */
export function clearSharedSnapshotSession(shareId) {
  const storage = getSessionStorageInstance();
  if (!shareId || !storage) {
    return;
  }
  try {
    storage.removeItem(`orvix_shared_snapshot_${shareId}`);
  } catch {}
}

/**
 * Validates the complete structure and contents of a shared chat snapshot document.
 * Enforces strict consistency with firestore.rules:
 * - Top-level keys: id, title, mode, messageCount, messages (and optional createdAt)
 * - id matches the expected shareId exactly
 * - title is a non-empty string <= MAX_SHARED_TITLE_LENGTH
 * - mode is in ALLOWED_CHAT_MODES
 * - messageCount matches messages.length (1 to 500)
 * - Every single message is validated against allowed sender, keys, content length, and structure
 * - Rejects malformed snapshots safely without modifying or creating chat history
 *
 * @param {Object} data - Raw document data from Firestore or session cache
 * @param {string} [expectedShareId=null] - The requested shareId
 * @returns {Object} Clean, validated, and canonically ordered snapshot
 */
export function validateSharedSnapshotPayload(data, expectedShareId = null) {
  const targetShareId = expectedShareId || data?.id;
  if (!targetShareId || !isValidShareId(targetShareId)) {
    throw new ShareChatError('Invalid or malformed share ID.', 'INVALID_SHARE_ID');
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new ShareChatError('Invalid shared conversation structure.', 'MALFORMED_SNAPSHOT');
  }

  if (typeof data.id === 'string' && expectedShareId && data.id !== expectedShareId) {
    throw new ShareChatError('Shared conversation identifier mismatch.', 'MALFORMED_SNAPSHOT');
  }

  if (typeof data.title !== 'string' || !data.title.trim()) {
    throw new ShareChatError('Shared conversation is missing a title.', 'MALFORMED_SNAPSHOT');
  }

  const cleanTitle = data.title.trim().slice(0, MAX_SHARED_TITLE_LENGTH);

  if (!ALLOWED_CHAT_MODES.includes(data.mode)) {
    throw new ShareChatError(
      `Shared conversation has an unsupported chat mode ("${String(data.mode)}").`,
      'MALFORMED_SNAPSHOT'
    );
  }

  if (!Array.isArray(data.messages) || data.messages.length === 0) {
    throw new ShareChatError('Shared conversation contains no messages.', 'EMPTY_SNAPSHOT');
  }

  if (data.messages.length > MAX_SHARED_MESSAGE_COUNT) {
    throw new ShareChatError(
      `Shared conversation exceeds the maximum message limit of ${MAX_SHARED_MESSAGE_COUNT}.`,
      'MALFORMED_SNAPSHOT'
    );
  }

  if (typeof data.messageCount === 'number' && data.messageCount !== data.messages.length) {
    throw new ShareChatError(
      'Shared conversation message count does not match the actual messages array length.',
      'MALFORMED_SNAPSHOT'
    );
  }

  // Pre-validate and sanitize EVERY individual message in the snapshot
  const sanitizedMessages = data.messages.map((rawMsg, idx) => {
    return sanitizeMessageForShare(rawMsg, idx, data.mode);
  });

  // Canonical chronological ordering and alternatives preservation
  const orderedMessages = orderConversationMessages(
    ensureConversationAlternatives(sanitizedMessages)
  );

  return {
    id: targetShareId,
    title: cleanTitle,
    mode: data.mode,
    createdAt: data.createdAt || null,
    messageCount: orderedMessages.length,
    messages: orderedMessages,
    isSharedSnapshot: true,
  };
}

/**
 * Loads and validates a single shared chat snapshot from Firestore (`sharedChats/{shareId}`)
 * using a single getDoc() call (no collection querying or enumeration).
 *
 * Implements strict error handling:
 * - Validates shareId format before attempting network call
 * - Consults session cache first for fast reload resilience
 * - Rejects nonexistent or missing shared documents
 * - Handles network, permission-denied, and offline scenarios gracefully
 * - Completely validates and sanitizes all document data and message fields
 * - Does NOT write to the shared document or modify chat history
 *
 * @param {string} shareId
 * @param {Object} [options]
 * @param {Object} [options.firestoreDb] - Optional Firestore instance override for testing
 * @param {Function} [options.docImpl] - Optional `doc` override for testing
 * @param {Function} [options.getDocImpl] - Optional `getDoc` override for testing
 * @param {boolean} [options.forceNetwork=false] - If true, bypasses session cache
 * @param {number} [options.timeoutMs=10000] - Firestore operation timeout
 * @returns {Promise<Object>} The validated shared snapshot
 */
export async function loadSharedChatSnapshot(shareId, options = {}) {
  // 1. Strict shareId validation before any network access
  if (!isValidShareId(shareId)) {
    throw new ShareChatError(
      'The shared conversation link is invalid or malformed.',
      'INVALID_SHARE_ID'
    );
  }

  // 2. Check session cache first for reload resilience (unless network forced)
  if (!options.forceNetwork) {
    const cached = getSharedSnapshotSession(shareId);
    if (cached) {
      return cached;
    }
  }

  // 3. Ensure Firestore is configured if using live database
  if (!options.getDocImpl) {
    if (!isFirebaseConfigured() || !db) {
      throw new ShareChatError(
        'Shared conversations are currently unavailable because Firebase is not configured.',
        'FIREBASE_UNAVAILABLE'
      );
    }
  }

  const targetDb = options.firestoreDb !== undefined ? options.firestoreDb : db;
  const docFn = options.docImpl || doc;
  const getDocFn = options.getDocImpl || getDoc;

  let docSnap;
  try {
    const docRef = docFn(targetDb, 'sharedChats', shareId);
    docSnap = await withPublishTimeout(getDocFn(docRef), options.timeoutMs || 10000);
  } catch (err) {
    if (err instanceof ShareChatError) {
      throw err;
    }
    const rawMsg = String(err?.message || '');
    if (rawMsg.includes('permission-denied') || err?.code === 'permission-denied') {
      throw new ShareChatError(
        'Access to this shared conversation was denied.',
        'PERMISSION_DENIED'
      );
    }
    if (
      err?.code === 'unavailable' ||
      rawMsg.includes('offline') ||
      (typeof navigator !== 'undefined' && navigator.onLine === false)
    ) {
      throw new ShareChatError(
        'Unable to load shared conversation while offline. Please check your internet connection.',
        'OFFLINE'
      );
    }
    throw new ShareChatError(
      'Failed to load shared conversation. Please check your connection and try again.',
      'LOAD_FAILED'
    );
  }

  if (!docSnap || (typeof docSnap.exists === 'function' && !docSnap.exists())) {
    throw new ShareChatError(
      'This shared conversation no longer exists or the link is invalid.',
      'NOT_FOUND'
    );
  }

  const rawData = typeof docSnap.data === 'function' ? docSnap.data() : docSnap;
  const validated = validateSharedSnapshotPayload(rawData, shareId);

  // Cache in session storage for fast reload resilience
  setSharedSnapshotSession(shareId, validated);

  return validated;
}

/**
 * Stage 5: Evaluates whether a given route and user represent an authenticated shared preview.
 * Strictly requires a valid /share/{shareId} route and a real, non-anonymous user.
 *
 * @param {Object} params
 * @param {boolean} [params.isShareRoute=false]
 * @param {Object|null} [params.user=null]
 * @returns {boolean}
 */
export function isAuthenticatedSharedPreview({ isShareRoute = false, user = null } = {}) {
  return Boolean(isShareRoute && isEligibleShareUser(user));
}

/**
 * Stage 5: Action-bar & composer permission evaluator for shared preview states.
 * Centralizes deterministic permissions:
 * - Public visitor: read-only, copy, read aloud enabled; composer & actions disabled.
 * - Authenticated preview before first message persistence:
 *     canRead, canCopy, canReadAloud enabled;
 *     canType, canSubmit enabled (text-only);
 *     canAttach, canRecordVoice, canDragDrop disabled;
 *     canRegenerate, canGenerateAlternative, canShare, canEditUserMessage disabled;
 *     isHistoryCreated: false.
 *
 * @param {Object} params
 * @param {boolean} [params.isShareRoute=false]
 * @param {Object|null} [params.user=null]
 * @param {boolean} [params.hasSentFirstMessage=false]
 * @returns {Object} Deterministic permission flags
 */
export function getSharedPreviewActionPermissions({
  isShareRoute = false,
  user = null,
  hasSentFirstMessage = false,
  isImported = false,
} = {}) {
  if (!isShareRoute || isImported) {
    return {
      canRead: true,
      canReadOriginal: true,
      canCopy: true,
      canReadAloud: true,
      canType: true,
      canSubmit: true,
      canSubmitFirstMessage: true,
      canAttach: true,
      canRecordVoice: true,
      canDictate: true,
      canDragDrop: true,
      canPasteFile: true,
      canRegenerate: true,
      canRegenerateOriginal: true,
      canGenerateAlternative: true,
      canRegenerateAlternative: true,
      canShare: true,
      canShareChat: true,
      canEditUserMessage: true,
      canEditResend: true,
      canEditOriginal: true,
      canDeleteMessage: true,
      canDelete: true,
      canRename: true,
      canPin: true,
      canSwitchMode: true,
      canSwitchProvider: true,
      canExport: true,
      canNewChat: true,
      isHistoryCreated: true,
      showInHistory: true,
      isPermanentChat: true,
      isSharedPreview: false,
      isAuthenticatedSharedPreview: false,
      isPublicSharedViewer: false,
      hasSentFirstMessage: Boolean(hasSentFirstMessage),
      isImported: Boolean(isImported),
    };
  }

  const isAuthedPreview = isEligibleShareUser(user);

  return {
    canRead: true,
    canReadOriginal: true,
    canCopy: true,
    canReadAloud: true,
    // Composer text entry is enabled strictly for authenticated preview
    canType: isAuthedPreview,
    canSubmit: isAuthedPreview,
    canSubmitFirstMessage: isAuthedPreview,
    // Attachments, voice dictation, drag-and-drop, and file paste remain disabled for shared preview
    canAttach: false,
    canRecordVoice: false,
    canDictate: false,
    canDragDrop: false,
    canPasteFile: false,
    // Conversational mutations on original messages remain disabled before Prompt 6 import
    canRegenerate: false,
    canRegenerateOriginal: false,
    canGenerateAlternative: false,
    canRegenerateAlternative: false,
    canShare: false,
    canShareChat: false,
    canEditUserMessage: false,
    canEditResend: false,
    canEditOriginal: false,
    canDeleteMessage: false,
    canDelete: false,
    canRename: false,
    canPin: false,
    canSwitchMode: false,
    canSwitchProvider: false,
    canExport: true,
    canNewChat: true,
    // History creation is strictly false in Prompt 5 preview
    isHistoryCreated: false,
    showInHistory: false,
    isPermanentChat: false,
    isSharedPreview: true,
    isAuthenticatedSharedPreview: isAuthedPreview,
    isPublicSharedViewer: !isAuthedPreview,
    hasSentFirstMessage: Boolean(hasSentFirstMessage),
    isImported: false,
  };
}

/**
 * Stage 5 & 6: State machine factory for shared preview and permanent import states.
 * Encapsulates the distinct lifecycle states:
 * 1. 'idle' (opened, typed or un-typed, not submitted)
 * 2. 'submitting' (first message actively processing)
 * 3. 'complete' / 'completed' (first message generation finished)
 * 4. 'failed' (submission error or user cancellation, can retry)
 * 5. 'imported' (permanently imported into recipient's private history)
 *
 * @param {Object} params
 * @param {boolean} [params.isShareRoute=false]
 * @param {Object|null} [params.user=null]
 * @param {boolean} [params.hasSentFirstMessage=false]
 * @param {boolean} [params.isSubmitting=false]
 * @param {boolean} [params.hasFailed=false]
 * @param {boolean} [params.isImported=false]
 * @param {string|null} [params.importedChatId=null]
 * @returns {Object}
 */
export function createSharedPreviewState({
  isShareRoute = false,
  user = null,
  hasSentFirstMessage = false,
  isSubmitting = false,
  hasFailed = false,
  isImported = false,
  importedChatId = null,
} = {}) {
  if (isImported) {
    return {
      isSharedRoute: false,
      isSharedPreview: false,
      isAuthenticatedSharedPreview: false,
      isPublicSharedViewer: false,
      hasSentFirstMessage: true,
      hasSharedPreviewFirstMessageBeenSent: true,
      isSubmitting: false,
      isSubmittingFirstSharedMessage: false,
      hasFailed: false,
      firstSharedMessageSubmissionFailed: false,
      submissionPhase: 'imported',
      submissionState: 'imported',
      isImported: true,
      importedChatId: importedChatId || null,
      permissions: getSharedPreviewActionPermissions({
        isShareRoute: false,
        user,
        hasSentFirstMessage: true,
        isImported: true,
      }),
    };
  }

  const isAuthedPreview = Boolean(isShareRoute && isEligibleShareUser(user));
  const isPublicViewer = Boolean(isShareRoute && !isAuthedPreview);

  let submissionPhase = 'idle';
  if (isSubmitting) {
    submissionPhase = 'submitting';
  } else if (hasFailed) {
    submissionPhase = 'failed';
  } else if (hasSentFirstMessage) {
    submissionPhase = 'complete';
  }

  return {
    isSharedRoute: Boolean(isShareRoute),
    isSharedPreview: Boolean(isShareRoute),
    isAuthenticatedSharedPreview: isAuthedPreview,
    isPublicSharedViewer: isPublicViewer,
    hasSentFirstMessage: Boolean(hasSentFirstMessage),
    hasSharedPreviewFirstMessageBeenSent: Boolean(hasSentFirstMessage),
    isSubmitting: Boolean(isSubmitting),
    isSubmittingFirstSharedMessage: Boolean(isSubmitting),
    hasFailed: Boolean(hasFailed),
    firstSharedMessageSubmissionFailed: Boolean(hasFailed),
    submissionPhase,
    submissionState: submissionPhase,
    isImported: false,
    importedChatId: null,
    permissions: getSharedPreviewActionPermissions({
      isShareRoute,
      user,
      hasSentFirstMessage,
      isImported: false,
    }),
  };
}

// Track in-flight and completed import operations to ensure strict idempotency and zero duplicate chats
const inFlightImports = new Map();
const completedImports = new Map();

/**
 * Generates a stable deduplication key for a shared conversation import request.
 * Format: {shareId}::{recipientUserId}::{firstInteractionIdentity}
 *
 * @param {string} shareId
 * @param {string} userId
 * @param {string} interactionIdentity
 * @returns {string}
 */
export function getImportDeduplicationKey(shareId, userId, interactionIdentity) {
  const safeShare = String(shareId || '').trim();
  const safeUser = String(userId || '').trim();
  const safeInteraction = String(interactionIdentity || '').trim();
  return `${safeShare}::${safeUser}::${safeInteraction}`;
}

/**
 * Resets in-memory import lock caches (primarily used in automated test suites).
 */
export function clearImportLocks() {
  inFlightImports.clear();
  completedImports.clear();
}

/**
 * Generates a collision-resistant, recipient-owned ID for imported messages, interactions, or chats.
 * Never reuses original shared snapshot IDs.
 *
 * @param {string} [prefix='imp']
 * @returns {string}
 */
export function generateImportedId(prefix = 'imp') {
  let rand = '';
  if (typeof globalThis !== 'undefined' && globalThis.crypto?.getRandomValues) {
    const bytes = new Uint8Array(6);
    globalThis.crypto.getRandomValues(bytes);
    rand = Array.from(bytes, (b) => (b % 36).toString(36)).join('');
  } else {
    rand = Date.now().toString(36).slice(-6);
  }
  return `${prefix}-${Date.now().toString(36)}-${rand}`;
}

/**
 * Remaps every message in a shared conversation snapshot with fresh recipient-owned IDs
 * while strictly preserving:
 * - message ordering
 * - sender
 * - content
 * - mode
 * - modelUsed / provider / responseTimeMs
 * - logical parent-child relationships (parentMessageId remapped to new parent ID)
 * - interaction relationships (interactionId remapped to new interaction ID)
 * - alternative response information & activeAlternativeId (remapped to new alternative ID)
 * - attachment metadata (sanitized plain metadata only, strictly zero raw blobs, files, or paths)
 *
 * @param {Array} originalMessages
 * @returns {{ remappedMessages: Array, messageIdMap: Map<string, string>, interactionIdMap: Map<string, string>, lastMessageId: string|null }}
 */
export function remapSharedSnapshotMessages(originalMessages) {
  if (!Array.isArray(originalMessages) || originalMessages.length === 0) {
    return {
      remappedMessages: [],
      messageIdMap: new Map(),
      interactionIdMap: new Map(),
      lastMessageId: null,
    };
  }

  const messageIdMap = new Map();
  const interactionIdMap = new Map();
  const alternativeIdMap = new Map();

  // Pass 1: Allocate fresh IDs for all messages, interactions, and alternatives
  originalMessages.forEach((msg, idx) => {
    if (!msg || typeof msg !== 'object') return;
    const oldMsgId = String(msg.id || `orig_${idx}`);
    const newMsgId = generateImportedId(msg.sender === 'user' ? 'msg_imp_user' : 'msg_imp_asst');
    messageIdMap.set(oldMsgId, newMsgId);

    if (msg.interactionId && !interactionIdMap.has(msg.interactionId)) {
      interactionIdMap.set(msg.interactionId, generateImportedId('inter_imp'));
    }

    if (Array.isArray(msg.alternatives)) {
      msg.alternatives.forEach((alt, altIdx) => {
        if (alt && alt.id && !alternativeIdMap.has(alt.id)) {
          alternativeIdMap.set(alt.id, generateImportedId(`alt_imp_${altIdx}`));
        }
      });
    }
  });

  // Pass 2: Remap relationships and sanitize all attachments
  let lastMessageId = null;
  const remappedMessages = originalMessages.map((msg, idx) => {
    const oldMsgId = String(msg.id || `orig_${idx}`);
    const newMsgId = messageIdMap.get(oldMsgId) || generateImportedId('msg');
    lastMessageId = newMsgId;

    const newParentId =
      msg.parentMessageId && messageIdMap.has(msg.parentMessageId)
        ? messageIdMap.get(msg.parentMessageId)
        : null;

    const newInteractionId =
      msg.interactionId && interactionIdMap.has(msg.interactionId)
        ? interactionIdMap.get(msg.interactionId)
        : null;

    let newActiveAltId = null;
    if (msg.activeAlternativeId) {
      newActiveAltId =
        alternativeIdMap.get(msg.activeAlternativeId) ||
        messageIdMap.get(msg.activeAlternativeId) ||
        null;
    }

    let remappedAlternatives = null;
    if (Array.isArray(msg.alternatives)) {
      remappedAlternatives = msg.alternatives.map((alt, altIdx) => {
        const altOldId = alt?.id || `alt_${altIdx}`;
        const altNewId = alternativeIdMap.get(altOldId) || generateImportedId('alt');
        const altParentId =
          alt?.parentMessageId && messageIdMap.has(alt.parentMessageId)
            ? messageIdMap.get(alt.parentMessageId)
            : newParentId;

        return {
          id: altNewId,
          parentMessageId: altParentId,
          sender: 'assistant',
          content: typeof alt?.content === 'string' ? alt.content : '',
          provider: alt?.provider || msg.provider || 'gemini',
          modelUsed: alt?.modelUsed || msg.modelUsed || null,
          mode: alt?.mode || msg.mode || 'general',
          responseTimeMs:
            typeof alt?.responseTimeMs === 'number' ? alt.responseTimeMs : null,
          createdAt: typeof alt?.createdAt === 'number' ? alt.createdAt : Date.now(),
          timestamp: alt?.timestamp || '',
          referencedAttachments: Array.isArray(alt?.referencedAttachments)
            ? alt.referencedAttachments
                .map((a, i) => sanitizeAttachmentForShare(a, i))
                .filter(Boolean)
            : [],
          isError: Boolean(alt?.isError),
          isStopped: Boolean(alt?.isStopped),
        };
      });
    }

    const sanitizedAttachments = Array.isArray(msg.attachments)
      ? msg.attachments
          .map((a, i) => sanitizeAttachmentForShare(a, i))
          .filter(Boolean)
      : [];

    const sanitizedReferencedAttachments = Array.isArray(msg.referencedAttachments)
      ? msg.referencedAttachments
          .map((a, i) => sanitizeAttachmentForShare(a, i))
          .filter(Boolean)
      : [];

    return {
      id: newMsgId,
      sender: msg.sender,
      content: msg.content,
      modelUsed: msg.modelUsed || null,
      provider: msg.provider || null,
      mode: msg.mode || 'general',
      responseTimeMs:
        typeof msg.responseTimeMs === 'number' ? msg.responseTimeMs : null,
      parentMessageId: newParentId,
      interactionId: newInteractionId,
      activeAlternativeId: newActiveAltId,
      alternatives: remappedAlternatives && remappedAlternatives.length > 0 ? remappedAlternatives : null,
      attachments: sanitizedAttachments,
      referencedAttachments: sanitizedReferencedAttachments,
      createdAtMs: typeof msg.createdAtMs === 'number' ? msg.createdAtMs : Date.now(),
      clientTimestamp: msg.clientTimestamp || msg.timestamp || '',
      timestamp: msg.timestamp || msg.clientTimestamp || '',
      isImported: true,
    };
  });

  return {
    remappedMessages,
    messages: remappedMessages,
    messageIdMap,
    mapping: messageIdMap,
    interactionIdMap,
    lastMessageId,
  };
}

/**
 * Constructs the complete data payload for an imported private conversation:
 * - Independent conversation metadata marked with isImported: true & importedFromShareId: shareId
 * - Remapped original shared conversation messages with fresh recipient-owned IDs
 * - Recipient's first user message linked to the last original message
 * - Generated AI response linked to recipient's user message
 *
 * @param {Object} params
 * @param {string} params.shareId
 * @param {Object} params.snapshot - Validated shared chat snapshot
 * @param {string} params.recipientUserId - Authenticated recipient UID
 * @param {Object} params.recipientUserMessage - First recipient user message
 * @param {Object} params.recipientAssistantMessage - First recipient AI response
 * @param {string} [params.customChatId] - Optional chatId override
 * @returns {{ chatMetadata: Object, messages: Array, newChatId: string }}
 */
export function createImportedConversationData({
  shareId,
  snapshot,
  recipientUserId,
  recipientUserMessage,
  recipientAssistantMessage,
  customChatId = null,
}) {
  if (!isValidShareId(shareId)) {
    throw new ShareChatError('Invalid share ID for import.', 'INVALID_SHARE_ID');
  }
  if (!recipientUserId || typeof recipientUserId !== 'string' || !recipientUserId.trim()) {
    throw new ShareChatError('Valid recipient user ID is required.', 'INVALID_USER_ID');
  }
  if (!snapshot || typeof snapshot !== 'object') {
    throw new ShareChatError('Invalid snapshot for import.', 'MALFORMED_SNAPSHOT');
  }

  const newChatId = customChatId || generateLocalChatId(recipientUserId) || generateImportedId('chat');
  const safeMode = ALLOWED_CHAT_MODES.includes(snapshot.mode) ? snapshot.mode : 'general';
  const rawTitle = typeof snapshot.title === 'string' && snapshot.title.trim() ? snapshot.title.trim() : 'Imported Chat';
  const safeTitle = rawTitle.slice(0, MAX_SHARED_TITLE_LENGTH);

  // 1. Remap all original shared snapshot messages
  const { remappedMessages, lastMessageId } = remapSharedSnapshotMessages(snapshot.messages || []);

  const nowMs = Date.now();

  // 2. Prepare recipient's first user message with fresh IDs and linked parent
  const recipientUserMsgId = recipientUserMessage?.id || generateImportedId('user');
  const recipientInteractionId = recipientUserMessage?.interactionId || generateImportedId('interaction');

  const remappedRecipientUserMsg = {
    id: recipientUserMsgId,
    sender: 'user',
    content: recipientUserMessage?.content || '',
    modelUsed: null,
    provider: null,
    mode: safeMode,
    responseTimeMs: null,
    parentMessageId: lastMessageId, // Links recipient's first prompt to the end of the original conversation
    interactionId: recipientInteractionId,
    activeAlternativeId: null,
    alternatives: null,
    attachments: [],
    referencedAttachments: [],
    createdAtMs: typeof recipientUserMessage?.createdAtMs === 'number' ? recipientUserMessage.createdAtMs : nowMs,
    clientTimestamp: recipientUserMessage?.timestamp || recipientUserMessage?.clientTimestamp || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    timestamp: recipientUserMessage?.timestamp || recipientUserMessage?.clientTimestamp || '',
    isImportedRecipientMessage: true,
  };

  // 3. Prepare recipient's AI response message
  const recipientAsstMsgId = recipientAssistantMessage?.id || generateImportedId('asst');
  const remappedRecipientAsstMsg = {
    id: recipientAsstMsgId,
    sender: 'assistant',
    content: recipientAssistantMessage?.content || '',
    modelUsed: recipientAssistantMessage?.modelUsed || null,
    provider: recipientAssistantMessage?.provider || 'gemini',
    mode: safeMode,
    responseTimeMs: typeof recipientAssistantMessage?.responseTimeMs === 'number' ? recipientAssistantMessage.responseTimeMs : null,
    parentMessageId: recipientUserMsgId,
    interactionId: recipientInteractionId,
    activeAlternativeId: recipientAssistantMessage?.activeAlternativeId || null,
    alternatives: Array.isArray(recipientAssistantMessage?.alternatives) ? recipientAssistantMessage.alternatives : null,
    attachments: [],
    referencedAttachments: [],
    createdAtMs: typeof recipientAssistantMessage?.createdAtMs === 'number' ? recipientAssistantMessage.createdAtMs : nowMs + 1,
    clientTimestamp: recipientAssistantMessage?.timestamp || recipientAssistantMessage?.clientTimestamp || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    timestamp: recipientAssistantMessage?.timestamp || recipientAssistantMessage?.clientTimestamp || '',
    isStreaming: false,
    isStopped: Boolean(recipientAssistantMessage?.isStopped),
    isImportedRecipientMessage: true,
  };

  const combinedMessages = [
    ...remappedMessages,
    remappedRecipientUserMsg,
    remappedRecipientAsstMsg,
  ];

  const orderedMessages = orderConversationMessages(
    ensureConversationAlternatives(combinedMessages)
  );

  const chatMetadata = {
    id: newChatId,
    title: safeTitle,
    mode: safeMode,
    userId: recipientUserId,
    isImported: true,
    importedFromShareId: shareId,
    isPinned: false,
    pinnedAt: null,
    createdAtMs: nowMs,
    rawUpdatedAt: nowMs,
    timestamp: 'Just now',
  };

  return {
    chatMetadata,
    messages: orderedMessages,
    newChatId,
  };
}

/**
 * Persists an imported conversation and all its messages to Cloud Firestore using
 * batched writes (chunked into batches of at most 400 operations to safely honor the
 * Firestore 500-op limit for up to 500 snapshot messages + recipient messages).
 * Implements a rollback-safe strategy if any multi-batch commit fails.
 *
 * @param {Object} params
 * @param {Object} [params.firestoreDb]
 * @param {string} params.userId
 * @param {Object} params.chatMetadata
 * @param {Array} params.messages
 * @param {Function} [params.docImpl]
 * @param {Function} [params.writeBatchImpl]
 * @param {number} [params.timeoutMs=15000]
 * @returns {Promise<void>}
 */
export async function persistImportedConversationToFirestore({
  firestoreDb,
  userId,
  chatMetadata,
  messages,
  docImpl = doc,
  writeBatchImpl = writeBatch,
  timeoutMs = 15000,
}) {
  const targetDb = firestoreDb !== undefined ? firestoreDb : db;
  if (!targetDb) {
    throw new ShareChatError('Firestore instance is unavailable for import.', 'FIREBASE_UNAVAILABLE');
  }

  const chatDocRef = docImpl(targetDb, 'users', userId, 'chats', chatMetadata.id);
  const chatPayload = {
    id: chatMetadata.id,
    title: chatMetadata.title,
    mode: chatMetadata.mode || 'general',
    userId,
    isImported: true,
    importedFromShareId: chatMetadata.importedFromShareId,
    isPinned: false,
    pinnedAt: null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  // Compile all operations: 1 chat setDoc + M message setDocs
  const operations = [
    { type: 'set', ref: chatDocRef, payload: chatPayload }
  ];

  messages.forEach((msg) => {
    const msgRef = docImpl(targetDb, 'users', userId, 'chats', chatMetadata.id, 'messages', msg.id);
    const msgPayload = buildFirestoreMessagePayload(msg);
    operations.push({ type: 'set', ref: msgRef, payload: msgPayload });
  });

  const BATCH_SIZE = 400; // Well within Firestore's 500 operations per batch limit
  const batches = [];
  for (let i = 0; i < operations.length; i += BATCH_SIZE) {
    batches.push(operations.slice(i, i + BATCH_SIZE));
  }

  const committedBatches = [];

  try {
    for (const chunk of batches) {
      const batch = writeBatchImpl(targetDb);
      chunk.forEach((op) => {
        if (op.type === 'set') {
          batch.set(op.ref, op.payload);
        }
      });

      await withPublishTimeout(batch.commit(), timeoutMs);
      committedBatches.push(chunk);
    }
  } catch (err) {
    // If a multi-batch commit fails on batch > 1, clean up committed messages to avoid orphaned partial chat
    if (committedBatches.length > 0) {
      try {
        const cleanupBatch = writeBatchImpl(targetDb);
        committedBatches.forEach((chunk) => {
          chunk.forEach((op) => {
            cleanupBatch.delete(op.ref);
          });
        });
        await cleanupBatch.commit();
      } catch (cleanupErr) {
        console.warn('Import rollback notice:', cleanupErr?.message || cleanupErr);
      }
    }

    if (err instanceof ShareChatError) throw err;
    const rawMsg = String(err?.message || '');
    if (rawMsg.includes('permission-denied') || err?.code === 'permission-denied') {
      throw new ShareChatError(
        'Permission denied while saving imported conversation.',
        'PERMISSION_DENIED'
      );
    }
    throw new ShareChatError(
      'Failed to persist imported conversation to Cloud Firestore.',
      'PERSISTENCE_FAILED'
    );
  }
}

/**
 * Orchestrates the complete permanent import transition for an authenticated recipient:
 * 1. Verifies non-anonymous authenticated user eligibility
 * 2. Checks deduplication lock so identical first interactions never produce duplicate chats
 * 3. Remaps original messages with fresh IDs and appends recipient interaction
 * 4. Updates local cache and history
 * 5. Persists atomically (or multi-batch safely) to Cloud Firestore
 * 6. Returns the permanent imported conversation metadata and messages
 *
 * @param {Object} params
 * @param {string} params.shareId
 * @param {Object} params.snapshot - Validated shared snapshot
 * @param {Object} params.recipientUser - Current authenticated Firebase user
 * @param {Object} params.recipientUserMessage - First recipient user message
 * @param {Object} params.recipientAssistantMessage - First recipient AI response
 * @param {Object} [params.options] - Optional overrides for testing
 * @returns {Promise<{ success: boolean, chatId: string, chatMetadata: Object, messages: Array, alreadyImported: boolean }>}
 */
export async function importSharedConversationToAccount({
  shareId,
  snapshot,
  recipientUser,
  recipientUserMessage,
  recipientAssistantMessage,
  options = {},
}) {
  // 1. Strict authentication check: must be a real non-anonymous Firebase user
  if (!isEligibleShareUser(recipientUser)) {
    throw new ShareChatError(
      'Only signed-in accounts can import shared conversations. Please log in first.',
      'AUTH_REQUIRED'
    );
  }

  if (!isValidShareId(shareId)) {
    throw new ShareChatError('Invalid shared conversation identifier.', 'INVALID_SHARE_ID');
  }

  if (!snapshot || typeof snapshot !== 'object') {
    throw new ShareChatError('Invalid shared conversation snapshot.', 'MALFORMED_SNAPSHOT');
  }

  const interactionIdentity =
    recipientUserMessage?.interactionId ||
    recipientUserMessage?.id ||
    `interaction_${shareId}`;

  const dedupKey = getImportDeduplicationKey(shareId, recipientUser.uid, interactionIdentity);

  // 2. Check in-memory completed cache
  if (completedImports.has(dedupKey)) {
    return {
      success: true,
      ...completedImports.get(dedupKey),
      alreadyImported: true,
    };
  }

  // Check sessionStorage for reload resilience
  const sessionStorageInstance = getSessionStorageInstance();
  if (sessionStorageInstance) {
    try {
      const stored = sessionStorageInstance.getItem(`orvix_import_${dedupKey}`);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed?.chatId) {
          completedImports.set(dedupKey, parsed);
          return {
            success: true,
            ...parsed,
            alreadyImported: true,
          };
        }
      }
    } catch (_) {}
  }

  // Check in-flight lock to deduplicate concurrent requests
  if (inFlightImports.has(dedupKey)) {
    return await inFlightImports.get(dedupKey);
  }

  // 3. Check if recipient's local chat history already contains an imported chat from this share
  const existingUserChats = getCachedUserChats(recipientUser.uid);
  const existingImportedChat = existingUserChats.find(
    (c) => c && c.isImported && c.importedFromShareId === shareId
  );

  if (existingImportedChat) {
    const existingMessages = getCachedChatMessages(recipientUser.uid, existingImportedChat.id);
    const hasSameFirstMessage = existingMessages.some(
      (m) =>
        m.sender === 'user' &&
        recipientUserMessage?.content &&
        m.content === recipientUserMessage.content
    );

    if (hasSameFirstMessage) {
      const result = {
        chatId: existingImportedChat.id,
        chatMetadata: existingImportedChat,
        messages: existingMessages,
      };
      completedImports.set(dedupKey, result);
      return {
        success: true,
        ...result,
        alreadyImported: true,
      };
    }
  }

  // 4. Create in-flight task
  const importTask = (async () => {
    // Build remapped payload
    const { chatMetadata, messages: orderedMessages, newChatId } = createImportedConversationData({
      shareId,
      snapshot,
      recipientUserId: recipientUser.uid,
      recipientUserMessage,
      recipientAssistantMessage,
      customChatId: options.customChatId || null,
    });

    const isOnline = options.isOnline !== undefined ? options.isOnline : isBrowserOnline();
    const canUseFirestore =
      options.firestoreDb !== undefined ||
      (isFirebaseConfigured() && Boolean(db) && isOnline && !options.skipFirestore);

    // Always update user-scoped local cache first for instant UI response and offline resilience
    upsertCachedUserChat(recipientUser.uid, {
      ...chatMetadata,
      pendingSync: !canUseFirestore,
      createdOffline: !canUseFirestore,
    });

    saveCachedChatMessages(recipientUser.uid, newChatId, orderedMessages);

    // Persist to Cloud Firestore if enabled
    if (canUseFirestore) {
      await persistImportedConversationToFirestore({
        firestoreDb: options.firestoreDb,
        userId: recipientUser.uid,
        chatMetadata,
        messages: orderedMessages,
        docImpl: options.docImpl,
        writeBatchImpl: options.writeBatchImpl,
        timeoutMs: options.timeoutMs || 15000,
      });

      // Clear pendingSync flag once Firestore write succeeds
      upsertCachedUserChat(recipientUser.uid, {
        id: newChatId,
        pendingSync: false,
        createdOffline: false,
      });
    }

    const completedRecord = {
      chatId: newChatId,
      chatMetadata,
      messages: orderedMessages,
    };

    completedImports.set(dedupKey, completedRecord);

    if (sessionStorageInstance) {
      try {
        sessionStorageInstance.setItem(
          `orvix_import_${dedupKey}`,
          JSON.stringify(completedRecord)
        );
      } catch (_) {}
    }

    return {
      success: true,
      ...completedRecord,
      alreadyImported: false,
    };
  })();

  inFlightImports.set(dedupKey, importTask);

  try {
    return await importTask;
  } finally {
    inFlightImports.delete(dedupKey);
  }
}

/**
 * Checks whether a conversation object represents an imported shared conversation.
 *
 * @param {Object|null} chat
 * @returns {boolean}
 */
export function isImportedConversation(chat) {
  return Boolean(chat && typeof chat === 'object' && chat.isImported === true);
}

/**
 * Retrieves the original public share ID that an imported conversation originated from.
 *
 * @param {Object|null} chat
 * @returns {string|null}
 */
export function getImportedOriginShareId(chat) {
  if (chat && typeof chat === 'object' && typeof chat.importedFromShareId === 'string' && chat.importedFromShareId.trim()) {
    return chat.importedFromShareId.trim();
  }
  return null;
}

/**
 * Validates that a reshared conversation snapshot is fully independent,
 * contains all historical messages and subsequent continuation turns,
 * has a fresh share ID, and strips all private metadata.
 *
 * @param {Object} params
 * @param {Object} params.originalSnapshot
 * @param {Object} params.reSharedSnapshot
 * @param {Array} params.continuationMessages
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function verifyReshareIntegrity({
  originalSnapshot,
  reSharedSnapshot,
  continuationMessages = [],
}) {
  const errors = [];

  if (!reSharedSnapshot || typeof reSharedSnapshot !== 'object') {
    errors.push('Reshared snapshot is missing or not an object.');
    return { valid: false, errors };
  }

  if (!isValidShareId(reSharedSnapshot.id)) {
    errors.push('Reshared snapshot does not have a valid URL-safe share ID.');
  }

  if (originalSnapshot && reSharedSnapshot.id === originalSnapshot.id) {
    errors.push('Reshared snapshot must have a brand-new share ID, not reuse original.');
  }

  const expectedCount = (originalSnapshot?.messageCount || 0) + continuationMessages.length;
  if (reSharedSnapshot.messageCount !== expectedCount) {
    errors.push(
      `Message count mismatch: expected ${expectedCount}, got ${reSharedSnapshot.messageCount}.`
    );
  }

  if (!Array.isArray(reSharedSnapshot.messages) || reSharedSnapshot.messages.length !== expectedCount) {
    errors.push(
      `Messages array length mismatch: expected ${expectedCount}, got ${reSharedSnapshot.messages?.length}.`
    );
  }

  // Ensure no private metadata leaked
  if ('isImported' in reSharedSnapshot || 'importedFromShareId' in reSharedSnapshot || 'userId' in reSharedSnapshot) {
    errors.push('Private conversation metadata leaked into public reshared snapshot.');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}



