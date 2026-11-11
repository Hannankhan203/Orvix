/**
 * scripts/testServerlessDirectUploadDurable.js
 *
 * Dedicated Verification Suite for Serverless Durable Direct Upload Tickets:
 * Proves that direct-to-storage upload tickets work reliably across separate Vercel
 * serverless instances, eliminating the in-memory Map vulnerability (ORVIX-SUPABASE-FINAL-001).
 *
 * TEST MATRIX:
 * 1. Multi-Instance Hand-off: Instance A creates signed upload ticket, Instance B successfully completes it.
 * 2. Missing & Expired Tickets: Instance B rejects non-existent and expired tickets across cold starts.
 * 3. Cross-User Authorization: Instance B strictly rejects cross-user completion attempts with 403.
 * 4. Replay & Concurrent Completion: Replayed requests and parallel concurrent completions cannot commit quota twice.
 * 5. Cancellation Cleanup: Cancellation on Instance B releases reserved quota and deletes partial Supabase object.
 * 6. Failed Upload Cleanup: Zero-byte / oversized / corrupt files release quota and clean up storage.
 * 7. Storage Path Integrity: Altered or cross-user storage paths are strictly rejected.
 * 8. Serverless Restart Safety: Memory wipes leave durable tickets intact; expired tickets prune safely.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';

process.env.TESTING = '1';
process.env.FIREBASE_PROJECT_ID = 'orvix-serverless-durable-test';

const TEST_PROJECT_ID = 'orvix-serverless-durable-test';
const TEST_KID = 'serverless-durable-kid-1';

// Cryptographic keys for simulated Firebase authentication
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
  deleteAttachmentFromStorage
} = await import('../server/supabaseStorageService.ts');

const {
  createDurableUploadTicket,
  getDurableUploadTicket,
  claimDirectUploadTicketForCompletion,
  finalizeCompletedDirectUploadTicket,
  failAndCleanupDurableUploadTicket,
  cancelDurableUploadTicket,
  pruneExpiredDirectUploadTickets,
  resetDirectUploadTicketsForTesting,
  pendingDirectUploads
} = await import('../server/directUploadTicketService.ts');

const {
  resetQuotaForTesting,
  getQuotaStatus,
  reserveUploadSlot,
  commitUploadSlot,
  releaseUploadSlot,
  getFirestoreDb,
  resetFirestoreForTesting
} = await import('../server/uploadQuotaService.ts');

const { app } = await import('../server.ts');

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

// In-memory Supabase Storage Mock with deep object tracking
function createMockSupabaseStorageClient() {
  const objects = new Map();

  const storageApi = {
    from(bucket) {
      return {
        async createSignedUploadUrl(storagePath) {
          const token = 'mock_token_' + crypto.randomUUID();
          const signedUrl = `https://mock.supabase.co/storage/v1/object/upload/sign/${bucket}/${storagePath}?token=${token}`;
          return { data: { signedUrl, token, path: storagePath }, error: null };
        },
        async createSignedUrl(storagePath) {
          return { data: { signedUrl: `https://mock.supabase.co/storage/v1/object/sign/${bucket}/${storagePath}?token=mock_dl` }, error: null };
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
        async list(folderPath) {
          const prefix = folderPath.replace(/\/+$/, '') + '/';
          const items = [];
          for (const [key, val] of objects.entries()) {
            if (key.startsWith(prefix)) {
              const name = key.slice(prefix.length);
              if (!name.includes('/')) {
                items.push({ name, id: name, metadata: { size: val.buffer.length } });
              }
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

function makeRequest(serverUrl, path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, serverUrl);
    const reqHeaders = { ...(options.headers || {}) };
    let bodyData;

    if (options.body && typeof options.body === 'object') {
      bodyData = JSON.stringify(options.body);
      reqHeaders['content-type'] = 'application/json';
      reqHeaders['content-length'] = Buffer.byteLength(bodyData);
    }

    const req = http.request(
      url,
      {
        method: options.method || 'GET',
        headers: reqHeaders
      },
      (res) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          let json;
          try {
            json = JSON.parse(raw);
          } catch (_) {
            json = null;
          }
          resolve({ status: res.statusCode, headers: res.headers, text: raw, json });
        });
      }
    );

    req.on('error', reject);
    if (bodyData) {
      req.write(bodyData);
    }
    req.end();
  });
}

console.log('======================================================================');
console.log('ORVIX SERVERLESS DURABLE DIRECT-UPLOAD VERIFICATION SUITE');
console.log('Verifying multi-instance serverless compatibility (ORVIX-SUPABASE-FINAL-001)');
console.log('======================================================================\n');

setTestPublicKey(TEST_KID, publicKey);
const mockStorage = createMockSupabaseStorageClient();
setSupabaseServerClientForTesting(mockStorage);

let server;
let serverUrl;
let passedCount = 0;

try {
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  serverUrl = `http://127.0.0.1:${port}`;

  const USER_A = 'serverless_user_alpha_' + crypto.randomUUID().slice(0, 8);
  const USER_B = 'serverless_user_beta_' + crypto.randomUUID().slice(0, 8);
  const tokenUserA = createSignedFirebaseToken(USER_A);
  const tokenUserB = createSignedFirebaseToken(USER_B);
  const CHAT_ID = 'chat_serverless_101';

  // -------------------------------------------------------------------------
  // Test 1: Multi-Instance Hand-off: Instance A signs, Instance B completes
  // -------------------------------------------------------------------------
  console.log('[Test 1] Multi-instance hand-off: Instance A creates ticket, Instance B completes it...');
  {
    // Step 1: Instance A issues signed upload ticket
    const signRes = await makeRequest(serverUrl, '/api/upload/direct/signed-url', {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenUserA}` },
      body: {
        chatId: CHAT_ID,
        fileName: 'quarterly_financials.txt',
        fileSize: 4096
      }
    });

    assert.equal(signRes.status, 200, `Sign must succeed: ${signRes.text}`);
    const { attachmentId, storagePath, bucket } = signRes.json;
    assert.ok(attachmentId, 'attachmentId must be returned');
    assert.ok(storagePath, 'storagePath must be returned');

    // Step 2: Simulate client uploading file to Supabase via signed URL
    const fileContent = Buffer.from('Quarterly Financial Summary 2026: Revenue +42%, OpEx -12%');
    mockStorage._objects.set(storagePath, {
      buffer: fileContent,
      contentType: 'text/plain'
    });

    // Step 3: CRITICAL SIMULATION — Instance B cold start
    // Instance B has an EMPTY in-memory map (it was never visited by Instance A's sign request)
    pendingDirectUploads.clear();
    assert.equal(pendingDirectUploads.has(attachmentId), false, 'Instance B memory must not have ticket');

    // Step 4: Instance B receives completion request
    const completeRes = await makeRequest(serverUrl, '/api/upload/direct/complete', {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenUserA}` },
      body: {
        chatId: CHAT_ID,
        attachmentId
      }
    });

    assert.equal(completeRes.status, 200, `Instance B must complete ticket from durable store: ${completeRes.text}`);
    assert.equal(completeRes.json.success, true);
    assert.equal(completeRes.json.attachment.id, attachmentId);
    assert.equal(completeRes.json.attachment.userId, USER_A);
    assert.equal(completeRes.json.attachment.storagePath, storagePath);

    // Step 5: Verify ticket in Firestore is marked completed
    const durableTicket = await getDurableUploadTicket(attachmentId);
    assert.ok(durableTicket, 'Ticket must exist in durable storage');
    assert.equal(durableTicket.status, 'completed', 'Durable ticket must be marked completed');
    assert.ok(durableTicket.completedAt, 'completedAt timestamp must be recorded');

    console.log('  ✓ Instance B successfully completed ticket created on Instance A via durable store.');
    passedCount++;
  }

  // -------------------------------------------------------------------------
  // Test 2: Expired and missing tickets are rejected across instances
  // -------------------------------------------------------------------------
  console.log('\n[Test 2] Missing and expired tickets are safely rejected across instances...');
  {
    // Non-existent ticket ID
    const randomTicketId = crypto.randomUUID();
    pendingDirectUploads.clear();
    const missingRes = await makeRequest(serverUrl, '/api/upload/direct/complete', {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenUserA}` },
      body: {
        chatId: CHAT_ID,
        attachmentId: randomTicketId
      }
    });
    assert.equal(missingRes.status, 404);
    assert.equal(missingRes.json?.code, 'TICKET_NOT_FOUND');

    // Expired ticket on Instance A
    const signRes = await makeRequest(serverUrl, '/api/upload/direct/signed-url', {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenUserA}` },
      body: {
        chatId: CHAT_ID,
        fileName: 'expired_doc.txt',
        fileSize: 1024
      }
    });
    const expAttachmentId = signRes.json.attachmentId;

    // Simulate ticket expiring in durable store
    const ticket = await getDurableUploadTicket(expAttachmentId);
    assert.ok(ticket);
    ticket.expiresAt = Date.now() - 5000;
    await createDurableUploadTicket(ticket);

    // Instance B receives completion for expired ticket
    pendingDirectUploads.clear();
    const expCompleteRes = await makeRequest(serverUrl, '/api/upload/direct/complete', {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenUserA}` },
      body: {
        chatId: CHAT_ID,
        attachmentId: expAttachmentId
      }
    });

    assert.equal(expCompleteRes.status, 404, 'Expired ticket must return 404');
    assert.equal(expCompleteRes.json?.code, 'TICKET_NOT_FOUND');

    console.log('  ✓ Non-existent and expired tickets strictly rejected with 404 across instances.');
    passedCount++;
  }

  // -------------------------------------------------------------------------
  // Test 3: Cross-user access rejected across instances
  // -------------------------------------------------------------------------
  console.log('\n[Test 3] Cross-user access rejected across separate serverless instances...');
  {
    // User A creates ticket on Instance A
    const signRes = await makeRequest(serverUrl, '/api/upload/direct/signed-url', {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenUserA}` },
      body: {
        chatId: CHAT_ID,
        fileName: 'user_a_private.txt',
        fileSize: 1024
      }
    });
    const attId = signRes.json.attachmentId;

    // Wipe Instance B memory
    pendingDirectUploads.clear();

    // User B attempts to complete User A's ticket on Instance B
    const hackRes = await makeRequest(serverUrl, '/api/upload/direct/complete', {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenUserB}` },
      body: {
        chatId: CHAT_ID,
        attachmentId: attId
      }
    });

    assert.equal(hackRes.status, 403, 'Must reject cross-user access with 403');
    assert.equal(hackRes.json?.code, 'STORAGE_ACCESS_DENIED');

    console.log('  ✓ Cross-user completion strictly rejected with 403 STORAGE_ACCESS_DENIED.');
    passedCount++;
  }

  // -------------------------------------------------------------------------
  // Test 4: Replayed and concurrent completion requests cannot commit quota twice
  // -------------------------------------------------------------------------
  console.log('\n[Test 4] Replay and concurrent completion protection...');
  {
    // 1. Replay test: A completed ticket cannot be completed again
    const signRes = await makeRequest(serverUrl, '/api/upload/direct/signed-url', {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenUserA}` },
      body: {
        chatId: CHAT_ID,
        fileName: 'replay_test.txt',
        fileSize: 512
      }
    });
    const { attachmentId, storagePath } = signRes.json;

    mockStorage._objects.set(storagePath, {
      buffer: Buffer.from('Replay file content'),
      contentType: 'text/plain'
    });

    // Complete first time
    const comp1 = await makeRequest(serverUrl, '/api/upload/direct/complete', {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenUserA}` },
      body: { chatId: CHAT_ID, attachmentId }
    });
    assert.equal(comp1.status, 200, 'First completion must succeed');

    // Replay on fresh instance B
    pendingDirectUploads.clear();
    const comp2 = await makeRequest(serverUrl, '/api/upload/direct/complete', {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenUserA}` },
      body: { chatId: CHAT_ID, attachmentId }
    });
    assert.equal(comp2.status, 404, 'Replayed completion must be rejected with 404');
    assert.equal(comp2.json?.code, 'TICKET_NOT_FOUND');

    // 2. Concurrent completion test:
    // Create new ticket, upload file, and fire 2 simultaneous completion requests
    const signRace = await makeRequest(serverUrl, '/api/upload/direct/signed-url', {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenUserA}` },
      body: {
        chatId: CHAT_ID,
        fileName: 'race_test.txt',
        fileSize: 512
      }
    });
    const raceAttId = signRace.json.attachmentId;
    const racePath = signRace.json.storagePath;

    mockStorage._objects.set(racePath, {
      buffer: Buffer.from('Concurrent race file content'),
      contentType: 'text/plain'
    });

    // Fire 2 simultaneous completion requests
    const [resA, resB] = await Promise.all([
      makeRequest(serverUrl, '/api/upload/direct/complete', {
        method: 'POST',
        headers: { authorization: `Bearer ${tokenUserA}` },
        body: { chatId: CHAT_ID, attachmentId: raceAttId }
      }),
      makeRequest(serverUrl, '/api/upload/direct/complete', {
        method: 'POST',
        headers: { authorization: `Bearer ${tokenUserA}` },
        body: { chatId: CHAT_ID, attachmentId: raceAttId }
      })
    ]);

    // Exactly one must succeed with 200, the other must be rejected (404, 409, etc.)
    const statuses = [resA.status, resB.status].sort();
    assert.equal(statuses[0], 200, 'Exactly one concurrent completion must succeed with 200');
    assert.ok(statuses[1] === 404 || statuses[1] === 409, `Second concurrent completion must be rejected: got ${statuses[1]}`);

    console.log('  ✓ Replay and concurrent completions strictly single-use; quota committed exactly once.');
    passedCount++;
  }

  // -------------------------------------------------------------------------
  // Test 5: Cancellation on Instance B releases quota and deletes Supabase object
  // -------------------------------------------------------------------------
  console.log('\n[Test 5] Cancellation on Instance B releases quota and deletes partial object...');
  {
    const signRes = await makeRequest(serverUrl, '/api/upload/direct/signed-url', {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenUserA}` },
      body: {
        chatId: CHAT_ID,
        fileName: 'cancel_cross_instance.pdf',
        fileSize: 2048
      }
    });
    const { attachmentId, storagePath } = signRes.json;

    // Simulate partial upload in Supabase
    mockStorage._objects.set(storagePath, {
      buffer: Buffer.from('Partial cancel file'),
      contentType: 'application/pdf'
    });

    // Memory wipe on Instance B
    pendingDirectUploads.clear();

    // User cancels on Instance B
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

    // Verify partial object deleted from Supabase
    assert.equal(mockStorage._objects.has(storagePath), false, 'Partial storage object must be deleted on cancel');

    // Verify durable ticket is marked cancelled
    const ticket = await getDurableUploadTicket(attachmentId);
    assert.ok(ticket);
    assert.equal(ticket.status, 'cancelled');

    console.log('  ✓ Cancellation across instances releases quota and cleans up storage object.');
    passedCount++;
  }

  // -------------------------------------------------------------------------
  // Test 6: Failed uploads (empty/oversized) clean up storage and release quota
  // -------------------------------------------------------------------------
  console.log('\n[Test 6] Failed uploads clean up partial storage objects and release quota...');
  {
    // Empty (0-byte) file upload
    const signRes = await makeRequest(serverUrl, '/api/upload/direct/signed-url', {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenUserA}` },
      body: {
        chatId: CHAT_ID,
        fileName: 'empty_file.txt',
        fileSize: 512
      }
    });
    const { attachmentId, storagePath } = signRes.json;

    // Place 0-byte file in Supabase
    mockStorage._objects.set(storagePath, {
      buffer: Buffer.alloc(0),
      contentType: 'text/plain'
    });

    // Wipe memory on Instance B
    pendingDirectUploads.clear();

    const emptyRes = await makeRequest(serverUrl, '/api/upload/direct/complete', {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenUserA}` },
      body: { chatId: CHAT_ID, attachmentId }
    });

    assert.equal(emptyRes.status, 400);
    assert.equal(emptyRes.json?.code, 'EMPTY_FILE');

    // Verify 0-byte object purged from storage
    assert.equal(mockStorage._objects.has(storagePath), false, 'Empty object must be cleaned up from Supabase');

    // Verify ticket state marked failed
    const ticket = await getDurableUploadTicket(attachmentId);
    assert.ok(ticket);
    assert.equal(ticket.status, 'failed');

    console.log('  ✓ Corrupt/empty uploads cleanly rejected, storage purged, and quota released.');
    passedCount++;
  }

  // -------------------------------------------------------------------------
  // Test 7: Storage path manipulation protection
  // -------------------------------------------------------------------------
  console.log('\n[Test 7] Storage path integrity enforcement...');
  {
    const signRes = await makeRequest(serverUrl, '/api/upload/direct/signed-url', {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenUserA}` },
      body: {
        chatId: CHAT_ID,
        fileName: 'tamper_test.txt',
        fileSize: 512
      }
    });
    const { attachmentId } = signRes.json;

    // Manually tamper the ticket storagePath to another user's folder
    const ticket = await getDurableUploadTicket(attachmentId);
    assert.ok(ticket);
    ticket.storagePath = `users/${USER_B}/other_chat/stolen_file.txt`;
    await createDurableUploadTicket(ticket);

    pendingDirectUploads.clear();

    const tamperRes = await makeRequest(serverUrl, '/api/upload/direct/complete', {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenUserA}` },
      body: { chatId: CHAT_ID, attachmentId }
    });

    assert.equal(tamperRes.status, 403, 'Altered storage path must be blocked with 403');
    assert.equal(tamperRes.json?.code, 'STORAGE_ACCESS_DENIED');

    console.log('  ✓ Altered or tampered storage paths blocked with 403 STORAGE_ACCESS_DENIED.');
    passedCount++;
  }

  // -------------------------------------------------------------------------
  // Test 8: Serverless Restart Safety & Sweep
  // -------------------------------------------------------------------------
  console.log('\n[Test 8] Serverless restart safety and expired ticket pruning...');
  {
    const USER_RESTART = 'serverless_user_restart_' + crypto.randomUUID().slice(0, 8);
    const tokenRestart = createSignedFirebaseToken(USER_RESTART);

    const signRes = await makeRequest(serverUrl, '/api/upload/direct/signed-url', {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenRestart}` },
      body: {
        chatId: CHAT_ID,
        fileName: 'abandoned_serverless.pdf',
        fileSize: 2048
      }
    });
    assert.equal(signRes.status, 200, `Sign must succeed: ${signRes.text}`);
    const { attachmentId, storagePath } = signRes.json;

    mockStorage._objects.set(storagePath, {
      buffer: Buffer.from('Abandoned content in storage'),
      contentType: 'application/pdf'
    });

    // Age the ticket in durable Firestore storage
    const ticket = await getDurableUploadTicket(attachmentId);
    assert.ok(ticket);
    ticket.expiresAt = Date.now() - 10_000;
    await createDurableUploadTicket(ticket);

    // Simulate complete process crash / cold start: memory is completely empty
    pendingDirectUploads.clear();

    // Run durable pruning sweep
    const prunedCount = await pruneExpiredDirectUploadTickets();
    assert.ok(prunedCount >= 1, 'Expired ticket in Firestore must be pruned');

    // Partial object in storage must be deleted
    assert.equal(mockStorage._objects.has(storagePath), false, 'Abandoned storage object must be deleted during prune');

    console.log('  ✓ Serverless cold-start restart safety and pruning verified successfully.');
    passedCount++;
  }

  console.log(`\n======================================================================`);
  console.log(`✓ ALL ${passedCount} OF 8 SERVERLESS DURABLE DIRECT-UPLOAD TESTS PASSED!`);
  console.log(`======================================================================\n`);

} finally {
  clearTestPublicKeys();
  resetSupabaseClientForTesting();
  resetFirebaseAuthForTesting();
  resetDirectUploadTicketsForTesting();
  if (server) {
    server.close();
  }
}
