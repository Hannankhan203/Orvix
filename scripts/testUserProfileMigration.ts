/**
 * Orvix User Profile Migration Verification Suite (Phase 3 Step 3.1)
 *
 * Verifies that user-profile reads and writes have migrated from direct Firestore
 * operations to the authenticated Express/MongoDB API (/api/users/me), adhering to:
 * 1. Username validation & constraint enforcement
 * 2. Local storage caching & offline resilience
 * 3. Guest mode safety & non-blocking behavior
 * 4. Authenticated profile creation & retrieval via Express MongoDB API
 * 5. Update & idempotence handling
 * 6. Multi-user identity isolation (token-based UID derivation, zero IDOR)
 * 7. Server error & offline fallback without data loss
 */

process.env.TESTING = 'true';
import dotenv from 'dotenv';
dotenv.config();

import http from 'http';
import type { DecodedIdToken } from 'firebase-admin/auth';
import { app } from '../server.ts';
import {
  setMockAuthVerifierForTesting,
  resetFirebaseAdminForTesting
} from '../src/services/firebaseAdminService.ts';
import { setMockDatabaseForTesting } from '../src/db/mongodb.ts';
import {
  validateUsername,
  getCachedUserProfile,
  saveCachedUserProfile,
  getUserProfile,
  saveUserProfile,
  setAuthTokenProviderForTesting,
  USERNAME_CONSTRAINTS
} from '../src/services/userProfileService.js';

// Setup Mock LocalStorage for Node.js test environment
const mockStorage = new Map<string, string>();
(global as any).localStorage = {
  getItem: (key: string) => mockStorage.get(key) || null,
  setItem: (key: string, val: string) => mockStorage.set(key, String(val)),
  removeItem: (key: string) => mockStorage.delete(key),
  clear: () => mockStorage.clear()
};
(global as any).window = {
  localStorage: (global as any).localStorage,
  location: { origin: '' }
};

// Test User Personas
const USER_ALICE: DecodedIdToken = {
  uid: 'user-alice-111',
  email: 'alice@orvix.ai',
  email_verified: true,
  name: 'Alice Developer',
  aud: 'orvix-project',
  auth_time: 1000,
  exp: 9999999999,
  iat: 1000,
  iss: 'https://securetoken.google.com/orvix-project',
  sub: 'user-alice-111',
  firebase: { identities: { email: ['alice@orvix.ai'] }, sign_in_provider: 'password' }
};

const USER_BOB: DecodedIdToken = {
  uid: 'user-bob-222',
  email: 'bob@orvix.ai',
  email_verified: true,
  name: 'Bob Explorer',
  aud: 'orvix-project',
  auth_time: 1000,
  exp: 9999999999,
  iat: 1000,
  iss: 'https://securetoken.google.com/orvix-project',
  sub: 'user-bob-222',
  firebase: { identities: { email: ['bob@orvix.ai'] }, sign_in_provider: 'password' }
};

let currentTestToken: string | null = null;
setAuthTokenProviderForTesting(async () => currentTestToken);

// In-Memory Mock Database
function createMockDb() {
  const usersStore = new Map<string, any>();
  const settingsStore = new Map<string, any>();
  const convsStore = new Map<string, any>();
  const msgsStore = new Map<string, any>();

  function makeCollection(store: Map<string, any>, name: string) {
    return {
      name,
      createIndex: async () => `${name}_idx`,
      insertOne: async (doc: any) => {
        const copy = JSON.parse(JSON.stringify(doc));
        store.set(String(copy._id || copy.uid || copy.id), copy);
        return { acknowledged: true, insertedId: copy._id };
      },
      findOne: async (filter: any) => {
        let id = filter._id || filter.uid;
        if (!id && filter.$or) {
          id = filter.$or[0]._id || filter.$or[0].uid;
        }
        if (id && store.has(String(id))) {
          return JSON.parse(JSON.stringify(store.get(String(id))));
        }
        for (const doc of store.values()) {
          let match = true;
          for (const [k, v] of Object.entries(filter)) {
            if (doc[k] !== v) match = false;
          }
          if (match) return JSON.parse(JSON.stringify(doc));
        }
        return null;
      },
      updateOne: async (filter: any, update: any, options?: any) => {
        let id = filter._id || filter.uid;
        if (!id && filter.$or) {
          id = filter.$or[0]._id || filter.$or[0].uid;
        }
        id = String(id);
        let existing = store.get(id);
        if (!existing && options?.upsert) {
          existing = { _id: id, uid: id, createdAt: new Date() };
          store.set(id, existing);
        }
        if (existing) {
          if (update.$set) {
            Object.assign(existing, JSON.parse(JSON.stringify(update.$set)));
          }
          if (update.$setOnInsert && !existing.createdAt) {
            Object.assign(existing, JSON.parse(JSON.stringify(update.$setOnInsert)));
          }
          existing.updatedAt = new Date();
          return { acknowledged: true, modifiedCount: 1, upsertedId: options?.upsert ? id : null };
        }
        return { acknowledged: true, modifiedCount: 0 };
      },
      findOneAndUpdate: async (filter: any, update: any, options?: any) => {
        let id = filter._id || filter.uid;
        if (!id && filter.$or) {
          id = filter.$or[0]._id || filter.$or[0].uid;
        }
        id = String(id);
        let existing = store.get(id);
        if (!existing && options?.upsert) {
          existing = { _id: id, uid: id, createdAt: new Date() };
          store.set(id, existing);
        }
        if (existing) {
          if (update.$set) {
            Object.assign(existing, JSON.parse(JSON.stringify(update.$set)));
          }
          if (update.$setOnInsert && !existing.createdAt) {
            Object.assign(existing, JSON.parse(JSON.stringify(update.$setOnInsert)));
          }
          existing.updatedAt = new Date();
          return JSON.parse(JSON.stringify(existing));
        }
        return null;
      },
      deleteOne: async (filter: any) => {
        let id = filter._id || filter.uid;
        if (!id && filter.$or) {
          id = filter.$or[0]._id || filter.$or[0].uid;
        }
        const deleted = store.delete(String(id));
        return { acknowledged: true, deletedCount: deleted ? 1 : 0 };
      }
    };
  }

  return {
    collection: (name: string) => {
      if (name === 'users') return makeCollection(usersStore, 'users');
      if (name === 'user_settings') return makeCollection(settingsStore, 'user_settings');
      if (name === 'conversations') return makeCollection(convsStore, 'conversations');
      return makeCollection(msgsStore, 'messages');
    },
    command: async () => ({ ok: 1 })
  };
}

let passedTests = 0;
let totalTests = 0;

function assert(condition: boolean, desc: string) {
  totalTests++;
  if (!condition) {
    console.error(`  FAIL: ${desc}`);
    throw new Error(`Assertion failed: ${desc}`);
  }
  passedTests++;
  console.log(`  PASS: ${desc}`);
}

async function runTestSuite() {
  console.log('--- Starting Orvix User Profile Migration Test Suite ---');

  // Setup Mock Database & Auth Verifier
  const mockDb = createMockDb();
  setMockDatabaseForTesting(mockDb as any);

  setMockAuthVerifierForTesting(async (token: string) => {
    if (token === 'token-alice') return USER_ALICE;
    if (token === 'token-bob') return USER_BOB;
    const err: any = new Error('Decoding Firebase ID token failed');
    err.code = 'auth/invalid-id-token';
    throw err;
  });

  // Start HTTP Server on random port for realistic fetch testing
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as any).port;
  process.env.TEST_API_BASE = `http://127.0.0.1:${port}`;
  (global as any).window.location.origin = `http://127.0.0.1:${port}`;

  try {
    // =========================================================================
    // SECTION 1: Username Validation
    // =========================================================================
    console.log('\n[1. Username Validation & Application Constraints]');
    {
      const valid1 = validateUsername('alice');
      assert(valid1.isValid && valid1.sanitized === 'alice', 'Valid single-word username accepted');

      const valid2 = validateUsername('  Bob_123.Dev-Expert  ');
      assert(valid2.isValid && valid2.sanitized === 'Bob_123.Dev-Expert', 'Username with periods, hyphens, and underscores accepted and trimmed');

      const valid3 = validateUsername('John Doe');
      assert(valid3.isValid && valid3.sanitized === 'John Doe', 'Username with spaces accepted');

      const tooShort = validateUsername('a');
      assert(Boolean(!tooShort.isValid && tooShort.error?.includes('at least 2 characters')), 'Rejects username shorter than 2 characters');

      const empty = validateUsername('');
      assert(Boolean(!empty.isValid && empty.error?.includes('empty')), 'Rejects empty username');

      const tooLong = validateUsername('a'.repeat(31));
      assert(Boolean(!tooLong.isValid && tooLong.error?.includes('cannot exceed 30 characters')), 'Rejects username longer than 30 characters');

      const invalidChars = validateUsername('alice@orvix!');
      assert(Boolean(!invalidChars.isValid && invalidChars.error?.includes('can only contain')), 'Rejects username with forbidden characters');
    }

    // =========================================================================
    // SECTION 2: Local Storage Caching & Offline Resilience
    // =========================================================================
    console.log('\n[2. Local Storage Cache Operations]');
    {
      mockStorage.clear();
      saveCachedUserProfile('user-cache-test', {
        uid: 'user-cache-test',
        username: 'Cached User',
        email: 'cached@orvix.ai'
      });

      const cached = getCachedUserProfile('user-cache-test');
      assert(cached?.username === 'Cached User', 'Successfully retrieved profile from local cache');
      assert(cached?.email === 'cached@orvix.ai', 'Retrieved cached email matches');

      const nonExistent = getCachedUserProfile('non-existent-user');
      assert(nonExistent === null, 'Returns null for non-existent cache key');

      mockStorage.set('orvix_user_profile_corrupted', '{corrupted_json');
      const corrupted = getCachedUserProfile('corrupted');
      assert(corrupted === null, 'Safely handles corrupted cache JSON without throwing');
    }

    // =========================================================================
    // SECTION 3: Guest Mode / Anonymous Sessions
    // =========================================================================
    console.log('\n[3. Guest Mode Safety & Local Continuity]');
    {
      currentTestToken = null;
      mockStorage.clear();

      // Guest profile save should update cache only, without throwing network errors
      await saveUserProfile('guest-test-123', {
        username: 'Guest Explorer',
        email: 'guest@orvix.ai'
      });

      const cachedGuest = getCachedUserProfile('guest-test-123');
      assert(cachedGuest?.username === 'Guest Explorer', 'Guest profile persisted to local cache');

      // Guest profile get returns cached without calling backend
      const guestProfile = await getUserProfile('guest-test-123');
      assert(guestProfile?.username === 'Guest Explorer', 'getUserProfile returns guest profile from local cache');
    }

    // =========================================================================
    // SECTION 4: Authenticated Profile Persistence & Retrieval (Express / MongoDB)
    // =========================================================================
    console.log('\n[4. Authenticated Express MongoDB API Integration]');
    {
      mockStorage.clear();
      currentTestToken = 'token-alice';

      // 4.1 Initial GET before profile is created (404 handled gracefully)
      const initialProfile = await getUserProfile('user-alice-111');
      assert(initialProfile === null, 'Initial profile fetch returns null when not yet created in MongoDB');

      // 4.2 Save profile for Alice via PUT /api/users/me
      await saveUserProfile('user-alice-111', {
        username: 'Alice Engineer',
        email: 'alice@orvix.ai'
      });

      // Cache should be updated
      const aliceCached = getCachedUserProfile('user-alice-111');
      assert(aliceCached?.username === 'Alice Engineer', 'Local cache updated after saveUserProfile');

      // 4.3 Retrieve profile for Alice via GET /api/users/me
      const fetchedAlice = await getUserProfile('user-alice-111');
      assert(fetchedAlice !== null, 'Profile fetched successfully from MongoDB API');
      assert(fetchedAlice?.username === 'Alice Engineer', 'Fetched username matches MongoDB record');
      assert(fetchedAlice?.uid === 'user-alice-111', 'Fetched UID matches verified Firebase user');
      assert(fetchedAlice?.email === 'alice@orvix.ai', 'Fetched email matches input');
    }

    // =========================================================================
    // SECTION 5: Profile Updates & Idempotence
    // =========================================================================
    console.log('\n[5. Profile Updates & Idempotence]');
    {
      currentTestToken = 'token-alice';

      // Update Alice's username
      await saveUserProfile('user-alice-111', {
        username: 'Alice Senior Dev'
      });

      const updated = await getUserProfile('user-alice-111');
      assert(updated?.username === 'Alice Senior Dev', 'Updated username persisted and returned');
      assert(updated?.email === 'alice@orvix.ai', 'Existing email preserved across updates');
    }

    // =========================================================================
    // SECTION 6: Multi-User Identity Isolation & Anti-Spoofing
    // =========================================================================
    console.log('\n[6. Multi-User Boundary & Anti-Spoofing]');
    {
      // Switch active session to Bob
      currentTestToken = 'token-bob';

      // Save Bob's profile
      await saveUserProfile('user-bob-222', {
        username: 'Bob Explorer',
        email: 'bob@orvix.ai'
      });

      const bobProfile = await getUserProfile('user-bob-222');
      assert(bobProfile?.username === 'Bob Explorer', 'Bob profile created and fetched independently');
      assert(bobProfile?.uid === 'user-bob-222', 'Bob UID derived from verified Bob token');

      // Confirm Alice's profile was not modified by Bob
      currentTestToken = 'token-alice';
      const aliceProfile = await getUserProfile('user-alice-111');
      assert(aliceProfile?.username === 'Alice Senior Dev', 'Alice profile intact and isolated from Bob');

      // Confirm Bob cannot overwrite Alice even if he passes Alice's UID in saveUserProfile
      currentTestToken = 'token-bob';
      await saveUserProfile('user-alice-111', {
        username: 'Malicious Overwrite'
      });

      // Alice's profile in database must remain Alice Senior Dev because the server derives identity from Bob's token!
      currentTestToken = 'token-alice';
      mockStorage.clear(); // Clear cache to force fresh DB fetch
      const verifiedAlice = await getUserProfile('user-alice-111');
      assert(verifiedAlice?.username === 'Alice Senior Dev', 'Server-side token verification strictly prevented spoofing Alice');
    }

    // =========================================================================
    // SECTION 7: Offline & Network Error Resilience
    // =========================================================================
    console.log('\n[7. Error Resilience & Fallback]');
    {
      currentTestToken = 'token-alice';
      mockStorage.clear();
      saveCachedUserProfile('user-alice-111', {
        uid: 'user-alice-111',
        username: 'Offline Cached Alice',
        email: 'alice@orvix.ai'
      });

      // Temporarily point API base to an unreachable port to simulate network failure
      const originalApiBase = process.env.TEST_API_BASE;
      process.env.TEST_API_BASE = 'http://127.0.0.1:1'; // Unused port

      const fallbackProfile = await getUserProfile('user-alice-111');
      assert(fallbackProfile?.username === 'Offline Cached Alice', 'Falls back gracefully to local cache when server is unreachable');

      // Restore API base
      process.env.TEST_API_BASE = originalApiBase;
    }

    // =========================================================================
    // SECTION 8: Input Validation Rejections
    // =========================================================================
    console.log('\n[8. Invalid Payload Rejections]');
    {
      currentTestToken = 'token-alice';
      let errorThrown = false;
      try {
        await saveUserProfile('user-alice-111', { username: '' });
      } catch (err: any) {
        errorThrown = true;
        assert(err.message.includes('empty'), 'saveUserProfile throws validation error on empty username');
      }
      assert(errorThrown, 'saveUserProfile rejected invalid username before network call');
    }

    console.log(`\nAll ${passedTests}/${totalTests} User Profile Migration tests PASSED successfully!`);
  } finally {
    server.close();
    resetFirebaseAdminForTesting();
  }
}

runTestSuite().catch((err) => {
  console.error('\nTest Suite Failed:', err);
  process.exit(1);
});
