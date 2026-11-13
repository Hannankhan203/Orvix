/**
 * Regression Suite: Phase 3 Regeneration History & Snapshot Protection
 *
 * Verifies:
 * 1. ChatPage.jsx implements retry preservation (`handleRetry`, `handleSwitchProviderAndRetry`),
 *    restore-prompt preservation (`handleRestorePrompt`), and stale-snapshot protection
 *    (`subscribeToChatMessages` using `requestControllerRef.current.getActiveRequest()`).
 * 2. Retrying a failed regeneration preserves all previously successful Gemini/Groq responses
 *    and appends the retried response as a new alternative.
 * 3. Initial-turn failure retry (no prior successful alternatives) preserves existing replace behavior.
 * 4. Switching provider and retrying after a failed/interrupted regeneration preserves prior
 *    Gemini/Groq responses and appends the fallback provider response as a new alternative.
 * 5. Restoring prompt after failure removes only the failed attempt, restores the most recent
 *    valid alternative, and deletes the message only when no successful alternatives exist.
 * 6. Stale Firestore snapshots arriving mid-stream do not revert or overwrite the active
 *    in-progress assistant message (matched by `assistantMessageId` on `requestControllerRef`).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  normalizeAssistantMessage,
  createAlternativeRecord,
  addAlternativeToAssistantMessage,
  switchActiveAlternativeInMessage,
  getActiveAlternative,
  getAlternativeMetrics,
  ensureConversationAlternatives,
  orderConversationMessages,
  createConversationOrderMemo,
  sanitizeModelForProvider
} from '../src/services/alternativeResponseService.js';
import {
  createRequestIsolationController,
  runIsolatedPromptStream
} from '../src/services/requestIsolationService.js';
import {
  sanitizeMessageForStorage,
  buildFirestoreMessagePayload,
  restoreAttachmentFromStorage
} from '../src/services/chatStorageService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

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
  const rootHasError = Boolean(assistantMessage.isError || assistantMessage.isInterrupted);
  const activeId = assistantMessage.activeAlternativeId;
  return assistantMessage.alternatives.filter((alt) => {
    if (!alt) return false;
    if (alt.isError || alt.isInterrupted) return false;
    if (rootHasError && alt.id === activeId) return false;
    return typeof alt.content === 'string' && alt.content.trim().length > 0;
  });
}

function createPhase3Harness() {
  const controller = createRequestIsolationController();
  const orderMemo = createConversationOrderMemo();
  const activeChatId = 'chat-phase3-1';
  let isLoading = false;
  let inputValue = '';
  let selectedProvider = 'gemini';
  /** @type {any[]} */
  let messages = [];
  const persistedMessageIds = new Set();
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
    if (normalized.isError) return;

    const payload = buildFirestoreMessagePayload(normalized);
    firestoreMessageDocs[normalized.id] = {
      ...payload,
      id: normalized.id,
      createdAtMs: payload.createdAtMs,
      clientTimestamp: payload.clientTimestamp
    };
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
      timestamp: data.clientTimestamp || ''
    }));
    return orderConversationMessages(ensureConversationAlternatives(hydrated));
  };

  // Mirrors updated subscribeToChatMessages snapshot merge in ChatPage.jsx
  const receiveFirestoreSnapshot = (snapshotDocs) => {
    const safeMessages = orderMemo(hydrateFromFirestoreDocs(snapshotDocs));

    if (controller.hasActiveRequest()) {
      const activeRequest = controller.getActiveRequest();
      const activeAssistantId =
        activeRequest && (!activeRequest.chatId || activeRequest.chatId === activeChatId)
          ? activeRequest.assistantMessageId
          : null;
      const activePrevMsg = activeAssistantId
        ? messages.find((m) => m.id === activeAssistantId)
        : null;

      let merged = safeMessages;
      let didPreserve = false;

      if (activePrevMsg) {
        const existsInSafe = safeMessages.some((sm) => sm.id === activeAssistantId);
        merged = existsInSafe
          ? safeMessages.map((sm) => (sm.id === activeAssistantId ? activePrevMsg : sm))
          : [...safeMessages, activePrevMsg];
        didPreserve = true;
      }

      const missingActiveMsgs = messages.filter(
        (m) => m.id && m.id !== activeAssistantId && !merged.some((sm) => sm.id === m.id)
      );
      if (missingActiveMsgs.length > 0) {
        merged = [...merged, ...missingActiveMsgs];
        didPreserve = true;
      }

      messages = didPreserve ? orderMemo(merged) : safeMessages;
    } else {
      messages = safeMessages;
    }

    const activeReqDuringSnapshot = controller.hasActiveRequest()
      ? controller.getActiveRequest()
      : null;
    const activeSnapshotSkipId =
      activeReqDuringSnapshot &&
      (!activeReqDuringSnapshot.chatId || activeReqDuringSnapshot.chatId === activeChatId)
        ? activeReqDuringSnapshot.assistantMessageId
        : null;

    safeMessages.forEach((message) => {
      if (message.id && message.id !== activeSnapshotSkipId) {
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
        canSwitchProvider: true
      })
    });

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

    const newAlternative = createAlternativeRecord({
      parentMessageId: precedingUserMessage.id,
      interactionId: precedingUserMessage.interactionId || normalizedTarget.interactionId || null,
      provider: providerToUse,
      modelUsed: modelToUse,
      content: '',
      isStreaming: true,
      timestamp: '10:05 AM'
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
          isStopped: false
        };
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

  // Mirrors Phase 3 handleRetry in ChatPage.jsx
  const handleRetry = async (failedMessage, streamRequest) => {
    const providerToUse = failedMessage.failedProvider || selectedProvider;
    const failedIdx = messages.findIndex((m) => m.id === failedMessage.id);
    const latestFailedMessage = (failedIdx >= 0 ? messages[failedIdx] : null) || failedMessage;
    const parentUser = latestFailedMessage.parentMessageId
      ? messages.find((m) => m.id === latestFailedMessage.parentMessageId)
      : (failedIdx > 0 ? messages[failedIdx - 1] : null);
    const parentMessageId = parentUser?.id || latestFailedMessage.parentMessageId || null;
    const interactionId = parentUser?.interactionId || latestFailedMessage.interactionId || null;

    const normalizedFailed = normalizeAssistantMessage(latestFailedMessage, parentUser);
    const successfulAlts = getSuccessfulAlternatives(normalizedFailed);
    const hasSuccessfulAlternatives = successfulAlts.length > 0;

    let assistantMessageId;
    let nextAssistantMessage;
    let retryModelOverride = null;

    if (hasSuccessfulAlternatives) {
      assistantMessageId = normalizedFailed.id;
      persistedMessageIds.delete(assistantMessageId);

      const activeFailedAlt = getActiveAlternative(normalizedFailed);
      retryModelOverride = sanitizeModelForProvider(
        providerToUse,
        activeFailedAlt?.modelUsed || null
      );

      const newRetryAlternative = createAlternativeRecord({
        parentMessageId,
        interactionId: interactionId || normalizedFailed.interactionId || null,
        provider: providerToUse,
        modelUsed: retryModelOverride,
        content: '',
        isStreaming: true,
        timestamp: '10:06 AM'
      });

      const latestValidAlt = successfulAlts[successfulAlts.length - 1];
      const basePreserved = {
        ...normalizedFailed,
        alternatives: successfulAlts,
        activeAlternativeId: latestValidAlt.id
      };

      nextAssistantMessage = {
        ...addAlternativeToAssistantMessage(basePreserved, newRetryAlternative),
        requestStartTime: 100,
        isStreaming: true,
        isError: false,
        isInterrupted: false,
        failedPrompt: undefined,
        failedProvider: undefined,
        canSwitchProvider: undefined,
        errorCode: undefined,
        status: undefined,
        httpStatus: undefined,
        suggestedProviders: undefined
      };
    } else {
      assistantMessageId = `${providerToUse}-${Date.now()}-retry`;
      nextAssistantMessage = normalizeAssistantMessage(
        {
          id: assistantMessageId,
          sender: 'assistant',
          parentMessageId,
          interactionId,
          provider: providerToUse,
          modelUsed: null,
          timestamp: '10:06 AM',
          createdAt: Date.now(),
          createdAtMs: Date.now(),
          content: '',
          isStreaming: true,
          requestStartTime: 100
        },
        parentUser
      );
    }

    const updatedMessages =
      failedIdx >= 0
        ? messages.map((m, idx) => (idx === failedIdx ? nextAssistantMessage : m))
        : [...messages, nextAssistantMessage];

    updateMessagesState(updatedMessages);

    return runStream({
      assistantMessageId,
      providerToUse,
      modelToUse: retryModelOverride,
      promptText: latestFailedMessage.failedPrompt,
      streamRequest
    });
  };

  // Mirrors Phase 3 handleSwitchProviderAndRetry in ChatPage.jsx
  const handleSwitchProviderAndRetry = async (failedMessage, newProviderId, streamRequest) => {
    selectedProvider = newProviderId;
    const failedSwitchIdx = messages.findIndex((m) => m.id === failedMessage.id);
    const latestFailedMessage = (failedSwitchIdx >= 0 ? messages[failedSwitchIdx] : null) || failedMessage;
    const parentSwitchUser = latestFailedMessage.parentMessageId
      ? messages.find((m) => m.id === latestFailedMessage.parentMessageId)
      : (failedSwitchIdx > 0 ? messages[failedSwitchIdx - 1] : null);
    const parentMessageId = parentSwitchUser?.id || latestFailedMessage.parentMessageId || null;
    const interactionId = parentSwitchUser?.interactionId || latestFailedMessage.interactionId || null;

    const normalizedFailed = normalizeAssistantMessage(latestFailedMessage, parentSwitchUser);
    const successfulAlts = getSuccessfulAlternatives(normalizedFailed);
    const hasSuccessfulAlternatives = successfulAlts.length > 0;

    let assistantMessageId;
    let nextAssistantMessage;

    if (hasSuccessfulAlternatives) {
      assistantMessageId = normalizedFailed.id;
      persistedMessageIds.delete(assistantMessageId);

      const newSwitchAlternative = createAlternativeRecord({
        parentMessageId,
        interactionId: interactionId || normalizedFailed.interactionId || null,
        provider: newProviderId,
        modelUsed: null,
        content: '',
        isStreaming: true,
        timestamp: '10:07 AM'
      });

      const latestValidAlt = successfulAlts[successfulAlts.length - 1];
      const basePreserved = {
        ...normalizedFailed,
        alternatives: successfulAlts,
        activeAlternativeId: latestValidAlt.id
      };

      nextAssistantMessage = {
        ...addAlternativeToAssistantMessage(basePreserved, newSwitchAlternative),
        requestStartTime: 100,
        isStreaming: true,
        isError: false,
        isInterrupted: false,
        failedPrompt: undefined,
        failedProvider: undefined,
        canSwitchProvider: undefined,
        errorCode: undefined,
        status: undefined,
        httpStatus: undefined,
        suggestedProviders: undefined
      };
    } else {
      assistantMessageId = `${newProviderId}-${Date.now()}-fallback`;
      nextAssistantMessage = normalizeAssistantMessage(
        {
          id: assistantMessageId,
          sender: 'assistant',
          parentMessageId,
          interactionId,
          provider: newProviderId,
          modelUsed: null,
          timestamp: '10:07 AM',
          createdAt: Date.now(),
          createdAtMs: Date.now(),
          content: '',
          isStreaming: true,
          requestStartTime: 100
        },
        parentSwitchUser
      );
    }

    const updatedMessages =
      failedSwitchIdx >= 0
        ? messages.map((m, idx) => (idx === failedSwitchIdx ? nextAssistantMessage : m))
        : [...messages, nextAssistantMessage];

    updateMessagesState(updatedMessages);

    return runStream({
      assistantMessageId,
      providerToUse: newProviderId,
      modelToUse: null,
      promptText: latestFailedMessage.failedPrompt,
      streamRequest
    });
  };

  // Mirrors Phase 3 handleRestorePrompt in ChatPage.jsx
  const handleRestorePrompt = (promptText) => {
    inputValue = promptText;

    const restoreMessageIfFailed = (message) => {
      if (message.failedPrompt !== promptText) {
        return { keep: true, message, restored: false };
      }
      const normalized =
        message.sender === 'assistant' ? normalizeAssistantMessage(message) : message;
      const validAlts = getSuccessfulAlternatives(normalized);
      if (validAlts.length === 0) {
        return { keep: false, message: null, restored: false };
      }
      const latestValidAlt = validAlts[validAlts.length - 1];
      const cleaned = switchActiveAlternativeInMessage(
        {
          ...normalized,
          alternatives: validAlts,
          activeAlternativeId: latestValidAlt.id,
          isStreaming: false,
          isError: false,
          isInterrupted: false,
          isStopped: Boolean(latestValidAlt.isStopped),
          failedPrompt: undefined,
          failedProvider: undefined,
          canSwitchProvider: undefined,
          errorCode: undefined,
          status: undefined,
          httpStatus: undefined,
          suggestedProviders: undefined
        },
        latestValidAlt.id
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
    handleRetry,
    handleSwitchProviderAndRetry,
    handleRestorePrompt,
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

console.log('Running Phase 3 Regeneration History & Snapshot Protection tests...');

await runCase('1. ChatPage.jsx contains Phase 3 retry, restore-prompt, and snapshot protection logic', async () => {
  const src = fs.readFileSync(path.join(ROOT_DIR, 'src/pages/ChatPage.jsx'), 'utf8');
  assert.ok(src.includes('const getSuccessfulAlternatives ='), 'Expected getSuccessfulAlternatives helper');
  assert.ok(
    src.includes('activeRequest.assistantMessageId'),
    'subscribeToChatMessages must inspect activeRequest.assistantMessageId from requestControllerRef'
  );

  const retryBody = src.slice(src.indexOf('const handleRetry ='), src.indexOf('const handleSwitchProviderAndRetry ='));
  assert.ok(retryBody.includes('getSuccessfulAlternatives('), 'handleRetry must check getSuccessfulAlternatives');
  assert.ok(retryBody.includes('addAlternativeToAssistantMessage('), 'handleRetry must append alternative when prior valid ones exist');

  const switchBody = src.slice(src.indexOf('const handleSwitchProviderAndRetry ='), src.indexOf('const handleRestorePrompt ='));
  assert.ok(switchBody.includes('getSuccessfulAlternatives('), 'handleSwitchProviderAndRetry must check getSuccessfulAlternatives');
  assert.ok(switchBody.includes('addAlternativeToAssistantMessage('), 'handleSwitchProviderAndRetry must append alternative when prior valid ones exist');

  const restoreBody = src.slice(src.indexOf('const handleRestorePrompt ='), src.indexOf('const handleRegenerate ='));
  assert.ok(restoreBody.includes('getSuccessfulAlternatives('), 'handleRestorePrompt must check getSuccessfulAlternatives');
  assert.ok(restoreBody.includes('switchActiveAlternativeInMessage('), 'handleRestorePrompt must restore latest valid alternative');
});

await runCase('2. Retry after failed regeneration preserves previous Gemini/Groq responses and appends retried Gemini response', async () => {
  const harness = createPhase3Harness();
  const { assistantMsg, alt1, alt2 } = await seedGeminiAndGroqTurn(harness, 1718000100000);

  // Trigger normal Regenerate on Gemini and fail with provider error
  await harness.handleRegenerate(assistantMsg, async () => {
    throw new Error('Upstream 429 rate limit');
  });

  const errored = harness.getMessages().find((m) => m.id === assistantMsg.id);
  assert.equal(errored.isError, true);
  assert.equal(errored.failedProvider, 'gemini');
  assert.equal(errored.alternatives.length, 3);
  assert.equal(errored.alternatives[0].content, 'Gemini initial TCP vs UDP answer.');
  assert.equal(errored.alternatives[1].content, 'Groq TCP vs UDP comparison.');

  // Retry failed regeneration
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
  assert.equal(afterRetry.id, assistantMsg.id, 'Assistant message ID must NOT be replaced');
  assert.equal(afterRetry.isError, false);
  assert.equal(afterRetry.alternatives.length, 3, 'Should contain Gemini v1, Groq v1, and retried Gemini');
  assert.equal(afterRetry.alternatives[0].id, alt1.id);
  assert.equal(afterRetry.alternatives[0].content, 'Gemini initial TCP vs UDP answer.');
  assert.equal(afterRetry.alternatives[1].id, alt2.id);
  assert.equal(afterRetry.alternatives[1].content, 'Groq TCP vs UDP comparison.');
  assert.equal(afterRetry.alternatives[2].content, 'Gemini retried answer.');
  assert.equal(afterRetry.activeAlternativeId, afterRetry.alternatives[2].id);

  // Verify persistence across Firestore reload
  const reloaded = harness.hydrateFromFirestoreDocs();
  assert.equal(reloaded[1].alternatives.length, 3);
  assert.equal(reloaded[1].alternatives[0].content, 'Gemini initial TCP vs UDP answer.');
  assert.equal(reloaded[1].alternatives[1].content, 'Groq TCP vs UDP comparison.');
  assert.equal(reloaded[1].alternatives[2].content, 'Gemini retried answer.');
});

await runCase('3. Initial-turn failure retry (no prior valid alternatives) preserves replacement behavior', async () => {
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

  await harness.handleRetry(failedInitial, async ({ onStart, onChunk }) => {
    onStart({ modelUsed: 'gemini-3.8-flash', provider: 'gemini' });
    onChunk('Recovered hello!', 'Recovered hello!');
    return { text: 'Recovered hello!', modelUsed: 'gemini-3.8-flash', provider: 'gemini' };
  });

  const msgs = harness.getMessages();
  assert.equal(msgs.length, 2);
  assert.notEqual(msgs[1].id, failedInitial.id, 'Initial failure retry keeps existing replacement ID behavior');
  assert.equal(msgs[1].alternatives.length, 1);
  assert.equal(msgs[1].content, 'Recovered hello!');
});

await runCase('4. Switch provider & retry after interrupted regeneration preserves Gemini/Groq history and appends new provider', async () => {
  const harness = createPhase3Harness();
  const { assistantMsg, alt1, alt2 } = await seedGeminiAndGroqTurn(harness, 1718000300000);

  // Trigger normal Regenerate and fail mid-stream (isInterrupted: true)
  await harness.handleRegenerate(assistantMsg, async ({ onStart, onChunk }) => {
    onStart({ modelUsed: 'gemini-3.8-flash', provider: 'gemini' });
    onChunk('Partial stream', 'Partial stream');
    throw new Error('Connection dropped mid-stream');
  });

  const interrupted = harness.getMessages().find((m) => m.id === assistantMsg.id);
  assert.equal(interrupted.isInterrupted, true);
  assert.equal(interrupted.alternatives.length, 3);

  await harness.handleSwitchProviderAndRetry(interrupted, 'openrouter', async ({ onStart, onChunk }) => {
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
  assert.equal(afterSwitch.alternatives.length, 3);
  assert.equal(afterSwitch.alternatives[0].id, alt1.id);
  assert.equal(afterSwitch.alternatives[0].content, 'Gemini initial TCP vs UDP answer.');
  assert.equal(afterSwitch.alternatives[1].id, alt2.id);
  assert.equal(afterSwitch.alternatives[1].content, 'Groq TCP vs UDP comparison.');
  assert.equal(afterSwitch.alternatives[2].provider, 'openrouter');
  assert.equal(afterSwitch.alternatives[2].content, 'OpenRouter fallback answer.');
  assert.equal(afterSwitch.activeAlternativeId, afterSwitch.alternatives[2].id);
});

await runCase('5. handleRestorePrompt removes only failed attempt when valid alternatives exist, and removes message when none exist', async () => {
  const harness = createPhase3Harness();
  const { userMsg, assistantMsg, alt1, alt2 } = await seedGeminiAndGroqTurn(harness, 1718000400000);

  // Fail a regeneration on Gemini
  await harness.handleRegenerate(assistantMsg, async () => {
    throw new Error('Temporary outage');
  });

  const errored = harness.getMessages().find((m) => m.id === assistantMsg.id);
  assert.equal(errored.isError, true);
  assert.equal(errored.alternatives.length, 3);

  harness.handleRestorePrompt(userMsg.content);

  assert.equal(harness.getInputValue(), userMsg.content);
  const restoredMsgs = harness.getMessages();
  assert.equal(restoredMsgs.length, 2, 'Assistant message must NOT be deleted when valid alternatives exist');
  const restoredAssistant = restoredMsgs[1];
  assert.equal(restoredAssistant.isError, false);
  assert.equal(restoredAssistant.isInterrupted, false);
  assert.equal(restoredAssistant.failedPrompt, undefined);
  assert.equal(restoredAssistant.alternatives.length, 2, 'Only failed attempt removed');
  assert.equal(restoredAssistant.alternatives[0].id, alt1.id);
  assert.equal(restoredAssistant.alternatives[1].id, alt2.id);
  assert.equal(restoredAssistant.activeAlternativeId, alt2.id, 'Should restore most recent valid alternative');
  assert.equal(restoredAssistant.content, 'Groq TCP vs UDP comparison.');
  assert.equal(getAlternativeMetrics(restoredAssistant).total, 2);

  // Also test message with zero successful alternatives -> deleted as before
  const harnessEmpty = createPhase3Harness();
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

await runCase('6. Stale Firestore snapshot arriving during active regeneration does not overwrite in-progress alternative', async () => {
  const harness = createPhase3Harness();
  const { assistantMsg, alt1, alt2 } = await seedGeminiAndGroqTurn(harness, 1718000500000);

  // Freeze stale Firestore docs (only alt1 and alt2 exist in DB)
  const staleFirestoreDocs = JSON.parse(JSON.stringify(harness.firestoreMessageDocs));

  let releaseFinish;
  const finishGate = new Promise((resolve) => {
    releaseFinish = resolve;
  });

  const regenPromise = harness.handleRegenerate(assistantMsg, async ({ onStart, onChunk }) => {
    onStart({ modelUsed: 'gemini-3.8-flash', provider: 'gemini' });
    onChunk('Streaming part 1... ', 'Streaming part 1... ');
    await new Promise((r) => setTimeout(r, 25));

    // Simulate incoming stale Firestore snapshot mid-stream containing the older 2-alternative doc for same ID
    harness.receiveFirestoreSnapshot(staleFirestoreDocs);

    // Confirm active in-progress message was preserved and NOT reverted to stale 2-alt snapshot
    const duringStream = harness.getMessages().find((m) => m.id === assistantMsg.id);
    assert.equal(duringStream.alternatives.length, 3, 'In-progress 3rd alternative must survive stale Firestore snapshot');
    assert.equal(duringStream.content, 'Streaming part 1... ', 'Streamed content must NOT revert');
    assert.equal(
      harness.persistedMessageIds.has(assistantMsg.id),
      false,
      'Active streaming assistantMessageId must not be re-marked persisted by stale snapshot'
    );

    await finishGate;
    onChunk('part 2 complete.', 'Streaming part 1... part 2 complete.');
    return {
      text: 'Streaming part 1... part 2 complete.',
      modelUsed: 'gemini-3.8-flash',
      provider: 'gemini'
    };
  });

  await new Promise((r) => setTimeout(r, 25));
  releaseFinish();
  await regenPromise;

  const finalMsg = harness.getMessages().find((m) => m.id === assistantMsg.id);
  assert.equal(finalMsg.alternatives.length, 3);
  assert.equal(finalMsg.alternatives[0].id, alt1.id);
  assert.equal(finalMsg.alternatives[1].id, alt2.id);
  assert.equal(finalMsg.alternatives[2].content, 'Streaming part 1... part 2 complete.');
  assert.equal(finalMsg.content, 'Streaming part 1... part 2 complete.');

  // Confirm final persisted Firestore state has all 3 alternatives
  const reloaded = harness.hydrateFromFirestoreDocs();
  assert.equal(reloaded[1].alternatives.length, 3);
  assert.equal(reloaded[1].alternatives[2].content, 'Streaming part 1... part 2 complete.');
});

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
if (failed > 0) {
  process.exit(1);
}
