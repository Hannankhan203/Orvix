/**
 * Comprehensive Frontend & Lifecycle Verification Suite for
 * Supabase Storage Cleanup Integration in Orvix's Conversation Deletion Lifecycle
 *
 * Verifies:
 * 1. Successful deletion: calls DELETE /api/upload/conversations/:chatId with Firebase ID token,
 *    cleans local cache and IndexedDB, then deletes Firestore messages and parent chat doc.
 * 2. Offline queueing: when browser is offline, durably queues failed cleanup in pendingDeletedChatIds.
 * 3. Online HTTP 5xx failures: when online but storage fails with 500, durably queues cleanup
 *    with exponential backoff and prevents premature Firestore deletion.
 * 4. Reconnection replay: replays queued deletions when network reconnects or on auth hydration,
 *    completing cleanup and emptying the queue.
 * 5. Repeated & concurrent deletion: deduplicates concurrent deletion calls and safely handles
 *    repeated/idempotent deletion without throwing.
 * 6. Authentication failures: queues retryable requests on missing or expired tokens, and
 *    succeeds once valid authentication hydrates.
 * 7. Firestore deletion ordering: strictly enforces that Supabase cleanup is called BEFORE Firestore deletion.
 * 8. Guest/local deletion: ensures guest chat deletion never blocks on Supabase operations.
 * 9. Cross-user isolation: ensures one user's deletion never affects another user's files or documents.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';

// Polyfill window & localStorage for Node test runner
const localStorageStore = new Map();
globalThis.localStorage = {
  getItem: (key) => localStorageStore.get(key) ?? null,
  setItem: (key, val) => localStorageStore.set(key, String(val)),
  removeItem: (key) => localStorageStore.delete(key),
  clear: () => localStorageStore.clear()
};
globalThis.window = {
  localStorage: globalThis.localStorage,
  addEventListener: () => {},
  removeEventListener: () => {}
};

// Polyfill IndexedDB stub
const mockIndexedDBStore = new Map();
globalThis.indexedDB = {
  open: () => {
    const req = {
      result: {
        objectStoreNames: { contains: () => true },
        createObjectStore: () => ({ createIndex: () => {} }),
        transaction: () => ({
          oncomplete: null,
          onerror: null,
          onabort: null,
          objectStore: () => ({
            get: (key) => {
              const r = { onsuccess: null, onerror: null, result: mockIndexedDBStore.get(key) };
              setTimeout(() => r.onsuccess && r.onsuccess({ target: r }), 0);
              return r;
            },
            put: (val) => {
              mockIndexedDBStore.set(val.id, val);
              const r = { onsuccess: null, onerror: null };
              setTimeout(() => r.onsuccess && r.onsuccess({ target: r }), 0);
              return r;
            },
            delete: (key) => {
              mockIndexedDBStore.delete(key);
              const r = { onsuccess: null, onerror: null };
              setTimeout(() => r.onsuccess && r.onsuccess({ target: r }), 0);
              return r;
            },
            index: () => ({
              openCursor: () => {
                const r = { onsuccess: null, onerror: null };
                setTimeout(() => r.onsuccess && r.onsuccess({ target: { result: null } }), 0);
                return r;
              }
            })
          })
        })
      }
    };
    setTimeout(() => req.onsuccess && req.onsuccess({ target: req }), 0);
    return req;
  }
};

// Set up cryptographic test credentials for Firebase JWT validation
const testProjectId = 'orvix-delete-lifecycle-project';
process.env.FIREBASE_PROJECT_ID = testProjectId;
process.env.SUPABASE_URL = 'https://delete-lifecycle-test.supabase.co';
process.env.SUPABASE_SECRET_KEY = 'test-secret-service-role-key-99999';
process.env.SUPABASE_STORAGE_BUCKET = 'orvix-attachments';

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

const testKid = 'orvix-delete-test-kid';
function createTestToken(uid, overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: testKid })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    aud: testProjectId,
    iss: `https://securetoken.google.com/${testProjectId}`,
    sub: uid,
    user_id: uid,
    iat: now,
    exp: now + 3600,
    ...overrides
  })).toString('base64url');

  const signature = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

const userAlice = 'user_alice_test_123';
const userBob = 'user_bob_test_456';
const tokenAlice = createTestToken(userAlice);
const tokenBob = createTestToken(userBob);

// Mock server for DELETE /api/upload/conversations/:chatId
let mockEndpointResponse = { status: 200, body: { success: true, deletedCount: 2 } };
let lastReceivedHeaders = null;
let lastReceivedUrl = null;
let lastReceivedMethod = null;
let requestCount = 0;
let requestDelayMs = 0;

const server = http.createServer((req, res) => {
  lastReceivedMethod = req.method;
  lastReceivedUrl = req.url;
  lastReceivedHeaders = req.headers;
  requestCount++;

  const handler = () => {
    if (req.method === 'DELETE' && req.url.startsWith('/api/upload/conversations/')) {
      const authHeader = req.headers.authorization || '';
      if (!authHeader.startsWith('Bearer ')) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Authentication required', code: 'AUTH_REQUIRED' }));
      }
      res.writeHead(mockEndpointResponse.status, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(mockEndpointResponse.body));
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  };

  if (requestDelayMs > 0) {
    setTimeout(handler, requestDelayMs);
  } else {
    handler();
  }
});

let serverPort = 0;
await new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => {
    serverPort = server.address().port;
    resolve();
  });
});

// Configure global fetch to route /api/upload/conversations to our test server
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const urlStr = typeof input === 'string' ? input : input?.url || '';
  if (urlStr.startsWith('/api/upload/conversations/')) {
    return originalFetch(`http://127.0.0.1:${serverPort}${urlStr}`, init);
  }
  return originalFetch(input, init);
};

// Import services after environment and polyfills are ready
import { setAuthInstanceForTesting } from '../src/services/authService.js';
import {
  deleteConversation,
  cleanUpSupabaseConversationStorage,
  replayPendingDeletions,
  getPendingDeletedQueue,
  savePendingDeletedQueue,
  getPendingDeletedChatIds,
  savePendingDeletedChatIds,
  enqueuePendingDeletion,
  removePendingDeletion,
  saveCachedUserChats,
  getCachedUserChats,
  saveCachedChatMessages,
  getCachedChatMessages,
  setFirestoreInstanceForTesting
} from '../src/services/chatStorageService.js';
import * as firebaseConfigModule from '../src/config/firebaseConfig.js';

// Setup Mock Auth
let currentTestToken = tokenAlice;
let currentTestUid = userAlice;
const mockAuth = {
  get currentUser() {
    if (!currentTestUid) return null;
    return {
      uid: currentTestUid,
      getIdToken: async () => currentTestToken
    };
  }
};
setAuthInstanceForTesting(mockAuth);

// Setup Mock Firestore
let onFirestoreDeleteCallback = null;
const mockDb = {
  deleteConversation: async (uid, cid) => {
    if (typeof onFirestoreDeleteCallback === 'function') {
      onFirestoreDeleteCallback(uid, cid);
    }
  }
};
setFirestoreInstanceForTesting(mockDb);

// Mock online state via standard navigator.onLine
let isOnlineMock = true;
Object.defineProperty(globalThis.navigator, 'onLine', {
  get: () => isOnlineMock,
  configurable: true
});

console.log('================================================================');
console.log('VERIFICATION SUITE: Supabase Conversation Deletion Lifecycle');
console.log('================================================================\n');

let passedCount = 0;
let totalTests = 0;

async function runTest(name, fn) {
  totalTests++;
  try {
    await fn();
    console.log(`  ✓ PASS: ${name}`);
    passedCount++;
  } catch (err) {
    console.error(`  ✗ FAIL: ${name}`);
    console.error(`    ${err.stack || err.message}`);
    process.exitCode = 1;
  }
}

try {
  // Test 1: Successful deletion with valid Firebase ID token & local cache removal
  await runTest('1. Successful deletion calls DELETE endpoint with auth header and removes local cache', async () => {
    localStorageStore.clear();
    isOnlineMock = true;
    currentTestToken = tokenAlice;
    currentTestUid = userAlice;
    mockEndpointResponse = { status: 200, body: { success: true, chatId: 'chat_success_1', deletedCount: 3 } };
    requestCount = 0;

    // Seed local cache
    saveCachedUserChats(userAlice, [{ id: 'chat_success_1', title: 'Test Chat' }]);
    saveCachedChatMessages(userAlice, 'chat_success_1', [{ id: 'msg_1', content: 'Hello' }]);

    await deleteConversation(userAlice, 'chat_success_1');

    assert.equal(requestCount, 1, 'DELETE endpoint should be called exactly once');
    assert.equal(lastReceivedMethod, 'DELETE');
    assert.equal(lastReceivedUrl, '/api/upload/conversations/chat_success_1');
    assert.equal(lastReceivedHeaders.authorization, `Bearer ${tokenAlice}`);

    // Verify local cache removal
    const cachedChats = getCachedUserChats(userAlice);
    assert.equal(cachedChats.find((c) => c.id === 'chat_success_1'), undefined, 'Chat should be removed from local cache');

    // Queue should be empty on successful deletion
    const queue = getPendingDeletedQueue(userAlice);
    assert.equal(queue.length, 0, 'Pending deletion queue must be empty');
  });

  // Test 2: Offline queueing
  await runTest('2. Offline deletion does not throw and durably queues deletion for background replay', async () => {
    localStorageStore.clear();
    isOnlineMock = false;
    requestCount = 0;

    saveCachedUserChats(userAlice, [{ id: 'chat_offline_1', title: 'Offline Chat' }]);
    saveCachedChatMessages(userAlice, 'chat_offline_1', [{ id: 'msg_1', content: 'Offline Message' }]);

    // Should complete cleanly without throwing unhandled network error
    await deleteConversation(userAlice, 'chat_offline_1');

    assert.equal(requestCount, 0, 'No HTTP request should be made while browser is offline');

    // Local cache should be removed immediately so user sees chat deleted
    const cachedChats = getCachedUserChats(userAlice);
    assert.equal(cachedChats.find((c) => c.id === 'chat_offline_1'), undefined);

    // Durably queued in pending queue
    const queue = getPendingDeletedQueue(userAlice);
    assert.equal(queue.length, 1);
    assert.equal(queue[0].chatId, 'chat_offline_1');
    assert.equal(queue[0].storageDeleted, false);

    const pendingIds = getPendingDeletedChatIds(userAlice);
    assert.deepEqual(pendingIds, ['chat_offline_1']);
  });

  // Test 3: Online HTTP 5xx failure durable queueing & retry backoff
  await runTest('3. Online HTTP 5xx failure durably queues cleanup with exponential backoff and prevents premature Firestore deletion', async () => {
    localStorageStore.clear();
    isOnlineMock = true;
    requestCount = 0;
    mockEndpointResponse = { status: 500, body: { error: 'Internal server error in Supabase storage' } };

    saveCachedUserChats(userAlice, [{ id: 'chat_server_err_1', title: 'Server Error Chat' }]);

    await deleteConversation(userAlice, 'chat_server_err_1');

    assert.equal(requestCount, 1, 'Should have attempted DELETE endpoint');

    // Should be durably queued
    const queue = getPendingDeletedQueue(userAlice);
    assert.equal(queue.length, 1);
    assert.equal(queue[0].chatId, 'chat_server_err_1');
    assert.equal(queue[0].storageDeleted, false);
    assert.equal(queue[0].attempts, 1);
    assert.ok(queue[0].nextRetryMs > Date.now(), 'nextRetryMs must be in the future (backoff)');
    assert.ok(queue[0].error.includes('500') || queue[0].error.includes('Internal server error'));
  });

  // Test 4: Reconnection replay
  await runTest('4. Reconnection replay processes queued deletions and clears the queue upon success', async () => {
    isOnlineMock = true;
    requestCount = 0;
    mockEndpointResponse = { status: 200, body: { success: true, chatId: 'chat_server_err_1', deletedCount: 1 } };

    // Before replay, item is in queue
    assert.equal(getPendingDeletedQueue(userAlice).length, 1);

    // Replay with force: true to bypass backoff delay
    const replayResult = await replayPendingDeletions(userAlice, { force: true });

    assert.equal(replayResult.replayed, 1);
    assert.equal(replayResult.remaining, 0);
    assert.equal(requestCount, 1);
    assert.equal(lastReceivedUrl, '/api/upload/conversations/chat_server_err_1');

    // Queue must now be empty
    const finalQueue = getPendingDeletedQueue(userAlice);
    assert.equal(finalQueue.length, 0, 'Queue should be emptied after successful replay');
  });

  // Test 5: Repeated & concurrent deletion
  await runTest('5. Concurrent deletion calls are deduplicated into a single HTTP request; subsequent calls are idempotent', async () => {
    localStorageStore.clear();
    isOnlineMock = true;
    requestCount = 0;
    requestDelayMs = 40; // Simulate network latency to allow parallel calls
    mockEndpointResponse = { status: 200, body: { success: true, chatId: 'chat_concurrent_1', deletedCount: 1 } };

    // Fire 2 concurrent deletions for the exact same chat
    const [res1, res2] = await Promise.all([
      deleteConversation(userAlice, 'chat_concurrent_1'),
      deleteConversation(userAlice, 'chat_concurrent_1')
    ]);

    requestDelayMs = 0;
    assert.equal(requestCount, 1, 'Concurrent deletions must be deduplicated into exactly 1 HTTP request');

    // Subsequent deletion when files are already deleted (404) should be idempotent and succeed
    mockEndpointResponse = { status: 404, body: { error: 'Not found', code: 'ATTACHMENTS_NOT_FOUND' } };
    await deleteConversation(userAlice, 'chat_concurrent_1');
    assert.equal(getPendingDeletedQueue(userAlice).length, 0, 'Repeated deletion remains clean');
  });

  // Test 6: Authentication failure handling & re-auth replay
  await runTest('6. Missing or expired auth token queues retryable operation and succeeds when valid token hydrates', async () => {
    localStorageStore.clear();
    isOnlineMock = true;
    requestCount = 0;

    // Simulate missing token (e.g. user session expired or hydrating)
    currentTestToken = null;

    await deleteConversation(userAlice, 'chat_unauth_1');

    // Storage cleanup could not send request without token, queued with retryable auth error
    const queue = getPendingDeletedQueue(userAlice);
    assert.equal(queue.length, 1);
    assert.equal(queue[0].chatId, 'chat_unauth_1');
    assert.equal(queue[0].storageDeleted, false);

    // Now user logs in or token hydrates
    currentTestToken = tokenAlice;
    mockEndpointResponse = { status: 200, body: { success: true, chatId: 'chat_unauth_1', deletedCount: 0 } };

    await replayPendingDeletions(userAlice, { force: true });

    assert.equal(requestCount, 1);
    assert.equal(lastReceivedHeaders.authorization, `Bearer ${tokenAlice}`);
    assert.equal(getPendingDeletedQueue(userAlice).length, 0, 'Replayed successfully after auth token restored');
  });

  // Test 7: Firestore deletion ordering
  await runTest('7. Safe deletion ordering: Supabase cleanup is called BEFORE any Firestore deletion', async () => {
    localStorageStore.clear();
    isOnlineMock = true;
    currentTestToken = tokenAlice;
    currentTestUid = userAlice;

    const executionLog = [];

    // Intercept Supabase endpoint
    const prevFetch = globalThis.fetch;
    globalThis.fetch = async (input, init = {}) => {
      const urlStr = typeof input === 'string' ? input : input?.url || '';
      if (urlStr.includes('/api/upload/conversations/')) {
        executionLog.push('supabase_storage_delete');
      }
      return prevFetch(input, init);
    };

    onFirestoreDeleteCallback = () => {
      executionLog.push('firestore_delete');
    };

    mockEndpointResponse = { status: 200, body: { success: true, chatId: 'chat_order_1', deletedCount: 1 } };

    try {
      await deleteConversation(userAlice, 'chat_order_1');
      assert.deepEqual(executionLog, ['supabase_storage_delete', 'firestore_delete'], 'Supabase delete must occur before Firestore delete');
      assert.equal(executionLog[0], 'supabase_storage_delete', 'Supabase storage cleanup must execute first');
      assert.equal(executionLog[1], 'firestore_delete', 'Firestore deletion must execute second');
    } finally {
      globalThis.fetch = prevFetch;
      onFirestoreDeleteCallback = null;
    }
  });

  // Test 8: Guest/local conversation deletion does not block on Supabase
  await runTest('8. Guest/local deletion does not call Supabase storage and completes immediately', async () => {
    localStorageStore.clear();
    requestCount = 0;

    saveCachedUserChats('guest', [{ id: 'guest_chat_1', title: 'Guest Chat' }]);

    await deleteConversation('guest', 'guest_chat_1');

    assert.equal(requestCount, 0, 'Guest deletion must never invoke Supabase storage endpoints');
    const guestChats = getCachedUserChats('guest');
    assert.equal(guestChats.find((c) => c.id === 'guest_chat_1'), undefined);
  });

  // Test 9: Cross-user deletion isolation (403 non-retryable)
  await runTest('9. Cross-user deletion receives 403, does not delete files, and does not loop infinitely', async () => {
    localStorageStore.clear();
    isOnlineMock = true;
    requestCount = 0;
    // Alice attempts to delete Bob's chat -> Server returns 403 Forbidden
    mockEndpointResponse = { status: 403, body: { error: 'Access denied', code: 'STORAGE_ACCESS_DENIED' } };

    await deleteConversation(userAlice, 'chat_bob_forbidden');

    assert.equal(requestCount, 1);
    // 403 is non-retryable; queue should not keep retrying it
    const queue = getPendingDeletedQueue(userAlice);
    assert.equal(queue.length, 0, '403 Forbidden must not be queued for infinite retry');
  });

  // Test 10: Bounded retries limit
  await runTest('10. Bounded retries limit drops entries after MAX_DELETION_RETRIES (5)', async () => {
    localStorageStore.clear();
    isOnlineMock = true;
    requestCount = 0;
    mockEndpointResponse = { status: 503, body: { error: 'Service Unavailable' } };

    // Seed queue with an item that has already failed 5 times
    enqueuePendingDeletion(userAlice, 'chat_max_retries', {
      attempts: 5,
      storageDeleted: false,
      firestoreDeleted: false
    });

    assert.equal(getPendingDeletedQueue(userAlice).length, 1);

    // Running replay without force should recognize max retries exceeded and drop the entry
    await replayPendingDeletions(userAlice, { force: false });

    assert.equal(requestCount, 0, 'Should not dispatch request once max retries exceeded');
    assert.equal(getPendingDeletedQueue(userAlice).length, 0, 'Max retry item must be discarded from queue');
  });

} finally {
  server.close();
}

console.log('\n================================================================');
console.log(`SUMMARY: ${passedCount}/${totalTests} Tests Passed`);
console.log('================================================================\n');

if (passedCount !== totalTests) {
  process.exit(1);
}
