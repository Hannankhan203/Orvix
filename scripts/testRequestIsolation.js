/**
 * Phase 3 — Behavioral Regression Suite for Request Isolation & Cancellation
 *
 * Exercises real production modules (`requestIsolationService.js`, `aiRouter.js`,
 * `alternativeResponseService.js`, `attachmentStorageService.js`, `documentContextService.js`)
 * against a live local HTTP SSE server (`node:http`) using native `fetch` and `AbortController`.
 */

import assert from 'node:assert/strict';
import http from 'node:http';

import {
  createRequestIsolationController,
  cancelActiveChatRequest,
  runIsolatedPromptStream
} from '../src/services/requestIsolationService.js';
import { streamAIMessage } from '../src/services/aiRouter.js';
import {
  normalizeAssistantMessage,
  addAlternativeToAssistantMessage,
  createAlternativeRecord
} from '../src/services/alternativeResponseService.js';
import {
  hydrateAttachmentsWithImageBytes,
  sanitizeAttachmentForNetwork
} from '../src/services/attachmentStorageService.js';
import { isVisionCapableProvider } from '../src/services/documentContextService.js';
import { sanitizeMessageForStorage } from '../src/services/chatStorageService.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Valid 1x1 PNG buffer for real attachment hydration verification in Test 10
const TINY_PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

/**
 * Starts an ephemeral local HTTP server so `streamAIMessage` executes real HTTP POST
 * requests, real `ReadableStreamDefaultReader` SSE parsing, and real TCP/stream aborts.
 */
async function startLocalSSEServer() {
  /** @type {Array<{ body: any, url: string }>} */
  const receivedRequests = [];
  /** @type {((req: http.IncomingMessage, res: http.ServerResponse, parsedBody: any, reqIndex: number) => void | Promise<void>) | null} */
  let currentHandler = null;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let parsedBody = null;
      try {
        parsedBody = raw ? JSON.parse(raw) : null;
      } catch (_) {
        parsedBody = raw;
      }
      const reqIndex = receivedRequests.length;
      receivedRequests.push({ url: req.url || '', body: parsedBody });

      if (typeof currentHandler === 'function') {
        await currentHandler(req, res, parsedBody, reqIndex);
      } else {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive'
        });
        res.write(`data: ${JSON.stringify({ type: 'start', modelUsed: 'test-model', provider: parsedBody?.provider || 'gemini' })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'chunk', text: 'Default response' })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'done', text: 'Default response', modelUsed: 'test-model', provider: parsedBody?.provider || 'gemini' })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      }
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    if (typeof input === 'string' && input.startsWith('/')) {
      return originalFetch(`${baseUrl}${input}`, init);
    }
    return originalFetch(input, init);
  };

  return {
    baseUrl,
    receivedRequests,
    setHandler(fn) {
      currentHandler = fn;
    },
    resetRequests() {
      receivedRequests.length = 0;
    },
    async close() {
      globalThis.fetch = originalFetch;
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    }
  };
}

/**
 * Creates an in-memory harness mirroring ChatPage's state/refs wired directly
 * to `createRequestIsolationController`, `runIsolatedPromptStream`, `cancelActiveChatRequest`,
 * and `streamAIMessage`.
 */
function createChatHarness({ initialChatId = 'chat-1', initialProvider = 'gemini', prefersReducedMotion = false } = {}) {
  const controller = createRequestIsolationController();
  let activeChatId = initialChatId;
  let selectedProvider = initialProvider;
  let isLoading = false;
  let isSubmitting = false;
  let persistenceError = null;
  /** @type {Record<string, any[]>} */
  const chatMessagesByChatId = {
    [initialChatId]: []
  };
  /** @type {Record<string, any[]>} */
  const persistedByChatId = {};
  let localEngineStopCount = 0;

  const getVisibleMessages = () => chatMessagesByChatId[activeChatId] || [];

  const updateMessages = (updater) => {
    const current = chatMessagesByChatId[activeChatId] || [];
    const next = typeof updater === 'function' ? updater(current) : updater;
    chatMessagesByChatId[activeChatId] = next;
  };

  const persistMessage = async (chatId, message) => {
    if (!chatId || !message?.id) return;
    const sanitized = sanitizeMessageForStorage(message);
    const list = persistedByChatId[chatId] ? [...persistedByChatId[chatId]] : [];
    const idx = list.findIndex((m) => m.id === sanitized.id);
    if (idx >= 0) {
      list[idx] = sanitized;
    } else {
      list.push(sanitized);
    }
    persistedByChatId[chatId] = list;
  };

  const findExistingAssistantMessage = (chatId, assistantMessageId) => {
    const inChat = chatMessagesByChatId[chatId] || [];
    const found = inChat.find((m) => m.id === assistantMessageId);
    if (found) return found;
    return (persistedByChatId[chatId] || []).find((m) => m.id === assistantMessageId) || null;
  };

  const setLoadingState = (val) => {
    isLoading = val;
    isSubmitting = val;
  };

  const cancelCurrent = (reason = 'stopped') =>
    cancelActiveChatRequest(controller, reason, {
      getActiveChatId: () => activeChatId,
      onUpdateMessages: updateMessages,
      onPersistMessage: persistMessage,
      onSetLoadingState: setLoadingState,
      findExistingAssistantMessage,
      stopLocalEngine: () => {
        localEngineStopCount++;
      },
      forceStopLocalEngine: reason === 'stopped' && selectedProvider === 'webllm'
    });

  return {
    controller,
    getState() {
      return {
        activeChatId,
        selectedProvider,
        isLoading,
        isSubmitting,
        persistenceError,
        visibleMessages: getVisibleMessages(),
        chatMessagesByChatId,
        persistedByChatId,
        localEngineStopCount
      };
    },
    seedMessages(chatId, msgs) {
      chatMessagesByChatId[chatId] = msgs;
    },
    stopGenerating() {
      return cancelCurrent('stopped');
    },
    switchProvider(nextProvider) {
      if (nextProvider && nextProvider !== selectedProvider && controller.hasActiveRequest()) {
        cancelCurrent('provider_switched');
      }
      selectedProvider = nextProvider;
    },
    switchConversation(nextChatId) {
      if (nextChatId === activeChatId) return;
      activeChatId = nextChatId;
      if (!chatMessagesByChatId[nextChatId]) {
        chatMessagesByChatId[nextChatId] = [];
      }
      cancelCurrent('conversation_switched');
      setLoadingState(false);
    },
    async sendPrompt({
      prompt,
      assistantMessageId = null,
      overrideProvider = null,
      attachments = [],
      existingMessages = null,
      customPrepareAttachments = null,
      customStreamRequest = null
    }) {
      const targetChatId = activeChatId;
      const providerToUse = overrideProvider || selectedProvider;
      const msgId = assistantMessageId || `${providerToUse}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

      if (existingMessages) {
        chatMessagesByChatId[targetChatId] = existingMessages;
      } else {
        const current = chatMessagesByChatId[targetChatId] || [];
        const hasTarget = current.some((m) => m.id === msgId);
        if (!hasTarget) {
          const userMsg = {
            id: `user-${msgId}`,
            sender: 'user',
            content: prompt,
            attachments
          };
          const assistantPlaceholder = normalizeAssistantMessage(
            {
              id: msgId,
              sender: 'assistant',
              parentMessageId: userMsg.id,
              provider: providerToUse,
              modelUsed: null,
              content: '',
              isStreaming: true
            },
            userMsg
          );
          chatMessagesByChatId[targetChatId] = [...current, userMsg, assistantPlaceholder];
          void persistMessage(targetChatId, userMsg);
        }
      }

      setLoadingState(true);
      persistenceError = null;

      return runIsolatedPromptStream({
        controller,
        targetChatId,
        assistantMessageId: msgId,
        providerToUse,
        effectiveModelOverride: null,
        promptText: prompt,
        currentAttachments: attachments,
        prefersReducedMotion,
        getActiveChatId: () => activeChatId,
        onUpdateMessages: updateMessages,
        onPersistMessage: persistMessage,
        onSetLoadingState: setLoadingState,
        onSetPersistenceError: (msg) => {
          persistenceError = msg;
        },
        findExistingAssistantMessage,
        prepareAttachments:
          customPrepareAttachments ||
          (async (atts, { provider, model }) => {
            if (!Array.isArray(atts) || atts.length === 0) return atts;
            if (isVisionCapableProvider(provider, model)) {
              return hydrateAttachmentsWithImageBytes(atts, { provider, model });
            }
            return atts.map((a) => sanitizeAttachmentForNetwork(a, { includeImageBytes: false }));
          }),
        streamRequest:
          customStreamRequest ||
          (({ signal, isRequestActive, attachments: reqAtts, onStart, onChunk }) =>
            streamAIMessage({
              provider: providerToUse,
              prompt,
              history: [],
              signal,
              isRequestActive,
              conversationId: targetChatId,
              attachments: reqAtts,
              onStart,
              onChunk
            })),
        classifyError: (err, { finalProvider, providerToUse: prov }) => ({
          friendlyMsg: err?.message || 'Error',
          effectiveProvider: err?.provider || finalProvider || prov,
          canSwitchProvider: true
        })
      });
    }
  };
}

async function runTests() {
  console.log('=== Phase 3: Request Isolation & Cancellation Behavioral Tests ===\n');
  const sseServer = await startLocalSSEServer();
  let passed = 0;

  async function runCase(name, fn) {
    sseServer.resetRequests();
    sseServer.setHandler(null);
    try {
      await fn();
      passed++;
      console.log(`  ✓ ${passed}. ${name}`);
    } catch (err) {
      console.error(`\n  ✗ FAILED: ${name}`);
      console.error(err);
      await sseServer.close();
      process.exit(1);
    }
  }

  try {
    // -------------------------------------------------------------------------
    // Test 1: Request A can be cancelled
    // -------------------------------------------------------------------------
    await runCase('Request A can be cancelled cleanly via Stop (aborts signal & closes SSE stream)', async () => {
      let serverStreamClosed = false;
      let firstChunkDeliveredResolve;
      const firstChunkDelivered = new Promise((r) => {
        firstChunkDeliveredResolve = r;
      });

      sseServer.setHandler(async (req, res) => {
        res.on('close', () => {
          serverStreamClosed = true;
        });
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive'
        });
        res.write(`data: ${JSON.stringify({ type: 'start', modelUsed: 'gemini-3.1-flash-lite', provider: 'gemini' })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'chunk', text: 'Partial A content' })}\n\n`);
        // Keep SSE stream open until client aborts
      });

      const harness = createChatHarness({ prefersReducedMotion: true });
      const activePromise = harness.sendPrompt({
        prompt: 'Explain quantum computing in detail',
        assistantMessageId: 'msg-a'
      });

      // Wait until partial text arrives in the active request entry
      for (let i = 0; i < 50; i++) {
        if (harness.controller.getActiveRequest()?.partialText === 'Partial A content') {
          firstChunkDeliveredResolve();
          break;
        }
        await sleep(10);
      }
      await firstChunkDelivered;
      await sleep(25); // Allow animation pump tick

      assert.equal(harness.getState().isLoading, true, 'isLoading must be true while streaming');

      const cancelledEntry = harness.stopGenerating();
      assert.ok(cancelledEntry, 'stopGenerating must return the detached active entry');
      assert.equal(cancelledEntry.signal.aborted, true, 'AbortSignal must be aborted immediately');
      assert.equal(cancelledEntry.stoppedByUser, true, 'stoppedByUser flag must be recorded on the entry');
      assert.equal(harness.controller.hasActiveRequest(), false, 'No active request may remain after Stop');
      assert.equal(harness.getState().isLoading, false, 'isLoading must reset synchronously on Stop');

      const result = await activePromise;
      assert.equal(result.status, 'cancelled');

      // Wait briefly for TCP close event to reach local server
      for (let i = 0; i < 30 && !serverStreamClosed; i++) {
        await sleep(10);
      }
      assert.equal(serverStreamClosed, true, 'Server SSE stream must close promptly upon client cancellation');

      const assistantMsg = harness.getState().visibleMessages.find((m) => m.id === 'msg-a');
      assert.ok(assistantMsg, 'Assistant message must exist');
      assert.equal(assistantMsg.content, 'Partial A content');
      assert.equal(assistantMsg.isStreaming, false);
      assert.equal(assistantMsg.isStopped, true);
    });

    // -------------------------------------------------------------------------
    // Test 2: Cancelled Request A cannot update the UI afterward
    // -------------------------------------------------------------------------
    await runCase('Cancelled Request A cannot append text, mutate metadata, or trigger error banners afterward', async () => {
      /** @type {any} */
      let capturedCallbacks = null;
      let releaseBlockedStream;
      const blockedStreamPromise = new Promise((r) => {
        releaseBlockedStream = r;
      });

      const harness = createChatHarness({ prefersReducedMotion: false });
      const reqAPromise = harness.sendPrompt({
        prompt: 'Stream A',
        assistantMessageId: 'msg-a2',
        customStreamRequest: async (ctx) => {
          capturedCallbacks = ctx;
          ctx.onStart({ modelUsed: 'gemini-3.1-flash-lite', provider: 'gemini' });
          ctx.onChunk('Initial safe text', 'Initial safe text');
          await blockedStreamPromise;
          // Attempt to return late completed text even after cancellation
          return {
            text: 'Initial safe text + FORBIDDEN LATE COMPLETION',
            modelUsed: 'rogue-model',
            provider: 'gemini'
          };
        }
      });

      await sleep(35);
      harness.stopGenerating();

      const snapshotAfterStop = structuredClone(harness.getState().visibleMessages);
      const stoppedMsgBefore = snapshotAfterStop.find((m) => m.id === 'msg-a2');
      assert.equal(stoppedMsgBefore.isStopped, true);
      assert.equal(stoppedMsgBefore.isStreaming, false);

      // Fire rogue late callbacks directly after Stop
      capturedCallbacks.onStart({ modelUsed: 'rogue-late-model', provider: 'openrouter' });
      capturedCallbacks.onChunk(' + FORBIDDEN CHUNK', 'Initial safe text + FORBIDDEN CHUNK');
      releaseBlockedStream();
      await reqAPromise;
      await sleep(60); // Wait past multiple 18ms animation pump intervals

      const stateAfter = harness.getState();
      assert.deepEqual(
        stateAfter.visibleMessages,
        snapshotAfterStop,
        'Visible messages must remain 100% identical after late callbacks on a cancelled request'
      );
      assert.equal(stateAfter.persistenceError, null, 'Cancelled request must never set persistenceError');
      assert.equal(stateAfter.isLoading, false);
    });

    // -------------------------------------------------------------------------
    // Test 3: Request B can start immediately after cancelling A
    // -------------------------------------------------------------------------
    await runCase('Request B starts immediately (0ms) after cancelling A without Stop state or loading clobbering B', async () => {
      sseServer.setHandler(async (req, res, body) => {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive'
        });
        if (body.prompt === 'Prompt A') {
          res.write(`data: ${JSON.stringify({ type: 'start', modelUsed: 'gemini-a', provider: 'gemini' })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: 'chunk', text: 'A partial' })}\n\n`);
          // Intentionally hang until aborted
          return;
        }
        // Prompt B streams normally across multiple ticks
        res.write(`data: ${JSON.stringify({ type: 'start', modelUsed: 'gemini-b', provider: 'gemini' })}\n\n`);
        await sleep(25);
        res.write(`data: ${JSON.stringify({ type: 'chunk', text: 'Answer B part 1' })}\n\n`);
        await sleep(25);
        res.write(`data: ${JSON.stringify({ type: 'chunk', text: ' + part 2' })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'done', text: 'Answer B part 1 + part 2', modelUsed: 'gemini-b', provider: 'gemini' })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      });

      const harness = createChatHarness({ prefersReducedMotion: true });
      const promiseA = harness.sendPrompt({ prompt: 'Prompt A', assistantMessageId: 'assistant-A' });

      while (harness.controller.getActiveRequest()?.partialText !== 'A partial') {
        await sleep(10);
      }

      // Press Stop and IMMEDIATELY (synchronously, 0ms gap) start Request B
      harness.stopGenerating();
      const promiseB = harness.sendPrompt({ prompt: 'Prompt B', assistantMessageId: 'assistant-B' });

      // Immediately after launching B (while A's abort promise is still settling), isLoading MUST remain true!
      assert.equal(harness.getState().isLoading, true, 'isLoading must stay true for Request B');
      await promiseA;
      // Even right after A's promise settles, B is still streaming so isLoading must STILL be true!
      if (harness.controller.hasActiveRequest()) {
        assert.equal(harness.getState().isLoading, true, 'Settling Request A must NOT set isLoading=false while Request B is active');
      }

      const resB = await promiseB;
      assert.equal(resB.status, 'completed');
      assert.equal(harness.getState().isLoading, false, 'isLoading must become false once Request B completes');

      const msgA = harness.getState().visibleMessages.find((m) => m.id === 'assistant-A');
      const msgB = harness.getState().visibleMessages.find((m) => m.id === 'assistant-B');
      assert.equal(msgA.content, 'A partial');
      assert.equal(msgA.isStopped, true);
      assert.equal(msgB.content, 'Answer B part 1 + part 2');
      assert.equal(msgB.isStopped, false);
      assert.equal(msgB.isStreaming, false);
    });

    // -------------------------------------------------------------------------
    // Test 4: Request A cannot overwrite Request B (rapid consecutive execution)
    // -------------------------------------------------------------------------
    await runCase('Rapid consecutive prompts: superseded Request A (late chunk or error) cannot overwrite Request B', async () => {
      /** @type {any} */
      let callbacksA = null;
      let finishA;
      const waitA = new Promise((r) => {
        finishA = r;
      });

      const harness = createChatHarness({ prefersReducedMotion: true });

      const pA = harness.sendPrompt({
        prompt: 'First rapid prompt',
        assistantMessageId: 'rapid-msg-a',
        customStreamRequest: async (ctx) => {
          callbacksA = ctx;
          ctx.onStart({ modelUsed: 'slow-model-a', provider: 'gemini' });
          ctx.onChunk('Slow A start', 'Slow A start');
          await waitA;
          // Simulate late error on A after B is already running
          throw new Error('Late upstream 500 error from Request A');
        }
      });

      await sleep(15);
      const signalA = callbacksA.signal;
      assert.equal(signalA.aborted, false);

      // Immediately launch Request B (superseding Request A automatically)
      const pB = harness.sendPrompt({
        prompt: 'Second rapid prompt',
        assistantMessageId: 'rapid-msg-b',
        customStreamRequest: async (ctx) => {
          await sleep(20);
          // While B is in flight, A tries to emit a chunk AND reject with an error
          callbacksA.onChunk(' OVERWRITE ATTEMPT', 'Slow A start OVERWRITE ATTEMPT');
          finishA();
          await sleep(20);
          ctx.onStart({ modelUsed: 'fast-model-b', provider: 'gemini' });
          ctx.onChunk('Clean B result', 'Clean B result');
          return { text: 'Clean B result', modelUsed: 'fast-model-b', provider: 'gemini' };
        }
      });

      assert.equal(signalA.aborted, true, 'Starting Request B must automatically abort Request A signal');

      const [resA, resB] = await Promise.all([pA, pB]);
      assert.equal(resA.status, 'cancelled');
      assert.equal(resB.status, 'completed');

      const state = harness.getState();
      const msgB = state.visibleMessages.find((m) => m.id === 'rapid-msg-b');
      assert.equal(msgB.content, 'Clean B result');
      assert.equal(msgB.modelUsed, 'fast-model-b');
      assert.equal(state.persistenceError, null, 'Superseded Request A error must NOT display error banner');
    });

    // -------------------------------------------------------------------------
    // Test 5: Provider switching invalidates the previous request
    // -------------------------------------------------------------------------
    await runCase('Provider switching invalidates active Provider A stream and isolates Provider B retry', async () => {
      let providerASignal = null;

      sseServer.setHandler(async (req, res, body) => {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive'
        });

        if (body.provider === 'gemini') {
          res.write(`data: ${JSON.stringify({ type: 'start', modelUsed: 'gemini-3.1-flash-lite', provider: 'gemini' })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: 'chunk', text: 'Gemini partial...' })}\n\n`);
          // Stay open until aborted by provider switch
          return;
        }

        if (body.provider === 'groq') {
          res.write(`data: ${JSON.stringify({ type: 'start', modelUsed: 'openai/gpt-oss-120b', provider: 'groq' })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: 'chunk', text: 'Groq complete response!' })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: 'done', text: 'Groq complete response!', modelUsed: 'openai/gpt-oss-120b', provider: 'groq' })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        }
      });

      const harness = createChatHarness({ initialProvider: 'gemini', prefersReducedMotion: true });
      const geminiPromise = harness.sendPrompt({
        prompt: 'Compare RISC-V and ARM',
        assistantMessageId: 'prov-msg-1'
      });

      while (harness.controller.getActiveRequest()?.partialText !== 'Gemini partial...') {
        await sleep(10);
      }
      providerASignal = harness.controller.getActiveRequest().signal;

      // User switches provider in ModelSelector from Gemini -> Groq mid-stream
      harness.switchProvider('groq');
      assert.equal(providerASignal.aborted, true, 'Switching provider must immediately abort Provider A signal');
      assert.equal(harness.controller.hasActiveRequest(), false, 'Active request must be cleared on provider switch');
      assert.equal(harness.getState().isLoading, false);

      await geminiPromise;

      // Now send/retry with Provider B (Groq)
      const groqPromise = harness.sendPrompt({
        prompt: 'Compare RISC-V and ARM',
        assistantMessageId: 'prov-msg-2'
      });
      const groqRes = await groqPromise;
      assert.equal(groqRes.status, 'completed');

      const msg1 = harness.getState().visibleMessages.find((m) => m.id === 'prov-msg-1');
      const msg2 = harness.getState().visibleMessages.find((m) => m.id === 'prov-msg-2');
      assert.equal(msg1.isStopped, true);
      assert.equal(msg1.provider, 'gemini');
      assert.equal(msg2.content, 'Groq complete response!');
      assert.equal(msg2.provider, 'groq');
      assert.equal(msg2.modelUsed, 'openai/gpt-oss-120b');
    });

    // -------------------------------------------------------------------------
    // Test 6: Retry / regenerate / alternative cannot receive stale chunks on same assistantMessageId
    // -------------------------------------------------------------------------
    await runCase('Regenerate and Generate Alternative on the same assistantMessageId block stale chunks from older request', async () => {
      /** @type {any} */
      let oldAttemptCallbacks = null;
      let releaseOldAttempt;
      const oldAttemptGate = new Promise((r) => {
        releaseOldAttempt = r;
      });

      const harness = createChatHarness({ prefersReducedMotion: true });

      // Initial attempt on shared assistant ID `regen-target`
      const attempt1 = harness.sendPrompt({
        prompt: 'Write a haiku about rust',
        assistantMessageId: 'regen-target',
        customStreamRequest: async (ctx) => {
          oldAttemptCallbacks = ctx;
          ctx.onStart({ modelUsed: 'gemini-3.1-flash-lite', provider: 'gemini' });
          ctx.onChunk('Old stale line 1', 'Old stale line 1');
          await oldAttemptGate;
          return { text: 'Old stale full text', modelUsed: 'gemini-3.1-flash-lite', provider: 'gemini' };
        }
      });

      await sleep(20);
      harness.stopGenerating();

      // Prepare in-place regeneration on the EXACT SAME `regen-target` message ID
      const resetMsgs = harness.getState().visibleMessages.map((m) => {
        if (m.id !== 'regen-target') return m;
        return normalizeAssistantMessage({
          ...m,
          content: '',
          isStreaming: true,
          isStopped: false,
          isError: false
        });
      });

      const attempt2 = harness.sendPrompt({
        prompt: 'Write a haiku about rust',
        assistantMessageId: 'regen-target',
        existingMessages: resetMsgs,
        customStreamRequest: async (ctx) => {
          // While regenerate attempt2 is streaming on `regen-target`, attempt1 fires late chunks & resolves!
          oldAttemptCallbacks.onChunk(' + STALE LEAK', 'Old stale line 1 + STALE LEAK');
          releaseOldAttempt();
          await sleep(20);
          ctx.onStart({ modelUsed: 'gemini-3.1-flash-lite', provider: 'gemini' });
          ctx.onChunk('Memory stays safe', 'Memory stays safe');
          return { text: 'Memory stays safe', modelUsed: 'gemini-3.1-flash-lite', provider: 'gemini' };
        }
      });

      await Promise.all([attempt1, attempt2]);

      const regenerated = harness.getState().visibleMessages.find((m) => m.id === 'regen-target');
      assert.equal(regenerated.content, 'Memory stays safe', 'Regenerated message must contain ONLY attempt 2 text');
      assert.equal(regenerated.isStopped, false);
      assert.equal(regenerated.isStreaming, false);

      // Now test Generate Alternative on `regen-target` with Groq while keeping Alternative #1 intact
      const withAltMsgs = harness.getState().visibleMessages.map((m) => {
        if (m.id !== 'regen-target') return m;
        const alt = createAlternativeRecord({
          parentMessageId: m.parentMessageId,
          provider: 'groq',
          modelUsed: 'openai/gpt-oss-120b',
          content: '',
          isStreaming: true
        });
        return {
          ...addAlternativeToAssistantMessage(m, alt),
          isStreaming: true,
          isStopped: false
        };
      });

      await harness.sendPrompt({
        prompt: 'Write a haiku about rust',
        assistantMessageId: 'regen-target',
        overrideProvider: 'groq',
        existingMessages: withAltMsgs,
        customStreamRequest: async (ctx) => {
          ctx.onStart({ modelUsed: 'openai/gpt-oss-120b', provider: 'groq' });
          ctx.onChunk('Borrow checker smiles', 'Borrow checker smiles');
          return { text: 'Borrow checker smiles', modelUsed: 'openai/gpt-oss-120b', provider: 'groq' };
        }
      });

      const withBothAlts = harness.getState().visibleMessages.find((m) => m.id === 'regen-target');
      assert.equal(withBothAlts.alternatives.length, 2);
      assert.equal(withBothAlts.alternatives[0].content, 'Memory stays safe', 'Alternative #1 must remain untouched');
      assert.equal(withBothAlts.alternatives[1].content, 'Borrow checker smiles', 'Alternative #2 must contain new Groq response');
      assert.equal(withBothAlts.content, 'Borrow checker smiles');
    });

    // -------------------------------------------------------------------------
    // Test 7: Conversation switching prevents old responses from entering new conversation
    // -------------------------------------------------------------------------
    await runCase('Conversation switching (A -> B and A -> B -> A) prevents stale chunks from leaking across chats', async () => {
      /** @type {any} */
      let chatACallbacks = null;
      let finishChatAStream;
      const chatAGate = new Promise((r) => {
        finishChatAStream = r;
      });

      const harness = createChatHarness({ initialChatId: 'chat-A', prefersReducedMotion: false });
      const chatAPromise = harness.sendPrompt({
        prompt: 'Long story in Chat A',
        assistantMessageId: 'msg-chat-A',
        customStreamRequest: async (ctx) => {
          chatACallbacks = ctx;
          ctx.onStart({ modelUsed: 'gemini-3.1-flash-lite', provider: 'gemini' });
          ctx.onChunk('Chapter 1 in Chat A.', 'Chapter 1 in Chat A.');
          await chatAGate;
          return { text: 'Chapter 1 + Stale Chapter 2', modelUsed: 'gemini-3.1-flash-lite', provider: 'gemini' };
        }
      });

      await sleep(30);

      // Switch to Conversation B while Chat A is actively streaming
      harness.switchConversation('chat-B');
      assert.equal(chatACallbacks.signal.aborted, true, 'Switching away from Chat A must abort Chat A request');
      assert.equal(harness.getState().activeChatId, 'chat-B');
      assert.equal(harness.getState().visibleMessages.length, 0, 'Chat B must start completely clean');

      // Fire late chunks from Chat A while viewing Chat B
      chatACallbacks.onChunk(' LEAK INTO B?', 'Chapter 1 in Chat A. LEAK INTO B?');
      await sleep(30);
      assert.equal(harness.getState().visibleMessages.length, 0, 'Zero messages from Chat A may enter Chat B');

      // Rapidly switch back to Chat A (A -> B -> A) BEFORE Chat A's promise finishes settling
      harness.switchConversation('chat-A');
      chatACallbacks.onChunk(' RESURRECTED IN A?', 'Chapter 1 in Chat A. RESURRECTED IN A?');
      finishChatAStream();
      await chatAPromise;
      await sleep(40);

      const chatAMsgs = harness.getState().chatMessagesByChatId['chat-A'];
      const msgInA = chatAMsgs.find((m) => m.id === 'msg-chat-A');
      assert.ok(!msgInA.content.includes('LEAK INTO B'), 'No leaked text in Chat A');
      assert.ok(!msgInA.content.includes('RESURRECTED'), 'Switching back B -> A must not resurrect invalidated stream');

      const persistedA = (harness.getState().persistedByChatId['chat-A'] || []).find((m) => m.id === 'msg-chat-A');
      assert.ok(persistedA, 'Stopped message for Chat A must be persisted cleanly in Chat A storage');
      assert.equal(persistedA.isStopped, true);
      assert.equal(persistedA.isStreaming, false);
      assert.equal((harness.getState().persistedByChatId['chat-B'] || []).length, 0, 'Zero persistence writes to Chat B');
    });

    // -------------------------------------------------------------------------
    // Test 8: Automatic continuation cannot restart after cancellation
    // -------------------------------------------------------------------------
    await runCase('Automatic stream continuation never restarts after cancellation or supersession (and still works when active)', async () => {
      // Part 8A: Aborted mid-stream drop -> MUST NOT auto-continue
      const abortCtrl = new AbortController();
      sseServer.setHandler(async (_req, res) => {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive'
        });
        res.write(`data: ${JSON.stringify({ type: 'start', modelUsed: 'gemini-3.1-flash-lite', provider: 'gemini' })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'chunk', text: 'Partial before user stop' })}\n\n`);
        await sleep(15);
        // User cancels right before/as connection drops without [DONE]
        abortCtrl.abort();
        res.end();
      });

      await assert.rejects(
        () =>
          streamAIMessage({
            provider: 'gemini',
            prompt: 'Write a 5000 word essay',
            signal: abortCtrl.signal
          }),
        (err) => err?.name === 'AbortError'
      );
      assert.equal(
        sseServer.receivedRequests.length,
        1,
        'Cancelled mid-stream drop must make 0 automatic continuation requests'
      );

      // Part 8B: Superseded via isRequestActive() -> MUST NOT auto-continue even if signal not yet aborted
      sseServer.resetRequests();
      let requestStillActive = true;
      sseServer.setHandler(async (_req, res) => {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive'
        });
        res.write(`data: ${JSON.stringify({ type: 'chunk', text: 'Truncated chunk' })}\n\n`);
        requestStillActive = false; // Superseded by newer requestId right as stream closes without [DONE]
        res.end();
      });

      await assert.rejects(
        () =>
          streamAIMessage({
            provider: 'gemini',
            prompt: 'Write another essay',
            isRequestActive: () => requestStillActive
          }),
        (err) => err?.name === 'AbortError'
      );
      assert.equal(
        sseServer.receivedRequests.length,
        1,
        'Superseded request must NOT launch an automatic continuation request'
      );

      // Part 8C: Uncancelled mid-stream drop -> MUST still seamlessly auto-continue!
      sseServer.resetRequests();
      sseServer.setHandler(async (_req, res, body, idx) => {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive'
        });
        if (idx === 0) {
          assert.equal(body.isContinuation, false);
          res.write(`data: ${JSON.stringify({ type: 'start', modelUsed: 'gemini-3.1-flash-lite', provider: 'gemini' })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: 'chunk', text: 'First half of stream' })}\n\n`);
          // Simulate abrupt upstream drop WITHOUT done/[DONE]
          res.end();
          return;
        }
        assert.equal(body.isContinuation, true);
        assert.equal(body.partNumber, 2);
        res.write(`data: ${JSON.stringify({ type: 'chunk', text: ' + seamlessly continued second half.' })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'done', modelUsed: 'gemini-3.1-flash-lite', provider: 'gemini' })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      });

      let latestAccumulated = '';
      const contResult = await streamAIMessage({
        provider: 'gemini',
        prompt: 'Long uninterrupted request',
        onChunk: (_delta, acc) => {
          latestAccumulated = acc;
        }
      });
      assert.equal(sseServer.receivedRequests.length, 2, 'Active interrupted stream must auto-continue');
      assert.equal(latestAccumulated, 'First half of stream + seamlessly continued second half.');
      assert.equal(contResult.text, 'First half of stream + seamlessly continued second half.');
    });

    // -------------------------------------------------------------------------
    // Test 9: Normal successful streaming still works end-to-end
    // -------------------------------------------------------------------------
    await runCase('Normal successful streaming progressively animates, records metrics, and finalizes cleanly', async () => {
      sseServer.setHandler(async (_req, res) => {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive'
        });
        res.write(`data: ${JSON.stringify({ type: 'start', modelUsed: 'gemini-3.1-flash-lite', provider: 'gemini' })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'chunk', text: 'Hello ' })}\n\n`);
        await sleep(20);
        res.write(`data: ${JSON.stringify({ type: 'chunk', text: 'Orvix ' })}\n\n`);
        await sleep(20);
        res.write(`data: ${JSON.stringify({ type: 'chunk', text: 'Phase 3!' })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'done', text: 'Hello Orvix Phase 3!', modelUsed: 'gemini-3.1-flash-lite', provider: 'gemini' })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      });

      // Use prefersReducedMotion: false to exercise the real progressive pumpAnimation timer loop
      const harness = createChatHarness({ prefersReducedMotion: false });
      const res = await harness.sendPrompt({
        prompt: 'Greet Phase 3',
        assistantMessageId: 'normal-stream-msg'
      });

      assert.equal(res.status, 'completed');
      const state = harness.getState();
      assert.equal(state.isLoading, false);
      assert.equal(state.isSubmitting, false);
      assert.equal(state.persistenceError, null);

      const finalMsg = state.visibleMessages.find((m) => m.id === 'normal-stream-msg');
      assert.ok(finalMsg);
      assert.equal(finalMsg.content, 'Hello Orvix Phase 3!');
      assert.equal(finalMsg.modelUsed, 'gemini-3.1-flash-lite');
      assert.equal(finalMsg.provider, 'gemini');
      assert.equal(finalMsg.isStreaming, false);
      assert.equal(finalMsg.isStopped, false);
      assert.ok(typeof finalMsg.responseTimeMs === 'number' && finalMsg.responseTimeMs >= 1);

      const persisted = (state.persistedByChatId['chat-1'] || []).find((m) => m.id === 'normal-stream-msg');
      assert.ok(persisted);
      assert.equal(persisted.content, 'Hello Orvix Phase 3!');
    });

    // -------------------------------------------------------------------------
    // Test 10: Existing attachment/OCR & provider-gated image hydration remain unaffected
    // -------------------------------------------------------------------------
    await runCase('Existing attachment OCR text, Gemini image hydration, Groq gating, and mid-hydration cancellation work cleanly', async () => {
      const imageFile = new Blob([TINY_PNG_BYTES], { type: 'image/png' });
      const sampleImageAttachment = {
        id: 'att-phase3-img',
        name: 'receipt.png',
        originalName: 'receipt.png',
        type: 'image/png',
        extension: 'png',
        size: TINY_PNG_BYTES.length,
        formattedSize: '68 B',
        isImage: true,
        file: imageFile,
        extraction: {
          status: 'ready',
          text: 'TOTAL DUE: $42.00',
          isImage: true
        }
      };

      sseServer.setHandler(async (_req, res, body) => {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive'
        });
        const prov = body.provider;
        const att = body.attachments?.[0];
        const summary = `provider=${prov};hasBase64=${Boolean(att?.base64)};ocr=${att?.extraction?.text || ''}`;
        res.write(`data: ${JSON.stringify({ type: 'start', modelUsed: `${prov}-model`, provider: prov })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'chunk', text: summary })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'done', text: summary, modelUsed: `${prov}-model`, provider: prov })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      });

      const harness = createChatHarness({ initialProvider: 'gemini', prefersReducedMotion: true });

      // 10A: Gemini receives hydrated base64 image bytes + OCR text, while persisted state strips base64
      await harness.sendPrompt({
        prompt: 'What is the total due?',
        assistantMessageId: 'att-gemini-msg',
        attachments: [sampleImageAttachment]
      });
      const geminiMsg = harness.getState().visibleMessages.find((m) => m.id === 'att-gemini-msg');
      assert.equal(geminiMsg.content, 'provider=gemini;hasBase64=true;ocr=TOTAL DUE: $42.00');
      const persistedUser = (harness.getState().persistedByChatId['chat-1'] || []).find((m) => m.sender === 'user');
      assert.equal(persistedUser.attachments[0].base64, undefined, 'Persisted user attachment must never contain raw base64');

      // 10B: Text-only provider (Groq) skips raw base64 hydration while preserving OCR text
      harness.switchProvider('groq');
      await harness.sendPrompt({
        prompt: 'What is the total due?',
        assistantMessageId: 'att-groq-msg',
        attachments: [sampleImageAttachment]
      });
      const groqMsg = harness.getState().visibleMessages.find((m) => m.id === 'att-groq-msg');
      assert.equal(groqMsg.content, 'provider=groq;hasBase64=false;ocr=TOTAL DUE: $42.00');

      // 10C: Cancelling during async attachment hydration prevents `/api/chat` from ever being called
      sseServer.resetRequests();
      const cancelHydratePromise = harness.sendPrompt({
        prompt: 'Cancel during hydration',
        assistantMessageId: 'att-cancelled-hydrate',
        attachments: [sampleImageAttachment],
        customPrepareAttachments: async (atts) => {
          await sleep(30);
          return atts;
        }
      });
      await sleep(10);
      harness.stopGenerating();
      const cancelHydrateRes = await cancelHydratePromise;
      assert.equal(cancelHydrateRes.status, 'cancelled');
      assert.equal(
        sseServer.receivedRequests.length,
        0,
        'Stopping during async attachment hydration must prevent /api/chat network dispatch'
      );
    });

    console.log(`\n=== ALL ${passed}/10 PHASE 3 REQUEST ISOLATION TESTS PASSED ===`);
  } finally {
    await sseServer.close();
  }
}

runTests().catch((err) => {
  console.error('Unhandled test runner failure:', err);
  process.exit(1);
});
