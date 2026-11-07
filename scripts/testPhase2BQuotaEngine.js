/**
 * ORVIX Phase 2B: Atomic Quota Engine Verification Suite
 *
 * Validates the 12 required quota engine scenarios:
 * 1. First five reservations succeed.
 * 2. Sixth reservation is rejected with 429 and DAILY_LIMIT_EXCEEDED.
 * 3. Mixed PDF and image uploads share the same limit.
 * 4. Non-PDF/image documents do not consume quota.
 * 5. Concurrent reservations cannot exceed five (race-condition protection).
 * 6. Failed uploads release their reservations.
 * 7. Successful uploads permanently consume quota via commit.
 * 8. Duplicate commit/release attempts are safe and idempotent.
 * 9. Different users have independent quotas.
 * 10. Authenticated and guest identities cannot manipulate each other's quotas.
 * 11. UTC date rollover creates a fresh daily allowance.
 * 12. Tracking survives server restarts and works across separate process instances.
 *
 * Run with: node scripts/testPhase2BQuotaEngine.js
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

process.env.TESTING = 'true';

// Import quotaEngine
const {
  DAILY_LIMIT_ATTACHMENTS,
  DAILY_LIMIT_ERROR_CODE,
  DAILY_LIMIT_EXCEEDED_MESSAGE,
  DAILY_LIMIT_ERROR_RESPONSE,
  QUOTA_TRACKED_EXTENSIONS,
  QUOTA_TRACKED_MIMES,
  isQuotaTrackedAttachment,
  getUtcDateKey,
  resolveUserQuotaKey,
  reserveAttachmentQuota,
  commitAttachmentQuota,
  releaseAttachmentQuota,
  getQuotaStatus,
  resetQuotaForTesting,
  _setQuotaStorageDirForTesting
} = await import('../server/quotaEngine.ts');

console.log('=== ORVIX Phase 2B: Atomic Quota Engine Verification Suite ===\n');

// Configure isolated test quota directory
const testQuotaDir = path.join(os.tmpdir(), `orvix_quota_test_${Date.now()}_${Math.random().toString(36).slice(2)}`);
fs.mkdirSync(testQuotaDir, { recursive: true });
_setQuotaStorageDirForTesting(testQuotaDir);

let passed = 0;
let failed = 0;

async function runTest(name, fn) {
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

// ---------------------------------------------------------------------------
// Test 1: First five reservations succeed
// ---------------------------------------------------------------------------
await runTest('1. First five reservations succeed for quota-tracked files', async () => {
  const identity = { uid: 'user_test_1', type: 'authenticated', isGuest: false };
  await resetQuotaForTesting(identity);

  const reservations = [];
  for (let i = 0; i < 5; i++) {
    const res = await reserveAttachmentQuota(identity, { originalname: `doc_${i}.pdf`, mimetype: 'application/pdf' });
    assert.equal(res.allowed, true, `Reservation ${i + 1} should be allowed`);
    assert.equal(res.quotaTracked, true);
    assert.ok(res.reservationId, `Reservation ${i + 1} must have a reservationId`);
    assert.equal(res.currentCount, i + 1);
    assert.equal(res.remaining, 5 - (i + 1));
    reservations.push(res);
  }

  const status = await getQuotaStatus(identity);
  assert.equal(status.activeCount, 5);
  assert.equal(status.remaining, 0);

  // Clean up
  for (const r of reservations) {
    await releaseAttachmentQuota(r);
  }
});

// ---------------------------------------------------------------------------
// Test 2: Sixth reservation is rejected with 429 DAILY_LIMIT_EXCEEDED
// ---------------------------------------------------------------------------
await runTest('2. Sixth reservation is rejected with 429 DAILY_LIMIT_EXCEEDED error payload', async () => {
  const identity = { uid: 'user_test_2', type: 'authenticated', isGuest: false };
  await resetQuotaForTesting(identity);

  const reservations = [];
  for (let i = 0; i < 5; i++) {
    const res = await reserveAttachmentQuota(identity, { originalname: `image_${i}.png`, mimetype: 'image/png' });
    assert.equal(res.allowed, true);
    reservations.push(res);
  }

  // 6th attempt
  const sixth = await reserveAttachmentQuota(identity, { originalname: 'image_extra.jpg', mimetype: 'image/jpeg' });
  assert.equal(sixth.allowed, false, 'Sixth reservation must be rejected');
  assert.equal(sixth.status, 429, 'Status must be 429');
  assert.equal(sixth.code, DAILY_LIMIT_ERROR_CODE);
  assert.equal(sixth.code, 'DAILY_LIMIT_EXCEEDED');
  assert.equal(sixth.error, DAILY_LIMIT_EXCEEDED_MESSAGE);
  assert.equal(sixth.error, 'Daily attachment limit reached. You can upload a maximum of 5 PDFs and images per UTC day.');
  assert.equal(sixth.remaining, 0);

  // Clean up
  for (const r of reservations) {
    await releaseAttachmentQuota(r);
  }
});

// ---------------------------------------------------------------------------
// Test 3: Mixed PDF and image uploads share the same limit
// ---------------------------------------------------------------------------
await runTest('3. Mixed PDF and image uploads share the exact same 5-file limit', async () => {
  const identity = { uid: 'user_test_3', type: 'authenticated', isGuest: false };
  await resetQuotaForTesting(identity);

  // 2 PDFs
  const res1 = await reserveAttachmentQuota(identity, { originalname: 'doc1.pdf', mimetype: 'application/pdf' });
  const res2 = await reserveAttachmentQuota(identity, { originalname: 'doc2.pdf', mimetype: 'application/pdf' });
  assert.equal(res1.allowed, true);
  assert.equal(res2.allowed, true);

  // 3 Images (webp, heic, jpeg)
  const res3 = await reserveAttachmentQuota(identity, { originalname: 'pic1.webp', mimetype: 'image/webp' });
  const res4 = await reserveAttachmentQuota(identity, { originalname: 'pic2.heic', mimetype: 'image/heic' });
  const res5 = await reserveAttachmentQuota(identity, { originalname: 'pic3.jpeg', mimetype: 'image/jpeg' });
  assert.equal(res3.allowed, true);
  assert.equal(res4.allowed, true);
  assert.equal(res5.allowed, true);

  // 6th attempt with PDF
  const sixthPdf = await reserveAttachmentQuota(identity, { originalname: 'overflow.pdf', mimetype: 'application/pdf' });
  assert.equal(sixthPdf.allowed, false);
  assert.equal(sixthPdf.status, 429);

  // 6th attempt with image
  const sixthImg = await reserveAttachmentQuota(identity, { originalname: 'overflow.png', mimetype: 'image/png' });
  assert.equal(sixthImg.allowed, false);
  assert.equal(sixthImg.status, 429);

  // Clean up
  await releaseAttachmentQuota(res1);
  await releaseAttachmentQuota(res2);
  await releaseAttachmentQuota(res3);
  await releaseAttachmentQuota(res4);
  await releaseAttachmentQuota(res5);
});

// ---------------------------------------------------------------------------
// Test 4: Non-PDF/image documents do not consume quota
// ---------------------------------------------------------------------------
await runTest('4. Non-PDF/image documents (TXT, DOCX, CSV, JSON, MD) do not consume quota', async () => {
  const identity = { uid: 'user_test_4', type: 'authenticated', isGuest: false };
  await resetQuotaForTesting(identity);

  const nonTrackedFiles = [
    { originalname: 'notes.txt', mimetype: 'text/plain' },
    { originalname: 'report.docx', mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
    { originalname: 'data.csv', mimetype: 'text/csv' },
    { originalname: 'config.json', mimetype: 'application/json' },
    { originalname: 'readme.md', mimetype: 'text/markdown' }
  ];

  for (const file of nonTrackedFiles) {
    const res = await reserveAttachmentQuota(identity, file);
    assert.equal(res.allowed, true, `Non-tracked file ${file.originalname} should be allowed`);
    assert.equal(res.quotaTracked, false, `File ${file.originalname} must not be quotaTracked`);
    assert.equal(res.reservationId, null);
  }

  const status = await getQuotaStatus(identity);
  assert.equal(status.activeCount, 0, 'Non-tracked files must not consume any quota slots');
  assert.equal(status.committedCount, 0);
  assert.equal(status.remaining, 5);
});

// ---------------------------------------------------------------------------
// Test 5: Concurrent reservations cannot exceed five (race-condition protection)
// ---------------------------------------------------------------------------
await runTest('5. Concurrent reservations cannot exceed five (simultaneous async race)', async () => {
  const identity = { uid: 'user_test_5_concurrent', type: 'authenticated', isGuest: false };
  await resetQuotaForTesting(identity);

  // Launch 20 concurrent reservation requests at the same time
  const CONCURRENT_REQUESTS = 20;
  const promises = [];
  for (let i = 0; i < CONCURRENT_REQUESTS; i++) {
    promises.push(
      reserveAttachmentQuota(identity, { originalname: `concurrent_${i}.png`, mimetype: 'image/png' })
    );
  }

  const results = await Promise.all(promises);
  const accepted = results.filter((r) => r.allowed === true);
  const rejected = results.filter((r) => r.allowed === false);

  assert.equal(accepted.length, 5, `Exactly 5 concurrent requests must succeed, got ${accepted.length}`);
  assert.equal(rejected.length, CONCURRENT_REQUESTS - 5, `Remaining requests must be rejected, got ${rejected.length}`);

  for (const rej of rejected) {
    assert.equal(rej.status, 429);
    assert.equal(rej.code, DAILY_LIMIT_ERROR_CODE);
  }

  const status = await getQuotaStatus(identity);
  assert.equal(status.activeCount, 5);
  assert.equal(status.remaining, 0);

  // Clean up
  for (const r of accepted) {
    await releaseAttachmentQuota(r);
  }
});

// ---------------------------------------------------------------------------
// Test 6: Failed uploads release their reservations
// ---------------------------------------------------------------------------
await runTest('6. Failed uploads release their reservations and restore daily quota', async () => {
  const identity = { uid: 'user_test_6', type: 'authenticated', isGuest: false };
  await resetQuotaForTesting(identity);

  // Reserve 5
  const resList = [];
  for (let i = 0; i < 5; i++) {
    resList.push(await reserveAttachmentQuota(identity, { originalname: `file_${i}.pdf`, mimetype: 'application/pdf' }));
  }

  // Quota is full
  let status = await getQuotaStatus(identity);
  assert.equal(status.remaining, 0);

  // Simulate upload validation failure for 2 of the files -> release them
  const rel1 = await releaseAttachmentQuota(resList[0]);
  const rel2 = await releaseAttachmentQuota(resList[1]);
  assert.equal(rel1.released, true);
  assert.equal(rel2.released, true);

  // Quota now has 2 remaining
  status = await getQuotaStatus(identity);
  assert.equal(status.remaining, 2);
  assert.equal(status.activeCount, 3);

  // User can now successfully reserve 2 new attachments
  const newRes1 = await reserveAttachmentQuota(identity, { originalname: 'new1.png', mimetype: 'image/png' });
  const newRes2 = await reserveAttachmentQuota(identity, { originalname: 'new2.png', mimetype: 'image/png' });
  assert.equal(newRes1.allowed, true);
  assert.equal(newRes2.allowed, true);

  // 3rd attempt is rejected
  const newRes3 = await reserveAttachmentQuota(identity, { originalname: 'new3.png', mimetype: 'image/png' });
  assert.equal(newRes3.allowed, false);

  // Clean up
  for (const r of [resList[2], resList[3], resList[4], newRes1, newRes2]) {
    await releaseAttachmentQuota(r);
  }
});

// ---------------------------------------------------------------------------
// Test 7: Successful uploads permanently consume quota via commit
// ---------------------------------------------------------------------------
await runTest('7. Successful uploads permanently consume quota via commit', async () => {
  const identity = { uid: 'user_test_7', type: 'authenticated', isGuest: false };
  await resetQuotaForTesting(identity);

  const res = await reserveAttachmentQuota(identity, { originalname: 'success.pdf', mimetype: 'application/pdf' });
  assert.equal(res.allowed, true);

  // Commit reservation on upload success
  const commitResult = await commitAttachmentQuota(res);
  assert.equal(commitResult.committed, true);
  assert.equal(commitResult.committedCount, 1);

  // Release attempt on committed reservation must have no effect
  const releaseAttempt = await releaseAttachmentQuota(res);
  assert.equal(releaseAttempt.released, false);

  const status = await getQuotaStatus(identity);
  assert.equal(status.committedCount, 1);
  assert.equal(status.reservedCount, 0);
  assert.equal(status.activeCount, 1);
  assert.equal(status.remaining, 4);
});

// ---------------------------------------------------------------------------
// Test 8: Duplicate commit/release attempts are safe and idempotent
// ---------------------------------------------------------------------------
await runTest('8. Duplicate commit/release attempts are safe and idempotent', async () => {
  const identity = { uid: 'user_test_8', type: 'authenticated', isGuest: false };
  await resetQuotaForTesting(identity);

  // Test duplicate commit
  const res1 = await reserveAttachmentQuota(identity, { originalname: 'test1.pdf', mimetype: 'application/pdf' });
  const commit1 = await commitAttachmentQuota(res1);
  const commit2 = await commitAttachmentQuota(res1);
  assert.equal(commit1.committed, true);
  assert.equal(commit2.committed, false); // Already finalized
  assert.equal(commit2.alreadyFinalized, true);

  let status = await getQuotaStatus(identity);
  assert.equal(status.committedCount, 1, 'Duplicate commit must not increment counter twice');

  // Test duplicate release
  const res2 = await reserveAttachmentQuota(identity, { originalname: 'test2.pdf', mimetype: 'application/pdf' });
  const release1 = await releaseAttachmentQuota(res2);
  const release2 = await releaseAttachmentQuota(res2);
  assert.equal(release1.released, true);
  assert.equal(release2.released, false);
  assert.equal(release2.alreadyFinalized, true);

  status = await getQuotaStatus(identity);
  assert.equal(status.committedCount, 1);
  assert.equal(status.reservedCount, 0);
});

// ---------------------------------------------------------------------------
// Test 9: Different users have independent quotas
// ---------------------------------------------------------------------------
await runTest('9. Different users have independent quotas', async () => {
  const userA = { uid: 'user_alice', type: 'authenticated', isGuest: false };
  const userB = { uid: 'user_bob', type: 'authenticated', isGuest: false };
  await resetQuotaForTesting(userA);
  await resetQuotaForTesting(userB);

  // User A consumes 5
  for (let i = 0; i < 5; i++) {
    const r = await reserveAttachmentQuota(userA, { originalname: `a_${i}.pdf`, mimetype: 'application/pdf' });
    assert.equal(r.allowed, true);
    await commitAttachmentQuota(r);
  }

  const statusA = await getQuotaStatus(userA);
  assert.equal(statusA.remaining, 0);

  // User B's quota should still be completely untouched
  const statusB = await getQuotaStatus(userB);
  assert.equal(statusB.committedCount, 0);
  assert.equal(statusB.remaining, 5);

  const resB = await reserveAttachmentQuota(userB, { originalname: 'b_0.pdf', mimetype: 'application/pdf' });
  assert.equal(resB.allowed, true);
  await releaseAttachmentQuota(resB);
});

// ---------------------------------------------------------------------------
// Test 10: Authenticated and guest identities cannot manipulate each other's quotas
// ---------------------------------------------------------------------------
await runTest('10. Authenticated and guest identities are strictly partitioned and cannot collide', async () => {
  const sharedUid = 'collision_target_id';
  const authUser = { uid: sharedUid, type: 'authenticated', isGuest: false };
  const guestUser = { uid: sharedUid, type: 'guest', isGuest: true };

  await resetQuotaForTesting(authUser);
  await resetQuotaForTesting(guestUser);

  // Verify key resolution prefixes
  assert.equal(resolveUserQuotaKey(authUser), `auth:${sharedUid}`);
  assert.equal(resolveUserQuotaKey(guestUser), `guest:${sharedUid}`);

  // Guest consumes all 5 attachments
  for (let i = 0; i < 5; i++) {
    const r = await reserveAttachmentQuota(guestUser, { originalname: `guest_${i}.png`, mimetype: 'image/png' });
    assert.equal(r.allowed, true);
    await commitAttachmentQuota(r);
  }

  const guestStatus = await getQuotaStatus(guestUser);
  assert.equal(guestStatus.remaining, 0);

  // Authenticated user with the same raw UID is NOT blocked
  const authStatus = await getQuotaStatus(authUser);
  assert.equal(authStatus.remaining, 5);

  const authRes = await reserveAttachmentQuota(authUser, { originalname: 'auth_doc.pdf', mimetype: 'application/pdf' });
  assert.equal(authRes.allowed, true);
  await releaseAttachmentQuota(authRes);
});

// ---------------------------------------------------------------------------
// Test 11: UTC date rollover creates a fresh daily allowance
// ---------------------------------------------------------------------------
await runTest('11. UTC date rollover creates a fresh daily allowance', async () => {
  const identity = { uid: 'user_date_rollover', type: 'authenticated', isGuest: false };
  await resetQuotaForTesting(identity);

  // Test getUtcDateKey formatting
  const fixedDate1 = new Date('2026-11-06T23:59:59.000Z');
  const fixedDate2 = new Date('2026-11-07T00:00:01.000Z');
  assert.equal(getUtcDateKey(fixedDate1), '2026-11-06');
  assert.equal(getUtcDateKey(fixedDate2), '2026-11-07');

  // Simulate usage on yesterday's date
  const yesterdayKey = '2026-11-05';
  const yesterdayStatus = await getQuotaStatus(identity, '2026-11-05');
  assert.equal(yesterdayStatus.remaining, 5);

  // Reserve and commit 5 on today
  for (let i = 0; i < 5; i++) {
    const r = await reserveAttachmentQuota(identity, { originalname: `day_${i}.png`, mimetype: 'image/png' });
    await commitAttachmentQuota(r);
  }

  const todayStatus = await getQuotaStatus(identity);
  assert.equal(todayStatus.remaining, 0);

  // Tomorrow has a fresh 5 allowance
  const tomorrowStatus = await getQuotaStatus(identity, new Date(Date.now() + 86400000));
  assert.equal(tomorrowStatus.committedCount, 0);
  assert.equal(tomorrowStatus.remaining, 5);
});

// ---------------------------------------------------------------------------
// Test 12: Tracking survives server restarts and works across separate process instances
// ---------------------------------------------------------------------------
await runTest('12. Tracking survives server restarts and works across separate process instances', async () => {
  const identity = { uid: 'user_restart_test', type: 'authenticated', isGuest: false };
  await resetQuotaForTesting(identity);

  // Step 1: Process A reserves and commits 3 uploads
  for (let i = 0; i < 3; i++) {
    const r = await reserveAttachmentQuota(identity, { originalname: `save_${i}.pdf`, mimetype: 'application/pdf' });
    await commitAttachmentQuota(r);
  }

  // Step 2: Spawn a completely separate Node child process pointing to the same storage directory
  const quotaEnginePath = path.resolve(__dirname, '../server/quotaEngine.ts');
  const childScript = `
    const { getQuotaStatus, reserveAttachmentQuota, commitAttachmentQuota, _setQuotaStorageDirForTesting } = await import(${JSON.stringify(quotaEnginePath)});
    _setQuotaStorageDirForTesting(${JSON.stringify(testQuotaDir)});

    const identity = { uid: 'user_restart_test', type: 'authenticated', isGuest: false };
    const status = await getQuotaStatus(identity);

    if (status.committedCount !== 3 || status.remaining !== 2) {
      console.error('Child read invalid count:', status);
      process.exit(1);
    }

    // Child reserves 2 more
    const r1 = await reserveAttachmentQuota(identity, { originalname: 'child_1.pdf', mimetype: 'application/pdf' });
    const r2 = await reserveAttachmentQuota(identity, { originalname: 'child_2.pdf', mimetype: 'application/pdf' });
    await commitAttachmentQuota(r1);
    await commitAttachmentQuota(r2);

    // Child attempts 6th upload
    const r3 = await reserveAttachmentQuota(identity, { originalname: 'child_overflow.pdf', mimetype: 'application/pdf' });
    if (r3.allowed !== false || r3.status !== 429) {
      console.error('Child allowed 6th upload:', r3);
      process.exit(2);
    }

    process.exit(0);
  `;

  const childPath = path.join(testQuotaDir, 'child_test.mjs');
  fs.writeFileSync(childPath, childScript, 'utf8');

  const childExitCode = await new Promise((resolve) => {
    const proc = fork(childPath, [], { stdio: 'inherit', env: { ...process.env, TESTING: 'true' } });
    proc.on('exit', (code) => resolve(code));
  });

  assert.equal(childExitCode, 0, `Child process should exit with code 0, got ${childExitCode}`);

  // Step 3: Main process verifies the state committed by the child process
  const finalStatus = await getQuotaStatus(identity);
  assert.equal(finalStatus.committedCount, 5, 'Final committed count must be 5');
  assert.equal(finalStatus.remaining, 0, 'Final remaining quota must be 0');
});

// Clean up temporary test directory
try {
  fs.rmSync(testQuotaDir, { recursive: true, force: true });
} catch (_) {}

console.log(`\n==================================================`);
console.log(`Tests Completed: ${passed + failed}`);
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
console.log(`==================================================\n`);

if (failed > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
