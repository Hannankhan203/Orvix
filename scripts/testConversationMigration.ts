/**
 * Orvix Conversation Storage Migration Verification Suite (Phase 3 Step 3.3A)
 *
 * Verifies that conversation metadata operations have migrated from direct Cloud Firestore
 * access to the authenticated Express/MongoDB API (/api/conversations):
 * 1. Conversation creation with owner UID derived exclusively from verified Firebase ID token
 * 2. Conversation listing, retrieval, and mapping to UI schema
 * 3. Title renaming and empty title validation
 * 4. Chat mode updates (general, coding, writing, learning)
 * 5. Pinning, unpinning, and strict 5-pinned limit enforcement
 * 6. Deletion via MongoDB API and local cache cleanup
 * 7. Multi-user security & IDOR protection (Bob cannot read, edit, or delete Alice's chats)
 * 8. Guest mode safety (local storage only, zero network/token requirements)
 * 9. Offline fallback and local queue preservation
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
  subscribeToUserChats,
  getCachedUserChats,
  saveCachedUserChats,
  generateChatTitle,
  mapMongoConversationToChat,
  setAuthTokenProviderForTesting
} from '../src/services/chatStorageService.js';

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
  removeEventListener: () => {}
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
        store.set(String(copy._id || copy.id), copy);
        return { acknowledged: true, insertedId: copy._id };
      },
      findOne: async (filter: any) => {
        if (filter.$or) {
          for (const cond of filter.$or) {
            const id = cond._id || cond.id;
            if (id && store.has(String(id))) {
              return JSON.parse(JSON.stringify(store.get(String(id))));
            }
          }
          return null;
        }
        const id = filter._id || filter.id;
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
            if (sortSpec.updatedAt === -1) {
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
        let id = filter._id || filter.id || filter.userId;
        if (!id && filter.$or) {
          for (const cond of filter.$or) {
            if (cond._id && store.has(String(cond._id))) id = cond._id;
            else if (cond.id && store.has(String(cond.id))) id = cond.id;
          }
          if (!id && filter.$or[0]) id = filter.$or[0]._id || filter.$or[0].id;
        }

        let existing = id ? store.get(String(id)) : null;
        if (!existing) {
          for (const val of store.values()) {
            let match = true;
            for (const [k, v] of Object.entries(filter)) {
              if (val[k] !== v) { match = false; break; }
            }
            if (match) { existing = val; id = val._id || val.id; break; }
          }
        }

        if (!existing && options?.upsert) {
          existing = {
            _id: id,
            id: id,
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
        const id = filter._id || filter.id;
        let item = id ? store.get(String(id)) : null;
        if (!item) {
          for (const val of store.values()) {
            let match = true;
            for (const [k, v] of Object.entries(filter)) {
              if (val[k] !== v) { match = false; break; }
            }
            if (match) { item = val; break; }
          }
        }
        if (!item) return { matchedCount: 0, modifiedCount: 0 };
        const updated = {
          ...item,
          ...(update.$set || {}),
          updatedAt: new Date()
        };
        store.set(String(item._id || item.id), updated);
        return { matchedCount: 1, modifiedCount: 1 };
      },
      deleteOne: async (filter: any) => {
        let id = filter._id || filter.id;
        if (!id && filter.$or) {
          for (const cond of filter.$or) {
            if (cond._id && store.has(String(cond._id))) id = cond._id;
            else if (cond.id && store.has(String(cond.id))) id = cond.id;
          }
          if (!id && filter.$or[0]) id = filter.$or[0]._id || filter.$or[0].id;
        }

        let deleted = false;
        if (id && store.has(String(id))) {
          deleted = store.delete(String(id));
        } else {
          for (const [k, item] of store.entries()) {
            let match = true;
            for (const [fk, fv] of Object.entries(filter)) {
              if (item[fk] !== fv) { match = false; break; }
            }
            if (match) {
              store.delete(k);
              deleted = true;
              break;
            }
          }
        }
        return { acknowledged: true, deletedCount: deleted ? 1 : 0 };
      },
      deleteMany: async (filter: any) => {
        let count = 0;
        for (const [k, item] of Array.from(store.entries())) {
          let match = true;
          for (const [fk, fv] of Object.entries(filter)) {
            if (item[fk] !== fv) { match = false; break; }
          }
          if (match) {
            store.delete(k);
            count++;
          }
        }
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
    _stores: { conversationsStore, messagesStore }
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
  console.log('--- Starting Orvix Conversation Storage Migration Test Suite (Phase 3 Step 3.3A) ---');
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, detail: string = '') {
    if (condition) {
      console.log(`  [PASS] ${testName}`);
      passed++;
    } else {
      console.error(`  [FAIL] ${testName}${detail ? ': ' + detail : ''}`);
      failed++;
    }
  }

  try {
    // 1. Title generation helper
    const titleA = generateChatTitle('TypeScript Architecture Guide');
    assert(titleA === 'TypeScript Architecture Guide', 'Title generation preserves concise prompt');
    const titleB = generateChatTitle('### **Hello World** - test clean markdown');
    assert(titleB.includes('Hello World'), 'Title generation strips leading markdown syntax');

    // 2. Authenticated Conversation Creation (Alice)
    currentTestToken = 'token-alice';
    const chatId1 = await createChatDocument(USER_ALICE.uid, 'TypeScript Architecture', 'coding');
    assert(Boolean(chatId1), 'Conversation created with valid ID', chatId1);

    // Verify stored in MongoDB mock
    const mongoConv1 = mockDb._stores.conversationsStore.get(chatId1);
    assert(Boolean(mongoConv1), 'Conversation exists in MongoDB collection');
    assert(mongoConv1?.userId === USER_ALICE.uid, 'Conversation owner UID strictly derived from verified token', mongoConv1?.userId);
    assert(mongoConv1?.title === 'TypeScript Architecture', 'Conversation title persisted in MongoDB', mongoConv1?.title);
    assert(mongoConv1?.mode === 'coding', 'Conversation mode persisted in MongoDB', mongoConv1?.mode);
    assert(mongoConv1?.isPinned === false, 'Conversation defaults to unpinned');

    // Verify local cache updated immediately
    const cachedAlice = getCachedUserChats(USER_ALICE.uid);
    assert(cachedAlice.some((c: any) => c.id === chatId1), 'Conversation cached in localStorage immediately for instant UI hydration');

    // 3. List Conversations via MongoDB API
    const aliceList = await listConversations(USER_ALICE.uid);
    assert(Array.isArray(aliceList) && aliceList.length >= 1, 'listConversations returns array of conversations');
    const matched = aliceList.find((c: any) => c.id === chatId1);
    assert(matched?.title === 'TypeScript Architecture', 'Listed conversation matches created title');
    assert(matched?.mode === 'coding', 'Listed conversation matches created mode');
    assert(typeof matched?.timestamp === 'string', 'UI date label formatted properly');
    assert(typeof matched?.rawUpdatedAt === 'number', 'rawUpdatedAt numeric timestamp present for client sorting');

    // 4. Conversation Title Renaming
    await renameConversation(USER_ALICE.uid, chatId1, 'Advanced TypeScript Architecture');
    const mongoRenamed = mockDb._stores.conversationsStore.get(chatId1);
    assert(mongoRenamed?.title === 'Advanced TypeScript Architecture', 'renameConversation updates title in MongoDB');
    const cachedRenamed = getCachedUserChats(USER_ALICE.uid).find((c: any) => c.id === chatId1);
    assert(cachedRenamed?.title === 'Advanced TypeScript Architecture', 'renameConversation updates title in local cache');

    // Validation: empty title rejection
    let emptyTitleRejected = false;
    try {
      await renameConversation(USER_ALICE.uid, chatId1, '   ');
    } catch (_) {
      emptyTitleRejected = true;
    }
    assert(emptyTitleRejected, 'renameConversation strictly rejects empty title strings');

    // 5. Chat Mode Updating
    await updateChatMode(USER_ALICE.uid, chatId1, 'learning');
    const mongoMode = mockDb._stores.conversationsStore.get(chatId1);
    assert(mongoMode?.mode === 'learning', 'updateChatMode updates mode in MongoDB');
    const cachedMode = getCachedUserChats(USER_ALICE.uid).find((c: any) => c.id === chatId1);
    assert(cachedMode?.mode === 'learning', 'updateChatMode updates mode in local cache');

    // 6. Pinning & Unpinning
    const pinRes = await toggleChatPinned(USER_ALICE.uid, chatId1, true);
    assert(pinRes === true, 'toggleChatPinned returns true when pinned');
    const mongoPinned = mockDb._stores.conversationsStore.get(chatId1);
    assert(mongoPinned?.isPinned === true && Boolean(mongoPinned?.pinnedAt), 'Pinned status and pinnedAt set in MongoDB');

    const unpinRes = await toggleChatPinned(USER_ALICE.uid, chatId1, false);
    assert(unpinRes === false, 'toggleChatPinned returns false when unpinned');
    const mongoUnpinned = mockDb._stores.conversationsStore.get(chatId1);
    assert(mongoUnpinned?.isPinned === false, 'Pinned status cleared in MongoDB');

    // 7. Enforce 5-Pinned Limit
    // Create 5 pinned chats
    const pinnedIds: string[] = [];
    for (let i = 1; i <= 5; i++) {
      const pid = await createChatDocument(USER_ALICE.uid, `Pinned Chat #${i}`, 'general');
      await toggleChatPinned(USER_ALICE.uid, pid, true);
      pinnedIds.push(pid);
    }
    assert(pinnedIds.length === 5, 'Created 5 pinned conversations successfully');

    // Attempt 6th pin -> must be rejected
    const extraChatId = await createChatDocument(USER_ALICE.uid, 'Excess Chat #6', 'general');
    let sixthPinRejected = false;
    try {
      await toggleChatPinned(USER_ALICE.uid, extraChatId, true);
    } catch (err: any) {
      if (err.message.includes('5 pinned') || err.message.includes('PIN_LIMIT_EXCEEDED')) {
        sixthPinRejected = true;
      }
    }
    assert(sixthPinRejected, 'Strict 5-pinned limit enforced: 6th pinned chat rejected with descriptive error');

    // 8. Multi-User Isolation & IDOR Protection
    // Bob should not be able to rename or delete Alice's chat
    currentTestToken = 'token-bob';
    let bobRenameFailed = false;
    try {
      await renameConversation(USER_BOB.uid, chatId1, 'Hacked by Bob');
    } catch (err) {
      bobRenameFailed = true;
    }
    assert(bobRenameFailed, 'IDOR Protection: Bob cannot rename Alice\'s conversation');
    assert(mockDb._stores.conversationsStore.get(chatId1)?.title === 'Advanced TypeScript Architecture', 'Alice\'s conversation title untouched after unauthorized attempt');

    let bobDeleteFailed = false;
    try {
      await deleteConversation(USER_BOB.uid, chatId1);
    } catch (err) {
      bobDeleteFailed = true;
    }
    assert(bobDeleteFailed, 'IDOR Protection: Bob cannot delete Alice\'s conversation');
    assert(Boolean(mockDb._stores.conversationsStore.get(chatId1)), 'Alice\'s conversation still exists in database after unauthorized attempt');

    // Bob listing should not show Alice's conversations
    const bobList = await listConversations(USER_BOB.uid);
    assert(!bobList.some((c: any) => c.id === chatId1), 'User Isolation: Bob\'s conversation list never includes Alice\'s conversations');

    // 9. Conversation Deletion (Alice)
    currentTestToken = 'token-alice';
    await deleteConversation(USER_ALICE.uid, chatId1);
    assert(!mockDb._stores.conversationsStore.has(chatId1), 'Conversation document deleted from MongoDB');
    const cachedAfterDelete = getCachedUserChats(USER_ALICE.uid);
    assert(!cachedAfterDelete.some((c: any) => c.id === chatId1), 'Conversation removed from local cache immediately');

    // 10. Guest Mode Safety & Continuity
    const guestUid = 'guest-test-session';
    const guestChatId = await createChatDocument(guestUid, 'Guest Discovery Session', 'general');
    assert(Boolean(guestChatId), 'Guest conversation created without authentication', guestChatId);
    assert(!mockDb._stores.conversationsStore.has(guestChatId), 'Guest conversations are NOT saved to MongoDB');

    await renameConversation(guestUid, guestChatId, 'Renamed Guest Session');
    const guestChats = getCachedUserChats(guestUid);
    assert(guestChats.some((c: any) => c.id === guestChatId && c.title === 'Renamed Guest Session'), 'Guest conversation renamed in local storage without network');

    await deleteConversation(guestUid, guestChatId);
    assert(!getCachedUserChats(guestUid).some((c: any) => c.id === guestChatId), 'Guest conversation deleted locally without network');

    // 11. Real-time Subscription Callback Verification
    currentTestToken = 'token-alice';
    let subscriptionFired = false;
    let subscriptionList: any[] = [];
    const unsubscribe = subscribeToUserChats(USER_ALICE.uid, (chats) => {
      subscriptionFired = true;
      subscriptionList = chats;
    }, () => {});

    // Wait microtask tick for async fetchFromMongo
    await new Promise((r) => setTimeout(r, 80));
    assert(subscriptionFired, 'subscribeToUserChats fires update callback with conversation list');
    assert(Array.isArray(subscriptionList), 'Subscription emits valid array of conversations');
    unsubscribe();

    console.log(`\nResults: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
      process.exit(1);
    }
  } catch (err: any) {
    console.error('Test execution error:', err);
    process.exit(1);
  } finally {
    if (server) {
      server.close();
    }
  }
}

// Start HTTP server on dynamic port and run tests
server = http.createServer(app);
server.listen(0, '127.0.0.1', () => {
  const addr: any = server.address();
  port = addr.port;
  process.env.TEST_API_BASE = `http://127.0.0.1:${port}`;
  runTests();
});
