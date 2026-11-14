/**
 * Regression Suite: Normal Regenerate Replaces Active Alternative & Preserves Others
 *
 * Verifies Phase 1 requirements:
 * 1. ChatPage.jsx `handleRegenerate` uses `replaceActiveAlternativeForRegeneration`
 *    instead of `createAlternativeRecord` / `addAlternativeToAssistantMessage`.
 * 2. Normal regeneration replaces only the active response (`[Grok, Cloudflare]` ->
 *    normal Regenerate while viewing Cloudflare -> `[Grok, Latest Cloudflare]`).
 * 3. Alternative count remains unchanged and the previous active response is no longer
 *    accessible in state, navigation, local cache, or Firestore reload.
 * 4. Other provider alternatives remain completely unchanged.
 * 5. Active alternative ID, position, provider, model, message ID, interaction ID,
 *    and creation timestamps remain stable.
 * 6. Streaming state and timer reset correctly (`content: ''`, `responseTimeMs: null`,
 *    `isStreaming: true`, `isError: false`, `isStopped: false`, `isInterrupted: false`,
 *    fresh timestamp, stale error/retry metadata cleared) so `LiveResponseTimer` starts
 *    and the previous response-time badge does not remain visible.
 * 7. Message ordering and topology memoization remain stable.
 * 8. Stopping mid-stream during normal regeneration finalizes only the active
 *    alternative without creating a new entry or mutating other alternatives.
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
  ensureConversationAlternatives,
  orderConversationMessages,
  createConversationOrderMemo,
  sanitizeModelForProvider
} from '../src/services/alternativeResponseService.js';
import {
  createRequestIsolationController,
  cancelActiveChatRequest,
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

function shouldRenderLiveTimer(msg) {
  return Boolean(
    msg &&
      msg.sender !== 'user' &&
      !msg.isError &&
      !msg.isStopped &&
      !msg.isInterrupted &&
      msg.isStreaming &&
      !msg.responseTimeMs &&
      typeof msg.requestStartTime === 'number'
  );
}

function shouldRenderResponseTimeBadge(msg) {
  return Boolean(
    msg &&
      msg.sender !== 'user' &&
      !msg.isError &&
      !msg.isStopped &&
      !msg.isInterrupted &&
      typeof msg.responseTimeMs === 'number'
  );
}

function createSimulationHarness() {
  const controller = createRequestIsolationController();
  let fullOrderCount = 0;
  const orderMemo = createConversationOrderMemo({
    onFullOrder: () => {
      fullOrderCount++;
    }
  });
  const activeChatId = 'chat-regen-1';
  let isLoading = false;
  /** @type {any[]} */
  let messages = [];
  /** @type {Record<string, any>} */
  const firestoreMessageDocs = {};
  /** @type {Record<string, string>} */
  const localStorageDocs = {};

  const updateMessagesState = (updater) => {
    const next = typeof updater === 'function' ? updater(messages) : updater;
    messages = orderMemo(next);
  };

  const findExistingAssistantMessage = (_chatId, assistantMessageId) =>
    messages.find((m) => m.id === assistantMessageId) || null;

  const persistMessageSafe = async (chatId, message) => {
    const normalized =
      message.sender === 'assistant' ? normalizeAssistantMessage(message) : message;
    const payload = buildFirestoreMessagePayload(normalized);
    firestoreMessageDocs[normalized.id] = {
      ...payload,
      id: normalized.id,
      createdAtMs: payload.createdAtMs,
      clientTimestamp: payload.clientTimestamp
    };
    const cacheMessages = messages.map((m) => sanitizeMessageForStorage(m));
    localStorageDocs[chatId] = JSON.stringify(cacheMessages);
  };

  const simulateReloadFromFirestore = () => {
    const hydrated = Object.values(firestoreMessageDocs).map((data) => ({
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

  const runStream = ({
    assistantMessageId,
    providerToUse,
    modelToUse,
    promptText,
    customStartTime = null,
    streamRequest
  }) =>
    runIsolatedPromptStream({
      controller,
      targetChatId: activeChatId,
      assistantMessageId,
      providerToUse,
      effectiveModelOverride: modelToUse,
      promptText,
      currentAttachments: [],
      customStartTime,
      prefersReducedMotion: true,
      getActiveChatId: () => activeChatId,
      onUpdateMessages: updateMessagesState,
      onPersistMessage: persistMessageSafe,
      onSetLoadingState: (val) => {
        isLoading = Boolean(val);
      },
      findExistingAssistantMessage,
      streamRequest,
      classifyError: (err) => ({
        friendlyMsg: err?.message || 'Error',
        effectiveProvider: providerToUse,
        canSwitchProvider: true
      })
    });

  // Mirrors updated handleRegenerate in src/pages/ChatPage.jsx
  const regenerateActiveResponse = async (
    assistantMessage,
    streamRequest,
    { freshTimestamp = '10:05 AM', requestStartTime = 500 } = {}
  ) => {
    const msgIndex = messages.findIndex((m) => m.id === assistantMessage.id);
    assert.ok(msgIndex >= 0, 'Target assistant message must exist');

    const precedingUserMessage = assistantMessage.parentMessageId
      ? messages.find((m) => m.id === assistantMessage.parentMessageId)
      : [...messages.slice(0, msgIndex)].reverse().find((m) => m.sender === 'user');
    assert.ok(precedingUserMessage, 'Preceding user message must exist');

    const latestAssistant = messages[msgIndex];
    const normalizedTarget = normalizeAssistantMessage(latestAssistant, precedingUserMessage);
    const activeAlt = getActiveAlternative(normalizedTarget);
    const providerToUse = activeAlt?.provider || latestAssistant.provider || 'gemini';
    const rawModelCandidate = activeAlt?.modelUsed || latestAssistant.modelUsed || null;
    const modelToUse = sanitizeModelForProvider(providerToUse, rawModelCandidate);

    updateMessagesState((previous) =>
      previous.map((m) => {
        if (m.id !== assistantMessage.id) return m;
        return replaceActiveAlternativeForRegeneration(m, {
          provider: providerToUse,
          modelUsed: modelToUse,
          timestamp: freshTimestamp,
          requestStartTime,
          precedingUserMessage
        });
      })
    );

    const streamResult = await runStream({
      assistantMessageId: assistantMessage.id,
      providerToUse,
      modelToUse,
      promptText: precedingUserMessage.content,
      customStartTime: requestStartTime,
      streamRequest
    });

    return { streamResult };
  };

  return {
    controller,
    getMessages: () => messages,
    getFullOrderCount: () => fullOrderCount,
    setInitialMessages: (initial) => {
      messages = orderMemo(initial);
    },
    getIsLoading: () => isLoading,
    getLocalCache: () => JSON.parse(localStorageDocs[activeChatId] || '[]'),
    persistMessageSafe,
    simulateReloadFromFirestore,
    updateMessagesState,
    runStream,
    regenerateActiveResponse,
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
    switchAlternative: (assistantMessageId, targetAltId) => {
      messages = messages.map((m) =>
        m.id === assistantMessageId ? switchActiveAlternativeInMessage(m, targetAltId) : m
      );
      const updated = messages.find((m) => m.id === assistantMessageId);
      if (updated) {
        return persistMessageSafe(activeChatId, updated);
      }
      return Promise.resolve();
    }
  };
}

console.log('Running Normal Regenerate Replaces Active Alternative regression tests...');

await runCase('1. ChatPage.jsx handleRegenerate replaces active alternative in-place via replaceActiveAlternativeForRegeneration', async () => {
  const chatPageSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/pages/ChatPage.jsx'), 'utf8');
  const startIdx = chatPageSrc.indexOf('const handleRegenerate =');
  assert.ok(startIdx !== -1, 'handleRegenerate must exist in ChatPage.jsx');
  const endIdx = chatPageSrc.indexOf('const handleGenerateAlternative =', startIdx);
  assert.ok(endIdx > startIdx, 'handleGenerateAlternative boundary must exist');

  const handleRegenBody = chatPageSrc.slice(startIdx, endIdx);
  assert.ok(
    handleRegenBody.includes('replaceActiveAlternativeForRegeneration('),
    'handleRegenerate must call replaceActiveAlternativeForRegeneration()'
  );
  assert.ok(
    !handleRegenBody.includes('createAlternativeRecord('),
    'handleRegenerate must NOT call createAlternativeRecord()'
  );
  assert.ok(
    !handleRegenBody.includes('addAlternativeToAssistantMessage('),
    'handleRegenerate must NOT call addAlternativeToAssistantMessage()'
  );
  assert.ok(
    handleRegenBody.includes('const activeAlt = getActiveAlternative(normalizedTarget)'),
    'handleRegenerate must preserve active alternative provider/model selection'
  );
});

await runCase('2. Grok -> Cloudflare -> normal Regenerate while viewing Cloudflare keeps exactly 2 alternatives and replaces only Cloudflare', async () => {
  const harness = createSimulationHarness();
  const now = 1718000000000;
  const userMsg = {
    id: `user-${now}`,
    interactionId: `interaction-${now}`,
    sender: 'user',
    content: 'Explain black holes briefly.',
    timestamp: '10:00 AM',
    createdAt: now,
    createdAtMs: now
  };
  const initialAssistant = normalizeAssistantMessage(
    {
      id: `groq-${now}-assistant`,
      interactionId: userMsg.interactionId,
      parentMessageId: userMsg.id,
      sender: 'assistant',
      provider: 'groq',
      modelUsed: 'openai/gpt-oss-120b',
      content: '',
      timestamp: '10:00 AM',
      createdAt: now,
      createdAtMs: now,
      isStreaming: true
    },
    userMsg
  );

  harness.setInitialMessages([userMsg, initialAssistant]);
  await harness.persistMessageSafe('chat-regen-1', userMsg);

  // Step 1: Generate response using Grok ("groq")
  await harness.runStream({
    assistantMessageId: initialAssistant.id,
    providerToUse: 'groq',
    modelToUse: 'openai/gpt-oss-120b',
    promptText: userMsg.content,
    streamRequest: async ({ onStart, onChunk }) => {
      onStart({ modelUsed: 'openai/gpt-oss-120b', provider: 'groq' });
      onChunk('Grok initial answer.', 'Grok initial answer.');
      return {
        text: 'Grok initial answer.',
        modelUsed: 'openai/gpt-oss-120b',
        provider: 'groq'
      };
    }
  });

  // Step 2: Regenerate with Another AI Model -> Cloudflare
  const cfAlt = createAlternativeRecord({
    parentMessageId: userMsg.id,
    interactionId: userMsg.interactionId,
    provider: 'cloudflare',
    modelUsed: '@cf/meta/llama-3.1-8b-instruct',
    content: '',
    timestamp: '10:01 AM',
    createdAt: now + 60_000,
    createdAtMs: now + 60_000
  });
  harness.updateMessagesState((prev) =>
    prev.map((m) =>
      m.id === initialAssistant.id
        ? { ...addAlternativeToAssistantMessage(m, cfAlt), isStreaming: true }
        : m
    )
  );
  await harness.runStream({
    assistantMessageId: initialAssistant.id,
    providerToUse: 'cloudflare',
    modelToUse: '@cf/meta/llama-3.1-8b-instruct',
    promptText: userMsg.content,
    streamRequest: async ({ onStart, onChunk }) => {
      onStart({ modelUsed: '@cf/meta/llama-3.1-8b-instruct', provider: 'cloudflare' });
      onChunk('Old Cloudflare response.', 'Old Cloudflare response.');
      return {
        text: 'Old Cloudflare response.',
        modelUsed: '@cf/meta/llama-3.1-8b-instruct',
        provider: 'cloudflare'
      };
    }
  });

  const beforeRegen = harness.getMessages().find((m) => m.id === initialAssistant.id);
  assert.equal(beforeRegen.alternatives.length, 2);
  const grokAltId = beforeRegen.alternatives[0].id;
  const grokResponseTime = beforeRegen.alternatives[0].responseTimeMs;
  const cloudflareAltId = beforeRegen.alternatives[1].id;
  assert.equal(beforeRegen.activeAlternativeId, cloudflareAltId);
  assert.equal(typeof beforeRegen.responseTimeMs, 'number');
  assert.equal(shouldRenderResponseTimeBadge(beforeRegen), true);

  const fullOrdersBeforeRegen = harness.getFullOrderCount();

  // Step 3: While viewing Cloudflare, click normal Regenerate
  await harness.regenerateActiveResponse(
    beforeRegen,
    async ({ onStart, onChunk }) => {
      // Pre-chunk check: old Cloudflare cleared, timer reset, LiveResponseTimer active, badge hidden
      const resetState = harness.getMessages().find((m) => m.id === initialAssistant.id);
      assert.equal(resetState.alternatives.length, 2);
      assert.equal(resetState.activeAlternativeId, cloudflareAltId);
      assert.equal(resetState.content, '');
      assert.equal(resetState.responseTimeMs, null);
      assert.equal(resetState.alternatives[1].responseTimeMs, null);
      assert.equal(resetState.isStreaming, true);
      assert.equal(resetState.isError, false);
      assert.equal(resetState.isStopped, false);
      assert.equal(resetState.isInterrupted, false);
      assert.equal(resetState.timestamp, '10:05 AM');
      assert.equal(shouldRenderLiveTimer(resetState), true);
      assert.equal(shouldRenderResponseTimeBadge(resetState), false);
      assert.equal(resetState.alternatives[0].content, 'Grok initial answer.');

      onStart({ modelUsed: '@cf/meta/llama-3.1-8b-instruct', provider: 'cloudflare' });
      onChunk('Latest Cloudflare ', 'Latest Cloudflare ');
      await new Promise((r) => setTimeout(r, 25));

      // Mid-stream check: Grok preserved, same 2 alternatives, active ID stable
      const midStream = harness.getMessages().find((m) => m.id === initialAssistant.id);
      assert.equal(midStream.alternatives.length, 2);
      assert.equal(midStream.activeAlternativeId, cloudflareAltId);
      assert.equal(midStream.alternatives[0].id, grokAltId);
      assert.equal(midStream.alternatives[0].content, 'Grok initial answer.');
      assert.equal(midStream.alternatives[1].id, cloudflareAltId);
      assert.equal(midStream.alternatives[1].content, 'Latest Cloudflare ');

      onChunk('response.', 'Latest Cloudflare response.');
      return {
        text: 'Latest Cloudflare response.',
        modelUsed: '@cf/meta/llama-3.1-8b-instruct',
        provider: 'cloudflare'
      };
    },
    { freshTimestamp: '10:05 AM', requestStartTime: 900 }
  );

  // Step 4: Verify exact 2 alternatives: [Grok, Latest Cloudflare]
  const afterRegen = harness.getMessages().find((m) => m.id === initialAssistant.id);
  assert.equal(afterRegen.id, initialAssistant.id, 'Message ID must remain stable');
  assert.equal(afterRegen.parentMessageId, userMsg.id);
  assert.equal(afterRegen.interactionId, userMsg.interactionId);
  assert.equal(afterRegen.createdAt, now);
  assert.equal(afterRegen.createdAtMs, now);
  assert.equal(afterRegen.alternatives.length, 2, 'Alternative count must stay 2');
  assert.equal(afterRegen.activeAlternativeId, cloudflareAltId, 'Active alternative ID must remain stable');
  assert.equal(afterRegen.provider, 'cloudflare');
  assert.equal(afterRegen.modelUsed, '@cf/meta/llama-3.1-8b-instruct');
  assert.equal(afterRegen.content, 'Latest Cloudflare response.');
  assert.equal(typeof afterRegen.responseTimeMs, 'number');
  assert.equal(shouldRenderLiveTimer(afterRegen), false);
  assert.equal(shouldRenderResponseTimeBadge(afterRegen), true);
  assert.equal(
    harness.getFullOrderCount(),
    fullOrdersBeforeRegen,
    'Topology memoization must reuse slot order without full re-order'
  );

  assert.equal(afterRegen.alternatives[0].id, grokAltId);
  assert.equal(afterRegen.alternatives[0].content, 'Grok initial answer.');
  assert.equal(afterRegen.alternatives[0].provider, 'groq');
  assert.equal(afterRegen.alternatives[0].modelUsed, 'openai/gpt-oss-120b');
  assert.equal(afterRegen.alternatives[0].responseTimeMs, grokResponseTime);

  assert.equal(afterRegen.alternatives[1].id, cloudflareAltId);
  assert.equal(afterRegen.alternatives[1].content, 'Latest Cloudflare response.');
  assert.equal(afterRegen.alternatives[1].provider, 'cloudflare');
  assert.equal(afterRegen.alternatives[1].modelUsed, '@cf/meta/llama-3.1-8b-instruct');

  const serialized = JSON.stringify(afterRegen);
  assert.equal(
    serialized.includes('Old Cloudflare response.'),
    false,
    'Previous Cloudflare response must no longer be accessible anywhere in message'
  );

  const metrics = getAlternativeMetrics(afterRegen);
  assert.deepEqual(
    {
      total: metrics.total,
      currentIndex: metrics.currentIndex,
      canGoPrevious: metrics.canGoPrevious,
      canGoNext: metrics.canGoNext
    },
    { total: 2, currentIndex: 1, canGoPrevious: true, canGoNext: false }
  );

  // Step 5: Navigate between Grok and Latest Cloudflare
  await harness.switchAlternative(initialAssistant.id, grokAltId);
  const viewedGrok = harness.getMessages().find((m) => m.id === initialAssistant.id);
  assert.equal(viewedGrok.content, 'Grok initial answer.');
  assert.equal(viewedGrok.provider, 'groq');
  assert.equal(getAlternativeMetrics(viewedGrok).currentIndex, 0);

  await harness.switchAlternative(initialAssistant.id, cloudflareAltId);
  const viewedCloudflare = harness.getMessages().find((m) => m.id === initialAssistant.id);
  assert.equal(viewedCloudflare.content, 'Latest Cloudflare response.');
  assert.equal(viewedCloudflare.provider, 'cloudflare');
  assert.equal(getAlternativeMetrics(viewedCloudflare).currentIndex, 1);

  // Step 6: Verify Firestore reload and localStorage cache have only Grok + Latest Cloudflare
  const reloadedFromFirestore = harness.simulateReloadFromFirestore();
  assert.equal(reloadedFromFirestore.length, 2);
  assert.equal(reloadedFromFirestore[0].id, userMsg.id);
  assert.equal(reloadedFromFirestore[1].id, initialAssistant.id);
  assert.equal(reloadedFromFirestore[1].alternatives.length, 2);
  assert.equal(reloadedFromFirestore[1].alternatives[0].content, 'Grok initial answer.');
  assert.equal(reloadedFromFirestore[1].alternatives[1].content, 'Latest Cloudflare response.');
  assert.equal(
    JSON.stringify(reloadedFromFirestore).includes('Old Cloudflare response.'),
    false
  );

  const localCached = harness.getLocalCache();
  assert.equal(localCached[1].alternatives.length, 2);
  assert.equal(JSON.stringify(localCached).includes('Old Cloudflare response.'), false);
});

await runCase('3. replaceActiveAlternativeForRegeneration clears stale error, stopped, interrupted, and retry metadata', async () => {
  const now = 1718000020000;
  const erroredAssistant = {
    id: `gemini-${now}-assistant`,
    parentMessageId: `user-${now}`,
    interactionId: `interaction-${now}`,
    sender: 'assistant',
    provider: 'gemini',
    modelUsed: 'gemini-3.8-flash',
    content: 'Partial content *[Response interrupted: Rate limit]*',
    responseTimeMs: 880,
    timestamp: '09:50 AM',
    createdAt: now,
    createdAtMs: now,
    activeAlternativeId: `alt-gemini-${now}`,
    alternatives: [
      {
        id: `alt-gemini-${now}`,
        parentMessageId: `user-${now}`,
        interactionId: `interaction-${now}`,
        sender: 'assistant',
        provider: 'gemini',
        modelUsed: 'gemini-3.8-flash',
        content: 'Partial content *[Response interrupted: Rate limit]*',
        responseTimeMs: 880,
        timestamp: '09:50 AM',
        createdAt: now,
        createdAtMs: now,
        isError: true,
        isStopped: true,
        isInterrupted: true,
        failedPrompt: 'Explain relativity',
        failedProvider: 'gemini',
        canSwitchProvider: true,
        errorCode: 'RATE_LIMIT',
        status: 'RATE_LIMIT',
        httpStatus: 429,
        suggestedProviders: ['groq']
      }
    ],
    isError: true,
    isStopped: true,
    isInterrupted: true,
    failedPrompt: 'Explain relativity',
    failedProvider: 'gemini',
    canSwitchProvider: true,
    errorCode: 'RATE_LIMIT',
    status: 'RATE_LIMIT',
    httpStatus: 429,
    suggestedProviders: ['groq']
  };

  const reset = replaceActiveAlternativeForRegeneration(erroredAssistant, {
    provider: 'gemini',
    modelUsed: 'gemini-3.8-flash',
    timestamp: '10:15 AM',
    requestStartTime: 1234.5
  });

  assert.equal(reset.id, erroredAssistant.id);
  assert.equal(reset.activeAlternativeId, `alt-gemini-${now}`);
  assert.equal(reset.alternatives.length, 1);
  assert.equal(reset.interactionId, `interaction-${now}`);
  assert.equal(reset.createdAt, now);
  assert.equal(reset.createdAtMs, now);
  assert.equal(reset.content, '');
  assert.equal(reset.responseTimeMs, null);
  assert.equal(reset.timestamp, '10:15 AM');
  assert.equal(reset.requestStartTime, 1234.5);
  assert.equal(reset.isStreaming, true);
  assert.equal(reset.isError, false);
  assert.equal(reset.isStopped, false);
  assert.equal(reset.isInterrupted, false);
  assert.equal(reset.failedPrompt, undefined);
  assert.equal(reset.failedProvider, undefined);
  assert.equal(reset.canSwitchProvider, undefined);
  assert.equal(reset.errorCode, undefined);
  assert.equal(reset.status, undefined);
  assert.equal(reset.httpStatus, undefined);
  assert.equal(reset.suggestedProviders, undefined);

  const resetAlt = reset.alternatives[0];
  assert.equal(resetAlt.id, `alt-gemini-${now}`);
  assert.equal(resetAlt.content, '');
  assert.equal(resetAlt.responseTimeMs, null);
  assert.equal(resetAlt.timestamp, '10:15 AM');
  assert.equal(resetAlt.createdAt, now);
  assert.equal(resetAlt.createdAtMs, now);
  assert.equal(resetAlt.isStreaming, true);
  assert.equal(resetAlt.isError, false);
  assert.equal(resetAlt.isStopped, false);
  assert.equal(resetAlt.isInterrupted, false);
  assert.equal(resetAlt.failedPrompt, undefined);
  assert.equal(resetAlt.failedProvider, undefined);
  assert.equal(shouldRenderLiveTimer(reset), true);
  assert.equal(shouldRenderResponseTimeBadge(reset), false);
});

await runCase('4. Stopping mid-stream during normal Regenerate updates only the active alternative and preserves prior ones', async () => {
  const harness = createSimulationHarness();
  const now = 1718000050000;
  const userMsg = {
    id: `user-${now}`,
    interactionId: `interaction-${now}`,
    sender: 'user',
    content: 'Write a short poem.',
    timestamp: '10:10 AM',
    createdAt: now,
    createdAtMs: now
  };
  const altGrok = createAlternativeRecord({
    id: `alt-grok-${now}`,
    parentMessageId: userMsg.id,
    interactionId: userMsg.interactionId,
    provider: 'groq',
    modelUsed: 'openai/gpt-oss-120b',
    content: 'Grok poem.',
    responseTimeMs: 250,
    timestamp: '10:10 AM',
    createdAt: now,
    createdAtMs: now
  });
  const altCloudflare = createAlternativeRecord({
    id: `alt-cf-${now}`,
    parentMessageId: userMsg.id,
    interactionId: userMsg.interactionId,
    provider: 'cloudflare',
    modelUsed: '@cf/meta/llama-3.1-8b-instruct',
    content: 'Old Cloudflare poem.',
    responseTimeMs: 420,
    timestamp: '10:11 AM',
    createdAt: now + 60_000,
    createdAtMs: now + 60_000
  });
  const initialAssistant = normalizeAssistantMessage(
    {
      id: `groq-${now}-assistant`,
      interactionId: userMsg.interactionId,
      parentMessageId: userMsg.id,
      sender: 'assistant',
      alternatives: [altGrok, altCloudflare],
      activeAlternativeId: altCloudflare.id,
      createdAt: now,
      createdAtMs: now,
      isStreaming: false
    },
    userMsg
  );

  harness.setInitialMessages([userMsg, initialAssistant]);
  await harness.persistMessageSafe('chat-regen-1', userMsg);
  await harness.persistMessageSafe('chat-regen-1', initialAssistant);

  let releaseAbort;
  const waitUntilAborted = new Promise((resolve) => {
    releaseAbort = resolve;
  });

  const regenPromise = harness.regenerateActiveResponse(
    initialAssistant,
    async ({ signal, onStart, onChunk }) => {
      signal.addEventListener('abort', () => releaseAbort(), { once: true });
      onStart({ modelUsed: '@cf/meta/llama-3.1-8b-instruct', provider: 'cloudflare' });
      onChunk('Partial ', 'Partial ');
      await waitUntilAborted;
      const err = new Error('Stopped by user');
      err.name = 'AbortError';
      throw err;
    }
  );

  await new Promise((r) => setTimeout(r, 25));
  harness.stopActive();
  await regenPromise;

  const afterStop = harness.getMessages().find((m) => m.id === initialAssistant.id);
  assert.equal(afterStop.alternatives.length, 2);
  assert.equal(afterStop.activeAlternativeId, altCloudflare.id);
  assert.equal(afterStop.alternatives[0].id, altGrok.id);
  assert.equal(afterStop.alternatives[0].content, 'Grok poem.');
  assert.equal(afterStop.alternatives[0].isStopped, false);
  assert.equal(afterStop.alternatives[1].id, altCloudflare.id);
  assert.equal(afterStop.alternatives[1].isStopped, true);
  assert.equal(afterStop.alternatives[1].content, 'Partial ');
  assert.equal(afterStop.alternatives[1].responseTimeMs, null);
  assert.equal(harness.getIsLoading(), false);

  const reloaded = harness.simulateReloadFromFirestore();
  assert.equal(reloaded[1].alternatives.length, 2);
  assert.equal(reloaded[1].alternatives[0].content, 'Grok poem.');
  assert.equal(reloaded[1].alternatives[1].content, 'Partial ');
});

await runCase('5. Scenario A: Clicking normal Regenerate 3x on same provider (Grok) keeps count at 1 and leaves only latest response', async () => {
  const harness = createSimulationHarness();
  const now = 1718000080000;
  const userMsg = {
    id: `user-${now}`,
    interactionId: `interaction-${now}`,
    sender: 'user',
    content: 'Summarize HTTP/3 in one paragraph.',
    timestamp: '10:20 AM',
    createdAt: now,
    createdAtMs: now
  };
  const initialAssistant = normalizeAssistantMessage(
    {
      id: `groq-${now}-assistant`,
      interactionId: userMsg.interactionId,
      parentMessageId: userMsg.id,
      sender: 'assistant',
      provider: 'groq',
      modelUsed: 'openai/gpt-oss-120b',
      content: '',
      timestamp: '10:20 AM',
      createdAt: now,
      createdAtMs: now,
      isStreaming: true
    },
    userMsg
  );

  harness.setInitialMessages([userMsg, initialAssistant]);
  await harness.persistMessageSafe('chat-regen-1', userMsg);

  await harness.runStream({
    assistantMessageId: initialAssistant.id,
    providerToUse: 'groq',
    modelToUse: 'openai/gpt-oss-120b',
    promptText: userMsg.content,
    streamRequest: async ({ onStart, onChunk }) => {
      onStart({ modelUsed: 'openai/gpt-oss-120b', provider: 'groq' });
      onChunk('Grok v1 answer.', 'Grok v1 answer.');
      return { text: 'Grok v1 answer.', modelUsed: 'openai/gpt-oss-120b', provider: 'groq' };
    }
  });

  const initialMsg = harness.getMessages().find((m) => m.id === initialAssistant.id);
  const originalAltId = initialMsg.alternatives[0].id;
  assert.equal(initialMsg.alternatives.length, 1);

  for (let round = 2; round <= 4; round++) {
    const current = harness.getMessages().find((m) => m.id === initialAssistant.id);
    const nextText = `Grok v${round} answer.`;
    await harness.regenerateActiveResponse(
      current,
      async ({ onStart, onChunk }) => {
        onStart({ modelUsed: 'openai/gpt-oss-120b', provider: 'groq' });
        onChunk(nextText, nextText);
        return { text: nextText, modelUsed: 'openai/gpt-oss-120b', provider: 'groq' };
      },
      { freshTimestamp: `10:2${round} AM`, requestStartTime: 200 * round }
    );

    const afterRound = harness.getMessages().find((m) => m.id === initialAssistant.id);
    assert.equal(afterRound.alternatives.length, 1, `Round ${round}: alternative count must remain 1`);
    assert.equal(afterRound.activeAlternativeId, originalAltId);
    assert.equal(afterRound.alternatives[0].id, originalAltId);
    assert.equal(afterRound.content, nextText);
    assert.equal(getAlternativeMetrics(afterRound).total, 1);
  }

  const finalSerialized = JSON.stringify(harness.getMessages());
  assert.equal(finalSerialized.includes('Grok v1 answer.'), false);
  assert.equal(finalSerialized.includes('Grok v2 answer.'), false);
  assert.equal(finalSerialized.includes('Grok v3 answer.'), false);
  assert.equal(finalSerialized.includes('Grok v4 answer.'), true);

  const reloaded = harness.simulateReloadFromFirestore();
  assert.equal(reloaded[1].alternatives.length, 1);
  assert.equal(reloaded[1].content, 'Grok v4 answer.');
  assert.equal(JSON.stringify(reloaded).includes('Grok v1 answer.'), false);
  assert.equal(JSON.stringify(reloaded).includes('Grok v2 answer.'), false);
  assert.equal(JSON.stringify(reloaded).includes('Grok v3 answer.'), false);

  const localCached = harness.getLocalCache();
  assert.equal(localCached[1].alternatives.length, 1);
  assert.equal(localCached[1].content, 'Grok v4 answer.');
});

await runCase('6. Scenario D: 3+ alternatives — regenerating the middle alternative preserves its position and all neighbors', async () => {
  const harness = createSimulationHarness();
  const now = 1718000120000;
  const userMsg = {
    id: `user-${now}`,
    interactionId: `interaction-${now}`,
    sender: 'user',
    content: 'Compare REST, GraphQL, and gRPC.',
    timestamp: '10:30 AM',
    createdAt: now,
    createdAtMs: now
  };
  const altGrok = createAlternativeRecord({
    id: `alt-grok-${now}`,
    parentMessageId: userMsg.id,
    interactionId: userMsg.interactionId,
    provider: 'groq',
    modelUsed: 'openai/gpt-oss-120b',
    content: 'Grok comparison v1.',
    responseTimeMs: 210,
    timestamp: '10:30 AM',
    createdAt: now,
    createdAtMs: now
  });
  const altCloudflare = createAlternativeRecord({
    id: `alt-cf-${now}`,
    parentMessageId: userMsg.id,
    interactionId: userMsg.interactionId,
    provider: 'cloudflare',
    modelUsed: '@cf/meta/llama-3.1-8b-instruct',
    content: 'Cloudflare comparison old.',
    responseTimeMs: 310,
    timestamp: '10:31 AM',
    createdAt: now + 1000,
    createdAtMs: now + 1000
  });
  const altGemini = createAlternativeRecord({
    id: `alt-gem-${now}`,
    parentMessageId: userMsg.id,
    interactionId: userMsg.interactionId,
    provider: 'gemini',
    modelUsed: 'gemini-3.8-flash',
    content: 'Gemini comparison v1.',
    responseTimeMs: 290,
    timestamp: '10:32 AM',
    createdAt: now + 2000,
    createdAtMs: now + 2000
  });
  const altOpenRouter = createAlternativeRecord({
    id: `alt-or-${now}`,
    parentMessageId: userMsg.id,
    interactionId: userMsg.interactionId,
    provider: 'openrouter',
    modelUsed: 'openrouter/free',
    content: 'OpenRouter comparison v1.',
    responseTimeMs: 350,
    timestamp: '10:33 AM',
    createdAt: now + 3000,
    createdAtMs: now + 3000
  });

  const assistantMsg = normalizeAssistantMessage(
    {
      id: `groq-${now}-assistant`,
      parentMessageId: userMsg.id,
      interactionId: userMsg.interactionId,
      sender: 'assistant',
      alternatives: [altGrok, altCloudflare, altGemini, altOpenRouter],
      activeAlternativeId: altOpenRouter.id,
      createdAt: now,
      createdAtMs: now
    },
    userMsg
  );

  harness.setInitialMessages([userMsg, assistantMsg]);
  await harness.persistMessageSafe('chat-regen-1', userMsg);
  await harness.persistMessageSafe('chat-regen-1', assistantMsg);

  // Navigate to middle alternative (Cloudflare at index 1)
  await harness.switchAlternative(assistantMsg.id, altCloudflare.id);
  const viewingMiddle = harness.getMessages().find((m) => m.id === assistantMsg.id);
  const middleMetrics = getAlternativeMetrics(viewingMiddle);
  assert.equal(middleMetrics.total, 4);
  assert.equal(middleMetrics.currentIndex, 1);
  assert.equal(middleMetrics.canGoPrevious, true);
  assert.equal(middleMetrics.canGoNext, true);

  // Normal Regenerate while viewing middle alternative
  await harness.regenerateActiveResponse(
    viewingMiddle,
    async ({ onStart, onChunk }) => {
      onStart({ modelUsed: '@cf/meta/llama-3.1-8b-instruct', provider: 'cloudflare' });
      onChunk('Cloudflare comparison latest.', 'Cloudflare comparison latest.');
      return {
        text: 'Cloudflare comparison latest.',
        modelUsed: '@cf/meta/llama-3.1-8b-instruct',
        provider: 'cloudflare'
      };
    },
    { freshTimestamp: '10:35 AM', requestStartTime: 650 }
  );

  const afterMiddleRegen = harness.getMessages().find((m) => m.id === assistantMsg.id);
  assert.equal(afterMiddleRegen.alternatives.length, 4, 'Must remain 4 alternatives');
  assert.equal(afterMiddleRegen.activeAlternativeId, altCloudflare.id, 'Middle alt remains active');
  assert.equal(afterMiddleRegen.alternatives[0].id, altGrok.id);
  assert.equal(afterMiddleRegen.alternatives[0].content, 'Grok comparison v1.');
  assert.equal(afterMiddleRegen.alternatives[1].id, altCloudflare.id);
  assert.equal(afterMiddleRegen.alternatives[1].content, 'Cloudflare comparison latest.');
  assert.equal(afterMiddleRegen.alternatives[2].id, altGemini.id);
  assert.equal(afterMiddleRegen.alternatives[2].content, 'Gemini comparison v1.');
  assert.equal(afterMiddleRegen.alternatives[3].id, altOpenRouter.id);
  assert.equal(afterMiddleRegen.alternatives[3].content, 'OpenRouter comparison v1.');

  assert.equal(
    JSON.stringify(afterMiddleRegen).includes('Cloudflare comparison old.'),
    false,
    'Old middle response must no longer be accessible'
  );

  const afterMetrics = getAlternativeMetrics(afterMiddleRegen);
  assert.equal(afterMetrics.currentIndex, 1);
  assert.equal(afterMetrics.canGoPrevious, true);
  assert.equal(afterMetrics.canGoNext, true);

  // Verify navigation backward & forward works cleanly across all 4 slots
  await harness.switchAlternative(assistantMsg.id, afterMiddleRegen.alternatives[0].id);
  assert.equal(harness.getMessages()[1].content, 'Grok comparison v1.');
  await harness.switchAlternative(assistantMsg.id, afterMiddleRegen.alternatives[2].id);
  assert.equal(harness.getMessages()[1].content, 'Gemini comparison v1.');
  await harness.switchAlternative(assistantMsg.id, afterMiddleRegen.alternatives[3].id);
  assert.equal(harness.getMessages()[1].content, 'OpenRouter comparison v1.');

  const reloaded = harness.simulateReloadFromFirestore();
  assert.equal(reloaded[1].alternatives.length, 4);
  assert.equal(reloaded[1].alternatives[1].content, 'Cloudflare comparison latest.');
  assert.equal(JSON.stringify(reloaded).includes('Cloudflare comparison old.'), false);
});

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
if (failed > 0) {
  process.exit(1);
}
