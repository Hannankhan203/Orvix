/**
 * Regression Suite: Phase 2 — Regeneration Recovery, Cross-Provider Alternatives & Persistence
 *
 * Verifies:
 * 1. Cross-provider duplicate prevention (`findMatchingAlternative`, `AlternativeResponseNav`, `handleGenerateAlternative`):
 *    - Active provider/model does not create another alternative.
 *    - Already-generated provider/model navigates to existing alternative instead of creating duplicate.
 *    - New provider/model adds 1 alternative with `interactionId` and preserves existing alternatives & order.
 * 2. Retry and switch-provider recovery (`handleRetry`, `handleSwitchProviderAndRetry`):
 *    - Failed in-place regeneration keeps original alternative slot and reuses alt ID.
 *    - Retrying 1-alt or multi-alt failed message reuses message ID (zero orphaned Firestore docs).
 *    - Switch-provider retry updates the failed slot in-place without shifting unrelated alternatives.
 * 3. Prompt restore & alternative switching (`handleRestorePrompt`, `switchActiveAlternativeInMessage`, `getSuccessfulAlternatives`):
 *    - Switching from an interrupted/failed alt to a valid alt clears error/interrupted state on root.
 *    - Restoring prompt after failed regeneration preserves valid alternatives and selects nearest valid alt.
 * 4. Firestore persistence & stale-snapshot safety (`shouldPersistChatMessage`, `buildFirestoreMessagePayload`, `saveChatMessage`, `subscribeToChatMessages`):
 *    - Failed regeneration messages overwrite previous responses in cache/Firestore instead of being skipped.
 *    - Initial single-turn errors remain non-persisted.
 *    - Top-level Firestore payload strictly matches `firestore.rules` allowed keys; `alternatives` carry recovery metadata without `undefined`.
 *    - Interrupted regenerations retain full recovery metadata across Firestore reload.
 *    - Stale Firestore snapshots during streaming or pending-persistence windows cannot restore replaced responses.
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
  findMatchingAlternative,
  ensureConversationAlternatives,
  orderConversationMessages,
  sanitizeModelForProvider
} from '../src/services/alternativeResponseService.js';
import {
  createRequestIsolationController,
  runIsolatedPromptStream
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

// Provide a minimal localStorage mock when running in Node
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

const FIRESTORE_ALLOWED_MESSAGE_KEYS = new Set([
  'id',
  'sender',
  'content',
  'modelUsed',
  'provider',
  'responseTimeMs',
  'parentMessageId',
  'interactionId',
  'createdAtMs',
  'activeAlternativeId',
  'alternatives',
  'attachments',
  'referencedAttachments',
  'createdAt',
  'clientTimestamp'
]);

function assertNoUndefinedDeep(obj, pathStr = 'root') {
  if (obj === undefined) {
    throw new Error(`Found undefined value at ${pathStr}`);
  }
  if (obj === null || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      assertNoUndefinedDeep(obj[i], `${pathStr}[${i}]`);
    }
    return;
  }
  for (const [k, v] of Object.entries(obj)) {
    assertNoUndefinedDeep(v, `${pathStr}.${k}`);
  }
}

console.log('Running Phase 2 Regeneration Recovery & Persistence regression tests...');

await runCase('1. Source guards: ChatPage.jsx and AlternativeResponseNav.jsx implement Phase 2 contracts', async () => {
  const chatPageSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/pages/ChatPage.jsx'), 'utf8');
  const navSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/components/chat/AlternativeResponseNav.jsx'), 'utf8');

  // AlternativeResponseNav checks
  assert.ok(navSrc.includes('normalizeProviderId'), 'AlternativeResponseNav must normalize provider IDs');
  assert.ok(navSrc.includes('findMatchingAlternative'), 'AlternativeResponseNav must use findMatchingAlternative');
  assert.ok(navSrc.includes('disabled={isLoading || isCurrent}'), 'AlternativeResponseNav must disable active current provider');

  // handleGenerateAlternative checks
  const genStart = chatPageSrc.indexOf('const handleGenerateAlternative =');
  const genEnd = chatPageSrc.indexOf('const handleSwitchAlternative =', genStart);
  assert.ok(genStart !== -1 && genEnd > genStart, 'handleGenerateAlternative boundaries must exist');
  const genBody = chatPageSrc.slice(genStart, genEnd);
  assert.ok(genBody.includes('findMatchingAlternative('), 'handleGenerateAlternative must check findMatchingAlternative');
  assert.ok(genBody.includes('handleSwitchAlternative('), 'handleGenerateAlternative must navigate to existing alternative');
  assert.ok(genBody.includes('interactionId: resolvedInteractionId'), 'handleGenerateAlternative must pass interactionId to createAlternativeRecord');

  // handleRetry and handleSwitchProviderAndRetry checks
  const retryStart = chatPageSrc.indexOf('const handleRetry =');
  const retryEnd = chatPageSrc.indexOf('const handleSwitchProviderAndRetry =', retryStart);
  const retryBody = chatPageSrc.slice(retryStart, retryEnd);
  assert.ok(retryBody.includes('replaceActiveAlternativeForRegeneration('), 'handleRetry must retry in-place');
  assert.ok(!retryBody.includes('addAlternativeToAssistantMessage('), 'handleRetry must not shift failed slot to end');
  assert.ok(retryBody.includes('normalizedFailed?.id'), 'handleRetry must reuse existing message ID');

  const switchStart = retryEnd;
  const switchEnd = chatPageSrc.indexOf('const handleRestorePrompt =', switchStart);
  const switchBody = chatPageSrc.slice(switchStart, switchEnd);
  assert.ok(switchBody.includes('replaceActiveAlternativeForRegeneration('), 'handleSwitchProviderAndRetry must switch provider in-place');
  assert.ok(!switchBody.includes('addAlternativeToAssistantMessage('), 'handleSwitchProviderAndRetry must not shift unrelated alternatives');
  assert.ok(switchBody.includes('normalizedFailed?.id'), 'handleSwitchProviderAndRetry must reuse existing message ID');

  // pendingPersistMessagesRef snapshot guard
  assert.ok(chatPageSrc.includes('pendingPersistMessagesRef'), 'ChatPage must track pendingPersistMessagesRef across stale snapshots');
});

await runCase('2. findMatchingAlternative prevents duplicate provider/model matches and respects distinct models', async () => {
  const now = 1718100000000;
  const altGrok = createAlternativeRecord({
    id: 'alt-groq-1',
    parentMessageId: 'user-1',
    interactionId: 'int-1',
    provider: 'groq',
    modelUsed: 'openai/gpt-oss-120b',
    content: 'Grok response',
    createdAt: now
  });
  const altCloudflare = createAlternativeRecord({
    id: 'alt-cf-1',
    parentMessageId: 'user-1',
    interactionId: 'int-1',
    provider: 'cloudflare',
    modelUsed: '@cf/meta/llama-3.1-8b-instruct',
    content: 'Cloudflare response',
    createdAt: now + 1000
  });
  const altGemini = createAlternativeRecord({
    id: 'alt-gem-1',
    parentMessageId: 'user-1',
    interactionId: 'int-1',
    provider: 'gemini',
    modelUsed: 'gemini-2.5-flash',
    content: 'Gemini response',
    createdAt: now + 2000
  });

  const msg = normalizeAssistantMessage({
    id: 'asst-1',
    parentMessageId: 'user-1',
    interactionId: 'int-1',
    sender: 'assistant',
    activeAlternativeId: altGrok.id,
    alternatives: [altGrok, altCloudflare, altGemini]
  });

  assert.equal(findMatchingAlternative(msg, 'cloudflare')?.id, altCloudflare.id);
  assert.equal(findMatchingAlternative(msg, ' GROQ ')?.id, altGrok.id);
  assert.equal(findMatchingAlternative(msg, 'ollama')?.id, altGemini.id, 'Legacy ollama alias resolves to gemini');
  assert.equal(findMatchingAlternative(msg, 'openrouter'), null);
  assert.equal(
    findMatchingAlternative(msg, { provider: 'cloudflare', model: '@cf/meta/llama-3.1-8b-instruct' })?.id,
    altCloudflare.id
  );
  assert.equal(
    findMatchingAlternative(msg, { provider: 'webllm', model: 'SmolLM2-360M-Instruct-q4f16_1-MLC' }),
    null
  );
});

await runCase('3. Cross-provider duplicate prevention: active provider no-ops, generated provider switches without duplicate, new adds interactionId', async () => {
  const userMsg = {
    id: 'user-cp-1',
    interactionId: 'interaction-cp-1',
    sender: 'user',
    content: 'Summarize photosynthesis.',
    createdAt: 1718100010000
  };
  const altGrok = createAlternativeRecord({
    id: 'alt-groq-cp',
    parentMessageId: userMsg.id,
    interactionId: userMsg.interactionId,
    provider: 'groq',
    modelUsed: 'openai/gpt-oss-120b',
    content: 'Grok photosynthesis.'
  });
  const altCf = createAlternativeRecord({
    id: 'alt-cf-cp',
    parentMessageId: userMsg.id,
    interactionId: userMsg.interactionId,
    provider: 'cloudflare',
    modelUsed: '@cf/meta/llama-3.1-8b-instruct',
    content: 'Cloudflare photosynthesis.'
  });

  let assistantMsg = normalizeAssistantMessage(
    {
      id: 'asst-cp-1',
      parentMessageId: userMsg.id,
      interactionId: userMsg.interactionId,
      sender: 'assistant',
      activeAlternativeId: altGrok.id,
      alternatives: [altGrok, altCf]
    },
    userMsg
  );

  let streamCallCount = 0;
  const simulateGenerateAlternative = (targetProvider) => {
    const rawProvider =
      typeof targetProvider === 'object' && targetProvider?.provider
        ? targetProvider.provider
        : targetProvider;
    const explicitModel =
      typeof targetProvider === 'object' && targetProvider?.model
        ? sanitizeModelForProvider(rawProvider, targetProvider.model)
        : null;
    const normalized = normalizeAssistantMessage(assistantMsg, userMsg);
    const active = getActiveAlternative(normalized);
    const existing = findMatchingAlternative(normalized, rawProvider, explicitModel);
    if (existing) {
      if (active && existing.id === active.id) {
        return 'noop';
      }
      assistantMsg = switchActiveAlternativeInMessage(normalized, existing.id);
      return 'switched';
    }
    streamCallCount++;
    const newAlt = createAlternativeRecord({
      parentMessageId: userMsg.id,
      interactionId: userMsg.interactionId,
      provider: rawProvider,
      modelUsed: explicitModel || 'openrouter/free',
      content: 'OpenRouter photosynthesis.'
    });
    assistantMsg = addAlternativeToAssistantMessage(normalized, newAlt);
    return 'created';
  };

  // Active provider ('groq') -> no-op, zero duplicates
  assert.equal(simulateGenerateAlternative('groq'), 'noop');
  assert.equal(assistantMsg.alternatives.length, 2);
  assert.equal(streamCallCount, 0);

  // Already-generated provider ('cloudflare') -> navigates to existing Cloudflare alt
  assert.equal(simulateGenerateAlternative('cloudflare'), 'switched');
  assert.equal(assistantMsg.activeAlternativeId, altCf.id);
  assert.equal(assistantMsg.content, 'Cloudflare photosynthesis.');
  assert.equal(assistantMsg.alternatives.length, 2);
  assert.equal(streamCallCount, 0);

  // New provider ('openrouter') -> appends 3rd alt with interactionId preserving order
  assert.equal(simulateGenerateAlternative('openrouter'), 'created');
  assert.equal(assistantMsg.alternatives.length, 3);
  assert.equal(streamCallCount, 1);
  assert.equal(assistantMsg.alternatives[0].id, altGrok.id);
  assert.equal(assistantMsg.alternatives[1].id, altCf.id);
  assert.equal(assistantMsg.alternatives[2].provider, 'openrouter');
  assert.equal(assistantMsg.alternatives[2].interactionId, userMsg.interactionId);
});

await runCase('4. In-place retry & switch-provider retry preserve original slot, alt ID, unrelated alternatives, and zero orphaned docs', async () => {
  const now = 1718100020000;
  const userMsg = {
    id: 'user-retry-1',
    interactionId: 'int-retry-1',
    sender: 'user',
    content: 'Compare TCP and UDP.',
    createdAt: now,
    createdAtMs: now
  };
  const altGrok = createAlternativeRecord({
    id: 'alt-grok-slot0',
    parentMessageId: userMsg.id,
    interactionId: userMsg.interactionId,
    provider: 'groq',
    modelUsed: 'openai/gpt-oss-120b',
    content: 'Grok TCP vs UDP',
    createdAt: now
  });
  const altCf = createAlternativeRecord({
    id: 'alt-cf-slot1',
    parentMessageId: userMsg.id,
    interactionId: userMsg.interactionId,
    provider: 'cloudflare',
    modelUsed: '@cf/meta/llama-3.1-8b-instruct',
    content: 'Service temporarily busy (503)',
    isError: true,
    failedPrompt: userMsg.content,
    failedProvider: 'cloudflare',
    canSwitchProvider: true,
    errorCode: 'SERVICE_UNAVAILABLE',
    createdAt: now + 1000
  });
  const altGemini = createAlternativeRecord({
    id: 'alt-gem-slot2',
    parentMessageId: userMsg.id,
    interactionId: userMsg.interactionId,
    provider: 'gemini',
    modelUsed: 'gemini-2.5-flash',
    content: 'Gemini TCP vs UDP',
    createdAt: now + 2000
  });

  // Scenario A: Multi-alternative [Grok, Cloudflare(failed), Gemini] -> Retry Cloudflare in slot 1
  const multiFailed = normalizeAssistantMessage(
    {
      id: 'asst-multi-retry-1',
      parentMessageId: userMsg.id,
      interactionId: userMsg.interactionId,
      sender: 'assistant',
      activeAlternativeId: altCf.id,
      alternatives: [altGrok, altCf, altGemini]
    },
    userMsg
  );

  const retriedInPlace = replaceActiveAlternativeForRegeneration(multiFailed, {
    provider: 'cloudflare',
    modelUsed: '@cf/meta/llama-3.1-8b-instruct',
    timestamp: '11:05 AM',
    requestStartTime: 200,
    precedingUserMessage: userMsg
  });

  assert.equal(retriedInPlace.id, multiFailed.id, 'Message ID must stay identical (zero orphans)');
  assert.equal(retriedInPlace.alternatives.length, 3, 'Alternative count must remain 3');
  assert.equal(retriedInPlace.alternatives[0].id, altGrok.id);
  assert.equal(retriedInPlace.alternatives[0].content, 'Grok TCP vs UDP');
  assert.equal(retriedInPlace.alternatives[1].id, altCf.id, 'Slot 1 alt ID must be reused');
  assert.equal(retriedInPlace.alternatives[1].isStreaming, true);
  assert.equal(retriedInPlace.alternatives[1].isError, false);
  assert.equal(retriedInPlace.alternatives[2].id, altGemini.id);
  assert.equal(retriedInPlace.alternatives[2].content, 'Gemini TCP vs UDP');

  // Scenario B: Switch-provider retry on slot 1 -> openrouter keeps [Grok, OpenRouter, Gemini] without shifting Gemini
  const switchedInPlace = replaceActiveAlternativeForRegeneration(multiFailed, {
    provider: 'openrouter',
    modelUsed: 'openrouter/free',
    timestamp: '11:06 AM',
    requestStartTime: 300,
    precedingUserMessage: userMsg
  });

  assert.equal(switchedInPlace.id, multiFailed.id, 'Switch-provider retry must reuse Firestore doc ID');
  assert.equal(switchedInPlace.alternatives.length, 3);
  assert.equal(switchedInPlace.alternatives[0].id, altGrok.id);
  assert.equal(switchedInPlace.alternatives[1].id, altCf.id, 'Slot 1 stays at index 1');
  assert.equal(switchedInPlace.alternatives[1].provider, 'openrouter');
  assert.equal(switchedInPlace.alternatives[2].id, altGemini.id);
  assert.equal(switchedInPlace.alternatives[2].content, 'Gemini TCP vs UDP');

  // Scenario C: Single-alternative failed regeneration keeps same message ID (no orphaned Firestore doc)
  const singleFailed = normalizeAssistantMessage(
    {
      id: 'asst-single-1',
      parentMessageId: userMsg.id,
      interactionId: userMsg.interactionId,
      sender: 'assistant',
      activeAlternativeId: altCf.id,
      alternatives: [altCf]
    },
    userMsg
  );
  const singleRetried = replaceActiveAlternativeForRegeneration(singleFailed, {
    provider: 'cloudflare',
    modelUsed: '@cf/meta/llama-3.1-8b-instruct',
    timestamp: '11:07 AM',
    requestStartTime: 400,
    precedingUserMessage: userMsg
  });
  assert.equal(singleRetried.id, 'asst-single-1', '1-alt retry must NOT allocate a new Firestore message ID');
  assert.equal(singleRetried.alternatives.length, 1);
  assert.equal(singleRetried.alternatives[0].id, altCf.id);
});

await runCase('5. Switching from interrupted/failed alternative clears root recovery state & prompt restore picks nearest valid alt', async () => {
  const altGrok = createAlternativeRecord({
    id: 'alt-grok-valid',
    parentMessageId: 'u-rest',
    interactionId: 'int-rest',
    provider: 'groq',
    content: 'Valid Grok answer'
  });
  const altCfInterrupted = createAlternativeRecord({
    id: 'alt-cf-int',
    parentMessageId: 'u-rest',
    interactionId: 'int-rest',
    provider: 'cloudflare',
    content: 'Partial cf *[Response interrupted: Timeout]*',
    isError: false,
    isInterrupted: true,
    failedPrompt: 'Explain gravity',
    failedProvider: 'cloudflare',
    canSwitchProvider: true,
    errorCode: 'DEADLINE_EXCEEDED'
  });
  const altGemini = createAlternativeRecord({
    id: 'alt-gem-valid',
    parentMessageId: 'u-rest',
    interactionId: 'int-rest',
    provider: 'gemini',
    content: 'Valid Gemini answer'
  });

  const msg = normalizeAssistantMessage({
    id: 'asst-rest',
    parentMessageId: 'u-rest',
    interactionId: 'int-rest',
    sender: 'assistant',
    activeAlternativeId: altCfInterrupted.id,
    alternatives: [altGrok, altCfInterrupted, altGemini]
  });

  // Switching to altGrok must project clean flags onto root
  const switchedToGrok = switchActiveAlternativeInMessage(msg, altGrok.id);
  assert.equal(switchedToGrok.isError, false);
  assert.equal(switchedToGrok.isInterrupted, false);
  assert.equal(switchedToGrok.failedPrompt, undefined);
  assert.equal(switchedToGrok.failedProvider, undefined);
  assert.equal(switchedToGrok.errorCode, undefined);

  // Switching back to interrupted altCf must project interrupted metadata back onto root
  const switchedToCf = switchActiveAlternativeInMessage(switchedToGrok, altCfInterrupted.id);
  assert.equal(switchedToCf.isInterrupted, true);
  assert.equal(switchedToCf.isError, false);
  assert.equal(switchedToCf.failedPrompt, 'Explain gravity');
  assert.equal(switchedToCf.failedProvider, 'cloudflare');
  assert.equal(switchedToCf.errorCode, 'DEADLINE_EXCEEDED');

  // Replicating restore selection logic from ChatPage handleRestorePrompt:
  const validAlts = switchedToCf.alternatives.filter((a) => !a.isError && !a.isInterrupted && a.content.trim());
  const validIds = new Set(validAlts.map((a) => a.id));
  const failedIdx = switchedToCf.alternatives.findIndex((a) => a.id === switchedToCf.activeAlternativeId);
  let targetAlt = null;
  for (let i = failedIdx - 1; i >= 0; i--) {
    if (validIds.has(switchedToCf.alternatives[i].id)) {
      targetAlt = switchedToCf.alternatives[i];
      break;
    }
  }
  assert.equal(targetAlt?.id, altGrok.id, 'Restore after failed slot 1 must choose nearest preceding valid alt (Grok), not jump to Gemini');
  assert.deepEqual(validAlts.map((a) => a.id), [altGrok.id, altGemini.id]);
});

await runCase('6. shouldPersistChatMessage persists failed regenerations while still skipping initial brand-new errors', async () => {
  const userId = 'user-persist-test';
  const chatId = 'chat-persist-test';
  localStorage.clear();

  // Brand-new initial error (never persisted, 1 alt, not a regeneration) -> skip
  const freshInitialError = normalizeAssistantMessage({
    id: 'msg-fresh-err',
    parentMessageId: 'u1',
    interactionId: 'i1',
    sender: 'assistant',
    provider: 'gemini',
    content: 'API unavailable',
    isError: true,
    failedPrompt: 'Hello',
    failedProvider: 'gemini'
  });
  assert.equal(shouldPersistChatMessage(userId, chatId, freshInitialError), false);

  // Multi-alternative message where slot 2 failed pre-chunk -> MUST persist
  const multiAltFailedRegen = normalizeAssistantMessage({
    id: 'msg-multi-err',
    parentMessageId: 'u1',
    interactionId: 'i1',
    sender: 'assistant',
    activeAlternativeId: 'alt-2',
    alternatives: [
      createAlternativeRecord({ id: 'alt-1', provider: 'groq', content: 'Old Grok' }),
      createAlternativeRecord({
        id: 'alt-2',
        provider: 'cloudflare',
        content: '503 error',
        isError: true,
        failedPrompt: 'Hello',
        failedProvider: 'cloudflare'
      })
    ]
  });
  assert.equal(shouldPersistChatMessage(userId, chatId, multiAltFailedRegen), true);

  // Single-alternative regeneration failure marked with isRegeneration -> MUST persist
  const priorHealthy = normalizeAssistantMessage({
    id: 'msg-single-regen',
    parentMessageId: 'u2',
    interactionId: 'i2',
    sender: 'assistant',
    provider: 'gemini',
    content: 'Old response that was replaced'
  });
  saveCachedChatMessages(userId, chatId, [priorHealthy]);

  const resetForRegen = replaceActiveAlternativeForRegeneration(priorHealthy, {
    provider: 'gemini',
    modelUsed: 'gemini-3.8-flash'
  });
  const preChunkFailedRegen = {
    ...resetForRegen,
    content: 'Provider error before any chunk arrived',
    isStreaming: false,
    isError: true,
    failedPrompt: 'Test',
    failedProvider: 'gemini'
  };
  assert.equal(shouldPersistChatMessage(userId, chatId, preChunkFailedRegen), true);

  // Even without isRegeneration flag (e.g., flag lost in intermediate update), pre-existing cached ID MUST persist
  const { isRegeneration: _stripped, ...withoutFlag } = preChunkFailedRegen;
  assert.equal(shouldPersistChatMessage(userId, chatId, withoutFlag), true);
});

await runCase('7. Firestore payload complies strictly with firestore.rules and preserves interrupted/error recovery metadata across reload', async () => {
  const now = 1718100040000;
  const userMsg = {
    id: 'user-fs-1',
    interactionId: 'int-fs-1',
    sender: 'user',
    content: 'Write a quicksort implementation.',
    createdAt: now,
    createdAtMs: now
  };

  const altGrok = createAlternativeRecord({
    id: 'alt-grok-fs',
    parentMessageId: userMsg.id,
    interactionId: userMsg.interactionId,
    provider: 'groq',
    modelUsed: 'openai/gpt-oss-120b',
    content: 'Grok quicksort',
    responseTimeMs: 320,
    createdAt: now,
    createdAtMs: now
  });

  const altCfInterrupted = createAlternativeRecord({
    id: 'alt-cf-fs',
    parentMessageId: userMsg.id,
    interactionId: userMsg.interactionId,
    provider: 'cloudflare',
    modelUsed: '@cf/meta/llama-3.1-8b-instruct',
    content: 'function quicksort(arr) {\n\n*[Response interrupted: Network connection lost]*',
    responseTimeMs: null,
    createdAt: now + 5000,
    createdAtMs: now + 5000,
    isError: false,
    isStopped: false,
    isInterrupted: true,
    failedPrompt: userMsg.content,
    failedProvider: 'cloudflare',
    canSwitchProvider: true,
    errorCode: 'NETWORK_ERROR',
    httpStatus: 503,
    suggestedProviders: ['groq', 'gemini']
  });

  const msg = normalizeAssistantMessage(
    {
      id: 'asst-fs-1',
      parentMessageId: userMsg.id,
      interactionId: userMsg.interactionId,
      sender: 'assistant',
      activeAlternativeId: altCfInterrupted.id,
      alternatives: [altGrok, altCfInterrupted],
      createdAt: now,
      createdAtMs: now
    },
    userMsg
  );

  const sanitized = sanitizeMessageForStorage(msg);
  const payload = buildFirestoreMessagePayload(sanitized);

  // Validate firestore.rules top-level keys contract
  for (const key of Object.keys(payload)) {
    assert.ok(FIRESTORE_ALLOWED_MESSAGE_KEYS.has(key), `Disallowed top-level Firestore key: ${key}`);
  }
  assert.equal(typeof payload.content, 'string');
  assert.ok(payload.content.length > 0 && payload.content.length <= 100000);
  assertNoUndefinedDeep(payload);

  // Simulate Firestore reload (only persisted payload fields exist on document!)
  const reloadedFromCloud = [
    userMsg,
    {
      id: payload.id,
      sender: payload.sender,
      content: payload.content,
      modelUsed: payload.modelUsed,
      provider: payload.provider,
      responseTimeMs: payload.responseTimeMs,
      parentMessageId: payload.parentMessageId,
      interactionId: payload.interactionId,
      activeAlternativeId: payload.activeAlternativeId,
      alternatives: payload.alternatives.map((alt) => ({
        ...alt,
        attachments: (alt.attachments || []).map(restoreAttachmentFromStorage),
        referencedAttachments: (alt.referencedAttachments || []).map(restoreAttachmentFromStorage)
      })),
      attachments: [],
      referencedAttachments: [],
      createdAtMs: payload.createdAtMs,
      timestamp: payload.clientTimestamp,
      pendingSync: false
    }
  ];

  const hydrated = orderConversationMessages(ensureConversationAlternatives(reloadedFromCloud));
  const hydratedAsst = hydrated[1];

  assert.equal(hydratedAsst.activeAlternativeId, altCfInterrupted.id);
  assert.equal(hydratedAsst.isInterrupted, true, 'Interrupted state must survive Firestore reload');
  assert.equal(hydratedAsst.isError, false);
  assert.equal(hydratedAsst.failedPrompt, userMsg.content, 'failedPrompt must survive Firestore reload');
  assert.equal(hydratedAsst.failedProvider, 'cloudflare', 'failedProvider must survive Firestore reload');
  assert.equal(hydratedAsst.canSwitchProvider, true);
  assert.equal(hydratedAsst.errorCode, 'NETWORK_ERROR');
  assert.equal(hydratedAsst.httpStatus, 503);
  assert.deepEqual(hydratedAsst.suggestedProviders, ['groq', 'gemini']);

  // Switching to Grok after reload clears interrupted root state
  const afterSwitch = switchActiveAlternativeInMessage(hydratedAsst, altGrok.id);
  assert.equal(afterSwitch.isInterrupted, false);
  assert.equal(afterSwitch.failedPrompt, undefined);
  assert.equal(afterSwitch.content, 'Grok quicksort');
});

await runCase('8. Stale Firestore snapshot cannot restore old replaced response during streaming or pending persistence', async () => {
  const controller = createRequestIsolationController();
  const chatId = 'chat-snapshot-race';
  const now = 1718100060000;

  const userMsg = {
    id: 'user-snap-1',
    interactionId: 'int-snap-1',
    sender: 'user',
    content: 'Explain DNS.',
    createdAt: now,
    createdAtMs: now
  };
  const oldCloudAlt = createAlternativeRecord({
    id: 'alt-cf-snap',
    parentMessageId: userMsg.id,
    interactionId: userMsg.interactionId,
    provider: 'cloudflare',
    modelUsed: '@cf/meta/llama-3.1-8b-instruct',
    content: 'OLD replaced Cloudflare response',
    responseTimeMs: 410,
    createdAt: now,
    createdAtMs: now
  });
  const staleCloudAssistant = normalizeAssistantMessage(
    {
      id: 'asst-snap-1',
      parentMessageId: userMsg.id,
      interactionId: userMsg.interactionId,
      sender: 'assistant',
      activeAlternativeId: oldCloudAlt.id,
      alternatives: [oldCloudAlt],
      createdAt: now,
      createdAtMs: now
    },
    userMsg
  );

  let uiMessages = [userMsg, staleCloudAssistant];
  const pendingPersistMap = new Map();

  // Helper replicating ChatPage.jsx protected snapshot merge logic
  const applyCloudSnapshot = (safeMessages) => {
    const activeReq = controller.hasActiveRequest() ? controller.getActiveRequest() : null;
    const activeAssistantId =
      activeReq && (!activeReq.chatId || activeReq.chatId === chatId)
        ? activeReq.assistantMessageId
        : null;
    const protectedIds = new Set();
    if (activeAssistantId) protectedIds.add(activeAssistantId);
    pendingPersistMap.forEach((entry, msgId) => {
      if (entry.chatId === chatId) protectedIds.add(msgId);
    });

    if (controller.hasActiveRequest() || protectedIds.size > 0) {
      uiMessages = safeMessages.map((sm) => {
        if (!sm?.id || !protectedIds.has(sm.id)) return sm;
        return (
          (sm.id === activeAssistantId ? uiMessages.find((m) => m.id === activeAssistantId) : null) ||
          pendingPersistMap.get(sm.id)?.message ||
          uiMessages.find((m) => m.id === sm.id) ||
          sm
        );
      });
    } else {
      uiMessages = safeMessages;
    }
  };

  // Start in-place regeneration
  uiMessages = uiMessages.map((m) =>
    m.id === staleCloudAssistant.id
      ? replaceActiveAlternativeForRegeneration(m, {
          provider: 'cloudflare',
          modelUsed: '@cf/meta/llama-3.1-8b-instruct',
          requestStartTime: 700,
          precedingUserMessage: userMsg
        })
      : m
  );

  let releaseWrite;
  const holdPersistWrite = new Promise((resolve) => {
    releaseWrite = resolve;
  });

  const persistSpy = async (targetChatId, message) => {
    const token = { chatId: targetChatId, message };
    pendingPersistMap.set(message.id, token);
    try {
      await holdPersistWrite;
    } finally {
      if (pendingPersistMap.get(message.id) === token) {
        pendingPersistMap.delete(message.id);
      }
    }
  };

  let streamFinished = false;
  const streamPromise = runIsolatedPromptStream({
    controller,
    targetChatId: chatId,
    assistantMessageId: staleCloudAssistant.id,
    providerToUse: 'cloudflare',
    effectiveModelOverride: '@cf/meta/llama-3.1-8b-instruct',
    promptText: userMsg.content,
    prefersReducedMotion: true,
    getActiveChatId: () => chatId,
    onUpdateMessages: (updater) => {
      uiMessages = typeof updater === 'function' ? updater(uiMessages) : updater;
    },
    onPersistMessage: async (targetChatId, msg) => {
      streamFinished = true;
      await persistSpy(targetChatId, msg);
    },
    onSetLoadingState: () => {},
    findExistingAssistantMessage: (_c, id) => uiMessages.find((m) => m.id === id) || null,
    streamRequest: async ({ onStart }) => {
      onStart({ provider: 'cloudflare', modelUsed: '@cf/meta/llama-3.1-8b-instruct' });
      // Stale snapshot #1 arrives mid-stream (before finalization)
      applyCloudSnapshot([userMsg, staleCloudAssistant]);
      const midMsg = uiMessages.find((m) => m.id === staleCloudAssistant.id);
      assert.notEqual(midMsg.content, 'OLD replaced Cloudflare response', 'Mid-stream stale snapshot must not restore old response');
      assert.equal(midMsg.isStreaming, true);
      throw new Error('503 Upstream Error');
    },
    classifyError: (err) => ({
      friendlyMsg: err.message,
      effectiveProvider: 'cloudflare',
      canSwitchProvider: true
    })
  });

  // Wait until stream finalized and entered pendingPersistMap (markFinalized has ALREADY cleared activeRequest!)
  while (!streamFinished) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(controller.hasActiveRequest(), false, 'Request controller is finalized during async Firestore write');

  // Stale snapshot #2 arrives AFTER markFinalized while Firestore write is still pending!
  applyCloudSnapshot([userMsg, staleCloudAssistant]);
  const duringPersistMsg = uiMessages.find((m) => m.id === staleCloudAssistant.id);
  assert.equal(duringPersistMsg.isError, true, 'Post-finalize stale snapshot must NOT overwrite new failed regeneration state');
  assert.equal(duringPersistMsg.content, '503 Upstream Error');
  assert.equal(duringPersistMsg.failedPrompt, userMsg.content);

  releaseWrite();
  await streamPromise;
  assert.equal(pendingPersistMap.size, 0);
});

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
if (failed > 0) {
  process.exit(1);
}
