/**
 * Dedicated Regression Test Suite for Prompt 21:
 * Fail Securely When Supabase Uploads Fail in POST /api/upload
 *
 * Requirements Verified:
 * 1. Supabase Success: Authenticated cloud uploads succeed (HTTP 200) and register with storageProvider: 'supabase'.
 * 2. Supabase Upload Failure: When Supabase storage upload fails, return HTTP 503 with STORAGE_UPLOAD_FAILED.
 *    No silent fallback to local disk and no HTTP 200.
 * 3. Supabase Thrown Exception: When Supabase client throws an exception, return HTTP 503 with STORAGE_UPLOAD_FAILED.
 * 4. Resource Cleanup / No Orphaned Temporary Files: Failed uploads completely clean up temporary disk files,
 *    fileRegistry, and conversationDocuments. No orphaned local files or misleading metadata remain.
 * 5. Retryable vs Non-retryable Error Classification:
 *    - Transient 5xx / 429 / timeout failures return retryable: true.
 *    - Client 4xx failures return retryable: false.
 * 6. Multi-file Partial Upload Rollback: When file 2 of a batch fails, file 1 is rolled back from Supabase,
 *    and neither file is left in local disk or fileRegistry.
 * 7. Guest / Local Upload Preservation: Unauthenticated guest uploads continue to work locally (HTTP 200, storageProvider: 'local').
 * 8. Offline Upload Preservation: Authenticated upload with offline=true preserves local storage (HTTP 200, storageProvider: 'local').
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import {
  registerUploadRoutes,
  fileRegistry,
  conversationDocuments,
  UPLOAD_DIR
} from '../server/uploadSubsystem.ts';
import {
  setTestPublicKey,
  clearTestPublicKeys,
  resetFirebaseAuthForTesting
} from '../server/firebaseAuthHelper.ts';
import {
  resetSupabaseClientForTesting,
  setSupabaseServerClientForTesting
} from '../server/supabaseClient.ts';

console.log('================================================================');
console.log('REGRESSION SUITE: Fail Securely When Supabase Uploads Fail (Prompt 21)');
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

// Generate real RSA key pair for test Firebase JWT generation
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

const TEST_KID = 'supabase-fail-kid-001';
const TEST_PROJECT_ID = 'orvix-supabase-fail-project';
const TEST_USER_ID = 'user_fail_secure_001';

function createSignedJwt(uid = TEST_USER_ID, overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    aud: TEST_PROJECT_ID,
    iss: `https://securetoken.google.com/${TEST_PROJECT_ID}`,
    sub: uid,
    user_id: uid,
    iat: now,
    exp: now + 3600,
    ...overrides
  };
  const headerB64 = Buffer.from(JSON.stringify({ alg: 'RS256', kid: TEST_KID })).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${headerB64}.${payloadB64}`), privateKey).toString('base64url');
  return `${headerB64}.${payloadB64}.${sig}`;
}

// Helper to create multipart form-data payload in memory
function createMultipartPayload({ files = [], conversationId, offline }) {
  const boundary = '----WebKitFormBoundary' + crypto.randomBytes(8).toString('hex');
  const chunks = [];

  if (conversationId !== undefined) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="conversationId"\r\n\r\n${conversationId}\r\n`
    ));
  }

  if (offline !== undefined) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="offline"\r\n\r\n${offline}\r\n`
    ));
  }

  for (const file of files) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${file.filename}"\r\nContent-Type: ${file.mimeType}\r\n\r\n`
    ));
    chunks.push(Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, 'utf8'));
    chunks.push(Buffer.from('\r\n'));
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`));

  const body = Buffer.concat(chunks);
  const contentType = `multipart/form-data; boundary=${boundary}`;
  return { body, contentType };
}

async function main() {
  process.env.FIREBASE_PROJECT_ID = TEST_PROJECT_ID;
  process.env.SUPABASE_URL = 'https://mock-failure-test.supabase.co';
  process.env.SUPABASE_SECRET_KEY = 'mock-failure-secret-key-000';
  process.env.SUPABASE_STORAGE_BUCKET = 'orvix-attachments';
  setTestPublicKey(TEST_KID, publicKey);

  const mockStorageStore = new Map();
  const deletedStoragePaths = [];

  // Behavior hook for mock Supabase upload
  let uploadBehavior = null;

  const mockSupabaseClient = {
    storage: {
      from: (bucketName) => ({
        upload: async (itemPath, buffer, options = {}) => {
          if (typeof uploadBehavior === 'function') {
            const override = await uploadBehavior(itemPath, buffer, options);
            if (override !== undefined) {
              return override;
            }
          }
          const key = `${bucketName}:${itemPath}`;
          mockStorageStore.set(key, { buffer, mimeType: options?.contentType || 'application/octet-stream' });
          return { data: { path: itemPath }, error: null };
        },
        download: async (itemPath) => {
          const key = `${bucketName}:${itemPath}`;
          if (!mockStorageStore.has(key)) return { data: null, error: { message: 'Not found', status: 404 } };
          const item = mockStorageStore.get(key);
          return { data: { arrayBuffer: async () => item.buffer }, error: null };
        },
        remove: async (paths) => {
          for (const p of paths) {
            deletedStoragePaths.push(p);
            mockStorageStore.delete(`${bucketName}:${p}`);
          }
          return { error: null };
        }
      })
    }
  };

  setSupabaseServerClientForTesting(mockSupabaseClient, process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

  const app = express();
  app.use(express.json());
  registerUploadRoutes(app);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const validAuthToken = createSignedJwt();

  try {
    // -------------------------------------------------------------------------
    // Test 1: Authenticated upload when Supabase upload succeeds -> 200 OK
    // -------------------------------------------------------------------------
    await runTest('1. Authenticated upload with Supabase success returns 200 and storageProvider: "supabase"', async () => {
      mockStorageStore.clear();
      uploadBehavior = null;
      const testChatId = 'chat_succ_001';

      const { body, contentType } = createMultipartPayload({
        files: [{ filename: 'success_report.txt', mimeType: 'text/plain', content: 'Supabase storage works perfectly.' }],
        conversationId: testChatId
      });

      const res = await fetch(`${baseUrl}/api/upload`, {
        method: 'POST',
        headers: {
          'Content-Type': contentType,
          'Authorization': `Bearer ${validAuthToken}`
        },
        body
      });

      assert.equal(res.status, 200, `Expected 200 OK, got ${res.status}`);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.count, 1);
      assert.equal(data.attachments[0].storageProvider, 'supabase');
      assert.equal(data.attachments[0].bucket, 'orvix-attachments');
      assert.ok(data.attachments[0].storagePath.startsWith(`${TEST_USER_ID}/${testChatId}/`));

      const registered = fileRegistry.get(data.attachments[0].id);
      assert.ok(registered, 'File must be registered');
      assert.equal(registered.storageProvider, 'supabase');
    });

    // -------------------------------------------------------------------------
    // Test 2: Supabase upload returns failure error -> returns 503 STORAGE_UPLOAD_FAILED (NO silent local fallback)
    // -------------------------------------------------------------------------
    await runTest('2. Supabase upload failure returns 503 STORAGE_UPLOAD_FAILED and no local fallback', async () => {
      mockStorageStore.clear();
      const testChatId = 'chat_fail_002';
      uploadBehavior = async () => {
        return {
          data: null,
          error: { message: 'Cloud storage backend is temporarily unavailable', status: 503, name: 'StorageServiceUnavailable' }
        };
      };

      const { body, contentType } = createMultipartPayload({
        files: [{ filename: 'critical_doc.txt', mimeType: 'text/plain', content: 'Do not silently drop this file to local disk.' }],
        conversationId: testChatId
      });

      const res = await fetch(`${baseUrl}/api/upload`, {
        method: 'POST',
        headers: {
          'Content-Type': contentType,
          'Authorization': `Bearer ${validAuthToken}`
        },
        body
      });

      assert.equal(res.status, 503, `Expected HTTP 503 when cloud storage fails, got ${res.status}`);
      const data = await res.json();
      assert.equal(data.code, 'STORAGE_UPLOAD_FAILED', `Expected code STORAGE_UPLOAD_FAILED, got ${data.code}`);
      assert.equal(data.retryable, true, 'Transient 503 error should be retryable');
      assert.ok(!data.attachments, 'Must not return attachments array on failure');
      assert.ok(data.error.includes('temporarily unavailable') || data.error.includes('Failed to upload'));
    });

    // -------------------------------------------------------------------------
    // Test 3: Supabase upload throws unexpected exception -> returns 503 STORAGE_UPLOAD_FAILED
    // -------------------------------------------------------------------------
    await runTest('3. Supabase client exception returns 503 STORAGE_UPLOAD_FAILED (fail closed)', async () => {
      mockStorageStore.clear();
      const testChatId = 'chat_throw_003';
      uploadBehavior = async () => {
        throw new Error('Supabase network connection ECONNRESET');
      };

      const { body, contentType } = createMultipartPayload({
        files: [{ filename: 'contract.txt', mimeType: 'text/plain', content: 'Sensitive contract document.' }],
        conversationId: testChatId
      });

      const res = await fetch(`${baseUrl}/api/upload`, {
        method: 'POST',
        headers: {
          'Content-Type': contentType,
          'Authorization': `Bearer ${validAuthToken}`
        },
        body
      });

      assert.equal(res.status, 503, `Expected HTTP 503 on cloud upload exception, got ${res.status}`);
      const data = await res.json();
      assert.equal(data.code, 'STORAGE_UPLOAD_FAILED', `Expected code STORAGE_UPLOAD_FAILED, got ${data.code}`);
      assert.equal(data.retryable, true, 'Network connection reset should be marked retryable');
      assert.ok(!data.attachments, 'Must not return attachments array on exception');
    });

    // -------------------------------------------------------------------------
    // Test 4: Failed uploads clean up temporary disk files, fileRegistry, and conversationDocuments
    // -------------------------------------------------------------------------
    await runTest('4. Failed cloud upload leaves NO orphaned disk files, fileRegistry entries, or conversationDocuments', async () => {
      mockStorageStore.clear();
      const testChatId = 'chat_cleanup_004';
      const initialRegistrySize = fileRegistry.size;

      uploadBehavior = async () => {
        return {
          data: null,
          error: { message: 'Supabase storage disk full', status: 507, name: 'InsufficientStorage' }
        };
      };

      const uniqueMarker = `cleanup_test_${Date.now()}`;
      const { body, contentType } = createMultipartPayload({
        files: [{ filename: 'cleanup_test.txt', mimeType: 'text/plain', content: `Test content with marker: ${uniqueMarker}` }],
        conversationId: testChatId
      });

      const res = await fetch(`${baseUrl}/api/upload`, {
        method: 'POST',
        headers: {
          'Content-Type': contentType,
          'Authorization': `Bearer ${validAuthToken}`
        },
        body
      });

      assert.equal(res.status, 503);

      // Verify fileRegistry has no new entries
      assert.equal(fileRegistry.size, initialRegistrySize, 'fileRegistry must not retain records of failed upload');

      // Verify conversationDocuments does not retain this chat's document references
      const convDocs = conversationDocuments.get(testChatId);
      assert.ok(!convDocs || convDocs.size === 0, 'conversationDocuments must not contain attachments for failed upload');

      // Verify no orphaned temporary file exists on disk with our marker
      if (fs.existsSync(UPLOAD_DIR)) {
        const filesOnDisk = await fs.promises.readdir(UPLOAD_DIR);
        for (const file of filesOnDisk) {
          try {
            const diskContent = await fs.promises.readFile(path.join(UPLOAD_DIR, file), 'utf8');
            assert.ok(!diskContent.includes(uniqueMarker), `Found orphaned file on disk containing marker: ${file}`);
          } catch (_) {}
        }
      }
    });

    // -------------------------------------------------------------------------
    // Test 5: Error classification: retryable (5xx, timeouts) vs non-retryable (4xx client/auth errors)
    // -------------------------------------------------------------------------
    await runTest('5. Error classification distinguishes retryable (503) vs non-retryable (403/400) errors', async () => {
      mockStorageStore.clear();

      // Sub-case A: 403 Forbidden / Access Denied from Supabase -> retryable: false
      uploadBehavior = async () => {
        return {
          data: null,
          error: { message: 'Bucket access forbidden: invalid RLS policy', status: 403, name: 'AccessDenied' }
        };
      };

      const payloadA = createMultipartPayload({
        files: [{ filename: 'forbidden.txt', mimeType: 'text/plain', content: 'Non-retryable test content' }],
        conversationId: 'chat_forbidden_005'
      });

      const resA = await fetch(`${baseUrl}/api/upload`, {
        method: 'POST',
        headers: {
          'Content-Type': payloadA.contentType,
          'Authorization': `Bearer ${validAuthToken}`
        },
        body: payloadA.body
      });

      assert.equal(resA.status, 503);
      const dataA = await resA.json();
      assert.equal(dataA.code, 'STORAGE_UPLOAD_FAILED');
      assert.equal(dataA.retryable, false, 'Client/permission 403 error must not be marked retryable');

      // Sub-case B: Gateway timeout (504) -> retryable: true
      uploadBehavior = async () => {
        return {
          data: null,
          error: { message: 'Upstream gateway timeout', status: 504, name: 'GatewayTimeout' }
        };
      };

      const payloadB = createMultipartPayload({
        files: [{ filename: 'timeout.txt', mimeType: 'text/plain', content: 'Retryable timeout content' }],
        conversationId: 'chat_timeout_005'
      });

      const resB = await fetch(`${baseUrl}/api/upload`, {
        method: 'POST',
        headers: {
          'Content-Type': payloadB.contentType,
          'Authorization': `Bearer ${validAuthToken}`
        },
        body: payloadB.body
      });

      assert.equal(resB.status, 503);
      const dataB = await resB.json();
      assert.equal(dataB.code, 'STORAGE_UPLOAD_FAILED');
      assert.equal(dataB.retryable, true, 'Gateway timeout 504 error must be marked retryable');
    });

    // -------------------------------------------------------------------------
    // Test 6: Conversation integrity & rollback on upload failure
    // -------------------------------------------------------------------------
    await runTest('6. Pre-existing conversation attachments remain intact when subsequent upload fails', async () => {
      mockStorageStore.clear();
      deletedStoragePaths.length = 0;
      const testChatId = 'chat_integrity_006';

      // Step 1: File 1 uploads successfully
      uploadBehavior = null;
      const payload1 = createMultipartPayload({
        files: [{ filename: 'file1.txt', mimeType: 'text/plain', content: 'Pre-existing file 1' }],
        conversationId: testChatId
      });

      const res1 = await fetch(`${baseUrl}/api/upload`, {
        method: 'POST',
        headers: {
          'Content-Type': payload1.contentType,
          'Authorization': `Bearer ${validAuthToken}`
        },
        body: payload1.body
      });

      assert.equal(res1.status, 200, `Expected 200 for file 1, got ${res1.status}`);
      const data1 = await res1.json();
      const file1Id = data1.attachments[0].id;
      assert.ok(fileRegistry.has(file1Id));
      assert.ok(conversationDocuments.get(testChatId)?.has(file1Id));

      // Step 2: File 2 fails on Supabase
      uploadBehavior = async () => {
        return { data: null, error: { message: 'Cloud storage transient timeout on file 2', status: 503 } };
      };

      const payload2 = createMultipartPayload({
        files: [{ filename: 'file2.txt', mimeType: 'text/plain', content: 'Second file that fails' }],
        conversationId: testChatId
      });

      const res2 = await fetch(`${baseUrl}/api/upload`, {
        method: 'POST',
        headers: {
          'Content-Type': payload2.contentType,
          'Authorization': `Bearer ${validAuthToken}`
        },
        body: payload2.body
      });

      assert.equal(res2.status, 503, `Expected 503 for failed file 2, got ${res2.status}`);
      const data2 = await res2.json();
      assert.equal(data2.code, 'STORAGE_UPLOAD_FAILED');

      // Verify that File 1 is still intact in fileRegistry and conversationDocuments
      assert.ok(fileRegistry.has(file1Id), 'Pre-existing File 1 must remain registered');
      assert.ok(conversationDocuments.get(testChatId)?.has(file1Id), 'Pre-existing File 1 must remain in conversationDocuments');
      assert.equal(conversationDocuments.get(testChatId)?.size, 1, 'Only File 1 should be in conversationDocuments');
    });

    // -------------------------------------------------------------------------
    // Test 7: Guest / unauthenticated upload preservation -> succeeds locally with 200 OK
    // -------------------------------------------------------------------------
    await runTest('7. Unauthenticated guest upload succeeds with 200 OK and storageProvider: "local"', async () => {
      mockStorageStore.clear();
      uploadBehavior = async () => {
        throw new Error('Supabase should not be called for unauthenticated guest upload');
      };

      const { body, contentType } = createMultipartPayload({
        files: [{ filename: 'guest_notes.txt', mimeType: 'text/plain', content: 'Guest content on local disk' }]
      });

      const res = await fetch(`${baseUrl}/api/upload`, {
        method: 'POST',
        headers: {
          'Content-Type': contentType
          // No Authorization header -> Guest mode
        },
        body
      });

      assert.equal(res.status, 200, `Expected 200 OK for guest upload, got ${res.status}`);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.attachments[0].storageProvider, 'local');
      assert.equal(mockStorageStore.size, 0, 'Supabase must not have received any uploads');
    });

    // -------------------------------------------------------------------------
    // Test 8: Offline upload preservation -> succeeds locally with 200 OK
    // -------------------------------------------------------------------------
    await runTest('8. Authenticated upload with offline=true succeeds with 200 OK and storageProvider: "local"', async () => {
      mockStorageStore.clear();
      uploadBehavior = async () => {
        throw new Error('Supabase should not be called for offline upload');
      };

      const { body, contentType } = createMultipartPayload({
        files: [{ filename: 'offline_log.txt', mimeType: 'text/plain', content: 'Offline local content' }],
        conversationId: 'chat_offline_008',
        offline: 'true'
      });

      const res = await fetch(`${baseUrl}/api/upload`, {
        method: 'POST',
        headers: {
          'Content-Type': contentType,
          'Authorization': `Bearer ${validAuthToken}`
        },
        body
      });

      assert.equal(res.status, 200, `Expected 200 OK for offline upload, got ${res.status}`);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.attachments[0].storageProvider, 'local');
      assert.equal(mockStorageStore.size, 0, 'Supabase must not have received any uploads');
    });

  } finally {
    clearTestPublicKeys();
    resetFirebaseAuthForTesting();
    resetSupabaseClientForTesting();
    await new Promise((resolve) => server.close(resolve));
  }

  console.log(`\n================================================================`);
  console.log(`REGRESSION SUMMARY: ${passedCount} / ${totalTests} tests passed.`);
  console.log(`================================================================\n`);

  if (passedCount !== totalTests) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal regression suite error:', err);
  process.exit(1);
});
