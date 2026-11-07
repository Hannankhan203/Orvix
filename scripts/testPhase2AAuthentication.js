/**
 * ORVIX Phase 2A: Authentication & Identity Propagation Verification Suite
 *
 * Verifies that:
 * 1. Missing authentication is rejected (HTTP 401).
 * 2. Invalid or expired token is rejected (HTTP 401).
 * 3. Valid Firebase ID token is cryptographically verified and accepted (HTTP 200).
 * 4. Valid guest identity is recognized and associated with client IP (HTTP 200).
 * 5. A guest cannot impersonate an authenticated UID (HTTP 400 on invalid format; genuine UID extracted from token only).
 * 6. Existing online upload behavior remains functional (files processed, extraction working, /upload and /api/upload compatible).
 * 7. Offline WebLLM path remains unaffected.
 *
 * Run with: node scripts/testPhase2AAuthentication.js
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Set TESTING flag to prevent background dev server conflict on import
process.env.TESTING = 'true';

const {
  app,
  verifyFirebaseIdToken,
  authenticateUploadRequest,
  resolveClientIp,
  _setGoogleCertCacheForTesting
} = await import('../server.ts');

const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const testPort = server.address().port;
const BASE_URL = `http://127.0.0.1:${testPort}`;

console.log('=== ORVIX Phase 2A: Authentication & Identity Propagation Verification Suite ===\n');

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

// Generate an ephemeral RSA key pair for testing token verification
const testKeyPair = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

const TEST_KID = 'test-mock-key-1';
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
    user_id: 'firebase-user-9999',
    sub: 'firebase-user-9999',
    iat: nowSeconds - 60,
    exp: nowSeconds + 3600, // Valid for 1 hour
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

// Inject mock certificate into Google certificate cache for unit & integration testing
_setGoogleCertCacheForTesting({
  certs: {
    [TEST_KID]: testKeyPair.publicKey
  },
  expiresAt: Date.now() + 24 * 60 * 60 * 1000
});

// Helper to create a multipart boundary payload with a file
function createMultipartFormData(fieldName, filename, content, mimeType = 'text/plain') {
  const boundary = '----WebKitFormBoundary' + crypto.randomBytes(16).toString('hex');
  let body = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n`
  );
  const contentBuf = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    boundary,
    body: Buffer.concat([body, contentBuf, footer]),
    contentType: `multipart/form-data; boundary=${boundary}`
  };
}

// Create a small 1x1 valid PNG buffer for image testing
const VALID_1X1_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk length & type
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1x1 width/height
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, // 8-bit RGBA
  0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, // IDAT chunk length & type
  0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4,
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, // IEND chunk length & type
  0xae, 0x42, 0x60, 0x82
]);

// ===========================================================================
// Test Group 1: Unit Verification of Firebase ID Token Verification
// ===========================================================================
console.log('--- Test Group 1: Unit Token Verification ---');

await runTest('Unit: Valid Firebase ID token with correct claims passes verification', async () => {
  const token = createMockJwt();
  const res = await verifyFirebaseIdToken(token);
  assert.equal(res.valid, true);
  assert.equal(res.uid, 'firebase-user-9999');
  assert.equal(res.email, 'testuser@orvix.ai');
  assert.equal(res.projectId, TEST_PROJECT_ID);
});

await runTest('Unit: Expired Firebase ID token is rejected', async () => {
  const now = Math.floor(Date.now() / 1000);
  const expiredToken = createMockJwt({}, { exp: now - 120, iat: now - 3600 });
  const res = await verifyFirebaseIdToken(expiredToken);
  assert.equal(res.valid, false);
  assert.equal(res.code, 'TOKEN_EXPIRED');
});

await runTest('Unit: Token with invalid cryptographic signature is rejected', async () => {
  // Sign with a different RSA key
  const rogueKeyPair = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  const rogueToken = createMockJwt({}, {}, rogueKeyPair.privateKey);
  const res = await verifyFirebaseIdToken(rogueToken);
  assert.equal(res.valid, false);
  assert.equal(res.code, 'INVALID_SIGNATURE');
});

await runTest('Unit: Token with invalid issuer is rejected', async () => {
  const badIssuerToken = createMockJwt({}, { iss: 'https://attacker.example.com/bad' });
  const res = await verifyFirebaseIdToken(badIssuerToken);
  assert.equal(res.valid, false);
  assert.equal(res.code, 'INVALID_ISSUER');
});

await runTest('Unit: Token with empty or missing subject (uid) is rejected', async () => {
  const emptySubToken = createMockJwt({}, { sub: '', user_id: '' });
  const res = await verifyFirebaseIdToken(emptySubToken);
  assert.equal(res.valid, false);
  assert.equal(res.code, 'INVALID_SUBJECT');
});

await runTest('Unit: Token with non-RS256 algorithm (e.g. HS256) is rejected', async () => {
  const badAlgToken = createMockJwt({ alg: 'HS256' });
  const res = await verifyFirebaseIdToken(badAlgToken);
  assert.equal(res.valid, false);
  assert.equal(res.code, 'INVALID_ALGORITHM');
});

// ===========================================================================
// Test Group 2: Unit Verification of Guest Identity Handling
// ===========================================================================
console.log('\n--- Test Group 2: Unit Guest Identity Handling ---');

await runTest('Unit: Valid guest identifier format (guest-xxxxxxx) is recognized', async () => {
  const mockReq = {
    headers: { 'x-orvix-guest-id': 'guest-session-12345' },
    app: { get: () => false },
    ip: '192.168.1.50',
    socket: { remoteAddress: '192.168.1.50' }
  };
  const res = await authenticateUploadRequest(mockReq);
  assert.equal(res.success, true);
  assert.equal(res.identity.type, 'guest');
  assert.equal(res.identity.uid, 'guest-session-12345');
  assert.equal(res.identity.isGuest, true);
  assert.equal(res.identity.ip, '192.168.1.50');
});

await runTest('Unit: Guest identifier attempting to impersonate authenticated UID format is rejected', async () => {
  // Real Firebase UIDs do not start with 'guest-'
  const mockReq = {
    headers: { 'x-orvix-guest-id': '4N7rK8qLm9vXz2Yp' },
    app: { get: () => false },
    ip: '127.0.0.1'
  };
  const res = await authenticateUploadRequest(mockReq);
  assert.equal(res.success, false);
  assert.equal(res.status, 400);
  assert.equal(res.code, 'INVALID_GUEST_IDENTIFIER');
});

await runTest('Unit: Missing authentication headers return 401 AUTHENTICATION_REQUIRED', async () => {
  const mockReq = {
    headers: {},
    app: { get: () => false },
    ip: '127.0.0.1'
  };
  const res = await authenticateUploadRequest(mockReq);
  assert.equal(res.success, false);
  assert.equal(res.status, 401);
  assert.equal(res.code, 'AUTHENTICATION_REQUIRED');
});

// ===========================================================================
// Test Group 3: Live HTTP API Tests Against /api/upload & /upload
// ===========================================================================
console.log('\n--- Test Group 3: Live HTTP API Verification ---');

await runTest('API: Request without any auth header is rejected with 401 Unauthorized', async () => {
  const form = createMultipartFormData('files', 'note.txt', 'This is a test document.');
  const res = await fetch(`${BASE_URL}/api/upload`, {
    method: 'POST',
    headers: { 'Content-Type': form.contentType },
    body: form.body
  });
  assert.equal(res.status, 401);
  const data = await res.json();
  assert.equal(data.code, 'AUTHENTICATION_REQUIRED');
  assert.equal(data.status, 'UNAUTHORIZED');
});

await runTest('API: Request with invalid Bearer token is rejected with 401', async () => {
  const form = createMultipartFormData('files', 'note.txt', 'This is a test document.');
  const res = await fetch(`${BASE_URL}/api/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': form.contentType,
      'Authorization': 'Bearer invalid.token.payload'
    },
    body: form.body
  });
  assert.equal(res.status, 401);
  const data = await res.json();
  assert.equal(data.code, 'INVALID_TOKEN_ENCODING');
});

await runTest('API: Request with valid Firebase ID token is accepted and returns 200 with verified UID', async () => {
  const validToken = createMockJwt({}, { sub: 'auth-user-prod-777', user_id: 'auth-user-prod-777' });
  const form = createMultipartFormData('files', 'research.txt', 'Important research content.');
  const res = await fetch(`${BASE_URL}/api/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': form.contentType,
      'Authorization': `Bearer ${validToken}`
    },
    body: form.body
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.success, true);
  assert.equal(data.count, 1);
  assert.equal(data.attachments[0].userId, 'auth-user-prod-777');
  assert.equal(data.attachments[0].userType, 'authenticated');
  assert.equal(data.attachments[0].originalName, 'research.txt');
  assert.equal(data.attachments[0].status, 'ready');
});

await runTest('API: Request with valid X-Orvix-Guest-Id is accepted and returns 200 with guest identity', async () => {
  const guestId = 'guest-client-turn-1234';
  const form = createMultipartFormData('files', 'guest_memo.txt', 'Guest notes and thoughts.');
  const res = await fetch(`${BASE_URL}/api/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': form.contentType,
      'X-Orvix-Guest-Id': guestId
    },
    body: form.body
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.success, true);
  assert.equal(data.count, 1);
  assert.equal(data.attachments[0].userId, guestId);
  assert.equal(data.attachments[0].userType, 'guest');
});

await runTest('API: Guest passing forged userId in request body does NOT override verified identity', async () => {
  const guestId = 'guest-secure-abc';
  // Attempt to pass spoofed userId field in multipart body
  const boundary = '----BoundarySpoof' + crypto.randomBytes(8).toString('hex');
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="userId"\r\n\r\nimpersonated-admin\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="file.txt"\r\nContent-Type: text/plain\r\n\r\nHello\r\n`),
    Buffer.from(`--${boundary}--\r\n`)
  ]);

  const res = await fetch(`${BASE_URL}/api/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'X-Orvix-Guest-Id': guestId
    },
    body
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  // Server MUST use guestId and NEVER the forged body userId
  assert.equal(data.attachments[0].userId, guestId);
  assert.equal(data.attachments[0].userType, 'guest');
  assert.notEqual(data.attachments[0].userId, 'impersonated-admin');
});

await runTest('API: Uploading valid PNG image attachment returns 200 with dimensions and verified identity', async () => {
  const guestId = 'guest-vision-444';
  const form = createMultipartFormData('files', 'tiny.png', VALID_1X1_PNG, 'image/png');
  const res = await fetch(`${BASE_URL}/api/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': form.contentType,
      'X-Orvix-Guest-Id': guestId
    },
    body: form.body
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.success, true);
  assert.equal(data.attachments[0].isImage, true);
  assert.equal(data.attachments[0].dimensions.width, 1);
  assert.equal(data.attachments[0].dimensions.height, 1);
  assert.equal(data.attachments[0].userId, guestId);
});

await runTest('API: Alternative route /upload (without /api) behaves identically', async () => {
  const guestId = 'guest-alt-route';
  const form = createMultipartFormData('files', 'alt.txt', 'Alt route check');
  const res = await fetch(`${BASE_URL}/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': form.contentType,
      'X-Orvix-Guest-Id': guestId
    },
    body: form.body
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.success, true);
  assert.equal(data.attachments[0].userId, guestId);
});

// ===========================================================================
// Test Group 4: Frontend Contract & Offline WebLLM Isolation Verification
// ===========================================================================
console.log('\n--- Test Group 4: Frontend Contract & WebLLM Isolation ---');

await runTest('Frontend: ChatPage.jsx attaches Authorization Bearer for authenticated users and X-Orvix-Guest-Id for guests', () => {
  const chatPageSource = fs.readFileSync(path.resolve('src/pages/ChatPage.jsx'), 'utf-8');
  assert.ok(chatPageSource.includes("uploadHeaders['Authorization'] = `Bearer ${token}`"));
  assert.ok(chatPageSource.includes("uploadHeaders['X-Orvix-Guest-Id'] = guestId"));
  assert.ok(chatPageSource.includes("currentUser.getIdToken()"));
});

await runTest('Frontend: Offline Browser AI (WebLLM) path bypasses /api/upload completely', () => {
  const chatPageSource = fs.readFileSync(path.resolve('src/pages/ChatPage.jsx'), 'utf-8');
  // Confirm offline branch exists before the online fetch('/api/upload')
  const offlineMarker = "if (isWebLLM && !clientOnline)";
  const uploadFetchMarker = "uploadRes = await fetch('/api/upload'";
  const offlineIdx = chatPageSource.indexOf(offlineMarker);
  const fetchIdx = chatPageSource.indexOf(uploadFetchMarker);
  assert.ok(offlineIdx > 0, 'Offline WebLLM check must exist');
  assert.ok(fetchIdx > offlineIdx, 'fetch(/api/upload) must be inside online branch after offline guard');
  assert.ok(chatPageSource.includes("extractBrowserDocument(att.file"));
});

console.log(`\n========================================`);
console.log(`Phase 2A Test Suite Finished: ${passed} Passed, ${failed} Failed`);
console.log(`========================================\n`);

server.close(() => {
  process.exit(failed > 0 ? 1 : 0);
});
setTimeout(() => {
  process.exit(failed > 0 ? 1 : 0);
}, 500).unref();
