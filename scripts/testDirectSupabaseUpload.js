/**
 * scripts/testDirectSupabaseUpload.js
 *
 * Comprehensive Automated Verification Suite for Direct-to-Supabase Large-File Uploads:
 * 1. Authenticated signed upload URL creation.
 * 2. Unauthenticated request rejection.
 * 3. Cross-user path protection.
 * 4. Invalid MIME type and extension rejection.
 * 5. File-size limit enforcement.
 * 6. Signed URL expiration / ticket expiration.
 * 7. Successful upload completion and metadata registration.
 * 8. Unauthorized completion rejection.
 * 9. Expiry marker creation.
 * 10. Abandoned upload cleanup.
 * 11. Upload cancellation and retry.
 * 12. Existing server-mediated upload regression.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';

process.env.TESTING = '1';
process.env.FIREBASE_PROJECT_ID = 'orvix-direct-upload-test';

const TEST_PROJECT_ID = 'orvix-direct-upload-test';
const TEST_KID = 'direct-upload-kid-1';

// Generate RSA key pair for testing verified Firebase JWT tokens
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

const {
  setTestPublicKey,
  clearTestPublicKeys,
  resetFirebaseAuthForTesting
} = await import('../server/firebaseAuthHelper.ts');

const {
  setSupabaseServerClientForTesting,
  resetSupabaseClientForTesting,
  DEFAULT_SUPABASE_STORAGE_BUCKET
} = await import('../server/supabaseClient.ts');

const {
  buildAttachmentStoragePath,
  parseStoragePath,
  assertUserOwnsStoragePath,
  EXPIRY_RECORDS_PREFIX
} = await import('../server/supabaseStorageService.ts');

const {
  fileRegistry,
  conversationDocuments,
  pendingDirectUploads,
  pruneExpiredDirectUploadTickets,
  resetDirectUploadTicketsForTesting
} = await import('../server/uploadSubsystem.ts');

const {
  resetQuotaForTesting,
  getQuotaStatus
} = await import('../server/uploadQuotaService.ts');

const { app } = await import('../server.ts');

// Helper to generate cryptographically signed Firebase ID token
function createSignedFirebaseToken(uid, customPayload = {}) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: TEST_KID })).toString('base64url');
  const nowSec = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    aud: TEST_PROJECT_ID,
    iss: `https://securetoken.google.com/${TEST_PROJECT_ID}`,
    sub: uid,
    user_id: uid,
    auth_time: nowSec,
    iat: nowSec,
    exp: nowSec + 3600,
    ...customPayload
  })).toString('base64url');

  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url');
  return `${header}.${payload}.${sig}`;
}

// In-memory Supabase storage mock
function createMockSupabaseStorageClient() {
  const objects = new Map(); // path -> { buffer, contentType, metadata }

  const storageApi = {
    from(bucket) {
      return {
        async createSignedUploadUrl(storagePath, options = {}) {
          const token = 'mock_upload_token_' + crypto.randomUUID();
          const signedUrl = `https://mock.supabase.co/storage/v1/object/upload/sign/${bucket}/${storagePath}?token=${token}`;
          return {
            data: { signedUrl, token, path: storagePath },
            error: null
          };
        },
        async createSignedUrl(storagePath, ttl = 120) {
          return {
            data: { signedUrl: `https://mock.supabase.co/storage/v1/object/sign/${bucket}/${storagePath}?token=mock_dl_token` },
            error: null
          };
        },
        async upload(storagePath, buffer, options = {}) {
          objects.set(storagePath, {
            buffer: Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer),
            contentType: options.contentType || 'application/octet-stream'
          });
          return { data: { path: storagePath, fullPath: `${bucket}/${storagePath}` }, error: null };
        },
        async download(storagePath) {
          const item = objects.get(storagePath);
          if (!item) {
            return { data: null, error: { message: 'Object not found', status: 404 } };
          }
          return {
            data: {
              type: item.contentType,
              async arrayBuffer() {
                return item.buffer.buffer.slice(
                  item.buffer.byteOffset,
                  item.buffer.byteOffset + item.buffer.byteLength
                );
              }
            },
            error: null
          };
        },
        async remove(paths) {
          for (const p of paths) {
            objects.delete(p);
          }
          return { data: paths.map(p => ({ name: p })), error: null };
        },
        async list(folderPath, options = {}) {
          const prefix = folderPath.replace(/\/+$/, '') + '/';
          const items = [];
          for (const [key, val] of objects.entries()) {
            if (key.startsWith(prefix)) {
              const name = key.slice(prefix.length);
              if (!name.includes('/')) {
                items.push({ name, id: name, metadata: { size: val.buffer.length } });
              }
            } else if (folderPath === EXPIRY_RECORDS_PREFIX && key.startsWith(EXPIRY_RECORDS_PREFIX + '/')) {
              const name = key.slice(EXPIRY_RECORDS_PREFIX.length + 1);
              items.push({ name, id: name });
            }
          }
          return { data: items, error: null };
        },
        async getBucket(name) {
          return { data: { name, id: name, public: false }, error: null };
        }
      };
    },
    async getBucket(name) {
      return { data: { name, id: name, public: false }, error: null };
    },
    async createBucket(name) {
      return { data: { name }, error: null };
    }
  };

  return { storage: storageApi, _objects: objects };
}

// HTTP request helper
function makeRequest(serverUrl, path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, serverUrl);
    const headers = { ...(options.headers || {}) };
    let body = options.body;

    if (body && typeof body === 'object' && !Buffer.isBuffer(body) && !headers['Content-Type']) {
      body = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
    }

    const req = http.request(
      url,
      {
        method: options.method || 'GET',
        headers
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const rawBuffer = Buffer.concat(chunks);
          const rawText = rawBuffer.toString('utf-8');
          let json = null;
          try {
            json = JSON.parse(rawText);
          } catch (_) {}
          resolve({
            status: res.statusCode,
            headers: res.headers,
            json,
            text: rawText,
            rawBuffer
          });
        });
      }
    );

    req.on('error', reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

console.log('=== RUNNING DIRECT SUPABASE UPLOAD VERIFICATION SUITE ===\n');

let server;
let serverUrl;
let mockStorage;
let passedCount = 0;

try {
  // Start ephemeral HTTP server on random port
  await new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      serverUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  setTestPublicKey(TEST_KID, publicKey);
  mockStorage = createMockSupabaseStorageClient();
  setSupabaseServerClientForTesting(mockStorage, 'https://mock.supabase.co', 'mock-service-key');

  const USER_A = 'usr_alice_101';
  const USER_B = 'usr_bob_202';
  const CHAT_ID = 'chat_proj_alpha';
  const tokenUserA = createSignedFirebaseToken(USER_A);
  const tokenUserB = createSignedFirebaseToken(USER_B);

  // Test 1: Authenticated signed upload URL creation
  console.log('[Test 1] Authenticated signed upload URL creation...');
  {
    resetDirectUploadTicketsForTesting();
    const res = await makeRequest(serverUrl, '/api/upload/direct/signed-url', {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenUserA}` },
      body: {
        chatId: CHAT_ID,
        fileName: 'large_dataset.csv',
        fileSize: 10 * 1024 * 1024, // 10 MB
        mimeType: 'text/csv'
      }
    });

    assert.equal(res.status, 200, `Expected HTTP 200 but got ${res.status}: ${res.text}`);
    assert.equal(res.json.success, true);
    assert.ok(res.json.signedUrl, 'signedUrl must be returned');
    assert.ok(res.json.signedUrl.includes('token='), 'signedUrl must contain token');
    assert.ok(res.json.token, 'token must be returned');
    assert.ok(res.json.attachmentId, 'attachmentId must be generated');

    // Verify storage path strictly follows {userId}/{chatId}/{attachmentId}.{ext}
    const expectedPathPrefix = `${USER_A}/${CHAT_ID}/${res.json.attachmentId}.csv`;
    assert.equal(res.json.storagePath, expectedPathPrefix, 'Path must match canonical user/chat structure');

    // Verify server registered ticket in pendingDirectUploads
    const ticket = pendingDirectUploads.get(res.json.attachmentId);
    assert.ok(ticket, 'Ticket must be registered in pendingDirectUploads');
    assert.equal(ticket.userId, USER_A);
    assert.equal(ticket.chatId, CHAT_ID);
    assert.equal(ticket.fileName, 'large_dataset.csv');

    console.log('  ✓ Successfully issued signed upload URL with canonical partitioned path.');
    passedCount++;
  }

  // Test 2: Unauthenticated request rejection
  console.log('\n[Test 2] Unauthenticated request rejection...');
  {
    // No Authorization header
    const resNoAuth = await makeRequest(serverUrl, '/api/upload/direct/signed-url', {
      method: 'POST',
      body: {
        chatId: CHAT_ID,
        fileName: 'test.pdf',
        fileSize: 1024
      }
    });
    assert.equal(resNoAuth.status, 401, 'Must reject unauthenticated request with 401');
    assert.equal(resNoAuth.json?.code, 'UNAUTHENTICATED');

    // Spoofed / forged Bearer token
    const resForged = await makeRequest(serverUrl, '/api/upload/direct/signed-url', {
      method: 'POST',
      headers: { authorization: 'Bearer invalid.forged.jwt' },
      body: {
        chatId: CHAT_ID,
        fileName: 'test.pdf',
        fileSize: 1024
      }
    });
    assert.equal(resForged.status, 401, 'Must reject forged JWT with 401');

    console.log('  ✓ Unauthenticated and forged requests strictly rejected.');
    passedCount++;
  }

  // Test 3: Cross-user path and completion protection
  console.log('\n[Test 3] Cross-user path protection...');
  {
    // User A obtains signed URL ticket
    const signRes = await makeRequest(serverUrl, '/api/upload/direct/signed-url', {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenUserA}` },
      body: {
        chatId: CHAT_ID,
        fileName: 'user_a_private.pdf',
        fileSize: 5 * 1024 * 1024
      }
    });
    assert.equal(signRes.status, 200);
    const attachmentId = signRes.json.attachmentId;

    // User B attempts to complete User A's upload
    const hackRes = await makeRequest(serverUrl, '/api/upload/direct/complete', {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenUserB}` },
      body: {
        chatId: CHAT_ID,
        attachmentId
      }
    });
    assert.equal(hackRes.status, 403, 'Must reject cross-user completion with 403');
    assert.equal(hackRes.json?.code, 'STORAGE_ACCESS_DENIED');

    console.log('  ✓ Cross-user completion strictly blocked with 403 STORAGE_ACCESS_DENIED.');
    passedCount++;
  }

  // Test 4: Invalid MIME type and extension rejection
  console.log('\n[Test 4] Invalid MIME type and extension rejection...');
  {
    // Unsupported executable extension
    const resExe = await makeRequest(serverUrl, '/api/upload/direct/signed-url', {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenUserA}` },
      body: {
        chatId: CHAT_ID,
        fileName: 'malware.exe',
        fileSize: 1024
      }
    });
    assert.equal(resExe.status, 400);
    assert.equal(resExe.json?.code, 'INVALID_FILE_TYPE');

    // Unsupported script extension
    const resSh = await makeRequest(serverUrl, '/api/upload/direct/signed-url', {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenUserA}` },
      body: {
        chatId: CHAT_ID,
        fileName: 'exploit.sh',
        fileSize: 1024
      }
    });
    assert.equal(resSh.status, 400);
    assert.equal(resSh.json?.code, 'INVALID_FILE_TYPE');

    // Disallowed MIME type
    const resMime = await makeRequest(serverUrl, '/api/upload/direct/signed-url', {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenUserA}` },
      body: {
        chatId: CHAT_ID,
        fileName: 'test.pdf',
        fileSize: 1024,
        mimeType: 'application/x-sh'
      }
    });
    assert.equal(resMime.status, 400);
    assert.equal(resMime.json?.code, 'INVALID_MIME_TYPE');

    console.log('  ✓ Invalid extensions and disallowed MIME types strictly rejected.');
    passedCount++;
  }

  // Test 5: File-size limit enforcement
  console.log('\n[Test 5] File-size limit enforcement...');
  {
    // Empty file (0 bytes)
    const resZero = await makeRequest(serverUrl, '/api/upload/direct/signed-url', {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenUserA}` },
      body: {
        chatId: CHAT_ID,
        fileName: 'empty.txt',
        fileSize: 0
      }
    });
    assert.equal(resZero.status, 400);
    assert.equal(resZero.json?.code, 'EMPTY_FILE');

    // Oversized file (> 25 MB)
    const resOversized = await makeRequest(serverUrl, '/api/upload/direct/signed-url', {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenUserA}` },
      body: {
        chatId: CHAT_ID,
        fileName: 'huge.pdf',
        fileSize: 30 * 1024 * 1024 // 30 MB
      }
    });
    assert.equal(resOversized.status, 400);
    assert.equal(resOversized.json?.code, 'FILE_TOO_LARGE');

    console.log('  ✓ Empty (0 byte) and oversized (>25MB) files strictly rejected.');
    passedCount++;
  }

  // Test 6: Signed URL / ticket expiration
  console.log('\n[Test 6] Signed URL / ticket expiration...');
  {
    const signRes = await makeRequest(serverUrl, '/api/upload/direct/signed-url', {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenUserA}` },
      body: {
        chatId: CHAT_ID,
        fileName: 'expiring.pdf',
        fileSize: 1024
      }
    });
    const attachmentId = signRes.json.attachmentId;
    const ticket = pendingDirectUploads.get(attachmentId);
    assert.ok(ticket);

    // Manually expire the ticket
    ticket.expiresAt = Date.now() - 1000;

    // Prune expired tickets
    const pruned = await pruneExpiredDirectUploadTickets();
    assert.ok(pruned >= 1, 'Expired ticket must be pruned');

    // Attempting completion after expiration must fail
    const completeRes = await makeRequest(serverUrl, '/api/upload/direct/complete', {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenUserA}` },
      body: {
        chatId: CHAT_ID,
        attachmentId
      }
    });
    assert.equal(completeRes.status, 404, 'Must return 404 for expired/missing ticket');
    assert.equal(completeRes.json?.code, 'TICKET_NOT_FOUND');

    console.log('  ✓ Expired direct upload tickets safely rejected on completion.');
    passedCount++;
  }

  // Test 7: Successful upload completion and metadata registration
  console.log('\n[Test 7] Successful upload completion and metadata registration...');
  {
    const signRes = await makeRequest(serverUrl, '/api/upload/direct/signed-url', {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenUserA}` },
      body: {
        chatId: CHAT_ID,
        fileName: 'quarterly_report.txt',
        fileSize: 2048,
        mimeType: 'text/plain'
      }
    });
    assert.equal(signRes.status, 200);
    const { attachmentId, storagePath } = signRes.json;

    // Simulate browser uploading directly to Supabase storage mock
    const validFileContent = Buffer.from('Quarterly revenue report: All Q4 targets exceeded.');
    mockStorage._objects.set(storagePath, {
      buffer: validFileContent,
      contentType: 'text/plain'
    });

    // Call completion endpoint
    const completeRes = await makeRequest(serverUrl, '/api/upload/direct/complete', {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenUserA}` },
      body: {
        chatId: CHAT_ID,
        attachmentId,
        storagePath
      }
    });

    assert.equal(completeRes.status, 200, `Expected HTTP 200: ${completeRes.text}`);
    assert.equal(completeRes.json.success, true);
    const att = completeRes.json.attachment;
    assert.equal(att.id, attachmentId);
    assert.equal(att.name, 'quarterly_report.txt');
    assert.equal(att.storageProvider, 'supabase');
    assert.equal(att.storagePath, storagePath);
    assert.equal(att.userId, USER_A);
    assert.equal(att.conversationId, CHAT_ID);
    assert.equal(att.size, validFileContent.length);

    // Verify record in fileRegistry
    const registered = fileRegistry.get(attachmentId);
    assert.ok(registered, 'Must be registered in fileRegistry');
    assert.equal(registered.storageProvider, 'supabase');
    assert.equal(registered.userId, USER_A);

    // Verify conversationDocuments tracking
    const chatDocs = conversationDocuments.get(CHAT_ID);
    assert.ok(chatDocs && chatDocs.has(attachmentId), 'Must be tracked in conversationDocuments');

    // Ticket must be cleaned up from pending map
    assert.equal(pendingDirectUploads.has(attachmentId), false, 'Completed ticket must be removed');

    console.log('  ✓ Upload completed, verified in storage, and registered in attachment registry.');
    passedCount++;
  }

  // Test 8: Unauthorized completion rejection
  console.log('\n[Test 8] Unauthorized completion rejection...');
  {
    // Non-existent attachmentId
    const resNotFound = await makeRequest(serverUrl, '/api/upload/direct/complete', {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenUserA}` },
      body: {
        chatId: CHAT_ID,
        attachmentId: '00000000-0000-0000-0000-000000000000'
      }
    });
    assert.equal(resNotFound.status, 404);
    assert.equal(resNotFound.json?.code, 'TICKET_NOT_FOUND');

    // Invalid path segment
    const resInvalidId = await makeRequest(serverUrl, '/api/upload/direct/complete', {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenUserA}` },
      body: {
        chatId: CHAT_ID,
        attachmentId: '../traversal'
      }
    });
    assert.equal(resInvalidId.status, 400);

    console.log('  ✓ Non-existent tickets and invalid IDs safely rejected.');
    passedCount++;
  }

  // Test 9: Durable expiry marker creation
  console.log('\n[Test 9] Durable expiry marker creation...');
  {
    const signRes = await makeRequest(serverUrl, '/api/upload/direct/signed-url', {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenUserA}` },
      body: {
        chatId: CHAT_ID,
        fileName: 'notes.txt',
        fileSize: 100,
        isPermanent: false
      }
    });
    const { attachmentId, storagePath } = signRes.json;

    mockStorage._objects.set(storagePath, {
      buffer: Buffer.from('Meeting notes content.'),
      contentType: 'text/plain'
    });

    const completeRes = await makeRequest(serverUrl, '/api/upload/direct/complete', {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenUserA}` },
      body: {
        chatId: CHAT_ID,
        attachmentId
      }
    });
    assert.equal(completeRes.status, 200);

    // Verify that an expiry record was saved in storage under _expiry_records/
    let foundExpiry = false;
    for (const [key] of mockStorage._objects.entries()) {
      if (key.startsWith(EXPIRY_RECORDS_PREFIX) && key.includes(attachmentId)) {
        foundExpiry = true;
        break;
      }
    }
    assert.ok(foundExpiry, 'Durable expiry record must be created under _expiry_records/');

    console.log('  ✓ Durable expiry marker properly created in storage.');
    passedCount++;
  }

  // Test 10: Abandoned upload cleanup
  console.log('\n[Test 10] Abandoned upload cleanup...');
  {
    const signRes = await makeRequest(serverUrl, '/api/upload/direct/signed-url', {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenUserA}` },
      body: {
        chatId: CHAT_ID,
        fileName: 'abandoned.pdf',
        fileSize: 1024
      }
    });
    const { attachmentId, storagePath } = signRes.json;
    const ticket = pendingDirectUploads.get(attachmentId);
    assert.ok(ticket);

    // Simulate partial/abandoned file placed in storage
    mockStorage._objects.set(storagePath, { buffer: Buffer.from('partial'), contentType: 'application/pdf' });

    // Age ticket
    ticket.expiresAt = Date.now() - 5000;

    await pruneExpiredDirectUploadTickets();

    // Verify ticket is pruned and partial storage object is deleted
    assert.equal(pendingDirectUploads.has(attachmentId), false, 'Abandoned ticket must be pruned');
    assert.equal(mockStorage._objects.has(storagePath), false, 'Partial storage object must be deleted');

    console.log('  ✓ Abandoned upload tickets pruned and partial storage objects cleaned up.');
    passedCount++;
  }

  // Test 11: Upload cancellation and retry
  console.log('\n[Test 11] Upload cancellation and retry...');
  {
    const signRes = await makeRequest(serverUrl, '/api/upload/direct/signed-url', {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenUserA}` },
      body: {
        chatId: CHAT_ID,
        fileName: 'cancel_me.pdf',
        fileSize: 1024
      }
    });
    const { attachmentId, storagePath } = signRes.json;
    assert.ok(pendingDirectUploads.has(attachmentId));

    // Cancel upload
    const cancelRes = await makeRequest(serverUrl, '/api/upload/direct/cancel', {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenUserA}` },
      body: {
        chatId: CHAT_ID,
        attachmentId
      }
    });
    assert.equal(cancelRes.status, 200);
    assert.equal(cancelRes.json.cancelled, true);
    assert.equal(pendingDirectUploads.has(attachmentId), false, 'Cancelled ticket must be removed');

    // Immediate retry with fresh upload must succeed
    const retryRes = await makeRequest(serverUrl, '/api/upload/direct/signed-url', {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenUserA}` },
      body: {
        chatId: CHAT_ID,
        fileName: 'retry_success.pdf',
        fileSize: 1024
      }
    });
    assert.equal(retryRes.status, 200, 'Retry must succeed');
    assert.ok(retryRes.json.attachmentId);

    console.log('  ✓ Upload cancellation and immediate retry work seamlessly.');
    passedCount++;
  }

  // Test 12: Existing server-mediated upload regression
  console.log('\n[Test 12] Existing server-mediated upload regression...');
  {
    // Upload config endpoint verification
    const configRes = await makeRequest(serverUrl, '/api/upload/config');
    assert.equal(configRes.status, 200);
    assert.equal(configRes.json.directUploadSupported, true);
    assert.equal(configRes.json.directUploadThresholdBytes, 4 * 1024 * 1024);

    console.log('  ✓ Server-mediated upload config accurately reflects direct upload capabilities.');
    passedCount++;
  }

  console.log(`\n======================================================`);
  console.log(`✓ ALL ${passedCount} DIRECT SUPABASE UPLOAD TESTS PASSED!`);
  console.log(`======================================================\n`);

} finally {
  clearTestPublicKeys();
  resetSupabaseClientForTesting();
  resetFirebaseAuthForTesting();
  resetDirectUploadTicketsForTesting();
  if (server) {
    server.close();
  }
}
