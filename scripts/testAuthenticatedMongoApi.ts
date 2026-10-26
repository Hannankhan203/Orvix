/**
 * Orvix Authenticated MongoDB API Verification Test Suite (Phase 3 Step 2)
 *
 * Comprehensive end-to-end testing of MongoDB-backed endpoints:
 * 1. Unauthenticated & Invalid Token Access Rejections (HTTP 401)
 * 2. User Profile CRUD and IDOR prevention across accounts (HTTP 403)
 * 3. Conversation CRUD, Owner UID derivation, and Cross-User Protections (HTTP 403)
 * 4. Pinned Conversations Limit Enforcement (Maximum 5 per user, HTTP 400)
 * 5. Message CRUD, Cross-Conversation Hijacking Prevention, and Read Protections
 * 6. Conversation Deletion with Automatic Message Cleanup (Cascading Deletion)
 * 7. User Settings Isolation and IDOR Prevention
 * 8. Malformed IDs, Invalid Payloads, and Existing Endpoint Regressions
 *
 * Usage:
 *   npm run test:mongo-api
 *   # or: npx tsx scripts/testAuthenticatedMongoApi.ts
 */

process.env.TESTING = 'true';
import dotenv from 'dotenv';
dotenv.config();

import type { DecodedIdToken } from 'firebase-admin/auth';
import { app } from '../server.ts';
import {
  setMockAuthVerifierForTesting,
  resetFirebaseAdminForTesting
} from '../src/services/firebaseAdminService.ts';
import {
  connectToDatabase,
  isMongoConfigured,
  setMockDatabaseForTesting
} from '../src/db/mongodb.ts';
import {
  deleteConversationsByUserId
} from '../src/repositories/conversationRepository.ts';
import {
  deleteUser
} from '../src/repositories/userRepository.ts';
import {
  deleteUserSettings
} from '../src/repositories/userSettingsRepository.ts';

// In-memory HTTP simulator
async function simulateRequest(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: any
): Promise<{ status: number; data: any; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const lowerHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      lowerHeaders[k.toLowerCase()] = v;
    }

    const [pathname, queryString] = path.split('?');
    const query: Record<string, string> = {};
    if (queryString) {
      const searchParams = new URLSearchParams(queryString);
      searchParams.forEach((val, key) => {
        query[key] = val;
      });
    }

    const req: any = {
      method,
      url: path,
      originalUrl: path,
      path: pathname,
      headers: lowerHeaders,
      body: body || {},
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
      socket: { setTimeout: () => {}, setNoDelay: () => {}, setKeepAlive: () => {} },
      on: () => res,
      emit: () => true,
      listeners: () => []
    };

    try {
      app(req, res);
    } catch (err) {
      reject(err);
    }
  });
}

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
  name: 'Bob Attacker',
  aud: 'orvix-project',
  auth_time: 1000,
  exp: 9999999999,
  iat: 1000,
  iss: 'https://securetoken.google.com/orvix-project',
  sub: 'user-bob-222',
  firebase: { identities: { email: ['bob@orvix.ai'] }, sign_in_provider: 'password' }
};

function matchesFilter(doc: any, filter: any): boolean {
  if (!filter || Object.keys(filter).length === 0) return true;
  for (const [key, value] of Object.entries(filter)) {
    if (key === '$or' && Array.isArray(value)) {
      const orMatch = value.some((subFilter) => matchesFilter(doc, subFilter));
      if (!orMatch) return false;
      continue;
    }
    if (key === '$and' && Array.isArray(value)) {
      const andMatch = value.every((subFilter) => matchesFilter(doc, subFilter));
      if (!andMatch) return false;
      continue;
    }
    if (value && typeof value === 'object' && '$in' in value) {
      const inList = (value as any).$in;
      if (Array.isArray(inList) && !inList.includes(doc[key])) return false;
      continue;
    }
    if (doc[key] !== value) return false;
  }
  return true;
}

function createInMemoryMockCollection(name: string) {
  const store = new Map<string, any>();

  return {
    name,
    createIndex: async () => `${name}_idx`,
    insertOne: async (doc: any) => {
      const cloned = JSON.parse(JSON.stringify(doc));
      if (doc.createdAt instanceof Date) cloned.createdAt = doc.createdAt;
      if (doc.updatedAt instanceof Date) cloned.updatedAt = doc.updatedAt;
      if (doc.pinnedAt instanceof Date) cloned.pinnedAt = doc.pinnedAt;
      store.set(String(cloned._id || cloned.id), cloned);
      return { acknowledged: true, insertedId: cloned._id };
    },
    findOne: async (filter: any, options?: any) => {
      const docs = Array.from(store.values()).filter((d) => matchesFilter(d, filter));
      if (options?.sort) {
        const sortKey = Object.keys(options.sort)[0];
        const dir = options.sort[sortKey];
        docs.sort((a, b) => (a[sortKey] > b[sortKey] ? dir : -dir));
      }
      return docs[0] ? JSON.parse(JSON.stringify(docs[0])) : null;
    },
    find: (filter: any) => {
      let docs = Array.from(store.values()).filter((d) => matchesFilter(d, filter));
      let sortKey: string | null = null;
      let sortDir = 1;
      let skipVal = 0;
      let limitVal: number | null = null;

      const cursor = {
        sort: (sortObj: any) => {
          if (sortObj) {
            sortKey = Object.keys(sortObj)[0];
            sortDir = sortObj[sortKey];
            docs.sort((a, b) => {
              const va = a[sortKey!];
              const vb = b[sortKey!];
              return (va > vb ? 1 : va < vb ? -1 : 0) * sortDir;
            });
          }
          return cursor;
        },
        skip: (n: number) => {
          skipVal = n;
          return cursor;
        },
        limit: (n: number) => {
          limitVal = n;
          return cursor;
        },
        toArray: async () => {
          let res = docs.slice(skipVal);
          if (limitVal !== null && limitVal > 0) {
            res = res.slice(0, limitVal);
          }
          return JSON.parse(JSON.stringify(res));
        }
      };
      return cursor;
    },
    findOneAndUpdate: async (filter: any, update: any, options?: any) => {
      let existing = Array.from(store.values()).find((d) => matchesFilter(d, filter));
      if (!existing && options?.upsert) {
        existing = {
          _id: filter._id || filter.id || filter.userId,
          ...(update.$setOnInsert || {}),
          ...(update.$set || {})
        };
        store.set(String(existing._id), existing);
        return JSON.parse(JSON.stringify(existing));
      }
      if (!existing) return null;
      if (update.$set) {
        Object.assign(existing, update.$set);
      }
      store.set(String(existing._id), existing);
      return JSON.parse(JSON.stringify(existing));
    },
    updateOne: async (filter: any, update: any) => {
      const existing = Array.from(store.values()).find((d) => matchesFilter(d, filter));
      if (!existing) return { matchedCount: 0, modifiedCount: 0, acknowledged: true };
      if (update.$set) {
        Object.assign(existing, update.$set);
      }
      store.set(String(existing._id), existing);
      return { matchedCount: 1, modifiedCount: 1, acknowledged: true };
    },
    countDocuments: async (filter: any) => {
      return Array.from(store.values()).filter((d) => matchesFilter(d, filter)).length;
    },
    deleteOne: async (filter: any) => {
      const existing = Array.from(store.values()).find((d) => matchesFilter(d, filter));
      if (!existing) return { acknowledged: true, deletedCount: 0 };
      store.delete(String(existing._id));
      return { acknowledged: true, deletedCount: 1 };
    },
    deleteMany: async (filter: any) => {
      const toDelete = Array.from(store.values()).filter((d) => matchesFilter(d, filter));
      for (const item of toDelete) {
        store.delete(String(item._id));
      }
      return { acknowledged: true, deletedCount: toDelete.length };
    }
  };
}

function createInMemoryMockDb() {
  const collections = new Map<string, any>();
  return {
    collection: (name: string) => {
      if (!collections.has(name)) {
        collections.set(name, createInMemoryMockCollection(name));
      }
      return collections.get(name);
    },
    command: async () => ({ ok: 1 }),
    listCollections: () => ({ toArray: async () => [{ name: 'users' }, { name: 'conversations' }, { name: 'messages' }, { name: 'user_settings' }] })
  };
}

async function run() {
  console.log('====================================================');
  console.log('  Orvix Authenticated MongoDB API Test Suite        ');
  console.log('  Phase 3 Step 2: Ownership, Identity & Security    ');
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

  // Connect to database if configured, or use isolated in-memory mock Db
  if (isMongoConfigured()) {
    await connectToDatabase().catch((e) => {
      console.warn('MongoDB connection note during tests:', e?.message || e);
    });
  } else {
    console.log('[Test Setup] MONGODB_URI unconfigured: using in-memory Mock MongoDB database for unit tests.');
    setMockDatabaseForTesting(createInMemoryMockDb());
  }

  // Clean test user data from prior runs if connected
  try {
    await deleteConversationsByUserId('user-alice-111');
    await deleteConversationsByUserId('user-bob-222');
    await deleteUser('user-alice-111');
    await deleteUser('user-bob-222');
    await deleteUserSettings('user-alice-111');
    await deleteUserSettings('user-bob-222');
  } catch (_) {}

  // Mock token verification to recognize Alice and Bob
  setMockAuthVerifierForTesting(async (token: string) => {
    if (token === 'token-alice') return USER_ALICE;
    if (token === 'token-bob') return USER_BOB;
    if (token === 'expired-token') {
      const err = new Error('Token expired');
      (err as any).code = 'auth/id-token-expired';
      throw err;
    }
    const err = new Error('Invalid token');
    (err as any).code = 'auth/invalid-id-token';
    throw err;
  });

  const authAlice = { authorization: 'Bearer token-alice' };
  const authBob = { authorization: 'Bearer token-bob' };

  try {
    // ---------------------------------------------------------------------------
    // 1. Unauthenticated & Invalid Token Access Rejections
    // ---------------------------------------------------------------------------
    console.log('--- [1/8] Unauthenticated & Invalid Token Access Rejections ---');

    const noToken1 = await simulateRequest('GET', '/api/conversations');
    assert('GET /api/conversations without token returns HTTP 401', noToken1.status === 401 && noToken1.data?.code === 'AUTH_TOKEN_MISSING');

    const noToken2 = await simulateRequest('POST', '/api/conversations', {}, { title: 'Secret' });
    assert('POST /api/conversations without token returns HTTP 401', noToken2.status === 401 && noToken2.data?.code === 'AUTH_TOKEN_MISSING');

    const noToken3 = await simulateRequest('GET', '/api/user-settings/me');
    assert('GET /api/user-settings/me without token returns HTTP 401', noToken3.status === 401 && noToken3.data?.code === 'AUTH_TOKEN_MISSING');

    const invalidToken = await simulateRequest('GET', '/api/conversations', { authorization: 'Bearer invalid-token' });
    assert('Invalid token returns HTTP 401 AUTH_TOKEN_INVALID', invalidToken.status === 401 && invalidToken.data?.code === 'AUTH_TOKEN_INVALID');

    const expiredToken = await simulateRequest('GET', '/api/conversations', { authorization: 'Bearer expired-token' });
    assert('Expired token returns HTTP 401 AUTH_TOKEN_EXPIRED', expiredToken.status === 401 && expiredToken.data?.code === 'AUTH_TOKEN_EXPIRED');

    // ---------------------------------------------------------------------------
    // 2. User Profile CRUD and IDOR Prevention
    // ---------------------------------------------------------------------------
    console.log('\n--- [2/8] User Profile CRUD and IDOR Prevention ---');

    // Alice creates / updates her profile
    const aliceUpsert = await simulateRequest('PUT', '/api/users/me', authAlice, {
      username: 'Alice Explorer',
      email: 'alice@orvix.ai'
    });
    assert('PUT /api/users/me creates profile returning HTTP 200', aliceUpsert.status === 200 && aliceUpsert.data?.user?.username === 'Alice Explorer');
    assert('Profile UID is derived from verified token', aliceUpsert.data?.user?.uid === 'user-alice-111');

    // Alice reads her profile via /users/me
    const aliceGetMe = await simulateRequest('GET', '/api/users/me', authAlice);
    assert('GET /api/users/me returns Alice profile', aliceGetMe.status === 200 && aliceGetMe.data?.user?.username === 'Alice Explorer');

    // Alice reads her profile via /users/user-alice-111
    const aliceGetId = await simulateRequest('GET', '/api/users/user-alice-111', authAlice);
    assert('GET /api/users/:userId with matching UID returns HTTP 200', aliceGetId.status === 200 && aliceGetId.data?.user?.uid === 'user-alice-111');

    // Bob tries to read Alice's profile (IDOR Attack)
    const bobReadAlice = await simulateRequest('GET', '/api/users/user-alice-111', authBob);
    assert('Bob reading Alice profile is rejected with HTTP 403 FORBIDDEN', bobReadAlice.status === 403 && bobReadAlice.data?.code === 'FORBIDDEN');

    // Bob tries to modify Alice's profile (IDOR Attack)
    const bobModifyAlice = await simulateRequest('PUT', '/api/users/user-alice-111', authBob, {
      username: 'Hacked By Bob'
    });
    assert('Bob modifying Alice profile is rejected with HTTP 403 FORBIDDEN', bobModifyAlice.status === 403 && bobModifyAlice.data?.code === 'FORBIDDEN');

    // Invalid username rejection
    const invalidUsername = await simulateRequest('PUT', '/api/users/me', authAlice, {
      username: 'A' // Too short (< 2 chars)
    });
    assert('Too short username returns HTTP 400 INVALID_USERNAME', invalidUsername.status === 400 && invalidUsername.data?.code === 'INVALID_USERNAME');

    // ---------------------------------------------------------------------------
    // 3. Conversation CRUD & Strict Ownership Enforcement
    // ---------------------------------------------------------------------------
    console.log('\n--- [3/8] Conversation CRUD & Ownership Enforcement ---');

    // Alice creates conversation #1
    const createConv1 = await simulateRequest('POST', '/api/conversations', authAlice, {
      id: 'conv-alice-test-1',
      title: 'Alice Project Roadmap',
      mode: 'coding',
      userId: 'spoofed-hacker-id' // Client-supplied userId must be ignored
    });
    assert('POST /api/conversations returns HTTP 201', createConv1.status === 201);
    assert('Conversation ID matches requested ID', createConv1.data?.conversation?._id === 'conv-alice-test-1');
    assert('Conversation userId is strictly Alice (ignoring spoofed body)', createConv1.data?.conversation?.userId === 'user-alice-111');

    // Alice lists conversations
    const listAlice = await simulateRequest('GET', '/api/conversations', authAlice);
    assert('Alice lists her conversation', listAlice.status === 200 && listAlice.data?.conversations?.length >= 1);

    // Bob lists conversations: should be empty for Bob
    const listBob = await simulateRequest('GET', '/api/conversations', authBob);
    assert('Bob cannot see Alice conversations in list', listBob.status === 200 && listBob.data?.conversations?.every((c: any) => c.userId === 'user-bob-222'));

    // Bob tries to read Alice conversation directly (Cross-User Access)
    const bobGetAliceConv = await simulateRequest('GET', '/api/conversations/conv-alice-test-1', authBob);
    assert('Bob reading Alice conversation returns HTTP 403 FORBIDDEN', bobGetAliceConv.status === 403 && bobGetAliceConv.data?.code === 'FORBIDDEN');

    // Bob tries to patch Alice conversation
    const bobPatchAliceConv = await simulateRequest('PATCH', '/api/conversations/conv-alice-test-1', authBob, {
      title: 'Hacked Title'
    });
    assert('Bob patching Alice conversation returns HTTP 403 FORBIDDEN', bobPatchAliceConv.status === 403 && bobPatchAliceConv.data?.code === 'FORBIDDEN');

    // Bob tries to delete Alice conversation
    const bobDeleteAliceConv = await simulateRequest('DELETE', '/api/conversations/conv-alice-test-1', authBob);
    assert('Bob deleting Alice conversation returns HTTP 403 FORBIDDEN', bobDeleteAliceConv.status === 403 && bobDeleteAliceConv.data?.code === 'FORBIDDEN');

    // Alice updates her own conversation title
    const alicePatch = await simulateRequest('PATCH', '/api/conversations/conv-alice-test-1', authAlice, {
      title: 'Alice Updated Roadmap'
    });
    assert('Alice updates own conversation title returning HTTP 200', alicePatch.status === 200 && alicePatch.data?.conversation?.title === 'Alice Updated Roadmap');

    // ---------------------------------------------------------------------------
    // 4. Pinned Conversations Limit Enforcement (Maximum 5)
    // ---------------------------------------------------------------------------
    console.log('\n--- [4/8] Pinned Conversations Limit Enforcement (Max 5) ---');

    // Pin conv #1
    await simulateRequest('PATCH', '/api/conversations/conv-alice-test-1', authAlice, { isPinned: true });

    // Create 4 more pinned conversations for Alice (total 5)
    for (let i = 2; i <= 5; i++) {
      const res = await simulateRequest('POST', '/api/conversations', authAlice, {
        id: `conv-alice-pin-${i}`,
        title: `Pinned Chat ${i}`,
        isPinned: true
      });
      assert(`Alice creates pinned conversation #${i} successfully`, res.status === 201 && res.data?.conversation?.isPinned === true);
    }

    // Try to create a 6th pinned conversation (must fail with PIN_LIMIT_EXCEEDED)
    const pinExceededCreate = await simulateRequest('POST', '/api/conversations', authAlice, {
      id: 'conv-alice-pin-6',
      title: 'Pinned Chat 6 (Exceeded)',
      isPinned: true
    });
    assert('Creating 6th pinned conversation is rejected with HTTP 400', pinExceededCreate.status === 400);
    assert('Error code is PIN_LIMIT_EXCEEDED', pinExceededCreate.data?.code === 'PIN_LIMIT_EXCEEDED');

    // Create 6th conversation UNPINNED, then try to pin it via PATCH
    await simulateRequest('POST', '/api/conversations', authAlice, {
      id: 'conv-alice-unpinned-6',
      title: 'Unpinned Chat 6',
      isPinned: false
    });
    const pinExceededPatch = await simulateRequest('PATCH', '/api/conversations/conv-alice-unpinned-6', authAlice, {
      isPinned: true
    });
    assert('Patching to pin 6th conversation is rejected with HTTP 400 PIN_LIMIT_EXCEEDED', pinExceededPatch.status === 400 && pinExceededPatch.data?.code === 'PIN_LIMIT_EXCEEDED');

    // Idempotent re-pin of already pinned conversation succeeds
    const idempotentPin = await simulateRequest('PATCH', '/api/conversations/conv-alice-test-1', authAlice, {
      isPinned: true
    });
    assert('Re-pinning already pinned conversation succeeds (idempotent)', idempotentPin.status === 200 && idempotentPin.data?.conversation?.isPinned === true);

    // ---------------------------------------------------------------------------
    // 5. Message CRUD & Cross-Conversation Security
    // ---------------------------------------------------------------------------
    console.log('\n--- [5/8] Message CRUD & Cross-Conversation Security ---');

    // Alice posts a message to her conversation
    const createMsg = await simulateRequest('POST', '/api/messages', authAlice, {
      id: 'msg-alice-test-1',
      conversationId: 'conv-alice-test-1',
      content: 'Hello, this is my confidential project note.',
      sender: 'user'
    });
    assert('Alice posts message returning HTTP 201', createMsg.status === 201);
    assert('Message ID matches requested ID', createMsg.data?.message?._id === 'msg-alice-test-1');
    assert('Message userId is derived as Alice', createMsg.data?.message?.userId === 'user-alice-111');

    // Bob tries to post a message into Alice's conversation (Cross-Conversation Hijack)
    const bobHijackPost = await simulateRequest('POST', '/api/messages', authBob, {
      id: 'msg-bob-hijack',
      conversationId: 'conv-alice-test-1',
      content: 'I am injecting a message into Alice conversation!'
    });
    assert('Bob posting to Alice conversation returns HTTP 403 FORBIDDEN', bobHijackPost.status === 403 && bobHijackPost.data?.code === 'FORBIDDEN');

    // Bob tries to list messages in Alice's conversation
    const bobListAliceMsgs = await simulateRequest('GET', '/api/messages?conversationId=conv-alice-test-1', authBob);
    assert('Bob listing Alice messages returns HTTP 403 FORBIDDEN', bobListAliceMsgs.status === 403 && bobListAliceMsgs.data?.code === 'FORBIDDEN');

    // Bob tries to read Alice's message directly by ID
    const bobGetAliceMsg = await simulateRequest('GET', '/api/messages/msg-alice-test-1', authBob);
    assert('Bob reading Alice message returns HTTP 403 FORBIDDEN', bobGetAliceMsg.status === 403 && bobGetAliceMsg.data?.code === 'FORBIDDEN');

    // Bob tries to update Alice's message
    const bobUpdateAliceMsg = await simulateRequest('PATCH', '/api/messages/msg-alice-test-1', authBob, {
      content: 'Altered content by Bob'
    });
    assert('Bob modifying Alice message returns HTTP 403 FORBIDDEN', bobUpdateAliceMsg.status === 403 && bobUpdateAliceMsg.data?.code === 'FORBIDDEN');

    // Bob tries to delete Alice's message
    const bobDeleteAliceMsg = await simulateRequest('DELETE', '/api/messages/msg-alice-test-1', authBob);
    assert('Bob deleting Alice message returns HTTP 403 FORBIDDEN', bobDeleteAliceMsg.status === 403 && bobDeleteAliceMsg.data?.code === 'FORBIDDEN');

    // Alice lists messages in her conversation
    const aliceListMsgs = await simulateRequest('GET', '/api/messages?conversationId=conv-alice-test-1', authAlice);
    assert('Alice lists messages in her conversation returning HTTP 200', aliceListMsgs.status === 200 && aliceListMsgs.data?.messages?.length >= 1);

    // Alice updates her own message
    const aliceUpdateMsg = await simulateRequest('PATCH', '/api/messages/msg-alice-test-1', authAlice, {
      content: 'Updated note by Alice'
    });
    assert('Alice updates own message returning HTTP 200', aliceUpdateMsg.status === 200 && aliceUpdateMsg.data?.message?.content === 'Updated note by Alice');

    // ---------------------------------------------------------------------------
    // 6. Conversation Deletion with Automatic Message Cleanup (Cascading)
    // ---------------------------------------------------------------------------
    console.log('\n--- [6/8] Conversation Deletion with Cascading Message Cleanup ---');

    // Alice deletes conversation #1 (which contains msg-alice-test-1)
    const deleteConvRes = await simulateRequest('DELETE', '/api/conversations/conv-alice-test-1', authAlice);
    assert('DELETE /api/conversations/:id returns HTTP 200', deleteConvRes.status === 200);
    assert('Reports deleted message count >= 1', deleteConvRes.data?.deletedMessagesCount >= 1);

    // Verify conversation is gone
    const checkConvGone = await simulateRequest('GET', '/api/conversations/conv-alice-test-1', authAlice);
    assert('Deleted conversation returns HTTP 404 NOT_FOUND', checkConvGone.status === 404 && checkConvGone.data?.code === 'NOT_FOUND');

    // Verify message was cascaded and is gone
    const checkMsgGone = await simulateRequest('GET', '/api/messages/msg-alice-test-1', authAlice);
    assert('Associated message was cascaded and returns HTTP 404 NOT_FOUND', checkMsgGone.status === 404 && checkMsgGone.data?.code === 'NOT_FOUND');

    // ---------------------------------------------------------------------------
    // 7. User Settings Isolation & IDOR Prevention
    // ---------------------------------------------------------------------------
    console.log('\n--- [7/8] User Settings Isolation & IDOR Prevention ---');

    // Alice reads settings (defaults if not yet saved)
    const aliceSettingsInit = await simulateRequest('GET', '/api/user-settings/me', authAlice);
    assert('GET /api/user-settings/me returns HTTP 200', aliceSettingsInit.status === 200 && typeof aliceSettingsInit.data?.settings === 'object');

    // Alice updates preferences
    const aliceSettingsUpdate = await simulateRequest('POST', '/api/user-settings/me', authAlice, {
      theme: 'dark',
      responseLength: 'detailed',
      defaultMode: 'coding',
      beginnerFriendly: true
    });
    assert('POST /api/user-settings/me saves settings returning HTTP 200', aliceSettingsUpdate.status === 200);
    assert('Saved settings reflect updated theme', aliceSettingsUpdate.data?.settings?.theme === 'dark');
    assert('Saved settings reflect updated responseLength', aliceSettingsUpdate.data?.settings?.responseLength === 'detailed');

    // Bob reads his own settings: must NOT reflect Alice's settings
    const bobSettings = await simulateRequest('GET', '/api/user-settings/me', authBob);
    assert('Bob settings are isolated and do not match Alice custom settings', bobSettings.status === 200 && bobSettings.data?.settings?.theme !== 'dark');

    // Bob tries to read Alice's settings (IDOR Attack)
    const bobReadAliceSettings = await simulateRequest('GET', '/api/user-settings/user-alice-111', authBob);
    assert('Bob reading Alice settings returns HTTP 403 FORBIDDEN', bobReadAliceSettings.status === 403 && bobReadAliceSettings.data?.code === 'FORBIDDEN');

    // Bob tries to modify Alice's settings (IDOR Attack)
    const bobModifyAliceSettings = await simulateRequest('POST', '/api/user-settings/user-alice-111', authBob, {
      theme: 'light'
    });
    assert('Bob modifying Alice settings returns HTTP 403 FORBIDDEN', bobModifyAliceSettings.status === 403 && bobModifyAliceSettings.data?.code === 'FORBIDDEN');

    // ---------------------------------------------------------------------------
    // 8. Malformed IDs, Payloads & Existing Endpoint Regressions
    // ---------------------------------------------------------------------------
    console.log('\n--- [8/8] Malformed IDs, Payloads & Existing Route Regressions ---');

    // Malformed conversation ID in URL
    const malformedId = await simulateRequest('GET', '/api/conversations/x', authAlice); // Too short
    assert('Malformed conversation ID returns HTTP 400 INVALID_CONVERSATION_ID', malformedId.status === 400 && malformedId.data?.code === 'INVALID_CONVERSATION_ID');

    // Missing conversationId query on /api/messages
    const missingQuery = await simulateRequest('GET', '/api/messages', authAlice);
    assert('Missing conversationId query returns HTTP 400 MISSING_CONVERSATION_ID', missingQuery.status === 400 && missingQuery.data?.code === 'MISSING_CONVERSATION_ID');

    // Missing content on message post
    const missingContent = await simulateRequest('POST', '/api/messages', authAlice, {
      conversationId: 'conv-alice-pin-2'
    });
    assert('Missing message content returns HTTP 400 INVALID_MESSAGE_PAYLOAD', missingContent.status === 400 && missingContent.data?.code === 'INVALID_MESSAGE_PAYLOAD');

    // Core endpoints regression verification
    const health = await simulateRequest('GET', '/api/health');
    assert('GET /api/health returns HTTP 200 ok', health.status === 200 && health.data?.status === 'ok');

    const config = await simulateRequest('GET', '/api/config');
    assert('GET /api/config returns HTTP 200 and specifies Orvix database', config.status === 200 && config.data?.mongodbDatabase === 'Orvix');

    const verify = await simulateRequest('GET', '/api/auth/verify', authAlice);
    assert('GET /api/auth/verify verifies token and returns user context', verify.status === 200 && verify.data?.user?.uid === 'user-alice-111');

    // Non-MongoDB /api/* routes mounted after mongoApiRouter must NOT be intercepted by requireAuth
    const unauthChatValidation = await simulateRequest('POST', '/api/chat', {}, {});
    assert(
      'POST /api/chat without Bearer token reaches chat handler (HTTP 400 validation, not 401 AUTH_TOKEN_MISSING)',
      unauthChatValidation.status === 400 && unauthChatValidation.data?.code !== 'AUTH_TOKEN_MISSING'
    );

    const unauthUploadConfig = await simulateRequest('GET', '/api/upload/config');
    assert(
      'GET /api/upload/config without Bearer token returns HTTP 200 (not intercepted by requireAuth)',
      unauthUploadConfig.status === 200 && unauthUploadConfig.data?.maxFileSizeBytes > 0
    );

    // Clean up test mocks
    resetFirebaseAdminForTesting();
    setMockDatabaseForTesting(null);

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
