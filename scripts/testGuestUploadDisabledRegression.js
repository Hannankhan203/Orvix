/**
 * scripts/testGuestUploadDisabledRegression.js
 *
 * ORVIX — P3 Regression Test Suite: Disable Guest Attachment Uploads
 *
 * Verifies:
 * 1. Unauthenticated standard uploads (POST /api/upload and POST /upload) are rejected with HTTP 401 and code 'UNAUTHENTICATED'.
 * 2. Unauthenticated direct uploads (POST /api/upload/direct/signed-url, /api/upload/direct/complete, /api/upload/direct/cancel, /upload/direct/*, and wildcard /api/upload/direct/*) are rejected with HTTP 401 and code 'UNAUTHENTICATED'.
 * 3. Guest cookie manipulation (orvix_guest_token) and guest header manipulation (X-Guest-Token, x-user-id, req.body.userId) cannot obtain upload access.
 * 4. Missing, malformed, expired, and forged authentication tokens are rejected with HTTP 401 and code 'UNAUTHENTICATED' and never fall back to guest identity.
 * 5. Authenticated students can still upload normally via both standard and direct upload endpoints, with quota derived exclusively from the verified Firebase UID.
 * 6. Client-supplied userIds, guest tokens, or cookies alongside a valid Firebase token never override the verified Firebase UID quota identity.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import express from 'express';

process.env.TESTING = '1';
process.env.FIREBASE_PROJECT_ID = 'orvix-p3-guest-upload-test';

const TEST_PROJECT_ID = 'orvix-p3-guest-upload-test';
const TEST_KID = 'p3-test-kid-001';

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

const { privateKey: attackerPrivateKey } = crypto.generateKeyPairSync('rsa', {
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
  resetDirectUploadTicketsForTesting,
  buildAuthenticatedQuotaIdentity,
  resolveAuthenticatedUploadIdentity
} = await import('../server/uploadSubsystem.ts');

const {
  DAILY_UPLOAD_LIMIT,
  createServerIssuedGuestToken,
  createExpiringGuestToken,
  resetQuotaForTesting,
  getQuotaStatus
} = await import('../server/uploadQuotaService.ts');

function createSignedJwt(uid, extraClaims = {}, signingKey = privateKey, headerOverrides = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  const header = {
    alg: 'RS256',
    typ: 'JWT',
    kid: TEST_KID,
    ...headerOverrides
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
  rawAuthHeader = null,
  guestToken = null,
  cookie = null,
  conversationId = 'conv_p3_test',
  userIdInBody = null,
  extraHeaders = {},
  filename = 'notes.txt',
  content = 'Verified student attachment content'
} = {}) {
  const boundary = '----OrvixP3Boundary' + crypto.randomBytes(8).toString('hex');
  const chunks = [];

  if (conversationId !== undefined && conversationId !== null) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="conversationId"\r\n\r\n${conversationId}\r\n`
      )
    );
  }

  if (userIdInBody !== null) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="userId"\r\n\r\n${userIdInBody}\r\n`
      )
    );
  }

  const fileBuf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${filename}"\r\nContent-Type: text/plain\r\n\r\n`
    )
  );
  chunks.push(fileBuf);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  const body = Buffer.concat(chunks);
  const headers = {
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
    'Content-Length': String(body.length),
    ...extraHeaders
  };

  if (rawAuthHeader !== null) {
    headers['Authorization'] = rawAuthHeader;
  } else if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  if (guestToken) {
    headers['X-Guest-Token'] = guestToken;
  }
  if (cookie) {
    headers['Cookie'] = cookie;
  }

  const res = await fetch(`${baseUrl}${endpoint}`, {
    method: 'POST',
    headers,
    body
  });

  let data = null;
  try {
    data = await res.json();
  } catch (_) {}

  return { status: res.status, headers: res.headers, data };
}

async function sendJsonPost(endpoint, bodyObj = {}, headersObj = {}) {
  const res = await fetch(`${baseUrl}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headersObj
    },
    body: JSON.stringify(bodyObj)
  });

  let data = null;
  try {
    data = await res.json();
  } catch (_) {}

  return { status: res.status, headers: res.headers, data };
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
console.log('ORVIX P3 REGRESSION SUITE: DISABLE GUEST ATTACHMENT UPLOADS');
console.log('================================================================\n');

try {
  setTestPublicKey(TEST_KID, publicKey);
  mockStorage = createMockSupabaseStorageClient();
  setSupabaseServerClientForTesting(mockStorage, 'https://mock.supabase.co', 'mock-service-key');
  await resetQuotaForTesting();
  resetDirectUploadTicketsForTesting();

  const app = express();
  app.use(express.json());
  registerUploadRoutes(app);

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;

  // -------------------------------------------------------------------------
  // Test 1: Unauthenticated standard uploads (POST /api/upload & POST /upload) rejected
  // -------------------------------------------------------------------------
  await test('1. Unauthenticated POST /api/upload and POST /upload are rejected with HTTP 401 UNAUTHENTICATED', async () => {
    for (const endpoint of ['/api/upload', '/upload']) {
      const res = await sendMultipartUpload({ endpoint, token: null });
      assert.strictEqual(res.status, 401, `Expected 401 on ${endpoint}, got ${res.status}`);
      assert.strictEqual(res.data?.code, 'UNAUTHENTICATED', `Expected code UNAUTHENTICATED on ${endpoint}`);
      assert.strictEqual(res.headers.get('x-guest-token'), null, 'Must never issue X-Guest-Token header');
      assert.strictEqual(res.headers.get('set-cookie'), null, 'Must never set orvix_guest_token cookie');
    }
  });

  // -------------------------------------------------------------------------
  // Test 2: Unauthenticated direct uploads (/api/upload/direct/* and /upload/direct/*) rejected
  // -------------------------------------------------------------------------
  await test('2. Unauthenticated requests to all /api/upload/direct/* and /upload/direct/* endpoints are rejected with HTTP 401 UNAUTHENTICATED', async () => {
    const directEndpoints = [
      '/api/upload/direct/signed-url',
      '/upload/direct/signed-url',
      '/api/upload/direct/complete',
      '/upload/direct/complete',
      '/api/upload/direct/cancel',
      '/upload/direct/cancel',
      '/api/upload/direct/any-other-operation',
      '/upload/direct/any-other-operation'
    ];

    for (const endpoint of directEndpoints) {
      const res = await sendJsonPost(endpoint, {
        chatId: 'conv_direct_test',
        fileName: 'doc.pdf',
        fileSize: 2048,
        attachmentId: crypto.randomUUID()
      });
      assert.strictEqual(res.status, 401, `Expected 401 on ${endpoint}, got ${res.status}`);
      assert.strictEqual(res.data?.code, 'UNAUTHENTICATED', `Expected code UNAUTHENTICATED on ${endpoint}`);
    }
  });

  // -------------------------------------------------------------------------
  // Test 3: Guest cookie & header manipulation cannot obtain upload access
  // -------------------------------------------------------------------------
  await test('3. Guest cookie (orvix_guest_token) and identity header manipulation cannot obtain upload access', async () => {
    const { guestToken: validServerGuestToken } = createServerIssuedGuestToken();
    const { guestToken: expiringServerGuestToken } = createExpiringGuestToken(3600_000);
    const rotatedGuestTokens = [
      validServerGuestToken,
      expiringServerGuestToken,
      'guest_rotated_incognito_1.abcdef0123456789',
      'guest_custom_crafted_token'
    ];

    for (const gToken of rotatedGuestTokens) {
      // Attempt via Cookie header on POST /api/upload
      const cookieRes = await sendMultipartUpload({
        endpoint: '/api/upload',
        cookie: `orvix_guest_token=${encodeURIComponent(gToken)}`,
        guestToken: gToken,
        userIdInBody: 'spoofed_student_uid',
        extraHeaders: {
          'x-user-id': 'spoofed_student_uid',
          'x-forwarded-user': 'spoofed_student_uid'
        }
      });
      assert.strictEqual(cookieRes.status, 401, 'Standard upload with guest cookie/headers must return 401');
      assert.strictEqual(cookieRes.data?.code, 'UNAUTHENTICATED');

      // Attempt via Cookie and X-Guest-Token on POST /api/upload/direct/signed-url
      const directRes = await sendJsonPost(
        '/api/upload/direct/signed-url',
        {
          chatId: 'conv_spoof',
          fileName: 'lecture.pdf',
          fileSize: 4096,
          userId: 'spoofed_student_uid'
        },
        {
          Cookie: `orvix_guest_token=${encodeURIComponent(gToken)}`,
          'X-Guest-Token': gToken,
          'x-user-id': 'spoofed_student_uid'
        }
      );
      assert.strictEqual(directRes.status, 401, 'Direct upload with guest cookie/headers must return 401');
      assert.strictEqual(directRes.data?.code, 'UNAUTHENTICATED');
    }
  });

  // -------------------------------------------------------------------------
  // Test 4: Missing, expired, malformed, and forged tokens are rejected with 401 UNAUTHENTICATED and never fall back to guest
  // -------------------------------------------------------------------------
  await test('4. Missing, malformed, expired, and forged Firebase tokens are rejected with 401 UNAUTHENTICATED without guest fallback', async () => {
    const expiredToken = createSignedJwt('student_expired_1', {
      iat: Math.floor(Date.now() / 1000) - 7200,
      exp: Math.floor(Date.now() / 1000) - 300
    });
    const forgedSignatureToken = createSignedJwt('student_forged_1', {}, attackerPrivateKey);
    const wrongAudToken = createSignedJwt('student_wrong_aud', { aud: 'wrong-project-id' });
    const wrongIssToken = createSignedJwt('student_wrong_iss', { iss: 'https://securetoken.google.com/wrong-project' });
    const algNoneToken = `${Buffer.from(JSON.stringify({ alg: 'none', kid: TEST_KID })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'admin', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.`;

    const { guestToken } = createServerIssuedGuestToken();

    const invalidAuthCases = [
      { label: 'Empty Bearer', rawAuthHeader: 'Bearer ' },
      { label: 'Basic auth scheme', rawAuthHeader: 'Basic dXNlcjpwYXNz' },
      { label: 'Malformed JWT string', rawAuthHeader: 'Bearer not.a.valid.jwt.token' },
      { label: 'Expired Firebase token', token: expiredToken },
      { label: 'Forged RSA signature token', token: forgedSignatureToken },
      { label: 'Wrong audience token', token: wrongAudToken },
      { label: 'Wrong issuer token', token: wrongIssToken },
      { label: 'alg:none token', token: algNoneToken }
    ];

    for (const testCase of invalidAuthCases) {
      // Even when accompanied by a valid server-issued guest cookie/header, invalid auth must NEVER fall back to guest!
      const stdRes = await sendMultipartUpload({
        endpoint: '/api/upload',
        token: testCase.token || null,
        rawAuthHeader: testCase.rawAuthHeader || null,
        guestToken,
        cookie: `orvix_guest_token=${encodeURIComponent(guestToken)}`
      });
      assert.strictEqual(stdRes.status, 401, `[${testCase.label}] Expected 401 on /api/upload, got ${stdRes.status}`);
      assert.strictEqual(stdRes.data?.code, 'UNAUTHENTICATED', `[${testCase.label}] Expected UNAUTHENTICATED code on /api/upload`);

      const stdAliasRes = await sendMultipartUpload({
        endpoint: '/upload',
        token: testCase.token || null,
        rawAuthHeader: testCase.rawAuthHeader || null,
        guestToken,
        cookie: `orvix_guest_token=${encodeURIComponent(guestToken)}`
      });
      assert.strictEqual(stdAliasRes.status, 401, `[${testCase.label}] Expected 401 on /upload, got ${stdAliasRes.status}`);
      assert.strictEqual(stdAliasRes.data?.code, 'UNAUTHENTICATED', `[${testCase.label}] Expected UNAUTHENTICATED code on /upload`);

      const authHeaderValue = testCase.rawAuthHeader || `Bearer ${testCase.token}`;
      for (const directRoute of ['/api/upload/direct/signed-url', '/api/upload/direct/complete', '/api/upload/direct/cancel']) {
        const dirRes = await sendJsonPost(
          directRoute,
          { chatId: 'conv_test', fileName: 'test.txt', fileSize: 128, attachmentId: crypto.randomUUID() },
          {
            Authorization: authHeaderValue,
            Cookie: `orvix_guest_token=${encodeURIComponent(guestToken)}`,
            'X-Guest-Token': guestToken
          }
        );
        assert.strictEqual(dirRes.status, 401, `[${testCase.label}] Expected 401 on ${directRoute}`);
        assert.strictEqual(dirRes.data?.code, 'UNAUTHENTICATED', `[${testCase.label}] Expected UNAUTHENTICATED code on ${directRoute}`);
      }
    }
  });

  // -------------------------------------------------------------------------
  // Test 5: Authenticated students can upload normally (standard & direct) and quota is derived exclusively from verified Firebase UID
  // -------------------------------------------------------------------------
  await test('5. Authenticated students can upload normally via standard and direct endpoints with quota bound to verified Firebase UID', async () => {
    const studentUid = 'verified_student_' + crypto.randomUUID();
    const studentToken = createSignedJwt(studentUid);
    const { guestToken } = createServerIssuedGuestToken();

    // 1. Standard upload via POST /api/upload (even with spoofed userId/guest headers, quota tracks studentUid)
    const u1 = await sendMultipartUpload({
      endpoint: '/api/upload',
      token: studentToken,
      conversationId: 'conv_student_main',
      userIdInBody: 'attacker_spoofed_uid',
      guestToken,
      cookie: `orvix_guest_token=${encodeURIComponent(guestToken)}`,
      extraHeaders: { 'x-user-id': 'attacker_spoofed_uid' },
      filename: 'homework_1.txt'
    });
    assert.strictEqual(u1.status, 200, `Authenticated student upload 1 should succeed, got ${u1.status}`);
    assert.strictEqual(u1.data?.success, true);
    assert.strictEqual(u1.headers.get('x-ratelimit-remaining'), '4');
    assert.strictEqual(u1.headers.get('x-guest-token'), null, 'Authenticated response must not attach guest token');

    // Verify storage path uses verified Firebase UID, NOT spoofed body/header userId
    assert.ok(
      u1.data.attachments[0].storagePath.startsWith(`${studentUid}/conv_student_main/`),
      `Expected storagePath to start with ${studentUid}, got ${u1.data.attachments[0].storagePath}`
    );

    // 2. Standard upload via POST /upload alias
    const u2 = await sendMultipartUpload({
      endpoint: '/upload',
      token: studentToken,
      conversationId: 'conv_student_main',
      filename: 'homework_2.txt'
    });
    assert.strictEqual(u2.status, 200);
    assert.strictEqual(u2.headers.get('x-ratelimit-remaining'), '3');

    // 3. Direct upload flow (signed-url -> storage put -> complete) consumes 3rd slot for the same verified UID
    const signRes = await sendJsonPost(
      '/api/upload/direct/signed-url',
      {
        chatId: 'conv_student_main',
        fileName: 'homework_3.txt',
        fileSize: 64,
        mimeType: 'text/plain'
      },
      { Authorization: `Bearer ${studentToken}` }
    );
    assert.strictEqual(signRes.status, 200, 'Direct signed-url must succeed for authenticated student');
    const { attachmentId, storagePath } = signRes.data;
    assert.ok(storagePath.startsWith(`${studentUid}/conv_student_main/`));

    mockStorage._objects.set(storagePath, {
      buffer: Buffer.from('Direct uploaded student homework #3'),
      contentType: 'text/plain'
    });

    const completeRes = await sendJsonPost(
      '/api/upload/direct/complete',
      {
        chatId: 'conv_student_main',
        attachmentId
      },
      { Authorization: `Bearer ${studentToken}` }
    );
    assert.strictEqual(completeRes.status, 200, 'Direct upload complete must succeed for authenticated student');
    assert.strictEqual(completeRes.headers.get('x-ratelimit-remaining'), '2');

    // 4. Consume remaining 2 slots (uploads 4 and 5)
    for (let i = 4; i <= 5; i++) {
      const r = await sendMultipartUpload({
        endpoint: '/api/upload',
        token: studentToken,
        conversationId: 'conv_student_main',
        filename: `homework_${i}.txt`
      });
      assert.strictEqual(r.status, 200);
    }

    // 5. Verify 6th upload is rejected with 429 QUOTA_EXCEEDED even if client rotates guest cookies/headers
    const rotatedGuest = createServerIssuedGuestToken().guestToken;
    const sixthStandard = await sendMultipartUpload({
      endpoint: '/api/upload',
      token: studentToken,
      guestToken: rotatedGuest,
      cookie: `orvix_guest_token=${encodeURIComponent(rotatedGuest)}`,
      userIdInBody: 'fresh_fake_uid_' + crypto.randomUUID(),
      extraHeaders: { 'x-user-id': 'fresh_fake_uid' },
      conversationId: 'conv_student_main',
      filename: 'homework_6.txt'
    });
    assert.strictEqual(sixthStandard.status, 429, '6th upload must be blocked with 429 QUOTA_EXCEEDED');
    assert.strictEqual(sixthStandard.data?.code, 'QUOTA_EXCEEDED');

    // Direct upload signed-url is also blocked with 429 QUOTA_EXCEEDED on 6th attempt
    const sixthDirect = await sendJsonPost(
      '/api/upload/direct/signed-url',
      {
        chatId: 'conv_student_main',
        fileName: 'homework_6_direct.txt',
        fileSize: 128
      },
      {
        Authorization: `Bearer ${studentToken}`,
        Cookie: `orvix_guest_token=${encodeURIComponent(rotatedGuest)}`,
        'X-Guest-Token': rotatedGuest
      }
    );
    assert.strictEqual(sixthDirect.status, 429, '6th attempt via direct upload signed-url must be 429');
    assert.strictEqual(sixthDirect.data?.code, 'QUOTA_EXCEEDED');

    // Verify quota status for studentUid shows 5 committed
    const identity = buildAuthenticatedQuotaIdentity(studentUid);
    const status = await getQuotaStatus(identity);
    assert.strictEqual(status.committed, DAILY_UPLOAD_LIMIT);
    assert.strictEqual(status.remaining, 0);
  });

  // -------------------------------------------------------------------------
  // Test 6: Unit verification of resolveAuthenticatedUploadIdentity
  // -------------------------------------------------------------------------
  await test('6. resolveAuthenticatedUploadIdentity returns null for guests/invalid tokens and verified auth identity for valid tokens', async () => {
    const guestReq = {
      headers: {
        cookie: `orvix_guest_token=${createServerIssuedGuestToken().guestToken}`,
        'x-guest-token': createServerIssuedGuestToken().guestToken,
        'x-user-id': 'spoofed_uid'
      },
      body: { userId: 'spoofed_uid' }
    };
    const guestIdentity = await resolveAuthenticatedUploadIdentity(guestReq);
    assert.strictEqual(guestIdentity, null, 'Must return null when no valid Firebase Bearer token is present');

    const validUid = 'unit_verified_student_777';
    const validToken = createSignedJwt(validUid);
    const authReq = {
      headers: {
        authorization: `Bearer ${validToken}`,
        cookie: `orvix_guest_token=${createServerIssuedGuestToken().guestToken}`,
        'x-user-id': 'spoofed_other_uid'
      },
      body: { userId: 'spoofed_other_uid' }
    };
    const resolved = await resolveAuthenticatedUploadIdentity(authReq);
    assert.ok(resolved, 'Must resolve identity for valid Firebase token');
    assert.strictEqual(resolved.type, 'auth');
    assert.strictEqual(resolved.id, validUid);
    assert.ok(resolved.key.startsWith('auth_'));
  });
} finally {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  clearTestPublicKeys();
  resetFirebaseAuthForTesting();
  resetSupabaseClientForTesting();
  resetDirectUploadTicketsForTesting();
  fileRegistry.clear();
  conversationDocuments.clear();
}

console.log('\n================================================================');
console.log(`ORVIX P3 SUMMARY: ${passed} passed, ${failed} failed`);
console.log('================================================================\n');

if (failed > 0) {
  process.exit(1);
}
