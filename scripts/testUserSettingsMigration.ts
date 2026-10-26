/**
 * Orvix User Settings Migration Verification Suite (Phase 3 Step 3.2)
 *
 * Verifies that user-settings persistence has migrated from direct Cloud Firestore
 * operations to the authenticated Express/MongoDB API (/api/user-settings/me):
 * 1. Default settings structure & sanitization
 * 2. Local storage caching & user isolation
 * 3. Guest mode safety & non-blocking local persistence
 * 4. Authenticated preferences creation & retrieval via Express MongoDB API
 * 5. Partial updates without resetting unrelated settings
 * 6. Multi-user identity isolation (token-based UID derivation, zero cross-user leakage)
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
  DEFAULT_SETTINGS,
  THEME_OPTIONS,
  RESPONSE_LENGTH_OPTIONS,
  CHAT_MODE_PREFERENCE_OPTIONS,
  sanitizeSettings,
  resolveEffectiveTheme,
  getStorageKey,
  loadSettings,
  saveSettings,
  setAuthTokenProviderForTesting
} from '../src/services/userSettingsService.js';

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
  matchMedia: (query: string) => ({
    matches: query.includes('dark'),
    addEventListener: () => {},
    removeEventListener: () => {}
  })
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
  const settingsStore = new Map<string, any>();
  const usersStore = new Map<string, any>();

  function makeCollection(store: Map<string, any>, name: string) {
    return {
      name,
      createIndex: async () => `${name}_idx`,
      insertOne: async (doc: any) => {
        const copy = JSON.parse(JSON.stringify(doc));
        store.set(String(copy._id || copy.userId), copy);
        return { acknowledged: true, insertedId: copy._id };
      },
      findOne: async (filter: any) => {
        let id = filter._id || filter.userId;
        if (!id && filter.$or) {
          for (const cond of filter.$or) {
            if (cond._id && store.has(cond._id)) return JSON.parse(JSON.stringify(store.get(cond._id)));
            if (cond.userId && store.has(cond.userId)) return JSON.parse(JSON.stringify(store.get(cond.userId)));
          }
          return null;
        }
        const item = store.get(String(id));
        return item ? JSON.parse(JSON.stringify(item)) : null;
      },
      findOneAndUpdate: async (filter: any, update: any, options: any) => {
        let id = filter._id || filter.userId;
        if (!id && filter.$or) {
          for (const cond of filter.$or) {
            if (cond._id && store.has(cond._id)) id = cond._id;
            else if (cond.userId && store.has(cond.userId)) id = cond.userId;
          }
          if (!id) id = filter.$or[0]._id || filter.$or[0].userId;
        }

        let existing = store.get(String(id));
        if (!existing && options?.upsert) {
          existing = {
            _id: id,
            userId: id,
            ...(update.$setOnInsert || {}),
            createdAt: new Date(),
            updatedAt: new Date()
          };
        }

        if (existing && update.$set) {
          existing = {
            ...existing,
            ...update.$set,
            updatedAt: new Date()
          };
        }

        if (existing) {
          store.set(String(id), JSON.parse(JSON.stringify(existing)));
          return JSON.parse(JSON.stringify(existing));
        }
        return null;
      },
      updateOne: async (filter: any, update: any) => {
        const id = filter._id || filter.userId;
        const existing = store.get(String(id));
        if (!existing) return { matchedCount: 0, modifiedCount: 0 };
        const updated = { ...existing, ...(update.$set || {}), updatedAt: new Date() };
        store.set(String(id), updated);
        return { matchedCount: 1, modifiedCount: 1 };
      },
      deleteOne: async (filter: any) => {
        const id = filter._id || filter.userId;
        const deleted = store.delete(String(id));
        return { acknowledged: true, deletedCount: deleted ? 1 : 0 };
      }
    };
  }

  return {
    collection: (name: string) => {
      if (name === 'user_settings') return makeCollection(settingsStore, name);
      if (name === 'users') return makeCollection(usersStore, name);
      return makeCollection(new Map(), name);
    },
    command: async () => ({ ok: 1 }),
    _stores: { settingsStore, usersStore }
  } as any;
}

const mockDb = createMockDb();
setMockDatabaseForTesting(mockDb);

// Configure mock auth token verifier
setMockAuthVerifierForTesting(async (token: string) => {
  if (token === 'token-alice') return USER_ALICE;
  if (token === 'token-bob') return USER_BOB;
  if (token === 'token-expired') {
    const err: any = new Error('Firebase ID token has expired.');
    err.code = 'auth/id-token-expired';
    throw err;
  }
  const err: any = new Error('Invalid authentication token.');
  err.code = 'auth/invalid-id-token';
  throw err;
});

let server: http.Server;
let port: number;

async function runTests() {
  console.log('--- Starting Orvix User Settings Migration Test Suite ---');
  let passed = 0;
  let failed = 0;

  function assert(title: string, condition: boolean, detail?: any) {
    if (condition) {
      console.log(`  PASS: ${title}`);
      passed++;
    } else {
      console.error(`  FAIL: ${title}`);
      if (detail) console.error('   ', detail);
      failed++;
    }
  }

  // Start temporary server for HTTP endpoints
  await new Promise<void>((resolve) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as any;
      port = addr.port;
      process.env.TEST_API_BASE = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  try {
    // -------------------------------------------------------------------------
    // 1. Settings Sanitization & Defaults
    // -------------------------------------------------------------------------
    console.log('\n[1. Settings Sanitization & Application Constraints]');

    const defaultSanitized = sanitizeSettings(null);
    assert('Null settings sanitizes to DEFAULT_SETTINGS', JSON.stringify(defaultSanitized) === JSON.stringify(DEFAULT_SETTINGS));

    const invalidTheme = sanitizeSettings({ theme: 'neon-purple' });
    assert('Invalid theme restores default theme', invalidTheme.theme === DEFAULT_SETTINGS.theme);

    const validLight = sanitizeSettings({ theme: 'light' });
    assert('Valid light theme accepted', validLight.theme === 'light');

    const invalidResponseLength = sanitizeSettings({ responseLength: 'encyclopedic' });
    assert('Invalid responseLength restores balanced', invalidResponseLength.responseLength === 'balanced');

    const invalidMode = sanitizeSettings({ defaultMode: 'gaming' });
    assert('Invalid defaultMode restores general', invalidMode.defaultMode === 'general');

    const invalidRate = sanitizeSettings({ speechRate: 99 });
    assert('Excessive speech rate clamped/restored', invalidRate.speechRate === DEFAULT_SETTINGS.speechRate);

    const validPartial = sanitizeSettings({ theme: 'dark', enterToSend: false });
    assert('Valid partial updates merge correctly with defaults', validPartial.theme === 'dark' && validPartial.enterToSend === false && validPartial.responseLength === 'balanced');

    // -------------------------------------------------------------------------
    // 2. Storage Key & Local Storage Cache Operations
    // -------------------------------------------------------------------------
    console.log('\n[2. Local Storage Cache Operations & Key Isolation]');

    assert('Registered user gets user-scoped key', getStorageKey('user-alice-111') === 'orvix_user_settings_user-alice-111');
    assert('Guest gets guest storage key', getStorageKey('guest-123') === 'orvix_guest_settings');
    assert('Null userId gets guest storage key', getStorageKey(null) === 'orvix_guest_settings');

    mockStorage.set('orvix_user_settings_user-alice-111', JSON.stringify({ theme: 'light', responseLength: 'concise' }));
    const aliceCached = await loadSettings('user-alice-111');
    assert('loadSettings retrieves from local storage cache', aliceCached.theme === 'light' && aliceCached.responseLength === 'concise');

    mockStorage.clear();

    // -------------------------------------------------------------------------
    // 3. Guest Mode Safety & Offline Continuity
    // -------------------------------------------------------------------------
    console.log('\n[3. Guest Mode Safety & Local Continuity]');

    currentTestToken = null; // No auth token for guest
    const guestSaved = await saveSettings('guest-1234', { theme: 'light', beginnerFriendly: true });
    assert('Guest settings returns sanitized object', guestSaved.theme === 'light' && guestSaved.beginnerFriendly === true);

    const guestStoredRaw = mockStorage.get('orvix_guest_settings');
    assert('Guest settings stored strictly in orvix_guest_settings', Boolean(guestStoredRaw && JSON.parse(guestStoredRaw).theme === 'light'));

    const guestLoaded = await loadSettings('guest-1234');
    assert('loadSettings for guest retrieves from local guest cache', guestLoaded.theme === 'light' && guestLoaded.beginnerFriendly === true);

    // -------------------------------------------------------------------------
    // 4. Authenticated Express MongoDB API Integration
    // -------------------------------------------------------------------------
    console.log('\n[4. Authenticated Express MongoDB API Integration]');

    mockStorage.clear();
    currentTestToken = 'token-alice';

    // Alice saves settings via API
    const aliceSaved = await saveSettings('user-alice-111', {
      theme: 'dark',
      responseLength: 'detailed',
      defaultMode: 'coding',
      beginnerFriendly: true,
      speechRate: 1.25
    });

    assert('saveSettings returns updated settings', aliceSaved.theme === 'dark' && aliceSaved.responseLength === 'detailed');

    // Verify stored in MongoDB mock
    const mongoDoc = mockDb._stores.settingsStore.get('user-alice-111');
    assert('Settings document created in MongoDB store', Boolean(mongoDoc));
    assert('MongoDB record reflects theme: dark', mongoDoc?.theme === 'dark');
    assert('MongoDB record reflects responseLength: detailed', mongoDoc?.responseLength === 'detailed');
    assert('MongoDB record reflects defaultMode: coding', mongoDoc?.defaultMode === 'coding');
    assert('MongoDB record reflects beginnerFriendly: true', mongoDoc?.beginnerFriendly === true);

    // Verify local storage was also updated
    const aliceCachedAfterSave = JSON.parse(mockStorage.get('orvix_user_settings_user-alice-111') || '{}');
    assert('Local storage cache updated after save', aliceCachedAfterSave.theme === 'dark');

    // Alice loads settings (reads from API and syncs)
    mockStorage.clear(); // Clear local cache to force fetch from MongoDB API
    const aliceFetched = await loadSettings('user-alice-111');
    assert('loadSettings fetches persisted settings from MongoDB API', aliceFetched.theme === 'dark' && aliceFetched.defaultMode === 'coding');
    assert('Local cache re-hydrated after API fetch', Boolean(mockStorage.get('orvix_user_settings_user-alice-111')));

    // -------------------------------------------------------------------------
    // 5. Partial Updates & Preservation of Unrelated Settings
    // -------------------------------------------------------------------------
    console.log('\n[5. Partial Updates & Preservation of Unrelated Settings]');

    // Alice updates ONLY theme to 'light'
    const partialUpdate = await saveSettings('user-alice-111', { theme: 'light' });
    assert('Partial update changes theme', partialUpdate.theme === 'light');
    assert('Partial update preserves defaultMode: coding', partialUpdate.defaultMode === 'coding');
    assert('Partial update preserves responseLength: detailed', partialUpdate.responseLength === 'detailed');
    assert('Partial update preserves beginnerFriendly: true', partialUpdate.beginnerFriendly === true);

    const mongoDocAfterPartial = mockDb._stores.settingsStore.get('user-alice-111');
    assert('MongoDB document has theme: light', mongoDocAfterPartial?.theme === 'light');
    assert('MongoDB document kept defaultMode: coding', mongoDocAfterPartial?.defaultMode === 'coding');

    // -------------------------------------------------------------------------
    // 6. Multi-User Boundary & IDOR Prevention
    // -------------------------------------------------------------------------
    console.log('\n[6. Multi-User Boundary & IDOR Prevention]');

    // Switch active user to Bob
    currentTestToken = 'token-bob';
    mockStorage.clear();

    // Bob loads settings: should be isolated and return defaults
    const bobLoaded = await loadSettings('user-bob-222');
    assert('Bob gets default settings, not Alice settings', bobLoaded.theme === DEFAULT_SETTINGS.theme && bobLoaded.defaultMode === DEFAULT_SETTINGS.defaultMode);

    // Bob saves custom settings
    await saveSettings('user-bob-222', { theme: 'system', defaultMode: 'learning' });
    const bobMongoDoc = mockDb._stores.settingsStore.get('user-bob-222');
    assert('Bob settings saved to separate record in MongoDB', bobMongoDoc?.defaultMode === 'learning');

    // Verify Alice settings remain completely unchanged
    const aliceMongoDocCheck = mockDb._stores.settingsStore.get('user-alice-111');
    assert('Alice settings remained untouched when Bob modified his settings', aliceMongoDocCheck?.defaultMode === 'coding');

    // -------------------------------------------------------------------------
    // 7. Error Resilience & Fallback
    // -------------------------------------------------------------------------
    console.log('\n[7. Error Resilience & Fallback]');

    // Set invalid token to simulate expired/rejected session
    currentTestToken = 'token-expired';
    mockStorage.set('orvix_user_settings_user-alice-111', JSON.stringify({ theme: 'dark', responseLength: 'concise' }));

    // Saving with rejected token falls back to local storage without throwing/crashing
    const fallbackSave = await saveSettings('user-alice-111', { theme: 'light' });
    assert('Failed server save falls back to local storage without crashing', fallbackSave.theme === 'light');
    assert('Local storage reflects the fallback save', JSON.parse(mockStorage.get('orvix_user_settings_user-alice-111') || '{}').theme === 'light');

    // Point API base to non-existent port to simulate server offline
    process.env.TEST_API_BASE = 'http://127.0.0.1:59999';
    currentTestToken = 'token-alice';

    const offlineLoad = await loadSettings('user-alice-111');
    assert('Offline load gracefully returns local cache', offlineLoad.theme === 'light');

    const offlineSave = await saveSettings('user-alice-111', { theme: 'dark' });
    assert('Offline save gracefully updates local cache', offlineSave.theme === 'dark');

    console.log('\n======================================================');
    console.log(`  Tests completed: ${passed} passed, ${failed} failed`);
    console.log('======================================================\n');

    if (failed > 0) {
      process.exit(1);
    }
  } finally {
    resetFirebaseAdminForTesting();
    server.close();
  }
}

runTests();
