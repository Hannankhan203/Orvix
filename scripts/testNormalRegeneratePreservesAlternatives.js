/**
 * Regression Suite: Normal Regenerate Preserves Existing Alternatives
 *
 * Verifies:
 * 1. ChatPage.jsx `handleRegenerate` appends a new alternative via
 *    `createAlternativeRecord` and `addAlternativeToAssistantMessage`
 *    instead of overwriting the active alternative via `updateActiveAlternativeInMessage`.
 * 2. Generating Gemini -> generating Groq/Grok -> switching back to Gemini ->
 *    clicking normal Regenerate preserves original Gemini and Groq responses
 *    while appending a new active Gemini alternative (`3 of 3`).
 * 3. `runIsolatedPromptStream` writes chunks, stop-state, and final completion
 *    strictly to the newly active alternative ID without mutating earlier ones.
 * 4. Switching across all alternatives updates root projected fields accurately.
 * 5. Firestore payload (`buildFirestoreMessagePayload`) and localStorage serialization
 *    (`sanitizeMessageForStorage`) preserve all alternatives across reload.
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

function createSimulationHarness() {
  const controller = createRequestIsolationController();
  const orderMemo = createConversationOrderMemo();
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
    // Mirror Firestore persistence (`buildFirestoreMessagePayload`) + local cache (`sanitizeMessageForStorage`)
    const payload = buildFirestoreMessagePayload(normalized);
    // Simulate serverTimestamp materialization
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

  const runStream = ({ assistantMessageId, providerToUse, modelToUse, promptText, streamRequest }) =>
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
      classifyError: (err) => ({
        friendlyMsg: err?.message || 'Error',
        effectiveProvider: providerToUse,
        canSwitchProvider: true
      })
    });

  // Mirrors updated handleRegenerate in src/pages/ChatPage.jsx
  const regenerateActiveResponse = async (assistantMessage, streamRequest) => {
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

    const newAlternative = createAlternativeRecord({
      parentMessageId: precedingUserMessage.id,
      interactionId: precedingUserMessage.interactionId || normalizedTarget.interactionId || null,
      provider: providerToUse,
      modelUsed: modelToUse,
      content: '',
      isStreaming: true,
      timestamp: '10:05 AM',
      referencedAttachments: undefined
    });

    updateMessagesState((previous) =>
      previous.map((m) => {
        if (m.id !== assistantMessage.id) return m;
        const normalized = normalizeAssistantMessage(m, precedingUserMessage);
        const updated = addAlternativeToAssistantMessage(normalized, newAlternative);
        return {
          ...updated,
          requestStartTime: 100,
          isStreaming: true,
          isError: false,
          isStopped: false
        };
      })
    );

    const streamResult = await runStream({
      assistantMessageId: assistantMessage.id,
      providerToUse,
      modelToUse,
      promptText: precedingUserMessage.content,
      streamRequest
    });

    return { newAlternative, streamResult };
  };

  return {
    controller,
    getMessages: () => messages,
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

console.log('Running Normal Regenerate Preserves Alternatives regression tests...');

await runCase('1. ChatPage.jsx handleRegenerate appends new alternative and no longer overwrites in-place', async () => {
  const chatPageSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/pages/ChatPage.jsx'), 'utf8');
  const startIdx = chatPageSrc.indexOf('const handleRegenerate =');
  assert.ok(startIdx !== -1, 'handleRegenerate must exist in ChatPage.jsx');
  const endIdx = chatPageSrc.indexOf('const handleGenerateAlternative =', startIdx);
  assert.ok(endIdx > startIdx, 'handleGenerateAlternative boundary must exist');

  const handleRegenBody = chatPageSrc.slice(startIdx, endIdx);
  assert.ok(
    handleRegenBody.includes('createAlternativeRecord('),
    'handleRegenerate must call createAlternativeRecord()'
  );
  assert.ok(
    handleRegenBody.includes('addAlternativeToAssistantMessage('),
    'handleRegenerate must call addAlternativeToAssistantMessage()'
  );
  assert.ok(
    !handleRegenBody.includes('updateActiveAlternativeInMessage('),
    'handleRegenerate must NOT overwrite active alternative with updateActiveAlternativeInMessage()'
  );
  assert.ok(
    handleRegenBody.includes('const activeAlt = getActiveAlternative(normalizedTarget)'),
    'handleRegenerate must preserve active alternative provider/model selection'
  );
});

await runCase('2. Gemini -> Groq -> switch to Gemini -> normal Regenerate preserves all 3 responses and persists across reload', async () => {
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
      id: `gemini-${now}-assistant`,
      interactionId: userMsg.interactionId,
      parentMessageId: userMsg.id,
      sender: 'assistant',
      provider: 'gemini',
      modelUsed: 'gemini-3.8-flash',
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

  // Step 1: Initial Gemini generation completes
  await harness.runStream({
    assistantMessageId: initialAssistant.id,
    providerToUse: 'gemini',
    modelToUse: 'gemini-3.8-flash',
    promptText: userMsg.content,
    streamRequest: async ({ onStart, onChunk }) => {
      onStart({ modelUsed: 'gemini-3.8-flash', provider: 'gemini' });
      onChunk('Gemini initial ', 'Gemini initial ');
      onChunk('answer.', 'Gemini initial answer.');
      return {
        text: 'Gemini initial answer.',
        modelUsed: 'gemini-3.8-flash',
        provider: 'gemini'
      };
    }
  });

  // Step 2: Generate alternative with Groq ("Grok")
  const groqAlt = createAlternativeRecord({
    parentMessageId: userMsg.id,
    interactionId: userMsg.interactionId,
    provider: 'groq',
    modelUsed: 'openai/gpt-oss-120b',
    content: '',
    timestamp: '10:01 AM'
  });
  harness.updateMessagesState((prev) =>
    prev.map((m) =>
      m.id === initialAssistant.id
        ? { ...addAlternativeToAssistantMessage(m, groqAlt), isStreaming: true }
        : m
    )
  );
  await harness.runStream({
    assistantMessageId: initialAssistant.id,
    providerToUse: 'groq',
    modelToUse: 'openai/gpt-oss-120b',
    promptText: userMsg.content,
    streamRequest: async ({ onStart, onChunk }) => {
      onStart({ modelUsed: 'openai/gpt-oss-120b', provider: 'groq' });
      onChunk('Groq response.', 'Groq response.');
      return {
        text: 'Groq response.',
        modelUsed: 'openai/gpt-oss-120b',
        provider: 'groq'
      };
    }
  });

  let assistantAfterGroq = harness.getMessages().find((m) => m.id === initialAssistant.id);
  assert.equal(assistantAfterGroq.alternatives.length, 2);
  const originalGeminiAltId = assistantAfterGroq.alternatives[0].id;
  const groqAltId = assistantAfterGroq.alternatives[1].id;

  // Step 3: Switch back to Gemini (`1 of 2`) and trigger normal Regenerate
  await harness.switchAlternative(initialAssistant.id, originalGeminiAltId);
  let activeBeforeRegen = harness.getMessages().find((m) => m.id === initialAssistant.id);
  assert.equal(activeBeforeRegen.activeAlternativeId, originalGeminiAltId);
  assert.equal(activeBeforeRegen.provider, 'gemini');
  assert.equal(activeBeforeRegen.content, 'Gemini initial answer.');

  const { newAlternative } = await harness.regenerateActiveResponse(
    activeBeforeRegen,
    async ({ onStart, onChunk }) => {
      onStart({ modelUsed: 'gemini-3.8-flash', provider: 'gemini' });
      onChunk('Gemini regenerated ', 'Gemini regenerated ');
      // Mid-stream check: previous alternatives remain untouched and active alt receives stream
      const midStreamMsg = harness.getMessages().find((m) => m.id === initialAssistant.id);
      assert.equal(midStreamMsg.alternatives.length, 3);
      assert.equal(midStreamMsg.activeAlternativeId, midStreamMsg.alternatives[2].id);
      assert.notEqual(midStreamMsg.activeAlternativeId, originalGeminiAltId);
      assert.notEqual(midStreamMsg.activeAlternativeId, groqAltId);
      assert.equal(midStreamMsg.alternatives[0].content, 'Gemini initial answer.');
      assert.equal(midStreamMsg.alternatives[1].content, 'Groq response.');

      onChunk('answer v2.', 'Gemini regenerated answer v2.');
      return {
        text: 'Gemini regenerated answer v2.',
        modelUsed: 'gemini-3.8-flash',
        provider: 'gemini'
      };
    }
  );

  // Step 4: Confirm original Gemini, Groq, and new Gemini are all present (`3 of 3`)
  const afterRegen = harness.getMessages().find((m) => m.id === initialAssistant.id);
  assert.equal(afterRegen.alternatives.length, 3);
  assert.equal(afterRegen.activeAlternativeId, newAlternative.id);
  assert.equal(afterRegen.provider, 'gemini');
  assert.equal(afterRegen.modelUsed, 'gemini-3.8-flash');
  assert.equal(afterRegen.content, 'Gemini regenerated answer v2.');

  assert.equal(afterRegen.alternatives[0].id, originalGeminiAltId);
  assert.equal(afterRegen.alternatives[0].content, 'Gemini initial answer.');
  assert.equal(afterRegen.alternatives[0].provider, 'gemini');

  assert.equal(afterRegen.alternatives[1].id, groqAltId);
  assert.equal(afterRegen.alternatives[1].content, 'Groq response.');
  assert.equal(afterRegen.alternatives[1].provider, 'groq');

  assert.equal(afterRegen.alternatives[2].id, newAlternative.id);
  assert.equal(afterRegen.alternatives[2].content, 'Gemini regenerated answer v2.');
  assert.equal(afterRegen.alternatives[2].provider, 'gemini');

  let metrics = getAlternativeMetrics(afterRegen);
  assert.deepEqual(
    {
      total: metrics.total,
      currentIndex: metrics.currentIndex,
      canGoPrevious: metrics.canGoPrevious,
      canGoNext: metrics.canGoNext
    },
    { total: 3, currentIndex: 2, canGoPrevious: true, canGoNext: false }
  );

  // Step 5: Switch across all 3 alternatives and verify root projections
  await harness.switchAlternative(initialAssistant.id, originalGeminiAltId);
  let switched1 = harness.getMessages().find((m) => m.id === initialAssistant.id);
  assert.equal(switched1.content, 'Gemini initial answer.');
  assert.equal(switched1.provider, 'gemini');
  assert.equal(getAlternativeMetrics(switched1).currentIndex, 0);

  await harness.switchAlternative(initialAssistant.id, groqAltId);
  let switched2 = harness.getMessages().find((m) => m.id === initialAssistant.id);
  assert.equal(switched2.content, 'Groq response.');
  assert.equal(switched2.provider, 'groq');
  assert.equal(switched2.modelUsed, 'openai/gpt-oss-120b');
  assert.equal(getAlternativeMetrics(switched2).currentIndex, 1);

  await harness.switchAlternative(initialAssistant.id, newAlternative.id);
  let switched3 = harness.getMessages().find((m) => m.id === initialAssistant.id);
  assert.equal(switched3.content, 'Gemini regenerated answer v2.');
  assert.equal(switched3.provider, 'gemini');
  assert.equal(getAlternativeMetrics(switched3).currentIndex, 2);

  // Step 6: Simulate conversation reload from Firestore & local cache
  const reloadedFromFirestore = harness.simulateReloadFromFirestore();
  assert.equal(reloadedFromFirestore.length, 2);
  const reloadedAssistant = reloadedFromFirestore[1];
  assert.equal(reloadedAssistant.alternatives.length, 3);
  assert.equal(reloadedAssistant.activeAlternativeId, newAlternative.id);
  assert.equal(reloadedAssistant.content, 'Gemini regenerated answer v2.');
  assert.equal(reloadedAssistant.alternatives[0].content, 'Gemini initial answer.');
  assert.equal(reloadedAssistant.alternatives[1].content, 'Groq response.');
  assert.equal(reloadedAssistant.alternatives[2].content, 'Gemini regenerated answer v2.');

  const localCached = harness.getLocalCache();
  assert.equal(localCached.length, 2);
  assert.equal(localCached[1].alternatives.length, 3);
  assert.equal(localCached[1].activeAlternativeId, newAlternative.id);
});

await runCase('3. Stopping mid-stream during normal Regenerate finalizes only the new alternative and preserves prior ones', async () => {
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
  const initialAssistant = normalizeAssistantMessage(
    {
      id: `gemini-${now}-assistant`,
      interactionId: userMsg.interactionId,
      parentMessageId: userMsg.id,
      sender: 'assistant',
      provider: 'gemini',
      modelUsed: 'gemini-3.8-flash',
      content: 'Original poem.',
      responseTimeMs: 420,
      timestamp: '10:10 AM',
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
      onStart({ modelUsed: 'gemini-3.8-flash', provider: 'gemini' });
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
  assert.equal(afterStop.alternatives[0].content, 'Original poem.');
  assert.equal(afterStop.alternatives[0].isStopped, false);
  assert.equal(afterStop.alternatives[1].isStopped, true);
  assert.equal(afterStop.alternatives[1].content, 'Partial ');
  assert.equal(afterStop.activeAlternativeId, afterStop.alternatives[1].id);
  assert.equal(harness.getIsLoading(), false);

  const reloaded = harness.simulateReloadFromFirestore();
  assert.equal(reloaded[1].alternatives.length, 2);
  assert.equal(reloaded[1].alternatives[0].content, 'Original poem.');
  assert.equal(reloaded[1].alternatives[1].content, 'Partial ');
});

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
if (failed > 0) {
  process.exit(1);
}
