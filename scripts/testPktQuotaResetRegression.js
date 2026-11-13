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
  buildAuthenticatedQuotaIdentity,
  getUtcDayString,
  getNextUtcMidnight,
  getFirestoreDb,
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
  syncUploadQuotaUserAccount,
  updateUploadQuotaFromResponse,
  fetchAuthenticatedUploadQuota,
  checkUploadQuotaUtcRollover,
  formatDailyUploadQuotaText,
  setClientQuotaDateHookForTesting,
  setClientQuotaFetchForTesting,
  resetUploadQuotaClientStateForTesting
} = await import('../src/services/uploadQuotaClientService.js');

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
  return {
    _objects: objects,
    storage: {
      from(bucket) {
        return {
          async createSignedUploadUrl(storagePath) {
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
} finally {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  setCustomDateHookForTesting(null);
  setClientQuotaDateHookForTesting(null);
  setClientQuotaFetchForTesting(null);
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
