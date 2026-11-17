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
import {
  getRateLimitPolicyConfig,
  resetRateLimitersForTesting
} from '../server/rateLimiter.ts';
import {
  InMemoryRedisMock,
  resetRedisClientForTesting,
  setRedisClientForTesting
} from '../server/redisClient.ts';

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

async function startShareTestServer(resetLimiter = true) {
  if (resetLimiter) {
    resetRateLimitersForTesting();
  }
  const app = express();
  applyCorsMiddleware(app);
  applyJsonBodyMiddleware(app);
  registerShareRoutes(app);
  // Read-only route to verify share creation rate limiter never affects GET access
  app.get('/share/:shareId', (req, res) => {
    res.status(200).json({ ok: true, shareId: req.params.shareId });
  });

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

  const secondUserToken = buildSignedJwt(
    {
      sub: 'share-user-202',
      user_id: 'share-user-202',
      email: 'sharer2@orvix.test',
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
    secondUserToken,
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

test('ORVIX-HIGH-02 /api/share & /share: enforces 10 req/min rate limit before Firestore writes, isolates users, and protects unauthenticated requests by IP', async () => {
  resetFirebaseAuthForTesting();
  resetFirestoreForTesting();
  resetRateLimitersForTesting();
  await resetRedisClientForTesting();

  const policyCfg = getRateLimitPolicyConfig('share');
  assert.equal(policyCfg.policy, 'share');
  assert.equal(policyCfg.max, 10);
  assert.equal(policyCfg.windowMs, 60_000);

  const keys = setupTestKeys();
  const fakeFs = createImmutableShareTestFirestore();
  setFirestoreForTesting(fakeFs.db);
  const srv = await startShareTestServer();

  try {
    // 1. Authenticated User 1 sends 10 requests across both /api/share and /share -> all 10 succeed (200 OK)
    for (let i = 1; i <= 10; i++) {
      const endpoint = i % 2 === 1 ? '/api/share' : '/share';
      const res = await fetch(`${srv.baseUrl}${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${keys.validToken}`
        },
        body: JSON.stringify({
          shareId: `High02User1Share_${String(i).padStart(3, '0')}`,
          chat: { id: `chat-u1-${i}`, title: `User 1 Share ${i}`, mode: 'general' },
          messages: [
            { id: 'm1', sender: 'user', content: `Prompt ${i}`, createdAtMs: 1700000000000 + i }
          ]
        })
      });
      assert.equal(res.status, 200, `Request ${i} on ${endpoint} should succeed`);
      assert.equal(res.headers.get('ratelimit-limit'), '10');
      assert.equal(res.headers.get('x-ratelimit-limit'), '10');
      assert.equal(res.headers.get('x-ratelimit-remaining'), String(10 - i));
    }

    assert.equal(fakeFs.getStats().createCalls, 10, 'Exactly 10 Firestore writes should have occurred');

    // 2. 11th request from Authenticated User 1 on /api/share and 12th on /share -> rejected with HTTP 429 BEFORE Firestore write
    for (const blockedRoute of ['/api/share', '/share']) {
      const resBlocked = await fetch(`${srv.baseUrl}${blockedRoute}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${keys.validToken}`
        },
        body: JSON.stringify({
          shareId: 'High02User1Share_Blocked_011',
          chat: { id: 'chat-u1-11', title: 'Should Be Rate Limited', mode: 'general' },
          messages: [
            { id: 'm1', sender: 'user', content: 'Blocked prompt', createdAtMs: 1700000099000 }
          ]
        })
      });
      assert.equal(resBlocked.status, 429, `Over-limit request on ${blockedRoute} must return HTTP 429`);
      assert.ok(Number(resBlocked.headers.get('retry-after')) >= 1);
      const errBody = (await resBlocked.json()) as any;
      assert.equal(errBody.code, 'RATE_LIMIT_EXCEEDED');
      assert.equal(errBody.status, 'RESOURCE_EXHAUSTED');
      assert.equal(errBody.policy, 'share');
      assert.equal(errBody.limit, 10);
      assert.equal(errBody.remaining, 0);
    }

    // Firestore write count MUST remain 10 (rate limiter blocked before Firestore!)
    assert.equal(
      fakeFs.getStats().createCalls,
      10,
      'Rate-limited share requests must never execute Firestore writes'
    );

    // 3. Separate Authenticated User 2 has an isolated rate-limit bucket and succeeds (200 OK)
    const resUser2 = await fetch(`${srv.baseUrl}/api/share`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${keys.secondUserToken}`
      },
      body: JSON.stringify({
        shareId: 'High02User2Share_001',
        chat: { id: 'chat-u2-1', title: 'User 2 Independent Share', mode: 'coding' },
        messages: [
          { id: 'm1', sender: 'user', content: 'User 2 message', createdAtMs: 1700000100000 }
        ]
      })
    });
    assert.equal(resUser2.status, 200);
    assert.equal(resUser2.headers.get('x-ratelimit-remaining'), '9');
    assert.equal(fakeFs.getStats().createCalls, 11);

    // 4. Read-only GET access to shared conversations is NOT rate limited by share creation exhaustion
    const resReadOnly = await fetch(`${srv.baseUrl}/share/High02User1Share_001`);
    assert.equal(resReadOnly.status, 200);

    // 5. Unauthenticated IP-based protection across both /api/share and /share
    resetRateLimitersForTesting();
    for (let i = 1; i <= 10; i++) {
      const endpoint = i <= 5 ? '/api/share' : '/share';
      const resUnauth = await fetch(`${srv.baseUrl}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shareId: `High02Unauth_${String(i).padStart(3, '0')}`,
          chat: { id: 'chat-unauth', title: 'Unauth', mode: 'general' },
          messages: [{ id: 'm1', sender: 'user', content: 'Hi', createdAtMs: 1700000200000 }]
        })
      });
      // Below the 10 req/min IP limit, unauthenticated requests pass the rate limiter and hit the 401 auth guard
      assert.equal(resUnauth.status, 401);
      assert.equal(resUnauth.headers.get('x-ratelimit-remaining'), String(10 - i));
    }

    // 11th unauthenticated request from the same IP is blocked with HTTP 429
    const resUnauth11 = await fetch(`${srv.baseUrl}/api/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shareId: 'High02Unauth_011',
        chat: { id: 'chat-unauth', title: 'Unauth 11', mode: 'general' },
        messages: [{ id: 'm1', sender: 'user', content: 'Hi', createdAtMs: 1700000200011 }]
      })
    });
    assert.equal(resUnauth11.status, 429);
    const unauth11Json = (await resUnauth11.json()) as any;
    assert.equal(unauth11Json.code, 'RATE_LIMIT_EXCEEDED');
    assert.equal(unauth11Json.policy, 'share');
  } finally {
    await srv.close();
    resetFirestoreForTesting();
    resetRateLimitersForTesting();
  }
});

test('ORVIX-HIGH-02 distributed Redis share rate limiting across multiple instances', async () => {
  resetFirebaseAuthForTesting();
  resetFirestoreForTesting();
  resetRateLimitersForTesting();
  await resetRedisClientForTesting();

  const keys = setupTestKeys();
  const fakeFs = createImmutableShareTestFirestore();
  setFirestoreForTesting(fakeFs.db);

  const mockRedis = new InMemoryRedisMock();
  await mockRedis.connect();
  setRedisClientForTesting(mockRedis);

  const srvA = await startShareTestServer(false);
  const srvB = await startShareTestServer(false);

  try {
    // Send 5 requests to Instance A (/api/share) and 5 requests to Instance B (/share) -> shared Redis counter reaches 10
    for (let i = 1; i <= 10; i++) {
      const targetBase = i <= 5 ? srvA.baseUrl : srvB.baseUrl;
      const endpoint = i <= 5 ? '/api/share' : '/share';
      const res = await fetch(`${targetBase}${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${keys.validToken}`
        },
        body: JSON.stringify({
          shareId: `High02RedisShare_${String(i).padStart(3, '0')}`,
          chat: { id: `chat-r-${i}`, title: `Redis Share ${i}`, mode: 'general' },
          messages: [{ id: 'm1', sender: 'user', content: `Hello ${i}`, createdAtMs: 1700000300000 + i }]
        })
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('x-ratelimit-remaining'), String(10 - i));
    }

    // 11th request hitting Instance B is rejected with 429 via shared Redis state
    const res11 = await fetch(`${srvB.baseUrl}/api/share`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${keys.validToken}`
      },
      body: JSON.stringify({
        shareId: 'High02RedisShare_011',
        chat: { id: 'chat-r-11', title: 'Redis Share 11', mode: 'general' },
        messages: [{ id: 'm1', sender: 'user', content: 'Hello 11', createdAtMs: 1700000300011 }]
      })
    });
    assert.equal(res11.status, 429);
    const body11 = (await res11.json()) as any;
    assert.equal(body11.code, 'RATE_LIMIT_EXCEEDED');
    assert.equal(body11.policy, 'share');
    assert.equal(fakeFs.getStats().createCalls, 10);
  } finally {
    await srvA.close();
    await srvB.close();
    mockRedis.clearAllForTesting();
    await resetRedisClientForTesting();
    resetFirestoreForTesting();
    resetRateLimitersForTesting();
  }
});

