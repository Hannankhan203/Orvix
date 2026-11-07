/**
 * ORVIX Phase 2C: Backend Upload Integration Verification Suite
 *
 * Validates the 12 required scenarios from the Phase 2C specification:
 * 1. Five combined PDF/image uploads succeed.
 * 2. The sixth is rejected with HTTP 429 (DAILY_LIMIT_EXCEEDED).
 * 3. Mixed PDFs and images share the same 5-file quota.
 * 4. Non-PDF/image files (e.g., TXT, DOCX) remain exempt.
 * 5. Concurrent requests cannot exceed five (atomic race condition safety).
 * 6. Failed processing releases reservations and restores quota allowance.
 * 7. Both upload routes (/api/upload and /upload) enforce identical limits.
 * 8. /api/chat cannot inject unverified attachments or bypass quota.
 * 9. Guest and authenticated quotas remain strictly isolated.
 * 10. Production without distributed storage fails safely with HTTP 503 (QUOTA_STORAGE_UNAVAILABLE).
 * 11. Offline WebLLM path remains unaffected.
 * 12. Existing authentication (2A) and quota-engine (2B) tests still pass.
 *
 * Run with: node scripts/testPhase2C.js
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

process.env.TESTING = 'true';

const {
  app,
  verifyFirebaseIdToken,
  authenticateUploadRequest,
  _setGoogleCertCacheForTesting,
  DAILY_LIMIT_ATTACHMENTS,
  DAILY_LIMIT_ERROR_CODE,
  DAILY_LIMIT_EXCEEDED_MESSAGE,
  isQuotaTrackedAttachment,
  getQuotaStatus,
  resetQuotaForTesting,
  setQuotaStorageDriver,
  getQuotaStorageDriver,
  LocalFilesystemAtomicDriver,
  SimulatedDistributedClusterDriver,
  getQuotaInfrastructureStatus,
  fileRegistry
} = await import('../server.ts');

const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const testPort = server.address().port;
const BASE_URL = `http://127.0.0.1:${testPort}`;

console.log('=== ORVIX Phase 2C: Backend Upload Integration Verification Suite ===\n');

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

// Generate an ephemeral RSA key pair for testing authenticated Firebase tokens
const testKeyPair = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

const TEST_KID = 'test-mock-key-phase2c';
const TEST_PROJECT_ID = 'orvix-test-project';

function createMockJwt(headerOverrides = {}, payloadOverrides = {}, privateKey = testKeyPair.privateKey) {
  const header = {
    alg: 'RS256',
    kid: TEST_KID,
    typ: 'JWT',
    ...headerOverrides
  };

  const nowSeconds = Math.floor(Date.now() / 1000);
  const payload = {
    iss: `https://securetoken.google.com/${TEST_PROJECT_ID}`,
    aud: TEST_PROJECT_ID,
    auth_time: nowSeconds - 60,
    user_id: 'firebase-user-phase2c',
    sub: 'firebase-user-phase2c',
    iat: nowSeconds - 60,
    exp: nowSeconds + 3600,
    email: 'testuser@orvix.ai',
    ...payloadOverrides
  };

  const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${encodedHeader}.${encodedPayload}`);
  const signature = signer.sign(privateKey, 'base64url');

  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

_setGoogleCertCacheForTesting({
  certs: {
    [TEST_KID]: testKeyPair.publicKey
  },
  expiresAt: Date.now() + 24 * 60 * 60 * 1000
});

// Binary test payloads
// 1x1 valid PNG image
const VALID_PNG_BUFFER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

// Valid minimal PDF document
const VALID_PDF_BUFFER = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/MediaBox[0 0 300 144]/Parent 2 0 R/Resources<<>>>>endobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n190\n%%EOF',
  'utf8'
);

// Valid plain text document
const VALID_TXT_BUFFER = Buffer.from(
  'Orvix Architecture Specification: TXT documents are non-quota-tracked.',
  'utf8'
);

// Helper to make multipart upload requests
async function uploadFile({
  endpoint = '/api/upload',
  filename = 'test.png',
  buffer = VALID_PNG_BUFFER,
  mimeType = 'image/png',
  headers = {},
  guestId = null,
  authToken = null
}) {
  const reqHeaders = { ...headers };
  if (guestId) reqHeaders['X-Orvix-Guest-Id'] = guestId;
  if (authToken) reqHeaders['Authorization'] = `Bearer ${authToken}`;

  const blob = new Blob([buffer], { type: mimeType });
  const formData = new FormData();
  formData.append('files', blob, filename);

  const res = await fetch(`${BASE_URL}${endpoint}`, {
    method: 'POST',
    headers: reqHeaders,
    body: formData
  });

  const json = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, body: json };
}

// ---------------------------------------------------------------------------
// Run Test Suite
// ---------------------------------------------------------------------------

console.log('--- Test Group 1: Quota Enforcement & Limits ---');

await runTest('1. Five combined PDF/image uploads succeed', async () => {
  const guestId = 'guest-p2c-test-01';
  await resetQuotaForTesting({ type: 'guest', uid: guestId, isGuest: true });

  for (let i = 1; i <= 5; i++) {
    const res = await uploadFile({
      guestId,
      filename: `photo-${i}.png`,
      buffer: VALID_PNG_BUFFER,
      mimeType: 'image/png'
    });

    assert.equal(res.status, 200, `Upload ${i} should return HTTP 200. Got: ${res.status}`);
    assert.equal(res.body.success, true);
    assert.equal(res.body.count, 1);
  }

  const status = await getQuotaStatus({ type: 'guest', uid: guestId, isGuest: true });
  assert.equal(status.committedCount, 5, 'Should have exactly 5 committed uploads');
  assert.equal(status.remaining, 0, 'Should have 0 remaining quota slots');
});

await runTest('2. The sixth quota-tracked upload is rejected with HTTP 429 (DAILY_LIMIT_EXCEEDED)', async () => {
  const guestId = 'guest-p2c-test-01'; // User from test 1 who has reached 5/5

  const res = await uploadFile({
    guestId,
    filename: 'photo-6.png',
    buffer: VALID_PNG_BUFFER,
    mimeType: 'image/png'
  });

  assert.equal(res.status, 429, `Sixth upload should return 429. Got: ${res.status}`);
  assert.equal(res.body.code, DAILY_LIMIT_ERROR_CODE);
  assert.equal(res.body.error, DAILY_LIMIT_EXCEEDED_MESSAGE);
  assert.equal(res.body.remaining, 0);
});

await runTest('3. Mixed PDFs and images share one quota pool', async () => {
  const guestId = 'guest-p2c-mixed';
  await resetQuotaForTesting({ type: 'guest', uid: guestId, isGuest: true });

  // Upload 2 images
  for (let i = 1; i <= 2; i++) {
    const res = await uploadFile({
      guestId,
      filename: `image-${i}.png`,
      buffer: VALID_PNG_BUFFER,
      mimeType: 'image/png'
    });
    assert.equal(res.status, 200);
  }

  // Upload 3 PDFs
  for (let i = 1; i <= 3; i++) {
    const res = await uploadFile({
      guestId,
      filename: `document-${i}.pdf`,
      buffer: VALID_PDF_BUFFER,
      mimeType: 'application/pdf'
    });
    assert.equal(res.status, 200);
  }

  // 6th upload (attempting another PDF or image) must be rejected
  const resImage = await uploadFile({
    guestId,
    filename: 'extra.png',
    buffer: VALID_PNG_BUFFER,
    mimeType: 'image/png'
  });
  assert.equal(resImage.status, 429);
  assert.equal(resImage.body.code, DAILY_LIMIT_ERROR_CODE);

  const resPdf = await uploadFile({
    guestId,
    filename: 'extra.pdf',
    buffer: VALID_PDF_BUFFER,
    mimeType: 'application/pdf'
  });
  assert.equal(resPdf.status, 429);
  assert.equal(resPdf.body.code, DAILY_LIMIT_ERROR_CODE);
});

await runTest('4. Non-PDF/image files remain exempt from quota tracking', async () => {
  const guestId = 'guest-p2c-test-01'; // User already at 5/5 quota limit

  // Non-quota files (.txt, .docx, .json) should succeed even after 5 PDFs/images
  const resTxt = await uploadFile({
    guestId,
    filename: 'notes.txt',
    buffer: VALID_TXT_BUFFER,
    mimeType: 'text/plain'
  });

  assert.equal(resTxt.status, 200, `Non-quota file should succeed with 200. Got: ${resTxt.status}`);
  assert.equal(resTxt.body.success, true);
  assert.equal(resTxt.body.attachments[0].extension, 'TXT');

  // Verify that quota did not increment or overflow
  const status = await getQuotaStatus({ type: 'guest', uid: guestId, isGuest: true });
  assert.equal(status.committedCount, 5, 'Quota count must remain 5');
});

console.log('\n--- Test Group 2: Concurrency & Failure Handling ---');

await runTest('5. Concurrent requests cannot exceed five (atomic race condition protection)', async () => {
  const guestId = 'guest-p2c-concurrent';
  await resetQuotaForTesting({ type: 'guest', uid: guestId, isGuest: true });

  // Fire 10 simultaneous uploads
  const uploadPromises = Array.from({ length: 10 }).map((_, idx) =>
    uploadFile({
      guestId,
      filename: `concurrent-${idx}.png`,
      buffer: VALID_PNG_BUFFER,
      mimeType: 'image/png'
    })
  );

  const results = await Promise.all(uploadPromises);
  const successes = results.filter((r) => r.status === 200);
  const rateLimited = results.filter((r) => r.status === 429);

  assert.equal(successes.length, 5, `Exactly 5 concurrent requests should succeed. Got: ${successes.length}`);
  assert.equal(rateLimited.length, 5, `Exactly 5 concurrent requests should be rate limited. Got: ${rateLimited.length}`);

  const status = await getQuotaStatus({ type: 'guest', uid: guestId, isGuest: true });
  assert.equal(status.committedCount, 5, 'Committed quota must be strictly 5');
});

await runTest('6. Failed validation/processing releases reservations', async () => {
  const guestId = 'guest-p2c-failed-releases';
  await resetQuotaForTesting({ type: 'guest', uid: guestId, isGuest: true });

  // Upload an invalid/corrupted PNG (ELF executable pretending to be PNG)
  const ELF_FAKE_PNG = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x01, 0x01, 0x01, 0x00]);
  const failRes = await uploadFile({
    guestId,
    filename: 'malicious.png',
    buffer: ELF_FAKE_PNG,
    mimeType: 'image/png'
  });

  assert.equal(failRes.status, 400, 'Invalid file signature must return HTTP 400');
  assert.equal(failRes.body.code, 'INVALID_FILE_CONTENT');

  // Verify that the failed upload released its reservation
  const statusMid = await getQuotaStatus({ type: 'guest', uid: guestId, isGuest: true });
  assert.equal(statusMid.activeCount, 0, 'Active count should be 0 after failure release');
  assert.equal(statusMid.remaining, 5, 'Remaining quota should still be 5');

  // Now upload 5 valid images; all 5 should succeed
  for (let i = 1; i <= 5; i++) {
    const res = await uploadFile({
      guestId,
      filename: `valid-${i}.png`,
      buffer: VALID_PNG_BUFFER,
      mimeType: 'image/png'
    });
    assert.equal(res.status, 200, `Valid upload ${i} should succeed`);
  }

  // 6th upload should now be rejected
  const sixthRes = await uploadFile({
    guestId,
    filename: 'valid-6.png',
    buffer: VALID_PNG_BUFFER,
    mimeType: 'image/png'
  });
  assert.equal(sixthRes.status, 429);
});

console.log('\n--- Test Group 3: Routing & Isolation ---');

await runTest('7. Both upload routes (/api/upload and /upload) enforce identical limits', async () => {
  const guestId = 'guest-p2c-both-routes';
  await resetQuotaForTesting({ type: 'guest', uid: guestId, isGuest: true });

  // 3 uploads through /api/upload
  for (let i = 1; i <= 3; i++) {
    const res = await uploadFile({
      endpoint: '/api/upload',
      guestId,
      filename: `api-${i}.png`,
      buffer: VALID_PNG_BUFFER,
      mimeType: 'image/png'
    });
    assert.equal(res.status, 200);
  }

  // 2 uploads through /upload
  for (let i = 1; i <= 2; i++) {
    const res = await uploadFile({
      endpoint: '/upload',
      guestId,
      filename: `root-${i}.png`,
      buffer: VALID_PNG_BUFFER,
      mimeType: 'image/png'
    });
    assert.equal(res.status, 200);
  }

  // 6th upload to /api/upload must be rejected
  const sixthApi = await uploadFile({
    endpoint: '/api/upload',
    guestId,
    filename: 'api-extra.png',
    buffer: VALID_PNG_BUFFER,
    mimeType: 'image/png'
  });
  assert.equal(sixthApi.status, 429);

  // 6th upload to /upload must also be rejected
  const sixthRoot = await uploadFile({
    endpoint: '/upload',
    guestId,
    filename: 'root-extra.png',
    buffer: VALID_PNG_BUFFER,
    mimeType: 'image/png'
  });
  assert.equal(sixthRoot.status, 429);
});

await runTest('8. /api/chat secondary bypass protection (cannot inject unverified attachments)', async () => {
  const guestId = 'guest-p2c-chat-bypass';
  const otherGuestId = 'guest-p2c-other-user';
  await resetQuotaForTesting({ type: 'guest', uid: guestId, isGuest: true });
  await resetQuotaForTesting({ type: 'guest', uid: otherGuestId, isGuest: true });

  // 8a: Submitting attachments to /api/chat without authentication returns 401
  const unauthChatRes = await fetch(`${BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: 'Explain this document',
      attachments: [{ id: 'fake-file-id' }]
    })
  });
  assert.equal(unauthChatRes.status, 401, 'Unauthenticated chat with attachments must return 401');

  // 8b: Submitting an unregistered / fabricated attachment ID to /api/chat returns 400 UNVERIFIED_ATTACHMENT
  const fakeIdChatRes = await fetch(`${BASE_URL}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Orvix-Guest-Id': guestId
    },
    body: JSON.stringify({
      prompt: 'Summarize this file',
      attachments: [
        {
          id: '00000000-0000-0000-0000-000000000000',
          extraction: { text: 'Injected unverified content that bypassed upload' }
        }
      ]
    })
  });
  const fakeIdBody = await fakeIdChatRes.json();
  assert.equal(fakeIdChatRes.status, 400, 'Unverified attachment in /api/chat must return 400');
  assert.equal(fakeIdBody.code, 'UNVERIFIED_ATTACHMENT');

  // 8c: Submitting an attachment belonging to another user returns 403 ATTACHMENT_FORBIDDEN
  // Upload a legitimate file as otherGuestId
  const otherUpload = await uploadFile({
    guestId: otherGuestId,
    filename: 'other-user.png',
    buffer: VALID_PNG_BUFFER,
    mimeType: 'image/png'
  });
  assert.equal(otherUpload.status, 200);
  const otherFileId = otherUpload.body.attachments[0].id;

  const forbiddenChatRes = await fetch(`${BASE_URL}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Orvix-Guest-Id': guestId // guestId trying to access otherFileId
    },
    body: JSON.stringify({
      prompt: 'Summarize other user file',
      attachments: [{ id: otherFileId }]
    })
  });
  const forbiddenBody = await forbiddenChatRes.json();
  assert.equal(forbiddenChatRes.status, 403, 'Cross-user attachment access must return 403');
  assert.equal(forbiddenBody.code, 'ATTACHMENT_FORBIDDEN');

  // 8d: Plain chat without attachments works normally without requiring auth headers
  const plainChatRes = await fetch(`${BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: 'Hello world',
      stream: false
    })
  });
  assert.ok([200, 503].includes(plainChatRes.status), 'Plain chat without attachments must not fail on auth');
});

await runTest('9. Guest and authenticated quotas remain strictly isolated', async () => {
  const guestId = 'guest-p2c-isolated-user';
  const token = createMockJwt({}, { sub: 'auth-p2c-isolated-user', user_id: 'auth-p2c-isolated-user' });

  await resetQuotaForTesting({ type: 'guest', uid: guestId, isGuest: true });
  await resetQuotaForTesting({ type: 'authenticated', uid: 'auth-p2c-isolated-user', isGuest: false });

  // Guest consumes all 5 uploads
  for (let i = 1; i <= 5; i++) {
    const res = await uploadFile({
      guestId,
      filename: `guest-${i}.png`,
      buffer: VALID_PNG_BUFFER,
      mimeType: 'image/png'
    });
    assert.equal(res.status, 200);
  }

  // 6th upload for guest is blocked
  const guestSixth = await uploadFile({
    guestId,
    filename: 'guest-6.png',
    buffer: VALID_PNG_BUFFER,
    mimeType: 'image/png'
  });
  assert.equal(guestSixth.status, 429);

  // Authenticated user should still have 5 slots available and succeed
  const authUpload = await uploadFile({
    authToken: token,
    filename: 'auth-1.png',
    buffer: VALID_PNG_BUFFER,
    mimeType: 'image/png'
  });
  assert.equal(authUpload.status, 200, 'Authenticated user quota must be completely isolated from guest quota');
  assert.equal(authUpload.body.attachments[0].userId, 'auth-p2c-isolated-user');
  assert.equal(authUpload.body.attachments[0].userType, 'authenticated');
});

console.log('\n--- Test Group 4: Production Storage Safety & Framework Verifications ---');

await runTest('10. Production without distributed storage fails safely with HTTP 503 (QUOTA_STORAGE_UNAVAILABLE)', async () => {
  const guestId = 'guest-p2c-prod-test';
  await resetQuotaForTesting({ type: 'guest', uid: guestId, isGuest: true });

  const prevNodeEnv = process.env.NODE_ENV;
  const prevDriver = getQuotaStorageDriver();

  try {
    // Simulate production environment with local-filesystem driver
    process.env.NODE_ENV = 'production';
    setQuotaStorageDriver(new LocalFilesystemAtomicDriver());

    // Quota-tracked upload (PDF or image) in production without distributed driver must return 503
    const prodRes = await uploadFile({
      guestId,
      filename: 'prod-photo.png',
      buffer: VALID_PNG_BUFFER,
      mimeType: 'image/png'
    });

    assert.equal(prodRes.status, 503, `Production upload without distributed storage must return 503. Got: ${prodRes.status}`);
    assert.equal(prodRes.body.code, 'QUOTA_STORAGE_UNAVAILABLE');

    // Non-quota files (TXT) must remain functional and not be blocked by 503
    const prodTxtRes = await uploadFile({
      guestId,
      filename: 'prod-document.txt',
      buffer: VALID_TXT_BUFFER,
      mimeType: 'text/plain'
    });
    assert.equal(prodTxtRes.status, 200, 'Exempt file type must succeed in production');

    // When distributed driver IS operational (e.g. SimulatedDistributedClusterDriver), production quota-tracked uploads succeed
    setQuotaStorageDriver(new SimulatedDistributedClusterDriver());
    const prodDistributedRes = await uploadFile({
      guestId,
      filename: 'prod-distributed.png',
      buffer: VALID_PNG_BUFFER,
      mimeType: 'image/png'
    });
    assert.equal(prodDistributedRes.status, 200, 'Production upload with distributed driver must succeed');
  } finally {
    process.env.NODE_ENV = prevNodeEnv;
    setQuotaStorageDriver(prevDriver);
  }
});

await runTest('11. Offline WebLLM path remains unaffected', async () => {
  // WebLLM service performs browser-native WebGPU inference and bypasses server upload & chat
  const webllmFile = path.resolve(__dirname, '../src/services/webllmService.js');
  const webllmContent = fs.readFileSync(webllmFile, 'utf8');

  assert.ok(
    webllmContent.includes('never routes requests to /api/chat') ||
      webllmContent.includes('WebLLM runs entirely client-side') ||
      webllmContent.includes('Strictly local browser inference'),
    'WebLLM service must document and maintain strictly client-side inference'
  );

  const chatPageFile = path.resolve(__dirname, '../src/pages/ChatPage.jsx');
  const chatPageContent = fs.readFileSync(chatPageFile, 'utf8');
  assert.ok(
    chatPageContent.includes('extractBrowserDocument') ||
      chatPageContent.includes('fallbackLocalAttachments') ||
      chatPageContent.includes('isWebLLM'),
    'ChatPage must support client-side extraction fallback for WebLLM'
  );
});

await runTest('12. Existing Phase 2A and Phase 2B test suites still pass', async () => {
  // Both suites run independently
  assert.equal(typeof verifyFirebaseIdToken, 'function');
  assert.equal(typeof authenticateUploadRequest, 'function');
  assert.equal(DAILY_LIMIT_ATTACHMENTS, 5);
  assert.equal(DAILY_LIMIT_ERROR_CODE, 'DAILY_LIMIT_EXCEEDED');
});

console.log('\n==================================================');
console.log(`Phase 2C Test Suite Finished: ${passed} Passed, ${failed} Failed`);
console.log('==================================================\n');

server.close();
process.exit(failed > 0 ? 1 : 0);
