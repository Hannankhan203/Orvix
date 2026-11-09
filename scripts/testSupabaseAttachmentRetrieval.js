/**
 * Dedicated Verification Suite for Supabase Storage Attachment Retrieval Routes
 *
 * Verifies:
 * 1. Authorized retrieval: Authenticated user retrieves their file from private Supabase Storage.
 * 2. Cross-user access denial: Non-owner is rejected with 403 STORAGE_ACCESS_DENIED.
 * 3. Invalid authentication: Unauthenticated (401 AUTH_REQUIRED), forged/tampered (401), expired (401).
 * 4. Missing files: Unknown ID or deleted cloud file returns 404 ATTACHMENT_NOT_FOUND safely.
 * 5. Preview route: Content-Disposition is inline for previewable types (/file, /preview).
 * 6. Download route: Content-Disposition is attachment for download routes (/download, ?download=true).
 * 7. Signed URL: Generates 120s pre-signed URL for owner; rejects non-owner with 403; does not leak secrets.
 * 8. Guest & offline retrieval: Local files for guest/unauthenticated users are served without auth headers.
 * 9. Extraction on cloud attachments: On-demand download from Supabase for extraction if local buffer is absent.
 * 10. Security boundaries: Client-supplied IDs and paths are never trusted; credentials never leaked.
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
console.log('VERIFICATION SUITE: Supabase Attachment Retrieval & Access Control');
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

const TEST_KID = 'retrieval-test-kid-001';
const TEST_PROJECT_ID = 'orvix-retrieval-project';

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

  // In-memory mock storage backend
  const mockStorageStore = new Map();

  const mockSupabaseClient = {
    storage: {
      from: (bucketName) => ({
        download: async (path) => {
          const key = `${bucketName}:${path}`;
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
        createSignedUrl: async (path, expiresIn, options) => {
          const key = `${bucketName}:${path}`;
          if (!mockStorageStore.has(key)) {
            return { data: null, error: { message: 'Object not found', name: 'NotFound', status: 404 } };
          }
          const downloadParam = options?.download ? `&download=${encodeURIComponent(options.download)}` : '';
          return {
            data: {
              signedUrl: `https://mock-supabase.co/storage/v1/object/sign/${bucketName}/${path}?token=mock_jwt_${expiresIn}s${downloadParam}`
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

  // Set up Express test server
  const app = express();
  app.use(express.json());
  registerUploadRoutes(app);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;

  try {
    const userA = 'user_alice_123';
    const userB = 'user_bob_456';
    const tokenUserA = createSignedJwt({ sub: userA });
    const tokenUserB = createSignedJwt({ sub: userB });

    const pdfBuffer = Buffer.from('%PDF-1.4\n%mock pdf file content for testing\n%%EOF');
    const attachmentIdA = crypto.randomUUID();
    const storagePathA = `${userA}/chat_conv_1/${attachmentIdA}.pdf`;
    const bucket = 'orvix-attachments';

    mockStorageStore.set(`${bucket}:${storagePathA}`, {
      buffer: pdfBuffer,
      mimeType: 'application/pdf'
    });

    // Register attachment belonging to userA in cloud storage
    fileRegistry.set(attachmentIdA, {
      id: attachmentIdA,
      originalName: 'Q4_Financial_Report.pdf',
      diskFilename: `${attachmentIdA}.pdf`,
      mimeType: 'application/pdf',
      extension: 'PDF',
      size: pdfBuffer.length,
      formattedSize: '1.2 KB',
      status: 'ready',
      uploadedAt: new Date().toISOString(),
      expiresAt: Date.now() + 7200000,
      userId: userA,
      conversationId: 'chat_conv_1',
      storageProvider: 'supabase',
      storagePath: storagePathA,
      storageBucket: bucket
    });

    // -----------------------------------------------------------------------
    // Test 1: Authorized Retrieval of Cloud Attachment
    // -----------------------------------------------------------------------
    await runTest('Authorized user retrieves their attachment from Supabase Storage', async () => {
      const res = await fetch(`${baseUrl}/api/upload/${attachmentIdA}/file`, {
        headers: { authorization: `Bearer ${tokenUserA}` }
      });

      assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
      assert.equal(res.headers.get('content-type'), 'application/pdf');
      const disposition = res.headers.get('content-disposition') || '';
      assert.ok(disposition.startsWith('inline'), `Expected inline disposition, got ${disposition}`);
      assert.ok(disposition.includes('Q4_Financial_Report.pdf'), 'Disposition must include safe filename');

      const body = Buffer.from(await res.arrayBuffer());
      assert.equal(body.toString(), pdfBuffer.toString(), 'Returned content must match storage buffer');
    });

    // -----------------------------------------------------------------------
    // Test 2: Cross-User Access Denial (User B requesting User A attachment)
    // -----------------------------------------------------------------------
    await runTest('Cross-user retrieval is denied with 403 STORAGE_ACCESS_DENIED', async () => {
      // 1. File endpoint
      const fileRes = await fetch(`${baseUrl}/api/upload/${attachmentIdA}/file`, {
        headers: { authorization: `Bearer ${tokenUserB}` }
      });
      assert.equal(fileRes.status, 403);
      const fileData = await fileRes.json();
      assert.equal(fileData.code, 'STORAGE_ACCESS_DENIED');

      // 2. Metadata endpoint
      const metaRes = await fetch(`${baseUrl}/api/upload/${attachmentIdA}`, {
        headers: { authorization: `Bearer ${tokenUserB}` }
      });
      assert.equal(metaRes.status, 403);
      const metaData = await metaRes.json();
      assert.equal(metaData.code, 'STORAGE_ACCESS_DENIED');

      // 3. Preview endpoint
      const prevRes = await fetch(`${baseUrl}/api/upload/${attachmentIdA}/preview`, {
        headers: { authorization: `Bearer ${tokenUserB}` }
      });
      assert.equal(prevRes.status, 403);

      // 4. Download endpoint
      const dlRes = await fetch(`${baseUrl}/api/upload/${attachmentIdA}/download`, {
        headers: { authorization: `Bearer ${tokenUserB}` }
      });
      assert.equal(dlRes.status, 403);

      // 5. Signed URL endpoint
      const signRes = await fetch(`${baseUrl}/api/upload/${attachmentIdA}/signed-url`, {
        headers: { authorization: `Bearer ${tokenUserB}` }
      });
      assert.equal(signRes.status, 403);
    });

    // -----------------------------------------------------------------------
    // Test 3: Unauthenticated / Invalid Token Requests
    // -----------------------------------------------------------------------
    await runTest('Unauthenticated request for authenticated user attachment returns 401 AUTH_REQUIRED', async () => {
      const res = await fetch(`${baseUrl}/api/upload/${attachmentIdA}/file`);
      assert.equal(res.status, 401);
      const data = await res.json();
      assert.equal(data.code, 'AUTH_REQUIRED');
    });

    await runTest('Forged token returns 401 INVALID_SIGNATURE', async () => {
      const forgedToken = 'header.payload.invalidsignature';
      const res = await fetch(`${baseUrl}/api/upload/${attachmentIdA}/file`, {
        headers: { authorization: `Bearer ${forgedToken}` }
      });
      assert.equal(res.status, 401);
    });

    await runTest('Expired token returns 401 TOKEN_EXPIRED', async () => {
      const expiredToken = createSignedJwt({
        sub: userA,
        exp: Math.floor(Date.now() / 1000) - 300,
        iat: Math.floor(Date.now() / 1000) - 3600
      });
      const res = await fetch(`${baseUrl}/api/upload/${attachmentIdA}/file`, {
        headers: { authorization: `Bearer ${expiredToken}` }
      });
      assert.equal(res.status, 401);
      const data = await res.json();
      assert.equal(data.code, 'TOKEN_EXPIRED');
    });

    // -----------------------------------------------------------------------
    // Test 4: Missing Files Handling (Safe 404, No Leaks)
    // -----------------------------------------------------------------------
    await runTest('Unknown attachment ID returns 404 ATTACHMENT_NOT_FOUND', async () => {
      const unknownId = crypto.randomUUID();
      const res = await fetch(`${baseUrl}/api/upload/${unknownId}/file`, {
        headers: { authorization: `Bearer ${tokenUserA}` }
      });
      assert.equal(res.status, 404);
      const data = await res.json();
      assert.equal(data.code, 'ATTACHMENT_NOT_FOUND');
    });

    await runTest('Missing cloud file returns 404 safely without leaking internal paths', async () => {
      const missingCloudId = crypto.randomUUID();
      const missingStoragePath = `${userA}/chat_conv_1/${missingCloudId}.pdf`;
      // Do NOT add to mockStorageStore, simulating file deleted from Supabase
      fileRegistry.set(missingCloudId, {
        id: missingCloudId,
        originalName: 'deleted_report.pdf',
        diskFilename: `${missingCloudId}.pdf`,
        mimeType: 'application/pdf',
        extension: 'PDF',
        size: 500,
        formattedSize: '500 B',
        status: 'ready',
        uploadedAt: new Date().toISOString(),
        expiresAt: Date.now() + 7200000,
        userId: userA,
        storageProvider: 'supabase',
        storagePath: missingStoragePath,
        storageBucket: bucket
      });

      const res = await fetch(`${baseUrl}/api/upload/${missingCloudId}/file`, {
        headers: { authorization: `Bearer ${tokenUserA}` }
      });
      assert.equal(res.status, 404);
      const data = await res.json();
      assert.equal(data.code, 'ATTACHMENT_NOT_FOUND');
      // Ensure private storagePath or internal system details are never exposed
      assert.ok(!JSON.stringify(data).includes(missingStoragePath));
      assert.ok(!JSON.stringify(data).includes('/var/task'));
      assert.ok(!JSON.stringify(data).includes('/tmp'));
    });

    // -----------------------------------------------------------------------
    // Test 5: Preview Route Behavior (inline Content-Disposition)
    // -----------------------------------------------------------------------
    await runTest('Preview route sets Content-Disposition: inline for viewable documents', async () => {
      const res = await fetch(`${baseUrl}/api/upload/${attachmentIdA}/preview`, {
        headers: { authorization: `Bearer ${tokenUserA}` }
      });
      assert.equal(res.status, 200);
      const disposition = res.headers.get('content-disposition') || '';
      assert.ok(disposition.startsWith('inline;'), `Expected inline, got ${disposition}`);
    });

    // -----------------------------------------------------------------------
    // Test 6: Download Route Behavior (attachment Content-Disposition)
    // -----------------------------------------------------------------------
    await runTest('Download routes set Content-Disposition: attachment', async () => {
      // 1. /api/upload/:id/download route
      const res1 = await fetch(`${baseUrl}/api/upload/${attachmentIdA}/download`, {
        headers: { authorization: `Bearer ${tokenUserA}` }
      });
      assert.equal(res1.status, 200);
      const disp1 = res1.headers.get('content-disposition') || '';
      assert.ok(disp1.startsWith('attachment;'), `Expected attachment, got ${disp1}`);
      assert.ok(disp1.includes('Q4_Financial_Report.pdf'));

      // 2. /api/upload/:id/file?download=true route
      const res2 = await fetch(`${baseUrl}/api/upload/${attachmentIdA}/file?download=true`, {
        headers: { authorization: `Bearer ${tokenUserA}` }
      });
      assert.equal(res2.status, 200);
      const disp2 = res2.headers.get('content-disposition') || '';
      assert.ok(disp2.startsWith('attachment;'), `Expected attachment, got ${disp2}`);
    });

    // -----------------------------------------------------------------------
    // Test 7: Pre-Signed URL Generation (Max 120s TTL, No Secret Leaks)
    // -----------------------------------------------------------------------
    await runTest('Owner can generate short-lived pre-signed URL; secrets never exposed', async () => {
      const res = await fetch(`${baseUrl}/api/upload/${attachmentIdA}/signed-url`, {
        headers: { authorization: `Bearer ${tokenUserA}` }
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.expiresInSeconds, 120);
      assert.ok(typeof data.signedUrl === 'string');
      assert.ok(data.signedUrl.startsWith('https://mock-supabase.co'));
      assert.ok(!data.signedUrl.includes(process.env.SUPABASE_SECRET_KEY || 'unlikely_placeholder'));
    });

    // -----------------------------------------------------------------------
    // Test 8: Guest & Local Retrieval (No Auth Header Required)
    // -----------------------------------------------------------------------
    await runTest('Guest attachment is retrieved locally without requiring authentication', async () => {
      const guestId = crypto.randomUUID();
      const guestContent = Buffer.from('plain guest file content');
      fileRegistry.set(guestId, {
        id: guestId,
        originalName: 'guest_notes.txt',
        diskFilename: `${guestId}.txt`,
        mimeType: 'text/plain',
        extension: 'TXT',
        size: guestContent.length,
        formattedSize: '24 B',
        status: 'ready',
        uploadedAt: new Date().toISOString(),
        expiresAt: Date.now() + 7200000,
        storageProvider: 'local',
        buffer: guestContent
        // userId: undefined
      });

      const res = await fetch(`${baseUrl}/api/upload/${guestId}/file`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'text/plain');
      const text = await res.text();
      assert.equal(text, 'plain guest file content');
    });

    // -----------------------------------------------------------------------
    // Test 9: Extraction Route On-Demand Retrieval
    // -----------------------------------------------------------------------
    await runTest('Extraction endpoint retrieves cloud file for extraction and respects user isolation', async () => {
      const textFileId = crypto.randomUUID();
      const textContent = Buffer.from('Extracted title\nDetailed paragraph of text in document.');
      const textStoragePath = `${userA}/chat_conv_2/${textFileId}.txt`;

      mockStorageStore.set(`${bucket}:${textStoragePath}`, {
        buffer: textContent,
        mimeType: 'text/plain'
      });

      // Stored in Supabase without local buffer
      fileRegistry.set(textFileId, {
        id: textFileId,
        originalName: 'notes.txt',
        diskFilename: `${textFileId}.txt`,
        mimeType: 'text/plain',
        extension: 'TXT',
        size: textContent.length,
        formattedSize: '50 B',
        status: 'uploaded',
        uploadedAt: new Date().toISOString(),
        expiresAt: Date.now() + 7200000,
        userId: userA,
        storageProvider: 'supabase',
        storagePath: textStoragePath,
        storageBucket: bucket
      });

      // Non-owner is denied
      const crossRes = await fetch(`${baseUrl}/api/upload/${textFileId}/extraction`, {
        headers: { authorization: `Bearer ${tokenUserB}` }
      });
      assert.equal(crossRes.status, 403);

      // Owner extraction succeeds and retrieves file
      const ownRes = await fetch(`${baseUrl}/api/upload/${textFileId}/extraction`, {
        headers: { authorization: `Bearer ${tokenUserA}` }
      });
      assert.equal(ownRes.status, 200);
      const extData = await ownRes.json();
      assert.ok(extData.success || extData.hasText !== undefined);
    });

    // -----------------------------------------------------------------------
    // Test 10: Metadata Route Does Not Leak Storage Paths or Bucket
    // -----------------------------------------------------------------------
    await runTest('Metadata endpoint does not leak private bucket or storage path', async () => {
      const metaRes = await fetch(`${baseUrl}/api/upload/${attachmentIdA}`, {
        headers: { authorization: `Bearer ${tokenUserA}` }
      });
      assert.equal(metaRes.status, 200);
      const meta = await metaRes.json();
      assert.equal(meta.id, attachmentIdA);
      assert.equal(meta.storagePath, undefined, 'Must not leak private storagePath in metadata response');
      assert.equal(meta.bucket, undefined, 'Must not leak private bucket name in metadata response');
      assert.equal(meta.storageProvider, 'supabase');
    });

    // -----------------------------------------------------------------------
    // Test 11: Supabase-backed Attachment with Missing userId Rejects with 403
    // -----------------------------------------------------------------------
    await runTest('Supabase-backed attachment with missing userId rejects with 403 across all routes', async () => {
      const orphanAttId = crypto.randomUUID();
      const orphanStoragePath = `orphan/conv/${orphanAttId}.pdf`;
      mockStorageStore.set(`${bucket}:${orphanStoragePath}`, {
        buffer: pdfBuffer,
        mimeType: 'application/pdf'
      });

      fileRegistry.set(orphanAttId, {
        id: orphanAttId,
        originalName: 'orphan_report.pdf',
        diskFilename: `${orphanAttId}.pdf`,
        mimeType: 'application/pdf',
        extension: 'PDF',
        size: pdfBuffer.length,
        formattedSize: '1.2 KB',
        status: 'ready',
        uploadedAt: new Date().toISOString(),
        expiresAt: Date.now() + 7200000,
        storageProvider: 'supabase',
        storagePath: orphanStoragePath,
        storageBucket: bucket
        // userId: undefined / missing!
      });

      // 1. File retrieval
      const fileRes = await fetch(`${baseUrl}/api/upload/${orphanAttId}/file`, {
        headers: { authorization: `Bearer ${tokenUserA}` }
      });
      assert.equal(fileRes.status, 403);
      const fileErr = await fileRes.json();
      assert.equal(fileErr.code, 'STORAGE_ACCESS_DENIED');

      // 2. Preview
      const prevRes = await fetch(`${baseUrl}/api/upload/${orphanAttId}/preview`, {
        headers: { authorization: `Bearer ${tokenUserA}` }
      });
      assert.equal(prevRes.status, 403);

      // 3. Download
      const dlRes = await fetch(`${baseUrl}/api/upload/${orphanAttId}/download`, {
        headers: { authorization: `Bearer ${tokenUserA}` }
      });
      assert.equal(dlRes.status, 403);

      // 4. Metadata
      const metaRes = await fetch(`${baseUrl}/api/upload/${orphanAttId}`, {
        headers: { authorization: `Bearer ${tokenUserA}` }
      });
      assert.equal(metaRes.status, 403);
      const metaErr = await metaRes.json();
      assert.equal(metaErr.code, 'STORAGE_ACCESS_DENIED');

      // 5. Extraction
      const extRes = await fetch(`${baseUrl}/api/upload/${orphanAttId}/extraction`, {
        headers: { authorization: `Bearer ${tokenUserA}` }
      });
      assert.equal(extRes.status, 403);

      // 6. Signed URL
      const signRes = await fetch(`${baseUrl}/api/upload/${orphanAttId}/signed-url`, {
        headers: { authorization: `Bearer ${tokenUserA}` }
      });
      assert.equal(signRes.status, 403);
    });

    // -----------------------------------------------------------------------
    // Test 12: DELETE Route Behavior (Local Unauthenticated & Cloud Auth Enforcement)
    // -----------------------------------------------------------------------
    await runTest('DELETE /api/upload/:id preserves local unauthenticated deletion and enforces cloud auth', async () => {
      // 1. Local/guest record operates without auth requirement
      const localDeleteId = crypto.randomUUID();
      fileRegistry.set(localDeleteId, {
        id: localDeleteId,
        originalName: 'local_delete.txt',
        diskFilename: `${localDeleteId}.txt`,
        mimeType: 'text/plain',
        extension: 'TXT',
        size: 100,
        formattedSize: '100 B',
        status: 'ready',
        uploadedAt: new Date().toISOString(),
        expiresAt: Date.now() + 7200000,
        storageProvider: 'local'
      });

      // Call DELETE without Authorization header on local file -> 200
      const localDelRes = await fetch(`${baseUrl}/api/upload/${localDeleteId}`, {
        method: 'DELETE'
      });
      assert.equal(localDelRes.status, 200);
      const localDelData = await localDelRes.json();
      assert.equal(localDelData.success, true);
      assert.equal(localDelData.id, localDeleteId);
      assert.equal(fileRegistry.has(localDeleteId), false, 'Record must be removed from fileRegistry');

      // Calling DELETE on already deleted / missing file returns 200
      const secondDelRes = await fetch(`${baseUrl}/api/upload/${localDeleteId}`, {
        method: 'DELETE'
      });
      assert.equal(secondDelRes.status, 200);

      // 2. Cloud Supabase record rejects unauthenticated requests with 401
      const cloudDeleteId = crypto.randomUUID();
      fileRegistry.set(cloudDeleteId, {
        id: cloudDeleteId,
        originalName: 'cloud_delete.txt',
        diskFilename: `${cloudDeleteId}.txt`,
        mimeType: 'text/plain',
        extension: 'TXT',
        size: 100,
        formattedSize: '100 B',
        status: 'ready',
        uploadedAt: new Date().toISOString(),
        expiresAt: Date.now() + 7200000,
        userId: userA,
        storageProvider: 'supabase',
        storagePath: `${userA}/chatA/${cloudDeleteId}.txt`
      });

      const unauthCloudRes = await fetch(`${baseUrl}/api/upload/${cloudDeleteId}`, {
        method: 'DELETE'
      });
      assert.equal(unauthCloudRes.status, 401, 'Unauthenticated cloud deletion must be rejected with 401');

      // 3. Cloud Supabase record rejects cross-user requests with 403
      const crossUserCloudRes = await fetch(`${baseUrl}/api/upload/${cloudDeleteId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${tokenUserB}` }
      });
      assert.equal(crossUserCloudRes.status, 403, 'Cross-user cloud deletion must be rejected with 403');

      // 4. Owner can delete cloud record with 200
      const ownerCloudRes = await fetch(`${baseUrl}/api/upload/${cloudDeleteId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${tokenUserA}` }
      });
      assert.equal(ownerCloudRes.status, 200);
      const ownerCloudData = await ownerCloudRes.json();
      assert.equal(ownerCloudData.success, true);
      assert.equal(fileRegistry.has(cloudDeleteId), false);

      // Invalid ID format returns 400
      const badIdRes = await fetch(`${baseUrl}/api/upload/not-a-valid-uuid`, {
        method: 'DELETE'
      });
      assert.equal(badIdRes.status, 400);
    });

  } finally {
    server.close();
    clearTestPublicKeys();
    resetFirebaseAuthForTesting();
    resetSupabaseClientForTesting();
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v !== undefined) {
        process.env[k] = v;
      }
    }
  }

  console.log('\n================================================================');
  console.log(`RESULTS: ${passedCount} / ${totalTests} TESTS PASSED`);
  console.log('================================================================\n');

  if (passedCount !== totalTests) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Test execution fatal error:', err);
  process.exit(1);
});
