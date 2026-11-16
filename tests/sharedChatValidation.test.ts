import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { applyCorsMiddleware, applyJsonBodyMiddleware } from '../server/serverConfig.ts';
import { registerShareRoutes } from '../server/shareSubsystem.ts';
import {
  resetFirebaseAuthForTesting,
  setTestFirebaseProjectId,
  setTestPublicKey
} from '../server/firebaseAuthHelper.ts';

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
