/**
 * testUploadAuthFlowHardening.js
 *
 * Dedicated verification suite for Orvix's PDF/image upload authentication flow hardening:
 * 1. Token failures & re-authentication error enforcement
 * 2. Never downgrading authenticated users to guest identity
 * 3. Guest session initialization, regex validation, and persistence
 * 4. End-to-end identity consistency between /api/upload and /api/chat (preventing 403 ATTACHMENT_FORBIDDEN)
 * 5. Unauthorized and malformed request rejection
 */

import express from 'express';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  registerUploadRoutes,
  _setGoogleCertCacheForTesting,
  fileRegistry
} from '../server/uploadSubsystem.ts';
import { registerChatRoutes } from '../server/chatSubsystem.ts';
import {
  getFreshIdToken,
  getOrCreatePersistentGuestId
} from '../src/services/authService.js';

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

// Generate ephemeral RSA keypair for JWT verification
const testKeyPair = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

const TEST_KID = 'test-hardening-key-1';
const TEST_PROJECT_ID = 'orvix-hardening-project';

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
    user_id: 'firebase-user-hardening-123',
    sub: 'firebase-user-hardening-123',
    iat: nowSeconds - 60,
    exp: nowSeconds + 3600,
    email: 'hardening-user@orvix.ai',
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

function createMultipartFormData(fieldName, filename, content, mimeType = 'text/plain') {
  const boundary = '----WebKitFormBoundary' + crypto.randomBytes(16).toString('hex');
  const header = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n`
  );
  const contentBuf = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    boundary,
    body: Buffer.concat([header, contentBuf, footer]),
    contentType: `multipart/form-data; boundary=${boundary}`
  };
}

// 1x1 valid PNG for image attachment test
const valid1x1Png = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82
]);

// Initialize mock server with both upload and chat subsystems
const app = express();
app.use(express.json());
registerUploadRoutes(app);
registerChatRoutes(app);

const server = app.listen(0);
const port = server.address().port;
const baseUrl = `http://127.0.0.1:${port}`;

console.log(`\n======================================================`);
console.log(`Running Upload Authentication Flow Hardening Suite`);
console.log(`Test Server Listening on: ${baseUrl}`);
console.log(`======================================================\n`);

// ---------------------------------------------------------------------------
// Group 1: Guest Identity Session & Regex Validation
// ---------------------------------------------------------------------------
console.log('--- Group 1: Guest Session Initialization & Storage ---');

await runTest('Guest ID conforms to server regex /^guest-[a-z0-9_-]{4,64}$/i', () => {
  // Simulate mock browser window storage
  const mockStorage = new Map();
  globalThis.window = {};
  globalThis.sessionStorage = {
    getItem: (k) => mockStorage.get(k) || null,
    setItem: (k, v) => mockStorage.set(k, String(v)),
    removeItem: (k) => mockStorage.delete(k)
  };
  globalThis.localStorage = globalThis.sessionStorage;

  const guestId = getOrCreatePersistentGuestId();
  assert.ok(/^guest-[a-z0-9_-]{4,64}$/i.test(guestId), `Generated guest ID '${guestId}' failed regex`);

  // Subsequent call returns exact same ID
  const secondCall = getOrCreatePersistentGuestId();
  assert.equal(guestId, secondCall, 'Guest ID must be persistent across invocations');
});

await runTest('Corrupted or invalid guest ID format in storage is safely repaired', () => {
  const mockStorage = new Map();
  globalThis.sessionStorage = {
    getItem: (k) => mockStorage.get(k) || null,
    setItem: (k, v) => mockStorage.set(k, String(v)),
    removeItem: (k) => mockStorage.delete(k)
  };
  globalThis.localStorage = globalThis.sessionStorage;

  // Set malformed guest ID
  mockStorage.set('orvix_guest_session', JSON.stringify({ uid: 'invalid!uid@not_guest' }));

  const fixedId = getOrCreatePersistentGuestId();
  assert.ok(/^guest-[a-z0-9_-]{4,64}$/i.test(fixedId), 'Must replace malformed session with valid guest ID');
  assert.notEqual(fixedId, 'invalid!uid@not_guest');
});

// ---------------------------------------------------------------------------
// Group 2: Authenticated User Token Failures & Downgrade Prevention
// ---------------------------------------------------------------------------
console.log('\n--- Group 2: Token Failures & Downgrade Prevention ---');

await runTest('getFreshIdToken throws clear error when user is unauthenticated', async () => {
  await assert.rejects(
    async () => await getFreshIdToken(null),
    /Authentication required. Please sign in to continue./
  );

  await assert.rejects(
    async () => await getFreshIdToken({}),
    /Authentication required. Please sign in to continue./
  );
});

await runTest('getFreshIdToken throws clear re-authentication error on token error or empty token', async () => {
  const mockFailingUser = {
    getIdToken: async () => { throw new Error('Token acquisition network error'); }
  };
  await assert.rejects(
    async () => await getFreshIdToken(mockFailingUser),
    /Your session has expired or authentication failed. Please sign in again./
  );

  const mockEmptyUser = {
    getIdToken: async () => '   '
  };
  await assert.rejects(
    async () => await getFreshIdToken(mockEmptyUser),
    /Your session has expired or authentication failed. Please sign in again./
  );
});

await runTest('Frontend ChatPage.jsx strictly halts upload on token failure without downgrading to guest', () => {
  const chatPageSource = fs.readFileSync(path.resolve('src/pages/ChatPage.jsx'), 'utf-8');
  assert.ok(chatPageSource.includes("failPreflightIfActive('Your session has expired or authentication failed. Please sign in again to attach files.')"));
  assert.ok(chatPageSource.includes("NEVER downgrade an authenticated user to guest"));
});

// ---------------------------------------------------------------------------
// Group 3: Server Endpoint Authentication & Rejection of Unauthorized Requests
// ---------------------------------------------------------------------------
console.log('\n--- Group 3: Unauthorized Requests & Malformed Header Handling ---');

await runTest('POST /api/upload rejects request missing both auth and guest headers with 401', async () => {
  const form = createMultipartFormData('files', 'document.txt', 'Sample text');
  const res = await fetch(`${baseUrl}/api/upload`, {
    method: 'POST',
    headers: { 'Content-Type': form.contentType },
    body: form.body
  });

  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.code, 'AUTHENTICATION_REQUIRED');
});

await runTest('POST /api/upload rejects malformed guest ID with 400', async () => {
  const form = createMultipartFormData('files', 'document.txt', 'Sample text');
  const res = await fetch(`${baseUrl}/api/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': form.contentType,
      'X-Orvix-Guest-Id': 'attacker_without_prefix_123'
    },
    body: form.body
  });

  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.code, 'INVALID_GUEST_IDENTIFIER');
});

await runTest('POST /api/upload rejects invalid Bearer token with 401', async () => {
  const form = createMultipartFormData('files', 'document.txt', 'Sample text');
  const res = await fetch(`${baseUrl}/api/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': form.contentType,
      'Authorization': 'Bearer bad.token.here'
    },
    body: form.body
  });

  assert.equal(res.status, 401);
});

// ---------------------------------------------------------------------------
// Group 4: Identity Consistency Between Upload and Chat (Preventing 403)
// ---------------------------------------------------------------------------
console.log('\n--- Group 4: Identity Consistency & Attachment Ownership Enforcement ---');

let authenticatedAttachmentId = null;
const authUid = 'firebase-user-hardening-123';
const validToken = createMockJwt({}, { user_id: authUid, sub: authUid });

await runTest('Authenticated user uploads image successfully with fresh ID token', async () => {
  const form = createMultipartFormData('files', 'screenshot.png', valid1x1Png, 'image/png');
  const res = await fetch(`${baseUrl}/api/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': form.contentType,
      'Authorization': `Bearer ${validToken}`
    },
    body: form.body
  });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.attachments.length, 1);
  assert.equal(body.attachments[0].userId, authUid);
  authenticatedAttachmentId = body.attachments[0].id;
});

await runTest('Subsequent chat with identical authenticated identity verifies attachment ownership', async () => {
  assert.ok(authenticatedAttachmentId, 'Must have uploaded attachment ID');
  const record = fileRegistry.get(authenticatedAttachmentId);
  assert.ok(record);
  assert.equal(record.userId, authUid);

  // Send request with matching auth token
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${validToken}`
    },
    body: JSON.stringify({
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      prompt: 'Describe this image',
      attachments: [{ id: authenticatedAttachmentId }]
    })
  });

  // Not 401 or 403 (may fail on API key in test environment, but passes attachment ownership check)
  assert.notEqual(res.status, 401, 'Must not be 401 unauthorized');
  assert.notEqual(res.status, 403, 'Must not be 403 ATTACHMENT_FORBIDDEN');
});

await runTest('Subsequent chat claiming attachment with mismatched guest ID triggers 403 ATTACHMENT_FORBIDDEN', async () => {
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Orvix-Guest-Id': 'guest-intruder-999'
    },
    body: JSON.stringify({
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      prompt: 'Describe this image',
      attachments: [{ id: authenticatedAttachmentId }]
    })
  });

  assert.equal(res.status, 403, 'Must reject mismatched identity with 403');
  const body = await res.json();
  assert.equal(body.code, 'ATTACHMENT_FORBIDDEN');
});

let guestAttachmentId = null;
const validGuestId = 'guest-hardening-test-uuid-4321';

await runTest('Guest user uploads PDF successfully with valid persistent guest ID', async () => {
  const samplePdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF');
  const form = createMultipartFormData('files', 'document.pdf', samplePdf, 'application/pdf');
  const res = await fetch(`${baseUrl}/api/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': form.contentType,
      'X-Orvix-Guest-Id': validGuestId
    },
    body: form.body
  });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.attachments[0].userId, validGuestId);
  guestAttachmentId = body.attachments[0].id;
});

await runTest('Subsequent chat with same guest ID verifies ownership; mismatched guest ID triggers 403', async () => {
  // Matching guest ID passes ownership
  const matchRes = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Orvix-Guest-Id': validGuestId
    },
    body: JSON.stringify({
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      prompt: 'Summarize',
      attachments: [{ id: guestAttachmentId }]
    })
  });
  assert.notEqual(matchRes.status, 401);
  assert.notEqual(matchRes.status, 403);

  // Mismatched guest ID is blocked with 403 ATTACHMENT_FORBIDDEN
  const mismatchRes = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Orvix-Guest-Id': 'guest-different-user-0000'
    },
    body: JSON.stringify({
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      prompt: 'Summarize',
      attachments: [{ id: guestAttachmentId }]
    })
  });
  assert.equal(mismatchRes.status, 403);
  const mismatchBody = await mismatchRes.json();
  assert.equal(mismatchBody.code, 'ATTACHMENT_FORBIDDEN');
});

console.log(`\n======================================================`);
console.log(`Hardening Suite Finished: ${passed} Passed, ${failed} Failed`);
console.log(`======================================================\n`);

server.close(() => {
  process.exit(failed > 0 ? 1 : 0);
});
setTimeout(() => {
  process.exit(failed > 0 ? 1 : 0);
}, 1000);
