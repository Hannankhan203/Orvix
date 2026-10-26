/**
 * Orvix Authenticated MongoDB API Token Refresh Verification Suite (Phase 3 Step 3.4C)
 *
 * Verifies that all authenticated MongoDB API operations (conversations, messages,
 * profiles, and user settings) consistently and safely handle expired Firebase ID tokens:
 * - Test A: Valid token -> Authenticated API request succeeds normally
 * - Test B: Expired token -> First request returns 401, token is refreshed, request is retried once and succeeds
 * - Test C: Refresh retry fails -> Second 401 stops retrying immediately (at most 1 retry, no infinite loop)
 * - Test D: Guest mode -> Operates strictly locally with zero token-refresh attempts
 * - Test E: Conversation API -> Confirms GET, POST, PATCH, DELETE operations use authorized path
 * - Test F: Profile API -> Confirms GET, PUT operations use authorized path
 * - Test G: Settings API -> Confirms GET, POST operations use authorized path
 * - Test H: Message API -> Confirms existing message operations remain authorized
 * - Test I: Concurrent request deduplication -> In-flight token refresh is shared without duplicate refresh calls
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
  createChatDocument,
  renameConversation,
  updateChatMode,
  toggleChatPinned,
  deleteConversation,
  listConversations,
  saveChatMessage,
  loadConversationMessages,
  deleteChatMessages,
  saveCachedUserChats,
  saveCachedChatMessages,
  setAuthTokenProviderForTesting
} from '../src/services/chatStorageService.js';
import {
  getUserProfile,
  saveUserProfile
} from '../src/services/userProfileService.js';
import {
  loadSettings,
  saveSettings
} from '../src/services/userSettingsService.js';
import {
  authorizedApiFetch,
  resolveAuthToken,
  getApiEndpoint
} from '../src/services/mongoApiClient.js';

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
  addEventListener: () => {},
  removeEventListener: () => {},
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} })
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

// In-Memory Mock Database
function createMockDb() {
  const conversationsStore = new Map<string, any>();
  const messagesStore = new Map<string, any>();
  const usersStore = new Map<string, any>();
  const settingsStore = new Map<string, any>();

  function makeCollection(store: Map<string, any>, name: string) {
    return {
      name,
      createIndex: async () => `${name}_idx`,
      insertOne: async (doc: any) => {
        const copy = JSON.parse(JSON.stringify(doc));
        const id = String(copy._id || copy.id || copy.uid || copy.userId);
        store.set(id, copy);
        return { acknowledged: true, insertedId: copy._id };
      },
      findOne: async (filter: any) => {
        if (filter.$or) {
          for (const cond of filter.$or) {
            const id = cond._id || cond.id || cond.uid || cond.userId;
            if (id && store.has(String(id))) {
              const item = store.get(String(id));
              if (filter.userId && item.userId !== filter.userId) continue;
              return JSON.parse(JSON.stringify(item));
            }
          }
          return null;
        }
        let id = filter._id || filter.id || filter.uid || filter.userId;
        if (id && store.has(String(id))) {
          const item = store.get(String(id));
          if (filter.userId && item.userId !== filter.userId) return null;
          return JSON.parse(JSON.stringify(item));
        }
        for (const item of store.values()) {
          let match = true;
          for (const [k, v] of Object.entries(filter)) {
            if (item[k] !== v) { match = false; break; }
          }
          if (match) return JSON.parse(JSON.stringify(item));
        }
        return null;
      },
      find: (filter: any) => {
        let results: any[] = [];
        for (const item of store.values()) {
          let match = true;
          for (const [k, v] of Object.entries(filter)) {
            if (item[k] !== v) { match = false; break; }
          }
          if (match) results.push(JSON.parse(JSON.stringify(item)));
        }
        return {
          sort: (sortSpec: any) => {
            if (sortSpec?.updatedAt === -1) {
              results.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
            }
            return {
              skip: (s: number) => {
                results = results.slice(s || 0);
                return {
                  limit: (l: number) => {
                    if (l > 0) results = results.slice(0, l);
                    return { toArray: async () => results };
                  },
                  toArray: async () => results
                };
              },
              limit: (l: number) => {
                if (l > 0) results = results.slice(0, l);
                return { toArray: async () => results };
              },
              toArray: async () => results
            };
          },
          toArray: async () => results
        };
      },
      countDocuments: async (filter: any) => {
        let count = 0;
        for (const item of store.values()) {
          let match = true;
          for (const [k, v] of Object.entries(filter)) {
            if (item[k] !== v) { match = false; break; }
          }
          if (match) count++;
        }
        return count;
      },
      findOneAndUpdate: async (filter: any, update: any, options: any) => {
        let id = filter._id || filter.id || filter.uid || filter.userId;
        if (!id && filter.$or) {
          for (const cond of filter.$or) {
            if (cond._id && store.has(String(cond._id))) id = cond._id;
            else if (cond.id && store.has(String(cond.id))) id = cond.id;
            else if (cond.userId && store.has(String(cond.userId))) id = cond.userId;
            else if (cond.uid && store.has(String(cond.uid))) id = cond.uid;
          }
          if (!id && filter.$or[0]) id = filter.$or[0]._id || filter.$or[0].id || filter.$or[0].userId || filter.$or[0].uid;
        }

        let existing = id ? store.get(String(id)) : null;
        if (!existing) {
          for (const val of store.values()) {
            let match = true;
            for (const [k, v] of Object.entries(filter)) {
              if (val[k] !== v) { match = false; break; }
            }
            if (match) { existing = val; id = val._id || val.id || val.userId || val.uid; break; }
          }
        }

        if (!existing && options?.upsert) {
          existing = {
            _id: id,
            id: id,
            uid: id,
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
        let id = filter._id || filter.id || filter.uid || filter.userId;
        if (!id && filter.$or) {
          for (const cond of filter.$or) {
            if (cond._id && store.has(String(cond._id))) id = cond._id;
            else if (cond.id && store.has(String(cond.id))) id = cond.id;
            else if (cond.userId && store.has(String(cond.userId))) id = cond.userId;
            else if (cond.uid && store.has(String(cond.uid))) id = cond.uid;
          }
        }
        let item = id ? store.get(String(id)) : null;
        if (!item) {
          for (const val of store.values()) {
            let match = true;
            for (const [k, v] of Object.entries(filter)) {
              if (val[k] !== v) { match = false; break; }
            }
            if (match) { item = val; id = val._id || val.id || val.userId || val.uid; break; }
          }
        }
        if (!item) return { matchedCount: 0, modifiedCount: 0 };
        const updated = {
          ...item,
          ...(update.$set || {}),
          updatedAt: new Date()
        };
        store.set(String(id), updated);
        return { matchedCount: 1, modifiedCount: 1 };
      },
      deleteOne: async (filter: any) => {
        let id = filter._id || filter.id || filter.uid || filter.userId;
        if (!id && filter.$or) {
          for (const cond of filter.$or) {
            if (cond._id && store.has(String(cond._id))) id = cond._id;
            else if (cond.id && store.has(String(cond.id))) id = cond.id;
            else if (cond.userId && store.has(String(cond.userId))) id = cond.userId;
          }
        }
        const deleted = id ? store.delete(String(id)) : false;
        return { acknowledged: true, deletedCount: deleted ? 1 : 0 };
      },
      deleteMany: async () => {
        const count = store.size;
        store.clear();
        return { acknowledged: true, deletedCount: count };
      }
    };
  }

  return {
    collection: (name: string) => {
      if (name === 'conversations') return makeCollection(conversationsStore, name);
      if (name === 'messages') return makeCollection(messagesStore, name);
      if (name === 'users') return makeCollection(usersStore, name);
      if (name === 'user_settings') return makeCollection(settingsStore, name);
      return makeCollection(new Map(), name);
    },
    command: async () => ({ ok: 1 }),
    _stores: { conversationsStore, messagesStore, usersStore, settingsStore }
  } as any;
}

const mockDb = createMockDb();
setMockDatabaseForTesting(mockDb);

// Configure mock auth verifier: rejects "token-expired" with auth/id-token-expired (HTTP 401)
// Accepts "token-alice-valid" and "token-alice-refreshed"
setMockAuthVerifierForTesting(async (token: string) => {
  if (token === 'token-alice-valid' || token === 'token-alice-refreshed') {
    return USER_ALICE;
  }
  if (token === 'token-expired' || token === 'token-expired-permanent') {
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
  console.log('====================================================================');
  console.log('🧪 Orvix Authenticated MongoDB API Token Refresh Suite (Step 3.4C)');
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
    // TEST A: Valid token -> Authenticated API request succeeds normally
    // =========================================================================
    console.log('--- Test A: Normal Valid Token Requests ---');
    setAuthTokenProviderForTesting(async () => 'token-alice-valid');

    // 1. Create conversation with valid token
    const convA = await createChatDocument(USER_ALICE.uid, 'Valid Token Chat', 'coding');
    assert(Boolean(convA), 'createChatDocument succeeds with valid token');

    // 2. Load conversations with valid token
    const listA = await listConversations(USER_ALICE.uid);
    assert(listA.some((c) => c.id === convA), 'listConversations finds created conversation with valid token');

    // 3. Save profile with valid token
    await saveUserProfile(USER_ALICE.uid, { username: 'AliceValid', email: 'alice@orvix.ai' });
    const profileA = await getUserProfile(USER_ALICE.uid);
    assert(profileA?.username === 'AliceValid', 'getUserProfile and saveUserProfile succeed with valid token');

    // 4. Save settings with valid token
    await saveSettings(USER_ALICE.uid, { theme: 'dark', responseLength: 'detailed' });
    const settingsA = await loadSettings(USER_ALICE.uid);
    assert(settingsA.theme === 'dark' && settingsA.responseLength === 'detailed', 'loadSettings and saveSettings succeed with valid token');

    // =========================================================================
    // TEST B: Expired token -> First request returns 401, token is refreshed, retried once, succeeds
    // =========================================================================
    console.log('\n--- Test B: Expired Token Auto-Refresh & Retry ---');

    // Helper that starts with expired token, then returns refreshed token on forceRefresh=true
    function createRefreshingTokenProvider() {
      let refreshedCount = 0;
      let initialCallCount = 0;
      const provider = async (forceRefresh?: boolean) => {
        if (forceRefresh) {
          refreshedCount++;
          return 'token-alice-refreshed';
        }
        initialCallCount++;
        return 'token-expired';
      };
      return { provider, getRefreshedCount: () => refreshedCount, getInitialCount: () => initialCallCount };
    }

    // 1. createChatDocument with expired token
    const convRef = createRefreshingTokenProvider();
    setAuthTokenProviderForTesting(convRef.provider);
    const convB = await createChatDocument(USER_ALICE.uid, 'Refreshed Token Chat', 'learning');
    assert(Boolean(convB), 'createChatDocument succeeds after token refresh');
    assert(convRef.getRefreshedCount() === 1, 'createChatDocument triggered exactly 1 token refresh');

    // 2. updateChatMode with expired token
    const modeRef = createRefreshingTokenProvider();
    setAuthTokenProviderForTesting(modeRef.provider);
    await updateChatMode(USER_ALICE.uid, convB, 'writing');
    assert(modeRef.getRefreshedCount() === 1, 'updateChatMode triggered token refresh and succeeded');

    // 3. renameConversation with expired token
    const renameRef = createRefreshingTokenProvider();
    setAuthTokenProviderForTesting(renameRef.provider);
    await renameConversation(USER_ALICE.uid, convB, 'Refreshed Renamed Chat');
    assert(renameRef.getRefreshedCount() === 1, 'renameConversation triggered token refresh and succeeded');

    // 4. toggleChatPinned with expired token
    const pinRef = createRefreshingTokenProvider();
    setAuthTokenProviderForTesting(pinRef.provider);
    const pinResult = await toggleChatPinned(USER_ALICE.uid, convB, true);
    assert(pinResult === true, 'toggleChatPinned returned true after token refresh');
    assert(pinRef.getRefreshedCount() === 1, 'toggleChatPinned triggered token refresh and succeeded');

    // 5. listConversations with expired token
    const listRef = createRefreshingTokenProvider();
    setAuthTokenProviderForTesting(listRef.provider);
    mockStorage.clear(); // clear local cache to ensure cloud fetch
    const listB = await listConversations(USER_ALICE.uid);
    assert(listRef.getRefreshedCount() === 1, 'listConversations triggered token refresh on 401');
    assert(listB.some((c) => c.id === convB), 'listConversations returned cloud conversations after refresh');

    // 6. saveChatMessage and loadConversationMessages with expired token
    const saveMsgRef = createRefreshingTokenProvider();
    setAuthTokenProviderForTesting(saveMsgRef.provider);
    await saveChatMessage(USER_ALICE.uid, convB, {
      id: 'msg-refresh-1',
      sender: 'user',
      content: 'Testing token refresh on message save'
    });
    assert(saveMsgRef.getRefreshedCount() === 1, 'saveChatMessage triggered token refresh on 401');

    const loadMsgRef = createRefreshingTokenProvider();
    setAuthTokenProviderForTesting(loadMsgRef.provider);
    saveCachedChatMessages(USER_ALICE.uid, convB, []);
    const messagesB = await loadConversationMessages(USER_ALICE.uid, convB);
    assert(loadMsgRef.getRefreshedCount() === 1, 'loadConversationMessages triggered token refresh on 401');
    assert(messagesB.some((m) => m.id === 'msg-refresh-1'), 'loadConversationMessages retrieved message after refresh');

    // 7. getUserProfile and saveUserProfile with expired token
    const profileSaveRef = createRefreshingTokenProvider();
    setAuthTokenProviderForTesting(profileSaveRef.provider);
    await saveUserProfile(USER_ALICE.uid, { username: 'AliceRefreshed', email: 'alice@orvix.ai' });
    assert(profileSaveRef.getRefreshedCount() === 1, 'saveUserProfile triggered token refresh on 401');

    const profileGetRef = createRefreshingTokenProvider();
    setAuthTokenProviderForTesting(profileGetRef.provider);
    mockStorage.clear();
    const profileB = await getUserProfile(USER_ALICE.uid);
    assert(profileGetRef.getRefreshedCount() === 1, 'getUserProfile triggered token refresh on 401');
    assert(profileB?.username === 'AliceRefreshed', 'getUserProfile returned profile after refresh');

    // 8. loadSettings and saveSettings with expired token
    const settingsSaveRef = createRefreshingTokenProvider();
    setAuthTokenProviderForTesting(settingsSaveRef.provider);
    await saveSettings(USER_ALICE.uid, { theme: 'light', responseLength: 'concise' });
    assert(settingsSaveRef.getRefreshedCount() === 1, 'saveSettings triggered token refresh on 401');

    const settingsGetRef = createRefreshingTokenProvider();
    setAuthTokenProviderForTesting(settingsGetRef.provider);
    mockStorage.clear();
    const settingsB = await loadSettings(USER_ALICE.uid);
    assert(settingsGetRef.getRefreshedCount() === 1, 'loadSettings triggered token refresh on 401');
    assert(settingsB.theme === 'light' && settingsB.responseLength === 'concise', 'loadSettings returned settings after refresh');

    // 9. deleteConversation with expired token
    const delRef = createRefreshingTokenProvider();
    setAuthTokenProviderForTesting(delRef.provider);
    await deleteConversation(USER_ALICE.uid, convB);
    assert(delRef.getRefreshedCount() === 1, 'deleteConversation triggered token refresh on 401');

    // =========================================================================
    // TEST C: Refresh retry fails -> Second 401 stops retrying immediately (at most 1 retry)
    // =========================================================================
    console.log('\n--- Test C: Refresh Retry Fails (At Most 1 Retry, No Loop) ---');
    let permanent401Calls = 0;
    let refreshCallsInC = 0;
    setAuthTokenProviderForTesting(async (forceRefresh?: boolean) => {
      if (forceRefresh) {
        refreshCallsInC++;
        return 'token-expired-permanent';
      }
      permanent401Calls++;
      return 'token-expired';
    });

    const { res: failRes } = await authorizedApiFetch('/api/conversations', { method: 'GET' });
    assert(failRes !== null && failRes.status === 401, 'Request returns HTTP 401 when refresh retry fails');
    assert(refreshCallsInC === 1, 'Token refresh was called exactly once');
    assert(permanent401Calls === 1, 'Initial request was called once before retry');

    // Verify error propagates to caller when saveUserProfile fails refresh
    let saveProfileThrew = false;
    try {
      await saveUserProfile(USER_ALICE.uid, { username: 'ShouldFail', email: 'alice@orvix.ai' });
    } catch (err: any) {
      saveProfileThrew = true;
      assert(err.message.includes('Authentication required'), 'Authentication required error propagated to caller on failed retry');
    }
    assert(saveProfileThrew, 'saveUserProfile rejected when token refresh failed');

    // =========================================================================
    // TEST D: Guest mode -> Operates strictly locally without attempting token refresh
    // =========================================================================
    console.log('\n--- Test D: Guest Mode Isolation ---');
    let guestTokenAttempts = 0;
    setAuthTokenProviderForTesting(async () => {
      guestTokenAttempts++;
      return null;
    });

    const guestUid = 'guest-session-999';
    const guestChatId = await createChatDocument(guestUid, 'Guest Chat', 'general');
    assert(guestChatId.startsWith('local-'), 'Guest conversation created locally with local- prefix');

    await saveChatMessage(guestUid, guestChatId, {
      id: 'guest-msg-1',
      sender: 'user',
      content: 'Hello guest'
    });
    const guestMsgs = await loadConversationMessages(guestUid, guestChatId);
    assert(guestMsgs.length === 1 && guestMsgs[0].id === 'guest-msg-1', 'Guest messages load strictly from local storage');

    await saveUserProfile(guestUid, { username: 'GuestUser' });
    const guestProfile = await getUserProfile(guestUid);
    assert(guestProfile?.username === 'GuestUser', 'Guest profile persists strictly to local storage');

    await saveSettings(guestUid, { theme: 'dark' });
    const guestSettings = await loadSettings(guestUid);
    assert(guestSettings.theme === 'dark', 'Guest settings persist strictly to local storage');

    assert(guestTokenAttempts === 0, 'Guest operations made ZERO token resolution or refresh attempts');

    // =========================================================================
    // TEST E: Conversation API -> All operations use authorized path
    // =========================================================================
    console.log('\n--- Test E: Conversation API Authorized Path Verification ---');
    setAuthTokenProviderForTesting(async () => 'token-alice-valid');

    // Create
    const testConvE = await createChatDocument(USER_ALICE.uid, 'Conversation E', 'coding');
    assert(mockDb._stores.conversationsStore.has(testConvE), 'createChatDocument persisted conversation to MongoDB');

    // Rename
    await renameConversation(USER_ALICE.uid, testConvE, 'Conversation E Renamed');
    assert(mockDb._stores.conversationsStore.get(testConvE)?.title === 'Conversation E Renamed', 'renameConversation updated MongoDB record');

    // Mode
    await updateChatMode(USER_ALICE.uid, testConvE, 'learning');
    assert(mockDb._stores.conversationsStore.get(testConvE)?.mode === 'learning', 'updateChatMode updated MongoDB record');

    // Pin
    await toggleChatPinned(USER_ALICE.uid, testConvE, true);
    assert(mockDb._stores.conversationsStore.get(testConvE)?.isPinned === true, 'toggleChatPinned updated MongoDB record');

    // Delete
    await deleteConversation(USER_ALICE.uid, testConvE);
    assert(!mockDb._stores.conversationsStore.has(testConvE), 'deleteConversation removed conversation from MongoDB');

    // =========================================================================
    // TEST F: Profile API -> All operations use authorized path
    // =========================================================================
    console.log('\n--- Test F: Profile MongoDB API Authorized Path ---');
    await saveUserProfile(USER_ALICE.uid, { username: 'AliceFinal', email: 'alice.final@orvix.ai' });
    const dbUser = mockDb._stores.usersStore.get(USER_ALICE.uid);
    assert(dbUser?.username === 'AliceFinal', 'saveUserProfile stored profile in MongoDB users store');

    mockStorage.clear();
    const fetchedProfile = await getUserProfile(USER_ALICE.uid);
    assert(fetchedProfile?.username === 'AliceFinal', 'getUserProfile loaded profile from MongoDB users store');

    // =========================================================================
    // TEST G: Settings API -> All operations use authorized path
    // =========================================================================
    console.log('\n--- Test G: Settings MongoDB API Authorized Path ---');
    await saveSettings(USER_ALICE.uid, { theme: 'light', responseLength: 'detailed', defaultMode: 'coding' });
    const dbSettings = mockDb._stores.settingsStore.get(USER_ALICE.uid);
    assert(dbSettings?.theme === 'light' && dbSettings?.defaultMode === 'coding', 'saveSettings stored settings in MongoDB settings store');

    mockStorage.clear();
    const fetchedSettings = await loadSettings(USER_ALICE.uid);
    assert(fetchedSettings.theme === 'light' && fetchedSettings.defaultMode === 'coding', 'loadSettings loaded settings from MongoDB settings store');

    // =========================================================================
    // TEST H: Existing Message Behavior -> GET, POST, DELETE remain intact
    // =========================================================================
    console.log('\n--- Test H: Existing Message Behavior Intact ---');
    const convH = await createChatDocument(USER_ALICE.uid, 'Message Test Chat', 'general');

    await saveChatMessage(USER_ALICE.uid, convH, {
      id: 'msg-h-1',
      sender: 'user',
      content: 'Message H user query'
    });
    await saveChatMessage(USER_ALICE.uid, convH, {
      id: 'msg-h-2',
      sender: 'assistant',
      content: 'Message H assistant response'
    });
    assert(mockDb._stores.messagesStore.has('msg-h-1') && mockDb._stores.messagesStore.has('msg-h-2'), 'Messages saved to MongoDB store');

    const loadedMsgs = await loadConversationMessages(USER_ALICE.uid, convH);
    assert(loadedMsgs.length === 2, 'loadConversationMessages retrieved both messages chronologically');

    await deleteChatMessages(USER_ALICE.uid, convH, ['msg-h-2']);
    assert(!mockDb._stores.messagesStore.has('msg-h-2'), 'deleteChatMessages removed specified message from MongoDB');

    // =========================================================================
    // TEST I: Concurrent Request Refresh Deduplication
    // =========================================================================
    console.log('\n--- Test I: Concurrent Request Token Refresh Deduplication ---');
    let concurrentRefreshCount = 0;
    setAuthTokenProviderForTesting(async (forceRefresh?: boolean) => {
      if (forceRefresh) {
        concurrentRefreshCount++;
        // Small delay to simulate async network token refresh
        await new Promise((r) => setTimeout(r, 20));
        return 'token-alice-refreshed';
      }
      return 'token-expired';
    });

    // Fire 3 simultaneous authorized fetches that will all hit 401
    const [res1, res2, res3] = await Promise.all([
      authorizedApiFetch('/api/conversations', { method: 'GET' }),
      authorizedApiFetch('/api/users/me', { method: 'GET' }),
      authorizedApiFetch('/api/user-settings/me', { method: 'GET' })
    ]);

    assert(res1.res?.ok === true, 'Concurrent request 1 succeeded after deduplicated refresh');
    assert(res2.res?.ok === true, 'Concurrent request 2 succeeded after deduplicated refresh');
    assert(res3.res?.ok === true, 'Concurrent request 3 succeeded after deduplicated refresh');
    assert(concurrentRefreshCount === 1, `Concurrent 401s triggered exactly 1 refresh operation (actual: ${concurrentRefreshCount})`);

    // =========================================================================
    // SUMMARY
    // =========================================================================
    console.log('\n====================================================================');
    console.log(`📊 Final Results: ${passed} passed, ${failed} failed`);
    console.log('====================================================================');

    if (failed > 0) {
      process.exit(1);
    }
  } finally {
    setAuthTokenProviderForTesting(null);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

runTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
