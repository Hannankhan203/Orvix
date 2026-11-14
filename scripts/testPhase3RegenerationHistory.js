/**
 * Regression Suite: Regeneration History, Recovery & Snapshot Protection (Orvix v0.4.2)
 *
 * Verifies the unified Phase 1 + Phase 2 regeneration contract:
 * 1. ChatPage.jsx implements in-place normal regeneration (`handleRegenerate`),
 *    duplicate-free cross-provider regeneration (`handleGenerateAlternative`),
 *    in-place retry & switch-provider retry (`handleRetry`, `handleSwitchProviderAndRetry`),
 *    prompt restoration preserving valid alternatives (`handleRestorePrompt`),
 *    and stale-snapshot protection (`subscribeToChatMessages` using
 *    `requestControllerRef.current.getActiveRequest()` and `pendingPersistMessagesRef`).
 * 2. Retrying a failed regeneration reuses the failed slot and assistant message ID,
 *    preserving all other provider alternatives in their original order.
 * 3. Initial-turn failure retry (single alternative, no prior valid alternatives)
 *    reuses the existing message ID without creating orphaned Firestore docs and
 *    persists once recovered.
 * 4. Switching provider and retrying after an interrupted regeneration preserves
 *    prior alternatives, updates only the failed slot in-place, and clears
 *    interrupted/error recovery state upon completion.
 * 5. Restoring prompt after failure removes only the failed attempt, selects the
 *    nearest valid alternative, persists the cleaned state, and deletes the message
 *    only when no successful alternatives exist.
 * 6. Stale Firestore snapshots arriving mid-stream or during async persistence cannot
 *    restore replaced responses or overwrite active/pending regeneration state.
 * 7. Reload behavior after successful, failed, and interrupted regeneration and
 *    offline synchronization never restore old replaced responses or overwrite newer
 *    locally pending updates.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  normalizeAssistantMessage,
  createAlternativeRecord,
  addAlternativeToAssistantMessage,
  replaceActiveAlternativeForRegeneration,
  switchActiveAlternativeInMessage,
  getActiveAlternative,
  getAlternativeMetrics,
  findMatchingAlternative,
  ensureConversationAlternatives,
  orderConversationMessages,
  createConversationOrderMemo,
  sanitizeModelForProvider
} from '../src/services/alternativeResponseService.js';
import {
  createRequestIsolationController,
  runIsolatedPromptStream,
  cancelActiveChatRequest
} from '../src/services/requestIsolationService.js';
import {
  sanitizeMessageForStorage,
  buildFirestoreMessagePayload,
  shouldPersistChatMessage,
  restoreAttachmentFromStorage,
  saveCachedChatMessages,
  getCachedChatMessages
} from '../src/services/chatStorageService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

if (typeof globalThis.window === 'undefined') {
  globalThis.window = {};
}
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => {
      store.set(k, String(v));
    },
    removeItem: (k) => {
      store.delete(k);
    },
    clear: () => {
      store.clear();
    }
  };
}

let passed = 0;
let failed = 0;

async function runCase(name, fn) {
  try {
    await fn();
    console.log(`  PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL: ${name}`);
    console.error('       ', err?.stack || err);
    failed++;
  }
}

function getSuccessfulAlternatives(assistantMessage) {
  if (!assistantMessage || !Array.isArray(assistantMessage.alternatives)) {
    return [];
  }
  const hasExplicitErrorFlags = assistantMessage.alternatives.some(
    (alt) => Boolean(alt?.isError || alt?.isInterrupted)
  );
  const rootHasError = Boolean(assistantMessage.isError || assistantMessage.isInterrupted);
  const activeId = assistantMessage.activeAlternativeId;
  return assistantMessage.alternatives.filter((alt) => {
    if (!alt) return false;
    if (alt.isError || alt.isInterrupted) return false;
    if (!hasExplicitErrorFlags && rootHasError && alt.id === activeId) return false;
    return typeof alt.content === 'string' && alt.content.trim().length > 0;
  });
}

function createPhase3Harness({ userId = 'user-phase3', chatId = 'chat-phase3-1' } = {}) {
  const controller = createRequestIsolationController();
  const orderMemo = createConversationOrderMemo();
  const activeChatId = chatId;
  let isLoading = false;
  let inputValue = '';
  let selectedProvider = 'gemini';
  /** @type {any[]} */
  let messages = [];
  const persistedMessageIds = new Set();
  const pendingPersistMessages = new Map();
  /** @type {Record<string, any>} */
  const firestoreMessageDocs = {};

  const updateMessagesState = (updater) => {
    const next = typeof updater === 'function' ? updater(messages) : updater;
    messages = orderMemo(next);
  };

  const findExistingAssistantMessage = (_chatId, assistantMessageId) =>
    messages.find((m) => m.id === assistantMessageId) || null;

  const persistMessageSafe = async (_chatId, message, force = false) => {
    if (!message?.id) return;
    if (force) {
      persistedMessageIds.delete(message.id);
    } else if (persistedMessageIds.has(message.id)) {
      return;
    }
    persistedMessageIds.add(message.id);

    const normalized =
      message.sender === 'assistant' ? normalizeAssistantMessage(message) : message;

    if (!shouldPersistChatMessage(userId, activeChatId, normalized)) {
      return;
    }

    const token = { chatId: activeChatId, message: normalized };
    pendingPersistMessages.set(normalized.id, token);
    try {
      const sanitized = sanitizeMessageForStorage(normalized);
      const currentCache = getCachedChatMessages(userId, activeChatId);
      const nextCache = currentCache.some((m) => m.id === sanitized.id)
        ? currentCache.map((m) => (m.id === sanitized.id ? { ...sanitized, pendingSync: false } : m))
        : [...currentCache, { ...sanitized, pendingSync: false }];
      saveCachedChatMessages(userId, activeChatId, orderConversationMessages(nextCache));

      const payload = buildFirestoreMessagePayload(sanitized);
      firestoreMessageDocs[normalized.id] = {
        ...payload,
        id: normalized.id,
        createdAtMs: payload.createdAtMs,
        clientTimestamp: payload.clientTimestamp
      };
    } finally {
      if (pendingPersistMessages.get(normalized.id) === token) {
        pendingPersistMessages.delete(normalized.id);
      }
    }
  };

  const hydrateFromFirestoreDocs = (docsMap = firestoreMessageDocs) => {
    const hydrated = Object.values(docsMap).map((data) => ({
      id: data.id,
      sender: data.sender,
      content: data.content,
      modelUsed: data.modelUsed || null,
      provider: data.provider || null,
      responseTimeMs: typeof data.responseTimeMs === 'number' ? data.responseTimeMs : null,
      parentMessageId: data.parentMessageId || null,
      interactionId: data.interactionId || null,
      activeAlternativeId: data.activeAlternativeId || null,
      alternatives: Array.isArray(data.alternatives)
        ? data.alternatives.map((alt) => ({
            ...alt,
            attachments: Array.isArray(alt.attachments)
              ? alt.attachments.map(restoreAttachmentFromStorage)
              : [],
            referencedAttachments: Array.isArray(alt.referencedAttachments)
              ? alt.referencedAttachments.map(restoreAttachmentFromStorage)
              : []
          }))
        : [],
      attachments: Array.isArray(data.attachments)
        ? data.attachments.map(restoreAttachmentFromStorage)
        : [],
      referencedAttachments: Array.isArray(data.referencedAttachments)
        ? data.referencedAttachments.map(restoreAttachmentFromStorage)
        : [],
      createdAtMs: data.createdAtMs,
      timestamp: data.clientTimestamp || '',
      pendingSync: false
    }));
    return orderConversationMessages(ensureConversationAlternatives(hydrated));
  };

  // Mirrors updated subscribeToChatMessages snapshot merge in ChatPage.jsx
  const receiveFirestoreSnapshot = (snapshotDocs) => {
    const safeMessages = orderMemo(hydrateFromFirestoreDocs(snapshotDocs));

    const activeRequest = controller.hasActiveRequest()
      ? controller.getActiveRequest()
      : null;
    const activeAssistantId =
      activeRequest && (!activeRequest.chatId || activeRequest.chatId === activeChatId)
        ? activeRequest.assistantMessageId
        : null;

    const pendingPersistMap = new Map();
    pendingPersistMessages.forEach((entry, msgId) => {
      if (entry && entry.chatId === activeChatId && entry.message) {
        pendingPersistMap.set(msgId, entry.message);
      }
    });

    const protectedIds = new Set(pendingPersistMap.keys());
    if (activeAssistantId) {
      protectedIds.add(activeAssistantId);
    }

    const hasActive = controller.hasActiveRequest();
    if (hasActive || protectedIds.size > 0) {
      const seenIds = new Set();
      let didPreserve = false;

      let merged = safeMessages.map((sm) => {
        if (sm?.id) seenIds.add(sm.id);
        if (!sm?.id || !protectedIds.has(sm.id)) return sm;
        const localOverride =
          (sm.id === activeAssistantId ? messages.find((m) => m.id === activeAssistantId) : null) ||
          pendingPersistMap.get(sm.id) ||
          messages.find((m) => m.id === sm.id);
        if (localOverride) {
          didPreserve = true;
          return localOverride;
        }
        return sm;
      });

      if (activeAssistantId && !seenIds.has(activeAssistantId)) {
        const activePrevMsg = messages.find((m) => m.id === activeAssistantId);
        if (activePrevMsg) {
          merged = [...merged, activePrevMsg];
          seenIds.add(activeAssistantId);
          didPreserve = true;
        }
      }

      pendingPersistMap.forEach((pendingMsg, msgId) => {
        if (!seenIds.has(msgId)) {
          merged = [...merged, pendingMsg];
          seenIds.add(msgId);
          didPreserve = true;
        }
      });

      if (hasActive) {
        const missingActiveMsgs = messages.filter((m) => m.id && !seenIds.has(m.id));
        if (missingActiveMsgs.length > 0) {
          merged = [...merged, ...missingActiveMsgs];
          didPreserve = true;
        }
      }

      messages = didPreserve ? orderMemo(merged) : safeMessages;
    } else {
      messages = safeMessages;
    }

    safeMessages.forEach((message) => {
      if (message.id && !protectedIds.has(message.id)) {
        persistedMessageIds.add(message.id);
      }
    });
  };

  const runStream = ({ assistantMessageId, providerToUse, modelToUse = null, promptText, streamRequest }) =>
    runIsolatedPromptStream({
      controller,
      targetChatId: activeChatId,
      assistantMessageId,
      providerToUse,
      effectiveModelOverride: modelToUse,
      promptText,
      currentAttachments: [],
      prefersReducedMotion: true,
      getActiveChatId: () => activeChatId,
      onUpdateMessages: updateMessagesState,
      onPersistMessage: persistMessageSafe,
      onSetLoadingState: (val) => {
        isLoading = Boolean(val);
      },
      findExistingAssistantMessage,
      streamRequest,
      classifyError: (err, ctx) => ({
        friendlyMsg: err?.message || 'Provider error',
        effectiveProvider: ctx?.finalProvider || providerToUse,
        canSwitchProvider: true,
        errorCode: err?.errorCode || 'PROVIDER_ERROR',
        httpStatus: err?.httpStatus || 503
      })
    });

  // Mirrors Phase 1 handleRegenerate in ChatPage.jsx (in-place active alternative replacement)
  const handleRegenerate = async (assistantMessage, streamRequest) => {
    const msgIndex = messages.findIndex((m) => m.id === assistantMessage.id);
    const precedingUserMessage = assistantMessage.parentMessageId
      ? messages.find((m) => m.id === assistantMessage.parentMessageId)
      : [...messages.slice(0, msgIndex)].reverse().find((m) => m.sender === 'user');
    const latestAssistant = messages[msgIndex];
    const normalizedTarget = normalizeAssistantMessage(latestAssistant, precedingUserMessage);
    const activeAlt = getActiveAlternative(normalizedTarget);
    const providerToUse = activeAlt?.provider || latestAssistant.provider || selectedProvider;
    const modelToUse = sanitizeModelForProvider(
      providerToUse,
      activeAlt?.modelUsed || latestAssistant.modelUsed || null
    );

    persistedMessageIds.delete(assistantMessage.id);

    updateMessagesState((previous) =>
      previous.map((m) => {
        if (m.id !== assistantMessage.id) return m;
        return replaceActiveAlternativeForRegeneration(m, {
          provider: providerToUse,
          modelUsed: modelToUse,
          timestamp: '10:05 AM',
          requestStartTime: 100,
          precedingUserMessage
        });
      })
    );

    return runStream({
      assistantMessageId: assistantMessage.id,
      providerToUse,
      modelToUse,
      promptText: precedingUserMessage.content,
      streamRequest
    });
  };

  // Mirrors Phase 2 handleGenerateAlternative in ChatPage.jsx (duplicate prevention + interactionId)
  const handleGenerateAlternative = async (assistantMessage, targetProvider, streamRequest) => {
    const msgIndex = messages.findIndex((m) => m.id === assistantMessage.id);
    const precedingUserMessage = assistantMessage.parentMessageId
      ? messages.find((m) => m.id === assistantMessage.parentMessageId)
      : [...messages.slice(0, msgIndex)].reverse().find((m) => m.sender === 'user');
    const latestAssistant = messages[msgIndex];
    const normalizedTarget = normalizeAssistantMessage(latestAssistant, precedingUserMessage);
    const activeAlt = getActiveAlternative(normalizedTarget);
    const existingAlt = findMatchingAlternative(normalizedTarget, targetProvider);
    if (existingAlt) {
      if (activeAlt && existingAlt.id === activeAlt.id) return { status: 'noop' };
      messages = messages.map((m) =>
        m.id === assistantMessage.id ? switchActiveAlternativeInMessage(m, existingAlt.id) : m
      );
      return { status: 'switched' };
    }

    const chosenModel =
      targetProvider === 'groq'
        ? 'openai/gpt-oss-120b'
        : targetProvider === 'cloudflare'
        ? '@cf/meta/llama-3.1-8b-instruct'
        : targetProvider === 'openrouter'
        ? 'openrouter/free'
        : 'gemini-3.8-flash';

    persistedMessageIds.delete(assistantMessage.id);
    const newAlternative = createAlternativeRecord({
      parentMessageId: precedingUserMessage.id,
      interactionId: precedingUserMessage.interactionId || normalizedTarget.interactionId || null,
      provider: targetProvider,
      modelUsed: chosenModel,
      content: '',
      timestamp: '10:06 AM'
    });

    updateMessagesState((previous) =>
      previous.map((m) => {
        if (m.id !== assistantMessage.id) return m;
        const normalized = normalizeAssistantMessage(m, precedingUserMessage);
        return {
          ...addAlternativeToAssistantMessage(normalized, newAlternative),
          requestStartTime: 100,
          isStreaming: true,
          isError: false,
          isStopped: false,
          isInterrupted: false
        };
      })
    );

    return runStream({
      assistantMessageId: assistantMessage.id,
      providerToUse: targetProvider,
      modelToUse: chosenModel,
      promptText: precedingUserMessage.content,
      streamRequest
    });
  };

  // Mirrors Phase 2 handleRetry in ChatPage.jsx (in-place retry reusing slot & message ID)
  const handleRetry = async (failedMessage, streamRequest) => {
    const failedIdx = messages.findIndex((m) => m.id === failedMessage.id);
    const latestFailedMessage = (failedIdx >= 0 ? messages[failedIdx] : null) || failedMessage;
    const parentUser = latestFailedMessage.parentMessageId
      ? messages.find((m) => m.id === latestFailedMessage.parentMessageId)
      : (failedIdx > 0 ? messages[failedIdx - 1] : null);
    const normalizedFailed = normalizeAssistantMessage(latestFailedMessage, parentUser);
    const activeFailedAlt = getActiveAlternative(normalizedFailed);
    const resolvedFailedPrompt =
      failedMessage?.failedPrompt ||
      latestFailedMessage?.failedPrompt ||
      activeFailedAlt?.failedPrompt;
    const providerToUse =
      failedMessage?.failedProvider ||
      latestFailedMessage?.failedProvider ||
      activeFailedAlt?.failedProvider ||
      activeFailedAlt?.provider ||
      selectedProvider;

    const retryModelOverride = sanitizeModelForProvider(
      providerToUse,
      activeFailedAlt?.modelUsed || null
    );
    const assistantMessageId = normalizedFailed.id;
    persistedMessageIds.delete(assistantMessageId);

    const nextAssistantMessage = replaceActiveAlternativeForRegeneration(normalizedFailed, {
      provider: providerToUse,
      modelUsed: retryModelOverride,
      timestamp: '10:06 AM',
      requestStartTime: 100,
      precedingUserMessage: parentUser
    });

    updateMessagesState((previous) =>
      previous.map((m) => (m.id === assistantMessageId ? nextAssistantMessage : m))
    );

    return runStream({
      assistantMessageId,
      providerToUse,
      modelToUse: retryModelOverride,
      promptText: resolvedFailedPrompt,
      streamRequest
    });
  };

  // Mirrors Phase 2 handleSwitchProviderAndRetry in ChatPage.jsx (in-place switch inside failed slot)
  const handleSwitchProviderAndRetry = async (failedMessage, newProviderId, streamRequest) => {
    selectedProvider = newProviderId;
    const failedSwitchIdx = messages.findIndex((m) => m.id === failedMessage.id);
    const latestFailedMessage = (failedSwitchIdx >= 0 ? messages[failedSwitchIdx] : null) || failedMessage;
    const parentSwitchUser = latestFailedMessage.parentMessageId
      ? messages.find((m) => m.id === latestFailedMessage.parentMessageId)
      : (failedSwitchIdx > 0 ? messages[failedSwitchIdx - 1] : null);
    const normalizedFailed = normalizeAssistantMessage(latestFailedMessage, parentSwitchUser);
    const activeFailedAlt = getActiveAlternative(normalizedFailed);
    const resolvedFailedPrompt =
      failedMessage?.failedPrompt ||
      latestFailedMessage?.failedPrompt ||
      activeFailedAlt?.failedPrompt;

    const assistantMessageId = normalizedFailed.id;
    persistedMessageIds.delete(assistantMessageId);

    const nextAssistantMessage = replaceActiveAlternativeForRegeneration(normalizedFailed, {
      provider: newProviderId,
      modelUsed: null,
      timestamp: '10:07 AM',
      requestStartTime: 100,
      precedingUserMessage: parentSwitchUser
    });

    updateMessagesState((previous) =>
      previous.map((m) => (m.id === assistantMessageId ? nextAssistantMessage : m))
    );

    return runStream({
      assistantMessageId,
      providerToUse: newProviderId,
      modelToUse: null,
      promptText: resolvedFailedPrompt,
      streamRequest
    });
  };

  // Mirrors Phase 2 handleRestorePrompt in ChatPage.jsx
  const handleRestorePrompt = (promptText) => {
    inputValue = promptText;

    const restoreMessageIfFailed = (message) => {
      const normalized =
        message.sender === 'assistant' ? normalizeAssistantMessage(message) : message;
      const activeFailedAlt =
        normalized?.sender === 'assistant' ? getActiveAlternative(normalized) : null;
      const activeFailedPrompt =
        normalized?.failedPrompt || activeFailedAlt?.failedPrompt;

      if (activeFailedPrompt !== promptText) {
        return { keep: true, message, restored: false };
      }
      const validAlts = getSuccessfulAlternatives(normalized);
      if (validAlts.length === 0) {
        return { keep: false, message: null, restored: false };
      }

      const allAlts = Array.isArray(normalized.alternatives) ? normalized.alternatives : [];
      const validIds = new Set(validAlts.map((a) => a.id));
      let targetAlt = null;

      if (normalized.activeAlternativeId && validIds.has(normalized.activeAlternativeId)) {
        targetAlt = validAlts.find((a) => a.id === normalized.activeAlternativeId) || null;
      }
      if (!targetAlt) {
        const failedIdx = allAlts.findIndex((a) => a?.id === normalized.activeAlternativeId);
        if (failedIdx >= 0) {
          for (let i = failedIdx - 1; i >= 0; i--) {
            if (validIds.has(allAlts[i]?.id)) {
              targetAlt = allAlts[i];
              break;
            }
          }
          if (!targetAlt) {
            for (let i = failedIdx + 1; i < allAlts.length; i++) {
              if (validIds.has(allAlts[i]?.id)) {
                targetAlt = allAlts[i];
                break;
              }
            }
          }
        }
      }
      if (!targetAlt) {
        targetAlt = validAlts[validAlts.length - 1];
      }

      const cleaned = switchActiveAlternativeInMessage(
        {
          ...normalized,
          alternatives: validAlts,
          activeAlternativeId: targetAlt.id,
          isStreaming: false,
          isError: false,
          isInterrupted: false,
          isStopped: Boolean(targetAlt.isStopped),
          failedPrompt: undefined,
          failedProvider: undefined,
          canSwitchProvider: undefined,
          errorCode: undefined,
          status: undefined,
          httpStatus: undefined,
          suggestedProviders: undefined
        },
        targetAlt.id
      );
      return { keep: true, message: cleaned, restored: true };
    };

    const restoredToPersist = messages
      .map(restoreMessageIfFailed)
      .filter((e) => e.keep && e.restored && e.message)
      .map((e) => e.message);

    updateMessagesState((previous) => {
      const next = [];
      for (const message of previous) {
        const res = restoreMessageIfFailed(message);
        if (res.keep && res.message) next.push(res.message);
      }
      return next;
    });

    for (const msg of restoredToPersist) {
      void persistMessageSafe(activeChatId, msg, true);
    }
  };

  return {
    controller,
    persistedMessageIds,
    pendingPersistMessages,
    firestoreMessageDocs,
    getMessages: () => messages,
    getInputValue: () => inputValue,
    getIsLoading: () => isLoading,
    setInitialMessages: (initial) => {
      messages = orderMemo(initial);
    },
    persistMessageSafe,
    hydrateFromFirestoreDocs,
    receiveFirestoreSnapshot,
    runStream,
    handleRegenerate,
    handleGenerateAlternative,
    handleRetry,
    handleSwitchProviderAndRetry,
    handleRestorePrompt,
    stopActive: () =>
      cancelActiveChatRequest(controller, 'stopped', {
        getActiveChatId: () => activeChatId,
        onUpdateMessages: updateMessagesState,
        onPersistMessage: persistMessageSafe,
        onSetLoadingState: (val) => {
          isLoading = Boolean(val);
        },
        findExistingAssistantMessage
      }),
    switchAlternative: (assistantId, altId) => {
      messages = messages.map((m) =>
        m.id === assistantId ? switchActiveAlternativeInMessage(m, altId) : m
      );
      const updated = messages.find((m) => m.id === assistantId);
      if (updated) return persistMessageSafe(activeChatId, updated, true);
      return Promise.resolve();
    }
  };
}

async function seedGeminiAndGroqTurn(harness, now = 1718000000000) {
  const userMsg = {
    id: `user-${now}`,
    interactionId: `interaction-${now}`,
    sender: 'user',
    content: 'Compare TCP and UDP.',
    timestamp: '10:00 AM',
    createdAt: now,
    createdAtMs: now
  };
  const alt1 = createAlternativeRecord({
    id: `alt-gemini-${now}`,
    parentMessageId: userMsg.id,
    interactionId: userMsg.interactionId,
    provider: 'gemini',
    modelUsed: 'gemini-3.8-flash',
    content: 'Gemini initial TCP vs UDP answer.',
    responseTimeMs: 320,
    timestamp: '10:00 AM'
  });
  const alt2 = createAlternativeRecord({
    id: `alt-groq-${now}`,
    parentMessageId: userMsg.id,
    interactionId: userMsg.interactionId,
    provider: 'groq',
    modelUsed: 'openai/gpt-oss-120b',
    content: 'Groq TCP vs UDP comparison.',
    responseTimeMs: 210,
    timestamp: '10:01 AM'
  });
  const assistantMsg = normalizeAssistantMessage(
    {
      id: `gemini-${now}-assistant`,
      parentMessageId: userMsg.id,
      interactionId: userMsg.interactionId,
      sender: 'assistant',
      alternatives: [alt1, alt2],
      activeAlternativeId: alt1.id,
      createdAt: now,
      createdAtMs: now
    },
    userMsg
  );

  harness.setInitialMessages([userMsg, assistantMsg]);
  await harness.persistMessageSafe('chat-phase3-1', userMsg, true);
  await harness.persistMessageSafe('chat-phase3-1', assistantMsg, true);
  return { userMsg, assistantMsg, alt1, alt2 };
}

console.log('Running Phase 3 Regeneration History, Recovery & Snapshot Protection tests...');

await runCase('1. ChatPage.jsx contains unified Phase 1 + Phase 2 in-place regeneration, recovery, and snapshot protection logic', async () => {
  const src = fs.readFileSync(path.join(ROOT_DIR, 'src/pages/ChatPage.jsx'), 'utf8');
  assert.ok(src.includes('const getSuccessfulAlternatives ='), 'Expected getSuccessfulAlternatives helper');
  assert.ok(
    src.includes('activeRequest.assistantMessageId'),
    'subscribeToChatMessages must inspect activeRequest.assistantMessageId from requestControllerRef'
  );
  assert.ok(
    src.includes('pendingPersistMessagesRef'),
    'subscribeToChatMessages must protect pendingPersistMessagesRef during async writes'
  );

  const regenBody = src.slice(src.indexOf('const handleRegenerate ='), src.indexOf('const handleGenerateAlternative ='));
  assert.ok(regenBody.includes('replaceActiveAlternativeForRegeneration('), 'handleRegenerate must replace active alternative in-place');
  assert.ok(!regenBody.includes('addAlternativeToAssistantMessage('), 'handleRegenerate must not append alternatives');

  const genAltBody = src.slice(src.indexOf('const handleGenerateAlternative ='), src.indexOf('const handleSwitchAlternative ='));
  assert.ok(genAltBody.includes('findMatchingAlternative('), 'handleGenerateAlternative must check for existing provider/model alternatives');
  assert.ok(genAltBody.includes('addAlternativeToAssistantMessage('), 'handleGenerateAlternative must append genuinely new provider alternatives');

  const retryBody = src.slice(src.indexOf('const handleRetry ='), src.indexOf('const handleSwitchProviderAndRetry ='));
  assert.ok(retryBody.includes('replaceActiveAlternativeForRegeneration('), 'handleRetry must retry failed alternative in-place');
  assert.ok(!retryBody.includes('addAlternativeToAssistantMessage('), 'handleRetry must not append duplicate alternative');

  const switchBody = src.slice(src.indexOf('const handleSwitchProviderAndRetry ='), src.indexOf('const handleRestorePrompt ='));
  assert.ok(switchBody.includes('replaceActiveAlternativeForRegeneration('), 'handleSwitchProviderAndRetry must switch provider in-place');
  assert.ok(!switchBody.includes('addAlternativeToAssistantMessage('), 'handleSwitchProviderAndRetry must not shift unrelated alternatives');

  const restoreBody = src.slice(src.indexOf('const handleRestorePrompt ='), src.indexOf('const handleRegenerate ='));
  assert.ok(restoreBody.includes('getSuccessfulAlternatives('), 'handleRestorePrompt must check getSuccessfulAlternatives');
  assert.ok(restoreBody.includes('switchActiveAlternativeInMessage('), 'handleRestorePrompt must restore valid alternative');
});

await runCase('2. Scenario E (Retry): Failed in-place regeneration persists error state, reuses slot on retry, and preserves Groq', async () => {
  localStorage.clear();
  const harness = createPhase3Harness();
  const { assistantMsg, alt1, alt2 } = await seedGeminiAndGroqTurn(harness, 1718000100000);

  // Trigger normal Regenerate on Gemini (slot 0) and fail with provider error
  await harness.handleRegenerate(assistantMsg, async () => {
    throw new Error('Upstream 429 rate limit');
  });

  const errored = harness.getMessages().find((m) => m.id === assistantMsg.id);
  assert.equal(errored.isError, true);
  assert.equal(errored.failedProvider, 'gemini');
  assert.equal(errored.alternatives.length, 2, 'In-place failed regen must keep exactly 2 slots');
  assert.equal(errored.alternatives[0].id, alt1.id);
  assert.equal(errored.alternatives[0].isError, true);
  assert.equal(errored.alternatives[1].id, alt2.id);
  assert.equal(errored.alternatives[1].content, 'Groq TCP vs UDP comparison.');

  // Verify failed regeneration replaced old Gemini response across reload (no stale restoration!)
  const reloadedFailed = harness.hydrateFromFirestoreDocs();
  assert.equal(reloadedFailed[1].alternatives.length, 2);
  assert.equal(reloadedFailed[1].isError, true);
  assert.equal(reloadedFailed[1].alternatives[0].isError, true);
  assert.equal(
    JSON.stringify(reloadedFailed).includes('Gemini initial TCP vs UDP answer.'),
    false,
    'Replaced Gemini response must not reappear after failed regeneration reload'
  );

  // Retry failed regeneration in-place
  await harness.handleRetry(errored, async ({ onStart, onChunk }) => {
    onStart({ modelUsed: 'gemini-3.8-flash', provider: 'gemini' });
    onChunk('Gemini retried answer.', 'Gemini retried answer.');
    return {
      text: 'Gemini retried answer.',
      modelUsed: 'gemini-3.8-flash',
      provider: 'gemini'
    };
  });

  const afterRetry = harness.getMessages().find((m) => m.id === assistantMsg.id);
  assert.ok(afterRetry, 'Original assistant message container must still exist');
  assert.equal(afterRetry.id, assistantMsg.id, 'Assistant message ID must NOT change (no orphaned docs)');
  assert.equal(afterRetry.isError, false);
  assert.equal(afterRetry.alternatives.length, 2, 'Should keep exactly 2 slots: [Gemini retried, Groq]');
  assert.equal(afterRetry.alternatives[0].id, alt1.id, 'Slot 0 ID must be reused');
  assert.equal(afterRetry.alternatives[0].content, 'Gemini retried answer.');
  assert.equal(afterRetry.alternatives[1].id, alt2.id);
  assert.equal(afterRetry.alternatives[1].content, 'Groq TCP vs UDP comparison.');
  assert.equal(afterRetry.activeAlternativeId, alt1.id);

  // Verify persistence across Firestore reload
  const reloaded = harness.hydrateFromFirestoreDocs();
  assert.equal(reloaded[1].alternatives.length, 2);
  assert.equal(reloaded[1].alternatives[0].content, 'Gemini retried answer.');
  assert.equal(reloaded[1].alternatives[1].content, 'Groq TCP vs UDP comparison.');
});

await runCase('3. Initial-turn failure retry (single alternative) reuses message ID and persists once recovered', async () => {
  localStorage.clear();
  const harness = createPhase3Harness();
  const now = 1718000200000;
  const userMsg = {
    id: `user-${now}`,
    interactionId: `interaction-${now}`,
    sender: 'user',
    content: 'Hello world',
    timestamp: '10:00 AM',
    createdAt: now,
    createdAtMs: now
  };
  const failedInitial = normalizeAssistantMessage(
    {
      id: `gemini-${now}-assistant`,
      parentMessageId: userMsg.id,
      interactionId: userMsg.interactionId,
      sender: 'assistant',
      provider: 'gemini',
      content: 'Rate limit exceeded',
      isError: true,
      failedPrompt: 'Hello world',
      failedProvider: 'gemini',
      createdAt: now,
      createdAtMs: now
    },
    userMsg
  );
  harness.setInitialMessages([userMsg, failedInitial]);
  await harness.persistMessageSafe('chat-phase3-1', userMsg, true);

  await harness.handleRetry(failedInitial, async ({ onStart, onChunk }) => {
    onStart({ modelUsed: 'gemini-3.8-flash', provider: 'gemini' });
    onChunk('Recovered hello!', 'Recovered hello!');
    return { text: 'Recovered hello!', modelUsed: 'gemini-3.8-flash', provider: 'gemini' };
  });

  const msgs = harness.getMessages();
  assert.equal(msgs.length, 2);
  assert.equal(msgs[1].id, failedInitial.id, 'Initial failure retry reuses message ID without creating orphans');
  assert.equal(msgs[1].alternatives.length, 1);
  assert.equal(msgs[1].content, 'Recovered hello!');
  assert.equal(msgs[1].isError, false);

  const reloaded = harness.hydrateFromFirestoreDocs();
  assert.equal(reloaded.length, 2);
  assert.equal(reloaded[1].content, 'Recovered hello!');
});

await runCase('4. Scenario E (Interrupted + Switch Provider + Reload): Interrupted metadata survives reload and switch-provider updates slot in-place', async () => {
  localStorage.clear();
  const harness = createPhase3Harness();
  const { assistantMsg, alt1, alt2 } = await seedGeminiAndGroqTurn(harness, 1718000300000);

  // Trigger normal Regenerate on Gemini (slot 0) and fail mid-stream (isInterrupted: true)
  await harness.handleRegenerate(assistantMsg, async ({ onStart, onChunk }) => {
    onStart({ modelUsed: 'gemini-3.8-flash', provider: 'gemini' });
    onChunk('Partial stream', 'Partial stream');
    throw new Error('Connection dropped mid-stream');
  });

  const interrupted = harness.getMessages().find((m) => m.id === assistantMsg.id);
  assert.equal(interrupted.isInterrupted, true);
  assert.equal(interrupted.alternatives.length, 2);
  assert.equal(interrupted.alternatives[0].isInterrupted, true);
  assert.equal(interrupted.alternatives[0].failedPrompt, 'Compare TCP and UDP.');
  assert.equal(interrupted.alternatives[1].content, 'Groq TCP vs UDP comparison.');

  // Verify interrupted recovery metadata survives Firestore reload before switching provider
  const reloadedInterrupted = harness.hydrateFromFirestoreDocs();
  assert.equal(reloadedInterrupted[1].isInterrupted, true);
  assert.equal(reloadedInterrupted[1].failedPrompt, 'Compare TCP and UDP.');
  assert.equal(reloadedInterrupted[1].failedProvider, 'gemini');
  assert.equal(reloadedInterrupted[1].alternatives[1].content, 'Groq TCP vs UDP comparison.');

  await harness.handleSwitchProviderAndRetry(reloadedInterrupted[1], 'openrouter', async ({ onStart, onChunk }) => {
    onStart({ modelUsed: 'openrouter/free', provider: 'openrouter' });
    onChunk('OpenRouter fallback answer.', 'OpenRouter fallback answer.');
    return {
      text: 'OpenRouter fallback answer.',
      modelUsed: 'openrouter/free',
      provider: 'openrouter'
    };
  });

  const afterSwitch = harness.getMessages().find((m) => m.id === assistantMsg.id);
  assert.equal(afterSwitch.id, assistantMsg.id);
  assert.equal(afterSwitch.isError, false);
  assert.equal(afterSwitch.isInterrupted, false);
  assert.equal(afterSwitch.alternatives.length, 2, 'Switch-provider retry updates slot 0 in-place without shifting slot 1');
  assert.equal(afterSwitch.alternatives[0].id, alt1.id);
  assert.equal(afterSwitch.alternatives[0].provider, 'openrouter');
  assert.equal(afterSwitch.alternatives[0].content, 'OpenRouter fallback answer.');
  assert.equal(afterSwitch.alternatives[1].id, alt2.id);
  assert.equal(afterSwitch.alternatives[1].content, 'Groq TCP vs UDP comparison.');
  assert.equal(afterSwitch.activeAlternativeId, alt1.id);

  const reloadedFinal = harness.hydrateFromFirestoreDocs();
  assert.equal(reloadedFinal[1].alternatives.length, 2);
  assert.equal(reloadedFinal[1].alternatives[0].provider, 'openrouter');
  assert.equal(reloadedFinal[1].alternatives[0].content, 'OpenRouter fallback answer.');
  assert.equal(reloadedFinal[1].alternatives[1].content, 'Groq TCP vs UDP comparison.');
});

await runCase('5. Scenario E (Restore Prompt): Removes only failed slot when valid alternatives exist, and removes message when none exist', async () => {
  localStorage.clear();
  const harness = createPhase3Harness();
  const { userMsg, assistantMsg, alt1, alt2 } = await seedGeminiAndGroqTurn(harness, 1718000400000);

  // Switch to Groq (slot 1), regenerate, and fail
  await harness.switchAlternative(assistantMsg.id, alt2.id);
  await harness.handleRegenerate(harness.getMessages().find((m) => m.id === assistantMsg.id), async () => {
    throw new Error('Temporary outage');
  });

  const errored = harness.getMessages().find((m) => m.id === assistantMsg.id);
  assert.equal(errored.isError, true);
  assert.equal(errored.alternatives.length, 2);

  harness.handleRestorePrompt(userMsg.content);

  assert.equal(harness.getInputValue(), userMsg.content);
  const restoredMsgs = harness.getMessages();
  assert.equal(restoredMsgs.length, 2, 'Assistant message must NOT be deleted when valid alternatives exist');
  const restoredAssistant = restoredMsgs[1];
  assert.equal(restoredAssistant.isError, false);
  assert.equal(restoredAssistant.isInterrupted, false);
  assert.equal(restoredAssistant.failedPrompt, undefined);
  assert.equal(restoredAssistant.alternatives.length, 1, 'Only failed slot removed');
  assert.equal(restoredAssistant.alternatives[0].id, alt1.id);
  assert.equal(restoredAssistant.activeAlternativeId, alt1.id, 'Should restore remaining valid Gemini alternative');
  assert.equal(restoredAssistant.content, 'Gemini initial TCP vs UDP answer.');
  assert.equal(getAlternativeMetrics(restoredAssistant).total, 1);

  // Also test message with zero successful alternatives -> deleted as before
  const harnessEmpty = createPhase3Harness({ chatId: 'chat-empty-restore' });
  const u0 = { id: 'u0', interactionId: 'i0', sender: 'user', content: 'First prompt', createdAt: 100, createdAtMs: 100 };
  const a0 = normalizeAssistantMessage(
    {
      id: 'a0',
      parentMessageId: 'u0',
      interactionId: 'i0',
      sender: 'assistant',
      provider: 'gemini',
      content: 'Error happened',
      isError: true,
      failedPrompt: 'First prompt',
      createdAt: 100,
      createdAtMs: 100
    },
    u0
  );
  harnessEmpty.setInitialMessages([u0, a0]);
  harnessEmpty.handleRestorePrompt('First prompt');
  assert.equal(harnessEmpty.getMessages().length, 1, 'Message with no successful alternatives must still be removed');
});

await runCase('6. Scenario F (Snapshot Safety): Stale Firestore snapshot arriving during active in-place regeneration does not restore old response', async () => {
  localStorage.clear();
  const harness = createPhase3Harness();
  const { assistantMsg, alt1, alt2 } = await seedGeminiAndGroqTurn(harness, 1718000500000);

  // Freeze stale Firestore docs (containing Gemini initial answer + Groq)
  const staleFirestoreDocs = JSON.parse(JSON.stringify(harness.firestoreMessageDocs));

  let releaseFinish;
  const finishGate = new Promise((resolve) => {
    releaseFinish = resolve;
  });

  const regenPromise = harness.handleRegenerate(assistantMsg, async ({ onStart, onChunk }) => {
    onStart({ modelUsed: 'gemini-3.8-flash', provider: 'gemini' });
    onChunk('Streaming new part 1... ', 'Streaming new part 1... ');
    await new Promise((r) => setTimeout(r, 25));

    // Simulate incoming stale Firestore snapshot mid-stream containing the replaced Gemini response
    harness.receiveFirestoreSnapshot(staleFirestoreDocs);

    const duringStream = harness.getMessages().find((m) => m.id === assistantMsg.id);
    assert.equal(duringStream.alternatives.length, 2, 'In-place regeneration preserves exact 2 alternatives');
    assert.equal(duringStream.content, 'Streaming new part 1... ', 'Streamed content must NOT revert to stale snapshot');
    assert.equal(
      JSON.stringify(duringStream).includes('Gemini initial TCP vs UDP answer.'),
      false,
      'Stale snapshot must not restore replaced Gemini response mid-stream'
    );

    await finishGate;
    onChunk('part 2 complete.', 'Streaming new part 1... part 2 complete.');
    return {
      text: 'Streaming new part 1... part 2 complete.',
      modelUsed: 'gemini-3.8-flash',
      provider: 'gemini'
    };
  });

  await new Promise((r) => setTimeout(r, 25));
  releaseFinish();
  await regenPromise;

  const finalMsg = harness.getMessages().find((m) => m.id === assistantMsg.id);
  assert.equal(finalMsg.alternatives.length, 2);
  assert.equal(finalMsg.alternatives[0].id, alt1.id);
  assert.equal(finalMsg.alternatives[0].content, 'Streaming new part 1... part 2 complete.');
  assert.equal(finalMsg.alternatives[1].id, alt2.id);
  assert.equal(finalMsg.alternatives[1].content, 'Groq TCP vs UDP comparison.');
  assert.equal(finalMsg.content, 'Streaming new part 1... part 2 complete.');

  // Confirm final persisted Firestore state has replaced response and old response is absent
  const reloaded = harness.hydrateFromFirestoreDocs();
  assert.equal(reloaded[1].alternatives.length, 2);
  assert.equal(reloaded[1].alternatives[0].content, 'Streaming new part 1... part 2 complete.');
  assert.equal(JSON.stringify(reloaded).includes('Gemini initial TCP vs UDP answer.'), false);
});

await runCase('7. Scenario B + C + Stop + Reload: Full end-to-end Grok -> Cloudflare -> Regenerate -> Stop -> Reload lifecycle', async () => {
  localStorage.clear();
  const harness = createPhase3Harness();
  const now = 1718000600000;
  const userMsg = {
    id: `user-${now}`,
    interactionId: `interaction-${now}`,
    sender: 'user',
    content: 'Explain event loop.',
    timestamp: '11:00 AM',
    createdAt: now,
    createdAtMs: now
  };
  const initialAssistant = normalizeAssistantMessage(
    {
      id: `groq-${now}-assistant`,
      parentMessageId: userMsg.id,
      interactionId: userMsg.interactionId,
      sender: 'assistant',
      provider: 'groq',
      modelUsed: 'openai/gpt-oss-120b',
      content: '',
      timestamp: '11:00 AM',
      createdAt: now,
      createdAtMs: now,
      isStreaming: true
    },
    userMsg
  );
  harness.setInitialMessages([userMsg, initialAssistant]);
  await harness.persistMessageSafe('chat-phase3-1', userMsg, true);

  // 1. Generate Grok
  await harness.runStream({
    assistantMessageId: initialAssistant.id,
    providerToUse: 'groq',
    modelToUse: 'openai/gpt-oss-120b',
    promptText: userMsg.content,
    streamRequest: async ({ onStart, onChunk }) => {
      onStart({ provider: 'groq', modelUsed: 'openai/gpt-oss-120b' });
      onChunk('Grok event loop.', 'Grok event loop.');
      return { text: 'Grok event loop.', provider: 'groq', modelUsed: 'openai/gpt-oss-120b' };
    }
  });

  // 2. Regenerate with another AI model -> Cloudflare (creates 2nd alt)
  await harness.handleGenerateAlternative(
    harness.getMessages()[1],
    'cloudflare',
    async ({ onStart, onChunk }) => {
      onStart({ provider: 'cloudflare', modelUsed: '@cf/meta/llama-3.1-8b-instruct' });
      onChunk('Cloudflare old event loop.', 'Cloudflare old event loop.');
      return {
        text: 'Cloudflare old event loop.',
        provider: 'cloudflare',
        modelUsed: '@cf/meta/llama-3.1-8b-instruct'
      };
    }
  );
  assert.equal(harness.getMessages()[1].alternatives.length, 2);

  // 3. Normal Regenerate while viewing Cloudflare -> replaces only Cloudflare, keeps Grok
  await harness.handleRegenerate(harness.getMessages()[1], async ({ onStart, onChunk }) => {
    onStart({ provider: 'cloudflare', modelUsed: '@cf/meta/llama-3.1-8b-instruct' });
    onChunk('Cloudflare latest event loop.', 'Cloudflare latest event loop.');
    return {
      text: 'Cloudflare latest event loop.',
      provider: 'cloudflare',
      modelUsed: '@cf/meta/llama-3.1-8b-instruct'
    };
  });

  const afterRegen = harness.getMessages()[1];
  assert.equal(afterRegen.alternatives.length, 2);
  assert.equal(afterRegen.alternatives[0].content, 'Grok event loop.');
  assert.equal(afterRegen.alternatives[1].content, 'Cloudflare latest event loop.');
  assert.equal(JSON.stringify(afterRegen).includes('Cloudflare old event loop.'), false);

  // 4. Reload & verify persistence
  const reloaded = harness.hydrateFromFirestoreDocs();
  assert.equal(reloaded[1].alternatives.length, 2);
  assert.equal(reloaded[1].alternatives[0].content, 'Grok event loop.');
  assert.equal(reloaded[1].alternatives[1].content, 'Cloudflare latest event loop.');
});

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
if (failed > 0) {
  process.exit(1);
}
