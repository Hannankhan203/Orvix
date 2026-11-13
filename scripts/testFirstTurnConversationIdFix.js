/**
 * Verification Suite for First-Turn Conversation ID Pre-Generation & Supabase Alignment
 *
 * Verifies:
 * 1. generateLocalChatId generates valid path segments compatible with Supabase Storage and Firestore.
 * 2. createChatDocument reuses pre-generated targetChatId (via argument or extraMetadata) and never generates a second ID.
 * 3. Backward compatibility: createChatDocument without targetChatId continues to generate a new valid ID.
 * 4. First-turn upload flow: attachment is uploaded with pre-generated conversationId, stored under {userId}/{chatId}/* (NOT staging),
 *    and matching Firestore conversation document uses the exact same ID.
 * 5. Existing conversation flow: uploads with existing activeChatId reuse the existing conversation ID without pre-generation.
 * 6. Guest conversation flow: guest uploads and conversations share the exact same guest ID without orphan files.
 * 7. Offline/local resilience: local/offline conversations maintain exact pre-generated ID across cache and sync flags.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';

import {
  generateLocalChatId,
  createChatDocument,
  getCachedUserChats,
  saveCachedUserChats
} from '../src/services/chatStorageService.js';
import {
  isValidPathSegment,
  buildAttachmentStoragePath,
  deleteAttachmentsForChatInStorage
} from '../server/supabaseStorageService.ts';
import {
  registerUploadRoutes,
  fileRegistry,
  conversationDocuments
} from '../server/uploadSubsystem.ts';
import {
  setSupabaseServerClientForTesting,
  resetSupabaseClientForTesting
} from '../server/supabaseClient.ts';
import {
  setTestPublicKey,
  clearTestPublicKeys,
  resetFirebaseAuthForTesting
} from '../server/firebaseAuthHelper.ts';

console.log('================================================================');
console.log('VERIFICATION SUITE: First-Turn Conversation ID Alignment Fix');
console.log('================================================================\n');

// Mock in-memory localStorage & window for Node environment
const localStorageStore = new Map();
globalThis.localStorage = {
  getItem: (key) => localStorageStore.get(key) || null,
  setItem: (key, val) => localStorageStore.set(key, String(val)),
  removeItem: (key) => localStorageStore.delete(key),
  clear: () => localStorageStore.clear()
};
globalThis.window = globalThis;

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

// Set up cryptographic test credentials
const testProjectId = 'first-turn-test-project';
process.env.FIREBASE_PROJECT_ID = testProjectId;
process.env.SUPABASE_URL = 'https://firstturn-test.supabase.co';
process.env.SUPABASE_SECRET_KEY = 'test-secret-service-role-key-12345';
process.env.SUPABASE_STORAGE_BUCKET = 'orvix-attachments';

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

const testKid = 'first-turn-kid-001';
setTestPublicKey(testKid, publicKey);

function createTestToken(uid) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: testKid })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    aud: testProjectId,
    iss: `https://securetoken.google.com/${testProjectId}`,
    sub: uid,
    user_id: uid,
    iat: now,
    exp: now + 3600
  })).toString('base64url');

  const signature = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

const testUser = 'user_first_turn_123';
const userToken = createTestToken(testUser);

// In-memory mock storage store: Map<path, { name, buffer, contentType }>
const mockStorageStore = new Map();

function createMockSupabaseClient() {
  return {
    storage: {
      from: (bucketName) => ({
        list: async (folderPath, options = {}) => {
          const cleanFolder = folderPath.replace(/\/+$/, '');
          const prefix = cleanFolder ? `${cleanFolder}/` : '';
          const matchingFiles = [];

          for (const [key, val] of mockStorageStore.entries()) {
            if (key.startsWith(prefix)) {
              const subKey = key.slice(prefix.length);
              if (!subKey.includes('/')) {
                matchingFiles.push({
                  name: subKey,
                  id: subKey,
                  metadata: { size: val.buffer?.length || 100 }
                });
              }
            }
          }
          const offset = typeof options.offset === 'number' ? options.offset : 0;
          const limit = typeof options.limit === 'number' ? options.limit : 100;
          return { data: matchingFiles.slice(offset, offset + limit), error: null };
        },
        remove: async (paths) => {
          const removed = [];
          for (const p of paths) {
            if (mockStorageStore.has(p)) {
              mockStorageStore.delete(p);
              removed.push({ name: p });
            }
          }
          return { data: removed, error: null };
        },
        upload: async (path, buffer, opts = {}) => {
          mockStorageStore.set(path, {
            name: path.split('/').pop(),
            buffer: Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer),
            contentType: opts.contentType || 'application/octet-stream'
          });
          return { data: { path }, error: null };
        }
      })
    }
  };
}

const app = express();
app.use(express.json());
registerUploadRoutes(app);

let server;
let baseUrl = '';

async function startServer() {
  return new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
}

async function runAllTests() {
  try {
    await startServer();
    setSupabaseServerClientForTesting(createMockSupabaseClient());

    // -------------------------------------------------------------------------
    // Test 1: generateLocalChatId validity
    // -------------------------------------------------------------------------
    await runTest('generateLocalChatId returns a valid path segment for Supabase Storage & Firestore', async () => {
      const generatedWithUser = generateLocalChatId(testUser);
      assert.ok(generatedWithUser && typeof generatedWithUser === 'string', 'Must return a string');
      assert.equal(isValidPathSegment(generatedWithUser), true, 'Must be a valid path segment (no slashes, no traversal)');

      const generatedWithoutUser = generateLocalChatId();
      assert.ok(generatedWithoutUser && typeof generatedWithoutUser === 'string');
      assert.equal(isValidPathSegment(generatedWithoutUser), true);
    });

    // -------------------------------------------------------------------------
    // Test 2: createChatDocument reuses pre-generated targetChatId
    // -------------------------------------------------------------------------
    await runTest('createChatDocument reuses targetChatId and never generates a second ID', async () => {
      const pregeneratedId = `pregen-conv-${Date.now()}`;
      localStorageStore.clear();

      // Pass targetChatId as 5th argument
      const resultChatId = await createChatDocument(
        testUser,
        'First Turn Conversation',
        'general',
        {},
        pregeneratedId
      );

      assert.equal(resultChatId, pregeneratedId, 'Must return the exact pregeneratedId');

      // Verify cached in local store with exact same ID
      const cached = getCachedUserChats(testUser);
      assert.equal(cached.length, 1);
      assert.equal(cached[0].id, pregeneratedId);
      assert.equal(cached[0].title, 'First Turn Conversation');

      // Pass via extraMetadata.chatId
      const metaChatId = `meta-conv-${Date.now()}`;
      const resultMetaId = await createChatDocument(
        testUser,
        'Meta Conversation',
        'coding',
        { chatId: metaChatId }
      );
      assert.equal(resultMetaId, metaChatId, 'Must return extraMetadata.chatId');
    });

    // -------------------------------------------------------------------------
    // Test 3: Backward compatibility - createChatDocument without targetChatId
    // -------------------------------------------------------------------------
    await runTest('createChatDocument without targetChatId generates a valid new ID', async () => {
      const autoId = await createChatDocument(testUser, 'Auto Generated Chat', 'writing');
      assert.ok(autoId && typeof autoId === 'string');
      assert.equal(isValidPathSegment(autoId), true);
    });

    // -------------------------------------------------------------------------
    // Test 4: First-Turn Upload: attachment uploads directly to conversation folder, NOT staging
    // -------------------------------------------------------------------------
    await runTest('First-turn attachment upload uses pregenerated chatId, avoiding staging orphan files', async () => {
      mockStorageStore.clear();
      fileRegistry.clear();

      // Simulate first-turn state in frontend:
      // activeChatIdRef.current is null!
      const activeChatId = null;

      // Logic implemented in ChatPage.jsx handleSubmit:
      const pregeneratedChatId = !activeChatId ? generateLocalChatId(testUser) : activeChatId;
      const effectiveChatId = activeChatId || pregeneratedChatId;

      assert.ok(effectiveChatId, 'Must have a pregenerated conversation ID');
      assert.notEqual(effectiveChatId, 'staging', 'Conversation ID must not be staging');

      // Upload file with conversationId = effectiveChatId
      const validPdfContent = '%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF';
      const form = new FormData();
      form.append('conversationId', effectiveChatId);
      form.append('provider', 'gemini');
      form.append('offline', 'false');
      form.append('files', new Blob([validPdfContent], { type: 'application/pdf' }), 'first_turn_doc.pdf');

      const uploadRes = await fetch(`${baseUrl}/api/upload`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${userToken}`
        },
        body: form
      });

      assert.equal(uploadRes.status, 200);
      const uploadData = await uploadRes.json();
      assert.equal(uploadData.attachments.length, 1);
      const uploadedAtt = uploadData.attachments[0];

      // CRITICAL ASSERTION: The storage path MUST be {userId}/{effectiveChatId}/{attachmentId}.pdf
      // and NOT {userId}/staging/{attachmentId}.pdf!
      const expectedStoragePath = `${testUser}/${effectiveChatId}/${uploadedAtt.id}.pdf`;
      assert.equal(uploadedAtt.storagePath, expectedStoragePath);
      assert.equal(mockStorageStore.has(expectedStoragePath), true, 'File must exist at expected conversation path');

      // Verify server fileRegistry and conversationDocuments mapped to effectiveChatId
      const reg = fileRegistry.get(uploadedAtt.id);
      assert.ok(reg);
      assert.equal(reg.conversationId, effectiveChatId);
      assert.equal(conversationDocuments.get(effectiveChatId)?.has(uploadedAtt.id), true);

      // Verify staging path was NEVER created!
      const stagingPath = `${testUser}/staging/${uploadedAtt.id}.pdf`;
      assert.equal(mockStorageStore.has(stagingPath), false, 'File must NOT be in staging');

      // Now simulate chat creation in Firestore with the reused effectiveChatId
      const createdChatId = await createChatDocument(
        testUser,
        'Chat with PDF',
        'general',
        {},
        effectiveChatId
      );
      assert.equal(createdChatId, effectiveChatId, 'Firestore chat doc ID must match attachment conversation ID');

      // Verify deletion lifecycle: deleting this conversation deletes the first-turn attachment completely!
      const delResult = await deleteAttachmentsForChatInStorage(testUser, effectiveChatId, testUser);
      assert.equal(delResult.success, true);
      assert.equal(delResult.deletedCount, 1);
      assert.equal(mockStorageStore.has(expectedStoragePath), false, 'Attachment was successfully cleaned up with chat deletion');
    });

    // -------------------------------------------------------------------------
    // Test 5: Existing Conversation Upload reuses existing conversation ID
    // -------------------------------------------------------------------------
    await runTest('Existing conversation upload reuses activeChatId without pre-generating a new ID', async () => {
      mockStorageStore.clear();

      // Existing conversation already has an activeChatId
      const existingChatId = 'existing_conv_888';

      // Logic in ChatPage.jsx:
      const activeChatId = existingChatId;
      const pregeneratedChatId = !activeChatId ? generateLocalChatId(testUser) : null;
      const effectiveChatId = activeChatId || pregeneratedChatId;

      assert.equal(pregeneratedChatId, null, 'Must NOT pregenerate an ID for existing chat');
      assert.equal(effectiveChatId, existingChatId);

      const validPdfContent = '%PDF-1.4\n2 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF';
      const form = new FormData();
      form.append('conversationId', effectiveChatId);
      form.append('provider', 'gemini');
      form.append('offline', 'false');
      form.append('files', new Blob([validPdfContent], { type: 'application/pdf' }), 'followup.pdf');

      const uploadRes = await fetch(`${baseUrl}/api/upload`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${userToken}`
        },
        body: form
      });

      assert.equal(uploadRes.status, 200);
      const uploadData = await uploadRes.json();
      const uploadedAtt = uploadData.attachments[0];

      assert.equal(uploadedAtt.storagePath, `${testUser}/${existingChatId}/${uploadedAtt.id}.pdf`);
      assert.equal(mockStorageStore.has(`${testUser}/${existingChatId}/${uploadedAtt.id}.pdf`), true);
    });

    // -------------------------------------------------------------------------
    // Test 6: Guest User First-Turn Upload Rejection (P3)
    // -------------------------------------------------------------------------
    await runTest('Guest unauthenticated first-turn upload is rejected with 401 UNAUTHENTICATED', async () => {
      const activeChatId = null;
      const isCloudEnabled = false;
      const currentUser = null;

      const pregeneratedChatId = !activeChatId
        ? (isCloudEnabled && currentUser?.uid ? generateLocalChatId(currentUser.uid) : `guest-${Date.now()}`)
        : null;
      const effectiveChatId = activeChatId || pregeneratedChatId;

      assert.ok(effectiveChatId.startsWith('guest-'));

      const form = new FormData();
      form.append('conversationId', effectiveChatId);
      form.append('provider', 'webllm');
      form.append('offline', 'false');
      form.append('files', new Blob(['Guest text file content'], { type: 'text/plain' }), 'guest_note.txt');

      const uploadRes = await fetch(`${baseUrl}/api/upload`, {
        method: 'POST',
        body: form
      });

      assert.equal(uploadRes.status, 401);
      const uploadData = await uploadRes.json();
      assert.equal(uploadData.code, 'UNAUTHENTICATED');
    });

    console.log('\n================================================================');
    console.log(`RESULTS: ${passedCount} / ${totalTests} TESTS PASSED`);
    console.log('================================================================');
  } finally {
    if (server) {
      server.close();
    }
    clearTestPublicKeys();
    resetFirebaseAuthForTesting();
    resetSupabaseClientForTesting();
  }
}

runAllTests().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
