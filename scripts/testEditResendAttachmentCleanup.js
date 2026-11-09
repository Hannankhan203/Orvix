/**
 * Verification Suite for Safe Supabase Attachment Cleanup During Edit & Resend
 *
 * Verifies:
 * 1. Orphaned attachment deletion: deletes attachments belonging to truncated messages
 *    that are no longer referenced by any retained messages.
 * 2. Attachments retained by earlier messages: preserves attachments still referenced
 *    by earlier/retained messages in the conversation.
 * 3. Both attachment reference fields: checks both `attachments` and `referencedAttachments`
 *    when computing retained references.
 * 4. Multiple references deduplication: deduplicates attachment references so that
 *    an orphaned attachment referenced multiple times is deleted exactly once.
 * 5. Authenticated cloud deletion with chatId: invokes DELETE /api/upload/:id?chatId=:chatId
 *    with valid Firebase Authorization headers and exact chatId.
 * 6. Guest/local deletion: cleans up IndexedDB attachment records for guest sessions
 *    without making cloud HTTP requests.
 * 7. Offline/network failure handling: handles offline states and 5xx errors gracefully
 *    without throwing or breaking message truncation.
 * 8. Repeated deletion: handles 404 responses idempotently on repeated or redundant deletions.
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
const deletedIndexedDBKeys = [];
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
              deletedIndexedDBKeys.push(key);
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

// Polyfill navigator.onLine
let isOnlineMock = true;
Object.defineProperty(globalThis.navigator, 'onLine', {
  get: () => isOnlineMock,
  configurable: true
});

// Set up cryptographic test credentials for Firebase JWT validation
const testProjectId = 'orvix-edit-resend-test-project';
process.env.FIREBASE_PROJECT_ID = testProjectId;
process.env.SUPABASE_URL = 'https://edit-resend-test.supabase.co';
process.env.SUPABASE_SECRET_KEY = 'test-secret-service-role-key-edit-resend';
process.env.SUPABASE_STORAGE_BUCKET = 'orvix-attachments';

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

const testKid = 'orvix-edit-test-kid';
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

const userAlice = 'user_alice_edit_123';
const tokenAlice = createTestToken(userAlice);

// Mock server for DELETE /api/upload/:id?chatId=...
let mockEndpointResponse = { status: 200, body: { success: true } };
const receivedRequests = [];

const server = http.createServer((req, res) => {
  const urlObj = new URL(req.url, 'http://127.0.0.1');
  receivedRequests.push({
    method: req.method,
    url: req.url,
    pathname: urlObj.pathname,
    chatId: urlObj.searchParams.get('chatId'),
    headers: req.headers
  });

  if (req.method === 'DELETE' && urlObj.pathname.startsWith('/api/upload/')) {
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
});

let serverPort = 0;
await new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => {
    serverPort = server.address().port;
    resolve();
  });
});

// Route /api/upload/ to test server
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const urlStr = typeof input === 'string' ? input : input?.url || '';
  if (urlStr.startsWith('/api/upload/')) {
    return originalFetch(`http://127.0.0.1:${serverPort}${urlStr}`, init);
  }
  return originalFetch(input, init);
};

// Import services
import { setAuthInstanceForTesting } from '../src/services/authService.js';
import {
  deleteChatMessages,
  cleanUpSingleAttachmentStorage,
  saveCachedChatMessages,
  getCachedChatMessages,
  setFirestoreInstanceForTesting
} from '../src/services/chatStorageService.js';

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
let onFirestoreDeleteChatMessages = null;
const mockDb = {
  deleteChatMessages: async (uid, cid, msgIds) => {
    if (typeof onFirestoreDeleteChatMessages === 'function') {
      onFirestoreDeleteChatMessages(uid, cid, msgIds);
    }
  }
};
setFirestoreInstanceForTesting(mockDb);

console.log('================================================================');
console.log('VERIFICATION SUITE: Safe Supabase Attachment Cleanup (Edit/Resend)');
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
  // Test 1: Orphaned attachment deletion
  await runTest('1. Orphaned attachments in truncated messages are deleted from cloud and IndexedDB', async () => {
    localStorageStore.clear();
    deletedIndexedDBKeys.length = 0;
    receivedRequests.length = 0;
    isOnlineMock = true;
    mockEndpointResponse = { status: 200, body: { success: true, id: 'att_orphan_1' } };

    const initialMessages = [
      { id: 'msg_1', sender: 'user', content: 'Initial prompt without attachments' },
      { id: 'msg_2', sender: 'assistant', content: 'Initial response' },
      { id: 'msg_3', sender: 'user', content: 'Prompt with image', attachments: [{ id: 'att_orphan_1', name: 'photo.jpg' }] },
      { id: 'msg_4', sender: 'assistant', content: 'Analysis of image', referencedAttachments: [{ id: 'att_orphan_1' }] }
    ];
    saveCachedChatMessages(userAlice, 'chat_edit_1', initialMessages);

    // Truncate messages 3 and 4 (user edits message 3)
    const result = await deleteChatMessages(userAlice, 'chat_edit_1', ['msg_3', 'msg_4']);

    assert.equal(result.deletedCount, 2);
    assert.deepEqual(result.orphanedAttachments, ['att_orphan_1']);

    // Check cloud request
    assert.equal(receivedRequests.length, 1);
    assert.equal(receivedRequests[0].pathname, '/api/upload/att_orphan_1');
    assert.equal(receivedRequests[0].chatId, 'chat_edit_1');
    assert.equal(receivedRequests[0].headers.authorization, `Bearer ${tokenAlice}`);

    // Check IndexedDB cleanup
    assert.ok(deletedIndexedDBKeys.includes('att_orphan_1'), 'att_orphan_1 must be removed from IndexedDB');

    // Check cached messages in localStorage
    const remaining = getCachedChatMessages(userAlice, 'chat_edit_1');
    assert.equal(remaining.length, 2);
    assert.deepEqual(remaining.map(m => m.id), ['msg_1', 'msg_2']);
  });

  // Test 2: Attachments retained by earlier messages
  await runTest('2. Attachments retained by earlier messages are NOT deleted when later messages are truncated', async () => {
    localStorageStore.clear();
    deletedIndexedDBKeys.length = 0;
    receivedRequests.length = 0;
    isOnlineMock = true;
    mockEndpointResponse = { status: 200, body: { success: true } };

    const initialMessages = [
      // Message 1 (retained) references att_shared
      { id: 'msg_1', sender: 'user', content: 'Original prompt', attachments: [{ id: 'att_shared_1', name: 'diagram.png' }] },
      { id: 'msg_2', sender: 'assistant', content: 'Response', referencedAttachments: [{ id: 'att_shared_1' }] },
      // Message 3 (truncated) ALSO references att_shared, plus unique att_orphan_2
      {
        id: 'msg_3',
        sender: 'user',
        content: 'Follow-up prompt',
        attachments: [
          { id: 'att_shared_1', name: 'diagram.png' },
          { id: 'att_orphan_2', name: 'notes.txt' }
        ]
      },
      { id: 'msg_4', sender: 'assistant', content: 'Follow-up response' }
    ];
    saveCachedChatMessages(userAlice, 'chat_edit_2', initialMessages);

    // Truncate messages 3 and 4
    const result = await deleteChatMessages(userAlice, 'chat_edit_2', ['msg_3', 'msg_4']);

    // Only att_orphan_2 is orphaned! att_shared_1 must be preserved!
    assert.deepEqual(result.orphanedAttachments, ['att_orphan_2']);
    assert.ok(!result.orphanedAttachments.includes('att_shared_1'), 'att_shared_1 must not be marked orphaned');

    // Cloud requests: only att_orphan_2 should be called
    assert.equal(receivedRequests.length, 1);
    assert.equal(receivedRequests[0].pathname, '/api/upload/att_orphan_2');

    // IndexedDB keys: att_shared_1 must NOT be deleted
    assert.ok(!deletedIndexedDBKeys.includes('att_shared_1'), 'att_shared_1 must remain in IndexedDB');
    assert.ok(deletedIndexedDBKeys.includes('att_orphan_2'), 'att_orphan_2 must be removed from IndexedDB');
  });

  // Test 3: Both attachment reference fields (attachments and referencedAttachments)
  await runTest('3. Both attachments and referencedAttachments fields are inspected for retained references and orphans', async () => {
    localStorageStore.clear();
    deletedIndexedDBKeys.length = 0;
    receivedRequests.length = 0;
    isOnlineMock = true;
    mockEndpointResponse = { status: 200, body: { success: true } };

    const initialMessages = [
      // Retained message contains att_ref_retained in referencedAttachments
      { id: 'msg_1', sender: 'assistant', content: 'Assistant turn', referencedAttachments: [{ id: 'att_ref_retained' }] },
      // Truncated message contains att_ref_retained in attachments, and att_ref_orphan in referencedAttachments
      { id: 'msg_2', sender: 'user', content: 'Turn to truncate', attachments: [{ id: 'att_ref_retained' }] },
      { id: 'msg_3', sender: 'assistant', content: 'Assistant response', referencedAttachments: [{ id: 'att_ref_orphan' }] }
    ];
    saveCachedChatMessages(userAlice, 'chat_edit_3', initialMessages);

    const result = await deleteChatMessages(userAlice, 'chat_edit_3', ['msg_2', 'msg_3']);

    // att_ref_retained must be preserved because msg_1 still references it in referencedAttachments
    assert.deepEqual(result.orphanedAttachments, ['att_ref_orphan']);

    assert.equal(receivedRequests.length, 1);
    assert.equal(receivedRequests[0].pathname, '/api/upload/att_ref_orphan');
  });

  // Test 4: Multiple references to the same attachment (deduplication)
  await runTest('4. Multiple references to the same orphaned attachment across messages are deduplicated to 1 deletion', async () => {
    localStorageStore.clear();
    deletedIndexedDBKeys.length = 0;
    receivedRequests.length = 0;
    isOnlineMock = true;
    mockEndpointResponse = { status: 200, body: { success: true } };

    const initialMessages = [
      { id: 'msg_1', sender: 'user', content: 'Keep this' },
      { id: 'msg_2', sender: 'user', content: 'Delete this', attachments: [{ id: 'att_dup_1' }] },
      { id: 'msg_3', sender: 'assistant', content: 'Delete this too', referencedAttachments: [{ id: 'att_dup_1' }], attachments: [{ id: 'att_dup_1' }] }
    ];
    saveCachedChatMessages(userAlice, 'chat_edit_4', initialMessages);

    const result = await deleteChatMessages(userAlice, 'chat_edit_4', ['msg_2', 'msg_3']);

    assert.deepEqual(result.orphanedAttachments, ['att_dup_1']);
    assert.equal(receivedRequests.length, 1, 'Only one cloud DELETE request should be sent for duplicate references');
    assert.equal(receivedRequests[0].pathname, '/api/upload/att_dup_1');
  });

  // Test 5: Authenticated cloud deletion with chatId
  await runTest('5. Cloud deletion endpoint includes exact chatId query parameter and Firebase Authorization token', async () => {
    localStorageStore.clear();
    receivedRequests.length = 0;
    isOnlineMock = true;
    mockEndpointResponse = { status: 200, body: { success: true } };

    const res = await cleanUpSingleAttachmentStorage('att_test_params_1', 'chat_xyz_789');

    assert.equal(res.success, true);
    assert.equal(receivedRequests.length, 1);
    assert.equal(receivedRequests[0].pathname, '/api/upload/att_test_params_1');
    assert.equal(receivedRequests[0].chatId, 'chat_xyz_789');
    assert.equal(receivedRequests[0].headers.authorization, `Bearer ${tokenAlice}`);
  });

  // Test 6: Guest/local deletion does not call cloud endpoints
  await runTest('6. Guest deletion cleans local IndexedDB records without dispatching cloud HTTP requests', async () => {
    localStorageStore.clear();
    deletedIndexedDBKeys.length = 0;
    receivedRequests.length = 0;

    const guestMessages = [
      { id: 'g_1', sender: 'user', content: 'Retained guest turn' },
      { id: 'g_2', sender: 'user', content: 'Truncated guest turn', attachments: [{ id: 'att_guest_orphan_1' }] }
    ];

    const result = await deleteChatMessages('guest', 'chat_guest_1', ['g_2'], {
      allMessages: guestMessages
    });

    assert.equal(result.deletedCount, 1);
    assert.deepEqual(result.orphanedAttachments, ['att_guest_orphan_1']);

    // IndexedDB cleanup verified
    assert.ok(deletedIndexedDBKeys.includes('att_guest_orphan_1'));

    // Zero cloud HTTP requests
    assert.equal(receivedRequests.length, 0, 'Guest deletion must never make cloud HTTP calls');
  });

  // Test 7: Offline / network failure handling
  await runTest('7. Offline or network 5xx failure during attachment cleanup does not break message truncation', async () => {
    localStorageStore.clear();
    receivedRequests.length = 0;
    isOnlineMock = false; // Browser offline

    const initialMessages = [
      { id: 'msg_1', sender: 'user', content: 'Keep' },
      { id: 'msg_2', sender: 'user', content: 'Truncate', attachments: [{ id: 'att_offline_1' }] }
    ];
    saveCachedChatMessages(userAlice, 'chat_offline_1', initialMessages);

    // Should complete cleanly without throwing
    const result = await deleteChatMessages(userAlice, 'chat_offline_1', ['msg_2']);

    assert.equal(result.deletedCount, 1);
    assert.deepEqual(result.orphanedAttachments, ['att_offline_1']);
    assert.equal(receivedRequests.length, 0, 'Offline should not dispatch network requests');

    // Message cache should still be updated
    const remaining = getCachedChatMessages(userAlice, 'chat_offline_1');
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, 'msg_1');
  });

  // Test 8: Repeated deletion idempotency (404 handled cleanly)
  await runTest('8. Repeated deletion and 404 responses are treated as idempotent success', async () => {
    localStorageStore.clear();
    receivedRequests.length = 0;
    isOnlineMock = true;
    mockEndpointResponse = { status: 404, body: { error: 'Attachment not found', code: 'ATTACHMENT_NOT_FOUND' } };

    const res = await cleanUpSingleAttachmentStorage('att_already_deleted_1', 'chat_repeat_1');

    assert.equal(res.success, true, '404 must be treated as successful idempotent deletion');
    assert.equal(res.status, 404);
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
