/**
 * scripts/testUploadDailyQuota.js
 *
 * Comprehensive Test Suite for Backend-Enforced Daily Attachment Upload Quota:
 * 1. Five successful uploads allowed (HTTP 200, decrementing remaining headers).
 * 2. Sixth upload rejected with HTTP 429, QUOTA_EXCEEDED code, and reset headers.
 * 3. UTC midnight reset (quota resets automatically on new UTC calendar day).
 * 4. Authenticated-user isolation (User A at limit does not affect User B).
 * 5. Guest identity isolation and persistence (Guest A at limit does not affect Guest B; stable guest token).
 * 6. Concurrent requests cannot exceed the limit (10 simultaneous uploads -> exactly 5 accepted, 5 rejected).
 * 7. Multiple upload routes share the same quota (/api/upload and /upload consume the same pool).
 * 8. Failed uploads release their reservations safely (empty/corrupted files do not consume quota).
 * 9. Server restart does not reset quota (disk-persisted quota survives restart).
 * 10. Invalid or forged identity cannot bypass enforcement (forged JWT -> 401, forged guest token -> fresh guest, client-supplied userId ignored).
 * 11. Correct HTTP status, error code, and X-RateLimit-Reset-UTC header verification.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  setTestPublicKey,
  clearTestPublicKeys,
  resetFirebaseAuthForTesting
} from '../server/firebaseAuthHelper.ts';

import {
  DAILY_UPLOAD_LIMIT,
  RESERVATION_TTL_MS,
  setCustomDateHookForTesting,
  resetQuotaForTesting,
  resolveQuotaDirectory,
  getUtcDayString,
  getNextUtcMidnight,
  getOrInitServerSecret,
  signGuestId,
  createServerIssuedGuestToken,
  getFirestoreDb,
  createSimulatedFirestoreInstance,
  setFirestoreForTesting,
  resetFirestoreForTesting,
  setForceProductionModeForTesting,
  isProductionEnvironment,
  reserveUploadSlot,
  commitUploadSlot,
  releaseUploadSlot,
  getQuotaStatus,
  getFirebaseServiceAccountCredentials,
  parseServiceAccountCredential
} from '../server/uploadQuotaService.ts';

import http from 'node:http';

process.env.TESTING = '1';
process.env.FIREBASE_PROJECT_ID = 'orvix-quota-test-project';
const { app } = await import('../server.ts');

const TEST_PROJECT_ID = 'orvix-quota-test-project';
const TEST_KID = 'quota-test-kid-001';

// Ephemeral test HTTP server
const testServer = http.createServer(app);
await new Promise((resolve) => testServer.listen(0, '127.0.0.1', resolve));
const serverAddr = testServer.address();
let BASE_URL = `http://127.0.0.1:${serverAddr.port}`;

console.log('======================================================================');
console.log('Orvix Daily Upload Quota Verification Suite');
console.log(`Testing 11 Invariants against http://127.0.0.1:${serverAddr.port}`);
console.log('======================================================================\n');

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

async function test(name, fn) {
  totalTests++;
  try {
    await fn();
    console.log(`  ✓ PASS: ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  ✗ FAIL: ${name}`);
    console.error(`    ${err.stack || err.message}`);
    failedTests++;
    process.exitCode = 1;
  }
}

// Generate real RSA key pairs for authenticated Firebase token generation
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

const { publicKey: attackerPublicKey, privateKey: attackerPrivateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

function createSignedJwt(uid, customClaims = {}, signingKey = privateKey, kid = TEST_KID) {
  const header = { alg: 'RS256', kid, typ: 'JWT' };
  const nowSec = Math.floor(Date.now() / 1000);
  const payload = {
    aud: TEST_PROJECT_ID,
    iss: `https://securetoken.google.com/${TEST_PROJECT_ID}`,
    sub: uid,
    user_id: uid,
    iat: nowSec - 10,
    exp: nowSec + 3600,
    ...customClaims
  };

  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signedData = Buffer.from(`${headerB64}.${payloadB64}`);
  const signature = crypto.sign('RSA-SHA256', signedData, signingKey).toString('base64url');
  return `${headerB64}.${payloadB64}.${signature}`;
}

// Minimal valid PNG generator (8x8 RGBA)
function createValidPngBuffer() {
  const width = 8;
  const height = 8;
  // Raw 1x1 or 8x8 valid PNG binary header
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.from([
    0, 0, 0, 13, // length 13
    73, 72, 68, 82, // IHDR
    0, 0, 0, 8, // width 8
    0, 0, 0, 8, // height 8
    8, 6, 0, 0, 0, // 8-bit RGBA, no compression/filter/interlace
    141, 147, 85, 237 // CRC
  ]);
  // Minimal empty IDAT and IEND
  const idat = Buffer.from([
    0, 0, 0, 10, // length 10
    73, 68, 65, 84, // IDAT
    120, 156, 99, 0, 1, 0, 0, 5, 0, 2, // zlib stream
    90, 85, 142, 114 // CRC
  ]);
  const iend = Buffer.from([
    0, 0, 0, 0, // length 0
    73, 69, 78, 68, // IEND
    174, 66, 96, 130 // CRC
  ]);
  return Buffer.concat([signature, ihdr, idat, iend]);
}

// Upload helper supporting custom headers, conversationId, endpoint path, and cookies
async function uploadAttachment({
  endpoint = '/api/upload',
  token = null,
  guestToken = null,
  cookie = null,
  conversationId = 'test_conv_quota',
  filename = 'sample.txt',
  mimeType = null,
  buffer = null,
  extraHeaders = {}
} = {}) {
  const isTxt = filename.endsWith('.txt');
  const effectiveMime = mimeType || (isTxt ? 'text/plain' : 'image/png');
  const effectiveBuffer = buffer !== null ? buffer : (isTxt ? Buffer.from('Orvix valid quota upload content verified for testing.') : createValidPngBuffer());

  const boundary = '----WebKitFormBoundary' + crypto.randomBytes(8).toString('hex');
  const parts = [];

  if (conversationId) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="conversationId"\r\n\r\n${conversationId}\r\n`
      )
    );
  }

  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${filename}"\r\nContent-Type: ${effectiveMime}\r\n\r\n`
    )
  );
  parts.push(effectiveBuffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  const body = Buffer.concat(parts);

  const headers = {
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
    'Content-Length': String(body.length),
    ...extraHeaders
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  if (guestToken) {
    headers['X-Guest-Token'] = guestToken;
  }

  if (cookie) {
    headers['Cookie'] = cookie;
  }

  const res = await fetch(`${BASE_URL}${endpoint}`, {
    method: 'POST',
    headers,
    body
  });

  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {
    json = { raw: text };
  }

  return {
    status: res.status,
    ok: res.ok,
    headers: res.headers,
    data: json
  };
}

async function runAllTests() {
  // Setup environment & keys
  process.env.FIREBASE_PROJECT_ID = TEST_PROJECT_ID;
  setTestPublicKey(TEST_KID, publicKey);
  await resetQuotaForTesting();
  setCustomDateHookForTesting(null);

  // -------------------------------------------------------------------------
  // Test 1: Five successful uploads allowed for authenticated user
  // -------------------------------------------------------------------------
  await test('Five successful uploads allowed (HTTP 200 with decrementing remaining)', async () => {
    const uid = 'quota_user_1_' + crypto.randomUUID();
    const token = createSignedJwt(uid);
    const convId = 'conv_user_1';

    for (let i = 1; i <= 5; i++) {
      const res = await uploadAttachment({
        token,
        conversationId: convId,
        filename: `image_${i}.txt`
      });

      assert.strictEqual(res.status, 200, `Upload ${i} should return 200, got ${res.status}: ${JSON.stringify(res.data)}`);
      assert.strictEqual(res.data.success, true);
      assert.strictEqual(res.headers.get('x-ratelimit-limit'), '5');
      const expectedRemaining = String(5 - i);
      assert.strictEqual(res.headers.get('x-ratelimit-remaining'), expectedRemaining);
      assert.ok(res.headers.get('x-ratelimit-reset-utc'), 'Must include X-RateLimit-Reset-UTC header');
    }
  });

  // -------------------------------------------------------------------------
  // Test 2: Sixth upload rejected with HTTP 429 and QUOTA_EXCEEDED
  // -------------------------------------------------------------------------
  await test('Sixth upload rejected with HTTP 429 QUOTA_EXCEEDED and reset header', async () => {
    const uid = 'quota_user_2_' + crypto.randomUUID();
    const token = createSignedJwt(uid);
    const convId = 'conv_user_2';

    // Exhaust 5 uploads
    for (let i = 1; i <= 5; i++) {
      const r = await uploadAttachment({ token, conversationId: convId, filename: `file_${i}.txt` });
      assert.strictEqual(r.status, 200);
    }

    // 6th upload
    const res6 = await uploadAttachment({ token, conversationId: convId, filename: 'file_6.txt' });
    assert.strictEqual(res6.status, 429, `Expected HTTP 429, got ${res6.status}`);
    assert.strictEqual(res6.data.code, 'QUOTA_EXCEEDED');
    assert.strictEqual(res6.data.status, 'QUOTA_EXCEEDED');
    assert.strictEqual(res6.data.limit, 5);
    assert.strictEqual(res6.data.remaining, 0);
    assert.ok(res6.data.resetAt, 'Should include resetAt timestamp in body');
    assert.strictEqual(res6.headers.get('x-ratelimit-limit'), '5');
    assert.strictEqual(res6.headers.get('x-ratelimit-remaining'), '0');
    assert.ok(res6.headers.get('x-ratelimit-reset-utc'), 'Should include X-RateLimit-Reset-UTC header');
  });

  // -------------------------------------------------------------------------
  // Test 3: UTC Midnight Reset
  // -------------------------------------------------------------------------
  await test('UTC midnight reset automatically clears quota on new calendar day', async () => {
    const uid = 'quota_user_3_' + crypto.randomUUID();
    const token = createSignedJwt(uid);
    const convId = 'conv_user_3';

    // Day 1: 2026-11-09 23:45:00 UTC
    const day1 = new Date('2026-11-09T23:45:00.000Z');
    setCustomDateHookForTesting(() => day1);

    for (let i = 1; i <= 5; i++) {
      const r = await uploadAttachment({ token, conversationId: convId, filename: `d1_${i}.txt` });
      assert.strictEqual(r.status, 200);
    }

    // Attempt on Day 1 is blocked
    const blocked = await uploadAttachment({ token, conversationId: convId, filename: 'd1_6.txt' });
    assert.strictEqual(blocked.status, 429);

    // Day 2: 2026-11-10 00:00:05 UTC (midnight rolled over)
    const day2 = new Date('2026-11-10T00:00:05.000Z');
    setCustomDateHookForTesting(() => day2);

    // Upload on Day 2 must succeed immediately
    const resDay2 = await uploadAttachment({ token, conversationId: convId, filename: 'd2_1.txt' });
    assert.strictEqual(resDay2.status, 200, `Upload on new UTC day should succeed with 200, got ${resDay2.status}`);
    assert.strictEqual(resDay2.headers.get('x-ratelimit-remaining'), '4');

    setCustomDateHookForTesting(null);
  });

  // -------------------------------------------------------------------------
  // Test 4: Authenticated User Isolation
  // -------------------------------------------------------------------------
  await test('Authenticated user isolation: User A at limit does not block User B', async () => {
    const uidA = 'user_A_' + crypto.randomUUID();
    const uidB = 'user_B_' + crypto.randomUUID();
    const tokenA = createSignedJwt(uidA);
    const tokenB = createSignedJwt(uidB);

    // User A consumes all 5 slots
    for (let i = 1; i <= 5; i++) {
      const r = await uploadAttachment({ token: tokenA, conversationId: 'conv_A', filename: `a_${i}.txt` });
      assert.strictEqual(r.status, 200);
    }

    // User A is blocked
    const rA = await uploadAttachment({ token: tokenA, conversationId: 'conv_A', filename: 'a_6.txt' });
    assert.strictEqual(rA.status, 429);

    // User B must still have full quota
    const rB1 = await uploadAttachment({ token: tokenB, conversationId: 'conv_B', filename: 'b_1.txt' });
    assert.strictEqual(rB1.status, 200, 'User B should not be blocked by User A');
    assert.strictEqual(rB1.headers.get('x-ratelimit-remaining'), '4');
  });

  // -------------------------------------------------------------------------
  // Test 5: Guest Identity Isolation & Persistence
  // -------------------------------------------------------------------------
  await test('Guest identity isolation & persistence: Server-issued token persists quota across requests', async () => {
    // 1. Initial guest upload receives server-issued guest token
    const firstGuestUpload = await uploadAttachment({ conversationId: undefined, filename: 'guest_1.txt' });
    assert.strictEqual(firstGuestUpload.status, 200);

    const guestToken = firstGuestUpload.headers.get('x-guest-token');
    assert.ok(guestToken, 'Server must return X-Guest-Token header for guests');
    assert.ok(guestToken.startsWith('guest_'), 'Guest token must be server-issued');

    // 2. Consume remaining 4 uploads with this guest token
    for (let i = 2; i <= 5; i++) {
      const r = await uploadAttachment({
        guestToken,
        conversationId: undefined,
        filename: `guest_${i}.txt`
      });
      assert.strictEqual(r.status, 200, `Guest upload ${i} should succeed`);
    }

    // 3. 6th upload with same guest token is blocked
    const r6 = await uploadAttachment({
      guestToken,
      conversationId: undefined,
      filename: 'guest_6.txt'
    });
    assert.strictEqual(r6.status, 429, 'Guest exceeding limit must receive 429');
    assert.strictEqual(r6.data.code, 'QUOTA_EXCEEDED');

    // 4. A different guest (with fresh identity) is not affected
    const otherGuestUpload = await uploadAttachment({
      conversationId: undefined,
      filename: 'other_guest.txt'
    });
    assert.strictEqual(otherGuestUpload.status, 200, 'Different guest should succeed');
  });

  // -------------------------------------------------------------------------
  // Test 6: Concurrent Requests Cannot Exceed the Limit
  // -------------------------------------------------------------------------
  await test('Concurrent requests cannot exceed quota (atomic reservation protection)', async () => {
    const uid = 'concurrent_user_' + crypto.randomUUID();
    const token = createSignedJwt(uid);
    const convId = 'conv_concurrent';

    // Fire 10 simultaneous uploads at the exact same millisecond
    const promises = Array.from({ length: 10 }, (_, i) =>
      uploadAttachment({
        token,
        conversationId: convId,
        filename: `conc_${i}.txt`
      })
    );

    const results = await Promise.all(promises);

    const successCount = results.filter((r) => r.status === 200).length;
    const quotaExceededCount = results.filter((r) => r.status === 429).length;

    assert.strictEqual(successCount, 5, `Exactly 5 concurrent requests must succeed, got ${successCount}`);
    assert.strictEqual(quotaExceededCount, 5, `Exactly 5 concurrent requests must be rejected with 429, got ${quotaExceededCount}`);

    // Any subsequent upload must also be rejected
    const followUp = await uploadAttachment({ token, conversationId: convId, filename: 'conc_after.txt' });
    assert.strictEqual(followUp.status, 429);
  });

  // -------------------------------------------------------------------------
  // Test 7: Multiple Upload Routes Share the Same Quota
  // -------------------------------------------------------------------------
  await test('Multiple upload routes (/api/upload and /upload) share the same quota', async () => {
    const uid = 'routes_user_' + crypto.randomUUID();
    const token = createSignedJwt(uid);
    const convId = 'conv_routes';

    // 3 uploads to /api/upload
    for (let i = 1; i <= 3; i++) {
      const r = await uploadAttachment({
        endpoint: '/api/upload',
        token,
        conversationId: convId,
        filename: `api_${i}.txt`
      });
      assert.strictEqual(r.status, 200);
    }

    // 2 uploads to /upload
    for (let i = 4; i <= 5; i++) {
      const r = await uploadAttachment({
        endpoint: '/upload',
        token,
        conversationId: convId,
        filename: `raw_${i}.txt`
      });
      assert.strictEqual(r.status, 200);
    }

    // 6th upload to /api/upload must be rejected
    const r6Api = await uploadAttachment({
      endpoint: '/api/upload',
      token,
      conversationId: convId,
      filename: 'overflow_api.txt'
    });
    assert.strictEqual(r6Api.status, 429);

    // 6th upload to /upload must also be rejected
    const r6Raw = await uploadAttachment({
      endpoint: '/upload',
      token,
      conversationId: convId,
      filename: 'overflow_raw.txt'
    });
    assert.strictEqual(r6Raw.status, 429);
  });

  // -------------------------------------------------------------------------
  // Test 8: Failed Uploads Release Reservations Safely
  // -------------------------------------------------------------------------
  await test('Failed uploads release their reservations without consuming quota slots', async () => {
    const uid = 'fail_release_user_' + crypto.randomUUID();
    const token = createSignedJwt(uid);
    const convId = 'conv_fail_release';

    // Upload 1: Valid upload (1 consumed)
    const u1 = await uploadAttachment({ token, conversationId: convId, filename: 'valid_1.txt' });
    assert.strictEqual(u1.status, 200);
    assert.strictEqual(u1.headers.get('x-ratelimit-remaining'), '4');

    // Upload 2: Corrupted buffer (fails signature verification) -> should be rejected with 400
    const corruptBuffer = Buffer.from('NOT_A_VALID_IMAGE_HEADER_123456');
    const uFail = await uploadAttachment({
      token,
      conversationId: convId,
      filename: 'bad.png',
      buffer: corruptBuffer
    });
    assert.strictEqual(uFail.status, 400);

    // Upload 3: Another failed upload (empty buffer)
    const uEmpty = await uploadAttachment({
      token,
      conversationId: convId,
      filename: 'empty.txt',
      buffer: Buffer.alloc(0)
    });
    assert.strictEqual(uEmpty.status, 400);

    // The user should still be able to complete 4 more valid uploads (totaling exactly 5 valid uploads)
    for (let i = 2; i <= 5; i++) {
      const r = await uploadAttachment({ token, conversationId: convId, filename: `valid_${i}.txt` });
      assert.strictEqual(r.status, 200, `Valid upload ${i} should succeed despite previous failures`);
    }

    // Now quota is exhausted; 6th valid upload should be 429
    const uBlocked = await uploadAttachment({ token, conversationId: convId, filename: 'valid_6.txt' });
    assert.strictEqual(uBlocked.status, 429);
  });

  // -------------------------------------------------------------------------
  // Test 9: Serverless Instance Restart Does Not Reset Quota (Firestore Persistence)
  // -------------------------------------------------------------------------
  await test('Serverless instance restart does not reset quota (Firestore persistence)', async () => {
    const uid = 'restart_user_' + crypto.randomUUID();
    const token = createSignedJwt(uid);
    const convId = 'conv_restart';

    // Exhaust 5 uploads
    for (let i = 1; i <= 5; i++) {
      const r = await uploadAttachment({ token, conversationId: convId, filename: `file_${i}.txt` });
      assert.strictEqual(r.status, 200);
    }

    // Verify quota document exists in Firestore
    const db = getFirestoreDb();
    const today = getUtcDayString();
    const hashedUid = crypto.createHash('sha256').update(`auth:${uid}`).digest('hex').slice(0, 32);
    const docId = `auth_${hashedUid}_${today}`;
    const docRef = db.collection('uploadQuotas').doc(docId);
    let storedRecord;
    await db.runTransaction(async (transaction) => {
      const snap = await transaction.get(docRef);
      assert.ok(snap.exists, 'Quota record must exist in persistent Firestore');
      storedRecord = snap.data();
    });

    assert.strictEqual(storedRecord.committed, 5, 'Stored record must have committed: 5');

    // Simulate fresh serverless instance connecting to Firestore
    const freshInstance = createSimulatedFirestoreInstance();
    setFirestoreForTesting(freshInstance);

    const postRestartUpload = await uploadAttachment({
      token,
      conversationId: convId,
      filename: 'file_after_restart.txt'
    });

    assert.strictEqual(postRestartUpload.status, 429, 'Must still be 429 after instance restart');
    assert.strictEqual(postRestartUpload.data.code, 'QUOTA_EXCEEDED');

    setFirestoreForTesting(null);
  });

  // -------------------------------------------------------------------------
  // Test 10: Invalid or Forged Identity Cannot Bypass Enforcement
  // -------------------------------------------------------------------------
  await test('Invalid or forged identity cannot bypass quota enforcement', async () => {
    // 1. Forged Firebase token with wrong signature -> rejected with 401
    const forgedToken = createSignedJwt('victim_user_999', {}, attackerPrivateKey);
    const resForgedAuth = await uploadAttachment({
      token: forgedToken,
      conversationId: 'conv_forged',
      filename: 'forged.txt'
    });
    assert.strictEqual(resForgedAuth.status, 401, 'Forged JWT must be rejected with 401');

    // 2. Client-supplied userId in body is ignored
    const resSpoofedBody = await uploadAttachment({
      extraHeaders: { 'x-user-id': 'victim_admin' },
      conversationId: undefined,
      filename: 'spoof.txt'
    });
    assert.strictEqual(resSpoofedBody.status, 200);
    // Must be assigned a guest identity, NOT victim_admin
    const guestToken = resSpoofedBody.headers.get('x-guest-token');
    assert.ok(guestToken, 'Must receive server-issued guest token');

    // 3. Forged guest token with tampered signature
    const forgedGuestToken = 'guest_1234567890abcdef.deadbeefcafebabe';
    const resForgedGuest = await uploadAttachment({
      guestToken: forgedGuestToken,
      conversationId: undefined,
      filename: 'forged_guest.txt'
    });
    assert.strictEqual(resForgedGuest.status, 200);
    const newGuestToken = resForgedGuest.headers.get('x-guest-token');
    // Must issue a NEW token, not adopt the forged guest ID
    assert.notStrictEqual(newGuestToken, forgedGuestToken);
  });

  // -------------------------------------------------------------------------
  // Test 11: Correct HTTP Status, Error Code, and Reset Header
  // -------------------------------------------------------------------------
  await test('Correct HTTP status, error code, and X-RateLimit-Reset-UTC header verification', async () => {
    const uid = 'header_test_user_' + crypto.randomUUID();
    const token = createSignedJwt(uid);
    const convId = 'conv_header_test';

    // Exhaust 5 uploads
    for (let i = 1; i <= 5; i++) {
      await uploadAttachment({ token, conversationId: convId, filename: `h_${i}.txt` });
    }

    const res = await uploadAttachment({ token, conversationId: convId, filename: 'h_exceeded.txt' });
    assert.strictEqual(res.status, 429);
    assert.strictEqual(res.data.code, 'QUOTA_EXCEEDED');
    assert.strictEqual(res.data.status, 'QUOTA_EXCEEDED');

    const resetHeader = res.headers.get('x-ratelimit-reset-utc');
    assert.ok(resetHeader, 'X-RateLimit-Reset-UTC header must be present');

    // Validate that resetHeader is a valid ISO date representing UTC midnight
    const resetDate = new Date(resetHeader);
    assert.ok(!isNaN(resetDate.getTime()), 'Reset date must be valid ISO timestamp');
    assert.strictEqual(resetDate.getUTCHours(), 0);
    assert.strictEqual(resetDate.getUTCMinutes(), 0);
    assert.strictEqual(resetDate.getUTCSeconds(), 0);
  });

  // -------------------------------------------------------------------------
  // Test 12: Concurrent Requests Across Simulated Serverless Instances
  // -------------------------------------------------------------------------
  await test('Concurrent requests across simulated serverless instances enforce limit atomically', async () => {
    const uid = 'multiserverless_user_' + crypto.randomUUID();
    const hashedUid = crypto.createHash('sha256').update(`auth:${uid}`).digest('hex').slice(0, 32);
    const identity = {
      type: 'auth',
      id: uid,
      key: `auth_${hashedUid}`
    };

    // Simulate 3 serverless instances sharing the same Firestore database
    const instanceA = createSimulatedFirestoreInstance();
    const instanceB = createSimulatedFirestoreInstance();
    const instanceC = createSimulatedFirestoreInstance();

    // Fire 12 concurrent reservation requests spread across the 3 instances
    const instances = [instanceA, instanceB, instanceC];
    const reservePromises = Array.from({ length: 12 }, async (_, idx) => {
      const activeInst = instances[idx % instances.length];
      setFirestoreForTesting(activeInst);
      return reserveUploadSlot(identity);
    });

    const results = await Promise.all(reservePromises);
    setFirestoreForTesting(null);

    const allowed = results.filter((r) => r.allowed === true);
    const rejected = results.filter((r) => r.allowed === false);

    assert.strictEqual(allowed.length, 5, `Exactly 5 reservations allowed across instances, got ${allowed.length}`);
    assert.strictEqual(rejected.length, 7, `Exactly 7 reservations rejected across instances, got ${rejected.length}`);

    // Commit all 5 reservations across instances
    for (let i = 0; i < allowed.length; i++) {
      const res = allowed[i].reservation;
      const inst = instances[i % instances.length];
      setFirestoreForTesting(inst);
      await commitUploadSlot(res);
    }
    setFirestoreForTesting(null);

    // Final quota check must show committed: 5, remaining: 0
    const finalStatus = await getQuotaStatus(identity);
    assert.strictEqual(finalStatus.committed, 5);
    assert.strictEqual(finalStatus.remaining, 0);
  });

  // -------------------------------------------------------------------------
  // Test 13: Reservation Expiry Protection (Requirement 5)
  // -------------------------------------------------------------------------
  await test('Expired reservations cannot cause active uploads to exceed quota', async () => {
    const uid = 'expiry_race_user_' + crypto.randomUUID();
    const hashedUid = crypto.createHash('sha256').update(`auth:${uid}`).digest('hex').slice(0, 32);
    const identity = {
      type: 'auth',
      id: uid,
      key: `auth_${hashedUid}`
    };

    const t0 = new Date('2026-11-09T12:00:00.000Z');
    setCustomDateHookForTesting(() => t0);

    // 1. Commit 4 uploads so 1 slot remains
    for (let i = 1; i <= 4; i++) {
      const res = await reserveUploadSlot(identity);
      assert.strictEqual(res.allowed, true);
      await commitUploadSlot(res.reservation);
    }

    // 2. Slow upload A reserves slot 5 at T=0
    const slowReserveA = await reserveUploadSlot(identity);
    assert.strictEqual(slowReserveA.allowed, true, 'Slot 5 should be reserved by slow upload A');
    assert.strictEqual(slowReserveA.remaining, 0);

    // 3. Advance time by 125 seconds: slow upload A reservation expires
    const tExpired = new Date('2026-11-09T12:02:05.000Z'); // +125 seconds (> 120s TTL)
    setCustomDateHookForTesting(() => tExpired);

    // 4. Fast upload B arrives while slow upload A is expired.
    // Upload B detects A is expired, prunes it, and claims slot 5
    const fastReserveB = await reserveUploadSlot(identity);
    assert.strictEqual(fastReserveB.allowed, true, 'Slot 5 claimed by fast upload B');

    // 5. Fast upload B commits successfully
    const commitB = await commitUploadSlot(fastReserveB.reservation);
    assert.strictEqual(commitB.committed, 5, 'Fast upload B committed 5th slot');
    assert.strictEqual(commitB.remaining, 0);

    // 6. Slow upload A now finishes at T=130s and attempts to commit its expired reservation.
    // INVARIANT: Expired reservation MUST NOT cause quota to exceed 5!
    let commitFailed = false;
    try {
      await commitUploadSlot(slowReserveA.reservation);
    } catch (err) {
      commitFailed = true;
      assert.strictEqual(err.code, 'QUOTA_EXCEEDED');
    }
    assert.ok(commitFailed, 'Expired reservation must be rejected when quota is full');

    // Total committed must strictly remain 5
    const status = await getQuotaStatus(identity);
    assert.strictEqual(status.committed, 5, 'Committed uploads must never exceed 5');
    assert.strictEqual(status.remaining, 0);

    setCustomDateHookForTesting(null);
  });

  // -------------------------------------------------------------------------
  // Test 14: Expired reservation safely reclaimed when upload was abandoned
  // -------------------------------------------------------------------------
  await test('Expired reservation without subsequent quota exhaustion safely commits or reclaims', async () => {
    const uid = 'abandoned_user_' + crypto.randomUUID();
    const hashedUid = crypto.createHash('sha256').update(`auth:${uid}`).digest('hex').slice(0, 32);
    const identity = {
      type: 'auth',
      id: uid,
      key: `auth_${hashedUid}`
    };

    const t0 = new Date('2026-11-09T14:00:00.000Z');
    setCustomDateHookForTesting(() => t0);

    // Reserve slot 1 but do NOT commit (abandoned upload)
    const abandonedRes = await reserveUploadSlot(identity);
    assert.strictEqual(abandonedRes.allowed, true);

    // Advance time past 120s TTL
    const tPastTtl = new Date('2026-11-09T14:03:00.000Z'); // +180s
    setCustomDateHookForTesting(() => tPastTtl);

    // Status should show 0 active reservations because abandoned reservation expired
    const status = await getQuotaStatus(identity);
    assert.strictEqual(status.activeReservations, 0);
    assert.strictEqual(status.remaining, 5);

    // New upload can successfully claim and commit
    const freshRes = await reserveUploadSlot(identity);
    assert.strictEqual(freshRes.allowed, true);
    const committedStatus = await commitUploadSlot(freshRes.reservation);
    assert.strictEqual(committedStatus.committed, 1);
    assert.strictEqual(committedStatus.remaining, 4);

    setCustomDateHookForTesting(null);
  });

  // -------------------------------------------------------------------------
  // Test 15: UTC midnight rollover isolation under active load
  // -------------------------------------------------------------------------
  await test('UTC midnight rollover maintains complete date isolation in Firestore', async () => {
    const uid = 'rollover_user_' + crypto.randomUUID();
    const token = createSignedJwt(uid);
    const hashedUid = crypto.createHash('sha256').update(`auth:${uid}`).digest('hex').slice(0, 32);
    const identity = {
      type: 'auth',
      id: uid,
      key: `auth_${hashedUid}`
    };

    // Day 1: 23:59:50 UTC
    const day1Time = new Date('2026-11-09T23:59:50.000Z');
    setCustomDateHookForTesting(() => day1Time);

    for (let i = 1; i <= 5; i++) {
      const res = await uploadAttachment({ token, conversationId: 'conv_roll', filename: `roll1_${i}.txt` });
      assert.strictEqual(res.status, 200);
    }

    const day1Status = await getQuotaStatus(identity);
    assert.strictEqual(day1Status.committed, 5);
    assert.strictEqual(day1Status.remaining, 0);

    // Day 2: 00:00:05 UTC (Midnight rollover)
    const day2Time = new Date('2026-11-10T00:00:05.000Z');
    setCustomDateHookForTesting(() => day2Time);

    const day2Status = await getQuotaStatus(identity);
    assert.strictEqual(day2Status.committed, 0, 'New UTC day must start with 0 committed');
    assert.strictEqual(day2Status.remaining, 5, 'New UTC day must start with 5 remaining');

    // Complete Day 2 upload
    const resDay2 = await uploadAttachment({ token, conversationId: 'conv_roll', filename: 'roll2_1.txt' });
    assert.strictEqual(resDay2.status, 200);
    assert.strictEqual(resDay2.headers.get('x-ratelimit-remaining'), '4');

    // Check Day 1 record in Firestore remains committed: 5
    const db = getFirestoreDb();
    const day1DocRef = db.collection('uploadQuotas').doc(`auth_${hashedUid}_2026-11-09`);
    await db.runTransaction(async (transaction) => {
      const snap = await transaction.get(day1DocRef);
      assert.strictEqual(snap.data().committed, 5);
    });

    setCustomDateHookForTesting(null);
  });

  // -------------------------------------------------------------------------
  // Test 16: Production fails closed when FIREBASE_PROJECT_ID is missing
  // -------------------------------------------------------------------------
  await test('Production fails closed with fatal error when FIREBASE_PROJECT_ID is missing', async () => {
    setForceProductionModeForTesting(true);
    const origProjectId = process.env.FIREBASE_PROJECT_ID;
    const origViteProjectId = process.env.VITE_FIREBASE_PROJECT_ID;
    delete process.env.FIREBASE_PROJECT_ID;
    delete process.env.VITE_FIREBASE_PROJECT_ID;

    let thrownError = null;
    try {
      getFirestoreDb();
    } catch (err) {
      thrownError = err;
    } finally {
      process.env.FIREBASE_PROJECT_ID = origProjectId;
      if (origViteProjectId) process.env.VITE_FIREBASE_PROJECT_ID = origViteProjectId;
      setForceProductionModeForTesting(null);
    }

    assert.ok(thrownError, 'Must throw fatal error in production when project ID is missing');
    assert.ok(
      thrownError.message.includes('Production deployment requires a valid FIREBASE_PROJECT_ID'),
      `Expected fatal project ID error, got: ${thrownError.message}`
    );
  });

  // -------------------------------------------------------------------------
  // Test 17: Production fails closed when Firebase Admin credentials are missing
  // -------------------------------------------------------------------------
  await test('Production fails closed with fatal error when Firebase Admin credentials are missing', async () => {
    setForceProductionModeForTesting(true);
    const origSa = process.env.FIREBASE_SERVICE_ACCOUNT;
    const origSaKey = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    const origGac = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    delete process.env.FIREBASE_SERVICE_ACCOUNT;
    delete process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;

    let thrownError = null;
    try {
      getFirestoreDb();
    } catch (err) {
      thrownError = err;
    } finally {
      if (origSa) process.env.FIREBASE_SERVICE_ACCOUNT = origSa;
      else delete process.env.FIREBASE_SERVICE_ACCOUNT;
      if (origSaKey) process.env.FIREBASE_SERVICE_ACCOUNT_KEY = origSaKey;
      else delete process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
      if (origGac) process.env.GOOGLE_APPLICATION_CREDENTIALS = origGac;
      else delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
      setForceProductionModeForTesting(null);
    }

    assert.ok(thrownError, 'Must throw fatal error in production when credentials are missing');
    assert.ok(
      thrownError.message.includes('Production deployment requires Firebase Admin credentials'),
      `Expected fatal credentials error, got: ${thrownError.message}`
    );
    assert.ok(
      thrownError.message.includes('In-memory fallback is strictly forbidden in production'),
      'Must explicitly state that in-memory fallback is forbidden in production'
    );
  });

  // -------------------------------------------------------------------------
  // Test 18: Production fails closed when FIREBASE_SERVICE_ACCOUNT contains invalid JSON
  // -------------------------------------------------------------------------
  await test('Production fails closed when FIREBASE_SERVICE_ACCOUNT contains invalid JSON', async () => {
    setForceProductionModeForTesting(true);
    const origSa = process.env.FIREBASE_SERVICE_ACCOUNT;
    const origSaKey = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    delete process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    process.env.FIREBASE_SERVICE_ACCOUNT = '{ this_is: invalid_json, broken: ';

    let thrownError = null;
    try {
      getFirestoreDb();
    } catch (err) {
      thrownError = err;
    } finally {
      if (origSa) process.env.FIREBASE_SERVICE_ACCOUNT = origSa;
      else delete process.env.FIREBASE_SERVICE_ACCOUNT;
      if (origSaKey) process.env.FIREBASE_SERVICE_ACCOUNT_KEY = origSaKey;
      else delete process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
      setForceProductionModeForTesting(null);
    }

    assert.ok(thrownError, 'Must throw fatal error for invalid service account JSON');
    assert.ok(
      thrownError.message.includes('FIREBASE_SERVICE_ACCOUNT contains invalid JSON') ||
        thrownError.message.includes('Failed to initialize Firebase Admin Firestore'),
      `Expected invalid JSON error, got: ${thrownError.message}`
    );
  });

  // -------------------------------------------------------------------------
  // Test 19: Production fail-closed rejects live HTTP upload with 500 QUOTA_SERVICE_UNAVAILABLE
  // -------------------------------------------------------------------------
  await test('Production fail-closed rejects live HTTP upload with 500 QUOTA_SERVICE_UNAVAILABLE', async () => {
    setForceProductionModeForTesting(true);
    const origSa = process.env.FIREBASE_SERVICE_ACCOUNT;
    const origSaKey = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    const origGac = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    delete process.env.FIREBASE_SERVICE_ACCOUNT;
    delete process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;

    const uid = 'prod_failclosed_user_' + crypto.randomUUID();
    const token = createSignedJwt(uid);

    let res;
    try {
      res = await uploadAttachment({ token, conversationId: 'conv_prod_fail', filename: 'prod_fail.txt' });
    } finally {
      if (origSa) process.env.FIREBASE_SERVICE_ACCOUNT = origSa;
      else delete process.env.FIREBASE_SERVICE_ACCOUNT;
      if (origSaKey) process.env.FIREBASE_SERVICE_ACCOUNT_KEY = origSaKey;
      else delete process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
      if (origGac) process.env.GOOGLE_APPLICATION_CREDENTIALS = origGac;
      else delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
      setForceProductionModeForTesting(null);
    }

    assert.strictEqual(res.status, 500, `Expected 500 status when production misconfigured, got ${res.status}`);
    assert.strictEqual(res.data.code, 'QUOTA_SERVICE_UNAVAILABLE');
    assert.strictEqual(res.data.status, 'SERVICE_UNAVAILABLE');
  });

  // -------------------------------------------------------------------------
  // Test 20: In-memory fallback is preserved exclusively for tests and permitted dev
  // -------------------------------------------------------------------------
  await test('In-memory fallback is strictly preserved for tests and permitted development environments', async () => {
    setForceProductionModeForTesting(false);

    // In testing/dev mode, getFirestoreDb returns the in-memory transactional adapter without throwing
    const devDb = getFirestoreDb();
    assert.ok(devDb, 'Must return database instance in test/dev mode');
    assert.strictEqual(typeof devDb.runTransaction, 'function');
    assert.strictEqual(typeof devDb.collection, 'function');

    setForceProductionModeForTesting(null);
  });

  // -------------------------------------------------------------------------
  // Test 21: getFirebaseServiceAccountCredentials resolves both variable names with precedence
  // -------------------------------------------------------------------------
  await test('getFirebaseServiceAccountCredentials resolves FIREBASE_SERVICE_ACCOUNT and FIREBASE_SERVICE_ACCOUNT_KEY with precedence', async () => {
    const origSa = process.env.FIREBASE_SERVICE_ACCOUNT;
    const origSaKey = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;

    try {
      // 1. Neither variable set -> returns null
      delete process.env.FIREBASE_SERVICE_ACCOUNT;
      delete process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
      assert.strictEqual(getFirebaseServiceAccountCredentials(), null);

      // 2. Only FIREBASE_SERVICE_ACCOUNT set -> resolves FIREBASE_SERVICE_ACCOUNT
      process.env.FIREBASE_SERVICE_ACCOUNT = '{"type":"service_account","project_id":"sa-test"}';
      const res1 = getFirebaseServiceAccountCredentials();
      assert.ok(res1);
      assert.strictEqual(res1.sourceVar, 'FIREBASE_SERVICE_ACCOUNT');
      assert.strictEqual(res1.raw, '{"type":"service_account","project_id":"sa-test"}');

      // 3. Only FIREBASE_SERVICE_ACCOUNT_KEY set -> resolves FIREBASE_SERVICE_ACCOUNT_KEY
      delete process.env.FIREBASE_SERVICE_ACCOUNT;
      process.env.FIREBASE_SERVICE_ACCOUNT_KEY = '{"type":"service_account","project_id":"key-test"}';
      const res2 = getFirebaseServiceAccountCredentials();
      assert.ok(res2);
      assert.strictEqual(res2.sourceVar, 'FIREBASE_SERVICE_ACCOUNT_KEY');
      assert.strictEqual(res2.raw, '{"type":"service_account","project_id":"key-test"}');

      // 4. Both variables set -> prefers FIREBASE_SERVICE_ACCOUNT
      process.env.FIREBASE_SERVICE_ACCOUNT = '{"type":"service_account","project_id":"preferred-sa"}';
      process.env.FIREBASE_SERVICE_ACCOUNT_KEY = '{"type":"service_account","project_id":"ignored-key"}';
      const res3 = getFirebaseServiceAccountCredentials();
      assert.ok(res3);
      assert.strictEqual(res3.sourceVar, 'FIREBASE_SERVICE_ACCOUNT');
      assert.strictEqual(res3.raw, '{"type":"service_account","project_id":"preferred-sa"}');
    } finally {
      if (origSa) process.env.FIREBASE_SERVICE_ACCOUNT = origSa;
      else delete process.env.FIREBASE_SERVICE_ACCOUNT;
      if (origSaKey) process.env.FIREBASE_SERVICE_ACCOUNT_KEY = origSaKey;
      else delete process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    }
  });

  // -------------------------------------------------------------------------
  // Test 22: Production fails closed when FIREBASE_SERVICE_ACCOUNT_KEY contains invalid JSON
  // -------------------------------------------------------------------------
  await test('Production fails closed when FIREBASE_SERVICE_ACCOUNT_KEY contains invalid JSON', async () => {
    setForceProductionModeForTesting(true);
    const origSa = process.env.FIREBASE_SERVICE_ACCOUNT;
    const origSaKey = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    delete process.env.FIREBASE_SERVICE_ACCOUNT;
    process.env.FIREBASE_SERVICE_ACCOUNT_KEY = '{ broken_json_in_key: ';

    let thrownError = null;
    try {
      getFirestoreDb();
    } catch (err) {
      thrownError = err;
    } finally {
      if (origSa) process.env.FIREBASE_SERVICE_ACCOUNT = origSa;
      else delete process.env.FIREBASE_SERVICE_ACCOUNT;
      if (origSaKey) process.env.FIREBASE_SERVICE_ACCOUNT_KEY = origSaKey;
      else delete process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
      setForceProductionModeForTesting(null);
    }

    assert.ok(thrownError, 'Must throw fatal error for invalid FIREBASE_SERVICE_ACCOUNT_KEY JSON');
    assert.ok(
      thrownError.message.includes('FIREBASE_SERVICE_ACCOUNT_KEY contains invalid JSON') ||
        thrownError.message.includes('Failed to initialize Firebase Admin Firestore'),
      `Expected invalid JSON error mentioning FIREBASE_SERVICE_ACCOUNT_KEY, got: ${thrownError.message}`
    );
  });

  // -------------------------------------------------------------------------
  // Test 23: parseServiceAccountCredential parses raw JSON for both variable names
  // -------------------------------------------------------------------------
  await test('parseServiceAccountCredential parses raw JSON for both variable names', async () => {
    const rawJson = JSON.stringify({
      type: 'service_account',
      project_id: 'test-raw-json-project',
      private_key: '-----BEGIN PRIVATE KEY-----\nMIIE...',
      client_email: 'test@test-raw-json-project.iam.gserviceaccount.com'
    });

    const parsed1 = parseServiceAccountCredential(rawJson, 'FIREBASE_SERVICE_ACCOUNT');
    assert.ok(parsed1);
    assert.strictEqual(parsed1.type, 'service_account');
    assert.strictEqual(parsed1.project_id, 'test-raw-json-project');

    const parsed2 = parseServiceAccountCredential(rawJson, 'FIREBASE_SERVICE_ACCOUNT_KEY');
    assert.ok(parsed2);
    assert.strictEqual(parsed2.type, 'service_account');
    assert.strictEqual(parsed2.project_id, 'test-raw-json-project');
  });

  // -------------------------------------------------------------------------
  // Test 24: parseServiceAccountCredential parses Base64-encoded JSON (including ewog...)
  // -------------------------------------------------------------------------
  await test('parseServiceAccountCredential parses Base64-encoded JSON beginning with ewog', async () => {
    // Formatted JSON with newline and spaces encodes to Base64 starting with ewog...
    const formattedJson = '{\n  "type": "service_account",\n  "project_id": "test-b64-project",\n  "client_email": "sa@test-b64-project.iam.gserviceaccount.com"\n}';
    const b64String = Buffer.from(formattedJson, 'utf8').toString('base64');
    assert.ok(b64String.startsWith('ewog'), `Expected Base64 string to begin with 'ewog', got: ${b64String.slice(0, 10)}`);

    const parsed1 = parseServiceAccountCredential(b64String, 'FIREBASE_SERVICE_ACCOUNT');
    assert.ok(parsed1);
    assert.strictEqual(parsed1.type, 'service_account');
    assert.strictEqual(parsed1.project_id, 'test-b64-project');

    const parsed2 = parseServiceAccountCredential(b64String, 'FIREBASE_SERVICE_ACCOUNT_KEY');
    assert.ok(parsed2);
    assert.strictEqual(parsed2.type, 'service_account');
    assert.strictEqual(parsed2.project_id, 'test-b64-project');
  });

  // -------------------------------------------------------------------------
  // Test 25: parseServiceAccountCredential rejects invalid Base64 and invalid JSON
  // -------------------------------------------------------------------------
  await test('parseServiceAccountCredential rejects invalid Base64 and invalid JSON with descriptive error', async () => {
    // Invalid JSON that is also invalid Base64
    let thrown1 = null;
    try {
      parseServiceAccountCredential('{ this_is: broken_json, not_base64: ', 'FIREBASE_SERVICE_ACCOUNT');
    } catch (err) {
      thrown1 = err;
    }
    assert.ok(thrown1);
    assert.ok(thrown1.message.includes('FIREBASE_SERVICE_ACCOUNT contains invalid JSON'));

    // Valid Base64 that decodes to invalid JSON
    let thrown2 = null;
    try {
      const b64BrokenJson = Buffer.from('{ broken_json_payload: ', 'utf8').toString('base64');
      parseServiceAccountCredential(b64BrokenJson, 'FIREBASE_SERVICE_ACCOUNT_KEY');
    } catch (err) {
      thrown2 = err;
    }
    assert.ok(thrown2);
    assert.ok(thrown2.message.includes('FIREBASE_SERVICE_ACCOUNT_KEY contains invalid JSON'));
  });

  // -------------------------------------------------------------------------
  // Test 26: parseServiceAccountCredential rejects non-service-account objects
  // -------------------------------------------------------------------------
  await test('parseServiceAccountCredential rejects non-service-account objects and primitives', async () => {
    // 1. Primitive string encoded in Base64
    let thrownPrim = null;
    try {
      const b64Prim = Buffer.from('"just_a_string"', 'utf8').toString('base64');
      parseServiceAccountCredential(b64Prim, 'FIREBASE_SERVICE_ACCOUNT');
    } catch (err) {
      thrownPrim = err;
    }
    assert.ok(thrownPrim);
    assert.ok(thrownPrim.message.includes('FIREBASE_SERVICE_ACCOUNT contains invalid JSON'));

    // 2. Array encoded in Base64
    let thrownArr = null;
    try {
      const b64Arr = Buffer.from('["not", "a", "service", "account"]', 'utf8').toString('base64');
      parseServiceAccountCredential(b64Arr, 'FIREBASE_SERVICE_ACCOUNT_KEY');
    } catch (err) {
      thrownArr = err;
    }
    assert.ok(thrownArr);
    assert.ok(thrownArr.message.includes('FIREBASE_SERVICE_ACCOUNT_KEY contains invalid JSON'));

    // 3. Object without service_account type or project_id
    let thrownObj = null;
    try {
      const b64Obj = Buffer.from('{"random_field": "random_value"}', 'utf8').toString('base64');
      parseServiceAccountCredential(b64Obj, 'FIREBASE_SERVICE_ACCOUNT');
    } catch (err) {
      thrownObj = err;
    }
    assert.ok(thrownObj);
    assert.ok(thrownObj.message.includes('FIREBASE_SERVICE_ACCOUNT contains invalid JSON'));
  });

  // -------------------------------------------------------------------------
  // Test 27: Production fails closed when Base64 FIREBASE_SERVICE_ACCOUNT_KEY contains invalid JSON
  // -------------------------------------------------------------------------
  await test('Production fails closed when Base64 FIREBASE_SERVICE_ACCOUNT_KEY contains invalid JSON', async () => {
    setForceProductionModeForTesting(true);
    const origSa = process.env.FIREBASE_SERVICE_ACCOUNT;
    const origSaKey = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    delete process.env.FIREBASE_SERVICE_ACCOUNT;
    process.env.FIREBASE_SERVICE_ACCOUNT_KEY = Buffer.from('{ broken_json_inside: ', 'utf8').toString('base64');

    let thrownError = null;
    try {
      getFirestoreDb();
    } catch (err) {
      thrownError = err;
    } finally {
      if (origSa) process.env.FIREBASE_SERVICE_ACCOUNT = origSa;
      else delete process.env.FIREBASE_SERVICE_ACCOUNT;
      if (origSaKey) process.env.FIREBASE_SERVICE_ACCOUNT_KEY = origSaKey;
      else delete process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
      setForceProductionModeForTesting(null);
    }

    assert.ok(thrownError, 'Must throw fatal error for invalid Base64 service account JSON');
    assert.ok(
      thrownError.message.includes('FIREBASE_SERVICE_ACCOUNT_KEY contains invalid JSON') ||
        thrownError.message.includes('Failed to initialize Firebase Admin Firestore'),
      `Expected invalid JSON error, got: ${thrownError.message}`
    );
  });

  // Clean up
  resetFirebaseAuthForTesting();
  testServer.closeAllConnections?.();
  testServer.close();

  console.log('\n======================================================================');
  console.log(`Test Execution Complete: ${passedTests} of ${totalTests} Cases Passed (${failedTests} Failed)`);
  console.log('======================================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runAllTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
