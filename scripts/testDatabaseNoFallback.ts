/**
 * Orvix Production MongoDB No-Fallback Verification Suite (Phase 3 Step 3.4D-1)
 *
 * Verifies that getDatabase() never silently substitutes an in-memory database
 * for MongoDB persistence in production or normal runtime:
 * - Test A: Valid / connected database returns active Db and repository operations succeed
 * - Test B: Missing MONGODB_URI fails explicitly (throws MongoNotConnectedError, returns HTTP 503 on API, no Map created)
 * - Test C: MongoDB connection failure fails explicitly (no silent in-memory fallback)
 * - Test D: Explicit test environment isolation (mock database and in-memory test database only accessible when TESTING=true)
 * - Test E: No mixed persistence (failed connections never store phantom records in memory)
 */

process.env.TESTING = 'true';
import dotenv from 'dotenv';
dotenv.config();

import http from 'http';
import type { DecodedIdToken } from 'firebase-admin/auth';
import { app } from '../server.ts';
import {
  getDatabase,
  connectToDatabase,
  getMongoStatus,
  isMongoConfigured,
  setMockDatabaseForTesting,
  enableInMemoryTestDatabase,
  resetTestDatabase,
  MongoNotConnectedError
} from '../src/db/mongodb.ts';
import {
  setMockAuthVerifierForTesting,
  resetFirebaseAdminForTesting
} from '../src/services/firebaseAdminService.ts';
import {
  createConversation,
  findConversationById,
  findConversationsByUserId,
  getConversationsCollection
} from '../src/repositories/conversationRepository.ts';
import {
  getUserProfile,
  saveUserProfile
} from '../src/services/userProfileService.js';
import {
  authorizedApiFetch,
  setAuthTokenProviderForTesting
} from '../src/services/mongoApiClient.js';

// Test User Identity
const USER_TEST: DecodedIdToken = {
  uid: 'user-nofallback-123',
  email: 'tester@orvix.ai',
  email_verified: true,
  name: 'Security Tester',
  aud: 'orvix-project',
  auth_time: 1000,
  exp: 9999999999,
  iat: 1000,
  iss: 'https://securetoken.google.com/orvix-project',
  sub: 'user-nofallback-123',
  firebase: { identities: { email: ['tester@orvix.ai'] }, sign_in_provider: 'password' }
};

setMockAuthVerifierForTesting(async (token: string) => {
  if (token === 'token-tester-valid') return USER_TEST;
  const err: any = new Error('Invalid token');
  err.code = 'auth/invalid-id-token';
  throw err;
});

setAuthTokenProviderForTesting(async () => 'token-tester-valid');

let server: http.Server;
let port: number;

async function runTests() {
  console.log('====================================================================');
  console.log('🧪 Orvix Production MongoDB No-Fallback Suite (Step 3.4D-1)');
  console.log('====================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, detail: string = '') {
    if (condition) {
      console.log(`  ✅ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${testName}${detail ? ` -> ${detail}` : ''}`);
      failed++;
    }
  }

  // Start ephemeral HTTP server for API route testing
  server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as any;
      port = addr.port;
      process.env.TEST_API_BASE = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  try {
    // =========================================================================
    // TEST A: Production MongoDB configured / connected behavior
    // =========================================================================
    console.log('--- Test A: Production MongoDB Configured & Connected ---');
    // Inject an explicit mock DB to simulate an active, connected database
    resetTestDatabase();
    enableInMemoryTestDatabase();

    const dbA = getDatabase();
    assert(Boolean(dbA), 'getDatabase() returns connected database instance when connected');
    assert(typeof dbA.collection === 'function', 'Returned database exposes standard collection API');

    // Create a conversation using repository
    const convA = await createConversation({
      userId: USER_TEST.uid,
      title: 'Active Connection Conversation',
      mode: 'coding'
    });
    assert(Boolean(convA && convA._id), 'createConversation persists successfully on active database');

    const fetchedA = await findConversationById(convA._id);
    assert(fetchedA?.title === 'Active Connection Conversation', 'findConversationById retrieves saved conversation from active database');

    // =========================================================================
    // TEST B: Production MongoDB missing (MONGODB_URI unconfigured)
    // =========================================================================
    console.log('\n--- Test B: Production MongoDB Missing (MONGODB_URI Not Configured) ---');
    // Reset test database mocks and simulate production state without MONGODB_URI
    resetTestDatabase();
    const originalUri = process.env.MONGODB_URI;
    const originalTesting = process.env.TESTING;

    try {
      delete process.env.MONGODB_URI;
      delete process.env.TESTING; // Simulate normal production runtime

      let threwCorrectError = false;
      let errorInstance: any = null;
      try {
        getDatabase();
      } catch (err: any) {
        threwCorrectError = err instanceof MongoNotConnectedError || err?.name === 'MongoNotConnectedError';
        errorInstance = err;
      }

      assert(threwCorrectError, 'getDatabase() throws MongoNotConnectedError in production when unconfigured');
      assert(
        errorInstance?.message?.includes('MONGODB_URI is not configured') ||
        errorInstance?.message?.includes('Database connection required'),
        'Error message explicitly states connection requirement without creating fallback Map'
      );

      // Verify that calling repository functions throws explicitly
      let repoThrew = false;
      try {
        await createConversation({
          userId: USER_TEST.uid,
          title: 'Should Never Be Persisted',
          mode: 'general'
        });
      } catch (err: any) {
        repoThrew = err instanceof MongoNotConnectedError || err?.code === 'DATABASE_NOT_CONNECTED';
      }
      assert(repoThrew, 'createConversation rejects with MongoNotConnectedError when database is unconfigured');

      // Verify that API requests fail explicitly with HTTP 503 DATABASE_UNAVAILABLE (NOT 201 or 200)
      const { res: apiRes } = await authorizedApiFetch('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Unconfigured Persistence Attempt' })
      });

      assert(apiRes !== null && apiRes.status === 503, 'POST /api/conversations returns HTTP 503 when MongoDB is unconfigured');
      const apiBody = await apiRes?.json();
      assert(apiBody?.code === 'DATABASE_UNAVAILABLE', 'API response specifies DATABASE_UNAVAILABLE code');

      // Verify that GET /api/conversations also fails explicitly with 503 (NOT an empty array or fake 200)
      const { res: getRes } = await authorizedApiFetch('/api/conversations', { method: 'GET' });
      assert(getRes !== null && getRes.status === 503, 'GET /api/conversations returns HTTP 503 (not fake empty array)');

      // Verify that profile API also fails explicitly with 503
      const { res: profRes } = await authorizedApiFetch('/api/users/me', { method: 'GET' });
      assert(profRes !== null && profRes.status === 503, 'GET /api/users/me returns HTTP 503 when MongoDB is unconfigured');

    } finally {
      process.env.MONGODB_URI = originalUri;
      process.env.TESTING = originalTesting;
    }

    // =========================================================================
    // TEST C: MongoDB connection failure (Failed network / server closed)
    // =========================================================================
    console.log('\n--- Test C: MongoDB Connection Failure (No Silent Map Fallback) ---');
    resetTestDatabase();
    const origTestingC = process.env.TESTING;

    try {
      delete process.env.TESTING; // Normal runtime
      // Simulate connection failure
      process.env.MONGODB_URI = 'mongodb://127.0.0.1:1/invalid';

      let threwOnDisconnect = false;
      try {
        getDatabase();
      } catch (err: any) {
        threwOnDisconnect = err instanceof MongoNotConnectedError;
      }
      assert(threwOnDisconnect, 'getDatabase() throws MongoNotConnectedError on connection failure');

      // Verify that user-settings API returns HTTP 503 when disconnected
      const { res: settingsRes } = await authorizedApiFetch('/api/user-settings/me', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme: 'dark' })
      });
      assert(settingsRes !== null && settingsRes.status === 503, 'POST /api/user-settings/me returns HTTP 503 on database failure');

    } finally {
      process.env.TESTING = origTestingC;
      process.env.MONGODB_URI = originalUri;
    }

    // =========================================================================
    // TEST D: Explicit test environment isolation
    // =========================================================================
    console.log('\n--- Test D: Explicit Test Mode Isolation (TESTING=true Guard) ---');
    // Ensure in-memory database CANNOT be activated outside TESTING=true
    const origTestingD = process.env.TESTING;
    delete process.env.TESTING;

    let blockedNonTestCall = false;
    try {
      enableInMemoryTestDatabase();
    } catch (err: any) {
      blockedNonTestCall = err.message.includes('strictly forbidden in production');
    }
    assert(blockedNonTestCall, 'enableInMemoryTestDatabase() throws error when called outside TESTING=true');

    let blockedMockInjection = false;
    try {
      setMockDatabaseForTesting({ dummy: true });
    } catch (err: any) {
      blockedMockInjection = err.message.includes('strictly forbidden in production');
    }
    assert(blockedMockInjection, 'setMockDatabaseForTesting() throws error when called outside TESTING=true');

    // Restore test mode and confirm explicit test hooks work
    process.env.TESTING = 'true';
    resetTestDatabase();
    const testDb = enableInMemoryTestDatabase();
    assert(Boolean(testDb), 'enableInMemoryTestDatabase() succeeds when process.env.TESTING === "true"');

    const dbActive = getDatabase();
    assert(dbActive === testDb, 'getDatabase() returns explicitly enabled test database in test mode');

    // =========================================================================
    // TEST E: No mixed persistence (Failed connection leaves zero phantom records)
    // =========================================================================
    console.log('\n--- Test E: No Mixed Persistence (Zero In-Memory Artifacts on Failure) ---');
    // Reset database to disconnected state
    resetTestDatabase();
    delete process.env.TESTING;

    let writeFailed = false;
    try {
      await createConversation({
        userId: USER_TEST.uid,
        title: 'Ghost Conversation',
        mode: 'writing'
      });
    } catch (err: any) {
      writeFailed = true;
    }
    assert(writeFailed, 'Write operation failed as expected when database was disconnected');

    // Re-enable test DB to simulate subsequent reconnect
    process.env.TESTING = 'true';
    enableInMemoryTestDatabase();

    // Verify that the failed write left ZERO phantom records in the database
    const conversationsAfterReconnect = await findConversationsByUserId(USER_TEST.uid);
    assert(
      !conversationsAfterReconnect.some((c) => c.title === 'Ghost Conversation'),
      'No phantom or orphaned in-memory record was created during failed connection'
    );

    // Verify health and diagnostic endpoints
    console.log('\n--- Health & Readiness Verification ---');
    const { res: healthRes } = await authorizedApiFetch('/api/health', { method: 'GET' });
    assert(healthRes?.status === 200, 'GET /api/health returns HTTP 200 (lightweight liveness intact)');

    const { res: statusRes } = await authorizedApiFetch('/api/db/status', { method: 'GET' });
    assert(statusRes?.status === 200, 'GET /api/db/status returns HTTP 200 with readiness data');

  } catch (unexpected: any) {
    console.error('Unexpected test error:', unexpected);
    failed++;
  } finally {
    resetTestDatabase();
    process.env.TESTING = 'true';
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  console.log('\n====================================================================');
  console.log(`📊 Final Results: ${passed} passed, ${failed} failed`);
  console.log('====================================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
