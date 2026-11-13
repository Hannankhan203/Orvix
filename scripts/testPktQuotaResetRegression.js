/**
 * scripts/testPktQuotaResetRegression.js
 *
 * Focused regression suite for Asia/Karachi (PKT) Daily Attachment Quota Reset:
 * 1. Exact 23:59:59.999 PKT vs 00:00:00.000 PKT boundary (plus month/year boundaries).
 * 2. No reset at midnight UTC (00:00:00 UTC == 05:00:00 PKT).
 * 3. Identical results under TZ=UTC, TZ=America/New_York, TZ=Europe/London, and TZ=Asia/Karachi.
 * 4. Concurrent uploads preserving the 5-upload limit.
 * 5. Upload reservation before midnight PKT and completion/cancellation after midnight PKT
 *    across standard and direct-upload HTTP routes (/direct/complete and /direct/cancel).
 * 6. Frontend quota indicator rollover and stale-response protection across midnight PKT.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import express from 'express';

process.env.TESTING = '1';
process.env.FIREBASE_PROJECT_ID = 'orvix-pkt-quota-test';

const TEST_PROJECT_ID = 'orvix-pkt-quota-test';
const TEST_KID = 'pkt-test-kid-001';

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
  RESERVATION_TTL_MS,
  buildAuthenticatedQuotaIdentity,
  createServerIssuedGuestToken,
  getUtcDayString,
  getNextUtcMidnight,
  getFirestoreDb,
  createSimulatedFirestoreInstance,
  setFirestoreForTesting,
  resetFirestoreForTesting,
  getQuotaStatus,
  reserveUploadSlot,
  commitUploadSlot,
  releaseUploadSlot,
  resetQuotaForTesting,
  setCustomDateHookForTesting
} = await import('../server/uploadQuotaService.ts');

const {
  getClientUtcDayString,
  getClientNextUtcMidnightIso,
  getUploadQuotaState,
  subscribeUploadQuotaState,
  syncUploadQuotaUserAccount,
  updateUploadQuotaFromResponse,
  fetchAuthenticatedUploadQuota,
  checkUploadQuotaUtcRollover,
  formatDailyUploadQuotaText,
  setClientQuotaDateHookForTesting,
  setClientQuotaFetchForTesting,
  resetUploadQuotaClientStateForTesting
} = await import('../src/services/uploadQuotaClientService.js');

const { setAuthInstanceForTesting } = await import('../src/services/authService.js');
const { uploadFileDirectToSupabase } = await import('../src/services/attachmentStorageService.js');

function createSignedJwt(uid) {
  const nowSec = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT', kid: TEST_KID };
  const payload = {
    iss: `https://securetoken.google.com/${TEST_PROJECT_ID}`,
    aud: TEST_PROJECT_ID,
    auth_time: nowSec - 10,
    user_id: uid,
    sub: uid,
    iat: nowSec - 10,
    exp: nowSec + 3600
  };
  const h = Buffer.from(JSON.stringify(header)).toString('base64url');
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), privateKey).toString('base64url');
  return `${h}.${p}.${sig}`;
}

function createMockSupabaseStorageClient() {
  const objects = new Map();
  const mockClient = {
    _objects: objects,
    _failCreateSignedUploadUrl: false,
    storage: {
      from(bucket) {
        return {
          async createSignedUploadUrl(storagePath) {
            if (mockClient._failCreateSignedUploadUrl) {
              return {
                data: null,
                error: { message: 'Simulated Supabase signed URL outage', status: 503 }
              };
            }
            const token = 'mock_pkt_token_' + crypto.randomUUID();
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
  return mockClient;
}

async function sendMultipartUpload(baseUrl, { token, conversationId = 'conv_pkt', filename = 'doc.txt' }) {
  const boundary = '----OrvixPktBoundary' + crypto.randomBytes(8).toString('hex');
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="conversationId"\r\n\r\n${conversationId}\r\n`
    ),
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${filename}"\r\nContent-Type: text/plain\r\n\r\n`
    ),
    Buffer.from('Verified PKT upload content'),
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);

  return fetch(`${baseUrl}/api/upload`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(body.length)
    },
    body
  });
}

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL: ${name}`);
    console.error(`    ${err.stack || err.message}`);
    failed++;
  }
}

console.log('================================================================');
console.log('ORVIX PKT (Asia/Karachi) QUOTA RESET REGRESSION SUITE');
console.log('================================================================\n');

let server;
let baseUrl = '';
let mockStorage;

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
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  // 1. 23:59:59.999 PKT vs 00:00:00.000 PKT
  await test('1. Exact 23:59:59.999 PKT vs 00:00:00.000 PKT boundary (plus year rollover)', async () => {
    const beforeMidnightPkt = new Date('2026-11-09T18:59:59.999Z'); // 2026-11-09 23:59:59.999 PKT
    const atMidnightPkt = new Date('2026-11-09T19:00:00.000Z');     // 2026-11-10 00:00:00.000 PKT

    assert.strictEqual(getUtcDayString(beforeMidnightPkt), '2026-11-09');
    assert.strictEqual(getNextUtcMidnight(beforeMidnightPkt).toISOString(), '2026-11-09T19:00:00.000Z');
    assert.strictEqual(getClientUtcDayString(beforeMidnightPkt), '2026-11-09');
    assert.strictEqual(getClientNextUtcMidnightIso(beforeMidnightPkt), '2026-11-09T19:00:00.000Z');

    assert.strictEqual(getUtcDayString(atMidnightPkt), '2026-11-10');
    assert.strictEqual(getNextUtcMidnight(atMidnightPkt).toISOString(), '2026-11-10T19:00:00.000Z');
    assert.strictEqual(getClientUtcDayString(atMidnightPkt), '2026-11-10');
    assert.strictEqual(getClientNextUtcMidnightIso(atMidnightPkt), '2026-11-10T19:00:00.000Z');

    // Year-end boundary in PKT
    const dec31LatePkt = new Date('2026-12-31T18:59:59.999Z'); // 2026-12-31 23:59:59.999 PKT
    const jan01StartPkt = new Date('2026-12-31T19:00:00.000Z'); // 2027-01-01 00:00:00.000 PKT
    assert.strictEqual(getUtcDayString(dec31LatePkt), '2026-12-31');
    assert.strictEqual(getNextUtcMidnight(dec31LatePkt).toISOString(), '2026-12-31T19:00:00.000Z');
    assert.strictEqual(getUtcDayString(jan01StartPkt), '2027-01-01');
    assert.strictEqual(getNextUtcMidnight(jan01StartPkt).toISOString(), '2027-01-01T19:00:00.000Z');

    // End-to-end HTTP check at 23:59:59.999 PKT -> blocked on 6th; at 00:00:00.000 PKT -> reset to 5
    const uid = 'pkt_boundary_' + crypto.randomUUID();
    const token = createSignedJwt(uid);
    setCustomDateHookForTesting(() => beforeMidnightPkt);

    for (let i = 1; i <= 5; i++) {
      const r = await sendMultipartUpload(baseUrl, { token, filename: `b_${i}.txt` });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.headers.get('x-ratelimit-reset-utc'), '2026-11-09T19:00:00.000Z');
    }
    const r6 = await sendMultipartUpload(baseUrl, { token, filename: 'b_6.txt' });
    assert.strictEqual(r6.status, 429);
    const j6 = await r6.json();
    assert.ok(j6.error.includes('midnight PKT'));

    setCustomDateHookForTesting(() => atMidnightPkt);
    const qRes = await fetch(`${baseUrl}/api/upload/quota`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.strictEqual(qRes.status, 200);
    assert.strictEqual(qRes.headers.get('x-ratelimit-remaining'), '5');
    assert.strictEqual(qRes.headers.get('x-ratelimit-reset-utc'), '2026-11-10T19:00:00.000Z');
    const qJson = await qRes.json();
    assert.strictEqual(qJson.utcDay, '2026-11-10');
    assert.strictEqual(qJson.remaining, 5);
    assert.strictEqual(qJson.resetAt, '2026-11-10T19:00:00.000Z');
  });

  // 2. No reset at midnight UTC
  await test('2. No reset at midnight UTC (00:00:00 UTC is 05:00:00 PKT)', async () => {
    const uid = 'pkt_no_utc_reset_' + crypto.randomUUID();
    const token = createSignedJwt(uid);
    const beforeUtcMidnight = new Date('2026-11-09T23:59:59.999Z'); // 2026-11-10 04:59:59.999 PKT
    const atUtcMidnight = new Date('2026-11-10T00:00:00.000Z');     // 2026-11-10 05:00:00.000 PKT

    assert.strictEqual(getUtcDayString(beforeUtcMidnight), '2026-11-10');
    assert.strictEqual(getUtcDayString(atUtcMidnight), '2026-11-10');
    assert.strictEqual(getNextUtcMidnight(beforeUtcMidnight).toISOString(), '2026-11-10T19:00:00.000Z');
    assert.strictEqual(getNextUtcMidnight(atUtcMidnight).toISOString(), '2026-11-10T19:00:00.000Z');

    setCustomDateHookForTesting(() => beforeUtcMidnight);
    for (let i = 1; i <= 5; i++) {
      const r = await sendMultipartUpload(baseUrl, { token, filename: `u_${i}.txt` });
      assert.strictEqual(r.status, 200);
    }

    setCustomDateHookForTesting(() => atUtcMidnight);
    const blocked = await sendMultipartUpload(baseUrl, { token, filename: 'u_6.txt' });
    assert.strictEqual(blocked.status, 429, 'Must remain rate-limited at midnight UTC');
    assert.strictEqual(blocked.headers.get('x-ratelimit-remaining'), '0');
    assert.strictEqual(blocked.headers.get('x-ratelimit-reset-utc'), '2026-11-10T19:00:00.000Z');
  });

  // 3. Identical results under UTC, America/New_York, Europe/London, and Asia/Karachi
  await test('3. Identical results under UTC, America/New_York, Europe/London, and Asia/Karachi TZ settings', async () => {
    const timezones = ['UTC', 'America/New_York', 'Europe/London', 'Asia/Karachi'];
    const probeScript = `
      process.env.TESTING = '1';
      import { getUtcDayString, getNextUtcMidnight } from './server/uploadQuotaService.ts';
      import { getClientUtcDayString, getClientNextUtcMidnightIso } from './src/services/uploadQuotaClientService.js';
      const samples = [
        '2026-11-09T18:59:59.999Z',
        '2026-11-09T19:00:00.000Z',
        '2026-11-10T00:00:00.000Z',
        '2026-07-15T18:59:59.999Z',
        '2026-07-15T19:00:00.000Z'
      ];
      const out = samples.map((iso) => {
        const d = new Date(iso);
        return {
          iso,
          serverDay: getUtcDayString(d),
          serverReset: getNextUtcMidnight(d).toISOString(),
          clientDay: getClientUtcDayString(d),
          clientReset: getClientNextUtcMidnightIso(d)
        };
      });
      console.log(JSON.stringify(out));
    `;

    const resultsByTz = {};
    for (const tz of timezones) {
      const run = spawnSync(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', probeScript],
        {
          cwd: process.cwd(),
          env: { ...process.env, TZ: tz },
          encoding: 'utf8'
        }
      );
      assert.strictEqual(run.status, 0, `Subprocess failed for TZ=${tz}: ${run.stderr}`);
      resultsByTz[tz] = JSON.parse(run.stdout.trim());
    }

    const baseline = resultsByTz['UTC'];
    assert.deepStrictEqual(
      baseline.map((x) => [x.serverDay, x.serverReset]),
      [
        ['2026-11-09', '2026-11-09T19:00:00.000Z'],
        ['2026-11-10', '2026-11-10T19:00:00.000Z'],
        ['2026-11-10', '2026-11-10T19:00:00.000Z'],
        ['2026-07-15', '2026-07-15T19:00:00.000Z'],
        ['2026-07-16', '2026-07-16T19:00:00.000Z']
      ]
    );
    for (const tz of timezones) {
      assert.deepStrictEqual(
        resultsByTz[tz],
        baseline,
        `TZ=${tz} output must match TZ=UTC identically`
      );
      for (const row of resultsByTz[tz]) {
        assert.strictEqual(row.clientDay, row.serverDay);
        assert.strictEqual(row.clientReset, row.serverReset);
      }
    }
  });

  // 4. Concurrent uploads preserve 5-upload limit
  await test('4. Concurrent uploads preserve the 5-upload limit on the active PKT day', async () => {
    const uid = 'pkt_concurrent_' + crypto.randomUUID();
    const token = createSignedJwt(uid);
    // Test right after PKT midnight (19:00:01Z) when UTC date is still the previous calendar day!
    setCustomDateHookForTesting(() => new Date('2026-11-09T19:00:01.000Z'));

    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, idx) =>
        sendMultipartUpload(baseUrl, { token, filename: `conc_${idx}.txt` })
      )
    );

    const okCount = responses.filter((r) => r.status === 200).length;
    const limitedCount = responses.filter((r) => r.status === 429).length;
    assert.strictEqual(okCount, 5, `Expected 5 succeeded concurrent uploads, got ${okCount}`);
    assert.strictEqual(limitedCount, 5, `Expected 5 rate-limited concurrent uploads, got ${limitedCount}`);

    for (const r of responses) {
      assert.strictEqual(r.headers.get('x-ratelimit-reset-utc'), '2026-11-10T19:00:00.000Z');
    }
  });

  // 5. Upload reservation before midnight PKT and completion / cancellation after midnight PKT (HTTP direct upload + service)
  await test('5. Direct upload reserved before midnight PKT and completed/cancelled after midnight PKT keeps Day 1 accounting and returns Day 2 quota status', async () => {
    const uid = 'pkt_direct_cross_' + crypto.randomUUID();
    const token = createSignedJwt(uid);
    const identity = buildAuthenticatedQuotaIdentity(uid);

    // Day 1 PKT: 2026-11-09 23:59:50 PKT == 2026-11-09T18:59:50.000Z
    setCustomDateHookForTesting(() => new Date('2026-11-09T18:59:50.000Z'));

    // Consume 3 slots first on Day 1
    for (let i = 1; i <= 3; i++) {
      const r = await sendMultipartUpload(baseUrl, { token, filename: `pre_${i}.txt` });
      assert.strictEqual(r.status, 200);
    }

    // Reserve slot 4 (will be COMPLETED after midnight PKT)
    const signCompleteRes = await fetch(`${baseUrl}/api/upload/direct/signed-url`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        chatId: 'conv_cross',
        fileName: 'cross_complete.txt',
        fileSize: 64,
        mimeType: 'text/plain'
      })
    });
    assert.strictEqual(signCompleteRes.status, 200);
    assert.strictEqual(signCompleteRes.headers.get('x-ratelimit-remaining'), '1');
    const signCompleteData = await signCompleteRes.json();
    mockStorage._objects.set(signCompleteData.storagePath, {
      buffer: Buffer.from('Cross-midnight PKT direct upload payload'),
      contentType: 'text/plain'
    });

    // Reserve slot 5 (will be CANCELLED after midnight PKT)
    const signCancelRes = await fetch(`${baseUrl}/api/upload/direct/signed-url`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        chatId: 'conv_cross',
        fileName: 'cross_cancel.txt',
        fileSize: 64,
        mimeType: 'text/plain'
      })
    });
    assert.strictEqual(signCancelRes.status, 200);
    assert.strictEqual(signCancelRes.headers.get('x-ratelimit-remaining'), '0');
    const signCancelData = await signCancelRes.json();

    // Advance clock past midnight PKT -> 2026-11-10 00:00:10 PKT == 2026-11-09T19:00:10.000Z
    setCustomDateHookForTesting(() => new Date('2026-11-09T19:00:10.000Z'));

    // Complete slot 4 after midnight PKT
    const completeRes = await fetch(`${baseUrl}/api/upload/direct/complete`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        chatId: 'conv_cross',
        attachmentId: signCompleteData.attachmentId
      })
    });
    assert.strictEqual(completeRes.status, 200);
    assert.strictEqual(
      completeRes.headers.get('x-ratelimit-remaining'),
      '5',
      'Completion after midnight PKT must return Day 2 remaining count (5)'
    );
    assert.strictEqual(
      completeRes.headers.get('x-ratelimit-reset-utc'),
      '2026-11-10T19:00:00.000Z',
      'Completion after midnight PKT must return Day 2 reset timestamp'
    );
    const completeJson = await completeRes.json();
    assert.strictEqual(completeJson.quota.remaining, 5);
    assert.strictEqual(completeJson.quota.utcDay, '2026-11-10');

    // Cancel slot 5 after midnight PKT
    const cancelRes = await fetch(`${baseUrl}/api/upload/direct/cancel`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        attachmentId: signCancelData.attachmentId
      })
    });
    assert.strictEqual(cancelRes.status, 200);
    assert.strictEqual(
      cancelRes.headers.get('x-ratelimit-remaining'),
      '5',
      'Cancellation after midnight PKT must return Day 2 remaining count (5)'
    );
    assert.strictEqual(
      cancelRes.headers.get('x-ratelimit-reset-utc'),
      '2026-11-10T19:00:00.000Z',
      'Cancellation after midnight PKT must return Day 2 reset timestamp'
    );
    const cancelJson = await cancelRes.json();
    assert.strictEqual(cancelJson.cancelled, true);
    assert.strictEqual(cancelJson.remaining, 5);
    assert.strictEqual(cancelJson.utcDay, '2026-11-10');
    assert.strictEqual(cancelJson.resetAt, '2026-11-10T19:00:00.000Z');

    // Verify Firestore Day 1 record has committed: 4 and 0 reservations, while Day 2 is untouched (remaining: 5)
    const db = getFirestoreDb();
    const day1Snap = await db.collection('uploadQuotas').doc(`${identity.key}_2026-11-09`).get();
    assert.strictEqual(day1Snap.data().committed, 4);
    assert.strictEqual(Object.keys(day1Snap.data().reservations || {}).length, 0);

    const day2Status = await getQuotaStatus(identity);
    assert.strictEqual(day2Status.committed, 0);
    assert.strictEqual(day2Status.remaining, DAILY_UPLOAD_LIMIT);
    assert.strictEqual(day2Status.utcDay, '2026-11-10');
  });

  // 6. Frontend quota indicator rollover and stale-response protection
  await test('6. Frontend quota indicator rolls over at 00:00 PKT and rejects late previous-PKT-day fetch/response overwrites', async () => {
    resetUploadQuotaClientStateForTesting();
    const uid = 'pkt_client_stale_' + crypto.randomUUID();
    let activeNow = new Date('2026-11-09T18:59:58.000Z'); // 23:59:58 PKT
    setClientQuotaDateHookForTesting(() => activeNow);

    syncUploadQuotaUserAccount(uid, { autoFetch: false });

    // Apply Day 1 snapshot: 1 remaining, resets at 2026-11-09T19:00:00.000Z
    updateUploadQuotaFromResponse(
      new Headers({
        'X-RateLimit-Limit': '5',
        'X-RateLimit-Remaining': '1',
        'X-RateLimit-Reset-UTC': '2026-11-09T19:00:00.000Z'
      }),
      uid
    );
    assert.strictEqual(formatDailyUploadQuotaText(getUploadQuotaState()), '1 of 5 uploads remaining today');

    // Start an in-flight GET /api/upload/quota BEFORE midnight PKT, advance clock past midnight during flight,
    // and return a stale Day 1 response (remaining: 1, resetAt: 2026-11-09T19:00:00.000Z)
    setClientQuotaFetchForTesting(async () => {
      activeNow = new Date('2026-11-09T19:00:02.000Z'); // Clock crosses 00:00:02 PKT while in flight
      return {
        ok: true,
        status: 200,
        headers: new Headers({
          'X-RateLimit-Limit': '5',
          'X-RateLimit-Remaining': '1',
          'X-RateLimit-Reset-UTC': '2026-11-09T19:00:00.000Z'
        })
      };
    });

    const afterInFlight = await fetchAuthenticatedUploadQuota({
      userId: uid,
      getTokenFn: async () => 'mock-jwt'
    });
    assert.strictEqual(afterInFlight.remaining, 5, 'In-flight Day 1 fetch must roll over to 5 instead of applying stale 1');
    assert.strictEqual(afterInFlight.utcDay, '2026-11-10');
    assert.strictEqual(formatDailyUploadQuotaText(afterInFlight), '5 of 5 uploads remaining today');

    // Now simulate Day 2 upload succeeded (remaining: 4), followed by a late Day 1 upload response (remaining: 0)
    updateUploadQuotaFromResponse(
      new Headers({
        'X-RateLimit-Limit': '5',
        'X-RateLimit-Remaining': '4',
        'X-RateLimit-Reset-UTC': '2026-11-10T19:00:00.000Z'
      }),
      uid
    );
    assert.strictEqual(getUploadQuotaState().remaining, 4);

    const afterLateDay1 = updateUploadQuotaFromResponse(
      new Headers({
        'X-RateLimit-Limit': '5',
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset-UTC': '2026-11-09T19:00:00.000Z'
      }),
      uid
    );
    assert.strictEqual(afterLateDay1.remaining, 4, 'Late Day 1 response must NOT overwrite active Day 2 count (4)');
    assert.strictEqual(afterLateDay1.utcDay, '2026-11-10');
    assert.strictEqual(formatDailyUploadQuotaText(afterLateDay1), '4 of 5 uploads remaining today');
  });

  // 7. Month-end, non-leap Feb, and leap-year PKT midnight transitions (server + client + HTTP)
  await test('7. Month-end, non-leap Feb 28->Mar 1, and leap-year Feb 28->29->Mar 1 PKT transitions with millisecond accuracy', async () => {
    const transitions = [
      // Month transitions (31-day & 30-day)
      {
        label: 'Jan 31 -> Feb 1',
        beforeIso: '2026-01-31T18:59:59.999Z',
        atIso: '2026-01-31T19:00:00.000Z',
        beforeDay: '2026-01-31',
        beforeResetIso: '2026-01-31T19:00:00.000Z',
        afterDay: '2026-02-01',
        afterResetIso: '2026-02-01T19:00:00.000Z'
      },
      {
        label: 'Apr 30 -> May 1',
        beforeIso: '2026-04-30T18:59:59.999Z',
        atIso: '2026-04-30T19:00:00.000Z',
        beforeDay: '2026-04-30',
        beforeResetIso: '2026-04-30T19:00:00.000Z',
        afterDay: '2026-05-01',
        afterResetIso: '2026-05-01T19:00:00.000Z'
      },
      // Non-leap year Feb 28 -> Mar 1
      {
        label: 'Non-leap 2026 Feb 28 -> Mar 1',
        beforeIso: '2026-02-28T18:59:59.999Z',
        atIso: '2026-02-28T19:00:00.000Z',
        beforeDay: '2026-02-28',
        beforeResetIso: '2026-02-28T19:00:00.000Z',
        afterDay: '2026-03-01',
        afterResetIso: '2026-03-01T19:00:00.000Z'
      },
      // Leap year 2024: Feb 28 -> Feb 29 -> Mar 1
      {
        label: 'Leap 2024 Feb 28 -> Feb 29',
        beforeIso: '2024-02-28T18:59:59.999Z',
        atIso: '2024-02-28T19:00:00.000Z',
        beforeDay: '2024-02-28',
        beforeResetIso: '2024-02-28T19:00:00.000Z',
        afterDay: '2024-02-29',
        afterResetIso: '2024-02-29T19:00:00.000Z'
      },
      {
        label: 'Leap 2024 Feb 29 -> Mar 1',
        beforeIso: '2024-02-29T18:59:59.999Z',
        atIso: '2024-02-29T19:00:00.000Z',
        beforeDay: '2024-02-29',
        beforeResetIso: '2024-02-29T19:00:00.000Z',
        afterDay: '2024-03-01',
        afterResetIso: '2024-03-01T19:00:00.000Z'
      },
      // Leap year 2028: Feb 28 -> Feb 29 -> Mar 1
      {
        label: 'Leap 2028 Feb 28 -> Feb 29',
        beforeIso: '2028-02-28T18:59:59.999Z',
        atIso: '2028-02-28T19:00:00.000Z',
        beforeDay: '2028-02-28',
        beforeResetIso: '2028-02-28T19:00:00.000Z',
        afterDay: '2028-02-29',
        afterResetIso: '2028-02-29T19:00:00.000Z'
      },
      {
        label: 'Leap 2028 Feb 29 -> Mar 1',
        beforeIso: '2028-02-29T18:59:59.999Z',
        atIso: '2028-02-29T19:00:00.000Z',
        beforeDay: '2028-02-29',
        beforeResetIso: '2028-02-29T19:00:00.000Z',
        afterDay: '2028-03-01',
        afterResetIso: '2028-03-01T19:00:00.000Z'
      },
      // Year transition
      {
        label: 'Year-end 2026-12-31 -> 2027-01-01',
        beforeIso: '2026-12-31T18:59:59.999Z',
        atIso: '2026-12-31T19:00:00.000Z',
        beforeDay: '2026-12-31',
        beforeResetIso: '2026-12-31T19:00:00.000Z',
        afterDay: '2027-01-01',
        afterResetIso: '2027-01-01T19:00:00.000Z'
      }
    ];

    for (const tc of transitions) {
      const beforeDate = new Date(tc.beforeIso);
      const atDate = new Date(tc.atIso);

      assert.strictEqual(getUtcDayString(beforeDate), tc.beforeDay, `${tc.label}: server beforeDay`);
      assert.strictEqual(getNextUtcMidnight(beforeDate).toISOString(), tc.beforeResetIso, `${tc.label}: server beforeReset`);
      assert.strictEqual(getClientUtcDayString(beforeDate), tc.beforeDay, `${tc.label}: client beforeDay`);
      assert.strictEqual(getClientNextUtcMidnightIso(beforeDate), tc.beforeResetIso, `${tc.label}: client beforeReset`);

      assert.strictEqual(getUtcDayString(atDate), tc.afterDay, `${tc.label}: server afterDay`);
      assert.strictEqual(getNextUtcMidnight(atDate).toISOString(), tc.afterResetIso, `${tc.label}: server afterReset`);
      assert.strictEqual(getClientUtcDayString(atDate), tc.afterDay, `${tc.label}: client afterDay`);
      assert.strictEqual(getClientNextUtcMidnightIso(atDate), tc.afterResetIso, `${tc.label}: client afterReset`);

      // Full HTTP + client rollover behavioral check at the exact boundary
      resetUploadQuotaClientStateForTesting();
      const uid = `pkt_cal_${tc.afterDay}_${crypto.randomUUID()}`;
      const token = createSignedJwt(uid);
      let activeClock = beforeDate;
      setCustomDateHookForTesting(() => activeClock);
      setClientQuotaDateHookForTesting(() => activeClock);
      syncUploadQuotaUserAccount(uid, { autoFetch: false });

      for (let i = 1; i <= 5; i++) {
        const res = await sendMultipartUpload(baseUrl, { token, filename: `cal_${i}.txt` });
        assert.strictEqual(res.status, 200, `${tc.label}: upload ${i} before midnight`);
        assert.strictEqual(res.headers.get('x-ratelimit-reset-utc'), tc.beforeResetIso);
        updateUploadQuotaFromResponse(res, uid);
      }

      const res6 = await sendMultipartUpload(baseUrl, { token, filename: 'cal_6.txt' });
      assert.strictEqual(res6.status, 429, `${tc.label}: 6th upload at .999ms must return 429`);
      updateUploadQuotaFromResponse(res6, uid);
      assert.strictEqual(getUploadQuotaState().remaining, 0);
      assert.strictEqual(getUploadQuotaState().utcDay, tc.beforeDay);

      // Still at .999ms before midnight PKT -> client rollover must NOT fire
      assert.strictEqual(checkUploadQuotaUtcRollover({ triggerRefresh: false }), false, `${tc.label}: client must NOT roll at .999ms`);

      // Advance 1 millisecond to 00:00:00.000 PKT -> both client and server reset to 5
      activeClock = atDate;
      assert.strictEqual(checkUploadQuotaUtcRollover({ triggerRefresh: false }), true, `${tc.label}: client MUST roll at .000ms`);
      assert.strictEqual(getUploadQuotaState().remaining, 5);
      assert.strictEqual(getUploadQuotaState().utcDay, tc.afterDay);
      assert.strictEqual(getUploadQuotaState().resetAt, tc.afterResetIso);

      const qRes = await fetch(`${baseUrl}/api/upload/quota`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      assert.strictEqual(qRes.status, 200);
      assert.strictEqual(qRes.headers.get('x-ratelimit-remaining'), '5');
      assert.strictEqual(qRes.headers.get('x-ratelimit-reset-utc'), tc.afterResetIso);
      const qJson = await qRes.json();
      assert.strictEqual(qJson.utcDay, tc.afterDay);
      assert.strictEqual(qJson.remaining, 5);
    }
  });

  // 8. No reset at browser-local midnight & identical end-to-end results across different server timezones
  await test('8. No reset at browser-local midnight and identical behavioral quota results across 6 TZ environments', async () => {
    const tzCases = [
      // Each non-PKT TZ tests its own browser/server local midnight boundary (not PKT midnight)
      { tz: 'UTC', localBeforeMidnightIso: '2026-06-14T23:59:59.999Z', localMidnightIso: '2026-06-15T00:00:00.000Z', expectedPktDayAtLocalMidnight: '2026-06-15', expectedPktResetIso: '2026-06-15T19:00:00.000Z' },
      { tz: 'America/New_York', localBeforeMidnightIso: '2026-06-15T03:59:59.999Z', localMidnightIso: '2026-06-15T04:00:00.000Z', expectedPktDayAtLocalMidnight: '2026-06-15', expectedPktResetIso: '2026-06-15T19:00:00.000Z' }, // EDT UTC-4: 00:00 NY = 09:00 PKT
      { tz: 'America/Los_Angeles', localBeforeMidnightIso: '2026-06-15T06:59:59.999Z', localMidnightIso: '2026-06-15T07:00:00.000Z', expectedPktDayAtLocalMidnight: '2026-06-15', expectedPktResetIso: '2026-06-15T19:00:00.000Z' }, // PDT UTC-7: 00:00 LA = 12:00 PKT
      { tz: 'Europe/London', localBeforeMidnightIso: '2026-06-14T22:59:59.999Z', localMidnightIso: '2026-06-14T23:00:00.000Z', expectedPktDayAtLocalMidnight: '2026-06-15', expectedPktResetIso: '2026-06-15T19:00:00.000Z' }, // BST UTC+1: 00:00 LDN = 04:00 PKT
      { tz: 'Asia/Tokyo', localBeforeMidnightIso: '2026-06-15T14:59:59.999Z', localMidnightIso: '2026-06-15T15:00:00.000Z', expectedPktDayAtLocalMidnight: '2026-06-15', expectedPktResetIso: '2026-06-15T19:00:00.000Z' }, // JST UTC+9: 00:00 TYO = 20:00 PKT
      { tz: 'Asia/Karachi', localBeforeMidnightIso: null, localMidnightIso: null, expectedPktDayAtLocalMidnight: '2026-06-15', expectedPktResetIso: '2026-06-15T19:00:00.000Z' }
    ];

    const tzBehavioralProbe = `
      process.env.TESTING = '1';
      import {
        getUtcDayString,
        getNextUtcMidnight,
        reserveUploadSlot,
        commitUploadSlot,
        getQuotaStatus,
        resetQuotaForTesting,
        setCustomDateHookForTesting
      } from './server/uploadQuotaService.ts';
      import {
        getClientUtcDayString,
        getClientNextUtcMidnightIso,
        syncUploadQuotaUserAccount,
        updateUploadQuotaFromResponse,
        checkUploadQuotaUtcRollover,
        getUploadQuotaState,
        setClientQuotaDateHookForTesting,
        resetUploadQuotaClientStateForTesting
      } from './src/services/uploadQuotaClientService.js';

      await resetQuotaForTesting();
      resetUploadQuotaClientStateForTesting();

      // 1. Verify calendar edge dates (leap year, month end, year end, UTC midnight)
      const samples = [
        '2024-02-28T18:59:59.999Z',
        '2024-02-28T19:00:00.000Z',
        '2024-02-29T18:59:59.999Z',
        '2024-02-29T19:00:00.000Z',
        '2026-02-28T18:59:59.999Z',
        '2026-02-28T19:00:00.000Z',
        '2026-06-15T00:00:00.000Z',
        '2026-12-31T18:59:59.999Z',
        '2026-12-31T19:00:00.000Z'
      ].map((iso) => {
        const d = new Date(iso);
        return {
          iso,
          serverDay: getUtcDayString(d),
          serverReset: getNextUtcMidnight(d).toISOString(),
          clientDay: getClientUtcDayString(d),
          clientReset: getClientNextUtcMidnightIso(d)
        };
      });

      // 2. Verify full server + client quota behavior across PKT day regardless of TZ
      const identity = { type: 'auth', id: 'tz_probe_uid', key: 'auth_tz_probe_fixed' };
      const uid = 'tz_probe_uid';
      let now = new Date('2026-06-14T19:00:00.000Z'); // 2026-06-15 00:00:00 PKT
      setCustomDateHookForTesting(() => now);
      setClientQuotaDateHookForTesting(() => now);
      syncUploadQuotaUserAccount(uid, { autoFetch: false });

      // Consume 5 slots on 2026-06-15 PKT
      for (let i = 0; i < 5; i++) {
        const r = await reserveUploadSlot(identity);
        if (!r.allowed) throw new Error('Expected reservation ' + i + ' to succeed');
        const c = await commitUploadSlot(r.reservation);
        updateUploadQuotaFromResponse({
          headers: new Headers({
            'X-RateLimit-Limit': String(c.limit),
            'X-RateLimit-Remaining': String(c.remaining),
            'X-RateLimit-Reset-UTC': c.resetAt
          })
        }, uid);
      }

      // Check local midnight (when supplied for non-PKT timezone): MUST NOT reset on server OR client
      let localMidnightCheck = null;
      const localBeforeIso = process.env.PROBE_LOCAL_BEFORE_ISO;
      const localMidIso = process.env.PROBE_LOCAL_MID_ISO;
      if (localBeforeIso && localMidIso) {
        now = new Date(localBeforeIso);
        const beforeReserve = await reserveUploadSlot(identity);
        const clientRolledBefore = checkUploadQuotaUtcRollover({ triggerRefresh: false });
        now = new Date(localMidIso);
        const atLocalMidStatus = await getQuotaStatus(identity);
        const atLocalMidReserve = await reserveUploadSlot(identity);
        const clientRolledAtLocalMid = checkUploadQuotaUtcRollover({ triggerRefresh: false });
        const clientStateAtLocalMid = getUploadQuotaState();
        localMidnightCheck = {
          beforeAllowed: beforeReserve.allowed,
          atLocalMidAllowed: atLocalMidReserve.allowed,
          atLocalMidRemaining: atLocalMidStatus.remaining,
          atLocalMidDay: atLocalMidStatus.utcDay,
          clientRolledBefore,
          clientRolledAtLocalMid,
          clientRemainingAtLocalMid: clientStateAtLocalMid.remaining
        };
      }

      // Check midnight UTC (2026-06-15T00:00:00.000Z is already tested inside same PKT day for TZs after it; test 2026-06-15T18:59:59.999Z -> 19:00:00.000Z)
      now = new Date('2026-06-15T18:59:59.999Z');
      const blockedBeforePkt = (await reserveUploadSlot(identity)).allowed;
      const clientRolledBeforePkt = checkUploadQuotaUtcRollover({ triggerRefresh: false });

      now = new Date('2026-06-15T19:00:00.000Z');
      const allowedAtPkt = (await reserveUploadSlot(identity)).allowed;
      const clientRolledAtPkt = checkUploadQuotaUtcRollover({ triggerRefresh: false });
      const clientStateAtPkt = getUploadQuotaState();

      console.log(JSON.stringify({
        samples,
        localMidnightCheck,
        pktBoundary: {
          blockedBeforePkt,
          clientRolledBeforePkt,
          allowedAtPkt,
          clientRolledAtPkt,
          clientDayAtPkt: clientStateAtPkt.utcDay,
          clientRemainingAtPkt: clientStateAtPkt.remaining,
          clientResetAtPkt: clientStateAtPkt.resetAt
        }
      }));
    `;

    let baselineSamples = null;
    let baselinePktBoundary = null;

    for (const tc of tzCases) {
      const env = { ...process.env, TZ: tc.tz };
      if (tc.localBeforeMidnightIso && tc.localMidnightIso) {
        env.PROBE_LOCAL_BEFORE_ISO = tc.localBeforeMidnightIso;
        env.PROBE_LOCAL_MID_ISO = tc.localMidnightIso;
      } else {
        delete env.PROBE_LOCAL_BEFORE_ISO;
        delete env.PROBE_LOCAL_MID_ISO;
      }

      const run = spawnSync(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', tzBehavioralProbe],
        { cwd: process.cwd(), env, encoding: 'utf8' }
      );
      assert.strictEqual(run.status, 0, `Subprocess failed for TZ=${tc.tz}: ${run.stderr}`);
      const parsed = JSON.parse(run.stdout.trim());

      if (!baselineSamples) {
        baselineSamples = parsed.samples;
        baselinePktBoundary = parsed.pktBoundary;
      } else {
        assert.deepStrictEqual(parsed.samples, baselineSamples, `TZ=${tc.tz} samples must match baseline`);
        assert.deepStrictEqual(parsed.pktBoundary, baselinePktBoundary, `TZ=${tc.tz} PKT rollover behavior must match baseline`);
      }

      assert.strictEqual(parsed.pktBoundary.blockedBeforePkt, false);
      assert.strictEqual(parsed.pktBoundary.clientRolledBeforePkt, false);
      assert.strictEqual(parsed.pktBoundary.allowedAtPkt, true);
      assert.strictEqual(parsed.pktBoundary.clientRolledAtPkt, true);
      assert.strictEqual(parsed.pktBoundary.clientDayAtPkt, '2026-06-16');
      assert.strictEqual(parsed.pktBoundary.clientRemainingAtPkt, 5);
      assert.strictEqual(parsed.pktBoundary.clientResetAtPkt, '2026-06-16T19:00:00.000Z');

      if (tc.localMidnightCheck !== null && parsed.localMidnightCheck) {
        assert.strictEqual(parsed.localMidnightCheck.beforeAllowed, false, `TZ=${tc.tz}: must be blocked before local midnight`);
        assert.strictEqual(parsed.localMidnightCheck.atLocalMidAllowed, false, `TZ=${tc.tz}: must NOT reset at browser-local midnight`);
        assert.strictEqual(parsed.localMidnightCheck.atLocalMidRemaining, 0, `TZ=${tc.tz}: remaining must stay 0 at browser-local midnight`);
        assert.strictEqual(parsed.localMidnightCheck.atLocalMidDay, tc.expectedPktDayAtLocalMidnight);
        assert.strictEqual(parsed.localMidnightCheck.clientRolledBefore, false);
        assert.strictEqual(parsed.localMidnightCheck.clientRolledAtLocalMid, false, `TZ=${tc.tz}: frontend indicator must NOT roll over at browser-local midnight`);
        assert.strictEqual(parsed.localMidnightCheck.clientRemainingAtLocalMid, 0);
      }
    }
  });

  // 9. Concurrent mixed-route reservations (/api/upload + /api/upload/direct/signed-url) and multi-instance Firestore contention
  await test('9. Concurrent mixed-route reservations and multi-instance Firestore transactions never exceed 5 per PKT day', async () => {
    const uid = 'pkt_mixed_conc_' + crypto.randomUUID();
    const token = createSignedJwt(uid);
    const identity = buildAuthenticatedQuotaIdentity(uid);
    // 2026-11-09T19:00:00.500Z => 2026-11-10 00:00:00.500 PKT
    setCustomDateHookForTesting(() => new Date('2026-11-09T19:00:00.500Z'));

    // Fire 6 multipart uploads + 6 direct signed-url reservations simultaneously (12 total)
    const mixedPromises = Array.from({ length: 12 }, (_, idx) => {
      if (idx % 2 === 0) {
        return sendMultipartUpload(baseUrl, { token, filename: `mix_std_${idx}.txt` });
      }
      return fetch(`${baseUrl}/api/upload/direct/signed-url`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          chatId: 'conv_mix_conc',
          fileName: `mix_dir_${idx}.txt`,
          fileSize: 64,
          mimeType: 'text/plain'
        })
      });
    });

    const responses = await Promise.all(mixedPromises);
    const okResponses = responses.filter((r) => r.status === 200);
    const limitedResponses = responses.filter((r) => r.status === 429);

    assert.strictEqual(okResponses.length, 5, `Expected 5 succeeded mixed concurrent requests, got ${okResponses.length}`);
    assert.strictEqual(limitedResponses.length, 7, `Expected 7 rate-limited mixed concurrent requests, got ${limitedResponses.length}`);

    for (const r of responses) {
      assert.strictEqual(r.headers.get('x-ratelimit-limit'), '5');
      assert.strictEqual(r.headers.get('x-ratelimit-reset-utc'), '2026-11-10T19:00:00.000Z');
    }

    const db = getFirestoreDb();
    const snap = await db.collection('uploadQuotas').doc(`${identity.key}_2026-11-10`).get();
    assert.ok(snap.exists);
    const docData = snap.data();
    const activeCount = Object.keys(docData.reservations || {}).length;
    assert.strictEqual(
      docData.committed + activeCount,
      5,
      `Firestore committed (${docData.committed}) + reservations (${activeCount}) must equal 5`
    );

    // Multi-instance contention check on PKT rollover boundary
    const uidMulti = 'pkt_multi_inst_' + crypto.randomUUID();
    const multiId = buildAuthenticatedQuotaIdentity(uidMulti);
    const instA = createSimulatedFirestoreInstance();
    const instB = createSimulatedFirestoreInstance();
    const instC = createSimulatedFirestoreInstance();
    const instances = [instA, instB, instC];

    try {
      setCustomDateHookForTesting(() => new Date('2026-11-09T18:59:59.999Z'));
      const day1Reserves = await Promise.all(
        Array.from({ length: 8 }, (_, idx) => {
          setFirestoreForTesting(instances[idx % instances.length]);
          return reserveUploadSlot(multiId);
        })
      );
      assert.strictEqual(day1Reserves.filter((r) => r.allowed).length, 5);
      assert.strictEqual(day1Reserves.filter((r) => !r.allowed).length, 3);

      // Advance 1ms to Day 2 PKT and reserve concurrently across the 3 simulated instances
      setCustomDateHookForTesting(() => new Date('2026-11-09T19:00:00.000Z'));
      const day2Reserves = await Promise.all(
        Array.from({ length: 9 }, (_, idx) => {
          setFirestoreForTesting(instances[idx % instances.length]);
          return reserveUploadSlot(multiId);
        })
      );
      assert.strictEqual(day2Reserves.filter((r) => r.allowed).length, 5);
      assert.strictEqual(day2Reserves.filter((r) => !r.allowed).length, 4);
    } finally {
      setFirestoreForTesting(null);
    }
  });

  // 10. Direct-upload signed-url failures, completion failures (same-day & cross-midnight), and expired cross-midnight commits
  await test('10. Direct-upload signed URL errors, completion failures across midnight PKT, and expired cross-midnight commit failures', async () => {
    // 10A. Signed-URL generation outage (503) releases reservation and returns restored quota header
    {
      const uid = 'pkt_sign_fail_' + crypto.randomUUID();
      const token = createSignedJwt(uid);
      setCustomDateHookForTesting(() => new Date('2026-11-09T18:59:50.000Z')); // Day 1 PKT

      // Consume 1 slot -> 4 remaining
      const ok1 = await sendMultipartUpload(baseUrl, { token, filename: 'ok1.txt' });
      assert.strictEqual(ok1.status, 200);
      assert.strictEqual(ok1.headers.get('x-ratelimit-remaining'), '4');

      // Fail signed-url creation -> must release reservation back to 4 remaining
      mockStorage._failCreateSignedUploadUrl = true;
      try {
        const failSignRes = await fetch(`${baseUrl}/api/upload/direct/signed-url`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chatId: 'conv_sign_fail',
            fileName: 'signed_fail.txt',
            fileSize: 64,
            mimeType: 'text/plain'
          })
        });
        assert.strictEqual(failSignRes.status, 503);
        const failBody = await failSignRes.json();
        assert.strictEqual(failBody.code, 'SIGNED_UPLOAD_URL_FAILED');
        assert.strictEqual(failSignRes.headers.get('x-ratelimit-remaining'), '4');
        assert.strictEqual(failSignRes.headers.get('x-ratelimit-reset-utc'), '2026-11-09T19:00:00.000Z');
      } finally {
        mockStorage._failCreateSignedUploadUrl = false;
      }

      const qAfter = await fetch(`${baseUrl}/api/upload/quota`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      assert.strictEqual(qAfter.headers.get('x-ratelimit-remaining'), '4');
    }

    // 10B. Direct-upload completion failures (OBJECT_NOT_FOUND, EMPTY_FILE, INVALID_FILE_SIGNATURE) across midnight PKT
    {
      const failureModes = [
        { code: 'OBJECT_NOT_FOUND', name: 'missing.txt', setupObject: null },
        { code: 'EMPTY_FILE', name: 'empty.txt', setupObject: { buffer: Buffer.alloc(0), contentType: 'text/plain' } },
        { code: 'INVALID_FILE_SIGNATURE', name: 'corrupt.png', setupObject: { buffer: Buffer.from('NOT_A_PNG'), contentType: 'image/png' } }
      ];

      for (const mode of failureModes) {
        const uid = `pkt_comp_fail_${mode.code}_${crypto.randomUUID()}`;
        const token = createSignedJwt(uid);
        const identity = buildAuthenticatedQuotaIdentity(uid);

        // Day 1 PKT: consume 4 slots, then reserve 5th via signed-url (remaining: 0)
        setCustomDateHookForTesting(() => new Date('2026-11-09T18:59:50.000Z'));
        for (let i = 1; i <= 4; i++) {
          const r = await sendMultipartUpload(baseUrl, { token, filename: `pre_${i}.txt` });
          assert.strictEqual(r.status, 200);
        }

        const signRes = await fetch(`${baseUrl}/api/upload/direct/signed-url`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chatId: 'conv_comp_fail',
            fileName: mode.name,
            fileSize: 64
          })
        });
        assert.strictEqual(signRes.status, 200);
        assert.strictEqual(signRes.headers.get('x-ratelimit-remaining'), '0');
        const { attachmentId, storagePath } = await signRes.json();

        if (mode.setupObject) {
          mockStorage._objects.set(storagePath, mode.setupObject);
        }

        // Cross midnight PKT -> 2026-11-10 00:00:05 PKT
        setCustomDateHookForTesting(() => new Date('2026-11-09T19:00:05.000Z'));

        const compRes = await fetch(`${baseUrl}/api/upload/direct/complete`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ chatId: 'conv_comp_fail', attachmentId })
        });
        assert.strictEqual(compRes.status, 400, `${mode.code}: expected 400`);
        const compJson = await compRes.json();
        assert.strictEqual(compJson.code, mode.code);

        // Must release Day 1 reservation, purge storage object, and return Day 2 status headers (5 remaining)
        assert.strictEqual(compRes.headers.get('x-ratelimit-remaining'), '5', `${mode.code}: cross-midnight failure must report Day 2 remaining 5`);
        assert.strictEqual(compRes.headers.get('x-ratelimit-reset-utc'), '2026-11-10T19:00:00.000Z', `${mode.code}: must report Day 2 resetAt`);
        assert.strictEqual(mockStorage._objects.has(storagePath), false, `${mode.code}: partial object must be deleted`);

        const db = getFirestoreDb();
        const day1Snap = await db.collection('uploadQuotas').doc(`${identity.key}_2026-11-09`).get();
        assert.strictEqual(day1Snap.data().committed, 4);
        assert.strictEqual(Object.keys(day1Snap.data().reservations || {}).length, 0);

        const day2Status = await getQuotaStatus(identity);
        assert.strictEqual(day2Status.committed, 0);
        assert.strictEqual(day2Status.remaining, 5);
      }
    }

    // 10C. Expired Day 1 reservation attempting to commit after midnight PKT when Day 1 was already exhausted
    {
      const uid = 'pkt_expired_cross_' + crypto.randomUUID();
      const token = createSignedJwt(uid);
      const identity = buildAuthenticatedQuotaIdentity(uid);

      // Day 1 PKT at 23:57:00 PKT -> commit 4 slots, reserve slow 5th
      const tSlowStart = new Date('2026-11-09T18:57:00.000Z');
      setCustomDateHookForTesting(() => tSlowStart);
      for (let i = 1; i <= 4; i++) {
        const r = await reserveUploadSlot(identity);
        assert.strictEqual(r.allowed, true);
        await commitUploadSlot(r.reservation);
      }

      const signSlow = await fetch(`${baseUrl}/api/upload/direct/signed-url`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatId: 'conv_exp_cross',
          fileName: 'slow.txt',
          fileSize: 64,
          mimeType: 'text/plain'
        })
      });
      assert.strictEqual(signSlow.status, 200);
      const slowData = await signSlow.json();
      mockStorage._objects.set(slowData.storagePath, {
        buffer: Buffer.from('Slow file uploaded late'),
        contentType: 'text/plain'
      });

      // Advance >120s TTL (still Day 1: 23:59:10 PKT) -> fast upload reclaims slot 5 and commits
      setCustomDateHookForTesting(() => new Date('2026-11-09T18:59:10.000Z'));
      const fastRes = await sendMultipartUpload(baseUrl, { token, filename: 'fast_reclaim.txt' });
      assert.strictEqual(fastRes.status, 200);

      // Cross midnight PKT -> slow upload attempts /direct/complete on Day 2
      setCustomDateHookForTesting(() => new Date('2026-11-09T19:00:05.000Z'));
      const lateComplete = await fetch(`${baseUrl}/api/upload/direct/complete`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: 'conv_exp_cross', attachmentId: slowData.attachmentId })
      });
      assert.strictEqual(lateComplete.status, 429);
      const lateJson = await lateComplete.json();
      assert.strictEqual(lateJson.code, 'QUOTA_EXCEEDED');
      assert.strictEqual(lateComplete.headers.get('x-ratelimit-remaining'), '5');
      assert.strictEqual(lateComplete.headers.get('x-ratelimit-reset-utc'), '2026-11-10T19:00:00.000Z');
      assert.strictEqual(mockStorage._objects.has(slowData.storagePath), false, 'Rejected late upload object must be cleaned up');

      const db = getFirestoreDb();
      const day1Snap = await db.collection('uploadQuotas').doc(`${identity.key}_2026-11-09`).get();
      assert.strictEqual(day1Snap.data().committed, 5, 'Day 1 committed must never exceed 5');
      const day2Status = await getQuotaStatus(identity);
      assert.strictEqual(day2Status.remaining, 5, 'Day 2 quota must remain 5');
    }
  });

  // 11. Client uploadFileDirectToSupabase behavioral sync (complete, cancel, error)
  await test('11. Client uploadFileDirectToSupabase keeps quota state synchronized on signed-url, complete, cancel, and error paths', async () => {
    resetUploadQuotaClientStateForTesting();
    const uid = 'pkt_client_direct_' + crypto.randomUUID();
    const token = createSignedJwt(uid);
    const activeNow = new Date('2026-11-09T18:59:45.000Z');
    setCustomDateHookForTesting(() => activeNow);
    setClientQuotaDateHookForTesting(() => activeNow);
    setAuthInstanceForTesting({ currentUser: { uid, getIdToken: async () => token } });
    syncUploadQuotaUserAccount(uid, { autoFetch: false });

    const originalFetch = globalThis.fetch;
    const originalXhr = globalThis.XMLHttpRequest;

    let xhrMode = 'success'; // 'success' | 'hang_for_abort' | 'empty_file'
    let cancelSignalController = null;
    let resolveCancelDone = null;
    let cancelDonePromise = null;

    // Bridge relative /api/... requests from client service to ephemeral test HTTP server
    globalThis.fetch = (input, init) => {
      const urlStr = typeof input === 'string' ? input : String(input?.url || input);
      const targetUrl = typeof input === 'string' && input.startsWith('/') ? `${baseUrl}${input}` : input;
      const promise = originalFetch(targetUrl, init);
      if (urlStr.includes('/api/upload/direct/cancel') && typeof resolveCancelDone === 'function') {
        const notify = resolveCancelDone;
        resolveCancelDone = null;
        return promise.then(async (resp) => {
          // Wait for microtasks so uploadFileDirectToSupabase's onAbort .then(updateUploadQuotaFromResponse) finishes
          queueMicrotask(() => queueMicrotask(notify));
          return resp;
        }, (err) => {
          queueMicrotask(() => queueMicrotask(notify));
          throw err;
        });
      }
      return promise;
    };

    class MockXMLHttpRequest {
      constructor() {
        this.upload = {};
        this.status = 0;
        this.responseText = '';
        this._aborted = false;
      }
      open(method, url) {
        this.method = method;
        this.url = url;
      }
      setRequestHeader() {}
      abort() {
        this._aborted = true;
      }
      async send(fileObj) {
        const parsed = new URL(this.url);
        const pathMatch = parsed.pathname.match(/\/storage\/v1\/object\/upload\/sign\/[^/]+\/(.+)$/);
        const storagePath = decodeURIComponent(pathMatch[1]);

        if (xhrMode === 'hang_for_abort') {
          assert.strictEqual(getUploadQuotaState().remaining, 3, 'Signed-URL reservation must drop client indicator to 3 of 5');
          mockStorage._objects.set(storagePath, { buffer: Buffer.from('partial'), contentType: 'text/plain' });
          cancelSignalController?.abort();
          return;
        }
        const buf = xhrMode === 'empty_file'
          ? Buffer.alloc(0)
          : Buffer.from(await fileObj.arrayBuffer());
        mockStorage._objects.set(storagePath, { buffer: buf, contentType: fileObj.type || 'text/plain' });
        this.status = 200;
        if (typeof this.onload === 'function') {
          this.onload();
        }
      }
    }
    globalThis.XMLHttpRequest = MockXMLHttpRequest;

    try {
      // 11A. Successful direct upload -> remaining drops to 4 of 5 and matches /api/upload/quota
      const validFile = new File(['Direct client upload bytes'], 'client_direct.txt', { type: 'text/plain' });
      const resOk = await uploadFileDirectToSupabase(validFile, { chatId: 'conv_cli_dir' });
      assert.strictEqual(resOk.success, true);
      assert.strictEqual(getUploadQuotaState().remaining, 4);
      assert.strictEqual(formatDailyUploadQuotaText(getUploadQuotaState()), '4 of 5 uploads remaining today');

      // 11B. Cancelled direct upload -> /api/upload/direct/cancel restores indicator from 3 back to 4 of 5
      xhrMode = 'hang_for_abort';
      cancelSignalController = new AbortController();
      cancelDonePromise = new Promise((resolve) => {
        resolveCancelDone = resolve;
      });
      await assert.rejects(
        () => uploadFileDirectToSupabase(validFile, { chatId: 'conv_cli_dir', signal: cancelSignalController.signal }),
        (err) => err?.name === 'AbortError'
      );
      await cancelDonePromise;
      // Flush one more macrotask/microtask turn after updateUploadQuotaFromResponse
      await new Promise((resolve) => setImmediate(resolve));
      assert.strictEqual(getUploadQuotaState().remaining, 4, 'Cancel must restore quota indicator from 3 back to 4 of 5');

      // 11C. Failed direct upload completion (0 bytes) -> /direct/complete returns 400 with header remaining: 4
      xhrMode = 'empty_file';
      await assert.rejects(
        () => uploadFileDirectToSupabase(validFile, { chatId: 'conv_cli_dir' }),
        (err) => err?.code === 'EMPTY_FILE'
      );
      assert.strictEqual(getUploadQuotaState().remaining, 4, 'Failed completion must keep quota indicator at 4 of 5');

      // Confirm backend agrees on 4 of 5
      const syncRes = await fetchAuthenticatedUploadQuota({
        userId: uid,
        endpoint: `${baseUrl}/api/upload/quota`,
        getTokenFn: async () => token
      });
      assert.strictEqual(syncRes.remaining, 4);
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.XMLHttpRequest = originalXhr;
      setAuthInstanceForTesting(null);
    }
  });

  // 12. Late previous-day edge cases (exact ms boundary, omitted reset header, cold-load retry, multi-tab triggerRefresh sync)
  await test('12. Late previous-day edge cases and frontend-backend /api/upload/quota synchronization', async () => {
    resetUploadQuotaClientStateForTesting();
    const uid = 'pkt_sync_edge_' + crypto.randomUUID();
    const token = createSignedJwt(uid);

    // 12A. Cold load starting at Day 1 with Day 1 response missing X-RateLimit-Reset-UTC -> retries once and gets Day 2
    let activeNow = new Date('2026-11-09T18:59:58.000Z');
    setCustomDateHookForTesting(() => activeNow);
    setClientQuotaDateHookForTesting(() => activeNow);
    syncUploadQuotaUserAccount(uid, { autoFetch: false });

    let fetchCount = 0;
    setClientQuotaFetchForTesting(async () => {
      fetchCount++;
      if (fetchCount === 1) {
        // Clock crosses midnight PKT during first request; server response lacks Reset header
        activeNow = new Date('2026-11-09T19:00:01.000Z');
        return {
          ok: true,
          status: 200,
          headers: new Headers({
            'X-RateLimit-Limit': '5',
            'X-RateLimit-Remaining': '1'
          })
        };
      }
      // Retry hits Day 2 backend quota endpoint
      return fetch(`${baseUrl}/api/upload/quota`, {
        headers: { Authorization: `Bearer ${token}` }
      });
    });

    const coldRetryState = await fetchAuthenticatedUploadQuota({
      userId: uid,
      getTokenFn: async () => token
    });
    assert.strictEqual(fetchCount, 2, 'Stale cold-load cross-day response must trigger exactly 1 Day-2 retry');
    assert.strictEqual(coldRetryState.remaining, 5);
    assert.strictEqual(coldRetryState.utcDay, '2026-11-10');

    // 12B. updateUploadQuotaFromResponse rejects omitted-reset header with requestStartedPktDay from Day 1, and rejects resetAt === exact now
    updateUploadQuotaFromResponse(
      new Headers({
        'X-RateLimit-Limit': '5',
        'X-RateLimit-Remaining': '4',
        'X-RateLimit-Reset-UTC': '2026-11-10T19:00:00.000Z'
      }),
      uid
    );
    const afterOmittedReset = updateUploadQuotaFromResponse(
      new Headers({ 'X-RateLimit-Limit': '5', 'X-RateLimit-Remaining': '0' }),
      uid,
      { requestStartedPktDay: '2026-11-09' }
    );
    assert.strictEqual(afterOmittedReset.remaining, 4, 'Omitted reset header from Day 1 must be ignored on Day 2');

    // Exact millisecond equality boundary: now === resetAt (2026-11-10T19:00:00.000Z -> Day 3 start)
    activeNow = new Date('2026-11-10T19:00:00.000Z');
    const afterExactBoundaryStale = updateUploadQuotaFromResponse(
      new Headers({
        'X-RateLimit-Limit': '5',
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset-UTC': '2026-11-10T19:00:00.000Z'
      }),
      uid
    );
    assert.strictEqual(afterExactBoundaryStale.remaining, 5, 'Response whose resetAt === now must be rejected as expired');
    assert.strictEqual(afterExactBoundaryStale.utcDay, '2026-11-11');

    // 12C. Multi-tab sync on rollover: Tab B uploads 2 files on Day 3 while Tab A wakes up and calls checkUploadQuotaUtcRollover({ triggerRefresh: true })
    resetUploadQuotaClientStateForTesting();
    activeNow = new Date('2026-11-10T18:59:58.000Z'); // Day 2 PKT
    setCustomDateHookForTesting(() => activeNow);
    setClientQuotaDateHookForTesting(() => activeNow);
    syncUploadQuotaUserAccount(uid, { autoFetch: false });
    updateUploadQuotaFromResponse(
      new Headers({
        'X-RateLimit-Limit': '5',
        'X-RateLimit-Remaining': '2',
        'X-RateLimit-Reset-UTC': '2026-11-10T19:00:00.000Z'
      }),
      uid
    );

    // Tab B uploads 2 files on Day 3 PKT on the backend
    activeNow = new Date('2026-11-10T19:00:10.000Z'); // Day 3 PKT (2026-11-11)
    for (let i = 1; i <= 2; i++) {
      const r = await sendMultipartUpload(baseUrl, { token, filename: `tabB_${i}.txt` });
      assert.strictEqual(r.status, 200);
    }

    // Tab A calls checkUploadQuotaUtcRollover({ triggerRefresh: true }) routed to live backend /api/upload/quota
    setAuthInstanceForTesting({ currentUser: { uid, getIdToken: async () => token } });
    const origFetch2 = globalThis.fetch;
    setClientQuotaFetchForTesting((url, init) =>
      origFetch2(typeof url === 'string' && url.startsWith('/') ? `${baseUrl}${url}` : url, init)
    );
    try {
      let unsub = () => {};
      const syncedPromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          unsub();
          reject(new Error('Timed out waiting for multi-tab rollover refresh to sync remaining=3'));
        }, 5000);
        unsub = subscribeUploadQuotaState((state) => {
          if (state.status === 'ready' && state.remaining === 3 && state.utcDay === '2026-11-11') {
            clearTimeout(timer);
            unsub();
            resolve(state);
          }
        });
      });

      const rolled = checkUploadQuotaUtcRollover({ triggerRefresh: true });
      assert.strictEqual(rolled, true);
      const syncedState = await syncedPromise;
      assert.strictEqual(syncedState.remaining, 3);
      assert.strictEqual(formatDailyUploadQuotaText(syncedState), '3 of 5 uploads remaining today');
    } finally {
      setClientQuotaFetchForTesting(null);
      setAuthInstanceForTesting(null);
    }
  });

  // 13. Auth, guest upload restrictions, and Cache-Control / quota headers remain intact across PKT rollover
  await test('13. Auth/guest restrictions and /api/upload/quota no-store headers remain intact across PKT midnight rollover', async () => {
    const uid = 'pkt_auth_hdr_' + crypto.randomUUID();
    const token = createSignedJwt(uid);
    const { guestToken } = createServerIssuedGuestToken();

    for (const ts of ['2026-11-09T18:59:59.999Z', '2026-11-09T19:00:00.000Z']) {
      setCustomDateHookForTesting(() => new Date(ts));

      // Guest / unauthenticated rejected with 401 on quota and upload endpoints
      for (const qPath of ['/api/upload/quota', '/upload/quota']) {
        const gRes = await fetch(`${baseUrl}${qPath}`, {
          headers: {
            Cookie: `orvix_guest_token=${encodeURIComponent(guestToken)}`,
            'X-Guest-Token': guestToken,
            'x-user-id': uid
          }
        });
        assert.strictEqual(gRes.status, 401, `Guest must remain 401 on ${qPath} at ${ts}`);
        assert.strictEqual(gRes.headers.get('x-ratelimit-remaining'), null);
      }

      const guestUp = await sendMultipartUpload(baseUrl, { token: guestToken, filename: 'bad_jwt.txt' });
      assert.strictEqual(guestUp.status, 401);

      // Authenticated quota endpoint returns no-store Cache-Control and accurate PKT headers without consuming slots
      const authQ = await fetch(`${baseUrl}/api/upload/quota`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      assert.strictEqual(authQ.status, 200);
      assert.ok((authQ.headers.get('cache-control') || '').includes('no-store'));
      assert.strictEqual(authQ.headers.get('x-ratelimit-limit'), '5');
      assert.strictEqual(authQ.headers.get('x-ratelimit-remaining'), '5');
    }
  });
} finally {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  setAuthInstanceForTesting(null);
  setCustomDateHookForTesting(null);
  setClientQuotaDateHookForTesting(null);
  setClientQuotaFetchForTesting(null);
  resetFirestoreForTesting();
  clearTestPublicKeys();
  resetFirebaseAuthForTesting();
  resetSupabaseClientForTesting();
  resetDirectUploadTicketsForTesting();
  resetUploadQuotaClientStateForTesting();
  fileRegistry.clear();
  conversationDocuments.clear();
}

console.log('\n================================================================');
console.log(`ORVIX PKT RESET SUMMARY: ${passed} passed, ${failed} failed`);
console.log('================================================================\n');

if (failed > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
