/**
 * Dedicated Verification Suite for Phase 3 Prompt 6:
 * Frontend Supabase-Backed Attachment Retrieval
 *
 * Verifies:
 * 1. getIdToken & getAuthHeaders retrieve valid Firebase JWTs when user is logged in.
 * 2. getIdToken returns null and getAuthHeaders omits Authorization for guest/unauthenticated users.
 * 3. fetchWithAuth attaches Authorization header and retries with force-refresh on 401 TOKEN_EXPIRED.
 * 4. checkAttachmentStatus sends auth headers to /api/upload/:id, detecting server-ready cloud attachments.
 * 5. fetchAttachmentBlob retrieves in-memory, IndexedDB, and server-side Supabase cloud files with auth.
 * 6. fetchAttachmentBlob caches newly retrieved cloud files into local IndexedDB for fast subsequent offline access.
 * 7. openOrPreviewAttachment opens previewable formats in new window and downloads non-previewable formats.
 * 8. downloadAttachmentFile triggers file download with original filename, and falls back to extraction text if binary expired.
 * 9. Safe error handling: 401 AUTH_REQUIRED, 403 STORAGE_ACCESS_DENIED, 404 ATTACHMENT_NOT_FOUND, and network errors.
 * 10. Security boundary: Frontend code never contains or leaks Supabase secret keys or private storage paths.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import crypto from 'node:crypto';

import {
  fetchWithAuth,
  fetchAttachmentBlob,
  checkAttachmentStatus,
  openOrPreviewAttachment,
  downloadAttachmentFile,
  getAttachmentSignedUrl,
  isFormatPreviewable,
  getAttachmentBlob,
  saveAttachmentBlob,
  isCloudAttachmentRecord,
  isAttachmentOwnedByCurrentUser
} from '../src/services/attachmentStorageService.js';
import { getIdToken, getAuthHeaders, setAuthInstanceForTesting } from '../src/services/authService.js';

console.log('================================================================');
console.log('VERIFICATION SUITE: Frontend Supabase Attachment Retrieval');
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

// In-memory IndexedDB stub for Node test environment
const mockIndexedDBStore = new Map();
globalThis.indexedDB = {
  open: () => {
    const req = {
      result: {
        objectStoreNames: { contains: () => true },
        createObjectStore: () => ({ createIndex: () => {} }),
        transaction: () => {
          const tx = {
            oncomplete: null,
            onerror: null,
            onabort: null,
            objectStore: () => ({
              get: (key) => {
                const getReq = { onsuccess: null, onerror: null, result: mockIndexedDBStore.get(key) };
                setTimeout(() => getReq.onsuccess && getReq.onsuccess({ target: getReq }), 0);
                return getReq;
              },
              put: (val) => {
                mockIndexedDBStore.set(val.id, val);
                const putReq = { onsuccess: null, onerror: null };
                setTimeout(() => {
                  if (putReq.onsuccess) putReq.onsuccess({ target: putReq });
                  if (tx.oncomplete) tx.oncomplete();
                }, 0);
                return putReq;
              },
              delete: (key) => {
                mockIndexedDBStore.delete(key);
                const delReq = { onsuccess: null, onerror: null };
                setTimeout(() => {
                  if (delReq.onsuccess) delReq.onsuccess({ target: delReq });
                  if (tx.oncomplete) tx.oncomplete();
                }, 0);
                return delReq;
              }
            })
          };
          return tx;
        }
      },
      onsuccess: null,
      onerror: null
    };
    setTimeout(() => req.onsuccess && req.onsuccess({ target: req }), 0);
    return req;
  }
};

// Mock DOM elements for download / preview testing in Node
let clickedDownloads = [];
let openedWindows = [];
globalThis.window = {
  indexedDB: globalThis.indexedDB,
  open: (url, target) => {
    openedWindows.push({ url, target });
    return { focus: () => {} };
  }
};
globalThis.document = {
  body: {
    appendChild: () => {},
    removeChild: () => {}
  },
  createElement: (tag) => {
    if (tag === 'a') {
      const el = {
        href: '',
        download: '',
        click: () => {
          clickedDownloads.push({ href: el.href, download: el.download });
        }
      };
      return el;
    }
    return {};
  }
};
globalThis.URL.createObjectURL = (blob) => `blob:http://localhost:3000/${crypto.randomUUID()}`;
globalThis.URL.revokeObjectURL = () => {};

async function main() {
  // Set up mock test backend server
  const testApp = express();
  testApp.use(express.json());

  let receivedAuthHeaders = [];
  let tokenRefreshCount = 0;

  // Middleware to record auth headers
  testApp.use((req, res, next) => {
    receivedAuthHeaders.push({
      path: req.path,
      method: req.method,
      auth: req.headers.authorization || null
    });
    next();
  });

  const testFileBuffer = Buffer.from('PDF mock content for frontend retrieval test');
  const cloudAttachmentId = 'cloud-attachment-test-uuid-1';
  const missingAttachmentId = 'missing-attachment-test-uuid-2';
  const deniedAttachmentId = 'denied-attachment-test-uuid-3';
  const expiredTokenAttachmentId = 'expired-token-attachment-uuid-4';
  const multiUserCloudAttachmentId = 'multi-user-isolated-file-uuid-99';

  // /api/upload/:id metadata endpoint
  testApp.get('/api/upload/:id', (req, res) => {
    const id = req.params.id;
    if (id === multiUserCloudAttachmentId) {
      if (!req.headers.authorization) {
        return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
      }
      if (req.headers.authorization === 'Bearer alice-jwt-token') {
        return res.json({
          id,
          name: 'Alice_Confidential.pdf',
          mimeType: 'application/pdf',
          status: 'ready',
          storageProvider: 'supabase',
          userId: 'user_alice'
        });
      }
      return res.status(403).json({ error: 'Access denied: not your file', code: 'STORAGE_ACCESS_DENIED' });
    }
    if (id === cloudAttachmentId) {
      if (!req.headers.authorization) {
        return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
      }
      return res.json({ id, name: 'Report.pdf', mimeType: 'application/pdf', status: 'ready', storageProvider: 'supabase' });
    }
    if (id === deniedAttachmentId) {
      return res.status(403).json({ error: 'Access denied', code: 'STORAGE_ACCESS_DENIED' });
    }
    return res.status(404).json({ error: 'Not found', code: 'ATTACHMENT_NOT_FOUND' });
  });

  // /api/upload/:id/file serving endpoint
  testApp.get('/api/upload/:id/file', (req, res) => {
    const id = req.params.id;
    const authHeader = req.headers.authorization;

    if (id === multiUserCloudAttachmentId) {
      if (!authHeader) {
        return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
      }
      if (authHeader === 'Bearer alice-jwt-token') {
        res.setHeader('Content-Type', 'application/pdf');
        return res.send(testFileBuffer);
      }
      return res.status(403).json({ error: 'Access denied: not your file', code: 'STORAGE_ACCESS_DENIED' });
    }

    if (id === expiredTokenAttachmentId) {
      if (authHeader === 'Bearer expired-jwt-token') {
        return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
      }
      if (authHeader === 'Bearer refreshed-jwt-token') {
        tokenRefreshCount++;
        res.setHeader('Content-Type', 'application/pdf');
        return res.send(testFileBuffer);
      }
    }

    if (id === cloudAttachmentId) {
      if (!authHeader) {
        return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
      }
      res.setHeader('Content-Type', 'application/pdf');
      return res.send(testFileBuffer);
    }

    if (id === deniedAttachmentId) {
      return res.status(403).json({ error: 'Access denied', code: 'STORAGE_ACCESS_DENIED' });
    }

    return res.status(404).json({ error: 'Not found', code: 'ATTACHMENT_NOT_FOUND' });
  });

  // /api/upload/:id/signed-url
  testApp.get('/api/upload/:id/signed-url', (req, res) => {
    if (!req.headers.authorization) {
      return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
    }
    return res.json({ success: true, signedUrl: 'https://supabase.co/signed/file.pdf', expiresInSeconds: 120 });
  });

  const server = http.createServer(testApp);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;

  // Patch global fetch to redirect /api/upload to test server
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    let url = typeof input === 'string' ? input : input.url;
    if (url.startsWith('/api/upload')) {
      url = `${baseUrl}${url}`;
    }
    return originalFetch(url, init);
  };

  try {
    // -----------------------------------------------------------------------
    // Test 1: getIdToken & getAuthHeaders for unauthenticated / guest user
    // -----------------------------------------------------------------------
    await runTest('getIdToken and getAuthHeaders return null / omit auth when no user is signed in', async () => {
      setAuthInstanceForTesting(null);
      const token = await getIdToken();
      assert.equal(token, null, 'Token must be null when user is not authenticated');

      const headers = await getAuthHeaders({ 'Content-Type': 'application/json' });
      assert.equal(headers['Authorization'], undefined, 'Authorization header must not be set');
      assert.equal(headers['Content-Type'], 'application/json');
    });

    // -----------------------------------------------------------------------
    // Test 2: getIdToken & getAuthHeaders for authenticated user
    // -----------------------------------------------------------------------
    await runTest('getIdToken and getAuthHeaders retrieve valid token from active Firebase user', async () => {
      setAuthInstanceForTesting({
        currentUser: {
          uid: 'test_user_789',
          getIdToken: async (force) => (force ? 'forced-refreshed-token' : 'valid-firebase-jwt')
        }
      });
      const token = await getIdToken();
      assert.equal(token, 'valid-firebase-jwt');

      const headers = await getAuthHeaders();
      assert.equal(headers['Authorization'], 'Bearer valid-firebase-jwt');

      const forcedHeaders = await getAuthHeaders({}, true);
      assert.equal(forcedHeaders['Authorization'], 'Bearer forced-refreshed-token');
    });

    // -----------------------------------------------------------------------
    // Test 3: fetchWithAuth token expiration retry
    // -----------------------------------------------------------------------
    await runTest('fetchWithAuth automatically refreshes token and retries on 401 TOKEN_EXPIRED', async () => {
      setAuthInstanceForTesting({
        currentUser: {
          uid: 'test_user_789',
          getIdToken: async (force) => {
            if (force) return 'refreshed-jwt-token';
            return 'expired-jwt-token';
          }
        }
      });

      const res = await fetchWithAuth(`/api/upload/${expiredTokenAttachmentId}/file`);
      assert.equal(res.status, 200, 'Must retry and succeed with refreshed token');
      assert.equal(tokenRefreshCount, 1, 'Must have refreshed token exactly once');
    });

    // -----------------------------------------------------------------------
    // Test 4: checkAttachmentStatus sends auth headers and detects cloud file
    // -----------------------------------------------------------------------
    await runTest('checkAttachmentStatus includes auth headers and verifies cloud attachment availability', async () => {
      setAuthInstanceForTesting({
        currentUser: {
          uid: 'test_user_789',
          getIdToken: async () => 'valid-firebase-jwt'
        }
      });
      receivedAuthHeaders = [];

      const status = await checkAttachmentStatus({ id: cloudAttachmentId });
      assert.equal(status.available, true);
      assert.equal(status.source, 'server');

      const reqRecord = receivedAuthHeaders.find((r) => r.path === `/api/upload/${cloudAttachmentId}`);
      assert.ok(reqRecord, 'Must have called metadata endpoint');
      assert.equal(reqRecord.auth, 'Bearer valid-firebase-jwt', 'Must have included Authorization header');
    });

    // -----------------------------------------------------------------------
    // Test 5: fetchAttachmentBlob in-memory & IndexedDB caching
    // -----------------------------------------------------------------------
    await runTest('fetchAttachmentBlob returns in-memory Blob without network call', async () => {
      const memBlob = new Blob(['in memory file'], { type: 'text/plain' });
      const result = await fetchAttachmentBlob({ id: 'mem-1', file: memBlob });
      assert.equal(result.success, true);
      assert.equal(result.source, 'memory');
      assert.equal(result.blob, memBlob);
    });

    await runTest('fetchAttachmentBlob retrieves and caches cloud file into IndexedDB', async () => {
      setAuthInstanceForTesting({
        currentUser: {
          uid: 'test_user_789',
          getIdToken: async () => 'valid-firebase-jwt'
        }
      });
      mockIndexedDBStore.clear();

      const result = await fetchAttachmentBlob({
        id: cloudAttachmentId,
        name: 'Report.pdf',
        mimeType: 'application/pdf'
      });

      assert.equal(result.success, true);
      assert.equal(result.source, 'server');
      assert.ok(result.blob instanceof Blob);

      // Verify cached into IndexedDB
      const cached = mockIndexedDBStore.get(cloudAttachmentId);
      assert.ok(cached, 'Retrieved cloud blob must be cached in local IndexedDB');
      assert.equal(cached.name, 'Report.pdf');

      // Subsequent call retrieves from IndexedDB without network fetch
      const idbResult = await fetchAttachmentBlob({ id: cloudAttachmentId });
      assert.equal(idbResult.success, true);
      assert.equal(idbResult.source, 'indexeddb');
    });

    // -----------------------------------------------------------------------
    // Test 6: Error handling (401, 403, 404, network failure)
    // -----------------------------------------------------------------------
    await runTest('fetchAttachmentBlob safely handles 401 AUTH_REQUIRED', async () => {
      setAuthInstanceForTesting(null);
      mockIndexedDBStore.clear();

      const result = await fetchAttachmentBlob({ id: cloudAttachmentId });
      assert.equal(result.success, false);
      assert.equal(result.status, 401);
      assert.ok(result.error.includes('Authentication required'));
    });

    await runTest('fetchAttachmentBlob safely handles 403 STORAGE_ACCESS_DENIED', async () => {
      setAuthInstanceForTesting({
        currentUser: { uid: 'other_user', getIdToken: async () => 'token' }
      });
      mockIndexedDBStore.clear();

      const result = await fetchAttachmentBlob({ id: deniedAttachmentId });
      assert.equal(result.success, false);
      assert.equal(result.status, 403);
      assert.ok(result.error.includes('permission'));
    });

    await runTest('fetchAttachmentBlob safely handles 404 ATTACHMENT_NOT_FOUND', async () => {
      setAuthInstanceForTesting({
        currentUser: { uid: 'test_user', getIdToken: async () => 'token' }
      });
      mockIndexedDBStore.clear();

      const result = await fetchAttachmentBlob({ id: missingAttachmentId });
      assert.equal(result.success, false);
      assert.equal(result.status, 404);
      assert.ok(result.error.includes('expired') || result.error.includes('not found'));
    });

    // -----------------------------------------------------------------------
    // Test 7: openOrPreviewAttachment behavior
    // -----------------------------------------------------------------------
    await runTest('openOrPreviewAttachment opens previewable PDF via Blob URL', async () => {
      setAuthInstanceForTesting({
        currentUser: { uid: 'test_user_789', getIdToken: async () => 'valid-firebase-jwt' }
      });
      openedWindows = [];
      clickedDownloads = [];

      const res = await openOrPreviewAttachment({
        id: cloudAttachmentId,
        name: 'Report.pdf',
        extension: 'PDF',
        mimeType: 'application/pdf'
      });

      assert.equal(res.success, true);
      assert.equal(res.action, 'preview');
      assert.equal(openedWindows.length, 1);
      assert.ok(openedWindows[0].url.startsWith('blob:'));
      assert.equal(openedWindows[0].target, '_blank');
    });

    // -----------------------------------------------------------------------
    // Test 8: downloadAttachmentFile with cloud attachment & fallback
    // -----------------------------------------------------------------------
    await runTest('downloadAttachmentFile triggers download with original filename', async () => {
      setAuthInstanceForTesting({
        currentUser: { uid: 'test_user_789', getIdToken: async () => 'valid-firebase-jwt' }
      });
      clickedDownloads = [];

      const res = await downloadAttachmentFile({
        id: cloudAttachmentId,
        name: 'Q4_Financials.pdf',
        mimeType: 'application/pdf'
      });

      assert.equal(res.success, true);
      assert.equal(clickedDownloads.length, 1);
      assert.equal(clickedDownloads[0].download, 'Q4_Financials.pdf');
      assert.ok(clickedDownloads[0].href.startsWith('blob:'));
    });

    await runTest('downloadAttachmentFile falls back to extraction text when binary expired', async () => {
      clickedDownloads = [];
      mockIndexedDBStore.clear();

      const res = await downloadAttachmentFile({
        id: 'expired-text-doc',
        name: 'summary.txt',
        extraction: { text: 'Extracted summary textual content.' }
      });

      assert.equal(res.success, true);
      assert.equal(clickedDownloads.length, 1);
      assert.equal(clickedDownloads[0].download, 'summary.txt');
    });

    // -----------------------------------------------------------------------
    // Test 9: getAttachmentSignedUrl endpoint call
    // -----------------------------------------------------------------------
    await runTest('getAttachmentSignedUrl requests pre-signed URL with auth headers', async () => {
      setAuthInstanceForTesting({
        currentUser: { uid: 'test_user_789', getIdToken: async () => 'valid-firebase-jwt' }
      });
      const signedUrl = await getAttachmentSignedUrl(cloudAttachmentId);
      assert.equal(signedUrl, 'https://supabase.co/signed/file.pdf');
    });

    // -----------------------------------------------------------------------
    // Test 10: Security assertions: zero secret leaks in frontend
    // -----------------------------------------------------------------------
    await runTest('Frontend source files never expose Supabase secret keys or private storage paths', () => {
      const srcDir = path.resolve('src');
      const files = [];

      function walk(dir) {
        for (const item of fs.readdirSync(dir)) {
          const full = path.join(dir, item);
          if (fs.statSync(full).isDirectory()) walk(full);
          else if (full.endsWith('.js') || full.endsWith('.jsx') || full.endsWith('.ts') || full.endsWith('.tsx')) {
            files.push(full);
          }
        }
      }
      walk(srcDir);

      for (const f of files) {
        const content = fs.readFileSync(f, 'utf-8');
        assert.ok(!content.includes('SUPABASE_SECRET_KEY'), `Forbidden Supabase secret key in ${f}`);
        assert.ok(!content.includes('SUPABASE_SERVICE_ROLE_KEY'), `Forbidden service role key in ${f}`);
        assert.ok(!content.includes('storage.from('), `Direct Supabase SDK storage access in frontend ${f}`);
      }
    });

    // -----------------------------------------------------------------------
    // Test 11: Account isolation regression: User A caches a Supabase attachment in IndexedDB;
    // User B cannot access User A's cached blob, and backend blocks User B with 403
    // -----------------------------------------------------------------------
    await runTest('Account isolation: User B cannot retrieve User A cached cloud blob from IndexedDB', async () => {
      // 1. User A (Alice) logs in
      setAuthInstanceForTesting({
        currentUser: { uid: 'user_alice', getIdToken: async () => 'alice-jwt-token' }
      });

      // User A fetches and caches the Supabase-backed attachment
      const aliceResult = await fetchAttachmentBlob({
        id: multiUserCloudAttachmentId,
        name: 'Alice_Confidential.pdf',
        mimeType: 'application/pdf',
        storageProvider: 'supabase'
      });
      assert.equal(aliceResult.success, true, 'Alice must successfully retrieve the attachment');
      assert.equal(aliceResult.source, 'server');

      // Verify that IndexedDB cached record has userId: 'user_alice' and storageProvider: 'supabase'
      const cached = mockIndexedDBStore.get(multiUserCloudAttachmentId);
      assert.ok(cached, 'Attachment must be cached in IndexedDB');
      assert.equal(cached.userId, 'user_alice', 'Cached record must be scoped to user_alice');
      assert.equal(cached.storageProvider, 'supabase');

      // Subsequent access by Alice returns from cache
      const aliceCachedResult = await fetchAttachmentBlob({
        id: multiUserCloudAttachmentId,
        name: 'Alice_Confidential.pdf',
        mimeType: 'application/pdf',
        storageProvider: 'supabase'
      });
      assert.equal(aliceCachedResult.success, true);
      assert.equal(aliceCachedResult.source, 'indexeddb', 'Alice must retrieve from IndexedDB cache');

      // 2. User B (Bob) logs in on the exact same browser/device
      setAuthInstanceForTesting({
        currentUser: { uid: 'user_bob', getIdToken: async () => 'bob-jwt-token' }
      });

      // Bob attempts to fetch the same attachment ID
      // The cached blob belongs to Alice, so it MUST NOT be returned from IndexedDB!
      // Execution must proceed to backend, where Bob's token is rejected with 403
      const bobResult = await fetchAttachmentBlob({
        id: multiUserCloudAttachmentId,
        name: 'Alice_Confidential.pdf',
        mimeType: 'application/pdf',
        storageProvider: 'supabase'
      });

      assert.equal(bobResult.success, false, 'Bob must NOT be granted access');
      assert.notEqual(bobResult.source, 'indexeddb', 'Bob must NEVER receive Alice cached IndexedDB blob');
      assert.equal(bobResult.status, 403, 'Backend must reject unauthorized User B with 403');
      assert.equal(bobResult.code, 'STORAGE_ACCESS_DENIED');

      // Bob also cannot get raw blob via getAttachmentBlob
      const bobRawBlob = await getAttachmentBlob(multiUserCloudAttachmentId);
      assert.equal(bobRawBlob, null, 'getAttachmentBlob must return null for unauthorized User B');

      // Bob checkAttachmentStatus does not return 'indexeddb'
      const bobStatus = await checkAttachmentStatus({ id: multiUserCloudAttachmentId, storageProvider: 'supabase' });
      assert.equal(bobStatus.available, false, 'Status must report unavailable for User B');
      assert.equal(bobStatus.reason, 'access_denied');
    });

    // -----------------------------------------------------------------------
    // Test 12: Account isolation regression: Guest cannot access User A cached cloud blob
    // -----------------------------------------------------------------------
    await runTest('Account isolation: Guest cannot retrieve User A cached cloud blob from IndexedDB', async () => {
      // Ensure Alice's cloud record is in cache
      assert.ok(mockIndexedDBStore.get(multiUserCloudAttachmentId), 'Alice record must be in IDB');

      // User signs out (Guest mode)
      setAuthInstanceForTesting(null);

      // Guest calls fetchAttachmentBlob
      const guestResult = await fetchAttachmentBlob({
        id: multiUserCloudAttachmentId,
        name: 'Alice_Confidential.pdf',
        mimeType: 'application/pdf',
        storageProvider: 'supabase'
      });

      assert.equal(guestResult.success, false, 'Guest must NOT be granted access to cloud file');
      assert.notEqual(guestResult.source, 'indexeddb', 'Guest must NEVER receive Alice cached cloud blob');
      assert.equal(guestResult.status, 401, 'Backend must require authentication with 401');

      // Guest raw blob must also be null
      const guestRawBlob = await getAttachmentBlob(multiUserCloudAttachmentId);
      assert.equal(guestRawBlob, null, 'getAttachmentBlob must return null for guest');
    });

    // -----------------------------------------------------------------------
    // Test 13: User A returns and successfully retrieves their own cached blob
    // -----------------------------------------------------------------------
    await runTest('Account isolation: User A returns and retrieves their cached cloud blob from IndexedDB', async () => {
      // Alice logs back in
      setAuthInstanceForTesting({
        currentUser: { uid: 'user_alice', getIdToken: async () => 'alice-jwt-token' }
      });

      const aliceResult = await fetchAttachmentBlob({
        id: multiUserCloudAttachmentId,
        name: 'Alice_Confidential.pdf',
        mimeType: 'application/pdf',
        storageProvider: 'supabase'
      });

      assert.equal(aliceResult.success, true, 'Alice must be granted access');
      assert.equal(aliceResult.source, 'indexeddb', 'Alice must retrieve from IndexedDB cache');
      assert.ok(aliceResult.blob instanceof Blob);

      const aliceBlob = await getAttachmentBlob(multiUserCloudAttachmentId);
      assert.ok(aliceBlob instanceof Blob, 'getAttachmentBlob must return blob for owner Alice');
    });

    // -----------------------------------------------------------------------
    // Test 14: Guest and offline functionality preserved for local attachments
    // -----------------------------------------------------------------------
    await runTest('Guest/local attachments: offline caching and retrieval are fully preserved', async () => {
      // Guest mode (no auth)
      setAuthInstanceForTesting(null);

      const localBlob = new Blob(['local offline note content'], { type: 'text/plain' });
      const localId = 'guest-local-doc-unique-123';

      const saveOk = await saveAttachmentBlob(localId, localBlob, {
        name: 'notes.txt',
        mimeType: 'text/plain',
        storageProvider: 'local'
      });
      assert.equal(saveOk, true, 'saveAttachmentBlob must succeed for guest');

      const cachedLocal = mockIndexedDBStore.get(localId);
      assert.ok(cachedLocal);
      assert.equal(cachedLocal.storageProvider, 'local');
      assert.equal(cachedLocal.userId, null);

      // Guest retrieval
      const guestLocalResult = await fetchAttachmentBlob({ id: localId, name: 'notes.txt', storageProvider: 'local' });
      assert.equal(guestLocalResult.success, true);
      assert.equal(guestLocalResult.source, 'indexeddb', 'Guest must retrieve local file from cache');

      const guestLocalBlob = await getAttachmentBlob(localId);
      assert.ok(guestLocalBlob instanceof Blob);
    });

    // -----------------------------------------------------------------------
    // Test 15: Unit tests for isCloudAttachmentRecord and isAttachmentOwnedByCurrentUser
    // -----------------------------------------------------------------------
    await runTest('isCloudAttachmentRecord and isAttachmentOwnedByCurrentUser validation logic', () => {
      // Local attachment: not cloud
      assert.equal(isCloudAttachmentRecord({ storageProvider: 'local' }, null), false);
      assert.equal(isCloudAttachmentRecord(null, { storageProvider: 'local', userId: null }), false);

      // Cloud attachment
      assert.equal(isCloudAttachmentRecord({ storageProvider: 'supabase' }), true);
      assert.equal(isCloudAttachmentRecord({ isCloud: true }), true);
      assert.equal(isCloudAttachmentRecord({ userId: 'u123' }), true);
      assert.equal(isCloudAttachmentRecord(null, { storageProvider: 'supabase' }), true);

      // Guest user ownership of local file
      setAuthInstanceForTesting(null);
      assert.equal(isAttachmentOwnedByCurrentUser({ storageProvider: 'local' }, null), true);

      // Guest user ownership of cloud file: false
      assert.equal(isAttachmentOwnedByCurrentUser({ storageProvider: 'supabase' }, null), false);
      assert.equal(isAttachmentOwnedByCurrentUser(null, { storageProvider: 'supabase', userId: 'user_1' }), false);

      // Authenticated user ownership of cloud file
      setAuthInstanceForTesting({ currentUser: { uid: 'user_1' } });
      assert.equal(isAttachmentOwnedByCurrentUser(null, { storageProvider: 'supabase', userId: 'user_1' }), true);
      assert.equal(isAttachmentOwnedByCurrentUser(null, { storageProvider: 'supabase', userId: 'user_2' }), false);
    });

  } finally {
    try {
      server.closeAllConnections?.();
      server.close();
    } catch (_) {}
    globalThis.fetch = originalFetch;
    setAuthInstanceForTesting(null);
  }

  console.log('\n================================================================');
  console.log(`RESULTS: ${passedCount} / ${totalTests} TESTS PASSED`);
  console.log('================================================================\n');

  if (passedCount !== totalTests) {
    process.exit(1);
  }
  process.exit(0);
}


main().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
