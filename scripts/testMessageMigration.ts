/**
 * Orvix Message Storage Migration Verification Suite (Phase 3 Step 3.3B)
 *
 * Verifies that message creation, loading, deletion, offline replay, and legacy Firestore
 * compatibility work end-to-end against the authenticated Express/MongoDB API (/api/messages):
 * 1. Saving and loading user and assistant messages via authenticated MongoDB API
 * 2. Chronological ordering, identical-timestamp tie-breaking, message IDs, timestamps,
 *    attachment binary stripping + metadata preservation, and response alternatives
 * 3. Conversation ownership, server-derived UID, and cross-user access denial (IDOR & spoofing)
 * 4. Deleting specific messages without affecting unrelated conversations
 * 5. Guest mode isolation (local-only, zero auth/network/MongoDB writes)
 * 6. Offline queueing, reconnect replay, idempotent retries, and duplicate prevention
 * 7. Legacy Firestore message read-only compatibility & hybrid conversation merging
 * 8. Streaming lifecycle & error-message non-persistence regression checks
 * 9. Compatibility with Step 3.3A conversation deletion cascade
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
  loadConversationMessages,
  deleteChatMessages,
  deleteConversation,
  syncOfflineUserChatsToFirestore,
  getCachedUserChats,
  getCachedChatMessages,
  saveCachedChatMessages,
  mapMongoMessageToUiMessage,
  setAuthTokenProviderForTesting,
  setLegacyFirestoreMessagesLoaderForTesting
} from '../src/services/chatStorageService.js';

// Setup Mock LocalStorage & Browser Online Toggle for Node.js test environment
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

// Test User Personas
const USER_ALICE: DecodedIdToken = {
  uid: 'user-alice-33b',
  email: 'alice@orvix.ai',
  email_verified: true,
  name: 'Alice Engineer',
  aud: 'orvix-project',
  auth_time: 1000,
  exp: 9999999999,
  iat: 1000,
  iss: 'https://securetoken.google.com/orvix-project',
  sub: 'user-alice-33b',
  firebase: { identities: { email: ['alice@orvix.ai'] }, sign_in_provider: 'password' }
};

const USER_BOB: DecodedIdToken = {
  uid: 'user-bob-33b',
  email: 'bob@orvix.ai',
  email_verified: true,
  name: 'Bob Reviewer',
  aud: 'orvix-project',
  auth_time: 1000,
  exp: 9999999999,
  iat: 1000,
  iss: 'https://securetoken.google.com/orvix-project',
  sub: 'user-bob-33b',
  firebase: { identities: { email: ['bob@orvix.ai'] }, sign_in_provider: 'password' }
};

let currentTestToken: string | null = null;
setAuthTokenProviderForTesting(async () => currentTestToken);

// Faithful BSON/Date-preserving In-Memory MongoDB Mock for Testing
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
  const usersStore = new Map<string, any>();
  const settingsStore = new Map<string, any>();

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
          if (matchesFilter(item, filter)) {
            return cloneDoc(item);
          }
        }
        return null;
      },
      find: (filter: any = {}) => {
        let items = Array.from(store.values())
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
          const base = {
            ...(update?.$setOnInsert || {}),
            ...(update?.$set || {})
          };
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
            const updated = {
              ...cloneDoc(v),
              ...(update?.$set ? cloneDoc(update.$set) : {})
            };
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
    messages: makeCollection(messagesStore, 'messages'),
    users: makeCollection(usersStore, 'users'),
    user_settings: makeCollection(settingsStore, 'user_settings')
  };

  return {
    command: async () => ({ ok: 1 }),
    collection: (name: string) => collections[name] || makeCollection(new Map(), name),
    _stores: {
      conversationsStore,
      messagesStore,
      usersStore,
      settingsStore
    }
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
let baseUrl = '';

async function runTests() {
  console.log('\n======================================================');
  console.log('🧪 Orvix Message Storage Migration Suite (Step 3.3B)');
  console.log('======================================================\n');

  const mockDb = createMockDb();
  setMockDatabaseForTesting(mockDb as any);

  setMockAuthVerifierForTesting(async (token: string) => {
    if (token === 'token-alice' || token === 'token-alice-refreshed') return USER_ALICE;
    if (token === 'token-bob') return USER_BOB;
    const err: any = new Error('Invalid or expired Firebase ID token');
    err.code = 'auth/id-token-expired';
    throw err;
  });

  try {
    // =========================================================================
    // 1. Save & Load User and Assistant Messages via Authenticated MongoDB API
    // =========================================================================
    console.log('--- 1. Saving & Loading User and Assistant Messages ---');
    mockStorage.clear();
    setOnlineStatus(true);
    currentTestToken = 'token-alice';

    const chat1 = await createChatDocument(USER_ALICE.uid, 'MongoDB Message Architecture', 'coding');
    assert(Boolean(chat1), 'Created parent conversation for Alice', chat1);

    const t0 = 1760000010000;
    const userMsg1 = {
      id: 'msg-user-1',
      sender: 'user',
      content: 'Explain indexes in MongoDB.',
      mode: 'coding',
      timestamp: '10:15 AM',
      createdAtMs: t0,
      attachments: [
        {
          id: 'att-schema-1',
          name: 'schema.sql',
          originalName: 'schema.sql',
          size: 2048,
          formattedSize: '2.0 KB',
          type: 'text/plain',
          extension: 'sql',
          isImage: false,
          status: 'extracted',
          extraction: { text: 'CREATE INDEX idx_conv_created ON messages;', wordCount: 6 },
          // Transient heavy properties that must be stripped before localStorage & API transport
          file: { dummyBlob: true },
          base64: 'SGVsbG8gV29ybGQ=',
          dataUrl: 'data:text/plain;base64,SGVsbG8gV29ybGQ=',
          previewUrl: 'blob:http://localhost:3000/12345'
        }
      ]
    };

    const assistantMsg1 = {
      id: 'msg-assistant-1',
      sender: 'assistant',
      parentMessageId: 'msg-user-1',
      content: 'Compound indexes on `{ conversationId: 1, createdAt: 1 }` optimize chronological queries.',
      provider: 'gemini',
      modelUsed: 'gemini-2.5-flash',
      mode: 'coding',
      responseTimeMs: 842,
      timestamp: '10:15 AM',
      createdAtMs: t0 + 850,
      referencedAttachments: [
        {
          id: 'att-schema-1',
          name: 'schema.sql',
          size: 2048,
          type: 'text/plain',
          extension: 'sql',
          base64: 'SHOULD_BE_STRIPPED'
        }
      ]
    };

    await saveChatMessage(USER_ALICE.uid, chat1, userMsg1);
    await saveChatMessage(USER_ALICE.uid, chat1, assistantMsg1);

    const rawMongoUser1 = mockDb._stores.messagesStore.get('msg-user-1');
    const rawMongoAsst1 = mockDb._stores.messagesStore.get('msg-assistant-1');

    assert(Boolean(rawMongoUser1), 'User message persisted in MongoDB messages collection');
    assert(Boolean(rawMongoAsst1), 'Assistant message persisted in MongoDB messages collection');
    assert(rawMongoUser1?.userId === USER_ALICE.uid, 'User message owner UID derived from verified token');
    assert(rawMongoAsst1?.userId === USER_ALICE.uid, 'Assistant message owner UID derived from verified token');
    assert(rawMongoUser1?.createdAt instanceof Date, 'MongoDB stores createdAt as native BSON Date');
    assert(rawMongoUser1?.createdAt.getTime() === t0, 'Preserved exact client createdAtMs timestamp on save');
    assert(rawMongoUser1?.attachments?.[0]?.base64 === undefined, 'Transient base64 stripped from stored attachment');
    assert(rawMongoUser1?.attachments?.[0]?.file === undefined, 'Transient File object stripped from stored attachment');
    assert(rawMongoUser1?.attachments?.[0]?.dataUrl === undefined, 'Transient dataUrl stripped from stored attachment');
    assert(
      rawMongoUser1?.attachments?.[0]?.extraction?.wordCount === 6,
      'Document extraction metadata preserved intact in MongoDB'
    );
    assert(
      rawMongoAsst1?.referencedAttachments?.[0]?.base64 === undefined,
      'Transient base64 stripped from referencedAttachments'
    );

    // Clear local cache to prove loadConversationMessages fetches from MongoDB API
    saveCachedChatMessages(USER_ALICE.uid, chat1, []);
    const loaded1 = await loadConversationMessages(USER_ALICE.uid, chat1);

    assert(loaded1.length === 2, 'Loaded both messages from MongoDB API after clearing local cache', loaded1.length);
    assert(loaded1[0].id === 'msg-user-1' && loaded1[1].id === 'msg-assistant-1', 'Messages loaded in chronological order');
    assert(loaded1[0].content === userMsg1.content, 'User message content preserved');
    assert(loaded1[0].timestamp === '10:15 AM', 'Client display timestamp preserved');
    assert(loaded1[0].attachments?.[0]?.name === 'schema.sql', 'Attachment metadata restored on load');
    assert(loaded1[1].modelUsed === 'gemini-2.5-flash', 'Assistant modelUsed preserved');
    assert(loaded1[1].provider === 'gemini', 'Assistant provider preserved');
    assert(loaded1[1].responseTimeMs === 842, 'Assistant responseTimeMs preserved');
    assert(loaded1[1].parentMessageId === 'msg-user-1', 'Assistant parentMessageId preserved');
    assert(Array.isArray(loaded1[1].alternatives) && loaded1[1].alternatives.length === 1, 'Assistant alternatives normalized on load');

    // =========================================================================
    // 2. Ordering, Identical-Timestamp Tie-Breaking & Multi-Alternative Updates
    // =========================================================================
    console.log('\n--- 2. Ordering, Tie-Breaking & Response Alternatives ---');
    const sameTickMs = t0 + 5000;
    // Save assistant and user sharing the exact same millisecond timestamp
    await saveChatMessage(USER_ALICE.uid, chat1, {
      id: 'msg-user-tie',
      sender: 'user',
      content: 'Same millisecond prompt',
      timestamp: '10:16 AM',
      createdAtMs: sameTickMs
    });
    await saveChatMessage(USER_ALICE.uid, chat1, {
      id: 'msg-asst-tie',
      sender: 'assistant',
      parentMessageId: 'msg-user-tie',
      content: 'Same millisecond reply',
      provider: 'groq',
      modelUsed: 'llama-3.3-70b-versatile',
      isStopped: true,
      timestamp: '10:16 AM',
      createdAtMs: sameTickMs
    });

    // Add a second alternative response to msg-assistant-1 (simulating Generate Alternative / Switch Alternative)
    const updatedAssistantWithAlt = {
      ...loaded1[1],
      content: 'Alternative explanation using B-Trees and covered queries.',
      provider: 'openrouter',
      modelUsed: 'meta-llama/llama-3.3-70b-instruct:free',
      responseTimeMs: 615,
      activeAlternativeId: 'msg-assistant-1-alt-2',
      alternatives: [
        ...loaded1[1].alternatives,
        {
          id: 'msg-assistant-1-alt-2',
          parentMessageId: 'msg-user-1',
          sender: 'assistant',
          content: 'Alternative explanation using B-Trees and covered queries.',
          provider: 'openrouter',
          modelUsed: 'meta-llama/llama-3.3-70b-instruct:free',
          responseTimeMs: 615,
          timestamp: '10:17 AM',
          createdAt: sameTickMs + 1000,
          referencedAttachments: [],
          isError: false,
          isStopped: false
        }
      ]
    };
    await saveChatMessage(USER_ALICE.uid, chat1, updatedAssistantWithAlt);

    saveCachedChatMessages(USER_ALICE.uid, chat1, []);
    const loaded2 = await loadConversationMessages(USER_ALICE.uid, chat1);
    assert(loaded2.length === 4, 'Updating existing message with alternative did NOT create duplicate message', loaded2.length);
    assert(
      loaded2.map((m: any) => m.id).join(',') === 'msg-user-1,msg-assistant-1,msg-user-tie,msg-asst-tie',
      'Chronological ordering & identical-timestamp tie-breaking preserved original order',
      loaded2.map((m: any) => m.id)
    );
    assert(
      loaded2[1].alternatives.length === 2 && loaded2[1].activeAlternativeId === 'msg-assistant-1-alt-2',
      'Both alternatives and activeAlternativeId persisted and restored accurately'
    );
    assert(loaded2[3].isStopped === true, 'isStopped metadata flag preserved on assistant message');

    // =========================================================================
    // 3. Ownership, Server-Derived UID & Cross-User Access Denial (IDOR)
    // =========================================================================
    console.log('\n--- 3. Conversation Ownership & Cross-User Access Denial ---');

    // 3a. Unauthenticated requests rejected with 401
    const unauthGet = await fetch(`${baseUrl}/api/messages?conversationId=${encodeURIComponent(chat1)}`);
    assert(unauthGet.status === 401, 'Unauthenticated GET /api/messages rejected with 401');

    const unauthPost = await fetch(`${baseUrl}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'unauth-1', conversationId: chat1, sender: 'user', content: 'hi' })
    });
    assert(unauthPost.status === 401, 'Unauthenticated POST /api/messages rejected with 401');

    // 3b. Switch active token to Bob and attempt cross-user read, write, and delete against Alice's chat1
    currentTestToken = 'token-bob';

    let bobLoadDenied = false;
    let bobLoadStatus = 0;
    try {
      await loadConversationMessages(USER_BOB.uid, chat1);
    } catch (err: any) {
      bobLoadDenied = true;
      bobLoadStatus = err.status || 0;
    }
    assert(bobLoadDenied && bobLoadStatus === 403, 'IDOR Protection: Bob denied (403) from loading Alice\'s messages');

    let bobSaveDenied = false;
    let bobSaveStatus = 0;
    try {
      await saveChatMessage(USER_BOB.uid, chat1, {
        id: 'msg-bob-intrusion',
        sender: 'user',
        content: 'Injected into Alice chat'
      });
    } catch (err: any) {
      bobSaveDenied = true;
      bobSaveStatus = err.status || 0;
    }
    assert(bobSaveDenied && bobSaveStatus === 403, 'IDOR Protection: Bob denied (403) from saving into Alice\'s conversation');
    assert(!mockDb._stores.messagesStore.has('msg-bob-intrusion'), 'Rejected cross-user message never written to MongoDB');
    assert(
      getCachedChatMessages(USER_BOB.uid, chat1).length === 0,
      'Optimistic local cache rolled back cleanly on 403 rejection'
    );

    let bobDeleteDenied = false;
    let bobDeleteStatus = 0;
    try {
      await deleteChatMessages(USER_BOB.uid, chat1, ['msg-user-1']);
    } catch (err: any) {
      bobDeleteDenied = true;
      bobDeleteStatus = err.status || 0;
    }
    assert(bobDeleteDenied && bobDeleteStatus === 403, 'IDOR Protection: Bob denied (403) from deleting Alice\'s messages');
    assert(mockDb._stores.messagesStore.has('msg-user-1'), 'Alice\'s message remains intact after Bob\'s unauthorized delete attempt');

    // 3c. Client-supplied UID spoofing test: Bob creates his own chat and posts a message with spoofed userId='user-alice-33b'
    const bobChat = await createChatDocument(USER_BOB.uid, 'Bob Legit Chat', 'general');
    const spoofRes = await fetch(`${baseUrl}/api/messages`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token-bob',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        id: 'msg-bob-spoof-attempt',
        conversationId: bobChat,
        userId: USER_ALICE.uid,
        _id: 'different-internal-id',
        sender: 'user',
        content: 'Testing UID spoofing resistance'
      })
    });
    assert(spoofRes.status === 201, 'Valid message POST to Bob\'s own conversation succeeds');
    const storedSpoofDoc = mockDb._stores.messagesStore.get('msg-bob-spoof-attempt');
    assert(
      storedSpoofDoc?.userId === USER_BOB.uid,
      'Server ignored client-supplied userId and enforced verified token UID (Bob)'
    );

    // 3d. Cross-conversation message ID collision rejected with 409
    const crossCollisionRes = await fetch(`${baseUrl}/api/messages`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token-bob',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        id: 'msg-user-1', // Already belongs to Alice's chat1!
        conversationId: bobChat,
        sender: 'user',
        content: 'Attempt to overwrite Alice message ID via Bob conversation'
      })
    });
    assert(
      crossCollisionRes.status === 409,
      'Cross-conversation message ID collision rejected with 409 Conflict'
    );
    assert(
      mockDb._stores.messagesStore.get('msg-user-1')?.userId === USER_ALICE.uid &&
        mockDb._stores.messagesStore.get('msg-user-1')?.content === userMsg1.content,
      'Alice\'s message completely protected from cross-conversation ID collision'
    );

    // =========================================================================
    // 4. Deleting Specific Messages Without Affecting Unrelated Conversations
    // =========================================================================
    console.log('\n--- 4. Scoped Message Deletion (Edit & Resend Truncation) ---');
    currentTestToken = 'token-alice';
    const chat2 = await createChatDocument(USER_ALICE.uid, 'Alice Second Conversation', 'writing');
    await saveChatMessage(USER_ALICE.uid, chat2, {
      id: 'chat2-msg-1',
      sender: 'user',
      content: 'Draft an executive summary.',
      createdAtMs: t0 + 10000
    });
    await saveChatMessage(USER_ALICE.uid, chat2, {
      id: 'chat2-msg-2',
      sender: 'assistant',
      parentMessageId: 'chat2-msg-1',
      content: 'Here is the executive summary...',
      createdAtMs: t0 + 11000
    });

    // Delete the tie-break pair from chat1, and also pass chat2-msg-1 in the array to prove server scopes strictly to chat1
    await deleteChatMessages(USER_ALICE.uid, chat1, ['msg-user-tie', 'msg-asst-tie', 'chat2-msg-1']);

    const chat1AfterTruncate = await loadConversationMessages(USER_ALICE.uid, chat1);
    const chat2AfterTruncate = await loadConversationMessages(USER_ALICE.uid, chat2);

    assert(
      chat1AfterTruncate.map((m: any) => m.id).join(',') === 'msg-user-1,msg-assistant-1',
      'Target messages deleted cleanly from chat1'
    );
    assert(
      chat2AfterTruncate.map((m: any) => m.id).join(',') === 'chat2-msg-1,chat2-msg-2',
      'Unrelated conversation (chat2) messages completely unaffected even when ID was included in chat1 delete call'
    );

    // =========================================================================
    // 5. Guest Mode Isolation
    // =========================================================================
    console.log('\n--- 5. Guest Mode Isolation ---');
    currentTestToken = null; // No auth token available
    const guestUid = 'guest-session-step33b';
    const mongoMsgCountBeforeGuest = mockDb._stores.messagesStore.size;
    const mongoConvCountBeforeGuest = mockDb._stores.conversationsStore.size;

    const guestChat = await createChatDocument(guestUid, 'Guest Sandbox Chat', 'general');
    await saveChatMessage(guestUid, guestChat, {
      id: 'guest-msg-1',
      sender: 'user',
      content: 'Hello from guest mode!',
      createdAtMs: t0 + 20000
    });
    await saveChatMessage(guestUid, guestChat, {
      id: 'guest-msg-2',
      sender: 'assistant',
      parentMessageId: 'guest-msg-1',
      content: 'Welcome, guest!',
      createdAtMs: t0 + 21000
    });

    const guestLoaded = await loadConversationMessages(guestUid, guestChat);
    assert(guestLoaded.length === 2, 'Guest messages saved and loaded locally without auth token');
    assert(
      mockDb._stores.messagesStore.size === mongoMsgCountBeforeGuest &&
        mockDb._stores.conversationsStore.size === mongoConvCountBeforeGuest,
      'Zero guest conversations or messages written to MongoDB'
    );

    await deleteChatMessages(guestUid, guestChat, ['guest-msg-2']);
    const guestAfterDel = await loadConversationMessages(guestUid, guestChat);
    assert(guestAfterDel.length === 1 && guestAfterDel[0].id === 'guest-msg-1', 'Guest message deletion works locally');

    const guestSyncRes = await syncOfflineUserChatsToFirestore(guestUid);
    assert(
      guestSyncRes.syncedChats === 0 && guestSyncRes.syncedMessages === 0,
      'Offline sync helper skips guest sessions completely'
    );

    // =========================================================================
    // 6. Offline Queueing, Reconnect Replay & Idempotent Duplicate Prevention
    // =========================================================================
    console.log('\n--- 6. Offline Queueing, Reconnect Replay & Idempotent Retries ---');
    currentTestToken = 'token-alice';
    setOnlineStatus(false);

    // 6a. Create conversation & messages while offline
    const offlineChat = await createChatDocument(USER_ALICE.uid, 'Offline Airplane Notes', 'learning');
    await saveChatMessage(USER_ALICE.uid, offlineChat, {
      id: 'off-msg-1',
      sender: 'user',
      content: 'How does Raft consensus elect leaders?',
      createdAtMs: t0 + 30000
    });
    await saveChatMessage(USER_ALICE.uid, offlineChat, {
      id: 'off-msg-2',
      sender: 'assistant',
      parentMessageId: 'off-msg-1',
      content: 'Raft uses randomized election timeouts and majority votes.',
      provider: 'webllm',
      modelUsed: 'Qwen2.5-1.5B-Instruct',
      createdAtMs: t0 + 30500
    });

    // Also queue a message deletion on chat2 while offline
    await deleteChatMessages(USER_ALICE.uid, chat2, ['chat2-msg-2']);

    assert(!mockDb._stores.conversationsStore.has(offlineChat), 'Offline chat queued locally while offline');
    assert(!mockDb._stores.messagesStore.has('off-msg-1'), 'Offline messages queued locally while offline');

    const loadedWhileOffline = await loadConversationMessages(USER_ALICE.uid, offlineChat);
    assert(
      loadedWhileOffline.length === 2 && loadedWhileOffline[0].pendingSync === true,
      'Offline messages load immediately from local cache with pendingSync=true'
    );

    // 6b. Reconnect & replay offline queue
    setOnlineStatus(true);
    const syncOutcome1 = await syncOfflineUserChatsToFirestore(USER_ALICE.uid);
    assert(
      syncOutcome1.syncedChats >= 1 && syncOutcome1.syncedMessages === 2,
      'Reconnect sync replayed offline conversation and both offline messages to MongoDB',
      syncOutcome1
    );
    assert(mockDb._stores.messagesStore.has('off-msg-1') && mockDb._stores.messagesStore.has('off-msg-2'), 'Offline messages now stored in MongoDB');
    assert(!mockDb._stores.messagesStore.has('chat2-msg-2'), 'Queued offline message deletion replayed to MongoDB on reconnect');

    const cachedAfterSync = getCachedChatMessages(USER_ALICE.uid, offlineChat);
    assert(
      cachedAfterSync.every((m: any) => m.pendingSync === false && m.syncedToMongo === true),
      'Local message cache pendingSync flags cleared after successful MongoDB sync'
    );

    // 6c. Idempotent duplicate replay & Edit-in-Place retry
    const syncOutcome2 = await syncOfflineUserChatsToFirestore(USER_ALICE.uid);
    assert(syncOutcome2.syncedMessages === 0, 'Repeated sync is a clean no-op with zero duplicate writes');

    const originalOffMsg1Date = mockDb._stores.messagesStore.get('off-msg-1')?.createdAt?.getTime();
    await saveChatMessage(USER_ALICE.uid, offlineChat, {
      id: 'off-msg-1',
      sender: 'user',
      content: 'How does Raft consensus elect leaders and handle split votes?'
    });
    const updatedOffMsg1Doc = mockDb._stores.messagesStore.get('off-msg-1');
    const reloadedOfflineChat = await loadConversationMessages(USER_ALICE.uid, offlineChat);

    assert(reloadedOfflineChat.length === 2, 'Idempotent retry/edit with same message ID produced zero duplicates');
    assert(
      updatedOffMsg1Doc?.content === 'How does Raft consensus elect leaders and handle split votes?',
      'In-place message edit updated content in MongoDB'
    );
    assert(
      updatedOffMsg1Doc?.createdAt?.getTime() === originalOffMsg1Date,
      'In-place message edit preserved original createdAt timestamp'
    );

    // =========================================================================
    // 7. Legacy Firestore Message Compatibility (Read-Only Non-Destructive Merge)
    // =========================================================================
    console.log('\n--- 7. Legacy Firestore Read-Only Compatibility & Hybrid Merging ---');
    const legacyChatOnly = 'legacy-fs-only-chat';
    const legacyHybridChat = await createChatDocument(USER_ALICE.uid, 'Migrated Metadata + Legacy Messages', 'general');

    const simulatedFirestoreStore: Record<string, any[]> = {
      [`${USER_ALICE.uid}:${legacyChatOnly}`]: [
        {
          id: 'fs-only-1',
          sender: 'user',
          content: 'Legacy Firestore question from before Step 3.3A/3.3B',
          clientTimestamp: '09:00 AM',
          createdAtMs: t0 - 60000
        },
        {
          id: 'fs-only-2',
          sender: 'assistant',
          parentMessageId: 'fs-only-1',
          content: 'Legacy Firestore answer preserved safely.',
          provider: 'gemini',
          modelUsed: 'gemini-2.0-flash',
          clientTimestamp: '09:00 AM',
          createdAtMs: t0 - 59000
        }
      ],
      [`${USER_ALICE.uid}:${legacyHybridChat}`]: [
        {
          id: 'fs-hyb-1',
          sender: 'user',
          content: 'Historical Firestore prompt #1',
          clientTimestamp: '09:10 AM',
          createdAtMs: t0 - 40000
        },
        {
          id: 'fs-hyb-2',
          sender: 'assistant',
          parentMessageId: 'fs-hyb-1',
          content: 'Historical Firestore response #1 (original)',
          provider: 'gemini',
          modelUsed: 'gemini-2.0-flash',
          clientTimestamp: '09:10 AM',
          createdAtMs: t0 - 39000
        }
      ]
    };
    const initialFirestoreSnapshot = JSON.stringify(simulatedFirestoreStore);

    setLegacyFirestoreMessagesLoaderForTesting(async (uid: string, cid: string) => {
      const key = `${uid}:${cid}`;
      return simulatedFirestoreStore[key] ? JSON.parse(JSON.stringify(simulatedFirestoreStore[key])) : [];
    });

    // 7a. Load legacy conversation whose metadata is not even in MongoDB yet (GET /api/messages -> 404)
    const loadedFsOnly = await loadConversationMessages(USER_ALICE.uid, legacyChatOnly);
    assert(
      loadedFsOnly.length === 2 &&
        loadedFsOnly[0].id === 'fs-only-1' &&
        loadedFsOnly[1].id === 'fs-only-2',
      'Pure legacy Firestore conversation remains fully accessible even when parent metadata is 404 in MongoDB'
    );

    // 7b. Hybrid conversation: user regenerates fs-hyb-2 into MongoDB AND appends new messages in MongoDB
    await saveChatMessage(USER_ALICE.uid, legacyHybridChat, {
      id: 'fs-hyb-2',
      sender: 'assistant',
      parentMessageId: 'fs-hyb-1',
      content: 'Historical Firestore response #1 (regenerated in MongoDB)',
      provider: 'gemini',
      modelUsed: 'gemini-2.5-flash',
      createdAtMs: t0 - 39000
    });
    await saveChatMessage(USER_ALICE.uid, legacyHybridChat, {
      id: 'mongo-hyb-3',
      sender: 'user',
      content: 'New follow-up prompt saved in MongoDB',
      createdAtMs: t0 - 10000
    });
    await saveChatMessage(USER_ALICE.uid, legacyHybridChat, {
      id: 'mongo-hyb-4',
      sender: 'assistant',
      parentMessageId: 'mongo-hyb-3',
      content: 'New follow-up reply saved in MongoDB',
      provider: 'gemini',
      modelUsed: 'gemini-2.5-flash',
      createdAtMs: t0 - 9000
    });

    saveCachedChatMessages(USER_ALICE.uid, legacyHybridChat, []);
    const loadedHybrid = await loadConversationMessages(USER_ALICE.uid, legacyHybridChat);
    assert(
      loadedHybrid.map((m: any) => m.id).join(',') === 'fs-hyb-1,fs-hyb-2,mongo-hyb-3,mongo-hyb-4',
      'Hybrid conversation merges legacy Firestore + new MongoDB messages chronologically with ZERO duplicates',
      loadedHybrid.map((m: any) => m.id)
    );
    assert(
      loadedHybrid[1].content === 'Historical Firestore response #1 (regenerated in MongoDB)',
      'MongoDB record takes precedence over legacy Firestore record when message ID overlaps'
    );

    // 7c. Truncating a legacy message honors local tombstone without mutating/deleting Firestore data
    await deleteChatMessages(USER_ALICE.uid, legacyChatOnly, ['fs-only-2']);
    const loadedFsOnlyAfterTruncate = await loadConversationMessages(USER_ALICE.uid, legacyChatOnly);
    assert(
      loadedFsOnlyAfterTruncate.map((m: any) => m.id).join(',') === 'fs-only-1',
      'Truncated legacy message stays hidden via deletion tombstone'
    );
    assert(
      JSON.stringify(simulatedFirestoreStore) === initialFirestoreSnapshot,
      'Legacy Firestore store was NEVER deleted, cleared, or modified during Step 3.3B operations'
    );

    setLegacyFirestoreMessagesLoaderForTesting(null);

    // =========================================================================
    // 8. Streaming Lifecycle & Error-State Regression Checks
    // =========================================================================
    console.log('\n--- 8. Streaming Lifecycle & Error Non-Persistence ---');
    const streamChat = await createChatDocument(USER_ALICE.uid, 'Streaming Test Session', 'general');
    const countBeforeErrorSave = mockDb._stores.messagesStore.size;

    // Pure error message (e.g. failed AI provider call) must NOT be saved
    await saveChatMessage(USER_ALICE.uid, streamChat, {
      id: 'err-msg-ignored',
      sender: 'assistant',
      content: 'Provider quota exceeded',
      isError: true
    });
    assert(
      mockDb._stores.messagesStore.size === countBeforeErrorSave &&
        !mockDb._stores.messagesStore.has('err-msg-ignored'),
      'Failed error messages (isError=true) are never persisted to MongoDB'
    );

    // Simulate ChatPage streaming flow:
    // Step A: User submits prompt -> saved immediately while stream starts concurrently
    const streamUserMsg = {
      id: 'stream-u-1',
      sender: 'user',
      content: 'Stream a poem about distributed databases.',
      createdAtMs: t0 + 50000
    };
    await saveChatMessage(USER_ALICE.uid, streamChat, streamUserMsg);

    // Step B: User stops stream midway (partial content with isInterrupted/isStopped, isError=false)
    const partialStreamMsg = {
      id: 'stream-a-1',
      sender: 'assistant',
      parentMessageId: 'stream-u-1',
      content: 'Across the shards the packets fly...',
      provider: 'gemini',
      modelUsed: 'gemini-2.5-flash',
      isStopped: true,
      isInterrupted: true,
      isError: false,
      createdAtMs: t0 + 50400
    };
    await saveChatMessage(USER_ALICE.uid, streamChat, partialStreamMsg);

    // Step C: User clicks Regenerate on stream-a-1 -> finalized full stream saved to same ID
    await saveChatMessage(USER_ALICE.uid, streamChat, {
      ...partialStreamMsg,
      content: 'Across the shards the packets fly,\nConsensus reached beneath the sky.',
      isStopped: false,
      isInterrupted: false,
      responseTimeMs: 710
    });

    // Also test 401 expired token auto-refresh during message load
    let refreshRequested = false;
    setAuthTokenProviderForTesting(async (forceRefresh?: boolean) => {
      if (forceRefresh) {
        refreshRequested = true;
        return 'token-alice-refreshed';
      }
      return 'expired-token-once';
    });

    saveCachedChatMessages(USER_ALICE.uid, streamChat, []);
    const streamLoaded = await loadConversationMessages(USER_ALICE.uid, streamChat);
    assert(refreshRequested, 'Expired 401 token automatically triggered force-refresh retry');
    assert(
      streamLoaded.length === 2 &&
        streamLoaded[1].id === 'stream-a-1' &&
        streamLoaded[1].isStopped === false &&
        streamLoaded[1].content.includes('Consensus reached'),
      'Streaming partial-stop + regenerate lifecycle persisted cleanly as a single ordered assistant message'
    );

    // Restore normal token provider
    setAuthTokenProviderForTesting(async () => currentTestToken);

    // =========================================================================
    // 9. Compatibility with Step 3.3A Conversation Deletion Cascade
    // =========================================================================
    console.log('\n--- 9. Step 3.3A Conversation Deletion Cascade Compatibility ---');
    assert(
      mockDb._stores.messagesStore.has('stream-u-1') && mockDb._stores.messagesStore.has('stream-a-1'),
      'Stream chat messages exist in MongoDB prior to conversation deletion'
    );

    await deleteConversation(USER_ALICE.uid, streamChat);

    assert(!mockDb._stores.conversationsStore.has(streamChat), 'Parent conversation deleted via Step 3.3A endpoint');
    assert(
      !mockDb._stores.messagesStore.has('stream-u-1') && !mockDb._stores.messagesStore.has('stream-a-1'),
      'Cascading deletion removed all MongoDB messages belonging to deleted conversation'
    );
    assert(
      getCachedChatMessages(USER_ALICE.uid, streamChat).length === 0,
      'Local message cache cleared when conversation is deleted'
    );
    assert(
      mockDb._stores.messagesStore.has('msg-user-1') && mockDb._stores.messagesStore.has('chat2-msg-1'),
      'Unrelated conversations\' messages in MongoDB remain completely untouched after deleting streamChat'
    );

    // Verify mapMongoMessageToUiMessage handles raw documents safely
    const mappedCheck = mapMongoMessageToUiMessage(mockDb._stores.messagesStore.get('msg-user-1'));
    assert(
      mappedCheck?.id === 'msg-user-1' && mappedCheck?.syncedToMongo === true,
      'mapMongoMessageToUiMessage maps raw MongoDB document accurately'
    );

    console.log('\n======================================================');
    console.log(`📊 Final Results: ${passed} passed, ${failed} failed`);
    console.log('======================================================\n');

    if (failed > 0) {
      process.exit(1);
    }
  } catch (err: any) {
    console.error('Unhandled test execution failure:', err);
    process.exit(1);
  } finally {
    resetFirebaseAdminForTesting();
    setMockDatabaseForTesting(null);
    setAuthTokenProviderForTesting(null);
    setLegacyFirestoreMessagesLoaderForTesting(null);
    if (server) {
      server.close();
    }
  }
}

server = http.createServer(app);
server.listen(0, '127.0.0.1', () => {
  const addr: any = server.address();
  baseUrl = `http://127.0.0.1:${addr.port}`;
  process.env.TEST_API_BASE = baseUrl;
  void runTests();
});
