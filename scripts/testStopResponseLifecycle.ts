/**
 * Orvix Stop Response Lifecycle & Response Actions Regression Test Suite
 *
 * Verifies the end-to-end stop lifecycle, UI rendering, Regenerate, MongoDB persistence,
 * SSE stream aborting, and concurrent-generation race isolation:
 *  1. Clicking Stop during an in-flight network stream (mid-SSE stream)
 *  2. Clicking Stop during post-network progressive animation backlog (fast provider SSE done, text still revealing)
 *  3. Partial response content preserved (never erased) & saved via MongoDB API + local cache
 *  4. Blue blinking cursor (`.ai-markdown-container.is-streaming` / `.streaming-code`) disappears immediately after Stop
 *  5. Per-message Stop button disappears and normal action toolbar (`Copy`, `Read aloud`, `Regenerate`, `Regenerate with another AI Model`) returns immediately
 *  6. `Regenerate` works on the interrupted/stopped response in-place, clears `isStopped`, and persists regenerated content
 *  7. Zero additional tokens appended after Stop (both in `aiRouter.js` SSE reader and in `streamLifecycle.js` animation pump)
 *  8. No false error status (`isError === false`, no error banner, no `persistenceError`)
 *  9. Refreshing and reopening a stopped response from MongoDB & local cache preserves `isStopped: true` with `isStreaming: false` (no stuck cursor or Stop button)
 * 10. Starting a new response immediately after stopping the previous one — stale abort/completion callbacks from Stream #1 never clobber Stream #2's `isLoading`, `isSubmitting`, or messages
 * 11. Normal successful completion and genuine provider error handling remain completely intact
 */

process.env.TESTING = 'true';
import dotenv from 'dotenv';
dotenv.config();

import assert from 'node:assert';
import http from 'node:http';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DecodedIdToken } from 'firebase-admin/auth';

import { app } from '../server.ts';
import {
  setMockAuthVerifierForTesting,
  resetFirebaseAdminForTesting
} from '../src/services/firebaseAdminService.ts';
import { setMockDatabaseForTesting } from '../src/db/mongodb.ts';
import {
  createChatDocument,
  saveChatMessage,
  loadConversationMessages,
  getCachedChatMessages,
  setAuthTokenProviderForTesting
} from '../src/services/chatStorageService.js';
import {
  normalizeAssistantMessage,
  updateActiveAlternativeInMessage,
  addAlternativeToAssistantMessage,
  switchActiveAlternativeInMessage,
  ensureConversationAlternatives,
  createAlternativeRecord,
  getActiveAlternative
} from '../src/services/alternativeResponseService.js';
import {
  executeStreamPromptSession,
  stopActiveGenerationSession
} from '../src/services/streamLifecycle.js';
import { streamAIMessage } from '../src/services/aiRouter.js';
import ChatMessage from '../src/components/chat/ChatMessage.jsx';
import { SpeechProvider } from '../src/context/SpeechContext.jsx';

// ---------------------------------------------------------------------------
// Mock Browser Storage & Environment Setup
// ---------------------------------------------------------------------------
const mockStorage = new Map<string, string>();
(global as any).localStorage = {
  getItem: (key: string) => (mockStorage.has(key) ? mockStorage.get(key)! : null),
  setItem: (key: string, val: string) => mockStorage.set(key, String(val)),
  removeItem: (key: string) => mockStorage.delete(key),
  clear: () => mockStorage.clear(),
  get length() {
    return mockStorage.size;
  },
  key: (index: number) => Array.from(mockStorage.keys())[index] ?? null
};

(global as any).window = {
  localStorage: (global as any).localStorage,
  speechSynthesis: {},
  SpeechSynthesisUtterance: function () {},
  addEventListener: () => {},
  removeEventListener: () => {},
  matchMedia: () => ({ matches: false })
};

Object.defineProperty(globalThis, 'navigator', {
  value: { onLine: true },
  configurable: true,
  writable: true
});

const TEST_USER: DecodedIdToken = {
  uid: 'user-stop-lifecycle-1',
  email: 'stoptest@orvix.ai',
  email_verified: true,
  name: 'Stop Tester',
  aud: 'orvix-project',
  auth_time: 1000,
  exp: 9999999999,
  iat: 1000,
  iss: 'https://securetoken.google.com/orvix-project',
  sub: 'user-stop-lifecycle-1',
  firebase: { identities: { email: ['stoptest@orvix.ai'] }, sign_in_provider: 'password' }
};

let currentTestToken: string | null = 'valid-stop-test-token';
setAuthTokenProviderForTesting(async () => currentTestToken);

function cloneDoc<T>(val: T): T {
  if (val instanceof Date) return new Date(val.getTime()) as unknown as T;
  if (Array.isArray(val)) return val.map((item) => cloneDoc(item)) as unknown as T;
  if (val !== null && typeof val === 'object') {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(val as Record<string, any>)) {
      if (v !== undefined) out[k] = cloneDoc(v);
    }
    return out as T;
  }
  return val;
}

function matchesFilter(doc: any, filter: any): boolean {
  if (!filter || Object.keys(filter).length === 0) return true;
  for (const [k, v] of Object.entries(filter)) {
    if (k === '$or' && Array.isArray(v)) {
      if (!v.some((cond) => matchesFilter(doc, cond))) return false;
      continue;
    }
    if (k === '$and' && Array.isArray(v)) {
      if (!v.every((cond) => matchesFilter(doc, cond))) return false;
      continue;
    }
    if (v && typeof v === 'object' && !(v instanceof Date) && '$in' in v) {
      const list = (v as any).$in;
      if (Array.isArray(list) && !list.includes(doc[k])) return false;
      continue;
    }
    if (doc[k] !== v) return false;
  }
  return true;
}

function createMockDb() {
  const conversationsStore = new Map<string, any>();
  const messagesStore = new Map<string, any>();
  const usersStore = new Map<string, any>();
  const settingsStore = new Map<string, any>();

  function makeCollection(store: Map<string, any>, name: string) {
    return {
      collectionName: name,
      createIndex: async () => `${name}_idx`,
      insertOne: async (doc: any) => {
        const cloned = cloneDoc(doc);
        const id = String(cloned._id ?? cloned.id);
        if (store.has(id)) {
          const dupErr: any = new Error(`E11000 duplicate key: ${id}`);
          dupErr.code = 11000;
          throw dupErr;
        }
        store.set(id, cloned);
        return { acknowledged: true, insertedId: cloned._id };
      },
      findOne: async (filter: any) => {
        for (const item of store.values()) {
          if (matchesFilter(item, filter)) return cloneDoc(item);
        }
        return null;
      },
      find: (filter: any = {}) => {
        const items = Array.from(store.values())
          .filter((d) => matchesFilter(d, filter))
          .map((d) => cloneDoc(d));
        let sortSpec: Record<string, 1 | -1> | null = null;
        const cursor = {
          sort(spec: Record<string, 1 | -1>) {
            sortSpec = spec;
            return cursor;
          },
          skip() {
            return cursor;
          },
          limit() {
            return cursor;
          },
          async toArray() {
            const out = [...items];
            if (sortSpec) {
              const entries = Object.entries(sortSpec);
              out.sort((a, b) => {
                for (const [field, dir] of entries) {
                  const av = a[field] instanceof Date ? a[field].getTime() : a[field];
                  const bv = b[field] instanceof Date ? b[field].getTime() : b[field];
                  if (av < bv) return dir === 1 ? -1 : 1;
                  if (av > bv) return dir === 1 ? 1 : -1;
                }
                return 0;
              });
            }
            return out;
          }
        };
        return cursor;
      },
      countDocuments: async (filter: any = {}) => {
        let count = 0;
        for (const item of store.values()) {
          if (matchesFilter(item, filter)) count++;
        }
        return count;
      },
      findOneAndUpdate: async (filter: any, update: any, options?: any) => {
        let existingKey: string | null = null;
        let existingDoc: any = null;
        for (const [k, v] of store.entries()) {
          if (matchesFilter(v, filter)) {
            existingKey = k;
            existingDoc = v;
            break;
          }
        }
        if (!existingDoc) {
          if (!options?.upsert) return null;
          const base = { ...(update?.$setOnInsert || {}), ...(update?.$set || {}) };
          const id = String(base._id ?? base.id ?? `doc-${Date.now()}`);
          base._id = id;
          const cloned = cloneDoc(base);
          store.set(id, cloned);
          return cloneDoc(cloned);
        }
        const merged = { ...cloneDoc(existingDoc), ...(update?.$set || {}) };
        store.set(existingKey!, merged);
        return options?.returnDocument === 'before' ? cloneDoc(existingDoc) : cloneDoc(merged);
      },
      updateOne: async (filter: any, update: any) => {
        for (const [k, v] of store.entries()) {
          if (matchesFilter(v, filter)) {
            const updated = {
              ...cloneDoc(v),
              ...(update?.$set ? cloneDoc(update.$set) : {})
            };
            store.set(k, updated);
            return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
          }
        }
        return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
      },
      deleteMany: async (filter: any) => {
        let deletedCount = 0;
        for (const [k, v] of Array.from(store.entries())) {
          if (matchesFilter(v, filter)) {
            store.delete(k);
            deletedCount++;
          }
        }
        return { acknowledged: true, deletedCount };
      },
      deleteOne: async (filter: any) => {
        for (const [k, v] of Array.from(store.entries())) {
          if (matchesFilter(v, filter)) {
            store.delete(k);
            return { acknowledged: true, deletedCount: 1 };
          }
        }
        return { acknowledged: true, deletedCount: 0 };
      }
    };
  }

  const collections: Record<string, any> = {
    conversations: makeCollection(conversationsStore, 'conversations'),
    messages: makeCollection(messagesStore, 'messages'),
    users: makeCollection(usersStore, 'users'),
    user_settings: makeCollection(settingsStore, 'user_settings')
  };

  return {
    messagesStore,
    db: {
      collection: (name: string) => collections[name] || makeCollection(new Map(), name),
      command: async () => ({ ok: 1 })
    }
  };
}

function renderMessageHtml(message: any, isLoading = false): string {
  return renderToStaticMarkup(
    React.createElement(
      SpeechProvider,
      null,
      React.createElement(ChatMessage as any, {
        message,
        isLoading,
        onStopGenerating: () => {},
        onRegenerate: () => {},
        onGenerateAlternative: () => {},
        onSwitchAlternative: () => {},
        onRetry: () => {},
        onSwitchProvider: () => {},
        onRestorePrompt: () => {}
      })
    )
  );
}

/**
 * Stateful harness replicating ChatPage's exact refs, commitMessages, persistMessageSafe,
 * handleStopGenerating, and handleRegenerate wiring.
 */
function createChatHarness(userId: string, initialChatId: string) {
  let messages: any[] = [];
  let isLoading = false;
  let persistenceError: string | null = null;
  const persistedIds = new Set<string>();

  const refs = {
    activeAbortControllerRef: { current: null as AbortController | null },
    activeAnimationRef: { current: null as (() => void) | null },
    activeStopHandlerRef: { current: null as (() => any) | null },
    activeChatIdRef: { current: initialChatId },
    messagesRef: { current: messages },
    generationIdRef: { current: 0 },
    isSubmittingRef: { current: false },
    isUserStoppedRef: { current: false }
  };

  const setIsLoading = (next: boolean) => {
    isLoading = Boolean(next);
  };

  const setPersistenceError = (msg: string | null) => {
    persistenceError = msg;
  };

  const commitMessages = (updater: any) => {
    const base = Array.isArray(refs.messagesRef.current) ? refs.messagesRef.current : [];
    const computedNext = typeof updater === 'function' ? updater(base) : updater;
    messages = computedNext;
    refs.messagesRef.current = computedNext;
    return computedNext;
  };

  const persistPromises: Promise<any>[] = [];

  const persistMessageSafe = async (chatId: string, msg: any, force = false) => {
    if (!chatId || !msg?.id) return;
    if (force) {
      persistedIds.delete(msg.id);
    } else if (persistedIds.has(msg.id)) {
      return;
    }
    persistedIds.add(msg.id);
    const normalized = msg.sender === 'assistant' ? normalizeAssistantMessage(msg) : msg;
    const p = saveChatMessage(userId, chatId, normalized);
    persistPromises.push(p);
    await p;
  };

  const stopGenerating = () => {
    stopActiveGenerationSession({
      refs,
      selectedProvider: 'gemini',
      webllmStatus: 'idle',
      stopWebLLMGeneration: () => {},
      commitMessages,
      persistMessageSafe,
      setIsLoading
    });
  };

  const sendPrompt = async (
    promptText: string,
    streamFn: (args: any) => Promise<any>,
    options: { prefersReducedMotion?: boolean; provider?: string } = {}
  ) => {
    const provider = options.provider || 'gemini';
    refs.isSubmittingRef.current = true;
    setIsLoading(true);
    setPersistenceError(null);

    const now = Date.now() + Math.floor(Math.random() * 1000);
    const userMessage = {
      id: `user-${now}`,
      sender: 'user',
      timestamp: '10:00 AM',
      content: promptText,
      attachments: []
    };
    const assistantMessageId = `${provider}-${now}-assistant`;
    const initialAssistant: any = normalizeAssistantMessage(
      {
        id: assistantMessageId,
        sender: 'assistant',
        parentMessageId: userMessage.id,
        provider,
        modelUsed: null,
        mode: 'general',
        timestamp: '10:00 AM',
        content: '',
        isStreaming: true,
        requestStartTime: performance.now()
      },
      userMessage
    );

    const validHistory = messages.filter((m) => !m.isError);
    commitMessages((prev: any[]) => [...prev, userMessage, initialAssistant]);
    await persistMessageSafe(refs.activeChatIdRef.current, userMessage);

    await (executeStreamPromptSession as any)({
      promptText,
      historyContext: validHistory,
      targetChatId: refs.activeChatIdRef.current,
      assistantMessageId,
      providerToUse: provider,
      effectiveModelOverride: null,
      activeMode: 'general',
      username: 'Stop Tester',
      preferences: { responseLength: 'balanced', beginnerFriendly: false },
      currentAttachments: [],
      multiPartParams: {},
      customStartTime: initialAssistant.requestStartTime,
      prefersReducedMotion: Boolean(options.prefersReducedMotion),
      streamAIMessageFn: streamFn,
      stopWebLLMGeneration: () => {},
      getWebLLMStatus: () => 'idle',
      refs,
      commitMessages,
      findMessageInUserChats: () => null,
      persistMessageSafe,
      setIsLoading,
      setPersistenceError
    });

    return { userMessage, assistantMessageId };
  };

  const regenerateMessage = async (
    targetMessage: any,
    streamFn: (args: any) => Promise<any>,
    options: { prefersReducedMotion?: boolean } = {}
  ) => {
    assert.strictEqual(isLoading, false, 'isLoading must be false before Regenerate');
    assert.strictEqual(refs.isSubmittingRef.current, false, 'isSubmittingRef must be false before Regenerate');

    const currentMessages = refs.messagesRef.current;
    const msgIndex = currentMessages.findIndex((m) => m.id === targetMessage.id);
    assert.ok(msgIndex >= 0, 'Target assistant message must exist in messages');

    const precedingUser = targetMessage.parentMessageId
      ? currentMessages.find((m) => m.id === targetMessage.parentMessageId)
      : [...currentMessages.slice(0, msgIndex)].reverse().find((m) => m.sender === 'user');
    assert.ok(precedingUser, 'Preceding user prompt must be resolved for Regenerate');

    const normalizedTarget: any = normalizeAssistantMessage(targetMessage, precedingUser);
    const activeAlt: any = getActiveAlternative(normalizedTarget);
    const providerToUse = activeAlt?.provider || targetMessage.provider || 'gemini';
    const modelToUse = activeAlt?.modelUsed || targetMessage.modelUsed || null;

    refs.isSubmittingRef.current = true;
    setIsLoading(true);
    setPersistenceError(null);
    persistedIds.delete(targetMessage.id);

    const requestStartTime = performance.now();
    commitMessages((prev: any[]) =>
      prev.map((m) => {
        if (m.id !== targetMessage.id) return m;
        const normalized: any = normalizeAssistantMessage(m, precedingUser);
        const updated: any = updateActiveAlternativeInMessage(normalized, {
          content: '',
          modelUsed: modelToUse,
          provider: providerToUse,
          responseTimeMs: null,
          timestamp: '10:01 AM',
          isStreaming: true,
          isError: false,
          isStopped: false,
          isInterrupted: false,
          failedPrompt: undefined,
          failedProvider: undefined,
          referencedAttachments: undefined
        });
        return { ...updated, requestStartTime };
      })
    );

    const userIdx = currentMessages.findIndex((m) => m.id === precedingUser.id);
    const validHistory = currentMessages.slice(0, userIdx).filter((m) => !m.isError);

    await (executeStreamPromptSession as any)({
      promptText: precedingUser.content,
      historyContext: validHistory,
      targetChatId: refs.activeChatIdRef.current,
      assistantMessageId: targetMessage.id,
      providerToUse,
      effectiveModelOverride: modelToUse,
      activeMode: 'general',
      username: 'Stop Tester',
      preferences: { responseLength: 'balanced', beginnerFriendly: false },
      currentAttachments: [],
      multiPartParams: {},
      customStartTime: requestStartTime,
      prefersReducedMotion: Boolean(options.prefersReducedMotion),
      streamAIMessageFn: streamFn,
      stopWebLLMGeneration: () => {},
      getWebLLMStatus: () => 'idle',
      refs,
      commitMessages,
      findMessageInUserChats: () => null,
      persistMessageSafe,
      setIsLoading,
      setPersistenceError
    });
  };

  const flushPersistence = async () => {
    await Promise.allSettled(persistPromises);
  };

  return {
    getMessages: () => refs.messagesRef.current,
    getIsLoading: () => isLoading,
    getIsSubmitting: () => refs.isSubmittingRef.current,
    getPersistenceError: () => persistenceError,
    refs,
    commitMessages,
    sendPrompt,
    stopGenerating,
    regenerateMessage,
    flushPersistence
  };
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runTests() {
  console.log('=== Starting Stop Response Lifecycle & Actions Regression Suite ===');

  const { db, messagesStore } = createMockDb();
  setMockDatabaseForTesting(db as any);
  setMockAuthVerifierForTesting(async (token: string) => {
    if (token === 'valid-stop-test-token') return TEST_USER;
    throw new Error('Unauthorized token');
  });

  // Start real Express server (including /api/conversations, /api/messages, and mock /test-sse)
  app.post('/api/test-sse-abort', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    // Emit multiple chunks in a single burst followed by delayed chunks
    res.write(
      [
        `data: ${JSON.stringify({ type: 'start', modelUsed: 'gemini-3.1-flash-lite', provider: 'gemini' })}\n\n`,
        `data: ${JSON.stringify({ type: 'chunk', text: 'First partial sentence. ' })}\n\n`
      ].join('')
    );

    const timer = setTimeout(() => {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type: 'chunk', text: 'SHOULD_NEVER_BE_APPENDED_AFTER_STOP' })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'done', text: 'First partial sentence. SHOULD_NEVER_BE_APPENDED_AFTER_STOP' })}\n\n`);
        res.end();
      }
    }, 80);

    req.on('close', () => {
      clearTimeout(timer);
    });
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  process.env.TEST_API_BASE = baseUrl;

  // Route relative /api/* fetches to our ephemeral test Express server
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (input: any, init?: any) => {
    if (typeof input === 'string' && input.startsWith('/')) {
      return origFetch(`${baseUrl}${input}`, init);
    }
    return origFetch(input, init);
  };

  let passed = 0;
  async function step(name: string, fn: () => Promise<void>) {
    try {
      await fn();
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (err) {
      console.error(`  ✗ FAILED: ${name}`);
      console.error(err);
      process.exitCode = 1;
      throw err;
    }
  }

  try {
    // -----------------------------------------------------------------------
    // 1. Mid-SSE-Stream Stop: Aborts stream, halts tokens, clears cursor, shows toolbar, saves to MongoDB
    // -----------------------------------------------------------------------
    const chat1Id = await createChatDocument(TEST_USER.uid, 'Stop Mid-Stream Test', 'general');
    const harness1 = createChatHarness(TEST_USER.uid, chat1Id);
    let stoppedMsg1Id = '';

    await step('1. Clicking Stop mid-stream immediately clears blinking cursor, restores toolbar, preserves partial text, and persists to MongoDB without error', async () => {
      let postAbortChunkCount = 0;

      const streamTask = harness1.sendPrompt(
        'Explain quantum computing in detail',
        async ({ onStart, onChunk, signal }) => {
          onStart?.({ modelUsed: 'gemini-3.1-flash-lite', provider: 'gemini' });
          onChunk?.('Quantum computing uses qubits ', 'Quantum computing uses qubits ');
          await delay(35); // Allow pumpAnimation to reveal partial text

          // Verify streaming UI state BEFORE Stop is clicked
          const streamingMsg = harness1.getMessages().find((m) => m.sender === 'assistant');
          assert.strictEqual(streamingMsg.isStreaming, true, 'Message must be streaming before Stop');
          const streamingHtml = renderMessageHtml(streamingMsg, true);
          assert.ok(
            streamingHtml.includes('is-streaming'),
            'Blue blinking cursor class (.is-streaming) must be active while streaming'
          );
          assert.ok(
            streamingHtml.includes('stop-generating-btn'),
            'Stop button must be rendered while streaming'
          );
          assert.ok(
            !streamingHtml.includes('regenerate-btn'),
            'Regenerate button must be hidden while streaming'
          );

          // Simulate user clicking Stop while stream is still open
          harness1.stopGenerating();

          // Attempt to push extra tokens after Stop — must be ignored!
          if (!signal?.aborted) {
            postAbortChunkCount++;
          }
          onChunk?.('EXTRA_POST_STOP_TOKENS', 'Quantum computing uses qubits EXTRA_POST_STOP_TOKENS');

          const abortErr = new Error('Aborted');
          abortErr.name = 'AbortError';
          throw abortErr;
        }
      );

      const { assistantMessageId } = await streamTask;
      stoppedMsg1Id = assistantMessageId;
      await harness1.flushPersistence();
      await delay(40); // Ensure no trailing animation timer fires

      assert.strictEqual(postAbortChunkCount, 0, 'AbortController signal must be aborted immediately on Stop');
      assert.strictEqual(harness1.getIsLoading(), false, 'isLoading must be cleared');
      assert.strictEqual(harness1.getIsSubmitting(), false, 'isSubmittingRef must be cleared');
      assert.strictEqual(harness1.getPersistenceError(), null, 'User stop must NOT set persistenceError');

      const stoppedMsg = harness1.getMessages().find((m) => m.id === assistantMessageId);
      assert.ok(stoppedMsg, 'Stopped assistant message must exist');
      assert.strictEqual(stoppedMsg.isStreaming, false, 'isStreaming must be false immediately after Stop');
      assert.strictEqual(stoppedMsg.isStopped, true, 'isStopped must be true');
      assert.strictEqual(stoppedMsg.isError, false, 'isError must be false (not classified as generation error)');
      assert.strictEqual(stoppedMsg.isInterrupted, false, 'isInterrupted error flag must be false');
      assert.strictEqual(stoppedMsg.requestStartTime, undefined, 'requestStartTime must be cleared');
      assert.ok(stoppedMsg.content.length > 0, 'Partial content must be preserved and non-empty');
      assert.ok(
        'Quantum computing uses qubits '.startsWith(stoppedMsg.content),
        `Partial content "${stoppedMsg.content}" must match revealed prefix without post-stop tokens`
      );
      assert.ok(
        !stoppedMsg.content.includes('EXTRA_POST_STOP_TOKENS'),
        'No tokens emitted after Stop may be appended'
      );

      // Verify rendered ChatMessage DOM markup after Stop
      const stoppedHtml = renderMessageHtml(stoppedMsg, false);
      assert.ok(
        !stoppedHtml.includes('is-streaming'),
        'Blue blinking streaming cursor (.is-streaming) must be completely removed after Stop'
      );
      assert.ok(
        !stoppedHtml.includes('streaming-code'),
        'Code block streaming cursor (.streaming-code) must not be present after Stop'
      );
      assert.ok(
        !stoppedHtml.includes('stop-generating-btn'),
        'Per-message Stop button must disappear after Stop'
      );
      assert.ok(
        stoppedHtml.includes('message-stopped-badge') && stoppedHtml.includes('Stopped'),
        'Stopped status badge must be rendered'
      );
      assert.ok(stoppedHtml.includes('Copy'), 'Copy action button must be restored');
      assert.ok(stoppedHtml.includes('Read aloud'), 'Read Aloud action button must be restored');
      assert.ok(stoppedHtml.includes('regenerate-btn') && stoppedHtml.includes('Regenerate'), 'Regenerate button must be restored');
      assert.ok(
        stoppedHtml.includes('Regenerate with another AI Model'),
        'Regenerate with another AI Model button must be restored'
      );
      assert.ok(
        !stoppedHtml.includes('error-message-box'),
        'Error banner must NOT appear for user-stopped response'
      );

      // Verify MongoDB persistence of partial stopped response
      const mongoDoc = Array.from(messagesStore.values()).find((d) => d.id === assistantMessageId);
      assert.ok(mongoDoc, 'Stopped partial response must be saved to MongoDB');
      assert.strictEqual(mongoDoc.content, stoppedMsg.content, 'MongoDB content must match preserved partial response');
      assert.strictEqual(mongoDoc.isStopped, true, 'MongoDB document must persist isStopped: true');
    });

    // -----------------------------------------------------------------------
    // 2. Post-Network Animation Backlog Stop (THE EXACT FAST-PROVIDER BUG!)
    // -----------------------------------------------------------------------
    await step('2. Clicking Stop AFTER fast network SSE finishes while progressive text animation is still revealing clears cursor & restores toolbar immediately', async () => {
      const longResponse =
        'Fast provider returned a 600-character markdown response in 50ms, while progressive reveal is still animating smoothly across multiple frames. '.repeat(
          5
        ) + '\n\n```js\nconst tail = "UNREVEALED_TAIL_MARKER";\n```';

      // Start prompt where streamAIMessage resolves almost immediately (~10ms),
      // leaving `executeStreamPromptSession` returned while `pumpAnimation` is still ticking!
      const { assistantMessageId } = await harness1.sendPrompt(
        'Give me a fast explanation',
        async ({ onStart, onChunk }) => {
          onStart?.({ modelUsed: 'openai/gpt-oss-120b', provider: 'groq' });
          onChunk?.(longResponse, longResponse);
          return {
            text: longResponse,
            modelUsed: 'openai/gpt-oss-120b',
            provider: 'groq'
          };
        },
        { provider: 'groq', prefersReducedMotion: false }
      );

      // Wait ~45ms so 2 animation frames have revealed a partial prefix, while network promise ALREADY resolved!
      await delay(45);

      const midAnimMsg = harness1.getMessages().find((m) => m.id === assistantMessageId);
      assert.strictEqual(midAnimMsg.isStreaming, true, 'Message must still be animating before Stop');
      assert.ok(
        midAnimMsg.content.length > 0 && midAnimMsg.content.length < longResponse.length,
        `Expected partial animated reveal (got ${midAnimMsg.content.length} of ${longResponse.length} chars)`
      );

      const frozenLengthAtStop = midAnimMsg.content.length;

      // Click Stop during post-network animation backlog!
      harness1.stopGenerating();
      await harness1.flushPersistence();

      // Wait 60ms to verify animation timer is completely dead and no further characters leak in
      await delay(60);

      const afterStopMsg = harness1.getMessages().find((m) => m.id === assistantMessageId);
      assert.strictEqual(afterStopMsg.isStreaming, false, 'isStreaming MUST be false after stopping post-network animation');
      assert.strictEqual(afterStopMsg.isStopped, true, 'isStopped MUST be true');
      assert.strictEqual(afterStopMsg.isError, false, 'isError MUST be false');
      assert.strictEqual(afterStopMsg.responseTimeMs, null, 'Provisional responseTimeMs must be cleared when stopped');
      assert.strictEqual(
        afterStopMsg.content.length,
        frozenLengthAtStop,
        'Zero further characters from buffered targetText may be appended after Stop'
      );
      assert.ok(
        !afterStopMsg.content.includes('UNREVEALED_TAIL_MARKER'),
        'Unrevealed tail tokens must not appear after Stop'
      );

      const html = renderMessageHtml(afterStopMsg, false);
      assert.ok(!html.includes('is-streaming'), 'Blinking cursor must be gone after post-network Stop');
      assert.ok(!html.includes('stop-generating-btn'), 'Stop button must be gone after post-network Stop');
      assert.ok(html.includes('regenerate-btn'), 'Regenerate button must be visible after post-network Stop');
      assert.ok(html.includes('Copy'), 'Copy button must be visible after post-network Stop');
      assert.ok(html.includes('Read aloud'), 'Read Aloud button must be visible after post-network Stop');
    });

    // -----------------------------------------------------------------------
    // 3. Refresh & Reopen Conversation from MongoDB & Local Cache
    // -----------------------------------------------------------------------
    await step('3. Refreshing and reopening conversation from MongoDB and local cache preserves stopped responses cleanly with no stuck cursor or Stop button', async () => {
      // Simulate fresh browser reload by clearing local cache first so loadConversationMessages fetches from MongoDB API
      mockStorage.clear();

      const reloadedFromMongo = await loadConversationMessages(TEST_USER.uid, chat1Id);
      assert.strictEqual(reloadedFromMongo.length, 4, 'Both user+stopped-assistant pairs must reload from MongoDB');

      for (const msg of reloadedFromMongo.filter((m: any) => m.sender === 'assistant')) {
        assert.strictEqual(msg.isStreaming, false, 'Reloaded message must have isStreaming: false');
        assert.strictEqual(msg.isStopped, true, 'Reloaded stopped message must preserve isStopped: true');
        assert.strictEqual(msg.isError, false, 'Reloaded stopped message must have isError: false');
        assert.ok(msg.content.length > 0, 'Reloaded partial content must be intact');

        const reloadedHtml = renderMessageHtml(msg, false);
        assert.ok(!reloadedHtml.includes('is-streaming'), 'Reloaded stopped message must not show blinking cursor');
        assert.ok(!reloadedHtml.includes('stop-generating-btn'), 'Reloaded stopped message must not show Stop button');
        assert.ok(reloadedHtml.includes('regenerate-btn'), 'Reloaded stopped message must show Regenerate button');
        assert.ok(reloadedHtml.includes('message-stopped-badge'), 'Reloaded stopped message must show Stopped badge');
      }

      // Also verify stale `isStreaming: true` in local storage is stripped by `ensureConversationAlternatives`
      const corruptedLocal = ensureConversationAlternatives([
        { id: 'u-1', sender: 'user', content: 'Hi' },
        { id: 'a-1', sender: 'assistant', content: 'Partial...', isStreaming: true, isStopped: true, requestStartTime: 12345 }
      ]);
      assert.strictEqual(corruptedLocal[1].isStreaming, false, 'Hydration must strip stale isStreaming: true');
      assert.strictEqual(corruptedLocal[1].requestStartTime, undefined, 'Hydration must strip requestStartTime');
      assert.strictEqual(corruptedLocal[1].isStopped, true, 'Hydration must preserve isStopped: true');
    });

    // -----------------------------------------------------------------------
    // 4. Regenerate on a Stopped Response
    // -----------------------------------------------------------------------
    await step('4. Regenerate on a stopped response regenerates that exact message in-place, clears isStopped, and updates MongoDB', async () => {
      const targetStopped = harness1.getMessages().find((m) => m.id === stoppedMsg1Id);
      assert.ok(targetStopped && targetStopped.isStopped, 'Target message must start in stopped state');
      const countBefore = harness1.getMessages().length;

      await harness1.regenerateMessage(
        targetStopped,
        async ({ prompt, onStart, onChunk }) => {
          assert.strictEqual(
            prompt,
            'Explain quantum computing in detail',
            'Regenerate must reuse the exact parent user prompt of the stopped response'
          );
          onStart?.({ modelUsed: 'gemini-3.1-flash-lite', provider: 'gemini' });
          const fullText = 'Complete regenerated explanation of quantum computing with superposition and entanglement.';
          onChunk?.(fullText, fullText);
          return {
            text: fullText,
            modelUsed: 'gemini-3.1-flash-lite',
            provider: 'gemini'
          };
        },
        { prefersReducedMotion: true }
      );

      await harness1.flushPersistence();

      assert.strictEqual(harness1.getMessages().length, countBefore, 'Regenerate must update message in-place without duplicating');
      const regeneratedMsg = harness1.getMessages().find((m) => m.id === stoppedMsg1Id);
      assert.strictEqual(regeneratedMsg.isStreaming, false, 'Regenerated message must finish streaming');
      assert.strictEqual(regeneratedMsg.isStopped, false, 'Regenerated message must clear isStopped: false');
      assert.strictEqual(regeneratedMsg.isError, false, 'Regenerated message must have isError: false');
      assert.strictEqual(
        regeneratedMsg.content,
        'Complete regenerated explanation of quantum computing with superposition and entanglement.'
      );
      assert.strictEqual(typeof regeneratedMsg.responseTimeMs, 'number', 'Completed regenerated message must record responseTimeMs');

      const regenHtml = renderMessageHtml(regeneratedMsg, false);
      assert.ok(!regenHtml.includes('message-stopped-badge'), 'Stopped badge must be removed once regenerated');
      assert.ok(!regenHtml.includes('is-streaming'), 'No blinking cursor after regeneration completes');
      assert.ok(regenHtml.includes('regenerate-btn'), 'Toolbar remains active');

      // Verify MongoDB updated in place
      const updatedMongoDoc = Array.from(messagesStore.values()).find((d) => d.id === stoppedMsg1Id);
      assert.strictEqual(updatedMongoDoc.isStopped, false, 'MongoDB must reflect cleared isStopped: false after Regenerate');
      assert.strictEqual(updatedMongoDoc.content, regeneratedMsg.content);
    });

    // -----------------------------------------------------------------------
    // 5. Real `aiRouter.js` SSE Abort Verification
    // -----------------------------------------------------------------------
    await step('5. aiRouter.streamAIMessage immediately stops emitting SSE chunks and throws AbortError when aborted', async () => {
      // Point /api/chat temporarily to /api/test-sse-abort to exercise aiRouter's actual ReadableStream SSE loop
      const prevFetch = globalThis.fetch;
      globalThis.fetch = async (input: any, init?: any) => {
        if (typeof input === 'string' && input === '/api/chat') {
          return origFetch(`${baseUrl}/api/test-sse-abort`, init);
        }
        return prevFetch(input, init);
      };

      const abortController = new AbortController();
      const receivedChunks: string[] = [];

      try {
        let threwAbort = false;
        try {
          await (streamAIMessage as any)({
            provider: 'gemini',
            prompt: 'Test SSE abort',
            history: [],
            signal: abortController.signal,
            onStart: () => {},
            onChunk: (chunk: string) => {
              receivedChunks.push(chunk);
              // Immediately abort upon first chunk!
              abortController.abort();
            }
          });
        } catch (err: any) {
          threwAbort = err?.name === 'AbortError' || abortController.signal.aborted;
        }

        await delay(110); // Wait longer than server's 80ms second chunk timer
        assert.strictEqual(threwAbort, true, 'streamAIMessage must reject with AbortError when signal aborts');
        assert.deepStrictEqual(
          receivedChunks,
          ['First partial sentence. '],
          'Zero chunks may be delivered after abortController.abort()'
        );
      } finally {
        globalThis.fetch = prevFetch;
      }
    });

    // -----------------------------------------------------------------------
    // 6. Immediate New Prompt After Stop (Stale Callback Isolation)
    // -----------------------------------------------------------------------
    await step('6. Starting a new prompt immediately after Stop isolates Stream #2 from Stream #1 stale abort/completion callbacks', async () => {
      const chat2Id = await createChatDocument(TEST_USER.uid, 'Concurrency Race Test', 'general');
      const harness2 = createChatHarness(TEST_USER.uid, chat2Id);

      let resolveDelayedAbortOfStream1!: () => void;
      const stream1Gate = new Promise<void>((r) => {
        resolveDelayedAbortOfStream1 = r;
      });

      // Launch Stream #1 whose underlying promise takes extra time to settle EVEN AFTER abort!
      const stream1Promise = harness2.sendPrompt(
        'First slow prompt',
        async ({ onStart, onChunk }) => {
          onStart?.({ modelUsed: 'gemini-3.1-flash-lite', provider: 'gemini' });
          onChunk?.('Stream 1 partial', 'Stream 1 partial');
          await stream1Gate; // Simulates delayed network rejection arriving later during Stream #2!
          const err = new Error('Late AbortError from Stream 1');
          err.name = 'AbortError';
          throw err;
        },
        { prefersReducedMotion: true }
      );

      await delay(25);
      // User clicks Stop on Stream #1
      harness2.stopGenerating();
      assert.strictEqual(harness2.getIsLoading(), false, 'isLoading cleared right after Stop');
      assert.strictEqual(harness2.getIsSubmitting(), false, 'isSubmitting cleared right after Stop');

      // User IMMEDIATELY starts Stream #2 BEFORE Stream #1's promise settles!
      let finishStream2!: () => void;
      const stream2Gate = new Promise<void>((r) => {
        finishStream2 = r;
      });

      const stream2Promise = harness2.sendPrompt(
        'Second prompt right after Stop',
        async ({ onStart, onChunk }) => {
          onStart?.({ modelUsed: 'gemini-3.1-flash-lite', provider: 'gemini' });
          onChunk?.('Stream 2 active text...', 'Stream 2 active text...');
          await stream2Gate;
          const final2 = 'Stream 2 active text... completed cleanly!';
          onChunk?.(' completed cleanly!', final2);
          return {
            text: final2,
            modelUsed: 'gemini-3.1-flash-lite',
            provider: 'gemini'
          };
        },
        { prefersReducedMotion: true }
      );

      await delay(25);
      assert.strictEqual(harness2.getIsLoading(), true, 'Stream #2 must have isLoading === true');
      assert.strictEqual(harness2.getIsSubmitting(), true, 'Stream #2 must have isSubmitting === true');

      // NOW fire Stream #1's stale delayed abort callback WHILE Stream #2 is actively streaming!
      resolveDelayedAbortOfStream1();
      await stream1Promise;
      await delay(20);

      // Verify Stream #2 was NOT clobbered by Stream #1's late settlement!
      assert.strictEqual(
        harness2.getIsLoading(),
        true,
        'Stale callback from Stream #1 MUST NOT clear Stream #2 isLoading state'
      );
      assert.strictEqual(
        harness2.getIsSubmitting(),
        true,
        'Stale callback from Stream #1 MUST NOT clear Stream #2 isSubmitting state'
      );

      // Complete Stream #2 normally
      finishStream2();
      const { assistantMessageId: msg2Id } = await stream2Promise;
      await harness2.flushPersistence();

      assert.strictEqual(harness2.getIsLoading(), false, 'isLoading clears once Stream #2 finishes');
      const allMsgs = harness2.getMessages().filter((m) => m.sender === 'assistant');
      assert.strictEqual(allMsgs.length, 2);
      assert.strictEqual(allMsgs[0].isStopped, true, 'Message #1 remains marked isStopped: true');
      assert.strictEqual(allMsgs[0].isStreaming, false, 'Message #1 has isStreaming: false');
      assert.strictEqual(allMsgs[0].content, 'Stream 1 partial');

      const msg2 = harness2.getMessages().find((m) => m.id === msg2Id);
      assert.strictEqual(msg2.isStopped, false, 'Message #2 completed normally (isStopped: false)');
      assert.strictEqual(msg2.isStreaming, false, 'Message #2 has isStreaming: false');
      assert.strictEqual(msg2.content, 'Stream 2 active text... completed cleanly!');
    });

    // -----------------------------------------------------------------------
    // 7. Alternative Switching & Genuine Provider Error Regressions
    // -----------------------------------------------------------------------
    await step('7. Alternative switching projects per-alternative isStopped accurately, and genuine provider errors still display error recovery UI', async () => {
      // Check alternative switching between a stopped alternative and a completed alternative
      const baseStopped: any = normalizeAssistantMessage({
        id: 'alt-switch-msg',
        sender: 'assistant',
        content: 'Stopped Gemini draft',
        provider: 'gemini',
        modelUsed: 'gemini-3.1-flash-lite',
        isStopped: true,
        isStreaming: false
      });
      const firstAltId = baseStopped.activeAlternativeId;
      const withSecondCompleted: any = addAlternativeToAssistantMessage(
        baseStopped,
        (createAlternativeRecord as any)({
          provider: 'groq',
          modelUsed: 'openai/gpt-oss-120b',
          content: 'Completed Groq response',
          responseTimeMs: 310,
          isStopped: false,
          isError: false
        })
      );
      const secondAltId = withSecondCompleted.activeAlternativeId;

      assert.strictEqual(withSecondCompleted.isStopped, false, 'Newly added completed alternative clears root isStopped');
      const switchedBack: any = switchActiveAlternativeInMessage(withSecondCompleted, firstAltId);
      assert.strictEqual(switchedBack.isStopped, true, 'Switching back to stopped alternative restores isStopped: true');
      assert.strictEqual(switchedBack.isStreaming, false);

      const switchedForward: any = switchActiveAlternativeInMessage(switchedBack, secondAltId);
      assert.strictEqual(switchedForward.isStopped, false, 'Switching to completed alternative sets isStopped: false');
      assert.strictEqual(switchedForward.responseTimeMs, 310);

      // Verify genuine provider error (non-abort) still marks isError: true and shows error box
      const chatErrId = await createChatDocument(TEST_USER.uid, 'Genuine Error Test', 'general');
      const errHarness = createChatHarness(TEST_USER.uid, chatErrId);
      const { assistantMessageId: errMsgId } = await errHarness.sendPrompt(
        'Trigger 429 error',
        async () => {
          const err: any = new Error('Rate limit exceeded');
          err.code = 429;
          err.status = 'RESOURCE_EXHAUSTED';
          err.provider = 'gemini';
          throw err;
        },
        { prefersReducedMotion: true }
      );

      const errMsg = errHarness.getMessages().find((m) => m.id === errMsgId);
      assert.strictEqual(errMsg.isError, true, 'Genuine provider failure must still set isError: true');
      assert.strictEqual(errMsg.isStopped, false, 'Genuine provider failure must NOT set isStopped: true');
      assert.strictEqual(errMsg.isStreaming, false, 'Genuine provider failure must clear isStreaming: false');
      const errHtml = renderMessageHtml(errMsg, false);
      assert.ok(errHtml.includes('error-message-box'), 'Genuine provider failure must render error recovery UI');
    });

    // -----------------------------------------------------------------------
    // 8. Guest Mode & Offline Mode Stop Persistence Compatibility
    // -----------------------------------------------------------------------
    await step('8. Stopping in Guest mode and Offline mode preserves partial stopped state without errors or stuck streaming flags', async () => {
      // 8A: Guest user (`guest-...`) stops generation -> local state + reload hydration preserves isStopped: true, isStreaming: false
      const guestHarness = createChatHarness('guest-session-123', 'guest-chat-1');
      const guestStreamPromise = guestHarness.sendPrompt(
        'Guest stop test',
        async ({ onStart, onChunk, signal }) => {
          onStart?.({ modelUsed: 'gemini-3.1-flash-lite', provider: 'gemini' });
          onChunk?.('Guest partial output', 'Guest partial output');
          await new Promise<void>((_, reject) => {
            signal?.addEventListener(
              'abort',
              () => {
                const e = new Error('Aborted');
                e.name = 'AbortError';
                reject(e);
              },
              { once: true }
            );
          });
          return { text: '', modelUsed: 'gemini-3.1-flash-lite', provider: 'gemini' };
        },
        { prefersReducedMotion: true }
      );

      await delay(25);
      guestHarness.stopGenerating();
      const { assistantMessageId: guestMsgId } = await guestStreamPromise;
      await guestHarness.flushPersistence();

      assert.strictEqual(guestHarness.getPersistenceError(), null, 'Guest stop must not trigger persistenceError');
      const guestMsg = guestHarness.getMessages().find((m) => m.id === guestMsgId);
      assert.strictEqual(guestMsg.isStreaming, false);
      assert.strictEqual(guestMsg.isStopped, true);
      assert.strictEqual(guestMsg.isError, false);
      assert.strictEqual(guestMsg.content, 'Guest partial output');

      // Simulate guest localStorage reload hydration
      const hydratedGuest = ensureConversationAlternatives(JSON.parse(JSON.stringify(guestHarness.getMessages())));
      const hydratedGuestAssistant = hydratedGuest.find((m: any) => m.id === guestMsgId);
      assert.strictEqual(hydratedGuestAssistant.isStreaming, false);
      assert.strictEqual(hydratedGuestAssistant.isStopped, true);

      // 8B: Authenticated user goes offline right before clicking Stop -> queued cleanly without breaking UI state
      const offlineChatId = await createChatDocument(TEST_USER.uid, 'Offline Stop Test', 'general');
      const offlineHarness = createChatHarness(TEST_USER.uid, offlineChatId);
      (globalThis.navigator as any).onLine = false;
      try {
        const offlineStreamPromise = offlineHarness.sendPrompt(
          'Offline stop prompt',
          async ({ onStart, onChunk, signal }) => {
            onStart?.({ modelUsed: 'gemini-3.1-flash-lite', provider: 'gemini' });
            onChunk?.('Offline stopped partial', 'Offline stopped partial');
            await new Promise<void>((_, reject) => {
              signal?.addEventListener(
                'abort',
                () => {
                  const e = new Error('Aborted');
                  e.name = 'AbortError';
                  reject(e);
                },
                { once: true }
              );
            });
            return { text: '', modelUsed: 'gemini-3.1-flash-lite', provider: 'gemini' };
          },
          { prefersReducedMotion: true }
        );

        await delay(25);
        offlineHarness.stopGenerating();
        const { assistantMessageId: offlineMsgId } = await offlineStreamPromise;
        await offlineHarness.flushPersistence();

        assert.strictEqual(offlineHarness.getPersistenceError(), null, 'Offline stop must queue cleanly without persistenceError');
        const offlineMsg = offlineHarness.getMessages().find((m) => m.id === offlineMsgId);
        assert.strictEqual(offlineMsg.isStreaming, false);
        assert.strictEqual(offlineMsg.isStopped, true);
        assert.strictEqual(offlineMsg.isError, false);
        assert.strictEqual(offlineMsg.content, 'Offline stopped partial');
      } finally {
        (globalThis.navigator as any).onLine = true;
      }
    });

    console.log(`\n=== ALL ${passed} STOP LIFECYCLE & RESPONSE ACTION TESTS PASSED ===`);
  } finally {
    delete process.env.TEST_API_BASE;
    globalThis.fetch = origFetch;
    resetFirebaseAdminForTesting();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

runTests().catch((err) => {
  console.error('Stop lifecycle test suite failed:', err);
  process.exit(1);
});
