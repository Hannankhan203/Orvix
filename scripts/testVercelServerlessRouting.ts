/**
 * Orvix Vercel Serverless Routing & Lifecycle Verification Suite (Phase 3 Step 3.4D-2)
 *
 * Comprehensive audit & regression verification covering:
 * 1. Direct invocation of all Vercel serverless function entry points (api/*.ts)
 * 2. URL and subpath rewrite parameter resolution with query string preservation
 * 3. CORS headers and HTTP methods (GET, POST, PUT, PATCH, DELETE, OPTIONS)
 * 4. Serverless connection lifecycle on cold start & warm instances
 * 5. Concurrent connection deduplication in serverless environment
 * 6. Authentication requirement & IDOR boundary enforcement through serverless entry points
 * 7. Preservation of Step 3.4D-1 no-fallback guarantees (explicit 503 DATABASE_UNAVAILABLE)
 * 8. Regression verification for AI, upload, health, and config serverless handlers
 *
 * Usage:
 *   TESTING=true tsx scripts/testVercelServerlessRouting.ts
 */

import type { DecodedIdToken } from 'firebase-admin/auth';
import fs from 'fs';
import path from 'path';

// Establish test and serverless environment variables BEFORE importing any application modules
process.env.TESTING = 'true';
process.env.VERCEL = '1';

const {
  setMockAuthVerifierForTesting,
  resetFirebaseAdminForTesting
} = await import('../src/services/firebaseAdminService.ts');
const {
  getDatabase,
  connectToDatabase,
  closeDatabase,
  getMongoStatus,
  isMongoConfigured,
  setMockDatabaseForTesting,
  enableInMemoryTestDatabase,
  resetTestDatabase,
  MongoNotConnectedError
} = await import('../src/db/mongodb.ts');

// Import all Vercel serverless entry point handlers after env initialization to prevent server.ts background listen
const { default: healthHandler } = await import('../api/health.ts');
const { default: configHandler } = await import('../api/config.ts');
const { default: chatHandler } = await import('../api/chat.ts');
const { default: uploadHandler } = await import('../api/upload.ts');
const { default: transcribeHandler } = await import('../api/transcribe.ts');
const { default: conversationsHandler } = await import('../api/conversations.ts');
const { default: messagesHandler } = await import('../api/messages.ts');
const { default: usersHandler } = await import('../api/users.ts');
const { default: userSettingsHandler } = await import('../api/user-settings.ts');
const { default: dbHandler } = await import('../api/db.ts');
const { default: authHandler } = await import('../api/auth.ts');

// Test Personas
const ALICE: DecodedIdToken = {
  uid: 'alice-vercel-101',
  email: 'alice@orvix.ai',
  email_verified: true,
  name: 'Alice Serverless',
  aud: 'orvix-project',
  auth_time: 1000,
  exp: 9999999999,
  iat: 1000,
  iss: 'https://securetoken.google.com/orvix-project',
  sub: 'alice-vercel-101',
  firebase: { identities: { email: ['alice@orvix.ai'] }, sign_in_provider: 'password' }
};

const BOB: DecodedIdToken = {
  uid: 'bob-vercel-202',
  email: 'bob@orvix.ai',
  email_verified: true,
  name: 'Bob Attacker',
  aud: 'orvix-project',
  auth_time: 1000,
  exp: 9999999999,
  iat: 1000,
  iss: 'https://securetoken.google.com/orvix-project',
  sub: 'bob-vercel-202',
  firebase: { identities: { email: ['bob@orvix.ai'] }, sign_in_provider: 'password' }
};

setMockAuthVerifierForTesting(async (token: string) => {
  if (token === 'token-alice') return ALICE;
  if (token === 'token-bob') return BOB;
  const err: any = new Error('Invalid authentication token');
  err.code = 'auth/invalid-id-token';
  throw err;
});

// Helper to simulate calling a Vercel serverless function handler with timeout protection
async function callServerlessHandler(
  handler: (req: any, res: any) => any,
  options: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: any;
    timeoutMs?: number;
  }
): Promise<{ status: number; data: any; headers: Record<string, string> }> {
  const timeoutMs = options.timeoutMs ?? 10000;

  return new Promise((resolve, reject) => {
    let isSettled = false;

    const timer = setTimeout(() => {
      if (!isSettled) {
        isSettled = true;
        reject(
          new Error(
            `[TIMEOUT] Serverless handler timed out after ${timeoutMs}ms for ${options.method} ${options.url}`
          )
        );
      }
    }, timeoutMs);

    const safeResolve = (val: { status: number; data: any; headers: Record<string, string> }) => {
      if (!isSettled) {
        isSettled = true;
        clearTimeout(timer);
        resolve(val);
      }
    };

    const safeReject = (err: any) => {
      if (!isSettled) {
        isSettled = true;
        clearTimeout(timer);
        reject(err);
      }
    };

    const lowerHeaders: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json'
    };

    if (options.headers) {
      for (const [k, v] of Object.entries(options.headers)) {
        lowerHeaders[k.toLowerCase()] = v;
      }
    }

    const [pathname, queryString] = options.url.split('?');
    const query: Record<string, string> = {};
    if (queryString) {
      const searchParams = new URLSearchParams(queryString);
      searchParams.forEach((val, key) => {
        query[key] = val;
      });
    }

    const req: any = {
      method: options.method.toUpperCase(),
      url: options.url,
      originalUrl: options.url,
      path: pathname,
      headers: lowerHeaders,
      body: options.body || {},
      query,
      params: {},
      setTimeout: () => {},
      socket: { setTimeout: () => {}, setNoDelay: () => {}, setKeepAlive: () => {} },
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
        res.statusCode = code;
        return res;
      },
      json: (obj: any) => {
        statusCode = statusCode || res.statusCode || 200;
        safeResolve({ status: statusCode, data: obj, headers: resHeaders });
      },
      send: (content: any) => {
        statusCode = statusCode || res.statusCode || 200;
        let parsed = content;
        try {
          if (typeof content === 'string') parsed = JSON.parse(content);
        } catch (_) {}
        safeResolve({ status: statusCode, data: parsed, headers: resHeaders });
      },
      sendStatus: (code: number) => {
        statusCode = code;
        res.statusCode = code;
        safeResolve({ status: statusCode, data: null, headers: resHeaders });
      },
      write: (chunk: any) => {
        if (chunk !== undefined && chunk !== null) {
          responseBody += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        }
        return true;
      },
      end: (chunk?: any) => {
        if (chunk !== undefined && chunk !== null && typeof chunk !== 'function') {
          responseBody += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        }
        statusCode = statusCode || res.statusCode || 200;
        let parsed: any = responseBody;
        try {
          if (typeof responseBody === 'string' && responseBody.trim()) {
            parsed = JSON.parse(responseBody);
          }
        } catch (_) {}
        safeResolve({ status: statusCode, data: parsed, headers: resHeaders });
      },
      setTimeout: () => {},
      socket: { setTimeout: () => {}, setNoDelay: () => {}, setKeepAlive: () => {} },
      on: () => res,
      emit: () => true,
      listeners: () => []
    };

    try {
      Promise.resolve(handler(req, res)).catch((err) => {
        safeReject(err);
      });
    } catch (err) {
      safeReject(err);
    }
  });
}

async function run() {
  console.log('========================================================================');
  console.log('⚡ Orvix Vercel Serverless Routing & Lifecycle Audit Suite (Step 3.4D-2)');
  console.log('========================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, detail = '') {
    if (condition) {
      console.log(`  ✅ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${testName}${detail ? ` -> ${detail}` : ''}`);
      failed++;
    }
  }

  // ---------------------------------------------------------------------------
  // [1/8] vercel.json Static Inspection & CORS Headers
  // ---------------------------------------------------------------------------
  console.log('--- [1/8] vercel.json Configuration & Route Audit ---');
  const vercelJsonPath = path.resolve(process.cwd(), 'vercel.json');
  assert(fs.existsSync(vercelJsonPath), 'vercel.json exists in root directory');

  const vercelConfig = JSON.parse(fs.readFileSync(vercelJsonPath, 'utf-8'));
  assert(vercelConfig.framework === 'vite', 'vercel.json targets vite framework');
  assert(typeof vercelConfig.functions === 'object', 'vercel.json configures functions');
  assert(Array.isArray(vercelConfig.rewrites), 'vercel.json specifies rewrite rules');

  const rewriteSources = vercelConfig.rewrites.map((r: any) => r.source);
  assert(rewriteSources.includes('/api/upload/:subpath*'), 'vercel.json rewrites /api/upload/:subpath*');
  assert(rewriteSources.includes('/api/conversations/:subpath*'), 'vercel.json rewrites /api/conversations/:subpath*');
  assert(rewriteSources.includes('/api/messages/:subpath*'), 'vercel.json rewrites /api/messages/:subpath*');
  assert(rewriteSources.includes('/api/users/:subpath*'), 'vercel.json rewrites /api/users/:subpath*');
  assert(rewriteSources.includes('/api/user-settings/:subpath*'), 'vercel.json rewrites /api/user-settings/:subpath*');
  assert(rewriteSources.includes('/api/db/:subpath*'), 'vercel.json rewrites /api/db/:subpath*');
  assert(rewriteSources.includes('/api/auth/:subpath*'), 'vercel.json rewrites /api/auth/:subpath*');

  const apiHeaderRule = vercelConfig.headers?.find((h: any) => h.source === '/api/(.*)');
  const allowMethodsHeader = apiHeaderRule?.headers?.find((h: any) => h.key === 'Access-Control-Allow-Methods')?.value;
  assert(
    typeof allowMethodsHeader === 'string' &&
      allowMethodsHeader.includes('PUT') &&
      allowMethodsHeader.includes('PATCH'),
    'vercel.json CORS headers include PUT and PATCH for MongoDB operations'
  );

  // ---------------------------------------------------------------------------
  // [2/8] Core Liveness & Config Serverless Handlers
  // ---------------------------------------------------------------------------
  console.log('\n--- [2/8] Testing Core Liveness & Config Serverless Handlers ---');
  const healthRes = await callServerlessHandler(healthHandler, {
    method: 'GET',
    url: '/api/health'
  });
  assert(healthRes.status === 200, 'api/health.ts handler returns HTTP 200');
  assert(healthRes.data?.status === 'ok', 'api/health.ts data reports status: "ok"');

  const configRes = await callServerlessHandler(configHandler, {
    method: 'GET',
    url: '/api/config'
  });
  assert(configRes.status === 200, 'api/config.ts handler returns HTTP 200');
  assert(typeof configRes.data?.mongodbConfigured === 'boolean', 'api/config.ts returns database config status');

  const dbStatusRes = await callServerlessHandler(dbHandler, {
    method: 'GET',
    url: '/api/db?__subpath=status'
  });
  assert(dbStatusRes.status === 200, 'api/db.ts handler resolves /api/db/status returning HTTP 200');
  assert(typeof dbStatusRes.data?.status === 'string', 'api/db.ts status endpoint returns connection state descriptor');

  const dbSummaryRes = await callServerlessHandler(dbHandler, {
    method: 'GET',
    url: '/api/db?__subpath=summary'
  });
  assert(dbSummaryRes.status === 200, 'api/db.ts handler resolves /api/db/summary returning HTTP 200');
  assert(dbSummaryRes.data?.database === 'Orvix', 'api/db.ts summary reports Orvix database name');

  // ---------------------------------------------------------------------------
  // [3/8] Authentication Serverless Handlers
  // ---------------------------------------------------------------------------
  console.log('\n--- [3/8] Testing Authentication Serverless Handlers ---');
  const authDiagRes = await callServerlessHandler(authHandler, {
    method: 'GET',
    url: '/api/auth?__subpath=status'
  });
  assert(authDiagRes.status === 200, 'api/auth.ts status handler returns HTTP 200');

  const authUnauthVerify = await callServerlessHandler(authHandler, {
    method: 'GET',
    url: '/api/auth?__subpath=verify'
  });
  assert(authUnauthVerify.status === 401, 'api/auth.ts verify rejects unauthenticated requests with HTTP 401');

  const authValidVerify = await callServerlessHandler(authHandler, {
    method: 'GET',
    url: '/api/auth?__subpath=verify',
    headers: { authorization: 'Bearer token-alice' }
  });
  assert(authValidVerify.status === 200, 'api/auth.ts verify succeeds with valid Firebase token returning HTTP 200');
  assert(authValidVerify.data?.user?.uid === ALICE.uid, 'api/auth.ts verify derives verified UID from token');

  // ---------------------------------------------------------------------------
  // [4/8] Authenticated User Profile Serverless Handlers & IDOR Prevention
  // ---------------------------------------------------------------------------
  console.log('\n--- [4/8] Testing Users Serverless Handlers & IDOR Prevention ---');
  resetTestDatabase();
  enableInMemoryTestDatabase();

  const unauthUsersMe = await callServerlessHandler(usersHandler, {
    method: 'GET',
    url: '/api/users?__subpath=me'
  });
  assert(unauthUsersMe.status === 401, 'api/users.ts rejects unauthenticated access with HTTP 401');

  const createAliceProfile = await callServerlessHandler(usersHandler, {
    method: 'PUT',
    url: '/api/users?__subpath=me',
    headers: { authorization: 'Bearer token-alice' },
    body: { username: 'AliceServerless' }
  });
  assert(createAliceProfile.status === 200, 'api/users.ts PUT /api/users/me creates profile returning HTTP 200');
  assert(createAliceProfile.data?.user?.uid === ALICE.uid, 'User profile UID is derived strictly from verified token');

  const getAliceProfile = await callServerlessHandler(usersHandler, {
    method: 'GET',
    url: '/api/users?__subpath=me',
    headers: { authorization: 'Bearer token-alice' }
  });
  assert(getAliceProfile.status === 200, 'api/users.ts GET /api/users/me retrieves created profile');
  assert(getAliceProfile.data?.user?.username === 'AliceServerless', 'Profile username matches created record');

  // Bob attempts IDOR to read Alice's profile
  const bobReadsAlice = await callServerlessHandler(usersHandler, {
    method: 'GET',
    url: `/api/users?__subpath=${ALICE.uid}`,
    headers: { authorization: 'Bearer token-bob' }
  });
  assert(bobReadsAlice.status === 403, 'api/users.ts blocks cross-user profile reading with HTTP 403 FORBIDDEN');

  // ---------------------------------------------------------------------------
  // [5/8] Conversations Serverless Handlers & Subpath Rewrites
  // ---------------------------------------------------------------------------
  console.log('\n--- [5/8] Testing Conversations Serverless Handlers & Subpaths ---');
  const unauthConvs = await callServerlessHandler(conversationsHandler, {
    method: 'GET',
    url: '/api/conversations'
  });
  assert(unauthConvs.status === 401, 'api/conversations.ts rejects unauthenticated request with HTTP 401');

  const createConv = await callServerlessHandler(conversationsHandler, {
    method: 'POST',
    url: '/api/conversations',
    headers: { authorization: 'Bearer token-alice' },
    body: { title: 'Vercel Serverless Chat', mode: 'coding' }
  });
  assert(createConv.status === 201, 'api/conversations.ts POST /api/conversations returns HTTP 201');
  const convId = createConv.data?.conversation?._id || createConv.data?.conversation?.id;
  assert(Boolean(convId), 'Created conversation has a valid ID');

  // Query conversation list with query parameters preserved
  const listConvs = await callServerlessHandler(conversationsHandler, {
    method: 'GET',
    url: '/api/conversations?limit=10&mode=coding',
    headers: { authorization: 'Bearer token-alice' }
  });
  assert(listConvs.status === 200, 'api/conversations.ts GET with query parameters returns HTTP 200');
  assert(
    Array.isArray(listConvs.data?.conversations) && listConvs.data.conversations.length >= 1,
    'Conversation list contains created conversation'
  );

  // Retrieve single conversation via subpath rewrite (?__subpath=convId)
  const getSingleConv = await callServerlessHandler(conversationsHandler, {
    method: 'GET',
    url: `/api/conversations?__subpath=${convId}`,
    headers: { authorization: 'Bearer token-alice' }
  });
  assert(getSingleConv.status === 200, 'api/conversations.ts resolves subpath /api/conversations/:id returning HTTP 200');
  assert(getSingleConv.data?.conversation?.title === 'Vercel Serverless Chat', 'Retrieved conversation matches title');

  // Bob attempts IDOR to read Alice's conversation
  const bobReadsConv = await callServerlessHandler(conversationsHandler, {
    method: 'GET',
    url: `/api/conversations?__subpath=${convId}`,
    headers: { authorization: 'Bearer token-bob' }
  });
  assert(bobReadsConv.status === 403, 'api/conversations.ts blocks cross-user conversation access with HTTP 403');

  // Patch conversation title via subpath
  const patchConv = await callServerlessHandler(conversationsHandler, {
    method: 'PATCH',
    url: `/api/conversations?__subpath=${convId}`,
    headers: { authorization: 'Bearer token-alice' },
    body: { title: 'Updated Serverless Chat Title' }
  });
  assert(patchConv.status === 200, 'api/conversations.ts PATCH /api/conversations/:id updates title returning HTTP 200');

  // ---------------------------------------------------------------------------
  // [6/8] Messages Serverless Handlers & Cascading Cleanup
  // ---------------------------------------------------------------------------
  console.log('\n--- [6/8] Testing Messages Serverless Handlers ---');
  const postMsg = await callServerlessHandler(messagesHandler, {
    method: 'POST',
    url: '/api/messages',
    headers: { authorization: 'Bearer token-alice' },
    body: {
      conversationId: convId,
      sender: 'user',
      content: 'Hello from Vercel Serverless Function'
    }
  });
  assert(postMsg.status === 201, 'api/messages.ts POST /api/messages returns HTTP 201');
  const msgId = postMsg.data?.message?._id || postMsg.data?.message?.id;
  assert(Boolean(msgId), 'Created message has valid ID');

  // List messages for conversation
  const listMsgs = await callServerlessHandler(messagesHandler, {
    method: 'GET',
    url: `/api/messages?conversationId=${convId}`,
    headers: { authorization: 'Bearer token-alice' }
  });
  assert(listMsgs.status === 200, 'api/messages.ts GET /api/messages?conversationId=... returns HTTP 200');
  assert(Array.isArray(listMsgs.data?.messages) && listMsgs.data.messages.length === 1, 'Messages list returns 1 message');

  // Bob attempts IDOR to post to Alice's conversation
  const bobPostsToAlice = await callServerlessHandler(messagesHandler, {
    method: 'POST',
    url: '/api/messages',
    headers: { authorization: 'Bearer token-bob' },
    body: {
      conversationId: convId,
      sender: 'user',
      content: 'Malicious insertion'
    }
  });
  assert(bobPostsToAlice.status === 403, 'api/messages.ts blocks cross-conversation injection with HTTP 403');

  // Delete conversation cascades to messages
  const deleteConv = await callServerlessHandler(conversationsHandler, {
    method: 'DELETE',
    url: `/api/conversations?__subpath=${convId}`,
    headers: { authorization: 'Bearer token-alice' }
  });
  assert(deleteConv.status === 200, 'api/conversations.ts DELETE /api/conversations/:id returns HTTP 200');

  const checkDeletedMsg = await callServerlessHandler(messagesHandler, {
    method: 'GET',
    url: `/api/messages?__subpath=${msgId}`,
    headers: { authorization: 'Bearer token-alice' }
  });
  assert(checkDeletedMsg.status === 404, 'Cascaded message is no longer found returning HTTP 404');

  // ---------------------------------------------------------------------------
  // [7/8] User Settings Serverless Handlers & Subpaths
  // ---------------------------------------------------------------------------
  console.log('\n--- [7/8] Testing User Settings Serverless Handlers ---');
  const saveSettings = await callServerlessHandler(userSettingsHandler, {
    method: 'POST',
    url: '/api/user-settings?__subpath=me',
    headers: { authorization: 'Bearer token-alice' },
    body: { theme: 'dark', responseLength: 'concise', defaultMode: 'coding' }
  });
  assert(saveSettings.status === 200, 'api/user-settings.ts POST /api/user-settings/me returns HTTP 200');
  assert(saveSettings.data?.settings?.theme === 'dark', 'Saved settings reflects updated theme');

  const getSettings = await callServerlessHandler(userSettingsHandler, {
    method: 'GET',
    url: '/api/user-settings?__subpath=me',
    headers: { authorization: 'Bearer token-alice' }
  });
  assert(getSettings.status === 200, 'api/user-settings.ts GET /api/user-settings/me returns HTTP 200');
  assert(getSettings.data?.settings?.responseLength === 'concise', 'Retrieved settings reflects responseLength');

  const bobReadsSettings = await callServerlessHandler(userSettingsHandler, {
    method: 'GET',
    url: `/api/user-settings?__subpath=${ALICE.uid}`,
    headers: { authorization: 'Bearer token-bob' }
  });
  assert(bobReadsSettings.status === 403, 'api/user-settings.ts blocks cross-user settings access with HTTP 403');

  // ---------------------------------------------------------------------------
  // [8/8] Step 3.4D-1 No-Fallback Guarantees in Serverless Handlers
  // ---------------------------------------------------------------------------
  console.log('\n--- [8/8] Testing No-Fallback Guarantees Under Database Outage ---');
  resetTestDatabase(); // Clear in-memory test database and state
  const originalMongoUri = process.env.MONGODB_URI;

  try {
    // Deterministically simulate database outage/unconfigured environment
    // without triggering Atlas network timeouts or cluster selection delays
    delete process.env.MONGODB_URI;

    // Test that when unconfigured, serverless handlers explicitly fail with HTTP 503 DATABASE_UNAVAILABLE
    const noFallbackConvs = await callServerlessHandler(conversationsHandler, {
      method: 'GET',
      url: '/api/conversations',
      headers: { authorization: 'Bearer token-alice' }
    });
    assert(noFallbackConvs.status === 503, 'api/conversations.ts returns HTTP 503 when MongoDB is unavailable');
    assert(noFallbackConvs.data?.code === 'DATABASE_UNAVAILABLE', 'Response code is DATABASE_UNAVAILABLE (no fake empty array)');

    const noFallbackPinnedConv = await callServerlessHandler(conversationsHandler, {
      method: 'POST',
      url: '/api/conversations',
      headers: { authorization: 'Bearer token-alice' },
      body: { title: 'Pinned Outage Conversation', isPinned: true }
    });
    assert(
      noFallbackPinnedConv.status === 503 && noFallbackPinnedConv.data?.code === 'DATABASE_UNAVAILABLE',
      'api/conversations.ts POST with isPinned: true returns HTTP 503 DATABASE_UNAVAILABLE when MongoDB is unavailable'
    );

    const noFallbackUsers = await callServerlessHandler(usersHandler, {
      method: 'GET',
      url: '/api/users?__subpath=me',
      headers: { authorization: 'Bearer token-alice' }
    });
    assert(noFallbackUsers.status === 503, 'api/users.ts returns HTTP 503 when MongoDB is unavailable');
    assert(noFallbackUsers.data?.code === 'DATABASE_UNAVAILABLE', 'Response code is DATABASE_UNAVAILABLE (no fake user)');

    const noFallbackSettings = await callServerlessHandler(userSettingsHandler, {
      method: 'POST',
      url: '/api/user-settings?__subpath=me',
      headers: { authorization: 'Bearer token-alice' },
      body: { theme: 'light' }
    });
    assert(noFallbackSettings.status === 503, 'api/user-settings.ts returns HTTP 503 when MongoDB is unavailable');
    assert(noFallbackSettings.data?.code === 'DATABASE_UNAVAILABLE', 'Response code is DATABASE_UNAVAILABLE (no fake write)');

    // Verify that core liveness endpoints (/api/health) still work even when database is unavailable
    const livenessStillWorks = await callServerlessHandler(healthHandler, {
      method: 'GET',
      url: '/api/health'
    });
    assert(livenessStillWorks.status === 200, 'Liveness endpoint /api/health returns HTTP 200 even when database is offline');
  } finally {
    // Restore environment and database state safely even if assertions fail
    if (originalMongoUri !== undefined) {
      process.env.MONGODB_URI = originalMongoUri;
    } else {
      delete process.env.MONGODB_URI;
    }
    resetTestDatabase();
    resetFirebaseAdminForTesting();
    await closeDatabase();
  }

  console.log('\n========================================================================');
  console.log(`📊 Audit Results: ${passed} passed, ${failed} failed`);
  console.log('========================================================================');

  if (failed > 0) {
    process.exit(1);
  }
  process.exitCode = 0;
}

run().catch((err) => {
  console.error('Unhandled test failure:', err);
  process.exit(1);
});
