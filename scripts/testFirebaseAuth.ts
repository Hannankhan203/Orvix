/**
 * Orvix Firebase Token Verification Test Suite (Phase 3 Step 1)
 *
 * Tests:
 * 1. Missing Authorization header returns HTTP 401 (AUTH_TOKEN_MISSING)
 * 2. Malformed headers (wrong scheme, missing token, extra arguments) return HTTP 401 (AUTH_TOKEN_MALFORMED)
 * 3. Unconfigured service behavior returns HTTP 401 (AUTH_SERVICE_UNCONFIGURED)
 * 4. Invalid token rejection returns HTTP 401 (AUTH_TOKEN_INVALID)
 * 5. Expired token rejection returns HTTP 401 (AUTH_TOKEN_EXPIRED)
 * 6. Revoked token rejection returns HTTP 401 (AUTH_TOKEN_REVOKED)
 * 7. Successful token verification populates req.user and returns HTTP 200
 * 8. Optional auth middleware works for both anonymous and authenticated states
 * 9. User-data boundary protection remains strictly enforced (AUTH_PENDING_PHASE_3)
 * 10. Existing endpoints (/api/health, /api/config) remain fully intact
 *
 * Usage:
 *   npm run test:auth
 *   # or: npx tsx scripts/testFirebaseAuth.ts
 */

process.env.TESTING = 'true';


import express from 'express';
import type { DecodedIdToken } from 'firebase-admin/auth';
import { app, requireAuth, optionalAuth } from '../server.ts';
import {
  setMockAuthVerifierForTesting,
  resetFirebaseAdminForTesting,
  fullResetFirebaseAdminForTesting,
  verifyFirebaseIdToken
} from '../src/services/firebaseAdminService.ts';
import { extractBearerToken } from '../src/middleware/authMiddleware.ts';

// In-memory HTTP simulator for Express routing tests
async function simulateRequest(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: any,
  targetApp: any = app
): Promise<{ status: number; data: any; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const lowerHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      lowerHeaders[k.toLowerCase()] = v;
    }

    const req: any = {
      method,
      url: path,
      originalUrl: path,
      path,
      headers: lowerHeaders,
      body: body || {},
      query: {},
      params: {},
      setTimeout: () => {},
      socket: { setTimeout: () => {} },
      on: () => req,
      emit: () => true,
      listeners: () => []
    };

    let statusCode = 200;
    const resHeaders: Record<string, string> = {};
    let responseBody = '';

    const res: any = {
      statusCode: 200,
      setHeader: (key: string, val: string) => {
        resHeaders[key.toLowerCase()] = val;
      },
      getHeader: (key: string) => resHeaders[key.toLowerCase()],
      status: (code: number) => {
        statusCode = code;
        return res;
      },
      json: (obj: any) => {
        statusCode = statusCode || 200;
        resolve({ status: statusCode, data: obj, headers: resHeaders });
      },
      send: (content: any) => {
        statusCode = statusCode || 200;
        resolve({ status: statusCode, data: content, headers: resHeaders });
      },
      sendStatus: (code: number) => {
        statusCode = code;
        resolve({ status: statusCode, data: null, headers: resHeaders });
      },
      end: () => {
        resolve({ status: statusCode, data: responseBody, headers: resHeaders });
      },
      setTimeout: () => {},
      socket: { setTimeout: () => {} },
      on: () => res,
      emit: () => true,
      listeners: () => []
    };

    try {
      targetApp(req, res);
    } catch (err) {
      reject(err);
    }
  });
}

async function run() {
  console.log('====================================================');
  console.log('  Orvix Firebase Token Verification Test Suite      ');
  console.log('  Phase 3 Step 1: Server-Side Token Verification    ');
  console.log('====================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(name: string, condition: boolean, extra?: string) {
    if (condition) {
      console.log(`  ✓ ${name}`);
      passed++;
    } else {
      console.error(`  ❌ ${name}${extra ? ` - ${extra}` : ''}`);
      failed++;
    }
  }

  try {
    // ---------------------------------------------------------------------------
    // 1. Token Extraction Unit Tests
    // ---------------------------------------------------------------------------
    console.log('--- [1/6] Testing Bearer Token Extraction ---');

    const missingRes = extractBearerToken({ headers: {} } as any);
    assert('Missing header returns AUTH_TOKEN_MISSING code', missingRes.error?.code === 'AUTH_TOKEN_MISSING');

    const nonBearerRes = extractBearerToken({ headers: { authorization: 'Basic dXNlcjpwYXNz' } } as any);
    assert('Non-Bearer scheme returns AUTH_TOKEN_MALFORMED', nonBearerRes.error?.code === 'AUTH_TOKEN_MALFORMED');

    const emptyBearerRes = extractBearerToken({ headers: { authorization: 'Bearer   ' } } as any);
    assert('Empty Bearer token returns AUTH_TOKEN_MALFORMED', emptyBearerRes.error?.code === 'AUTH_TOKEN_MALFORMED');

    const multiPartRes = extractBearerToken({ headers: { authorization: 'Bearer token1 token2' } } as any);
    assert('Multi-segment Bearer returns AUTH_TOKEN_MALFORMED', multiPartRes.error?.code === 'AUTH_TOKEN_MALFORMED');

    const validBearerRes = extractBearerToken({ headers: { authorization: 'Bearer valid-sample-jwt-token' } } as any);
    assert('Valid Bearer token extracts clean token string', validBearerRes.token === 'valid-sample-jwt-token');

    // Case-insensitivity test for 'bearer'
    const lowerBearerRes = extractBearerToken({ headers: { authorization: 'bearer lowercase-scheme-jwt' } } as any);
    assert('Accepts lowercase bearer scheme', lowerBearerRes.token === 'lowercase-scheme-jwt');

    // ---------------------------------------------------------------------------
    // 2. Unconfigured Service & Missing Headers on /api/auth/verify
    // ---------------------------------------------------------------------------
    console.log('\n--- [2/6] Testing Endpoint Security (Missing / Malformed) ---');
    await fullResetFirebaseAdminForTesting();

    const noAuthReq = await simulateRequest('GET', '/api/auth/verify');
    assert('GET /api/auth/verify without header returns HTTP 401', noAuthReq.status === 401);
    assert('Response code is AUTH_TOKEN_MISSING', noAuthReq.data?.code === 'AUTH_TOKEN_MISSING');

    const malformedReq1 = await simulateRequest('GET', '/api/auth/verify', {
      authorization: 'InvalidHeaderFormat'
    });
    assert('GET /api/auth/verify with non-Bearer header returns HTTP 401', malformedReq1.status === 401);
    assert('Response code is AUTH_TOKEN_MALFORMED', malformedReq1.data?.code === 'AUTH_TOKEN_MALFORMED');

    const malformedReq2 = await simulateRequest('GET', '/api/auth/verify', {
      authorization: 'Bearer '
    });
    assert('GET /api/auth/verify with empty token returns HTTP 401', malformedReq2.status === 401);
    assert('Response code is AUTH_TOKEN_MALFORMED', malformedReq2.data?.code === 'AUTH_TOKEN_MALFORMED');

    // When no mock and no credentials configured, rejects tokens safely.
    // Temporarily isolate Firebase credential env vars in case local .env or shell is configured.
    const firebaseEnvKeys = [
      'FIREBASE_SERVICE_ACCOUNT_KEY',
      'GOOGLE_APPLICATION_CREDENTIALS',
      'FIREBASE_CLIENT_EMAIL',
      'GOOGLE_CLIENT_EMAIL',
      'FIREBASE_PRIVATE_KEY',
      'GOOGLE_PRIVATE_KEY',
      'FIREBASE_PROJECT_ID',
      'VITE_FIREBASE_PROJECT_ID',
      'GOOGLE_CLOUD_PROJECT'
    ] as const;
    const savedFirebaseEnv: Partial<Record<(typeof firebaseEnvKeys)[number], string | undefined>> = {};
    for (const key of firebaseEnvKeys) {
      savedFirebaseEnv[key] = process.env[key];
      delete process.env[key];
    }

    try {
      await fullResetFirebaseAdminForTesting();
      const unconfiguredReq = await simulateRequest('GET', '/api/auth/verify', {
        authorization: 'Bearer some-jwt-token'
      });
      assert('Unconfigured Admin SDK returns HTTP 401', unconfiguredReq.status === 401);
      assert('Response declares unconfigured service', unconfiguredReq.data?.code === 'AUTH_SERVICE_UNCONFIGURED');
    } finally {
      for (const key of firebaseEnvKeys) {
        if (savedFirebaseEnv[key] !== undefined) {
          process.env[key] = savedFirebaseEnv[key];
        } else {
          delete process.env[key];
        }
      }
    }

    // ---------------------------------------------------------------------------
    // 3. Rejection of Invalid, Expired, and Revoked Tokens
    // ---------------------------------------------------------------------------
    console.log('\n--- [3/6] Testing Cryptographic Rejection (Mocked Verifier) ---');

    // Mock: Invalid token error
    setMockAuthVerifierForTesting(async (token: string) => {
      if (token === 'invalid-token') {
        const err = new Error('Decoding Firebase ID token failed. The token is invalid.');
        (err as any).code = 'auth/invalid-id-token';
        throw err;
      }
      if (token === 'expired-token') {
        const err = new Error('Firebase ID token has expired. Get a fresh ID token and try again.');
        (err as any).code = 'auth/id-token-expired';
        throw err;
      }
      if (token === 'revoked-token') {
        const err = new Error('Firebase ID token has been revoked.');
        (err as any).code = 'auth/id-token-revoked';
        throw err;
      }
      if (token === 'valid-user-token') {
        return {
          uid: 'firebase-user-98765',
          email: 'alice@orvix.ai',
          email_verified: true,
          name: 'Alice Developer',
          aud: 'orvix-project',
          auth_time: Math.floor(Date.now() / 1000) - 100,
          exp: Math.floor(Date.now() / 1000) + 3600,
          iat: Math.floor(Date.now() / 1000) - 100,
          iss: 'https://securetoken.google.com/orvix-project',
          sub: 'firebase-user-98765',
          firebase: {
            identities: { email: ['alice@orvix.ai'] },
            sign_in_provider: 'password'
          }
        } as DecodedIdToken;
      }
      throw new Error('Unknown token rejection.');
    });

    const invalidRes = await simulateRequest('GET', '/api/auth/verify', {
      authorization: 'Bearer invalid-token'
    });
    assert('Invalid token returns HTTP 401', invalidRes.status === 401);
    assert('Invalid token returns AUTH_TOKEN_INVALID code', invalidRes.data?.code === 'AUTH_TOKEN_INVALID');

    const expiredRes = await simulateRequest('GET', '/api/auth/verify', {
      authorization: 'Bearer expired-token'
    });
    assert('Expired token returns HTTP 401', expiredRes.status === 401);
    assert('Expired token returns AUTH_TOKEN_EXPIRED code', expiredRes.data?.code === 'AUTH_TOKEN_EXPIRED');

    const revokedRes = await simulateRequest('GET', '/api/auth/verify', {
      authorization: 'Bearer revoked-token'
    });
    assert('Revoked token returns HTTP 401', revokedRes.status === 401);
    assert('Revoked token returns AUTH_TOKEN_REVOKED code', revokedRes.data?.code === 'AUTH_TOKEN_REVOKED');

    // ---------------------------------------------------------------------------
    // 4. Successful Verification & Downstream Context Propagation
    // ---------------------------------------------------------------------------
    console.log('\n--- [4/6] Testing Successful Token Verification ---');

    const successRes = await simulateRequest('GET', '/api/auth/verify', {
      authorization: 'Bearer valid-user-token'
    });
    assert('Valid token returns HTTP 200', successRes.status === 200);
    assert('Response confirms authenticated status', successRes.data?.status === 'authenticated');
    assert('Response exposes verified UID from token', successRes.data?.user?.uid === 'firebase-user-98765');
    assert('Response exposes verified email from token', successRes.data?.user?.email === 'alice@orvix.ai');
    assert('Response exposes verified displayName/name', successRes.data?.user?.name === 'Alice Developer');

    // Direct unit test of verifyFirebaseIdToken
    const decodedDirect = await verifyFirebaseIdToken('valid-user-token');
    assert('verifyFirebaseIdToken returns DecodedIdToken structure', decodedDirect.uid === 'firebase-user-98765');

    // ---------------------------------------------------------------------------
    // 5. Optional Auth Middleware Verification
    // ---------------------------------------------------------------------------
    console.log('\n--- [5/6] Testing Optional Auth Middleware ---');

    // Create a mini Express test app for testing optionalAuth directly
    const testApp = express();
    testApp.get('/test-optional', optionalAuth, (req, res) => {
      res.json({
        hasUser: Boolean(req.user),
        uid: req.user?.uid || null
      });
    });

    const optAnonymous = await simulateRequest('GET', '/test-optional', {}, undefined, testApp);
    assert('optionalAuth without header allows anonymous access (hasUser = false)', optAnonymous.status === 200 && optAnonymous.data?.hasUser === false);

    const optAuthenticated = await simulateRequest('GET', '/test-optional', {
      authorization: 'Bearer valid-user-token'
    }, undefined, testApp);
    assert('optionalAuth with valid token populates user (hasUser = true)', optAuthenticated.status === 200 && optAuthenticated.data?.hasUser === true && optAuthenticated.data?.uid === 'firebase-user-98765');

    const optInvalid = await simulateRequest('GET', '/test-optional', {
      authorization: 'Bearer invalid-token'
    }, undefined, testApp);
    assert('optionalAuth with invalid token still rejects with 401', optInvalid.status === 401);

    // ---------------------------------------------------------------------------
    // 6. Preservation of Existing Security Boundaries & Existing Endpoints
    // ---------------------------------------------------------------------------
    console.log('\n--- [6/6] Verifying Boundaries & Endpoint Preservation ---');

    // Protected endpoints require valid authentication token
    const blockedUser = await simulateRequest('GET', '/api/users/firebase-user-98765');
    assert('User endpoints require authentication (HTTP 401 AUTH_TOKEN_MISSING)', blockedUser.status === 401 && blockedUser.data?.code === 'AUTH_TOKEN_MISSING');

    const blockedChat = await simulateRequest('GET', '/api/conversations/chat-12345');
    assert('Conversation endpoints require authentication (HTTP 401 AUTH_TOKEN_MISSING)', blockedChat.status === 401 && blockedChat.data?.code === 'AUTH_TOKEN_MISSING');

    // Requirement 10: Existing endpoints intact
    const health = await simulateRequest('GET', '/api/health');
    assert('/api/health returns HTTP 200 ok', health.status === 200 && health.data?.status === 'ok');

    const config = await simulateRequest('GET', '/api/config');
    assert('/api/config returns HTTP 200', config.status === 200);
    assert('/api/config declares firebaseAdminConfigured property', 'firebaseAdminConfigured' in config.data);

    // Clean up test mocks
    resetFirebaseAdminForTesting();

    console.log('\n====================================================');
    console.log(`  Tests completed: ${passed} passed, ${failed} failed`);
    console.log('====================================================\n');

    if (failed > 0) {
      process.exit(1);
    }
  } catch (err) {
    console.error('Fatal test runner exception:', err);
    process.exit(1);
  }
}

run();
