/**
 * scripts/testUploadQuotaIndicatorRegression.js
 *
 * ORVIX — P4 Regression Test Suite: Daily Attachment Quota Indicator
 *
 * Verifies:
 * 1. Initial quota display:
 *    - Authenticated student queries GET /api/upload/quota without consuming a reservation
 *    - Indicator displays "5 of 5 uploads remaining today" derived from X-RateLimit-Remaining: 5
 *    - Repeated GET /api/upload/quota requests never consume or reserve upload slots
 * 2. Remaining count after successful uploads:
 *    - Standard uploads (POST /api/upload) and direct uploads (/api/upload/direct/signed-url & /complete)
 *      return authoritative X-RateLimit-Remaining headers
 *    - Client indicator updates to "4 of 5 uploads remaining today", "3 of 5 uploads remaining today",
 *      "2 of 5 uploads remaining today", "1 of 5 uploads remaining today"
 * 3. Zero remaining uploads:
 *    - After the 5th upload succeeds (X-RateLimit-Remaining: 0), indicator displays
 *      "0 of 5 uploads remaining today"
 * 4. HTTP 429 handling:
 *    - When an upload returns HTTP 429 QUOTA_EXCEEDED with X-RateLimit-Remaining: 0,
 *      updateUploadQuotaFromResponse updates the indicator to "0 of 5 uploads remaining today"
 *      even if client state was previously out-of-sync (e.g. showing 3 of 5)
 * 5. UTC midnight reset:
 *    - When the UTC calendar day changes, both checkUploadQuotaUtcRollover() on the client
 *      and GET /api/upload/quota on the backend reset the displayed quota to
 *      "5 of 5 uploads remaining today"
 * 6. Missing quota headers & network failures:
 *    - Missing X-RateLimit-Remaining headers or network failures are handled gracefully
 *    - Never fabricates quota numbers or decrements via frontend counter math (remaining - 1)
 * 7. Authenticated account isolation:
 *    - Unauthenticated/guest requests to GET /api/upload/quota are rejected with HTTP 401 UNAUTHENTICATED
 *    - Spoofed userId headers/query params cannot expose another student's quota
 *    - Switching authenticated Firebase accounts immediately clears the previous user's quota
 *      and loads the new user's isolated quota
 * 8. No frontend-only quota enforcement & UI component integration:
 *    - ChatArea.jsx and ComposerAttachmentTray.jsx render the quota indicator near the attachment
 *      controls/tray without disabling the attachment button or blocking uploads on the frontend
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express from 'express';

process.env.TESTING = '1';
process.env.FIREBASE_PROJECT_ID = 'orvix-p4-quota-indicator-test';

const TEST_PROJECT_ID = 'orvix-p4-quota-indicator-test';
const TEST_KID = 'p4-test-kid-001';

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
  resetSupabaseClientForTesting
} = await import('../server/supabaseClient.ts');

const {
  registerUploadRoutes,
  fileRegistry,
  conversationDocuments,
  resetDirectUploadTicketsForTesting
} = await import('../server/uploadSubsystem.ts');

const {
  DAILY_UPLOAD_LIMIT,
  createServerIssuedGuestToken,
  resetQuotaForTesting,
  setCustomDateHookForTesting
} = await import('../server/uploadQuotaService.ts');

const {
  extractQuotaFromHeaders,
  formatDailyUploadQuotaText,
  getUploadQuotaState,
  subscribeUploadQuotaState,
  syncUploadQuotaUserAccount,
  updateUploadQuotaFromResponse,
  fetchAuthenticatedUploadQuota,
  checkUploadQuotaUtcRollover,
  setClientQuotaDateHookForTesting,
  resetUploadQuotaClientStateForTesting
} = await import('../src/services/uploadQuotaClientService.js');

function createSignedJwt(uid, extraClaims = {}, signingKey = privateKey) {
  const nowSec = Math.floor(Date.now() / 1000);
  const header = {
    alg: 'RS256',
    typ: 'JWT',
    kid: TEST_KID
  };
  const payload = {
    iss: `https://securetoken.google.com/${TEST_PROJECT_ID}`,
    aud: TEST_PROJECT_ID,
    auth_time: nowSec - 10,
    user_id: uid,
    sub: uid,
    iat: nowSec - 10,
    exp: nowSec + 3600,
    ...extraClaims
  };

  const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), signingKey).toString('base64url');
  return `${signingInput}.${signature}`;
}

function createMockSupabaseStorageClient() {
  const objects = new Map();
  return {
    _objects: objects,
    storage: {
      from(bucket) {
        return {
          async createSignedUploadUrl(storagePath) {
            const token = 'mock_direct_token_' + crypto.randomUUID();
            return {
              data: {
                signedUrl: `https://mock.supabase.co/storage/v1/object/upload/sign/${bucket}/${storagePath}?token=${token}`,
                token,
                path: storagePath
              },
              error: null
            };
          },
          async upload(storagePath, buffer, options = {}) {
            objects.set(storagePath, {
              buffer: Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer),
              contentType: options.contentType || 'application/octet-stream'
            });
            return { data: { path: storagePath }, error: null };
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
            for (const p of paths) objects.delete(p);
            return { data: paths.map((name) => ({ name })), error: null };
          },
          async list() {
            return { data: [], error: null };
          }
        };
      }
    }
  };
}

let server;
let baseUrl = '';
let mockStorage;

async function sendMultipartUpload({
  endpoint = '/api/upload',
  token = null,
  conversationId = 'conv_p4_test',
  filename = 'notes.txt',
  content = 'Verified student attachment content for P4 quota test'
} = {}) {
  const boundary = '----OrvixP4Boundary' + crypto.randomBytes(8).toString('hex');
  const chunks = [
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="conversationId"\r\n\r\n${conversationId}\r\n`
    ),
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${filename}"\r\nContent-Type: text/plain\r\n\r\n`
    ),
    Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'),
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ];

  const body = Buffer.concat(chunks);
  const headers = {
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
    'Content-Length': String(body.length)
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  return fetch(`${baseUrl}${endpoint}`, {
    method: 'POST',
    headers,
    body
  });
}

async function sendJsonPost(endpoint, bodyObj = {}, headersObj = {}) {
  return fetch(`${baseUrl}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headersObj
    },
    body: JSON.stringify(bodyObj)
  });
}

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ FAIL: ${name}`);
    console.error(`     ${err.stack || err.message}`);
    failed++;
  }
}

console.log('================================================================');
console.log('ORVIX P4 REGRESSION SUITE: DAILY ATTACHMENT QUOTA INDICATOR');
console.log('================================================================\n');

try {
  setTestPublicKey(TEST_KID, publicKey);
  mockStorage = createMockSupabaseStorageClient();
  setSupabaseServerClientForTesting(mockStorage, 'https://mock.supabase.co', 'mock-service-key');
  await resetQuotaForTesting();
  resetDirectUploadTicketsForTesting();
  resetUploadQuotaClientStateForTesting();

  const app = express();
  app.use(express.json());
  registerUploadRoutes(app);

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;

  // -------------------------------------------------------------------------
  // Test 1: Initial quota display (5 of 5 uploads remaining today) without consuming reservations
  // -------------------------------------------------------------------------
  await test('1. Initial quota display: GET /api/upload/quota returns X-RateLimit-Remaining: 5 and displays "5 of 5 uploads remaining today" without consuming reservations', async () => {
    resetUploadQuotaClientStateForTesting();
    const studentUid = 'student_p4_initial_' + crypto.randomUUID();
    const studentToken = createSignedJwt(studentUid);

    const observedStates = [];
    const unsubscribe = subscribeUploadQuotaState((state) => {
      observedStates.push({ ...state, text: formatDailyUploadQuotaText(state) });
    });

    try {
      // Sync user account without autoFetch first to inspect initial pre-fetch state
      const initialState = syncUploadQuotaUserAccount(studentUid, { autoFetch: false });
      assert.strictEqual(initialState.userId, studentUid);
      assert.strictEqual(initialState.status, 'idle');
      assert.strictEqual(initialState.remaining, null);
      assert.strictEqual(formatDailyUploadQuotaText(initialState), null);

      // Fetch initial quota from live backend endpoint multiple times to prove it never consumes a reservation
      for (let callIdx = 1; callIdx <= 3; callIdx++) {
        const state = await fetchAuthenticatedUploadQuota({
          userId: studentUid,
          endpoint: `${baseUrl}/api/upload/quota`,
          getTokenFn: async () => studentToken
        });
        assert.ok(state, `Quota state must be returned on call ${callIdx}`);
        assert.strictEqual(state.status, 'ready');
        assert.strictEqual(state.userId, studentUid);
        assert.strictEqual(state.limit, 5);
        assert.strictEqual(state.remaining, 5, `Call ${callIdx} to GET /api/upload/quota must not decrement remaining count`);
        assert.strictEqual(
          formatDailyUploadQuotaText(state),
          '5 of 5 uploads remaining today',
          'Exact initial quota text format required'
        );
      }
    } finally {
      unsubscribe();
    }

    assert.ok(observedStates.some((s) => s.status === 'loading'), 'Must emit loading state during initial fetch');
    assert.ok(observedStates.some((s) => s.text === '5 of 5 uploads remaining today'));
  });

  // -------------------------------------------------------------------------
  // Test 2: Remaining count updates after successful uploads (standard & direct)
  // -------------------------------------------------------------------------
  await test('2. Remaining count after successful uploads: indicator updates strictly from backend X-RateLimit-Remaining header (4 of 5 -> 3 of 5 -> 2 of 5 -> 1 of 5)', async () => {
    resetUploadQuotaClientStateForTesting();
    const studentUid = 'student_p4_uploads_' + crypto.randomUUID();
    const studentToken = createSignedJwt(studentUid);

    syncUploadQuotaUserAccount(studentUid, { autoFetch: false });
    await fetchAuthenticatedUploadQuota({
      userId: studentUid,
      endpoint: `${baseUrl}/api/upload/quota`,
      getTokenFn: async () => studentToken
    });
    assert.strictEqual(formatDailyUploadQuotaText(getUploadQuotaState()), '5 of 5 uploads remaining today');

    // Upload 1 (standard multipart POST /api/upload) -> 4 of 5
    const u1Res = await sendMultipartUpload({
      endpoint: '/api/upload',
      token: studentToken,
      filename: 'assignment_1.txt'
    });
    assert.strictEqual(u1Res.status, 200);
    assert.strictEqual(u1Res.headers.get('x-ratelimit-remaining'), '4');
    const stateAfterU1 = updateUploadQuotaFromResponse(u1Res, studentUid);
    assert.strictEqual(stateAfterU1.remaining, 4);
    assert.strictEqual(formatDailyUploadQuotaText(stateAfterU1), '4 of 5 uploads remaining today');

    // Upload 2 (standard multipart POST /api/upload) -> 3 of 5
    const u2Res = await sendMultipartUpload({
      endpoint: '/api/upload',
      token: studentToken,
      filename: 'assignment_2.txt'
    });
    assert.strictEqual(u2Res.status, 200);
    assert.strictEqual(u2Res.headers.get('x-ratelimit-remaining'), '3');
    const stateAfterU2 = updateUploadQuotaFromResponse(u2Res, studentUid);
    assert.strictEqual(stateAfterU2.remaining, 3);
    assert.strictEqual(formatDailyUploadQuotaText(stateAfterU2), '3 of 5 uploads remaining today');

    // Upload 3 (direct upload signed-url + complete) -> 2 of 5
    const signRes = await sendJsonPost(
      '/api/upload/direct/signed-url',
      {
        chatId: 'conv_p4_test',
        fileName: 'assignment_3.txt',
        fileSize: 128,
        mimeType: 'text/plain'
      },
      { Authorization: `Bearer ${studentToken}` }
    );
    assert.strictEqual(signRes.status, 200);
    assert.strictEqual(signRes.headers.get('x-ratelimit-remaining'), '2');
    const signData = await signRes.json();
    mockStorage._objects.set(signData.storagePath, {
      buffer: Buffer.from('Direct uploaded assignment 3'),
      contentType: 'text/plain'
    });

    const completeRes = await sendJsonPost(
      '/api/upload/direct/complete',
      {
        chatId: 'conv_p4_test',
        attachmentId: signData.attachmentId
      },
      { Authorization: `Bearer ${studentToken}` }
    );
    assert.strictEqual(completeRes.status, 200);
    assert.strictEqual(completeRes.headers.get('x-ratelimit-remaining'), '2');
    const stateAfterU3 = updateUploadQuotaFromResponse(completeRes, studentUid);
    assert.strictEqual(stateAfterU3.remaining, 2);
    assert.strictEqual(formatDailyUploadQuotaText(stateAfterU3), '2 of 5 uploads remaining today');

    // Upload 4 (standard multipart) -> 1 of 5
    const u4Res = await sendMultipartUpload({
      endpoint: '/api/upload',
      token: studentToken,
      filename: 'assignment_4.txt'
    });
    assert.strictEqual(u4Res.status, 200);
    assert.strictEqual(u4Res.headers.get('x-ratelimit-remaining'), '1');
    const stateAfterU4 = updateUploadQuotaFromResponse(u4Res, studentUid);
    assert.strictEqual(stateAfterU4.remaining, 1);
    assert.strictEqual(formatDailyUploadQuotaText(stateAfterU4), '1 of 5 uploads remaining today');
  });

  // -------------------------------------------------------------------------
  // Test 3: Zero remaining uploads ("0 of 5 uploads remaining today")
  // -------------------------------------------------------------------------
  await test('3. Zero remaining uploads: 5th upload returns X-RateLimit-Remaining: 0 and indicator displays "0 of 5 uploads remaining today"', async () => {
    resetUploadQuotaClientStateForTesting();
    const studentUid = 'student_p4_zero_' + crypto.randomUUID();
    const studentToken = createSignedJwt(studentUid);

    syncUploadQuotaUserAccount(studentUid, { autoFetch: false });

    let latestState = null;
    for (let i = 1; i <= DAILY_UPLOAD_LIMIT; i++) {
      const res = await sendMultipartUpload({
        endpoint: '/api/upload',
        token: studentToken,
        filename: `doc_${i}.txt`
      });
      assert.strictEqual(res.status, 200);
      latestState = updateUploadQuotaFromResponse(res, studentUid);
    }

    assert.ok(latestState);
    assert.strictEqual(latestState.remaining, 0);
    assert.strictEqual(latestState.limit, 5);
    assert.strictEqual(
      formatDailyUploadQuotaText(latestState),
      '0 of 5 uploads remaining today',
      'Must format zero remaining uploads accurately'
    );

    // Also verify GET /api/upload/quota agrees on 0 remaining
    const statusRes = await fetch(`${baseUrl}/api/upload/quota`, {
      headers: { Authorization: `Bearer ${studentToken}` }
    });
    assert.strictEqual(statusRes.status, 200);
    assert.strictEqual(statusRes.headers.get('x-ratelimit-remaining'), '0');
    const statusState = updateUploadQuotaFromResponse(statusRes, studentUid);
    assert.strictEqual(formatDailyUploadQuotaText(statusState), '0 of 5 uploads remaining today');
  });

  // -------------------------------------------------------------------------
  // Test 4: HTTP 429 handling updates indicator from authoritative header
  // -------------------------------------------------------------------------
  await test('4. HTTP 429 handling: 429 QUOTA_EXCEEDED response updates indicator to "0 of 5 uploads remaining today" even if client state was stale', async () => {
    resetUploadQuotaClientStateForTesting();
    const studentUid = 'student_p4_429_' + crypto.randomUUID();
    const studentToken = createSignedJwt(studentUid);

    syncUploadQuotaUserAccount(studentUid, { autoFetch: false });

    // Simulate Tab A consuming all 5 uploads on the backend while Tab B still shows "3 of 5 uploads remaining today"
    for (let i = 1; i <= 2; i++) {
      const res = await sendMultipartUpload({
        endpoint: '/api/upload',
        token: studentToken,
        filename: `tab_b_${i}.txt`
      });
      assert.strictEqual(res.status, 200);
      updateUploadQuotaFromResponse(res, studentUid);
    }
    assert.strictEqual(formatDailyUploadQuotaText(getUploadQuotaState()), '3 of 5 uploads remaining today');

    // Tab A consumes the remaining 3 uploads on the backend without updating Tab B's client state
    for (let i = 3; i <= 5; i++) {
      const res = await sendMultipartUpload({
        endpoint: '/api/upload',
        token: studentToken,
        filename: `tab_a_${i}.txt`
      });
      assert.strictEqual(res.status, 200);
    }

    // Tab B still thinks 3 of 5 remain before attempting an upload
    assert.strictEqual(formatDailyUploadQuotaText(getUploadQuotaState()), '3 of 5 uploads remaining today');

    // Tab B now attempts an upload -> receives HTTP 429 with X-RateLimit-Remaining: 0
    const res429 = await sendMultipartUpload({
      endpoint: '/api/upload',
      token: studentToken,
      filename: 'tab_b_exceeded.txt'
    });
    assert.strictEqual(res429.status, 429, 'Expected 429 QUOTA_EXCEEDED');
    assert.strictEqual(res429.headers.get('x-ratelimit-remaining'), '0');

    const updatedAfter429 = updateUploadQuotaFromResponse(res429, studentUid);
    assert.strictEqual(updatedAfter429.remaining, 0);
    assert.strictEqual(
      formatDailyUploadQuotaText(updatedAfter429),
      '0 of 5 uploads remaining today',
      'Indicator must immediately jump from stale 3 of 5 to authoritative 0 of 5 upon HTTP 429'
    );

    // Also verify direct upload signed-url 429 response updates indicator identically
    // Reset client state to a stale 4 of 5 first
    updateUploadQuotaFromResponse(
      new Headers({
        'X-RateLimit-Limit': '5',
        'X-RateLimit-Remaining': '4',
        'X-RateLimit-Reset-UTC': new Date(Date.now() + 3600_000).toISOString()
      }),
      studentUid
    );
    assert.strictEqual(formatDailyUploadQuotaText(getUploadQuotaState()), '4 of 5 uploads remaining today');

    const direct429Res = await sendJsonPost(
      '/api/upload/direct/signed-url',
      {
        chatId: 'conv_p4_429',
        fileName: 'direct_exceeded.pdf',
        fileSize: 2048
      },
      { Authorization: `Bearer ${studentToken}` }
    );
    assert.strictEqual(direct429Res.status, 429);
    assert.strictEqual(direct429Res.headers.get('x-ratelimit-remaining'), '0');

    const updatedAfterDirect429 = updateUploadQuotaFromResponse(direct429Res, studentUid);
    assert.strictEqual(updatedAfterDirect429.remaining, 0);
    assert.strictEqual(formatDailyUploadQuotaText(updatedAfterDirect429), '0 of 5 uploads remaining today');
  });

  // -------------------------------------------------------------------------
  // Test 5: UTC midnight reset
  // -------------------------------------------------------------------------
  await test('5. UTC midnight reset: advancing past UTC midnight resets displayed quota from "0 of 5" to "5 of 5 uploads remaining today"', async () => {
    resetUploadQuotaClientStateForTesting();
    const day1Date = new Date('2026-05-10T23:58:00.000Z');
    const day2Date = new Date('2026-05-11T00:00:05.000Z');

    setCustomDateHookForTesting(() => day1Date);
    setClientQuotaDateHookForTesting(() => day1Date);

    try {
      const studentUid = 'student_p4_utc_reset_' + crypto.randomUUID();
      const studentToken = createSignedJwt(studentUid);
      syncUploadQuotaUserAccount(studentUid, { autoFetch: false });

      // Exhaust all 5 uploads on Day 1 (2026-05-10 UTC)
      for (let i = 1; i <= 5; i++) {
        const res = await sendMultipartUpload({
          endpoint: '/api/upload',
          token: studentToken,
          filename: `day1_${i}.txt`
        });
        assert.strictEqual(res.status, 200);
        updateUploadQuotaFromResponse(res, studentUid);
      }

      assert.strictEqual(getUploadQuotaState().utcDay, '2026-05-10');
      assert.strictEqual(formatDailyUploadQuotaText(getUploadQuotaState()), '0 of 5 uploads remaining today');

      // Advance clock to Day 2 (2026-05-11T00:00:05.000Z)
      setCustomDateHookForTesting(() => day2Date);
      setClientQuotaDateHookForTesting(() => day2Date);

      // 1. Client-side rollover detection resets displayed quota immediately at UTC midnight
      const didRollover = checkUploadQuotaUtcRollover({ autoRefetch: false });
      assert.strictEqual(didRollover, true, 'checkUploadQuotaUtcRollover must detect UTC calendar day change');
      const rolledState = getUploadQuotaState();
      assert.strictEqual(rolledState.utcDay, '2026-05-11');
      assert.strictEqual(rolledState.remaining, 5);
      assert.strictEqual(formatDailyUploadQuotaText(rolledState), '5 of 5 uploads remaining today');

      // 2. Backend GET /api/upload/quota also confirms 5 of 5 for the new UTC day
      const backendConfirmedState = await fetchAuthenticatedUploadQuota({
        userId: studentUid,
        endpoint: `${baseUrl}/api/upload/quota`,
        getTokenFn: async () => studentToken
      });
      assert.strictEqual(backendConfirmedState.utcDay, '2026-05-11');
      assert.strictEqual(backendConfirmedState.remaining, 5);
      assert.strictEqual(formatDailyUploadQuotaText(backendConfirmedState), '5 of 5 uploads remaining today');
    } finally {
      setCustomDateHookForTesting(null);
      setClientQuotaDateHookForTesting(null);
    }
  });

  // -------------------------------------------------------------------------
  // Test 6: Missing quota headers & network failures (no frontend counter math)
  // -------------------------------------------------------------------------
  await test('6. Missing quota headers & network failures: handles gracefully and NEVER decrements using frontend counters', async () => {
    resetUploadQuotaClientStateForTesting();
    const studentUid = 'student_p4_missing_hdr_' + crypto.randomUUID();
    syncUploadQuotaUserAccount(studentUid, { autoFetch: false });

    // Case A: extractQuotaFromHeaders with missing or malformed headers returns null
    assert.strictEqual(extractQuotaFromHeaders(null), null);
    assert.strictEqual(extractQuotaFromHeaders(new Headers({})), null);
    assert.strictEqual(
      extractQuotaFromHeaders(new Headers({ 'X-RateLimit-Limit': '5' })),
      null,
      'Must return null when X-RateLimit-Remaining is missing'
    );
    assert.strictEqual(
      extractQuotaFromHeaders(new Headers({ 'X-RateLimit-Remaining': 'not-a-number' })),
      null,
      'Must return null when X-RateLimit-Remaining is non-numeric'
    );

    // Case B: Initial network failure sets status to 'unavailable' and text to null (never NaN or fake count)
    const failedState = await fetchAuthenticatedUploadQuota({
      userId: studentUid,
      endpoint: 'http://127.0.0.1:1/unreachable-quota-endpoint',
      getTokenFn: async () => 'valid_token'
    });
    assert.strictEqual(failedState.status, 'unavailable');
    assert.strictEqual(failedState.remaining, null);
    assert.strictEqual(formatDailyUploadQuotaText(failedState), null);

    // Case C: Once a valid backend header sets "4 of 5 uploads remaining today",
    // receiving a proxy/response WITHOUT X-RateLimit-Remaining must NOT subtract 1 on the frontend!
    updateUploadQuotaFromResponse(
      new Headers({
        'X-RateLimit-Limit': '5',
        'X-RateLimit-Remaining': '4',
        'X-RateLimit-Reset-UTC': new Date(Date.now() + 3600_000).toISOString()
      }),
      studentUid
    );
    assert.strictEqual(formatDailyUploadQuotaText(getUploadQuotaState()), '4 of 5 uploads remaining today');

    const responseMissingHeaders = {
      status: 200,
      headers: new Headers({ 'Content-Type': 'application/json' })
    };
    const stateAfterMissingHeader = updateUploadQuotaFromResponse(responseMissingHeaders, studentUid);
    assert.strictEqual(
      stateAfterMissingHeader.remaining,
      4,
      'Must NOT decrement remaining count on frontend when X-RateLimit-Remaining header is absent'
    );
    assert.strictEqual(formatDailyUploadQuotaText(stateAfterMissingHeader), '4 of 5 uploads remaining today');
  });

  // -------------------------------------------------------------------------
  // Test 7: Authenticated account isolation (backend & frontend)
  // -------------------------------------------------------------------------
  await test('7. Authenticated account isolation: GET /api/upload/quota rejects unauthenticated/guest requests and isolates Student A from Student B', async () => {
    resetUploadQuotaClientStateForTesting();
    const { guestToken } = createServerIssuedGuestToken();

    // 1. Unauthenticated / guest requests to GET /api/upload/quota and GET /upload/quota must return 401 UNAUTHENTICATED
    for (const endpoint of ['/api/upload/quota', '/upload/quota']) {
      const unauthRes = await fetch(`${baseUrl}${endpoint}`, {
        headers: {
          Cookie: `orvix_guest_token=${encodeURIComponent(guestToken)}`,
          'X-Guest-Token': guestToken,
          'x-user-id': 'spoofed_student_id'
        }
      });
      assert.strictEqual(unauthRes.status, 401, `Expected 401 on unauthenticated ${endpoint}`);
      const unauthBody = await unauthRes.json();
      assert.strictEqual(unauthBody.code, 'UNAUTHENTICATED');
    }

    // 2. Student A uploads 3 files (2 of 5 remaining); Student B uploads 0 files (5 of 5 remaining)
    const studentAUid = 'student_p4_iso_A_' + crypto.randomUUID();
    const studentBUid = 'student_p4_iso_B_' + crypto.randomUUID();
    const tokenA = createSignedJwt(studentAUid);
    const tokenB = createSignedJwt(studentBUid);

    for (let i = 1; i <= 3; i++) {
      const r = await sendMultipartUpload({
        endpoint: '/api/upload',
        token: tokenA,
        filename: `studentA_${i}.txt`
      });
      assert.strictEqual(r.status, 200);
    }

    // Student B attempts to spoof Student A's UID via headers/query params on GET /api/upload/quota
    // Backend must ignore spoofed parameters and return Student B's own quota (5 of 5)
    const spoofCheckRes = await fetch(
      `${baseUrl}/api/upload/quota?userId=${encodeURIComponent(studentAUid)}`,
      {
        headers: {
          Authorization: `Bearer ${tokenB}`,
          'x-user-id': studentAUid
        }
      }
    );
    assert.strictEqual(spoofCheckRes.status, 200);
    assert.strictEqual(
      spoofCheckRes.headers.get('x-ratelimit-remaining'),
      '5',
      'Backend must return Student B quota (5), never exposing Student A quota (2)'
    );

    // 3. Frontend account switching isolation
    syncUploadQuotaUserAccount(studentAUid, { autoFetch: false });
    await fetchAuthenticatedUploadQuota({
      userId: studentAUid,
      endpoint: `${baseUrl}/api/upload/quota`,
      getTokenFn: async () => tokenA
    });
    assert.strictEqual(getUploadQuotaState().userId, studentAUid);
    assert.strictEqual(formatDailyUploadQuotaText(getUploadQuotaState()), '2 of 5 uploads remaining today');

    // Attempt to apply a late response from Student A after switching to Student B must be ignored
    const stateOnSwitchToB = syncUploadQuotaUserAccount(studentBUid, { autoFetch: false });
    assert.strictEqual(stateOnSwitchToB.userId, studentBUid);
    assert.strictEqual(stateOnSwitchToB.remaining, null, 'Previous account quota must be cleared immediately on switch');
    assert.strictEqual(formatDailyUploadQuotaText(stateOnSwitchToB), null);

    // Late response intended for Student A is rejected because active user is now Student B
    updateUploadQuotaFromResponse(
      new Headers({ 'X-RateLimit-Limit': '5', 'X-RateLimit-Remaining': '1' }),
      studentAUid
    );
    assert.strictEqual(
      getUploadQuotaState().remaining,
      null,
      'Stale response from previous user must not pollute current user quota state'
    );

    // Fetch Student B's quota -> shows 5 of 5
    await fetchAuthenticatedUploadQuota({
      userId: studentBUid,
      endpoint: `${baseUrl}/api/upload/quota`,
      getTokenFn: async () => tokenB
    });
    assert.strictEqual(formatDailyUploadQuotaText(getUploadQuotaState()), '5 of 5 uploads remaining today');

    // Sign out (syncUploadQuotaUserAccount(null)) clears state completely
    const signedOutState = syncUploadQuotaUserAccount(null, { autoFetch: false });
    assert.strictEqual(signedOutState.userId, null);
    assert.strictEqual(signedOutState.status, 'unauthenticated');
    assert.strictEqual(signedOutState.remaining, null);
    assert.strictEqual(formatDailyUploadQuotaText(signedOutState), null);
  });

  // -------------------------------------------------------------------------
  // Test 8: No frontend-only quota enforcement & UI component wiring verification
  // -------------------------------------------------------------------------
  await test('8. No frontend-only quota enforcement: ChatArea, ComposerAttachmentTray, and ChatPage render indicator without blocking uploads on the client', async () => {
    const chatAreaSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/components/chat/ChatArea.jsx'),
      'utf8'
    );
    const traySource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/components/chat/ComposerAttachmentTray.jsx'),
      'utf8'
    );
    const chatPageSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/pages/ChatPage.jsx'),
      'utf8'
    );
    const quotaServiceSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/services/uploadQuotaClientService.js'),
      'utf8'
    );

    // Verify ChatArea renders the upload-quota-indicator near the attachment button/tray
    assert.ok(
      chatAreaSource.includes('data-testid="upload-quota-indicator"'),
      'ChatArea.jsx must render data-testid="upload-quota-indicator"'
    );
    assert.ok(
      chatAreaSource.includes('formatDailyUploadQuotaText'),
      'ChatArea.jsx must format quota text using formatDailyUploadQuotaText'
    );

    // Verify attachment button disabled prop does NOT depend on uploadQuota.remaining === 0
    const attachBtnMatch = chatAreaSource.match(
      /disabled=\{([^}]+)\}\s+onClick=\{handleAttachClick\}/
    );
    assert.ok(attachBtnMatch, 'Attach button must exist in ChatArea.jsx');
    assert.ok(
      !attachBtnMatch[1].includes('uploadQuota'),
      `Attach button disabled condition must NOT enforce quota on frontend, found: ${attachBtnMatch[1]}`
    );

    // Verify ComposerAttachmentTray also supports uploadQuotaText prop
    assert.ok(
      traySource.includes('uploadQuotaText'),
      'ComposerAttachmentTray.jsx must support uploadQuotaText prop'
    );

    // Verify ChatPage wires updateUploadQuotaFromResponse on upload responses without blocking submission when remaining === 0
    assert.ok(
      chatPageSource.includes('updateUploadQuotaFromResponse(uploadRes'),
      'ChatPage.jsx must call updateUploadQuotaFromResponse(uploadRes, ...) after /api/upload'
    );
    assert.ok(
      chatPageSource.includes('uploadQuota={uploadQuota}'),
      'ChatPage.jsx must pass uploadQuota to ChatArea'
    );

    // Verify uploadQuotaClientService never decrements remaining count via frontend math
    assert.ok(
      !quotaServiceSource.includes('remaining - 1') && !quotaServiceSource.includes('remaining--'),
      'uploadQuotaClientService.js must never calculate quota using frontend decrement counters'
    );
  });
} finally {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  setCustomDateHookForTesting(null);
  setClientQuotaDateHookForTesting(null);
  clearTestPublicKeys();
  resetFirebaseAuthForTesting();
  resetSupabaseClientForTesting();
  resetDirectUploadTicketsForTesting();
  resetUploadQuotaClientStateForTesting();
  fileRegistry.clear();
  conversationDocuments.clear();
}

console.log('\n================================================================');
console.log(`ORVIX P4 SUMMARY: ${passed} passed, ${failed} failed`);
console.log('================================================================\n');

if (failed > 0) {
  process.exit(1);
}
