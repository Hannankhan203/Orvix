/**
 * Dedicated Regression Test Suite for Post-Restart Supabase Attachment Retrieval
 * & Unauthenticated Disk-Access Prevention
 *
 * Verifies:
 * 1. Empty-registry retrieval: Authenticated user retrieves files directly from Supabase
 *    via /file, /preview, /download, /signed-url, /extraction, and /api/upload/:id using chatId.
 * 2. Server-restart simulation: After fileRegistry is cleared, all authenticated endpoints
 *    locate and serve cloud attachments using findAttachmentPathInStorage().
 * 3. Missing chatId handling: Empty or invalid chatId returns 400 (MISSING_CHAT_ID /
 *    INVALID_PATH_SEGMENT); omitting chatId when registry is empty returns 404 ATTACHMENT_NOT_FOUND.
 * 4. Invalid ownership & cross-user isolation: User B cannot retrieve or sign URLs for User A's
 *    attachments even after restart.
 * 5. Unauthenticated disk access prevention: Files residing on disk without an active in-memory
 *    registry entry fail closed (404/401) and are NEVER served to unauthenticated or cross-user requests.
 * 6. Leak prevention: Responses never expose Supabase secret keys or internal storage paths.
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
console.log('REGRESSION SUITE: Post-Restart Supabase Retrieval & Security');
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

// Generate real RSA key pairs for Firebase JWT verification
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

const TEST_KID = 'post-restart-kid-001';
const TEST_PROJECT_ID = 'orvix-post-restart-project';

function createSignedJwt(payloadObj, kid = TEST_KID, key = privateKey) {
  const fullPayload = {
    aud: TEST_PROJECT_ID,
    iss: `https://securetoken.google.com/${TEST_PROJECT_ID}`,
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
    ...payloadObj
  };
  const headerB64 = Buffer.from(JSON.stringify({ alg: 'RS256', kid })).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(fullPayload)).toString('base64url');
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${headerB64}.${payloadB64}`), key).toString('base64url');
  return `${headerB64}.${payloadB64}.${sig}`;
}

async function main() {
  process.env.FIREBASE_PROJECT_ID = TEST_PROJECT_ID;
  setTestPublicKey(TEST_KID, publicKey);

  // In-memory mock storage store: Map<key, { buffer, mimeType, name }>
  const mockStorageStore = new Map();

  const mockSupabaseClient = {
    storage: {
      from: (bucketName) => ({
        list: async (folderPath, options = {}) => {
          const cleanFolder = (folderPath || '').replace(/\/+$/, '');
          const prefix = cleanFolder ? `${cleanFolder}/` : '';
          const results = [];

          for (const [key, val] of mockStorageStore.entries()) {
            const expectedBucketPrefix = `${bucketName}:`;
            if (!key.startsWith(expectedBucketPrefix)) continue;
            const fullPath = key.slice(expectedBucketPrefix.length);

            if (fullPath.startsWith(prefix)) {
              const subKey = fullPath.slice(prefix.length);
              if (!subKey.includes('/')) {
                results.push({
                  name: subKey,
                  id: subKey,
                  metadata: { mimetype: val.mimeType, size: val.buffer?.length || 0 }
                });
              }
            }
          }

          const offset = options?.offset || 0;
          const limit = options?.limit || 100;
          return { data: results.slice(offset, offset + limit), error: null };
        },
        download: async (itemPath) => {
          const key = `${bucketName}:${itemPath}`;
          if (!mockStorageStore.has(key)) {
            return { data: null, error: { message: 'Object not found', name: 'NotFound', status: 404 } };
          }
          const item = mockStorageStore.get(key);
          return {
            data: {
              type: item.mimeType,
              arrayBuffer: async () => item.buffer.buffer.slice(
                item.buffer.byteOffset,
                item.buffer.byteOffset + item.buffer.byteLength
              )
            },
            error: null
          };
        },
        createSignedUrl: async (itemPath, expiresIn, options) => {
          const key = `${bucketName}:${itemPath}`;
          if (!mockStorageStore.has(key)) {
            return { data: null, error: { message: 'Object not found', name: 'NotFound', status: 404 } };
          }
          const downloadParam = options?.download ? `&download=${encodeURIComponent(options.download)}` : '';
          return {
            data: {
              signedUrl: `https://mock-supabase.co/storage/v1/object/sign/${bucketName}/${itemPath}?token=mock_jwt_${expiresIn}s${downloadParam}`
            },
            error: null
          };
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

  setSupabaseServerClientForTesting(mockSupabaseClient);

  const app = express();
  app.use(express.json());
  registerUploadRoutes(app);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;

  try {
    const userAlice = 'user_alice_post_restart';
    const userBob = 'user_bob_post_restart';
    const tokenAlice = createSignedJwt({ sub: userAlice });
    const tokenBob = createSignedJwt({ sub: userBob });

    const chatId1 = 'chat_conversation_001';
    const chatId2 = 'chat_conversation_002';
    const bucket = 'orvix-attachments';

    const pdfBuffer = Buffer.from('%PDF-1.4\n%mock post-restart pdf content\n%%EOF');
    const txtBuffer = Buffer.from('Plain text document extraction test content.');
    const imgBuffer = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
      0x00, 0x00, 0x00, 0x0a, 0x00, 0x00, 0x00, 0x0a, // 10x10 px
      0x08, 0x06, 0x00, 0x00, 0x00, 0x8d, 0x32, 0x2e, 0x9b
    ]);

    const pdfId = crypto.randomUUID();
    const txtId = crypto.randomUUID();
    const imgId = crypto.randomUUID();

    // Store in Supabase under userAlice's folder structure
    mockStorageStore.set(`${bucket}:${userAlice}/${chatId1}/${pdfId}.pdf`, {
      buffer: pdfBuffer,
      mimeType: 'application/pdf',
      name: `${pdfId}.pdf`
    });
    mockStorageStore.set(`${bucket}:${userAlice}/${chatId1}/${txtId}.txt`, {
      buffer: txtBuffer,
      mimeType: 'text/plain',
      name: `${txtId}.txt`
    });
    mockStorageStore.set(`${bucket}:${userAlice}/${chatId2}/${imgId}.png`, {
      buffer: imgBuffer,
      mimeType: 'image/png',
      name: `${imgId}.png`
    });

    // -------------------------------------------------------------------------
    // Test 1: Empty Registry Retrieval for Authenticated User via /file
    // -------------------------------------------------------------------------
    await runTest('Empty registry: Authenticated user retrieves PDF from Supabase via /file with chatId', async () => {
      // Ensure fileRegistry has NO entry for pdfId (simulating restart / uncached state)
      fileRegistry.delete(pdfId);
      assert.equal(fileRegistry.has(pdfId), false);

      const res = await fetch(`${baseUrl}/api/upload/${pdfId}/file?chatId=${chatId1}`, {
        headers: { authorization: `Bearer ${tokenAlice}` }
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'application/pdf');
      assert.ok(res.headers.get('content-disposition')?.includes('inline'));
      const buf = Buffer.from(await res.arrayBuffer());
      assert.equal(buf.toString('utf8'), pdfBuffer.toString('utf8'));
    });

    // -------------------------------------------------------------------------
    // Test 2: Empty Registry Retrieval via /preview and /download
    // -------------------------------------------------------------------------
    await runTest('Empty registry: Preview endpoint serves inline Content-Disposition', async () => {
      fileRegistry.delete(pdfId);
      const res = await fetch(`${baseUrl}/api/upload/${pdfId}/preview?chatId=${chatId1}`, {
        headers: { authorization: `Bearer ${tokenAlice}` }
      });
      assert.equal(res.status, 200);
      assert.ok(res.headers.get('content-disposition')?.startsWith('inline'));
    });

    await runTest('Empty registry: Download endpoint sets attachment Content-Disposition', async () => {
      fileRegistry.delete(pdfId);
      const res = await fetch(`${baseUrl}/api/upload/${pdfId}/download?chatId=${chatId1}`, {
        headers: { authorization: `Bearer ${tokenAlice}` }
      });
      assert.equal(res.status, 200);
      assert.ok(res.headers.get('content-disposition')?.startsWith('attachment'));
      const buf = Buffer.from(await res.arrayBuffer());
      assert.equal(buf.length, pdfBuffer.length);
    });

    // -------------------------------------------------------------------------
    // Test 3: Empty Registry Retrieval for /signed-url
    // -------------------------------------------------------------------------
    await runTest('Empty registry: Generates signed URL directly from Supabase without registry record', async () => {
      fileRegistry.delete(pdfId);
      const res = await fetch(`${baseUrl}/api/upload/${pdfId}/signed-url?chatId=${chatId1}`, {
        headers: { authorization: `Bearer ${tokenAlice}` }
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.ok(typeof data.signedUrl === 'string');
      assert.ok(data.signedUrl.includes(pdfId));
      assert.equal(data.expiresInSeconds, 120);
    });

    // -------------------------------------------------------------------------
    // Test 4: Empty Registry Extraction for Documents
    // -------------------------------------------------------------------------
    await runTest('Empty registry: Extraction endpoint downloads from Supabase and extracts content', async () => {
      fileRegistry.delete(txtId);
      const res = await fetch(`${baseUrl}/api/upload/${txtId}/extraction?chatId=${chatId1}`, {
        headers: { authorization: `Bearer ${tokenAlice}` }
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(data.text?.includes('Plain text document extraction test content'));
    });

    // -------------------------------------------------------------------------
    // Test 5: Empty Registry Metadata Endpoint (/api/upload/:id)
    // -------------------------------------------------------------------------
    await runTest('Empty registry: Metadata endpoint resolves cloud attachment details via chatId', async () => {
      fileRegistry.delete(pdfId);
      const res = await fetch(`${baseUrl}/api/upload/${pdfId}?chatId=${chatId1}`, {
        headers: { authorization: `Bearer ${tokenAlice}` }
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.id, pdfId);
      assert.equal(data.mimeType, 'application/pdf');
      assert.equal(data.storageProvider, 'supabase');
    });

    // -------------------------------------------------------------------------
    // Test 6: Full Server Restart Simulation across Multiple Chats
    // -------------------------------------------------------------------------
    await runTest('Server restart simulation: Completely clears fileRegistry, all chats still retrievable', async () => {
      // Simulate server crash & restart by clearing all in-memory registries
      fileRegistry.clear();
      assert.equal(fileRegistry.size, 0);

      // Verify chat 1 file
      const res1 = await fetch(`${baseUrl}/api/upload/${pdfId}/file?chatId=${chatId1}`, {
        headers: { authorization: `Bearer ${tokenAlice}` }
      });
      assert.equal(res1.status, 200);

      // Verify chat 2 image
      const res2 = await fetch(`${baseUrl}/api/upload/${imgId}/file?chatId=${chatId2}`, {
        headers: { authorization: `Bearer ${tokenAlice}` }
      });
      assert.equal(res2.status, 200);
      assert.equal(res2.headers.get('content-type'), 'image/png');
    });

    // -------------------------------------------------------------------------
    // Test 7: Missing / Invalid chatId Handling
    // -------------------------------------------------------------------------
    await runTest('Missing chatId on unknown / empty-registry file returns 404 ATTACHMENT_NOT_FOUND', async () => {
      fileRegistry.clear();
      const unknownId = crypto.randomUUID();
      const res = await fetch(`${baseUrl}/api/upload/${unknownId}/file`, {
        headers: { authorization: `Bearer ${tokenAlice}` }
      });
      assert.equal(res.status, 404);
      const data = await res.json();
      assert.equal(data.code, 'ATTACHMENT_NOT_FOUND');
    });

    await runTest('Explicit empty chatId (?chatId=) returns 400 MISSING_CHAT_ID', async () => {
      fileRegistry.clear();
      const res = await fetch(`${baseUrl}/api/upload/${pdfId}/file?chatId=`, {
        headers: { authorization: `Bearer ${tokenAlice}` }
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.code, 'MISSING_CHAT_ID');
    });

    await runTest('Whitespace chatId (?chatId=%20) returns 400 MISSING_CHAT_ID', async () => {
      fileRegistry.clear();
      const res = await fetch(`${baseUrl}/api/upload/${pdfId}/file?chatId=%20%20`, {
        headers: { authorization: `Bearer ${tokenAlice}` }
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.code, 'MISSING_CHAT_ID');
    });

    await runTest('Path traversal in chatId returns 400 INVALID_PATH_SEGMENT', async () => {
      fileRegistry.clear();
      const res = await fetch(`${baseUrl}/api/upload/${pdfId}/file?chatId=..%2F..%2Fetc`, {
        headers: { authorization: `Bearer ${tokenAlice}` }
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.code, 'INVALID_PATH_SEGMENT');
    });

    await runTest('Missing chatId on /signed-url returns 400 MISSING_CHAT_ID', async () => {
      fileRegistry.clear();
      const res = await fetch(`${baseUrl}/api/upload/${pdfId}/signed-url`, {
        headers: { authorization: `Bearer ${tokenAlice}` }
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.code, 'MISSING_CHAT_ID');
    });

    await runTest('Explicit empty chatId on /extraction returns 400 MISSING_CHAT_ID', async () => {
      fileRegistry.clear();
      const res = await fetch(`${baseUrl}/api/upload/${txtId}/extraction?chatId=`, {
        headers: { authorization: `Bearer ${tokenAlice}` }
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.code, 'MISSING_CHAT_ID');
    });

    // -------------------------------------------------------------------------
    // Test 8: Invalid Ownership & Cross-User Isolation
    // -------------------------------------------------------------------------
    await runTest('Cross-user retrieval fails closed: User Bob cannot retrieve User Alice file', async () => {
      fileRegistry.clear();
      // Bob requests Alice's fileId even with Alice's chatId.
      // Lookup searches under Bob's userId and finds nothing.
      const res = await fetch(`${baseUrl}/api/upload/${pdfId}/file?chatId=${chatId1}`, {
        headers: { authorization: `Bearer ${tokenBob}` }
      });
      assert.equal(res.status, 404);
      const data = await res.json();
      assert.equal(data.code, 'ATTACHMENT_NOT_FOUND');
    });

    await runTest('Cross-user signed-url fails closed: User Bob cannot generate signed URL for Alice file', async () => {
      fileRegistry.clear();
      const res = await fetch(`${baseUrl}/api/upload/${pdfId}/signed-url?chatId=${chatId1}`, {
        headers: { authorization: `Bearer ${tokenBob}` }
      });
      assert.equal(res.status, 404);
      const data = await res.json();
      assert.equal(data.code, 'ATTACHMENT_NOT_FOUND');
    });

    // -------------------------------------------------------------------------
    // Test 9: Unauthenticated Disk-Access Vulnerability Prevention (Fail Closed)
    // -------------------------------------------------------------------------
    await runTest('Unauthenticated disk-access prevention: Unregistered disk file is NEVER served', async () => {
      fileRegistry.clear();

      // Create a rogue / orphaned file directly on disk in UPLOAD_DIR
      const rogueId = crypto.randomUUID();
      const diskFilename = `${rogueId}.pdf`;
      const fullDiskPath = path.join(UPLOAD_DIR, diskFilename);
      const secretDiskContent = Buffer.from('CONFIDENTIAL_DISK_ONLY_PAYLOAD_NEVER_SERVE');
      await fs.promises.writeFile(fullDiskPath, secretDiskContent);

      try {
        // 1. Unauthenticated request without chatId
        const resUnauth = await fetch(`${baseUrl}/api/upload/${rogueId}/file`);
        assert.equal(resUnauth.status, 404);
        const dataUnauth = await resUnauth.json();
        assert.equal(dataUnauth.code, 'ATTACHMENT_NOT_FOUND');

        // 2. Unauthenticated request with fake chatId
        const resUnauthChat = await fetch(`${baseUrl}/api/upload/${rogueId}/file?chatId=any_chat`);
        assert.equal(resUnauthChat.status, 401);
        const dataUnauthChat = await resUnauthChat.json();
        assert.equal(dataUnauthChat.code, 'AUTH_REQUIRED');

        // 3. Authenticated request from User Alice (file is on disk but NOT in Supabase nor in fileRegistry)
        const resAuthAlice = await fetch(`${baseUrl}/api/upload/${rogueId}/file?chatId=chat_conversation_001`, {
          headers: { authorization: `Bearer ${tokenAlice}` }
        });
        assert.equal(resAuthAlice.status, 404);
        const dataAuthAlice = await resAuthAlice.json();
        assert.equal(dataAuthAlice.code, 'ATTACHMENT_NOT_FOUND');
      } finally {
        // Clean up test disk file
        await fs.promises.unlink(fullDiskPath).catch(() => {});
      }
    });

    // -------------------------------------------------------------------------
    // Test 10: Secret Leak Prevention
    // -------------------------------------------------------------------------
    await runTest('Security boundaries: Responses never expose Supabase secrets or private storage paths', async () => {
      fileRegistry.clear();

      const res = await fetch(`${baseUrl}/api/upload/${pdfId}?chatId=${chatId1}`, {
        headers: { authorization: `Bearer ${tokenAlice}` }
      });
      const bodyText = await res.text();
      assert.ok(!bodyText.includes('supabase_service_role_key'));
      assert.ok(!bodyText.includes(bucket));
      assert.ok(!bodyText.includes(userAlice));
    });

  } finally {
    server.close();
    clearTestPublicKeys();
    resetFirebaseAuthForTesting();
    resetSupabaseClientForTesting();
    process.env = originalEnv;
  }

  console.log('\n================================================================');
  console.log(`RESULTS: ${passedCount} / ${totalTests} TESTS PASSED`);
  console.log('================================================================\n');

  if (passedCount !== totalTests) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Test suite uncaught failure:', err);
  process.exit(1);
});
