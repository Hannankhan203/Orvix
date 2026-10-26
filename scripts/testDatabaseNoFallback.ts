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

import http from 'http';
import type { DecodedIdToken } from 'firebase-admin/auth';

// Establish TESTING=true before dynamically importing application modules so server.ts does not start listening
process.env.TESTING = 'true';

const { app } = await import('../server.ts');
const {
  getDatabase,
  connectToDatabase,
  getMongoClient,
  getMongoStatus,
  isMongoConfigured,
  setMockDatabaseForTesting,
  setMongoClientFactoryForTesting,
  enableInMemoryTestDatabase,
  resetTestDatabase,
  MongoNotConnectedError
} = (await import('../src/db/mongodb.ts')) as any;
const {
  setMockAuthVerifierForTesting,
  resetFirebaseAdminForTesting
} = await import('../src/services/firebaseAdminService.ts');
const {
  createConversation,
  findConversationById,
  findConversationsByUserId,
  getConversationsCollection
} = await import('../src/repositories/conversationRepository.ts');
const {
  getUserProfile,
  saveUserProfile
} = await import('../src/services/userProfileService.js');
const {
  authorizedApiFetch,
  setAuthTokenProviderForTesting
} = await import('../src/services/mongoApiClient.js');

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

      // Verify that pinned conversation creation also fails explicitly with 503 (no unhandled rejection in canPinConversation)
      const { res: pinnedRes } = await authorizedApiFetch('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Pinned Unconfigured Attempt', isPinned: true })
      });
      assert(
        pinnedRes !== null && pinnedRes.status === 503,
        'POST /api/conversations with isPinned: true returns HTTP 503 when MongoDB is unconfigured'
      );

      // Verify that GET /api/conversations also fails explicitly with 503 (NOT an empty array or fake 200)
      const { res: getRes } = await authorizedApiFetch('/api/conversations', { method: 'GET' });
      assert(getRes !== null && getRes.status === 503, 'GET /api/conversations returns HTTP 503 (not fake empty array)');

      // Verify that profile API also fails explicitly with 503
      const { res: profRes } = await authorizedApiFetch('/api/users/me', { method: 'GET' });
      assert(profRes !== null && profRes.status === 503, 'GET /api/users/me returns HTTP 503 when MongoDB is unconfigured');

    } finally {
      if (originalUri !== undefined) {
        process.env.MONGODB_URI = originalUri;
      } else {
        delete process.env.MONGODB_URI;
      }
      if (originalTesting !== undefined) {
        process.env.TESTING = originalTesting;
      } else {
        delete process.env.TESTING;
      }
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
      if (origTestingC !== undefined) {
        process.env.TESTING = origTestingC;
      } else {
        delete process.env.TESTING;
      }
      if (originalUri !== undefined) {
        process.env.MONGODB_URI = originalUri;
      } else {
        delete process.env.MONGODB_URI;
      }
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

    // Verify that even without calling resetTestDatabase(), removing TESTING prevents getDatabase() from returning testDb
    delete process.env.TESTING;
    let leakedTestDbOutsideTesting = false;
    try {
      getDatabase();
      leakedTestDbOutsideTesting = true;
    } catch (err: any) {
      leakedTestDbOutsideTesting = !(err instanceof MongoNotConnectedError);
    }
    assert(!leakedTestDbOutsideTesting, 'getDatabase() refuses to return cached test database once TESTING=true is removed');
    process.env.TESTING = 'true';

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

    // =========================================================================
    // TEST F: Deterministic Connection Lifecycle Race Condition Suite
    // =========================================================================
    console.log('\n--- Test F: Deterministic Connection Lifecycle Race Conditions ---');
    resetTestDatabase();
    process.env.TESTING = 'true';

    function createDeferred<T = void>() {
      let resolve!: (val: T | PromiseLike<T>) => void;
      let reject!: (err?: any) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }

    function createControlledMockClient(
      label: string,
      connectDeferred: ReturnType<typeof createDeferred<void>>,
      pingImpl: () => Promise<any> = async () => ({ ok: 1 })
    ) {
      const listeners: Record<string, Array<(...args: any[]) => void>> = {};
      const mockDb = {
        databaseName: `Orvix-${label}`,
        command: pingImpl,
        collection: () => ({})
      } as any;

      const client = {
        label,
        closeCalls: 0,
        on: (event: string, fn: (...args: any[]) => void) => {
          listeners[event] = listeners[event] || [];
          listeners[event].push(fn);
          return client;
        },
        emit: (event: string, ...args: any[]) => {
          for (const fn of listeners[event] || []) fn(...args);
        },
        connect: () => connectDeferred.promise,
        db: () => mockDb,
        close: async () => {
          client.closeCalls++;
          client.emit('serverClosed');
        }
      };
      return { client: client as any, mockDb };
    }

    // 1. Old attempt finishes AFTER resetTestDatabase() while Attempt #2 is still pending,
    //    and concurrent Attempt #3 deduplicates onto Attempt #2 without constructing a 3rd client
    {
      const def1 = createDeferred<void>();
      const def2 = createDeferred<void>();
      const def3 = createDeferred<void>();
      const c1 = createControlledMockClient('attempt-1', def1);
      const c2 = createControlledMockClient('attempt-2', def2);
      const c3 = createControlledMockClient('unexpected-attempt-3', def3);
      let factoryCallCount = 0;

      setMongoClientFactoryForTesting(() => {
        factoryCallCount++;
        return c1.client;
      });

      process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/Orvix';

      const p1 = connectToDatabase();
      await Promise.resolve();
      await Promise.resolve();
      assert(factoryCallCount === 1, 'Attempt #1 constructs first MongoClient');

      // Reset while Attempt #1 is still in flight, then start Attempt #2
      resetTestDatabase();
      setMongoClientFactoryForTesting(() => {
        factoryCallCount++;
        return factoryCallCount === 2 ? c2.client : c3.client;
      });

      const p2 = connectToDatabase();
      await Promise.resolve();
      await Promise.resolve();
      assert(factoryCallCount === 2, 'Attempt #2 constructs second MongoClient after reset');

      // Resolve stale Attempt #1 WHILE Attempt #2 is still pending
      def1.resolve();
      const res1 = await p1;

      assert(res1 === null, 'Stale Attempt #1 resolves to null after reset');
      assert(c1.client.closeCalls === 1, 'Stale Attempt #1 closes its abandoned MongoClient');
      assert(c2.client.closeCalls === 0, 'Stale Attempt #1 does not close Attempt #2 MongoClient');

      // Concurrent caller Attempt #3 arrives while Attempt #2 is still pending:
      // Proves Attempt #1's finally block did NOT clear state.connectionPromise
      const p3 = connectToDatabase();
      await Promise.resolve();
      await Promise.resolve();
      assert(
        factoryCallCount === 2,
        'Concurrent caller Attempt #3 reuses Attempt #2 in-flight promise without constructing a third MongoClient'
      );

      const statusWhileAttempt2Pending = await getMongoStatus();

      assert(
        statusWhileAttempt2Pending.isConnecting === true,
        'Attempt #2 remains marked as connecting while the concurrent caller reuses it'
      );

      // Now resolve Attempt #2 and confirm both p2 and p3 resolve to Attempt #2's Db and Attempt #2 owns state
      def2.resolve();
      const [res2, res3] = await Promise.all([p2, p3]);
      assert(res2 === c2.mockDb, 'Attempt #2 resolves with its own Db instance');
      assert(res3 === c2.mockDb, 'Concurrent caller Attempt #3 resolves with Attempt #2 Db instance');
      assert(factoryCallCount === 2, 'Total MongoClient constructions remained strictly 2');
      assert(getDatabase() === c2.mockDb, 'getDatabase() returns Attempt #2 Db');
      assert(getMongoClient() === c2.client, 'getMongoClient() returns Attempt #2 MongoClient');
    }

    // 2. Stale attempt resolving or rejecting cannot overwrite a newly enabled in-memory DB or injected mock
    {
      resetTestDatabase();
      const defStaleSuccess = createDeferred<void>();
      const cStaleSuccess = createControlledMockClient('stale-vs-inmem', defStaleSuccess);
      setMongoClientFactoryForTesting(() => cStaleSuccess.client);
      process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/Orvix';

      const pStale = connectToDatabase();
      await Promise.resolve();
      await Promise.resolve();

      // Enable in-memory test database while pStale is still connecting
      const inMemDb = enableInMemoryTestDatabase();
      defStaleSuccess.resolve();
      const staleRes = await pStale;

      assert(staleRes === null, 'Stale attempt superseded by enableInMemoryTestDatabase() resolves to null');
      assert(cStaleSuccess.client.closeCalls === 1, 'Stale attempt superseded by enableInMemoryTestDatabase() closes its client');
      assert(getDatabase() === inMemDb, 'Stale attempt does not overwrite newly enabled in-memory test database');
      assert(getMongoClient() === null, 'state.client remains null when in-memory test database is active');

      // Now test stale attempt vs setMockDatabaseForTesting()
      resetTestDatabase();
      const defStaleFail = createDeferred<void>();
      const cStaleFail = createControlledMockClient('stale-vs-mock', defStaleFail);
      setMongoClientFactoryForTesting(() => cStaleFail.client);

      const pStaleFail = connectToDatabase();
      await Promise.resolve();
      await Promise.resolve();

      const customMockDb = { databaseName: 'CustomMock', command: async () => ({ ok: 1 }), collection: () => ({}) };
      setMockDatabaseForTesting(customMockDb);
      defStaleFail.reject(new Error('Delayed connection refusal'));
      const staleFailRes = await pStaleFail;

      assert(staleFailRes === null, 'Rejected stale attempt superseded by setMockDatabaseForTesting() returns null');
      assert(cStaleFail.client.closeCalls === 1, 'Rejected stale attempt closes its client');
      assert(getDatabase() === (customMockDb as any), 'Rejected stale attempt does not overwrite injected mock database');
    }

    // 3. Failed ping after successful connect() closes the client created by that attempt
    {
      resetTestDatabase();
      const defConnectOk = createDeferred<void>();
      const cPingFail = createControlledMockClient(
        'ping-fail',
        defConnectOk,
        async () => {
          throw new Error('Authentication failed during ping');
        }
      );
      setMongoClientFactoryForTesting(() => cPingFail.client);
      process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/Orvix';

      defConnectOk.resolve();
      const pingFailRes = await connectToDatabase();

      assert(pingFailRes === null, 'connectToDatabase() returns null when post-connect ping fails');
      assert(cPingFail.client.closeCalls === 1, 'Failed ping closes the MongoClient created by that attempt');
      assert(getMongoClient() === null, 'state.client remains null after failed ping');
    }

    // 4. URI removal closes previous real client without disrupting an explicitly permitted test database
    {
      resetTestDatabase();
      const defReal = createDeferred<void>();
      const cReal = createControlledMockClient('real-connected', defReal);
      setMongoClientFactoryForTesting(() => cReal.client);
      process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/Orvix';

      defReal.resolve();
      await connectToDatabase();
      assert(getMongoClient() === cReal.client, 'Real client is connected prior to URI removal');

      delete process.env.MONGODB_URI;
      const statusAfterUriRemoval = await getMongoStatus();
      assert(statusAfterUriRemoval.isConnected === false, 'getMongoStatus() marks connection false when URI is removed');
      assert(cReal.client.closeCalls === 1, 'getMongoStatus() closes previous real MongoClient when URI is removed');
      assert(getMongoClient() === null, 'state.client is cleared after URI removal');

      // Enable explicit test database while MONGODB_URI remains unset
      const permittedTestDb = enableInMemoryTestDatabase();
      const statusWithTestDb = await getMongoStatus();
      assert(statusWithTestDb.isConnected === true, 'getMongoStatus() preserves explicit test DB when URI is unset');
      assert(getDatabase() === permittedTestDb, 'getDatabase() returns explicit test DB when URI is unset and TESTING=true');
      assert((await connectToDatabase()) === permittedTestDb, 'connectToDatabase() preserves explicit test DB when TESTING=true');
    }

    // 5. Synchronous exception in MongoClient factory cleans up connectionPromise without wedging
    {
      resetTestDatabase();
      process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/Orvix';
      let syncThrowCalls = 0;
      setMongoClientFactoryForTesting(() => {
        syncThrowCalls++;
        throw new Error('Synchronous MongoParseError in constructor');
      });

      const syncFailRes = await connectToDatabase();
      assert(syncFailRes === null, 'Synchronous constructor error resolves to null');
      assert(syncThrowCalls === 1, 'Factory was invoked once during synchronous failure');

      const statusAfterSyncFail = await getMongoStatus();
      assert(statusAfterSyncFail.isConnecting === false, 'state.isConnecting is reset to false after synchronous factory error');

      const defRecovery = createDeferred<void>();
      const cRecovery = createControlledMockClient('recovery', defRecovery);
      setMongoClientFactoryForTesting(() => cRecovery.client);
      defRecovery.resolve();

      const recoveredDb = await connectToDatabase();
      assert(
        recoveredDb === cRecovery.mockDb,
        'Subsequent connectToDatabase() succeeds (no permanently settled promise left cached)'
      );
    }

    // 6. Disconnected real client (serverClosed -> state.isConnected === false) + MONGODB_URI removal
    //    is invalidated and closed once when getDatabase() is called
    {
      const savedUri = process.env.MONGODB_URI;
      const savedTesting = process.env.TESTING;
      try {
        process.env.TESTING = 'true';
        resetTestDatabase();

        const defDisc = createDeferred<void>();
        const cDisc = createControlledMockClient('server-closed-uri-removed', defDisc);
        setMongoClientFactoryForTesting(() => cDisc.client);
        process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/Orvix';

        defDisc.resolve();
        const connectedDb = await connectToDatabase();
        assert(connectedDb === cDisc.mockDb, 'Controlled mock client connects and caches Db');
        assert(getMongoClient() === cDisc.client, 'getMongoClient() returns active controlled client');

        // Emit serverClosed so state.isConnected becomes false while state.client and state.db remain cached
        cDisc.client.emit('serverClosed');
        assert(cDisc.client.closeCalls === 0, 'Emitting serverClosed does not increment closeCalls by itself');

        // Remove MONGODB_URI while state.isConnected is already false
        delete process.env.MONGODB_URI;

        let getDbThrew = false;
        try {
          getDatabase();
        } catch (err: any) {
          getDbThrew = err instanceof MongoNotConnectedError || err?.name === 'MongoNotConnectedError';
        }

        assert(
          getDbThrew,
          'getDatabase() throws MongoNotConnectedError after serverClosed and MONGODB_URI removal'
        );
        assert(
          getMongoClient() === null,
          'getDatabase() clears cached state.client even when state.isConnected was already false'
        );
        assert(
          cDisc.client.closeCalls === 1,
          'getDatabase() closes the detached stale client once when MONGODB_URI is missing'
        );

        // Calling getDatabase() again should not close the already-detached client a second time
        try {
          getDatabase();
        } catch (_) {}
        assert(
          cDisc.client.closeCalls === 1,
          'Subsequent getDatabase() calls do not close the stale client again (closed strictly once)'
        );
      } finally {
        if (savedUri !== undefined) {
          process.env.MONGODB_URI = savedUri;
        } else {
          delete process.env.MONGODB_URI;
        }
        if (savedTesting !== undefined) {
          process.env.TESTING = savedTesting;
        } else {
          delete process.env.TESTING;
        }
        resetTestDatabase();
      }
    }

    // 7. Test database purge on exiting TESTING mode prevents resurrection when TESTING='true' is restored
    {
      const savedUri = process.env.MONGODB_URI;
      const savedTesting = process.env.TESTING;
      try {
        delete process.env.MONGODB_URI;
        process.env.TESTING = 'true';
        resetTestDatabase();

        const enabledTestDb = enableInMemoryTestDatabase();
        assert(getDatabase() === enabledTestDb, 'In-memory test database is active while TESTING="true"');

        // Exit test mode and call getDatabase()
        delete process.env.TESTING;
        let rejectedOutsideTesting = false;
        try {
          getDatabase();
        } catch (err: any) {
          rejectedOutsideTesting = err instanceof MongoNotConnectedError || err?.name === 'MongoNotConnectedError';
        }
        assert(
          rejectedOutsideTesting,
          'getDatabase() rejects in-memory test database with MongoNotConnectedError when TESTING is removed'
        );

        // Restore TESTING='true' WITHOUT calling enableInMemoryTestDatabase() again
        process.env.TESTING = 'true';
        let rejectedAfterRestoringTesting = false;
        try {
          getDatabase();
        } catch (err: any) {
          rejectedAfterRestoringTesting =
            err instanceof MongoNotConnectedError || err?.name === 'MongoNotConnectedError';
        }
        assert(
          rejectedAfterRestoringTesting,
          'Restoring TESTING="true" without re-enabling does not resurrect purged test database in getDatabase()'
        );
        assert(
          (await connectToDatabase()) === null,
          'Restoring TESTING="true" without re-enabling does not resurrect purged test database in connectToDatabase()'
        );
      } finally {
        if (savedUri !== undefined) {
          process.env.MONGODB_URI = savedUri;
        } else {
          delete process.env.MONGODB_URI;
        }
        if (savedTesting !== undefined) {
          process.env.TESTING = savedTesting;
        } else {
          delete process.env.TESTING;
        }
        resetTestDatabase();
      }
    }

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
