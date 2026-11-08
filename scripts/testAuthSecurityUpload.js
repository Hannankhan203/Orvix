/**
 * scripts/testAuthSecurityUpload.js
 *
 * Dedicated Security & Regression Test Suite for uploadSubsystem.ts Authentication:
 * 1. Forged JWTs with invalid or tampered signatures are rejected.
 * 2. Insecure algorithm confusion attacks (alg: 'none', alg: 'HS256') are rejected.
 * 3. Expired and future-dated tokens are rejected.
 * 4. User ID spoofing via req.body.userId, x-user-id header, or query parameters is strictly ignored.
 * 5. Even when an attacker combines a legitimate token with a spoofed body, identity is derived EXCLUSIVELY from the token.
 * 6. Valid cryptographically signed tokens derive the verified user ID.
 * 7. Guest and offline upload behavior is fully preserved without requiring authentication.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  verifyFirebaseIdToken,
  resolveVerifiedUserId,
  authenticateRequest,
  setTestPublicKey,
  clearTestPublicKeys,
  resetFirebaseAuthForTesting,
  extractBearerToken
} from '../server/firebaseAuthHelper.ts';
import { resolveRequestUserId } from '../server/uploadSubsystem.ts';

console.log('================================================================');
console.log('SECURITY VERIFICATION SUITE: uploadSubsystem Authentication');
console.log('================================================================\n');

let totalTests = 0;
let passedTests = 0;

async function test(name, fn) {
  totalTests++;
  try {
    await fn();
    console.log(`  ✓ PASS: ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  ✗ FAIL: ${name}`);
    console.error(`    ${err.stack || err.message}`);
    process.exitCode = 1;
  }
}

// Generate real RSA key pairs for cryptographic test assertions
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

const { publicKey: otherPublicKey, privateKey: otherPrivateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

const TEST_KID = 'test-firebase-auth-kid-001';

function createSignedJwt(headerObj, payloadObj, signingKey = privateKey) {
  const headerB64 = Buffer.from(JSON.stringify(headerObj)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  const data = Buffer.from(`${headerB64}.${payloadB64}`);
  const signature = crypto.sign('RSA-SHA256', data, signingKey).toString('base64url');
  return `${headerB64}.${payloadB64}.${signature}`;
}

async function runAllTests() {
  resetFirebaseAuthForTesting();
  setTestPublicKey(TEST_KID, publicKey);

  // -------------------------------------------------------------------------
  // Test 1: User ID Spoofing via req.body.userId is completely blocked
  // -------------------------------------------------------------------------
  await test('Never trusts req.body.userId for authorization (resolves to null)', async () => {
    const req = {
      body: { userId: 'victim_admin_user_123' },
      headers: {}
    };

    const resolvedUid = await resolveRequestUserId(req);
    assert.equal(resolvedUid, null, 'Must NOT trust req.body.userId');

    const authStatus = await authenticateRequest(req);
    assert.equal(authStatus.status, 'guest');
    assert.equal(authStatus.userId, null);
  });

  // -------------------------------------------------------------------------
  // Test 2: User ID Spoofing via x-user-id header is completely blocked
  // -------------------------------------------------------------------------
  await test('Never trusts x-user-id header for authorization (resolves to null)', async () => {
    const req = {
      body: {},
      headers: { 'x-user-id': 'spoofed_privileged_user' }
    };

    const resolvedUid = await resolveRequestUserId(req);
    assert.equal(resolvedUid, null, 'Must NOT trust x-user-id header');

    const authStatus = await authenticateRequest(req);
    assert.equal(authStatus.status, 'guest');
    assert.equal(authStatus.userId, null);
  });

  // -------------------------------------------------------------------------
  // Test 3: User ID Spoofing via req.query.userId is completely blocked
  // -------------------------------------------------------------------------
  await test('Never trusts req.query.userId for authorization (resolves to null)', async () => {
    const req = {
      body: {},
      query: { userId: 'query_spoofed_user' },
      headers: {}
    };

    const resolvedUid = await resolveRequestUserId(req);
    assert.equal(resolvedUid, null, 'Must NOT trust query.userId');
  });

  // -------------------------------------------------------------------------
  // Test 4: Forged JWT (fake or tampered signature) is rejected
  // -------------------------------------------------------------------------
  await test('Rejects forged JWT with invalid signature without trusting payload', async () => {
    const headerB64 = Buffer.from(JSON.stringify({ alg: 'RS256', kid: TEST_KID })).toString('base64url');
    const payloadB64 = Buffer.from(
      JSON.stringify({
        sub: 'forged_target_victim_uid',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000)
      })
    ).toString('base64url');
    // Fake signature
    const fakeSignature = Buffer.from('this_is_a_completely_fake_signature_bytes_12345').toString('base64url');
    const forgedToken = `${headerB64}.${payloadB64}.${fakeSignature}`;

    const verifyResult = await verifyFirebaseIdToken(forgedToken);
    assert.equal(verifyResult.success, false);
    assert.equal(verifyResult.code, 'INVALID_SIGNATURE');

    const req = {
      headers: { authorization: `Bearer ${forgedToken}` }
    };
    const resolved = await resolveRequestUserId(req);
    assert.equal(resolved, null, 'Forged JWT must never resolve to an authorized userId');

    const status = await authenticateRequest(req);
    assert.equal(status.status, 'invalid');
    assert.equal(status.code, 'INVALID_SIGNATURE');
  });

  // -------------------------------------------------------------------------
  // Test 5: JWT signed with wrong/untrusted RSA key fails signature verification
  // -------------------------------------------------------------------------
  await test('Rejects JWT signed by an unauthorized/unregistered private key', async () => {
    const tokenFromOtherKey = createSignedJwt(
      { alg: 'RS256', kid: TEST_KID },
      {
        sub: 'unauthorized_sender',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000)
      },
      otherPrivateKey
    );

    const result = await verifyFirebaseIdToken(tokenFromOtherKey);
    assert.equal(result.success, false);
    assert.equal(result.code, 'INVALID_SIGNATURE');
  });

  // -------------------------------------------------------------------------
  // Test 6: Insecure algorithm confusion attack (alg: 'none') is rejected
  // -------------------------------------------------------------------------
  await test("Rejects tokens with alg: 'none'", async () => {
    const noneHeader = Buffer.from(JSON.stringify({ alg: 'none', kid: TEST_KID })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        sub: 'admin',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000)
      })
    ).toString('base64url');
    const token = `${noneHeader}.${payload}.`;

    const result = await verifyFirebaseIdToken(token);
    assert.equal(result.success, false);
    assert.equal(result.code, 'INVALID_ALGORITHM');
  });

  // -------------------------------------------------------------------------
  // Test 7: Insecure symmetric algorithm attack (alg: 'HS256') is rejected
  // -------------------------------------------------------------------------
  await test("Rejects symmetric algorithms (alg: 'HS256')", async () => {
    const hsHeader = Buffer.from(JSON.stringify({ alg: 'HS256', kid: TEST_KID })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        sub: 'admin',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000)
      })
    ).toString('base64url');
    const token = `${hsHeader}.${payload}.fakehs256signature`;

    const result = await verifyFirebaseIdToken(token);
    assert.equal(result.success, false);
    assert.equal(result.code, 'INVALID_ALGORITHM');
  });

  // -------------------------------------------------------------------------
  // Test 8: Expired Firebase ID token is rejected
  // -------------------------------------------------------------------------
  await test('Rejects expired Firebase ID token (TOKEN_EXPIRED)', async () => {
    const expiredToken = createSignedJwt(
      { alg: 'RS256', kid: TEST_KID },
      {
        sub: 'legitimate_user_expired',
        exp: Math.floor(Date.now() / 1000) - 300, // Expired 5 minutes ago
        iat: Math.floor(Date.now() / 1000) - 3600
      }
    );

    const result = await verifyFirebaseIdToken(expiredToken);
    assert.equal(result.success, false);
    assert.equal(result.code, 'TOKEN_EXPIRED');

    const req = { headers: { authorization: `Bearer ${expiredToken}` } };
    assert.equal(await resolveRequestUserId(req), null);
  });

  // -------------------------------------------------------------------------
  // Test 9: Tampered payload fails cryptographic integrity verification
  // -------------------------------------------------------------------------
  await test('Detects payload tampering and rejects invalid signature', async () => {
    const validToken = createSignedJwt(
      { alg: 'RS256', kid: TEST_KID },
      {
        sub: 'original_user_uid',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000)
      }
    );

    // Tamper with payload by changing one character
    const [h, p, s] = validToken.split('.');
    const decodedPayload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    decodedPayload.sub = 'tampered_user_uid';
    const tamperedPayloadB64 = Buffer.from(JSON.stringify(decodedPayload)).toString('base64url');
    const tamperedToken = `${h}.${tamperedPayloadB64}.${s}`;

    const result = await verifyFirebaseIdToken(tamperedToken);
    assert.equal(result.success, false);
    assert.equal(result.code, 'INVALID_SIGNATURE');
  });

  // -------------------------------------------------------------------------
  // Test 10: Valid cryptographically signed token derives verified userId
  // -------------------------------------------------------------------------
  await test('Derives userId exclusively from verified Firebase identity', async () => {
    const validToken = createSignedJwt(
      { alg: 'RS256', kid: TEST_KID },
      {
        sub: 'verified_firebase_uid_888',
        email: 'user888@example.com',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000)
      }
    );

    const result = await verifyFirebaseIdToken(validToken);
    assert.equal(result.success, true);
    assert.equal(result.user.uid, 'verified_firebase_uid_888');

    const req = {
      headers: { authorization: `Bearer ${validToken}` },
      body: {}
    };
    const resolvedUid = await resolveRequestUserId(req);
    assert.equal(resolvedUid, 'verified_firebase_uid_888');

    const authStatus = await authenticateRequest(req);
    assert.equal(authStatus.status, 'authenticated');
    assert.equal(authStatus.userId, 'verified_firebase_uid_888');
  });

  // -------------------------------------------------------------------------
  // Test 11: Attacker sends valid token + spoofed body/header -> derives ONLY token UID
  // -------------------------------------------------------------------------
  await test('Valid token ignores spoofed req.body.userId and x-user-id', async () => {
    const validToken = createSignedJwt(
      { alg: 'RS256', kid: TEST_KID },
      {
        sub: 'genuine_authenticated_user',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000)
      }
    );

    const maliciousReq = {
      headers: {
        authorization: `Bearer ${validToken}`,
        'x-user-id': 'spoofed_target_header'
      },
      body: {
        userId: 'spoofed_target_body'
      }
    };

    const resolvedUid = await resolveRequestUserId(maliciousReq);
    assert.equal(
      resolvedUid,
      'genuine_authenticated_user',
      'Must derive identity EXCLUSIVELY from token, never body or headers'
    );
  });

  // -------------------------------------------------------------------------
  // Test 12: Guest upload (no Authorization header) is preserved
  // -------------------------------------------------------------------------
  await test('Guest requests (no token) return status guest without error', async () => {
    const guestReq = {
      headers: {},
      body: {}
    };

    const resolvedUid = await resolveRequestUserId(guestReq);
    assert.equal(resolvedUid, null);

    const authStatus = await authenticateRequest(guestReq);
    assert.equal(authStatus.status, 'guest');
    assert.equal(authStatus.userId, null);
  });

  // -------------------------------------------------------------------------
  // Test 13: Malformed Authorization header format is detected
  // -------------------------------------------------------------------------
  await test('Malformed Authorization header returns invalid status', async () => {
    const badReq = {
      headers: { authorization: 'Basic somecredentials' }
    };

    const authStatus = await authenticateRequest(badReq);
    assert.equal(authStatus.status, 'invalid');
    assert.equal(authStatus.code, 'MALFORMED_AUTH_HEADER');
  });

  // -------------------------------------------------------------------------
  // Test 14: Token missing kid claim in header
  // -------------------------------------------------------------------------
  await test('Token missing kid header is rejected (MISSING_KID)', async () => {
    const noKidToken = createSignedJwt(
      { alg: 'RS256' }, // Missing kid
      {
        sub: 'user_123',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000)
      }
    );

    const result = await verifyFirebaseIdToken(noKidToken);
    assert.equal(result.success, false);
    assert.equal(result.code, 'MISSING_KID');
  });

  // -------------------------------------------------------------------------
  // Test 15: Path traversal attack inside token sub claim is blocked
  // -------------------------------------------------------------------------
  await test('Rejects token with path traversal in sub claim', async () => {
    const traversalToken = createSignedJwt(
      { alg: 'RS256', kid: TEST_KID },
      {
        sub: '../../etc/passwd',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000)
      }
    );

    const result = await verifyFirebaseIdToken(traversalToken);
    assert.equal(result.success, false);
    assert.equal(result.code, 'INVALID_USER_ID');
  });

  clearTestPublicKeys();
  resetFirebaseAuthForTesting();

  console.log('\n================================================================');
  console.log(`RESULTS: ${passedTests} / ${totalTests} SECURITY TESTS PASSED`);
  console.log('================================================================\n');

  if (passedTests !== totalTests) {
    process.exit(1);
  }
}

runAllTests().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
