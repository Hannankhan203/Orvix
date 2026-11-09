/**
 * Focused Regression Test Suite for Durable Orphaned Attachment Deletions Queue
 *
 * Verifies:
 * 1. Persistence: Failed cleanUpSingleAttachmentStorage calls persist to localStorage queue.
 * 2. Retry Success: Replaying pending deletions sends authenticated DELETE with exact chatId
 *    and clears the queue entry upon HTTP 200 or 404.
 * 3. Repeated Failures: Entries are retained across repeated failures with exponential backoff.
 * 4. Deduplication & Concurrency: Duplicate queue entries are prevented and concurrent calls deduped.
 * 5. Authentication Isolation & Guest Protection: Cross-account deletion is blocked and guest
 *    operations remain strictly local.
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

// Polyfill navigator.onLine
let isOnlineMock = true;
Object.defineProperty(globalThis.navigator, 'onLine', {
  get: () => isOnlineMock,
  configurable: true
});

const testProjectId = 'orvix-retry-queue-project';
process.env.FIREBASE_PROJECT_ID = testProjectId;

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

const testKid = 'orvix-retry-queue-kid';
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

const userAlice = 'user_alice_retry_queue';
const userBob = 'user_bob_retry_queue';
const tokenAlice = createTestToken(userAlice);
const tokenBob = createTestToken(userBob);

let currentAuthUser = { uid: userAlice, getIdToken: async () => tokenAlice };

// Mock auth instance for authService
import { setAuthInstanceForTesting } from '../src/services/authService.js';
setAuthInstanceForTesting({
  get currentUser() {
    return currentAuthUser;
  }
});

// Import storage services after polyfills
import {
  cleanUpSingleAttachmentStorage,
  getPendingOrphanedAttachmentDeletions,
  savePendingOrphanedAttachmentDeletions,
  enqueuePendingOrphanedAttachmentDeletion,
  removePendingOrphanedAttachmentDeletion,
  replayPendingOrphanedAttachmentDeletions
} from '../src/services/chatStorageService.js';

console.log('================================================================');
console.log('REGRESSION SUITE: Durable Attachment Deletions Retry Queue');
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

// Track HTTP requests made to mock server
const receivedRequests = [];
let mockEndpointResponse = { status: 200, body: { success: true } };

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const authHeader = req.headers.authorization;
  const chatId = parsedUrl.searchParams.get('chatId');

  receivedRequests.push({
    method: req.method,
    pathname: parsedUrl.pathname,
    chatId,
    headers: req.headers
  });

  res.writeHead(mockEndpointResponse.status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(mockEndpointResponse.body));
});

await new Promise((resolve) => server.listen(0, resolve));
const port = server.address().port;
const originalFetch = globalThis.fetch;

// Intercept fetch requests targeting /api/upload
globalThis.fetch = async (input, init = {}) => {
  const urlStr = typeof input === 'string' ? input : input.url;
  if (urlStr.startsWith('/api/upload') || urlStr.startsWith('http://localhost') || urlStr.startsWith('http://127.0.0.1')) {
    const fullUrl = urlStr.startsWith('http') ? urlStr : `http://127.0.0.1:${port}${urlStr}`;
    return originalFetch(fullUrl, init);
  }
  return originalFetch(input, init);
};

try {
  // -------------------------------------------------------------------------
  // Test 1: Persistence of Failed cleanUpSingleAttachmentStorage Calls
  // -------------------------------------------------------------------------
  await runTest('1. Failed attachment cleanup persists to durable localStorage queue', async () => {
    localStorageStore.clear();
    receivedRequests.length = 0;
    currentAuthUser = { uid: userAlice, getIdToken: async () => tokenAlice };

    // Simulate 500 server error
    mockEndpointResponse = { status: 500, body: { error: 'Internal storage error' } };
    isOnlineMock = true;

    const res = await cleanUpSingleAttachmentStorage('att_failed_1', 'chat_conv_1', userAlice);
    assert.equal(res.success, false);
    assert.equal(res.status, 500);

    // Verify persisted into queue
    const queue = getPendingOrphanedAttachmentDeletions(userAlice);
    assert.equal(queue.length, 1);
    assert.equal(queue[0].attachmentId, 'att_failed_1');
    assert.equal(queue[0].chatId, 'chat_conv_1');
    assert.equal(queue[0].userId, userAlice);
    assert.equal(queue[0].attempts, 1);
    assert.ok(queue[0].nextRetryMs > Date.now());

    // Verify localStorage key existence
    const rawGlobal = localStorage.getItem('pendingOrphanedAttachmentDeletions');
    assert.ok(rawGlobal, 'Must be stored in pendingOrphanedAttachmentDeletions');
    assert.ok(rawGlobal.includes('att_failed_1'));
  });

  // -------------------------------------------------------------------------
  // Test 2: Offline Persistence
  // -------------------------------------------------------------------------
  await runTest('2. Offline failure persists immediately without dispatching network request', async () => {
    localStorageStore.clear();
    receivedRequests.length = 0;
    isOnlineMock = false;

    const res = await cleanUpSingleAttachmentStorage('att_offline_1', 'chat_conv_offline', userAlice);
    assert.equal(res.success, false);
    assert.equal(res.code, 'OFFLINE');
    assert.equal(receivedRequests.length, 0, 'No network call when offline');

    const queue = getPendingOrphanedAttachmentDeletions(userAlice);
    assert.equal(queue.length, 1);
    assert.equal(queue[0].attachmentId, 'att_offline_1');
    assert.equal(queue[0].chatId, 'chat_conv_offline');
  });

  // -------------------------------------------------------------------------
  // Test 3: Successful Replay & Queue Removal
  // -------------------------------------------------------------------------
  await runTest('3. Replaying pending deletions dispatches authenticated DELETE and clears queue on success', async () => {
    localStorageStore.clear();
    receivedRequests.length = 0;
    isOnlineMock = true;
    currentAuthUser = { uid: userAlice, getIdToken: async () => tokenAlice };
    mockEndpointResponse = { status: 200, body: { success: true } };

    // Seed queue with pending deletion
    enqueuePendingOrphanedAttachmentDeletion(userAlice, 'chat_conv_replay', 'att_replay_1');
    assert.equal(getPendingOrphanedAttachmentDeletions(userAlice).length, 1);

    // Replay queue (force=true to ignore backoff window)
    const replayRes = await replayPendingOrphanedAttachmentDeletions(userAlice, { force: true });
    assert.equal(replayRes.replayed, 1);
    assert.equal(replayRes.remaining, 0);

    // Verify HTTP call details
    assert.equal(receivedRequests.length, 1);
    assert.equal(receivedRequests[0].pathname, '/api/upload/att_replay_1');
    assert.equal(receivedRequests[0].chatId, 'chat_conv_replay');
    assert.equal(receivedRequests[0].headers.authorization, `Bearer ${tokenAlice}`);

    // Queue is cleared
    assert.equal(getPendingOrphanedAttachmentDeletions(userAlice).length, 0);
  });

  // -------------------------------------------------------------------------
  // Test 4: Idempotent 404 Clears Queue Entry
  // -------------------------------------------------------------------------
  await runTest('4. Replay treating 404 as idempotent success clears queue entry', async () => {
    localStorageStore.clear();
    receivedRequests.length = 0;
    isOnlineMock = true;
    mockEndpointResponse = { status: 404, body: { error: 'Not found', code: 'ATTACHMENT_NOT_FOUND' } };

    enqueuePendingOrphanedAttachmentDeletion(userAlice, 'chat_conv_404', 'att_already_gone_1');
    const replayRes = await replayPendingOrphanedAttachmentDeletions(userAlice, { force: true });

    assert.equal(replayRes.replayed, 1);
    assert.equal(replayRes.remaining, 0);
    assert.equal(getPendingOrphanedAttachmentDeletions(userAlice).length, 0);
  });

  // -------------------------------------------------------------------------
  // Test 5: Repeated Failures Retained with Exponential Backoff
  // -------------------------------------------------------------------------
  await runTest('5. Repeated failures retain entry in queue with incrementing attempts and backoff', async () => {
    localStorageStore.clear();
    receivedRequests.length = 0;
    isOnlineMock = true;
    mockEndpointResponse = { status: 503, body: { error: 'Service Unavailable' } };

    // Initial enqueue
    enqueuePendingOrphanedAttachmentDeletion(userAlice, 'chat_backoff', 'att_backoff_1');
    const q1 = getPendingOrphanedAttachmentDeletions(userAlice);
    assert.equal(q1[0].attempts, 1);

    // Replay with failure (forced)
    await replayPendingOrphanedAttachmentDeletions(userAlice, { force: true });

    const q2 = getPendingOrphanedAttachmentDeletions(userAlice);
    assert.equal(q2.length, 1, 'Failed entry must be retained');
    assert.equal(q2[0].attempts, 2, 'Attempts count must increment');
    assert.ok(q2[0].nextRetryMs > Date.now());

    // Another replay attempt with failure
    await replayPendingOrphanedAttachmentDeletions(userAlice, { force: true });
    const q3 = getPendingOrphanedAttachmentDeletions(userAlice);
    assert.equal(q3[0].attempts, 3);
  });

  // -------------------------------------------------------------------------
  // Test 6: Deduplication of Queue Entries
  // -------------------------------------------------------------------------
  await runTest('6. Enqueuing the same attachmentId multiple times updates the existing entry without creating duplicates', async () => {
    localStorageStore.clear();

    enqueuePendingOrphanedAttachmentDeletion(userAlice, 'chat_dedup', 'att_dedup_1', { error: 'First error' });
    enqueuePendingOrphanedAttachmentDeletion(userAlice, 'chat_dedup', 'att_dedup_1', { error: 'Second error' });
    enqueuePendingOrphanedAttachmentDeletion(userAlice, 'chat_dedup', 'att_dedup_1', { error: 'Third error' });

    const queue = getPendingOrphanedAttachmentDeletions(userAlice);
    assert.equal(queue.length, 1, 'Queue must contain exactly 1 entry for the attachmentId');
    assert.equal(queue[0].attachmentId, 'att_dedup_1');
    assert.equal(queue[0].attempts, 3, 'Attempts must accumulate');
    assert.equal(queue[0].error, 'Third error');
  });

  // -------------------------------------------------------------------------
  // Test 7: Concurrent Execution Lock (activeAttachmentDeletionPromises)
  // -------------------------------------------------------------------------
  await runTest('7. Concurrent calls to cleanUpSingleAttachmentStorage share a single in-flight promise', async () => {
    localStorageStore.clear();
    receivedRequests.length = 0;
    isOnlineMock = true;
    mockEndpointResponse = { status: 200, body: { success: true } };

    // Fire 3 simultaneous deletion calls for the same attachment
    const [r1, r2, r3] = await Promise.all([
      cleanUpSingleAttachmentStorage('att_concurrent_1', 'chat_conc', userAlice),
      cleanUpSingleAttachmentStorage('att_concurrent_1', 'chat_conc', userAlice),
      cleanUpSingleAttachmentStorage('att_concurrent_1', 'chat_conc', userAlice)
    ]);

    assert.equal(r1.success, true);
    assert.equal(r2.success, true);
    assert.equal(r3.success, true);

    // Exactly 1 network request dispatched
    assert.equal(receivedRequests.length, 1, 'Concurrent calls must be deduplicated into 1 network request');
  });

  // -------------------------------------------------------------------------
  // Test 8: Authentication Isolation & Cross-Account Protection
  // -------------------------------------------------------------------------
  await runTest('8. Cross-account isolation: User Bob cannot replay or delete User Alice queued attachments', async () => {
    localStorageStore.clear();
    receivedRequests.length = 0;
    isOnlineMock = true;
    mockEndpointResponse = { status: 200, body: { success: true } };

    // Alice has a failed attachment queued
    enqueuePendingOrphanedAttachmentDeletion(userAlice, 'chat_alice_private', 'att_alice_secret');

    // Bob signs in
    currentAuthUser = { uid: userBob, getIdToken: async () => tokenBob };

    // Bob triggers replay
    const bobReplay = await replayPendingOrphanedAttachmentDeletions(userBob, { force: true });
    assert.equal(bobReplay.replayed, 0);
    assert.equal(bobReplay.remaining, 0);

    // Zero requests dispatched under Bob for Alice's attachment
    assert.equal(receivedRequests.length, 0, 'Bob must never dispatch deletions for Alice');

    // Alice's queue remains intact
    const aliceQueue = getPendingOrphanedAttachmentDeletions(userAlice);
    assert.equal(aliceQueue.length, 1);
    assert.equal(aliceQueue[0].attachmentId, 'att_alice_secret');
  });

  // -------------------------------------------------------------------------
  // Test 9: Guest Behavior Preservation
  // -------------------------------------------------------------------------
  await runTest('9. Guest sessions do not enqueue cloud deletions or dispatch cloud replay requests', async () => {
    localStorageStore.clear();
    receivedRequests.length = 0;

    enqueuePendingOrphanedAttachmentDeletion('guest', 'chat_guest', 'att_guest_1');
    const guestQueue = getPendingOrphanedAttachmentDeletions('guest');
    assert.equal(guestQueue.length, 0, 'Guest attachments must never be enqueued to cloud retry queue');

    const replayRes = await replayPendingOrphanedAttachmentDeletions('guest', { force: true });
    assert.equal(replayRes.replayed, 0);
    assert.equal(receivedRequests.length, 0);
  });

} finally {
  server.close();
  globalThis.fetch = originalFetch;
}

console.log('\n================================================================');
console.log(`SUMMARY: ${passedCount}/${totalTests} Tests Passed`);
console.log('================================================================\n');

if (passedCount !== totalTests) {
  process.exit(1);
}
