/**
 * Orvix Legacy Firestore Conversation Discovery Verification Suite (Phase 3 Step 3.4B)
 *
 * Verifies read-only legacy Firestore conversation discovery and deterministic merging:
 * - Case A: Legacy-only user on fresh browser/device (sidebar discovery + historical message load + zero writes)
 * - Case B: MongoDB-only user (clean Mongo load + skips unnecessary Firestore message subcollection lookup)
 * - Case C: Hybrid user with distinct conversation IDs across MongoDB and Firestore
 * - Case D: Duplicate chatId in both MongoDB and Firestore (MongoDB strictly authoritative, zero duplicates, hybrid messages)
 * - Case E: Firestore unavailable / error / bounded timeout (MongoDB still succeeds, zero false errors)
 * - Case F: Guest mode (strictly local, zero Firestore or MongoDB calls)
 * - Case G: Offline mode (local cache, pendingSync, pendingMetaSync, and pending-delete preservation)
 * - Case H: Delete legacy & hybrid conversations (MongoDB + Firestore + local cache cleanup)
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
  saveChatMessage,
  renameConversation,
  updateChatMode,
  toggleChatPinned,
  deleteConversation,
  listConversations,
  subscribeToUserChats,
  loadConversationMessages,
  syncOfflineUserChatsToFirestore,
  getCachedUserChats,
  getCachedChatMessages,
  saveCachedChatMessages,
  mapLegacyFirestoreConversationToChat,
  setAuthTokenProviderForTesting,
  setLegacyFirestoreChatsLoaderForTesting,
  setLegacyFirestoreMessagesLoaderForTesting,
  setLegacyFirestoreDeleteHandlerForTesting,
  setFirestoreTimeoutMsForTesting
} from '../src/services/chatStorageService.js';

// Mock LocalStorage & Browser Online Toggle for Node.js test environment
const mockStorage = new Map<string, string>();
(global as any).localStorage = {
  getItem: (key: string) => (mockStorage.has(key) ? mockStorage.get(key)! : null),
  setItem: (key: string, val: string) => mockStorage.set(key, String(val)),
  removeItem: (key: string) => mockStorage.delete(key),
  clear: () => mockStorage.clear(),
  get length() {
    return mockStorage.size;
  },
  key: (index: number) => Array.from(mockStorage.keys())[index] ?? null
};

(global as any).window = {
  localStorage: (global as any).localStorage,
  addEventListener: () => {},
  removeEventListener: () => {}
};

function setOnlineStatus(online: boolean) {
  Object.defineProperty(globalThis, 'navigator', {
    value: { onLine: online },
    configurable: true,
    writable: true
  });
}
setOnlineStatus(true);

const USER_LEGACY: DecodedIdToken = {
  uid: 'user-legacy-34b',
  email: 'legacy@orvix.ai',
  email_verified: true,
  name: 'Legacy User',
  aud: 'orvix-project',
  auth_time: 1000,
  exp: 9999999999,
  iat: 1000,
  iss: 'https://securetoken.google.com/orvix-project',
  sub: 'user-legacy-34b',
  firebase: { identities: { email: ['legacy@orvix.ai'] }, sign_in_provider: 'password' }
};

const USER_MONGO_ONLY: DecodedIdToken = {
  uid: 'user-mongo-34b',
  email: 'mongo@orvix.ai',
  email_verified: true,
  name: 'Mongo User',
  aud: 'orvix-project',
  auth_time: 1000,
  exp: 9999999999,
  iat: 1000,
  iss: 'https://securetoken.google.com/orvix-project',
  sub: 'user-mongo-34b',
  firebase: { identities: { email: ['mongo@orvix.ai'] }, sign_in_provider: 'password' }
};

const USER_HYBRID: DecodedIdToken = {
  uid: 'user-hybrid-34b',
  email: 'hybrid@orvix.ai',
  email_verified: true,
  name: 'Hybrid User',
  aud: 'orvix-project',
  auth_time: 1000,
  exp: 9999999999,
  iat: 1000,
  iss: 'https://securetoken.google.com/orvix-project',
  sub: 'user-hybrid-34b',
  firebase: { identities: { email: ['hybrid@orvix.ai'] }, sign_in_provider: 'password' }
};

let currentTestToken: string | null = null;
setAuthTokenProviderForTesting(async () => currentTestToken);

function cloneDoc<T>(val: T): T {
  if (val instanceof Date) {
    return new Date(val.getTime()) as unknown as T;
  }
  if (Array.isArray(val)) {
    return val.map((item) => cloneDoc(item)) as unknown as T;
  }
  if (val !== null && typeof val === 'object') {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(val as Record<string, any>)) {
      if (v !== undefined) {
        out[k] = cloneDoc(v);
      }
    }
    return out as T;
  }
  return val;
}

function matchesFilter(doc: any, filter: any): boolean {
  if (!filter || Object.keys(filter).length === 0) return true;
  for (const [k, v] of Object.entries(filter)) {
    if (k === '$or' && Array.isArray(v)) {
      if (!v.some((cond) => matchesFilter(doc, cond))) return false;
      continue;
    }
    if (k === '$and' && Array.isArray(v)) {
      if (!v.every((cond) => matchesFilter(doc, cond))) return false;
      continue;
    }
    if (v && typeof v === 'object' && !(v instanceof Date) && '$in' in v) {
      const list = (v as any).$in;
      if (Array.isArray(list) && !list.includes(doc[k])) return false;
      continue;
    }
    if (doc[k] !== v) return false;
  }
  return true;
}

function createMockDb() {
  const conversationsStore = new Map<string, any>();
  const messagesStore = new Map<string, any>();

  function makeCollection(store: Map<string, any>, name: string) {
    return {
      collectionName: name,
      createIndex: async () => `${name}_idx`,
      insertOne: async (doc: any) => {
        const cloned = cloneDoc(doc);
        const id = String(cloned._id ?? cloned.id);
        if (store.has(id)) {
          const dupErr: any = new Error(`E11000 duplicate key error collection: ${name} dup key: { _id: "${id}" }`);
          dupErr.code = 11000;
          throw dupErr;
        }
        store.set(id, cloned);
        return { acknowledged: true, insertedId: cloned._id };
      },
      findOne: async (filter: any) => {
        for (const item of store.values()) {
          if (matchesFilter(item, filter)) return cloneDoc(item);
        }
        return null;
      },
      find: (filter: any = {}) => {
        const items = Array.from(store.values())
          .filter((d) => matchesFilter(d, filter))
          .map((d) => cloneDoc(d));
        let sortSpec: Record<string, 1 | -1> | null = null;
        let skipCount = 0;
        let limitCount = 0;

        const cursor = {
          sort(spec: Record<string, 1 | -1>) {
            sortSpec = spec;
            return cursor;
          },
          skip(n: number) {
            skipCount = Math.max(0, n || 0);
            return cursor;
          },
          limit(n: number) {
            limitCount = Math.max(0, n || 0);
            return cursor;
          },
          async toArray() {
            let out = [...items];
            if (sortSpec) {
              const entries = Object.entries(sortSpec);
              out.sort((a, b) => {
                for (const [field, dir] of entries) {
                  const av = a[field] instanceof Date ? a[field].getTime() : a[field];
                  const bv = b[field] instanceof Date ? b[field].getTime() : b[field];
                  if (av < bv) return dir === 1 ? -1 : 1;
                  if (av > bv) return dir === 1 ? 1 : -1;
                }
                return 0;
              });
            }
            if (skipCount > 0) out = out.slice(skipCount);
            if (limitCount > 0) out = out.slice(0, limitCount);
            return out;
          }
        };
        return cursor;
      },
      countDocuments: async (filter: any = {}) => {
        let count = 0;
        for (const item of store.values()) {
          if (matchesFilter(item, filter)) count++;
        }
        return count;
      },
      findOneAndUpdate: async (filter: any, update: any, options?: any) => {
        let existingKey: string | null = null;
        let existingDoc: any = null;
        for (const [k, v] of store.entries()) {
          if (matchesFilter(v, filter)) {
            existingKey = k;
            existingDoc = v;
            break;
          }
        }
        if (!existingDoc) {
          if (!options?.upsert) return null;
          const base = { ...(update?.$setOnInsert || {}), ...(update?.$set || {}) };
          const newKey = String(base._id ?? base.id ?? Date.now());
          const cloned = cloneDoc(base);
          store.set(newKey, cloned);
          return cloneDoc(cloned);
        }
        const updated = {
          ...cloneDoc(existingDoc),
          ...(update?.$set ? cloneDoc(update.$set) : {})
        };
        store.set(existingKey!, updated);
        return options?.returnDocument === 'before' ? cloneDoc(existingDoc) : cloneDoc(updated);
      },
      updateOne: async (filter: any, update: any) => {
        for (const [k, v] of store.entries()) {
          if (matchesFilter(v, filter)) {
            const updated = { ...cloneDoc(v), ...(update?.$set ? cloneDoc(update.$set) : {}) };
            store.set(k, updated);
            return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
          }
        }
        return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
      },
      deleteOne: async (filter: any) => {
        for (const [k, v] of store.entries()) {
          if (matchesFilter(v, filter)) {
            store.delete(k);
            return { acknowledged: true, deletedCount: 1 };
          }
        }
        return { acknowledged: true, deletedCount: 0 };
      },
      deleteMany: async (filter: any) => {
        let deletedCount = 0;
        for (const [k, v] of Array.from(store.entries())) {
          if (matchesFilter(v, filter)) {
            store.delete(k);
            deletedCount++;
          }
        }
        return { acknowledged: true, deletedCount };
      }
    };
  }

  const collections: Record<string, any> = {
    conversations: makeCollection(conversationsStore, 'conversations'),
    messages: makeCollection(messagesStore, 'messages')
  };

  return {
    command: async () => ({ ok: 1 }),
    collection: (name: string) => collections[name] || makeCollection(new Map(), name),
    _stores: { conversationsStore, messagesStore }
  };
}

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string, detail?: any) {
  if (condition) {
    console.log(`  ✅ PASS: ${label}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${label}`, detail !== undefined ? detail : '');
    failed++;
  }
}

let server: http.Server;

async function runTests() {
  console.log('\n====================================================================');
  console.log('🧪 Orvix Legacy Firestore Conversation Discovery Suite (Step 3.4B)');
  console.log('====================================================================\n');

  const mockDb = createMockDb();
  setMockDatabaseForTesting(mockDb as any);

  setMockAuthVerifierForTesting(async (token: string) => {
    if (token === 'token-legacy') return USER_LEGACY;
    if (token === 'token-mongo') return USER_MONGO_ONLY;
    if (token === 'token-hybrid') return USER_HYBRID;
    const err: any = new Error('Invalid Firebase ID token');
    err.code = 'auth/invalid-id-token';
    throw err;
  });

  // Simulated read-only Firestore state (`users/{uid}/chats` and `messages`)
  const firestoreChatsByUser: Record<string, any[]> = {};
  const firestoreMessagesByChat: Record<string, any[]> = {};
  let firestoreChatReadCalls = 0;
  let firestoreMsgReadCalls = 0;
  let firestoreDeleteCalls = 0;

  setLegacyFirestoreChatsLoaderForTesting(async (uid: string) => {
    firestoreChatReadCalls++;
    const list = firestoreChatsByUser[uid] || [];
    // Return shallow-safe clones while preserving Timestamp-like .toMillis() methods if present
    return list.map((item) => ({ ...item }));
  });

  setLegacyFirestoreMessagesLoaderForTesting(async (uid: string, cid: string) => {
    firestoreMsgReadCalls++;
    const key = `${uid}:${cid}`;
    return firestoreMessagesByChat[key] ? JSON.parse(JSON.stringify(firestoreMessagesByChat[key])) : [];
  });

  setLegacyFirestoreDeleteHandlerForTesting(async (uid: string, cid: string) => {
    firestoreDeleteCalls++;
    if (Array.isArray(firestoreChatsByUser[uid])) {
      firestoreChatsByUser[uid] = firestoreChatsByUser[uid].filter((c) => c.id !== cid);
    }
    delete firestoreMessagesByChat[`${uid}:${cid}`];
  });

  const tBase = 1765000000000;

  try {
    // =========================================================================
    // Case A — Legacy-only user on fresh browser/device
    // =========================================================================
    console.log('--- Case A: Legacy-Only User on Fresh Browser/Device ---');
    mockStorage.clear();
    setOnlineStatus(true);
    currentTestToken = 'token-legacy';

    firestoreChatsByUser[USER_LEGACY.uid] = [
      {
        id: 'fs-legacy-older',
        // Missing title & mode -> must default cleanly to 'Untitled Chat' & 'general'
        createdAt: { toMillis: () => tBase - 20000 },
        updatedAt: { toMillis: () => tBase - 15000 }
      },
      {
        id: 'fs-legacy-newer',
        title: 'Pre-Migration Research Notes',
        mode: 'learning',
        isPinned: true,
        pinnedAt: { seconds: Math.floor((tBase - 5000) / 1000), nanoseconds: 0 },
        createdAt: { toMillis: () => tBase - 10000 },
        updatedAt: { toMillis: () => tBase - 5000 }
      }
    ];
    firestoreMessagesByChat[`${USER_LEGACY.uid}:fs-legacy-newer`] = [
      {
        id: 'fs-msg-1',
        sender: 'user',
        content: 'Summarize distributed consensus before Phase 3.',
        clientTimestamp: '08:30 AM',
        createdAtMs: tBase - 9000
      },
      {
        id: 'fs-msg-2',
        sender: 'assistant',
        parentMessageId: 'fs-msg-1',
        content: 'Paxos and Raft guarantee safety under asynchronous networks.',
        provider: 'gemini',
        modelUsed: 'gemini-2.0-flash',
        clientTimestamp: '08:30 AM',
        createdAtMs: tBase - 8000
      }
    ];

    const fsChatSnapshotBeforeA = firestoreChatsByUser[USER_LEGACY.uid].length;

    // 1. Fresh device listConversations()
    const legacyList = await listConversations(USER_LEGACY.uid);
    assert(legacyList.length === 2, 'Fresh browser discovers both legacy Firestore conversations', legacyList.length);
    assert(
      legacyList[0].id === 'fs-legacy-newer' && legacyList[1].id === 'fs-legacy-older',
      'Legacy conversations sorted deterministically by updatedAt descending'
    );
    assert(
      legacyList[0].title === 'Pre-Migration Research Notes' &&
        legacyList[0].mode === 'learning' &&
        legacyList[0].isPinned === true,
      'Legacy conversation preserves title, mode, and pinned status'
    );
    assert(
      legacyList[1].title === 'Untitled Chat' &&
        legacyList[1].mode === 'general' &&
        legacyList[1].isPinned === false &&
        legacyList[1].pinnedAt === null,
      'Missing optional legacy fields default safely to Orvix UI defaults'
    );
    assert(
      mockDb._stores.conversationsStore.size === 0,
      'Read-only discovery does NOT bulk-migrate or write untouched legacy chats to MongoDB'
    );

    // 2. Fresh device subscribeToUserChats() (sidebar path)
    mockStorage.clear();
    let subUpdates: any[][] = [];
    let subError: any = null;
    const unsubLegacy = subscribeToUserChats(
      USER_LEGACY.uid,
      (chats) => subUpdates.push(chats),
      (err) => {
        subError = err;
      }
    );
    await new Promise((r) => setTimeout(r, 60));
    unsubLegacy();

    assert(subError === null, 'subscribeToUserChats completes without errors for legacy-only user');
    assert(
      subUpdates.length >= 1 && subUpdates[subUpdates.length - 1].length === 2,
      'Sidebar subscription emits discovered legacy Firestore conversations on fresh browser'
    );

    // 3. Opening legacy conversation loads historical Firestore messages
    const beforeOpenMsgReads = firestoreMsgReadCalls;
    const legacyMessages = await loadConversationMessages(USER_LEGACY.uid, 'fs-legacy-newer');
    assert(
      legacyMessages.length === 2 &&
        legacyMessages[0].id === 'fs-msg-1' &&
        legacyMessages[1].id === 'fs-msg-2',
      'Opening discovered legacy conversation loads historical Firestore messages'
    );
    assert(firestoreMsgReadCalls === beforeOpenMsgReads + 1, 'Legacy message loader invoked once when opening legacy chat');

    // 4. Reconnect sync does NOT write untouched legacy chats to MongoDB or Firestore
    const noopSync = await syncOfflineUserChatsToFirestore(USER_LEGACY.uid);
    assert(
      noopSync.syncedChats === 0 &&
        noopSync.syncedMessages === 0 &&
        mockDb._stores.conversationsStore.size === 0 &&
        firestoreChatsByUser[USER_LEGACY.uid].length === fsChatSnapshotBeforeA,
      'Untouched legacy conversations remain strictly read-only across sync cycles'
    );

    // =========================================================================
    // Case B — MongoDB-only user (and skipping unnecessary Firestore message lookups)
    // =========================================================================
    console.log('\n--- Case B: MongoDB-Only User & Skipping Legacy Message Lookup ---');
    mockStorage.clear();
    currentTestToken = 'token-mongo';
    firestoreChatsByUser[USER_MONGO_ONLY.uid] = [];

    const mongoChat1 = await createChatDocument(USER_MONGO_ONLY.uid, 'Modern Mongo Conversation', 'coding');
    await saveChatMessage(USER_MONGO_ONLY.uid, mongoChat1, {
      id: 'm-only-1',
      sender: 'user',
      content: 'Write a TypeScript generic helper.',
      createdAtMs: tBase + 1000
    });
    await saveChatMessage(USER_MONGO_ONLY.uid, mongoChat1, {
      id: 'm-only-2',
      sender: 'assistant',
      parentMessageId: 'm-only-1',
      content: 'export function identity<T>(val: T): T { return val; }',
      provider: 'gemini',
      modelUsed: 'gemini-2.5-flash',
      createdAtMs: tBase + 1500
    });

    // Clear local cache to simulate fresh browser load for MongoDB-only user
    mockStorage.clear();
    const mongoOnlyList = await listConversations(USER_MONGO_ONLY.uid);
    assert(
      mongoOnlyList.length === 1 &&
        mongoOnlyList[0].id === mongoChat1 &&
        mongoOnlyList[0].hasLegacyFirestore === false,
      'MongoDB-only conversation loaded cleanly and marked internally as non-legacy'
    );

    const msgReadsBeforeMongoOnly = firestoreMsgReadCalls;
    saveCachedChatMessages(USER_MONGO_ONLY.uid, mongoChat1, []);
    const mongoOnlyMsgs = await loadConversationMessages(USER_MONGO_ONLY.uid, mongoChat1);
    assert(mongoOnlyMsgs.length === 2, 'MongoDB-only messages loaded accurately');
    assert(
      firestoreMsgReadCalls === msgReadsBeforeMongoOnly,
      'Skipped legacy Firestore message lookup for confirmed MongoDB-only conversation'
    );

    // =========================================================================
    // Case C — Hybrid user with different conversation IDs
    // =========================================================================
    console.log('\n--- Case C: Hybrid User (Distinct MongoDB + Legacy Firestore IDs) ---');
    mockStorage.clear();
    currentTestToken = 'token-hybrid';

    // Seed two legacy conversations in Firestore for USER_HYBRID
    firestoreChatsByUser[USER_HYBRID.uid] = [
      {
        id: 'hyb-legacy-1',
        title: 'Legacy Architecture Draft',
        mode: 'writing',
        isPinned: false,
        updatedAt: tBase + 2000
      },
      {
        id: 'hyb-legacy-2',
        title: 'Legacy Python Debugging',
        mode: 'coding',
        isPinned: false,
        updatedAt: tBase - 30000
      }
    ];

    // Seed two MongoDB conversations for USER_HYBRID with distinct timestamps
    const hybMongo1 = await createChatDocument(USER_HYBRID.uid, 'Mongo System Design', 'coding');
    mockDb._stores.conversationsStore.get(hybMongo1).updatedAt = new Date(tBase + 5000);

    const hybMongo2 = await createChatDocument(USER_HYBRID.uid, 'Mongo Essay Outline', 'writing');
    mockDb._stores.conversationsStore.get(hybMongo2).updatedAt = new Date(tBase - 1000);

    mockStorage.clear();
    const hybridDistinctList = await listConversations(USER_HYBRID.uid);
    assert(
      hybridDistinctList.map((c: any) => c.id).join(',') ===
        `${hybMongo1},hyb-legacy-1,${hybMongo2},hyb-legacy-2`,
      'Hybrid user merges MongoDB and legacy Firestore conversations in deterministic updatedAt order without duplicates',
      hybridDistinctList.map((c: any) => c.id)
    );

    // Mode-filtered listConversations check
    const codingOnly = await listConversations(USER_HYBRID.uid, { mode: 'coding' });
    assert(
      codingOnly.map((c: any) => c.id).join(',') === `${hybMongo1},hyb-legacy-2`,
      'Mode filter applies consistently across merged MongoDB and legacy conversations'
    );
    assert(
      getCachedUserChats(USER_HYBRID.uid).length === 4,
      'Filtered listConversations does not overwrite full cached conversation list'
    );

    // =========================================================================
    // Case D — Duplicate chatId in both MongoDB and Firestore
    // =========================================================================
    console.log('\n--- Case D: Duplicate chatId in Both MongoDB and Firestore ---');
    const sharedChatId = 'shared-overlap-chat-01';

    // Add sharedChatId to Firestore with stale metadata (and artificially future timestamp > Date.now() to prove Mongo still wins!)
    const staleFutureFsMs = Date.now() + 9_999_999;
    firestoreChatsByUser[USER_HYBRID.uid].push({
      id: sharedChatId,
      title: 'Stale Firestore Title',
      mode: 'general',
      isPinned: false,
      updatedAt: staleFutureFsMs
    });
    firestoreMessagesByChat[`${USER_HYBRID.uid}:${sharedChatId}`] = [
      {
        id: 'shared-msg-1',
        sender: 'user',
        content: 'Original question in Firestore',
        createdAtMs: tBase - 50000
      },
      {
        id: 'shared-msg-2',
        sender: 'assistant',
        parentMessageId: 'shared-msg-1',
        content: 'Stale Firestore answer',
        provider: 'gemini',
        modelUsed: 'gemini-2.0-flash',
        createdAtMs: tBase - 49000
      }
    ];

    // Insert authoritative metadata + newer messages in MongoDB for the exact same sharedChatId
    mockDb._stores.conversationsStore.set(sharedChatId, {
      _id: sharedChatId,
      id: sharedChatId,
      userId: USER_HYBRID.uid,
      title: 'Authoritative MongoDB Title',
      mode: 'coding',
      isPinned: true,
      pinnedAt: new Date(tBase + 10000),
      createdAt: new Date(tBase - 50000),
      updatedAt: new Date(tBase + 10000)
    });

    await saveChatMessage(USER_HYBRID.uid, sharedChatId, {
      id: 'shared-msg-2',
      sender: 'assistant',
      parentMessageId: 'shared-msg-1',
      content: 'Regenerated authoritative answer in MongoDB',
      provider: 'gemini',
      modelUsed: 'gemini-2.5-flash',
      createdAtMs: tBase - 49000
    });
    await saveChatMessage(USER_HYBRID.uid, sharedChatId, {
      id: 'shared-msg-3',
      sender: 'user',
      content: 'New follow-up stored in MongoDB',
      createdAtMs: tBase + 9500
    });

    const expectedMongoUpdatedMs = mockDb._stores.conversationsStore
      .get(sharedChatId)
      .updatedAt.getTime();

    mockStorage.clear();
    const dedupedList = await listConversations(USER_HYBRID.uid);
    const matchingShared = dedupedList.filter((c: any) => c.id === sharedChatId);
    assert(matchingShared.length === 1, 'Overlapping chatId appears strictly ONCE (zero duplicates)');
    assert(
      matchingShared[0].title === 'Authoritative MongoDB Title' &&
        matchingShared[0].mode === 'coding' &&
        matchingShared[0].isPinned === true &&
        matchingShared[0].rawUpdatedAt === expectedMongoUpdatedMs &&
        matchingShared[0].rawUpdatedAt !== staleFutureFsMs,
      'MongoDB metadata strictly takes precedence over stale Firestore metadata for same chatId',
      matchingShared[0]
    );
    assert(
      matchingShared[0].storageSource === 'hybrid' && matchingShared[0].hasLegacyFirestore === true,
      'Overlapping chatId marked internally as hybrid so historical Firestore messages remain accessible'
    );

    const sharedMessages = await loadConversationMessages(USER_HYBRID.uid, sharedChatId);
    assert(
      sharedMessages.map((m: any) => m.id).join(',') === 'shared-msg-1,shared-msg-2,shared-msg-3',
      'Hybrid conversation merges Firestore + MongoDB messages chronologically without duplicates'
    );
    assert(
      sharedMessages[1].content === 'Regenerated authoritative answer in MongoDB',
      'MongoDB message overrides legacy Firestore message on overlapping message ID'
    );

    // Also verify renaming a legacy-only conversation promotes metadata to MongoDB without mutating Firestore
    await renameConversation(USER_HYBRID.uid, 'hyb-legacy-1', 'Renamed Legacy Draft in Mongo');
    const promotedMongoDoc = mockDb._stores.conversationsStore.get('hyb-legacy-1');
    const untouchedFsDoc = firestoreChatsByUser[USER_HYBRID.uid].find((c) => c.id === 'hyb-legacy-1');
    assert(
      promotedMongoDoc?.title === 'Renamed Legacy Draft in Mongo' &&
        untouchedFsDoc?.title === 'Legacy Architecture Draft',
      'Renaming a legacy-only conversation saves to MongoDB while leaving Firestore strictly read-only'
    );

    // =========================================================================
    // Case E — Firestore unavailable / error / timeout
    // =========================================================================
    console.log('\n--- Case E: Firestore Error & Bounded Timeout Fallback ---');
    currentTestToken = 'token-mongo';

    // E1. Permission-denied / unavailable error from Firestore
    setLegacyFirestoreChatsLoaderForTesting(async () => {
      const fsErr: any = new Error('Missing or insufficient permissions.');
      fsErr.code = 'permission-denied';
      throw fsErr;
    });

    let subErrOnFsFail: any = null;
    let subChatsOnFsFail: any[] = [];
    const unsubErrCheck = subscribeToUserChats(
      USER_MONGO_ONLY.uid,
      (chats) => {
        subChatsOnFsFail = chats;
      },
      (err) => {
        subErrOnFsFail = err;
      }
    );
    await new Promise((r) => setTimeout(r, 60));
    unsubErrCheck();

    const listOnFsFail = await listConversations(USER_MONGO_ONLY.uid);
    assert(
      listOnFsFail.length === 1 && listOnFsFail[0].id === mongoChat1,
      'listConversations still returns MongoDB conversations when Firestore throws permission-denied'
    );
    assert(
      subErrOnFsFail === null && subChatsOnFsFail.length === 1,
      'subscribeToUserChats emits MongoDB conversations and does NOT fire onError when Firestore fails'
    );

    // E2. Bounded timeout when Firestore hangs
    setFirestoreTimeoutMsForTesting(60);
    setLegacyFirestoreChatsLoaderForTesting(
      () => new Promise((resolve) => setTimeout(() => resolve([]), 500))
    );

    const tStartTimeout = Date.now();
    const listOnFsTimeout = await listConversations(USER_MONGO_ONLY.uid);
    const elapsedMs = Date.now() - tStartTimeout;
    assert(
      listOnFsTimeout.length === 1 && elapsedMs < 350,
      `Firestore timeout bounded cleanly (${elapsedMs}ms) without blocking MongoDB conversations`
    );

    // Restore normal test loader & default timeout
    setFirestoreTimeoutMsForTesting(null);
    setLegacyFirestoreChatsLoaderForTesting(async (uid: string) => {
      firestoreChatReadCalls++;
      return (firestoreChatsByUser[uid] || []).map((item) => ({ ...item }));
    });

    // =========================================================================
    // Case F — Guest mode
    // =========================================================================
    console.log('\n--- Case F: Guest Mode Isolation ---');
    currentTestToken = null;
    const guestUid = 'guest-session-step34b';
    const fsReadsBeforeGuest = firestoreChatReadCalls;
    const fsMsgReadsBeforeGuest = firestoreMsgReadCalls;
    const fsDeletesBeforeGuest = firestoreDeleteCalls;
    const mongoConvsBeforeGuest = mockDb._stores.conversationsStore.size;

    const guestChatId = await createChatDocument(guestUid, 'Guest Local Chat', 'general');
    const guestList = await listConversations(guestUid);
    let guestSubList: any[] = [];
    const unsubGuest = subscribeToUserChats(guestUid, (chats) => {
      guestSubList = chats;
    });
    const guestMsgs = await loadConversationMessages(guestUid, guestChatId);
    await deleteConversation(guestUid, guestChatId);
    unsubGuest();

    assert(
      guestList.length === 1 && guestSubList.length === 1 && Array.isArray(guestMsgs),
      'Guest conversations operate locally without authentication'
    );
    assert(
      firestoreChatReadCalls === fsReadsBeforeGuest &&
        firestoreMsgReadCalls === fsMsgReadsBeforeGuest &&
        firestoreDeleteCalls === fsDeletesBeforeGuest &&
        mockDb._stores.conversationsStore.size === mongoConvsBeforeGuest,
      'Guest mode makes ZERO Firestore discovery/message/delete calls and ZERO MongoDB writes'
    );

    // =========================================================================
    // Case G — Offline mode (cache, pendingSync, pendingMetaSync, pending-delete)
    // =========================================================================
    console.log('\n--- Case G: Offline Mode & Pending Sync/Delete Preservation ---');
    currentTestToken = 'token-hybrid';
    setOnlineStatus(true);

    // Hydrate USER_HYBRID cache while online
    await listConversations(USER_HYBRID.uid);

    // Transition offline
    setOnlineStatus(false);
    const fsReadsBeforeOffline = firestoreChatReadCalls;

    const offlineCreatedId = await createChatDocument(USER_HYBRID.uid, 'Offline Draft Chat', 'general');
    await renameConversation(USER_HYBRID.uid, hybMongo2, 'Offline Renamed Essay');
    await deleteConversation(USER_HYBRID.uid, 'hyb-legacy-2');

    const offlineList = await listConversations(USER_HYBRID.uid);
    assert(
      firestoreChatReadCalls === fsReadsBeforeOffline,
      'Offline listConversations makes zero Firestore calls'
    );
    assert(
      offlineList.some((c: any) => c.id === offlineCreatedId && c.createdOffline === true),
      'Offline-created conversation preserved in local list'
    );
    assert(
      offlineList.some((c: any) => c.id === hybMongo2 && c.title === 'Offline Renamed Essay' && c.pendingMetaSync === true),
      'Offline metadata rename preserved with pendingMetaSync=true'
    );
    assert(
      !offlineList.some((c: any) => c.id === 'hyb-legacy-2'),
      'Offline-deleted legacy conversation removed immediately from local list'
    );

    // Reconnect online BEFORE replaying sync: merge must STILL respect pending edits & pending-delete tombstones!
    setOnlineStatus(true);
    const mergedBeforeSyncReplay = await listConversations(USER_HYBRID.uid);
    assert(
      mergedBeforeSyncReplay.some((c: any) => c.id === offlineCreatedId),
      'Pending offline-created chat survives online refresh before sync replay completes'
    );
    assert(
      mergedBeforeSyncReplay.find((c: any) => c.id === hybMongo2)?.title === 'Offline Renamed Essay',
      'Pending local metadata edit takes precedence over cloud metadata before sync replay'
    );
    assert(
      !mergedBeforeSyncReplay.some((c: any) => c.id === 'hyb-legacy-2'),
      'Pending-delete tombstone prevents offline-deleted legacy chat from reappearing on reconnect'
    );

    // Replay offline queue -> syncs creation, rename, and legacy deletion cleanup
    await syncOfflineUserChatsToFirestore(USER_HYBRID.uid);
    assert(
      mockDb._stores.conversationsStore.has(offlineCreatedId) &&
        mockDb._stores.conversationsStore.get(hybMongo2)?.title === 'Offline Renamed Essay' &&
        !firestoreChatsByUser[USER_HYBRID.uid].some((c) => c.id === 'hyb-legacy-2'),
      'Reconnect sync replayed offline creation, offline rename, and queued legacy Firestore deletion'
    );

    // =========================================================================
    // Case H — Delete legacy conversation (pure legacy & hybrid)
    // =========================================================================
    console.log('\n--- Case H: Delete Legacy & Hybrid Conversations ---');
    currentTestToken = 'token-legacy';
    setOnlineStatus(true);
    await listConversations(USER_LEGACY.uid);

    const deletesBeforeH = firestoreDeleteCalls;
    await deleteConversation(USER_LEGACY.uid, 'fs-legacy-newer');

    assert(
      firestoreDeleteCalls === deletesBeforeH + 1 &&
        !firestoreChatsByUser[USER_LEGACY.uid].some((c) => c.id === 'fs-legacy-newer') &&
        !firestoreMessagesByChat[`${USER_LEGACY.uid}:fs-legacy-newer`],
      'Deleting legacy-only conversation executes Firestore parent + message cleanup'
    );
    assert(
      !getCachedUserChats(USER_LEGACY.uid).some((c: any) => c.id === 'fs-legacy-newer') &&
        getCachedChatMessages(USER_LEGACY.uid, 'fs-legacy-newer').length === 0,
      'Local chat and message caches cleared immediately upon deleting legacy conversation'
    );

    const remainingLegacy = await listConversations(USER_LEGACY.uid);
    assert(
      remainingLegacy.map((c: any) => c.id).join(',') === 'fs-legacy-older',
      'Deleted legacy conversation no longer appears in subsequent listConversations'
    );

    // Also delete hybrid conversation (sharedChatId) for USER_HYBRID -> cleans up BOTH MongoDB and Firestore
    currentTestToken = 'token-hybrid';
    await deleteConversation(USER_HYBRID.uid, sharedChatId);
    assert(
      !mockDb._stores.conversationsStore.has(sharedChatId) &&
        !mockDb._stores.messagesStore.has('shared-msg-2') &&
        !mockDb._stores.messagesStore.has('shared-msg-3') &&
        !firestoreChatsByUser[USER_HYBRID.uid].some((c) => c.id === sharedChatId),
      'Deleting hybrid conversation cleans up MongoDB conversation + MongoDB messages + legacy Firestore documents'
    );

    // Direct unit check on mapLegacyFirestoreConversationToChat edge cases
    const mappedNull = mapLegacyFirestoreConversationToChat('', {});
    assert(mappedNull === null, 'mapLegacyFirestoreConversationToChat safely returns null for empty ID');

    console.log('\n====================================================================');
    console.log(`📊 Final Results: ${passed} passed, ${failed} failed`);
    console.log('====================================================================\n');

    if (failed > 0) {
      process.exit(1);
    }
  } catch (err: any) {
    console.error('Unhandled test failure in testLegacyConversationDiscovery:', err);
    process.exit(1);
  } finally {
    resetFirebaseAdminForTesting();
    setMockDatabaseForTesting(null);
    setAuthTokenProviderForTesting(null);
    setLegacyFirestoreChatsLoaderForTesting(null);
    setLegacyFirestoreMessagesLoaderForTesting(null);
    setLegacyFirestoreDeleteHandlerForTesting(null);
    setFirestoreTimeoutMsForTesting(null);
    if (server) {
      server.close();
    }
  }
}

server = http.createServer(app);
server.listen(0, '127.0.0.1', () => {
  const addr: any = server.address();
  process.env.TEST_API_BASE = `http://127.0.0.1:${addr.port}`;
  void runTests();
});
