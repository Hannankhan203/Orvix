/**
 * Focused Regression Test Suite for:
 * - ORVIX-AUD-039: IndexedDB Vector Database Recovery (semanticVectorStorage.js)
 * - ORVIX-AUD-040: Chat Route Registration (server/chatSubsystem.ts & api/chat.ts)
 * - ORVIX-AUD-041: API Configuration Error Handling (server.ts & api/config.ts)
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

import {
  getVectorDB,
  storeDocumentChunks,
  getChunksForDocuments,
  resetVectorDBForTesting
} from '../src/services/semanticVectorStorage.js';
import { registerChatRoutes } from '../server/chatSubsystem.ts';
import { setForceConfigStatusErrorForTesting } from '../server/serverConfig.ts';
import {
  fetchProviderConfig,
  resetCachedProviderConfig
} from '../src/services/aiRouter.js';
import { getProviderConfigAvailability } from '../src/services/providerModelSanitizer.js';

let passed = 0;
let failed = 0;

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`  PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL: ${name}`);
    console.error(`    ${err?.stack || err}`);
    failed++;
  }
}

function createFakeStore(backingMap) {
  return {
    put(record) {
      backingMap.set(record.id, record);
    },
    getAll() {
      const req = { result: Array.from(backingMap.values()), onsuccess: null, onerror: null };
      queueMicrotask(() => req.onsuccess?.({ target: req }));
      return req;
    },
    index(indexName) {
      return {
        getAll(key) {
          const matches = Array.from(backingMap.values()).filter((r) => r?.[indexName] === key);
          const req = { result: matches, onsuccess: null, onerror: null };
          queueMicrotask(() => req.onsuccess?.({ target: req }));
          return req;
        }
      };
    }
  };
}

function createFakeDB(backingMap, { name = 'mock-db' } = {}) {
  const listeners = new Map();
  const objectStoreNames = new Set(['vector_chunks']);
  const db = {
    name,
    closed: false,
    objectStoreNames: {
      contains: (n) => objectStoreNames.has(n)
    },
    createObjectStore(n) {
      objectStoreNames.add(n);
      return { createIndex() {} };
    },
    transaction() {
      const store = createFakeStore(backingMap);
      const tx = {
        oncomplete: null,
        onerror: null,
        onabort: null,
        objectStore: () => store
      };
      queueMicrotask(() => tx.oncomplete?.());
      return tx;
    },
    addEventListener(evt, fn) {
      if (!listeners.has(evt)) listeners.set(evt, []);
      listeners.get(evt).push(fn);
    },
    emit(evt) {
      for (const fn of listeners.get(evt) || []) fn();
    },
    close() {
      db.closed = true;
    }
  };
  return db;
}

console.log('======================================================================');
console.log('Orvix Regression Suite: ORVIX-AUD-039 through ORVIX-AUD-041');
console.log('======================================================================\n');

// ===========================================================================
// 1. ORVIX-AUD-039: IndexedDB Vector Database Recovery
// ===========================================================================
console.log('--- 1. ORVIX-AUD-039: IndexedDB Vector Database Recovery ---');

await runTest('1.1 Async IndexedDB open error is NOT cached and recovers on subsequent retry', async () => {
  const origIndexedDB = globalThis.indexedDB;
  resetVectorDBForTesting();

  const backing = new Map();
  let openAttempts = 0;
  let mode = 'async-error';

  globalThis.indexedDB = {
    open() {
      openAttempts++;
      const req = { onupgradeneeded: null, onsuccess: null, onerror: null };
      queueMicrotask(() => {
        if (mode === 'async-error') {
          req.error = new Error('Transient IDB open failure');
          req.onerror?.({ target: req });
        } else {
          const db = createFakeDB(backing, { name: `recovered-${openAttempts}` });
          req.onsuccess?.({ target: { result: db } });
        }
      });
      return req;
    }
  };

  try {
    // Attempt 1: fails transiently
    const first = await getVectorDB();
    assert.strictEqual(first, null, 'Failed IDB open must return null for memory fallback');
    assert.strictEqual(openAttempts, 1);

    // Attempt 2: IDB recovers -> must retry open instead of returning cached null
    mode = 'success';
    const second = await getVectorDB();
    assert.ok(second && second.name === 'recovered-2', 'Subsequent retry must reopen IDB and succeed');
    assert.strictEqual(openAttempts, 2);

    // Attempt 3: cached live DB must be reused without another open()
    const third = await getVectorDB();
    assert.strictEqual(third, second, 'Live DB promise must remain cached');
    assert.strictEqual(openAttempts, 2);
  } finally {
    resetVectorDBForTesting();
    globalThis.indexedDB = origIndexedDB;
  }
});

await runTest('1.2 Synchronous exception in idb.open clears cache and concurrent callers deduplicate open()', async () => {
  const origIndexedDB = globalThis.indexedDB;
  resetVectorDBForTesting();

  const backing = new Map();
  let openAttempts = 0;
  let mode = 'sync-throw';
  let pendingCallbacks = [];

  globalThis.indexedDB = {
    open() {
      openAttempts++;
      if (mode === 'sync-throw') {
        throw new Error('Blocked IndexedDB');
      }
      const req = { onupgradeneeded: null, onsuccess: null, onerror: null };
      pendingCallbacks.push(req);
      return req;
    }
  };

  try {
    // Sync throw resolves null and allows immediate retry
    const syncFail = await getVectorDB();
    assert.strictEqual(syncFail, null);
    assert.strictEqual(openAttempts, 1);

    // Concurrent calls while open is pending must call idb.open only ONCE
    mode = 'manual';
    const p1 = getVectorDB();
    const p2 = getVectorDB();
    const p3 = getVectorDB();
    assert.strictEqual(p1, p2, 'Concurrent callers must share the exact same promise');
    assert.strictEqual(p2, p3, 'Concurrent callers must share the exact same promise');
    assert.strictEqual(openAttempts, 2, 'Concurrent initialization must only invoke idb.open once');

    // Trigger failure on the shared in-flight request
    pendingCallbacks.shift().onerror?.(new Error('Second transient error'));
    const failedBatch = await Promise.all([p1, p2, p3]);
    assert.deepEqual(failedBatch, [null, null, null]);

    // Now another concurrent batch retries and succeeds
    const r1 = getVectorDB();
    const r2 = getVectorDB();
    assert.strictEqual(openAttempts, 3, 'Retry after failed batch must invoke idb.open again once');
    const liveDb = createFakeDB(backing, { name: 'recovered-batch' });
    pendingCallbacks.shift().onsuccess?.({ target: { result: liveDb } });

    const [d1, d2] = await Promise.all([r1, r2]);
    assert.strictEqual(d1, liveDb);
    assert.strictEqual(d2, liveDb);

    // Simulate DB unexpected close -> next call reopens cleanly
    liveDb.emit('close');
    const r3 = getVectorDB();
    assert.strictEqual(openAttempts, 4, 'Closing cached DB must allow safe reopen');
    const reopenedDb = createFakeDB(backing, { name: 'reopened-after-close' });
    pendingCallbacks.shift().onsuccess?.({ target: { result: reopenedDb } });
    assert.strictEqual(await r3, reopenedDb);
  } finally {
    resetVectorDBForTesting();
    globalThis.indexedDB = origIndexedDB;
  }
});

await runTest('1.3 Fallback memory store and recovered IndexedDB remain consistent across store/retrieve', async () => {
  const origIndexedDB = globalThis.indexedDB;
  resetVectorDBForTesting();

  const backing = new Map();
  let shouldFail = true;

  globalThis.indexedDB = {
    open() {
      const req = { onupgradeneeded: null, onsuccess: null, onerror: null };
      queueMicrotask(() => {
        if (shouldFail) {
          req.onerror?.(new Error('Temporary IDB failure'));
        } else {
          req.onsuccess?.({ target: { result: createFakeDB(backing) } });
        }
      });
      return req;
    }
  };

  try {
    // Store during IDB failure -> succeeds via memoryVectorStore fallback
    const storedFallback = await storeDocumentChunks(
      'doc-mem',
      [{ id: 'c1', docId: 'doc-mem', text: 'fallback chunk', embedding: [1, 0] }],
      'conv-1'
    );
    assert.strictEqual(storedFallback, true);
    const readFallback = await getChunksForDocuments(['doc-mem']);
    assert.strictEqual(readFallback.length, 1);
    assert.strictEqual(readFallback[0].text, 'fallback chunk');

    // Now IDB recovers -> new store persists into IndexedDB
    shouldFail = false;
    const storedRecovered = await storeDocumentChunks(
      'doc-idb',
      [{ id: 'c2', docId: 'doc-idb', text: 'recovered chunk', embedding: [0, 1] }],
      'conv-1'
    );
    assert.strictEqual(storedRecovered, true);
    assert.strictEqual(backing.has('c2'), true, 'Recovered IDB must persist newly stored chunks');
    const readRecovered = await getChunksForDocuments(['doc-idb']);
    assert.strictEqual(readRecovered.length, 1);
    assert.strictEqual(readRecovered[0].text, 'recovered chunk');
  } finally {
    resetVectorDBForTesting();
    globalThis.indexedDB = origIndexedDB;
  }
});

// ===========================================================================
// 2. ORVIX-AUD-040: Chat Route Registration
// ===========================================================================
console.log('\n--- 2. ORVIX-AUD-040: Chat Route Registration ---');

await runTest('2.1 registerChatRoutes exposes POST /api/chat and POST /chat without shadowing POST /', async () => {
  const app = express();
  app.use(express.json());
  registerChatRoutes(app);

  // Downstream route on POST / to prove registerChatRoutes does not shadow root '/'
  app.post('/', (_req, res) => {
    res.status(200).json({ rootHandled: true });
  });

  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    // POST / must reach the downstream root handler (not intercepted by chat prompt validation)
    const rootRes = await fetch(`${baseUrl}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.strictEqual(rootRes.status, 200);
    assert.deepEqual(await rootRes.json(), { rootHandled: true });

    // POST /api/chat still hits chat route and validates prompt
    const apiChatRes = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.strictEqual(apiChatRes.status, 400);
    assert.deepEqual(await apiChatRes.json(), { error: 'Prompt is required.' });

    // POST /chat still hits chat route and validates prompt
    const chatRes = await fetch(`${baseUrl}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.strictEqual(chatRes.status, 400);
    assert.deepEqual(await chatRes.json(), { error: 'Prompt is required.' });
  } finally {
    await new Promise((r) => server.close(r));
  }
});

await runTest('2.2 server.ts does not shadow POST / while Vercel api/chat.ts handler preserves root rewrite', async () => {
  process.env.TESTING = '1';
  const { app: mainApp } = await import('../server.ts');
  const { default: vercelChatHandler } = await import('../api/chat.ts');

  const mainServer = http.createServer(mainApp);
  const vercelServer = http.createServer((req, res) => vercelChatHandler(req, res));

  await Promise.all([
    new Promise((r) => mainServer.listen(0, '127.0.0.1', r)),
    new Promise((r) => vercelServer.listen(0, '127.0.0.1', r))
  ]);

  const mainBase = `http://127.0.0.1:${mainServer.address().port}`;
  const vercelBase = `http://127.0.0.1:${vercelServer.address().port}`;

  try {
    // On main server, POST / must NOT return chat's 400 "Prompt is required."
    const mainRootPost = await fetch(`${mainBase}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.notStrictEqual(mainRootPost.status, 400, 'Main server POST / must not invoke chat route');

    // On main server, POST /api/chat still invokes chat route
    const mainApiChatPost = await fetch(`${mainBase}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.strictEqual(mainApiChatPost.status, 400);
    assert.deepEqual(await mainApiChatPost.json(), { error: 'Prompt is required.' });

    // On Vercel api/chat.ts entrypoint, '/' is rewritten to '/api/chat' and still works
    const vercelRootPost = await fetch(`${vercelBase}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.strictEqual(vercelRootPost.status, 400);
    assert.deepEqual(await vercelRootPost.json(), { error: 'Prompt is required.' });
  } finally {
    await Promise.all([
      new Promise((r) => mainServer.close(r)),
      new Promise((r) => vercelServer.close(r))
    ]);
  }
});

// ===========================================================================
// 3. ORVIX-AUD-041: API Configuration Error Handling
// ===========================================================================
console.log('\n--- 3. ORVIX-AUD-041: API Configuration Error Handling ---');

await runTest('3.1 GET /api/config returns 200 shape on success and safe HTTP 500 error (no all-false 200, no secrets/stacks) on failure', async () => {
  process.env.TESTING = '1';
  const { app: mainApp } = await import('../server.ts');
  const { default: vercelConfigHandler } = await import('../api/config.ts');

  const mainServer = http.createServer(mainApp);
  const vercelServer = http.createServer((req, res) => vercelConfigHandler(req, res));

  await Promise.all([
    new Promise((r) => mainServer.listen(0, '127.0.0.1', r)),
    new Promise((r) => vercelServer.listen(0, '127.0.0.1', r))
  ]);

  const mainBase = `http://127.0.0.1:${mainServer.address().port}`;
  const vercelBase = `http://127.0.0.1:${vercelServer.address().port}`;

  try {
    // 1. Success baseline on both servers
    setForceConfigStatusErrorForTesting(null);
    for (const url of [`${mainBase}/api/config`, `${mainBase}/config`, `${vercelBase}/api/config`]) {
      const okRes = await fetch(url);
      assert.strictEqual(okRes.status, 200, `Expected 200 for ${url}`);
      assert.ok(okRes.headers.get('cache-control')?.includes('no-store'));
      const okBody = await okRes.json();
      assert.strictEqual(typeof okBody.geminiConfigured, 'boolean');
      assert.strictEqual(typeof okBody.groqConfigured, 'boolean');
      assert.strictEqual(typeof okBody.openrouterConfigured, 'boolean');
      assert.strictEqual(typeof okBody.cloudflareConfigured, 'boolean');
      assert.strictEqual(typeof okBody.supabaseConfigured, 'boolean');
      assert.strictEqual(okBody.webllmSupported, true);
    }

    // 2. Simulate internal config resolution error containing sensitive token/stack
    const secretSentinel = 'AIzaSySecretKeyShouldNeverAppearInResponse12345';
    setForceConfigStatusErrorForTesting(
      new Error(`Internal resolver boom GEMINI_API_KEY=${secretSentinel}`)
    );

    for (const url of [`${mainBase}/api/config`, `${mainBase}/config`, `${vercelBase}/api/config`]) {
      const errRes = await fetch(url);
      assert.strictEqual(errRes.status, 500, `${url} must return HTTP 500 on internal config error`);
      assert.ok(errRes.headers.get('cache-control')?.includes('no-store'));
      const rawText = await errRes.text();
      assert.strictEqual(rawText.includes(secretSentinel), false, 'Must NEVER leak secrets');
      assert.strictEqual(rawText.includes('Internal resolver boom'), false, 'Must NEVER leak raw error details');
      assert.strictEqual(rawText.includes('at '), false, 'Must NEVER leak stack traces');

      const errBody = JSON.parse(rawText);
      assert.strictEqual(errBody.code, 500);
      assert.strictEqual(errBody.status, 'INTERNAL_CONFIG_ERROR');
      assert.strictEqual(typeof errBody.error, 'string');
      assert.strictEqual(errBody.geminiConfigured, undefined, 'Must NOT return all-false provider flags');
      assert.strictEqual(errBody.groqConfigured, undefined, 'Must NOT return all-false provider flags');
    }

    // 3. Verify frontend fetchProviderConfig treats HTTP 500 as 'error' and 'unknown' availability
    const origFetch = globalThis.fetch;
    resetCachedProviderConfig();
    try {
      globalThis.fetch = (input, init) => {
        const target = typeof input === 'string' && input.startsWith('/') ? `${mainBase}${input}` : input;
        return origFetch(target, init);
      };
      const snapshot = await fetchProviderConfig({ forceRefresh: true });
      assert.strictEqual(snapshot.status, 'error');
      assert.strictEqual(
        getProviderConfigAvailability('gemini', snapshot).state,
        'unknown',
        'HTTP 500 from /api/config must map to unknown, never falsely unconfigured'
      );
    } finally {
      globalThis.fetch = origFetch;
      resetCachedProviderConfig();
    }

    // 4. Verify outer catch in api/config.ts handler returns safe 500 JSON on raw Node ServerResponse
    const headersMap = new Map();
    let endedBody = '';
    const mockReq = {
      headers: {},
      get url() {
        throw new Error('Malformed request URL property');
      }
    };
    const mockRes = {
      statusCode: 200,
      headersSent: false,
      setHeader(k, v) {
        headersMap.set(k.toLowerCase(), v);
      },
      end(chunk) {
        endedBody = String(chunk || '');
      }
    };
    vercelConfigHandler(mockReq, mockRes);
    assert.strictEqual(mockRes.statusCode, 500);
    const parsedOuter = JSON.parse(endedBody);
    assert.strictEqual(parsedOuter.code, 500);
    assert.strictEqual(parsedOuter.status, 'INTERNAL_CONFIG_ERROR');
    assert.strictEqual(parsedOuter.geminiConfigured, undefined);
  } finally {
    setForceConfigStatusErrorForTesting(null);
    await Promise.all([
      new Promise((r) => mainServer.close(r)),
      new Promise((r) => vercelServer.close(r))
    ]);
  }
});

// ===========================================================================
// Summary
// ===========================================================================
console.log('\n======================================================================');
console.log(`Audit 039-041 Regression Summary: ${passed} passed, ${failed} failed.`);
console.log('======================================================================');

if (failed > 0) {
  process.exit(1);
}
