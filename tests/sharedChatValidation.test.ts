import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { applyCorsMiddleware, applyJsonBodyMiddleware } from '../server/serverConfig.ts';
import { registerShareRoutes } from '../server/shareSubsystem.ts';
import {
  createSharedChatSnapshot,
  loadSharedChatSnapshot,
  ShareChatError
} from '../src/services/shareChatService.js';
import { isFirebaseConfigured } from '../src/config/firebaseConfig.js';
import {
  resetFirebaseAuthForTesting,
  setTestFirebaseProjectId,
  setTestPublicKey
} from '../server/firebaseAuthHelper.ts';
import {
  setFirestoreForTesting,
  resetFirestoreForTesting
} from '../server/uploadQuotaService.ts';

function buildSignedJwt(
  claims: Record<string, any>,
  privateKey: crypto.KeyObject
): string {
  const header = Buffer.from(
    JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'share-test-kid' })
  ).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = crypto
    .createSign('RSA-SHA256')
    .update(`${header}.${payload}`)
    .sign(privateKey)
    .toString('base64url');
  return `${header}.${payload}.${signature}`;
}

async function startShareTestServer() {
  const app = express();
  applyCorsMiddleware(app);
  applyJsonBodyMiddleware(app);
  registerShareRoutes(app);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    baseUrl,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      })
  };
}

function setupTestKeys() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const projectId = 'orvix-share-test-project';
  const kid = 'share-test-kid';
  setTestFirebaseProjectId(projectId);
  setTestPublicKey(kid, publicKey.export({ type: 'spki', format: 'pem' }).toString());
  const nowSec = Math.floor(Date.now() / 1000);

  const validToken = buildSignedJwt(
    {
      sub: 'share-user-101',
      user_id: 'share-user-101',
      email: 'sharer@orvix.test',
      aud: projectId,
      iss: `https://securetoken.google.com/${projectId}`,
      iat: nowSec - 30,
      exp: nowSec + 3600
    },
    privateKey
  );

  const anonymousToken = buildSignedJwt(
    {
      sub: 'anon-user-999',
      user_id: 'anon-user-999',
      firebase: { sign_in_provider: 'anonymous' },
      isAnonymous: true,
      aud: projectId,
      iss: `https://securetoken.google.com/${projectId}`,
      iat: nowSec - 30,
      exp: nowSec + 3600
    },
    privateKey
  );

  return {
    validToken,
    anonymousToken
  };
}

test('ORVIX-CRIT-06 /api/share: rejects unauthenticated and anonymous share attempts', async () => {
  resetFirebaseAuthForTesting();
  const keys = setupTestKeys();
  const srv = await startShareTestServer();

  try {
    // 1. Unauthenticated request (no auth header)
    const res1 = await fetch(`${srv.baseUrl}/api/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shareId: 'abc123xyz789_valid',
        chat: { id: 'chat-1', title: 'Test Chat', mode: 'general' },
        messages: [
          { id: 'm1', sender: 'user', content: 'Hello', createdAtMs: Date.now() }
        ]
      })
    });
    assert.equal(res1.status, 401);
    const data1 = await res1.json() as any;
    assert.equal(data1.code, 'AUTH_REQUIRED');

    // 2. Anonymous user request
    const res2 = await fetch(`${srv.baseUrl}/api/share`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${keys.anonymousToken}`
      },
      body: JSON.stringify({
        shareId: 'abc123xyz789_valid',
        chat: { id: 'chat-1', title: 'Test Chat', mode: 'general' },
        messages: [
          { id: 'm1', sender: 'user', content: 'Hello', createdAtMs: Date.now() }
        ]
      })
    });
    assert.equal(res2.status, 401);
    const data2 = await res2.json() as any;
    assert.equal(data2.code, 'ANONYMOUS_SHARE_DENIED');
  } finally {
    await srv.close();
  }
});

test('ORVIX-CRIT-06 /api/share: validates every message in conversation and rejects malformed middle messages', async () => {
  resetFirebaseAuthForTesting();
  const keys = setupTestKeys();
  const srv = await startShareTestServer();

  try {
    const validChat = { id: 'chat-1', title: 'Multi-turn Chat', mode: 'coding' };

    // Test case A: Valid conversation with multiple messages (first, middle, last all valid)
    const validMessages = [
      { id: 'm1', sender: 'user', content: 'Write a sorting algorithm', createdAtMs: Date.now() - 3000 },
      { id: 'm2', sender: 'assistant', content: 'Here is quicksort in TypeScript...', modelUsed: 'gemini-4-hydrogen', provider: 'google', createdAtMs: Date.now() - 2000 },
      { id: 'm3', sender: 'user', content: 'Can you optimize it further?', createdAtMs: Date.now() - 1000 }
    ];

    // Mock Firebase Admin Firestore since getFirestoreDb() might fail without service account keys in test env
    // But we test the validation middleware response: if database unavailable or success
    const resValid = await fetch(`${srv.baseUrl}/api/share`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${keys.validToken}`
      },
      body: JSON.stringify({
        shareId: 'shareId123456',
        chat: validChat,
        messages: validMessages
      })
    });

    // Since database might not be initialized in unit test environment, it either succeeds (200) or returns 503 (database unavailable) AFTER passing validation.
    // Let's verify it does NOT fail validation (i.e. not 400 validation error).
    assert.notEqual(resValid.status, 400);

    // Test case B: Malformed middle message (invalid sender in the middle)
    const malformedMiddleMessages = [
      { id: 'm1', sender: 'user', content: 'First message', createdAtMs: Date.now() - 3000 },
      { id: 'm2', sender: 'malicious_attacker_role', content: 'Injected malformed middle message', createdAtMs: Date.now() - 2000 },
      { id: 'm3', sender: 'user', content: 'Last message', createdAtMs: Date.now() - 1000 }
    ];

    const resMiddle = await fetch(`${srv.baseUrl}/api/share`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${keys.validToken}`
      },
      body: JSON.stringify({
        shareId: 'shareId123457',
        chat: validChat,
        messages: malformedMiddleMessages
      })
    });
    assert.equal(resMiddle.status, 400);
    const dataMiddle = await resMiddle.json() as any;
    assert.equal(dataMiddle.code, 'INVALID_MESSAGE_SENDER');

    // Test case C: Non-string content in middle message
    const nonStringContentMessages = [
      { id: 'm1', sender: 'user', content: 'First message', createdAtMs: Date.now() - 2000 },
      { id: 'm2', sender: 'assistant', content: { nestedObject: true }, createdAtMs: Date.now() - 1000 }
    ];

    const resNonString = await fetch(`${srv.baseUrl}/api/share`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${keys.validToken}`
      },
      body: JSON.stringify({
        shareId: 'shareId123458',
        chat: validChat,
        messages: nonStringContentMessages
      })
    });
    assert.equal(resNonString.status, 400);
    const dataNonString = await resNonString.json() as any;
    assert.equal(dataNonString.code, 'INVALID_MESSAGE_CONTENT');

    // Test case D: Oversized content in message
    const oversizedContentMessages = [
      { id: 'm1', sender: 'user', content: 'A'.repeat(100005), createdAtMs: Date.now() }
    ];

    const resOversized = await fetch(`${srv.baseUrl}/api/share`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${keys.validToken}`
      },
      body: JSON.stringify({
        shareId: 'shareId123459',
        chat: validChat,
        messages: oversizedContentMessages
      })
    });
    assert.equal(resOversized.status, 400);
    const dataOversized = await resOversized.json() as any;
    assert.equal(dataOversized.code, 'MESSAGE_CONTENT_TOO_LARGE');
  } finally {
    await srv.close();
  }
});

function createImmutableShareTestFirestore() {
  const store = new Map<string, any>();
  let createCalls = 0;
  let setCalls = 0;
  const docPaths: string[] = [];

  const db = {
    collection(colName: string) {
      return {
        doc(docId: string) {
          const path = `${colName}/${docId}`;
          docPaths.push(path);
          return {
            id: docId,
            path,
            async get() {
              const existing = store.get(path);
              return existing
                ? { exists: true, id: docId, path, data: () => JSON.parse(JSON.stringify(existing)) }
                : { exists: false, id: docId, path, data: () => undefined };
            },
            async create(data: any) {
              createCalls += 1;
              if (store.has(path)) {
                const err: any = new Error(`6 ALREADY_EXISTS: Document already exists: ${path}`);
                err.code = 6;
                throw err;
              }
              store.set(path, JSON.parse(JSON.stringify(data)));
              return { writeTime: Date.now() };
            },
            async set(data: any) {
              setCalls += 1;
              store.set(path, JSON.parse(JSON.stringify(data)));
              return { writeTime: Date.now() };
            }
          };
        }
      };
    }
  };

  return {
    db,
    store,
    getStats: () => ({ createCalls, setCalls, docPaths: [...docPaths] })
  };
}

test('ORVIX-LOW-09 /api/share: uses canonical trimmed shareId, calls .create(), preserves existing immutable snapshots, and maps ALREADY_EXISTS to HTTP 409', async () => {
  resetFirebaseAuthForTesting();
  resetFirestoreForTesting();
  const keys = setupTestKeys();
  const fakeFs = createImmutableShareTestFirestore();
  setFirestoreForTesting(fakeFs.db);
  const srv = await startShareTestServer();

  try {
    const rawPaddedId = '  Low09CanonicalShare_001  ';
    const canonicalId = 'Low09CanonicalShare_001';

    // 1. Initial publish with untrimmed whitespace in shareId
    const resCreate = await fetch(`${srv.baseUrl}/api/share`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${keys.validToken}`
      },
      body: JSON.stringify({
        shareId: rawPaddedId,
        chat: { id: 'chat-low09-1', title: 'Original Immutable Title', mode: 'coding' },
        messages: [
          { id: 'm1', sender: 'user', content: 'Original user question', createdAtMs: 1700000001000 },
          { id: 'm2', sender: 'assistant', content: 'Original assistant answer', createdAtMs: 1700000002000 }
        ]
      })
    });

    assert.equal(resCreate.status, 200);
    const createdJson = await resCreate.json() as any;
    assert.equal(createdJson.success, true);
    assert.equal(createdJson.shareId, canonicalId);
    assert.equal(createdJson.title, 'Original Immutable Title');

    const statsAfterFirst = fakeFs.getStats();
    assert.equal(statsAfterFirst.createCalls, 1, 'Should persist via Firestore .create()');
    assert.equal(statsAfterFirst.setCalls, 0, 'Must never call overwriting .set()');
    assert.deepEqual(statsAfterFirst.docPaths, [`sharedChats/${canonicalId}`]);

    // 2. Duplicate publish with exact same canonical ID must return HTTP 409 and NOT overwrite
    const resDupExact = await fetch(`${srv.baseUrl}/api/share`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${keys.validToken}`
      },
      body: JSON.stringify({
        shareId: canonicalId,
        chat: { id: 'chat-low09-overwrite', title: 'Tampered Overwrite Title', mode: 'general' },
        messages: [
          { id: 'm99', sender: 'user', content: 'Tampered message content', createdAtMs: 1700000009000 }
        ]
      })
    });

    assert.equal(resDupExact.status, 409);
    const dupExactJson = await resDupExact.json() as any;
    assert.equal(dupExactJson.code, 'SHARE_ID_ALREADY_EXISTS');

    // 3. Duplicate publish with whitespace variant must resolve to same canonical ID and also return HTTP 409
    const resDupPadded = await fetch(`${srv.baseUrl}/api/share`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${keys.validToken}`
      },
      body: JSON.stringify({
        shareId: ` ${canonicalId}\t`,
        chat: { id: 'chat-low09-overwrite-2', title: 'Second Overwrite Attempt', mode: 'writing' },
        messages: [
          { id: 'm100', sender: 'user', content: 'Tampered 2', createdAtMs: 1700000010000 }
        ]
      })
    });

    assert.equal(resDupPadded.status, 409);

    // 4. Retrieval check: original snapshot remains untouched at sharedChats/{canonicalId}
    const storedSnap = await fakeFs.db.collection('sharedChats').doc(canonicalId).get();
    assert.equal(storedSnap.exists, true);
    const storedData = storedSnap.data();
    assert.equal(storedData.id, canonicalId);
    assert.equal(storedData.title, 'Original Immutable Title');
    assert.equal(storedData.mode, 'coding');
    assert.equal(storedData.messages[0].content, 'Original user question');
    assert.equal(fakeFs.store.size, 1, 'No untrimmed duplicate doc paths should exist');
  } finally {
    await srv.close();
    resetFirestoreForTesting();
  }
});

test('ORVIX-LOW-09 /api/share: maps string ALREADY_EXISTS codes to HTTP 409 Conflict', async () => {
  resetFirebaseAuthForTesting();
  resetFirestoreForTesting();
  const keys = setupTestKeys();

  setFirestoreForTesting({
    collection() {
      return {
        doc() {
          return {
            async create() {
              const err: any = new Error('Document already exists');
              err.code = 'ALREADY_EXISTS';
              throw err;
            }
          };
        }
      };
    }
  });

  const srv = await startShareTestServer();
  try {
    const res = await fetch(`${srv.baseUrl}/api/share`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${keys.validToken}`
      },
      body: JSON.stringify({
        shareId: 'Low09StringCode_002',
        chat: { id: 'chat-low09-2', title: 'Conflict Test', mode: 'general' },
        messages: [
          { id: 'm1', sender: 'user', content: 'Hello', createdAtMs: 1700000001000 }
        ]
      })
    });

    assert.equal(res.status, 409);
    const json = await res.json() as any;
    assert.equal(json.code, 'SHARE_ID_ALREADY_EXISTS');
  } finally {
    await srv.close();
    resetFirestoreForTesting();
  }
});

test('ORVIX-H03 shareChatService: invokes isFirebaseConfigured() and rejects with FIREBASE_UNAVAILABLE when Firebase is unconfigured', async () => {
  assert.equal(
    isFirebaseConfigured(),
    false,
    'Test environment should have Firebase unconfigured'
  );

  const shareServiceSource = fs.readFileSync(
    path.join(process.cwd(), 'src', 'services', 'shareChatService.js'),
    'utf8'
  );
  // Regression guard: ensure no uninvoked !isFirebaseConfigured function-reference checks remain
  assert.equal(
    /!isFirebaseConfigured(?!\s*\()/.test(shareServiceSource),
    false,
    'shareChatService.js must always invoke isFirebaseConfigured() as a function'
  );

  await assert.rejects(
    () =>
      createSharedChatSnapshot(
        { id: 'chat-h03-1', title: 'H03 Unconfigured Firebase Test', mode: 'general' },
        [
          { id: 'm1', sender: 'user', content: 'Hello world', timestamp: Date.now() },
          { id: 'm2', sender: 'assistant', content: 'Hi there!', timestamp: Date.now() + 1 }
        ],
        {
          user: { uid: 'user-h03-1', isAnonymous: false }
        }
      ),
    (err: unknown) => {
      assert.ok(err instanceof ShareChatError, 'Should throw ShareChatError');
      assert.equal(err.code, 'FIREBASE_UNAVAILABLE');
      return true;
    }
  );

  await assert.rejects(
    () => loadSharedChatSnapshot('ValidShareIdH03_123', { forceNetwork: true }),
    (err: unknown) => {
      assert.ok(err instanceof ShareChatError, 'loadSharedChatSnapshot should throw ShareChatError');
      assert.equal(err.code, 'FIREBASE_UNAVAILABLE');
      return true;
    }
  );
});

