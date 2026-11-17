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
  buildValidatedSharedSnapshot,
  createSharedChatSnapshot,
  getSharedSnapshotSession,
  isShareSnapshotExpired,
  loadSharedChatSnapshot,
  resolveShareExpiration,
  revokeSharedChatSnapshot,
  setSharedSnapshotSession,
  clearSharedSnapshotSession,
  ShareChatError,
  validateSharedSnapshotPayload
} from '../src/services/shareChatService.js';
import {
  resetFirebaseAuthForTesting,
  setTestFirebaseProjectId,
  setTestPublicKey
} from '../server/firebaseAuthHelper.ts';
import {
  resetFirestoreForTesting,
  setFirestoreForTesting
} from '../server/uploadQuotaService.ts';
import { resetRateLimitersForTesting } from '../server/rateLimiter.ts';

function buildSignedJwt(claims: Record<string, any>, privateKey: crypto.KeyObject): string {
  const header = Buffer.from(
    JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'opt02-test-kid' })
  ).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = crypto
    .createSign('RSA-SHA256')
    .update(`${header}.${payload}`)
    .sign(privateKey)
    .toString('base64url');
  return `${header}.${payload}.${signature}`;
}

function setupAuthKeys() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const projectId = 'orvix-opt02-test-project';
  setTestFirebaseProjectId(projectId);
  setTestPublicKey('opt02-test-kid', publicKey.export({ type: 'spki', format: 'pem' }).toString());
  const nowSec = Math.floor(Date.now() / 1000);

  const ownerToken = buildSignedJwt(
    {
      sub: 'owner-uid-001',
      user_id: 'owner-uid-001',
      email: 'owner@orvix.test',
      aud: projectId,
      iss: `https://securetoken.google.com/${projectId}`,
      iat: nowSec - 30,
      exp: nowSec + 3600
    },
    privateKey
  );

  const otherUserToken = buildSignedJwt(
    {
      sub: 'attacker-uid-002',
      user_id: 'attacker-uid-002',
      email: 'other@orvix.test',
      aud: projectId,
      iss: `https://securetoken.google.com/${projectId}`,
      iat: nowSec - 30,
      exp: nowSec + 3600
    },
    privateKey
  );

  const anonToken = buildSignedJwt(
    {
      sub: 'anon-uid-999',
      user_id: 'anon-uid-999',
      isAnonymous: true,
      firebase: { sign_in_provider: 'anonymous' },
      aud: projectId,
      iss: `https://securetoken.google.com/${projectId}`,
      iat: nowSec - 30,
      exp: nowSec + 3600
    },
    privateKey
  );

  return { ownerToken, otherUserToken, anonToken };
}

function createFakeShareFirestore() {
  const store = new Map<string, any>();

  const makeRef = (colName: string, docId: string) => {
    const docPath = `${colName}/${docId}`;
    return {
      id: docId,
      path: docPath,
      async get() {
        const existing = store.get(docPath);
        return existing
          ? { exists: true, id: docId, path: docPath, data: () => JSON.parse(JSON.stringify(existing)) }
          : { exists: false, id: docId, path: docPath, data: () => undefined };
      },
      async create(data: any) {
        if (store.has(docPath)) {
          const err: any = new Error(`ALREADY_EXISTS: ${docPath}`);
          err.code = 6;
          throw err;
        }
        store.set(docPath, JSON.parse(JSON.stringify(data)));
        return { writeTime: Date.now() };
      },
      async update(patch: any) {
        const existing = store.get(docPath);
        if (!existing) {
          const err: any = new Error(`NOT_FOUND: ${docPath}`);
          err.code = 5;
          throw err;
        }
        store.set(docPath, JSON.parse(JSON.stringify({ ...existing, ...patch })));
        return { writeTime: Date.now() };
      },
      async set(data: any, opts?: { merge?: boolean }) {
        const existing = store.get(docPath);
        const next = opts?.merge && existing ? { ...existing, ...data } : data;
        store.set(docPath, JSON.parse(JSON.stringify(next)));
        return { writeTime: Date.now() };
      }
    };
  };

  const db = {
    collection(colName: string) {
      return {
        doc(docId: string) {
          return makeRef(colName, docId);
        }
      };
    },
    async runTransaction(fn: (tx: any) => Promise<any>) {
      const tx = {
        async get(ref: any) {
          return await ref.get();
        },
        update(ref: any, patch: any) {
          return ref.update(patch);
        },
        set(ref: any, data: any, opts?: any) {
          return ref.set(data, opts);
        }
      };
      return await fn(tx);
    }
  };

  return { db, store };
}

async function startTestServer() {
  resetRateLimitersForTesting();
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

test('ORVIX-OPT-02 resolveShareExpiration & isShareSnapshotExpired: validates presets, future bounds, and timestamp formats', () => {
  const baseNow = 1_750_000_000_000;

  assert.deepEqual(resolveShareExpiration({ expirationPreset: 'never', nowMs: baseNow }), {
    expiresAtMs: null,
    ttlMs: null,
    preset: 'never'
  });

  const oneHour = resolveShareExpiration({ expirationPreset: '1h', nowMs: baseNow });
  assert.equal(oneHour.expiresAtMs, baseNow + 3_600_000);
  assert.equal(oneHour.preset, '1h');

  const sevenDays = resolveShareExpiration({ expirationPreset: '7d', nowMs: baseNow });
  assert.equal(sevenDays.expiresAtMs, baseNow + 7 * 86_400_000);

  // Reject past, too-short, excessive, and malformed expiration values
  assert.throws(
    () => resolveShareExpiration({ expiresAt: baseNow - 10_000, nowMs: baseNow }),
    (err: unknown) => err instanceof ShareChatError && err.code === 'INVALID_EXPIRATION'
  );
  assert.throws(
    () => resolveShareExpiration({ expiresInSeconds: 10, nowMs: baseNow }),
    (err: unknown) => err instanceof ShareChatError && err.code === 'INVALID_EXPIRATION'
  );
  assert.throws(
    () => resolveShareExpiration({ expiresInSeconds: 400 * 86_400, nowMs: baseNow }),
    (err: unknown) => err instanceof ShareChatError && err.code === 'INVALID_EXPIRATION'
  );
  assert.throws(
    () => resolveShareExpiration({ expirationPreset: 'invalid-preset', nowMs: baseNow }),
    (err: unknown) => err instanceof ShareChatError && err.code === 'INVALID_EXPIRATION'
  );

  // Expiration evaluation handles ms numbers, ISO strings, Firestore-like timestamps, and malformed values (fail closed)
  assert.equal(isShareSnapshotExpired({ expiresAtMs: null }, baseNow), false);
  assert.equal(isShareSnapshotExpired({ expiresAtMs: baseNow + 5000 }, baseNow), false);
  assert.equal(isShareSnapshotExpired({ expiresAtMs: baseNow - 1 }, baseNow), true);
  assert.equal(isShareSnapshotExpired({ expiresAt: { _seconds: Math.floor((baseNow - 2000) / 1000), _nanoseconds: 0 } }, baseNow), true);
  assert.equal(isShareSnapshotExpired({ expiresAt: 'not-a-date' }, baseNow), true);
});

test('ORVIX-OPT-02 server ownership, revocation authorization, active preservation, and 410 blocking', async () => {
  resetFirebaseAuthForTesting();
  resetFirestoreForTesting();
  const keys = setupAuthKeys();
  const fakeFs = createFakeShareFirestore();
  setFirestoreForTesting(fakeFs.db);
  const srv = await startTestServer();

  try {
    const shareId = 'Opt02OwnerShare_12345';
    const resCreate = await fetch(`${srv.baseUrl}/api/share`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${keys.ownerToken}`
      },
      body: JSON.stringify({
        shareId,
        expirationPreset: '24h',
        // Spoofed ownerId in body must be ignored in favor of verified JWT UID
        ownerId: 'spoofed-attacker-uid',
        chat: { id: 'chat-opt02-1', title: 'Owner Revocation Test', mode: 'coding' },
        messages: [
          { id: 'u1', sender: 'user', content: 'Explain binary search', createdAtMs: 1700000001000 },
          { id: 'a1', sender: 'assistant', content: 'Binary search halves the sorted search space.', createdAtMs: 1700000002000 }
        ]
      })
    });

    assert.equal(resCreate.status, 200);
    const createdJson = await resCreate.json() as any;
    assert.equal(createdJson.success, true);
    assert.equal(createdJson.revoked, false);
    assert.equal(typeof createdJson.expiresAtMs, 'number');
    assert.ok(createdJson.expiresAtMs > Date.now() + 23 * 3_600_000);

    // Server stored authoritative ownerId from token, NOT spoofed body
    const storedDoc = fakeFs.store.get(`sharedChats/${shareId}`);
    assert.equal(storedDoc.ownerId, 'owner-uid-001');
    assert.equal(storedDoc.revoked, false);

    // Active share can be retrieved publicly and NEVER leaks ownerId
    const resActiveGet = await fetch(`${srv.baseUrl}/api/share/${shareId}`);
    assert.equal(resActiveGet.status, 200);
    const activeSnapshot = await resActiveGet.json() as any;
    assert.equal(activeSnapshot.title, 'Owner Revocation Test');
    assert.equal(activeSnapshot.messages.length, 2);
    assert.equal('ownerId' in activeSnapshot, false, 'Public snapshot must never leak ownerId');

    // Unauthenticated revocation -> 401
    const resUnauthRevoke = await fetch(`${srv.baseUrl}/api/share/${shareId}`, {
      method: 'DELETE'
    });
    assert.equal(resUnauthRevoke.status, 401);

    // Anonymous revocation -> 401
    const resAnonRevoke = await fetch(`${srv.baseUrl}/api/share/${shareId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${keys.anonToken}` }
    });
    assert.equal(resAnonRevoke.status, 401);

    // Non-owner authenticated revocation -> 403 FORBIDDEN (link remains active!)
    const resOtherRevoke = await fetch(`${srv.baseUrl}/api/share/${shareId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${keys.otherUserToken}` }
    });
    assert.equal(resOtherRevoke.status, 403);
    const otherJson = await resOtherRevoke.json() as any;
    assert.equal(otherJson.code, 'FORBIDDEN');

    const stillActiveGet = await fetch(`${srv.baseUrl}/api/share/${shareId}`);
    assert.equal(stillActiveGet.status, 200, 'Non-owner revoke attempt must leave link active');

    // Owner revocation via DELETE -> 200
    const resOwnerRevoke = await fetch(`${srv.baseUrl}/api/share/${shareId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${keys.ownerToken}` }
    });
    assert.equal(resOwnerRevoke.status, 200);
    const revokeJson = await resOwnerRevoke.json() as any;
    assert.equal(revokeJson.revoked, true);
    assert.equal(revokeJson.shareId, shareId);

    // Retrieving revoked link returns 410 GONE with SHARE_REVOKED and omits messages
    const resAfterRevokeGet = await fetch(`${srv.baseUrl}/api/share/${shareId}`);
    assert.equal(resAfterRevokeGet.status, 410);
    const afterRevokeJson = await resAfterRevokeGet.json() as any;
    assert.equal(afterRevokeJson.code, 'SHARE_REVOKED');
    assert.equal('messages' in afterRevokeJson, false);

    // Client validateSharedSnapshotPayload rejects revoked doc even if delivered directly
    assert.throws(
      () => validateSharedSnapshotPayload(fakeFs.store.get(`sharedChats/${shareId}`), shareId),
      (err: unknown) => err instanceof ShareChatError && err.code === 'SHARE_REVOKED'
    );
  } finally {
    await srv.close();
    resetFirestoreForTesting();
    resetFirebaseAuthForTesting();
  }
});

test('ORVIX-OPT-02 expired share links: reject invalid expiration on create and return 410 SHARE_EXPIRED once expired', async () => {
  resetFirebaseAuthForTesting();
  resetFirestoreForTesting();
  const keys = setupAuthKeys();
  const fakeFs = createFakeShareFirestore();
  setFirestoreForTesting(fakeFs.db);
  const srv = await startTestServer();

  try {
    // Reject invalid past expiration timestamp on creation (HTTP 400)
    const resBadExp = await fetch(`${srv.baseUrl}/api/share`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${keys.ownerToken}`
      },
      body: JSON.stringify({
        shareId: 'Opt02BadExpShare_1234',
        expiresAt: Date.now() - 60_000,
        chat: { id: 'chat-bad-exp', title: 'Invalid Exp', mode: 'general' },
        messages: [{ id: 'm1', sender: 'user', content: 'Hello', createdAtMs: 1700000001000 }]
      })
    });
    assert.equal(resBadExp.status, 400);
    const badExpJson = await resBadExp.json() as any;
    assert.equal(badExpJson.code, 'INVALID_EXPIRATION');

    // Create valid link with 120s expiration
    const shareId = 'Opt02ExpShare_1234567';
    const resCreate = await fetch(`${srv.baseUrl}/api/share`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${keys.ownerToken}`
      },
      body: JSON.stringify({
        shareId,
        expiresInSeconds: 120,
        chat: { id: 'chat-exp-1', title: 'Expiring Chat', mode: 'learning' },
        messages: [
          { id: 'm1', sender: 'user', content: 'What is entropy?', createdAtMs: 1700000001000 }
        ]
      })
    });
    assert.equal(resCreate.status, 200);

    // Active before expiration
    const resActive = await fetch(`${srv.baseUrl}/api/share/${shareId}`);
    assert.equal(resActive.status, 200);

    // Simulate time passing past expiration
    const stored = fakeFs.store.get(`sharedChats/${shareId}`);
    stored.expiresAtMs = Date.now() - 5000;
    stored.expiresAt = { _seconds: Math.floor((Date.now() - 5000) / 1000), _nanoseconds: 0 };
    fakeFs.store.set(`sharedChats/${shareId}`, stored);

    const resExpired = await fetch(`${srv.baseUrl}/api/share/${shareId}`);
    assert.equal(resExpired.status, 410);
    const expiredJson = await resExpired.json() as any;
    assert.equal(expiredJson.code, 'SHARE_EXPIRED');
    assert.equal('messages' in expiredJson, false);
  } finally {
    await srv.close();
    resetFirestoreForTesting();
    resetFirebaseAuthForTesting();
  }
});

test('ORVIX-OPT-02 client helpers: revokeSharedChatSnapshot, loadSharedChatSnapshot permission-denied diagnosis, and sessionStorage expiration clearing', async () => {
  // Mock sessionStorage in Node
  const memStorage = new Map<string, string>();
  const mockSessionStorage = {
    getItem: (k: string) => memStorage.get(k) ?? null,
    setItem: (k: string, v: string) => { memStorage.set(k, String(v)); },
    removeItem: (k: string) => { memStorage.delete(k); }
  };
  (globalThis as any).sessionStorage = mockSessionStorage;

  const shareId = 'Opt02ClientCache_1234';
  try {
    // Cache an entry that expires in the past -> getSharedSnapshotSession evicts and returns null
    setSharedSnapshotSession(shareId, {
      id: shareId,
      title: 'Expired Cached Chat',
      mode: 'general',
      expiresAtMs: Date.now() - 1000,
      revoked: false,
      messageCount: 1,
      messages: [{ id: 'm1', sender: 'user', content: 'Hi', createdAtMs: 1700000001000 }]
    });
    assert.equal(getSharedSnapshotSession(shareId), null);
    assert.equal(memStorage.has(`orvix_shared_snapshot_${shareId}`), false);

    // Valid buildValidatedSharedSnapshot preserves active future expiry and strips nothing public
    const { documentData } = buildValidatedSharedSnapshot({
      shareId,
      chat: { id: 'c1', title: 'Active Cache', mode: 'general' },
      messages: [{ id: 'm1', sender: 'user', content: 'Hi', createdAtMs: 1700000001000 }],
      expirationPreset: '1h'
    });
    const validated = validateSharedSnapshotPayload(documentData, shareId) as Record<string, any>;
    assert.equal(validated.revoked, false);
    assert.ok(typeof validated.expiresAtMs === 'number' && validated.expiresAtMs > Date.now());

    // Client createSharedChatSnapshot forwards expirationPreset and revokeSharedChatSnapshot sends DELETE
    const mockFetch = async (url: string, init?: RequestInit) => {
      if (url === '/api/share' && init?.method === 'POST') {
        const parsed = JSON.parse(String(init.body || '{}'));
        assert.equal(parsed.expirationPreset, '7d');
        return new Response(
          JSON.stringify({
            success: true,
            shareId: parsed.shareId,
            expiresAtMs: Date.now() + 7 * 86_400_000,
            revoked: false
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url === `/api/share/${shareId}` && init?.method === 'DELETE') {
        return new Response(
          JSON.stringify({ success: true, shareId, revoked: true, revokedAtMs: Date.now() }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url === `/api/share/${shareId}` && init?.method === 'GET') {
        return new Response(
          JSON.stringify({ code: 'SHARE_REVOKED', error: 'Revoked by owner.' }),
          { status: 410, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response('{}', { status: 404 });
    };

    const created = await createSharedChatSnapshot(
      { id: 'c-opt02', title: 'Client Exp Share', mode: 'general' },
      [{ id: 'm1', sender: 'user', content: 'Hello', createdAtMs: 1700000001000 }],
      {
        user: { uid: 'u1', isAnonymous: false, getIdToken: async () => 'tok' },
        fetchImpl: mockFetch,
        expirationPreset: '7d'
      }
    );
    assert.ok(created.expiresAtMs && created.expiresAtMs > Date.now() + 6 * 86_400_000);

    // Revoke clears session cache
    setSharedSnapshotSession(shareId, validated);
    const revokedRes = await revokeSharedChatSnapshot(shareId, {
      user: { uid: 'u1', isAnonymous: false, getIdToken: async () => 'tok' },
      fetchImpl: mockFetch
    });
    assert.equal(revokedRes.revoked, true);
    assert.equal(getSharedSnapshotSession(shareId), null);

    // loadSharedChatSnapshot surfaces SHARE_REVOKED when Firestore throws permission-denied and API reports 410
    await assert.rejects(
      () =>
        loadSharedChatSnapshot(shareId, {
          forceNetwork: true,
          firestoreDb: {},
          docImpl: () => ({ id: shareId }),
          getDocImpl: async () => {
            const err: any = new Error('Missing or insufficient permissions');
            err.code = 'permission-denied';
            throw err;
          },
          fetchImpl: mockFetch
        }),
      (err: unknown) => err instanceof ShareChatError && err.code === 'SHARE_REVOKED'
    );
  } finally {
    clearSharedSnapshotSession(shareId);
    delete (globalThis as any).sessionStorage;
  }
});

test('ORVIX-OPT-02 firestore.rules enforces revocation and timestamp expiration for sharedChats/{shareId}', () => {
  const rulesText = fs.readFileSync(path.join(process.cwd(), 'firestore.rules'), 'utf8');
  assert.match(rulesText, /match \/sharedChats\/\{shareId\}/);
  assert.match(rulesText, /function isActiveSharedChat\(data\)/);
  assert.match(rulesText, /data\.revoked != true/);
  assert.match(rulesText, /request\.time < data\.expiresAt/);
  assert.match(rulesText, /allow get:\s*if isActiveSharedChat\(resource\.data\)/);
  assert.match(rulesText, /allow list:\s*if false/);
  assert.match(rulesText, /allow create, update, delete:\s*if false/);
});
