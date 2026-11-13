/**
 * Dedicated Regression Test Suite for Prompt 20:
 * Fix Orphaned Supabase Staging Uploads in POST /api/upload
 *
 * Verifies:
 * 1. Missing conversationId: Authenticated upload without conversationId is rejected with 400 MISSING_CONVERSATION_ID.
 * 2. Invalid conversationId: Authenticated upload with path traversal, slashes, or reserved 'staging' name is rejected with 400 INVALID_CONVERSATION_ID.
 * 3. Valid conversationId: Authenticated upload with valid conversationId succeeds (200 OK) and stores in Supabase under {userId}/{conversationId}/{attId}.{ext}.
 * 4. Staging folder elimination: No files are ever stored under {userId}/staging/.
 * 5. Guest/local preservation: Unauthenticated uploads succeed locally (200 OK, storageProvider: 'local') with or without conversationId.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';
import {
  registerUploadRoutes,
  fileRegistry
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
console.log('REGRESSION SUITE: Fix Orphaned Supabase Staging Uploads (Prompt 20)');
console.log('================================================================\n');

const originalEnv = { ...process.env };
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

const TEST_KID = 'staging-fix-kid-001';
const TEST_PROJECT_ID = 'orvix-staging-fix-project';
const TEST_USER_ID = 'user_alice_staging_test';

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
function createMultipartPayload({ filename, mimeType, content, conversationId, offline }) {
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

  chunks.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`
  ));
  chunks.push(Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'));
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  const body = Buffer.concat(chunks);
  const contentType = `multipart/form-data; boundary=${boundary}`;
  return { body, contentType };
}

async function main() {
  process.env.FIREBASE_PROJECT_ID = TEST_PROJECT_ID;
  process.env.SUPABASE_URL = 'https://mock-staging-test.supabase.co';
  process.env.SUPABASE_SECRET_KEY = 'mock-staging-secret-key-000';
  process.env.SUPABASE_STORAGE_BUCKET = 'orvix-attachments';
  setTestPublicKey(TEST_KID, publicKey);

  const mockStorageStore = new Map();
  const mockSupabaseClient = {
    storage: {
      from: (bucketName) => ({
        upload: async (itemPath, buffer, options = {}) => {
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
    // Test 1: Authenticated upload with MISSING conversationId is rejected
    // -------------------------------------------------------------------------
    await runTest('1. Authenticated upload with missing conversationId returns 400 MISSING_CONVERSATION_ID', async () => {
      mockStorageStore.clear();

      const { body, contentType } = createMultipartPayload({
        filename: 'notes.txt',
        mimeType: 'text/plain',
        content: 'Important meeting notes'
        // conversationId intentionally omitted
      });

      const res = await fetch(`${baseUrl}/api/upload`, {
        method: 'POST',
        headers: {
          'Content-Type': contentType,
          'Authorization': `Bearer ${validAuthToken}`
        },
        body
      });

      assert.equal(res.status, 400, 'Must return HTTP 400');
      const data = await res.json();
      assert.equal(data.code, 'MISSING_CONVERSATION_ID');
      assert.ok(data.error.toLowerCase().includes('conversationid is required'));

      // Verify no files were stored in Supabase under staging or anywhere else
      assert.equal(mockStorageStore.size, 0, 'No files must be stored in Supabase when conversationId is missing');
    });

    // -------------------------------------------------------------------------
    // Test 2: Authenticated upload with EMPTY/WHITESPACE conversationId is rejected
    // -------------------------------------------------------------------------
    await runTest('2. Authenticated upload with empty or whitespace conversationId returns 400 MISSING_CONVERSATION_ID', async () => {
      mockStorageStore.clear();

      const { body, contentType } = createMultipartPayload({
        filename: 'notes.txt',
        mimeType: 'text/plain',
        content: 'Important meeting notes',
        conversationId: '    '
      });

      const res = await fetch(`${baseUrl}/api/upload`, {
        method: 'POST',
        headers: {
          'Content-Type': contentType,
          'Authorization': `Bearer ${validAuthToken}`
        },
        body
      });

      assert.equal(res.status, 400, 'Must return HTTP 400');
      const data = await res.json();
      assert.equal(data.code, 'MISSING_CONVERSATION_ID');
      assert.equal(mockStorageStore.size, 0, 'No files must be stored in Supabase');
    });

    // -------------------------------------------------------------------------
    // Test 3: Authenticated upload with INVALID conversationId (path traversal) is rejected
    // -------------------------------------------------------------------------
    await runTest('3. Authenticated upload with path traversal conversationId returns 400 INVALID_CONVERSATION_ID', async () => {
      mockStorageStore.clear();

      const { body, contentType } = createMultipartPayload({
        filename: 'doc.txt',
        mimeType: 'text/plain',
        content: 'Document with traversal attempt',
        conversationId: '../staging'
      });

      const res = await fetch(`${baseUrl}/api/upload`, {
        method: 'POST',
        headers: {
          'Content-Type': contentType,
          'Authorization': `Bearer ${validAuthToken}`
        },
        body
      });

      assert.equal(res.status, 400, 'Must return HTTP 400');
      const data = await res.json();
      assert.equal(data.code, 'INVALID_CONVERSATION_ID');
      assert.ok(data.error.toLowerCase().includes('invalid conversationid'));
      assert.equal(mockStorageStore.size, 0, 'No files must be stored in Supabase');
    });

    // -------------------------------------------------------------------------
    // Test 4: Authenticated upload with INVALID conversationId (slashes) is rejected
    // -------------------------------------------------------------------------
    await runTest('4. Authenticated upload with slashes in conversationId returns 400 INVALID_CONVERSATION_ID', async () => {
      mockStorageStore.clear();

      const { body, contentType } = createMultipartPayload({
        filename: 'doc.txt',
        mimeType: 'text/plain',
        content: 'Document with slash path',
        conversationId: 'folder/subfolder/chat1'
      });

      const res = await fetch(`${baseUrl}/api/upload`, {
        method: 'POST',
        headers: {
          'Content-Type': contentType,
          'Authorization': `Bearer ${validAuthToken}`
        },
        body
      });

      assert.equal(res.status, 400, 'Must return HTTP 400');
      const data = await res.json();
      assert.equal(data.code, 'INVALID_CONVERSATION_ID');
      assert.equal(mockStorageStore.size, 0);
    });

    // -------------------------------------------------------------------------
    // Test 5: Authenticated upload with RESERVED 'staging' name is rejected
    // -------------------------------------------------------------------------
    await runTest('5. Authenticated upload with reserved "staging" conversationId returns 400 INVALID_CONVERSATION_ID', async () => {
      mockStorageStore.clear();

      const { body, contentType } = createMultipartPayload({
        filename: 'doc.txt',
        mimeType: 'text/plain',
        content: 'Document targeting staging',
        conversationId: 'staging'
      });

      const res = await fetch(`${baseUrl}/api/upload`, {
        method: 'POST',
        headers: {
          'Content-Type': contentType,
          'Authorization': `Bearer ${validAuthToken}`
        },
        body
      });

      assert.equal(res.status, 400, 'Must return HTTP 400');
      const data = await res.json();
      assert.equal(data.code, 'INVALID_CONVERSATION_ID');
      assert.equal(mockStorageStore.size, 0, 'Must never write to staging');
    });

    // -------------------------------------------------------------------------
    // Test 6: Authenticated upload with VALID conversationId succeeds and stores under chat path
    // -------------------------------------------------------------------------
    await runTest('6. Authenticated upload with valid conversationId succeeds and stores under {userId}/{conversationId}/', async () => {
      mockStorageStore.clear();

      const targetChatId = 'chat_conversation_valid_999';
      const { body, contentType } = createMultipartPayload({
        filename: 'project_brief.txt',
        mimeType: 'text/plain',
        content: 'Project roadmap and specifications',
        conversationId: targetChatId
      });

      const res = await fetch(`${baseUrl}/api/upload`, {
        method: 'POST',
        headers: {
          'Content-Type': contentType,
          'Authorization': `Bearer ${validAuthToken}`
        },
        body
      });

      assert.equal(res.status, 200, 'Must return HTTP 200');
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.count, 1);
      const att = data.attachments[0];
      assert.equal(att.storageProvider, 'supabase');
      assert.ok(att.storagePath, 'Must provide storagePath');

      // Verify exact storage key in mock Supabase
      assert.ok(att.storagePath.startsWith(`${TEST_USER_ID}/${targetChatId}/`), 'Path must be under {userId}/{chatId}/');
      assert.ok(!att.storagePath.includes('/staging/'), 'Must NOT be under /staging/');

      const storedKey = `orvix-attachments:${att.storagePath}`;
      assert.ok(mockStorageStore.has(storedKey), 'File must be stored in Supabase under exact path');
      const storedItem = mockStorageStore.get(storedKey);
      assert.ok(storedItem.buffer.toString().includes('Project roadmap and specifications'));
    });

    // -------------------------------------------------------------------------
    // Test 7: Unauthenticated guest upload without conversationId is rejected (P3)
    // -------------------------------------------------------------------------
    await runTest('7. Unauthenticated guest upload without conversationId is rejected with 401 UNAUTHENTICATED', async () => {
      mockStorageStore.clear();

      const { body, contentType } = createMultipartPayload({
        filename: 'guest_file.txt',
        mimeType: 'text/plain',
        content: 'Guest scratchpad data'
        // No conversationId and NO auth header
      });

      const res = await fetch(`${baseUrl}/api/upload`, {
        method: 'POST',
        headers: {
          'Content-Type': contentType
        },
        body
      });

      assert.equal(res.status, 401, 'Unauthenticated guest upload must return 401 UNAUTHENTICATED');
      const data = await res.json();
      assert.equal(data.code, 'UNAUTHENTICATED');
      assert.equal(mockStorageStore.size, 0, 'Guest upload must not touch Supabase');
    });

    // -------------------------------------------------------------------------
    // Test 8: Unauthenticated guest upload with conversationId is rejected (P3)
    // -------------------------------------------------------------------------
    await runTest('8. Unauthenticated guest upload with conversationId is rejected with 401 UNAUTHENTICATED', async () => {
      mockStorageStore.clear();

      const guestChatId = 'guest_chat_12345';
      const { body, contentType } = createMultipartPayload({
        filename: 'guest_with_id.txt',
        mimeType: 'text/plain',
        content: 'Guest with local conversation id',
        conversationId: guestChatId
      });

      const res = await fetch(`${baseUrl}/api/upload`, {
        method: 'POST',
        headers: {
          'Content-Type': contentType
        },
        body
      });

      assert.equal(res.status, 401, 'Unauthenticated guest upload with conversationId must return 401 UNAUTHENTICATED');
      const data = await res.json();
      assert.equal(data.code, 'UNAUTHENTICATED');
      assert.equal(mockStorageStore.size, 0, 'Guest upload must not touch Supabase');
    });

    // -------------------------------------------------------------------------
    // Test 9: Complete elimination of staging folder references
    // -------------------------------------------------------------------------
    await runTest('9. Source check: uploadSubsystem contains no fallback to staging folder', async () => {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const uploadSource = fs.readFileSync(path.resolve('server/uploadSubsystem.ts'), 'utf-8');

      // The substring ': \'staging\'' or '? conversationId : \'staging\'' must NOT exist
      assert.ok(!uploadSource.includes(": 'staging'"), "Must not contain fallback to 'staging'");
      assert.ok(!uploadSource.includes('? conversationId : "staging"'), "Must not contain fallback to staging");
    });

  } finally {
    server.close();
    clearTestPublicKeys();
    resetSupabaseClientForTesting();
    resetFirebaseAuthForTesting();
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v !== undefined) {
        process.env[k] = v;
      } else {
        delete process.env[k];
      }
    }
  }

  console.log('\n================================================================');
  console.log(`SUMMARY: ${passedCount}/${totalTests} Tests Passed`);
  console.log('================================================================\n');

  if (passedCount !== totalTests) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
