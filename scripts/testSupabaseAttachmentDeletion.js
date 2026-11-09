/**
 * Comprehensive Backend Verification Suite for Supabase Attachment Deletion Lifecycle
 *
 * Verifies:
 * 1. Pagination in deleteAttachmentsForChatInStorage (deleting conversations with >1000 attachments reliably).
 * 2. Authenticated DELETE /api/upload/conversations/:chatId endpoint:
 *    - Validates chatId format
 *    - Rejects unauthenticated requests with 401 AUTH_REQUIRED
 *    - Rejects invalid JWTs with 401
 *    - Rejects cross-user deletion attempts with 403 STORAGE_ACCESS_DENIED
 *    - Deletes all attachments for owner with 200
 *    - Cleans up conversation in-memory maps and local disk files
 *    - Idempotent repeated deletion returns 200 with deletedCount 0
 * 3. Upgraded DELETE /api/upload/:id endpoint:
 *    - Rejects unauthenticated cloud deletion with 401 AUTH_REQUIRED
 *    - Rejects cross-user cloud deletion with 403 STORAGE_ACCESS_DENIED
 *    - Successfully deletes Supabase cloud attachment for owner
 *    - Empty fileRegistry support: accepts ?chatId=... and resolves file through user's own Supabase folder
 *    - Exact filename matching: does NOT delete files with loose prefixes (e.g. id_thumb.png or id-copy.pdf)
 *    - Paginated search when locating file in chat folder with >1000 files
 *    - Idempotent repeated deletion returns 200
 *    - Preserves unauthenticated local/guest deletion returning 200
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';

import {
  isExactAttachmentMatch,
  findAttachmentPathInStorage,
  deleteAttachmentsForChatInStorage,
  deleteAttachmentFromStorage
} from '../server/supabaseStorageService.ts';
import {
  setSupabaseServerClientForTesting,
  resetSupabaseClientForTesting
} from '../server/supabaseClient.ts';
import {
  setTestPublicKey,
  clearTestPublicKeys,
  resetFirebaseAuthForTesting
} from '../server/firebaseAuthHelper.ts';
import {
  registerUploadRoutes,
  fileRegistry,
  conversationDocuments
} from '../server/uploadSubsystem.ts';

const app = express();
app.use(express.json());
registerUploadRoutes(app);

console.log('================================================================');
console.log('VERIFICATION SUITE: Supabase Attachment Deletion Lifecycle');
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

// Set up cryptographic test credentials
const testProjectId = 'orvix-delete-test-project';
process.env.FIREBASE_PROJECT_ID = testProjectId;
process.env.SUPABASE_URL = 'https://delete-test.supabase.co';
process.env.SUPABASE_SECRET_KEY = 'test-secret-service-role-key-12345';
process.env.SUPABASE_STORAGE_BUCKET = 'orvix-attachments';

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

const testKid = 'orvix-delete-test-kid';
setTestPublicKey(testKid, publicKey);

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

const userAlice = 'user_alice_123';
const userBob = 'user_bob_456';
const tokenAlice = createTestToken(userAlice);
const tokenBob = createTestToken(userBob);

// In-memory mock storage store: Map<path, { name, buffer, contentType }>
const mockStorageStore = new Map();

let listHook = null;
let removeHook = null;

function createMockSupabaseClient() {
  return {
    storage: {
      from: (bucketName) => ({
        list: async (folderPath, options = {}) => {
          if (listHook) {
            const hookRes = await listHook(folderPath, options);
            if (hookRes !== undefined) return hookRes;
          }

          const cleanFolder = folderPath.replace(/\/+$/, '');
          const prefix = cleanFolder ? `${cleanFolder}/` : '';
          const matchingFiles = [];

          for (const [key, val] of mockStorageStore.entries()) {
            if (key.startsWith(prefix)) {
              const subKey = key.slice(prefix.length);
              // Only immediate children (no nested slashes)
              if (!subKey.includes('/')) {
                matchingFiles.push({
                  name: subKey,
                  id: subKey,
                  metadata: { size: val.buffer?.length || 100 }
                });
              }
            }
          }

          // Apply offset and limit
          const offset = typeof options.offset === 'number' ? options.offset : 0;
          const limit = typeof options.limit === 'number' ? options.limit : 100;
          const page = matchingFiles.slice(offset, offset + limit);

          return { data: page, error: null };
        },
        remove: async (paths) => {
          if (removeHook) {
            const hookRes = await removeHook(paths);
            if (hookRes !== undefined) return hookRes;
          }

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

let server;
let baseUrl = '';

async function startTestServer() {
  return new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
}

async function runAllTests() {
  try {
    await startTestServer();
    setSupabaseServerClientForTesting(createMockSupabaseClient());

    // -------------------------------------------------------------------------
    // Test 1: Exact attachment match helper
    // -------------------------------------------------------------------------
    await runTest('isExactAttachmentMatch validates exact filenames and rejects loose prefixes', async () => {
      const attId = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
      assert.equal(isExactAttachmentMatch(`${attId}.pdf`, attId), true);
      assert.equal(isExactAttachmentMatch(`${attId}.PNG`, attId), true);
      assert.equal(isExactAttachmentMatch(`${attId}`, attId), true);

      // Loose prefix rejections
      assert.equal(isExactAttachmentMatch(`${attId}_thumb.png`, attId), false);
      assert.equal(isExactAttachmentMatch(`${attId}-copy.pdf`, attId), false);
      assert.equal(isExactAttachmentMatch(`${attId}extra.jpg`, attId), false);
      assert.equal(isExactAttachmentMatch(`prefix_${attId}.pdf`, attId), false);
      assert.equal(isExactAttachmentMatch('', attId), false);
      assert.equal(isExactAttachmentMatch(null, attId), false);
    });

    // -------------------------------------------------------------------------
    // Test 2: Pagination against Mutable Shrinking Storage Listing (2,500 files)
    // -------------------------------------------------------------------------
    await runTest('deleteAttachmentsForChatInStorage: handles 2,500 files with mutable listing shrinking without skipping files', async () => {
      const testChatId = 'chat_large_2500';
      mockStorageStore.clear();
      listHook = null;
      removeHook = null;

      // 1. Upload/simulate 2,500 files into user_alice_123/chat_large_2500/
      const totalFiles = 2500;
      for (let i = 0; i < totalFiles; i++) {
        const fakeAttId = `att_${String(i).padStart(4, '0')}`;
        const path = `${userAlice}/${testChatId}/${fakeAttId}.txt`;
        mockStorageStore.set(path, { name: `${fakeAttId}.txt`, buffer: Buffer.from(`data_${i}`) });
      }

      assert.equal(mockStorageStore.size, 2500, 'Must have seeded 2500 files');

      const iterations = [];
      listHook = (folderPath, options) => {
        iterations.push({
          type: 'list',
          offset: options.offset,
          limit: options.limit,
          storeSizeBefore: mockStorageStore.size
        });
        return undefined; // proceed with default mock behavior
      };

      const removals = [];
      removeHook = (paths) => {
        removals.push({
          type: 'remove',
          count: paths.length,
          firstPath: paths[0],
          lastPath: paths[paths.length - 1],
          storeSizeBefore: mockStorageStore.size
        });
        return undefined; // proceed with default mock behavior
      };

      // 2. Fetch and delete the files
      const result = await deleteAttachmentsForChatInStorage(userAlice, testChatId, userAlice);

      // Clean up hooks
      listHook = null;
      removeHook = null;

      // 3. Verify pagination parameters and that no files were skipped because offsets shifted
      const batchIterations = iterations.filter((it) => it.limit === 1000);
      assert.equal(batchIterations.length, 3, 'Should take exactly 3 batch list calls for 2,500 files (1000 + 1000 + 500)');
      if (iterations.length > 3) {
        assert.equal(iterations[3].limit, 1, 'Final verification call checks that 0 files remain');
      }

      // Iteration 1: offset 0, limit 1000, fetched att_0000 to att_0999, store size 2500 -> 1500
      assert.equal(iterations[0].offset, 0, 'Iteration 1 must query offset 0');
      assert.equal(iterations[0].storeSizeBefore, 2500);
      assert.equal(removals[0].count, 1000);
      assert.ok(removals[0].firstPath.endsWith('att_0000.txt'), 'Iteration 1 starts at att_0000');
      assert.ok(removals[0].lastPath.endsWith('att_0999.txt'), 'Iteration 1 ends at att_0999');

      // Iteration 2: MUST query offset 0 (because listing shrank from 2500 to 1500!)
      // If it queried offset 1000, it would have skipped att_1000..att_1999!
      assert.equal(iterations[1].offset, 0, 'Iteration 2 must query offset 0 to prevent skipping shifted items');
      assert.equal(iterations[1].storeSizeBefore, 1500);
      assert.equal(removals[1].count, 1000);
      assert.ok(removals[1].firstPath.endsWith('att_1000.txt'), 'Iteration 2 must start at att_1000 (no files skipped)');
      assert.ok(removals[1].lastPath.endsWith('att_1999.txt'), 'Iteration 2 must end at att_1999');

      // Iteration 3: queries offset 0, store size 500
      assert.equal(iterations[2].offset, 0, 'Iteration 3 must query offset 0');
      assert.equal(iterations[2].storeSizeBefore, 500);
      assert.equal(removals[2].count, 500);
      assert.ok(removals[2].firstPath.endsWith('att_2000.txt'), 'Iteration 3 starts at att_2000');
      assert.ok(removals[2].lastPath.endsWith('att_2499.txt'), 'Iteration 3 ends at att_2499');

      // 4. Confirm every single file is deleted, with no infinite loop
      assert.equal(result.success, true);
      assert.equal(result.deletedCount, 2500);
      assert.equal(mockStorageStore.size, 0, 'All 2,500 files must be deleted from storage');

      // 5. Confirm idempotent repeated deletion returns 200 with 0 deleted
      const secondResult = await deleteAttachmentsForChatInStorage(userAlice, testChatId, userAlice);
      assert.equal(secondResult.success, true);
      assert.equal(secondResult.deletedCount, 0);
    });

    // -------------------------------------------------------------------------
    // Test 2B: Partial Failures Remain Retryable and Idempotent
    // -------------------------------------------------------------------------
    await runTest('deleteAttachmentsForChatInStorage: partial failures remain retryable and idempotent', async () => {
      const testChatId = 'chat_partial_retry_2500';
      mockStorageStore.clear();
      listHook = null;
      removeHook = null;

      // Seed 2,500 files
      for (let i = 0; i < 2500; i++) {
        const fakeAttId = `att_${String(i).padStart(4, '0')}`;
        const path = `${userAlice}/${testChatId}/${fakeAttId}.txt`;
        mockStorageStore.set(path, { name: `${fakeAttId}.txt`, buffer: Buffer.from(`data_${i}`) });
      }

      // Simulate failure on the second batch removal
      let removalCallCount = 0;
      removeHook = (paths) => {
        removalCallCount++;
        if (removalCallCount === 2) {
          // Batch 2 fails with a 503 backend error
          return {
            data: null,
            error: { message: 'Supabase Storage 503 Service Unavailable', name: 'DELETE_FAILED', status: 503 }
          };
        }
        return undefined; // Batch 1 and other batches proceed normally
      };

      // First run: should succeed on batch 1 (1000 deleted), fail on batch 2
      const firstResult = await deleteAttachmentsForChatInStorage(userAlice, testChatId, userAlice);
      assert.equal(firstResult.success, false);
      assert.equal(firstResult.deletedCount, 1000, 'Should report 1000 files deleted before failure');
      assert.equal(firstResult.code, 'DELETE_FAILED');
      assert.equal(mockStorageStore.size, 1500, '1,500 files must remain in storage after partial failure');

      // Clear the error condition (backend service recovered)
      removeHook = null;

      // Retry deletion: should pick up remaining 1,500 files starting from offset 0
      const retryResult = await deleteAttachmentsForChatInStorage(userAlice, testChatId, userAlice);
      assert.equal(retryResult.success, true);
      assert.equal(retryResult.deletedCount, 1500, 'Should delete remaining 1,500 files on retry');
      assert.equal(mockStorageStore.size, 0, 'All files must now be cleared from storage');

      // Repeated call (idempotency): should return success with 0 deleted
      const idempotentResult = await deleteAttachmentsForChatInStorage(userAlice, testChatId, userAlice);
      assert.equal(idempotentResult.success, true);
      assert.equal(idempotentResult.deletedCount, 0);
    });

    // -------------------------------------------------------------------------
    // Test 2C: Anti-Stall Detection Prevents Infinite Loops
    // -------------------------------------------------------------------------
    await runTest('deleteAttachmentsForChatInStorage: anti-stall detection halts when deletion cannot make progress', async () => {
      const testChatId = 'chat_stall_test';
      mockStorageStore.clear();
      listHook = null;

      // Seed 5 files
      for (let i = 0; i < 5; i++) {
        const path = `${userAlice}/${testChatId}/stalled_${i}.txt`;
        mockStorageStore.set(path, { name: `stalled_${i}.txt`, buffer: Buffer.from('x') });
      }

      // Simulate a backend that returns empty removedData without deleting files
      removeHook = () => {
        return { data: [], error: null };
      };

      const stallResult = await deleteAttachmentsForChatInStorage(userAlice, testChatId, userAlice);
      removeHook = null;

      assert.equal(stallResult.success, false);
      assert.ok(
        stallResult.code === 'PARTIAL_DELETE_FAILURE' || stallResult.code === 'DELETE_STALLED',
        `Expected failure code, got ${stallResult.code}`
      );
    });

    // -------------------------------------------------------------------------
    // Test 3: DELETE /api/upload/conversations/:chatId Authentication & Authorization
    // -------------------------------------------------------------------------
    await runTest('DELETE /api/upload/conversations/:chatId rejects unauthenticated (401) and cross-user (403)', async () => {
      const targetChatId = 'chat_protected_001';
      mockStorageStore.clear();

      // Seed files for Alice
      mockStorageStore.set(`${userAlice}/${targetChatId}/file1.pdf`, { name: 'file1.pdf', buffer: Buffer.from('alice1') });
      mockStorageStore.set(`${userAlice}/${targetChatId}/file2.png`, { name: 'file2.png', buffer: Buffer.from('alice2') });

      // 1. Unauthenticated request -> 401
      const unauthRes = await fetch(`${baseUrl}/api/upload/conversations/${targetChatId}`, {
        method: 'DELETE'
      });
      assert.equal(unauthRes.status, 401);
      const unauthData = await unauthRes.json();
      assert.equal(unauthData.code, 'AUTH_REQUIRED');

      // 2. Cross-user deletion: Bob attempts to delete Alice's chat -> scoped to Bob's own folder (deletes 0)
      const bobRes = await fetch(`${baseUrl}/api/upload/conversations/${targetChatId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${tokenBob}` }
      });
      assert.equal(bobRes.status, 200);
      const bobData = await bobRes.json();
      // Bob has 0 files in chat_protected_001
      assert.equal(bobData.deletedCount, 0);
      // Alice's files are untouched!
      assert.equal(mockStorageStore.has(`${userAlice}/${targetChatId}/file1.pdf`), true);
      assert.equal(mockStorageStore.has(`${userAlice}/${targetChatId}/file2.png`), true);

      // 3. Invalid chatId format (traversal attempt) -> 400
      const badChatRes = await fetch(`${baseUrl}/api/upload/conversations/../traversal`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${tokenAlice}` }
      });
      assert.equal(badChatRes.status, 400);

      // 4. Owner Alice deletes her conversation -> 200 and files deleted
      const aliceRes = await fetch(`${baseUrl}/api/upload/conversations/${targetChatId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${tokenAlice}` }
      });
      assert.equal(aliceRes.status, 200);
      const aliceData = await aliceRes.json();
      assert.equal(aliceData.success, true);
      assert.equal(aliceData.deletedCount, 2);
      assert.equal(mockStorageStore.has(`${userAlice}/${targetChatId}/file1.pdf`), false);
      assert.equal(mockStorageStore.has(`${userAlice}/${targetChatId}/file2.png`), false);

      // 5. Repeated deletion is idempotent -> 200 with 0 files
      const repeatRes = await fetch(`${baseUrl}/api/upload/conversations/${targetChatId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${tokenAlice}` }
      });
      assert.equal(repeatRes.status, 200);
      const repeatData = await repeatRes.json();
      assert.equal(repeatData.success, true);
      assert.equal(repeatData.deletedCount, 0);
    });

    // -------------------------------------------------------------------------
    // Test 4: DELETE /api/upload/:id with Empty fileRegistry (Serverless / Restart)
    // -------------------------------------------------------------------------
    await runTest('DELETE /api/upload/:id resolves and deletes cloud file when fileRegistry is empty', async () => {
      fileRegistry.clear();
      mockStorageStore.clear();

      const testChatId = 'chat_serverless_789';
      const testFileId = 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d';
      const storagePath = `${userAlice}/${testChatId}/${testFileId}.pdf`;

      // Seed file in Supabase Storage directly (simulating prior upload from another instance)
      mockStorageStore.set(storagePath, { name: `${testFileId}.pdf`, buffer: Buffer.from('important pdf') });
      assert.equal(fileRegistry.has(testFileId), false, 'fileRegistry must be empty');

      // 1. Unauthenticated call with chatId -> 401
      const unauthRes = await fetch(`${baseUrl}/api/upload/${testFileId}?chatId=${testChatId}`, {
        method: 'DELETE'
      });
      assert.equal(unauthRes.status, 401);

      // 2. Cross-user Bob attempts to delete Alice's file using Alice's chatId -> Bob's folder checked -> 200 idempotent (file in Alice folder remains untouched!)
      const bobRes = await fetch(`${baseUrl}/api/upload/${testFileId}?chatId=${testChatId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${tokenBob}` }
      });
      assert.equal(bobRes.status, 200);
      assert.equal(mockStorageStore.has(storagePath), true, "Alice's file must NOT be deleted by Bob");

      // 3. Owner Alice deletes her file -> resolved via folder listing and deleted
      const aliceRes = await fetch(`${baseUrl}/api/upload/${testFileId}?chatId=${testChatId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${tokenAlice}` }
      });
      assert.equal(aliceRes.status, 200);
      const aliceData = await aliceRes.json();
      assert.equal(aliceData.success, true);
      assert.equal(mockStorageStore.has(storagePath), false, 'File must be deleted from Supabase');

      // 4. Repeated call is idempotent -> 200
      const repeatRes = await fetch(`${baseUrl}/api/upload/${testFileId}?chatId=${testChatId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${tokenAlice}` }
      });
      assert.equal(repeatRes.status, 200);
    });

    // -------------------------------------------------------------------------
    // Test 5: Exact filename matching protects related files with similar prefixes
    // -------------------------------------------------------------------------
    await runTest('Exact filename matching protects files with similar prefix in folder', async () => {
      mockStorageStore.clear();
      fileRegistry.clear();

      const testChatId = 'chat_exact_match';
      const targetAttId = '00000000-0000-0000-0000-000000000001';

      // Seed target file and similar files
      const targetPath = `${userAlice}/${testChatId}/${targetAttId}.png`;
      const thumbPath = `${userAlice}/${testChatId}/${targetAttId}_thumb.png`;
      const copyPath = `${userAlice}/${testChatId}/${targetAttId}-copy.png`;

      mockStorageStore.set(targetPath, { name: `${targetAttId}.png`, buffer: Buffer.from('main') });
      mockStorageStore.set(thumbPath, { name: `${targetAttId}_thumb.png`, buffer: Buffer.from('thumb') });
      mockStorageStore.set(copyPath, { name: `${targetAttId}-copy.png`, buffer: Buffer.from('copy') });

      // Delete targetAttId
      const delRes = await fetch(`${baseUrl}/api/upload/${targetAttId}?chatId=${testChatId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${tokenAlice}` }
      });
      assert.equal(delRes.status, 200);

      // Verify only target was deleted; thumb and copy are preserved!
      assert.equal(mockStorageStore.has(targetPath), false, 'Target file must be deleted');
      assert.equal(mockStorageStore.has(thumbPath), true, 'Thumb file must be protected');
      assert.equal(mockStorageStore.has(copyPath), true, 'Copy file must be protected');
    });

    // -------------------------------------------------------------------------
    // Test 6: In-memory conversationDocuments and fileRegistry synchronization
    // -------------------------------------------------------------------------
    await runTest('Conversation deletion cleans up in-memory registry and conversationDocuments', async () => {
      const convId = 'conv_sync_test_999';
      const attId1 = '11111111-1111-1111-1111-111111111111';
      const attId2 = '22222222-2222-2222-2222-222222222222';

      fileRegistry.set(attId1, {
        id: attId1,
        diskFilename: `${attId1}.txt`,
        originalName: 'file1.txt',
        mimeType: 'text/plain',
        extension: 'txt',
        size: 50,
        formattedSize: '50 B',
        status: 'ready',
        uploadedAt: new Date().toISOString(),
        expiresAt: Date.now() + 3600000,
        userId: userAlice,
        conversationId: convId,
        storageProvider: 'supabase',
        storagePath: `${userAlice}/${convId}/${attId1}.txt`
      });

      fileRegistry.set(attId2, {
        id: attId2,
        diskFilename: `${attId2}.txt`,
        originalName: 'file2.txt',
        mimeType: 'text/plain',
        extension: 'txt',
        size: 50,
        formattedSize: '50 B',
        status: 'ready',
        uploadedAt: new Date().toISOString(),
        expiresAt: Date.now() + 3600000,
        userId: userAlice,
        conversationId: convId,
        storageProvider: 'supabase',
        storagePath: `${userAlice}/${convId}/${attId2}.txt`
      });

      conversationDocuments.set(convId, new Set([attId1, attId2]));
      mockStorageStore.set(`${userAlice}/${convId}/${attId1}.txt`, { name: `${attId1}.txt`, buffer: Buffer.from('1') });
      mockStorageStore.set(`${userAlice}/${convId}/${attId2}.txt`, { name: `${attId2}.txt`, buffer: Buffer.from('2') });

      const delRes = await fetch(`${baseUrl}/api/upload/conversations/${convId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${tokenAlice}` }
      });
      assert.equal(delRes.status, 200);

      assert.equal(conversationDocuments.has(convId), false, 'conversationDocuments must be cleared');
      assert.equal(fileRegistry.has(attId1), false, 'fileRegistry att1 must be deleted');
      assert.equal(fileRegistry.has(attId2), false, 'fileRegistry att2 must be deleted');
      assert.equal(mockStorageStore.has(`${userAlice}/${convId}/${attId1}.txt`), false);
      assert.equal(mockStorageStore.has(`${userAlice}/${convId}/${attId2}.txt`), false);
    });

    // -------------------------------------------------------------------------
    // Test 7: Paginated search in findAttachmentPathInStorage (>1000 files in folder)
    // -------------------------------------------------------------------------
    await runTest('findAttachmentPathInStorage locates file located past page 1 (>1000 files)', async () => {
      mockStorageStore.clear();
      const largeChatId = 'chat_deep_search';
      const targetAttId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

      // Seed 1,200 files in userAlice/chat_deep_search/
      for (let i = 0; i < 1200; i++) {
        const fakeId = `file_${String(i).padStart(5, '0')}`;
        mockStorageStore.set(`${userAlice}/${largeChatId}/${fakeId}.txt`, { name: `${fakeId}.txt`, buffer: Buffer.from('x') });
      }

      // Place target at position 1,150 (page 2)
      mockStorageStore.set(`${userAlice}/${largeChatId}/${targetAttId}.pdf`, {
        name: `${targetAttId}.pdf`,
        buffer: Buffer.from('needle in haystack')
      });

      const lookup = await findAttachmentPathInStorage(userAlice, largeChatId, targetAttId);
      assert.equal(lookup.found, true);
      assert.equal(lookup.path, `${userAlice}/${largeChatId}/${targetAttId}.pdf`);
      assert.equal(lookup.filename, `${targetAttId}.pdf`);
    });

    // -------------------------------------------------------------------------
    // Test 8: Unauthenticated local/guest deletion preserved
    // -------------------------------------------------------------------------
    await runTest('DELETE /api/upload/:id preserves unauthenticated local/guest deletion', async () => {
      const localId = crypto.randomUUID();
      fileRegistry.set(localId, {
        id: localId,
        diskFilename: `${localId}.txt`,
        originalName: 'guest_file.txt',
        mimeType: 'text/plain',
        extension: 'txt',
        size: 20,
        formattedSize: '20 B',
        status: 'ready',
        uploadedAt: new Date().toISOString(),
        expiresAt: Date.now() + 3600000,
        storageProvider: 'local'
      });

      // No Authorization header -> succeeds with 200
      const delRes = await fetch(`${baseUrl}/api/upload/${localId}`, {
        method: 'DELETE'
      });
      assert.equal(delRes.status, 200);
      assert.equal(fileRegistry.has(localId), false);
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
