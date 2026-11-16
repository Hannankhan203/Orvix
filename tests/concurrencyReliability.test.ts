import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import http from 'node:http';
import { WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';

import {
  setupVoiceWebSocketServer,
  getVoiceIpConnectionCount,
  resetVoiceWebSocketStateForTesting,
  getActiveVoiceSessions
} from '../server/voiceWebSocketSubsystem.ts';

import {
  reserveUploadSlot,
  resetQuotaForTesting,
  getFirestoreDb
} from '../server/uploadQuotaService.ts';

import {
  createDurableUploadTicket,
  claimDirectUploadTicketForCompletion,
  cancelDurableUploadTicket,
  resetDirectUploadTicketsForTesting
} from '../server/directUploadTicketService.ts';

import { registerUploadRoutes } from '../server/uploadSubsystem.ts';
import {
  resetFirebaseAuthForTesting,
  setTestFirebaseProjectId,
  setTestPublicKey
} from '../server/firebaseAuthHelper.ts';
import { resetRedisClientForTesting } from '../server/redisClient.ts';

function createSignedTestJwt(uid: string, projectId: string, privateKey: crypto.KeyObject, kid: string): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      sub: uid,
      user_id: uid,
      aud: projectId,
      iss: `https://securetoken.google.com/${projectId}`,
      iat: nowSec - 10,
      exp: nowSec + 3600
    })
  ).toString('base64url');
  const signature = crypto
    .createSign('RSA-SHA256')
    .update(`${header}.${payload}`)
    .sign(privateKey)
    .toString('base64url');
  return `${header}.${payload}.${signature}`;
}

async function startTestHttpServer(app: express.Express): Promise<{
  server: http.Server;
  baseUrl: string;
  wsUrl: string;
  close: () => Promise<void>;
}> {
  const server = http.createServer(app);
  setupVoiceWebSocketServer(server);
  registerUploadRoutes(app);

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  const wsUrl = `ws://127.0.0.1:${addr.port}/api/voice-stream`;
  return {
    server,
    baseUrl,
    wsUrl,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      })
  };
}

test('Voice WebSocket subsystem: enforces max connections per IP and cleans up slots on rejection', async () => {
  const prevTrustProxy = process.env.TRUST_PROXY;
  process.env.TRUST_PROXY = 'false';

  resetVoiceWebSocketStateForTesting();
  resetFirebaseAuthForTesting();

  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'ws-concurrency-kid';
  const projectId = 'orvix-ws-test-project';
  setTestFirebaseProjectId(projectId);
  setTestPublicKey(kid, publicKey.export({ type: 'spki', format: 'pem' }).toString());
  const validToken = createSignedTestJwt('ws-concurrency-user-1', projectId, privateKey, kid);

  const app = express();
  const srv = await startTestHttpServer(app);

  try {
    const realPeerIp = '127.0.0.1';
    const spoofedIp = '198.51.100.123';
    const connectWs = (forwardedFor = spoofedIp) =>
      new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(`${srv.wsUrl}?token=${encodeURIComponent(validToken)}`, {
          headers: { 'x-forwarded-for': forwardedFor }
        });
        ws.on('open', () => resolve(ws));
        ws.on('error', (err) => reject(err));
      });

    // Connect 10 sockets concurrently (max allowed per IP)
    const sockets: WebSocket[] = [];
    for (let i = 0; i < 10; i++) {
      const ws = await connectWs(`198.51.100.${10 + i}`);
      sockets.push(ws);
    }

    assert.equal(getVoiceIpConnectionCount(realPeerIp), 10);
    assert.equal(getVoiceIpConnectionCount(spoofedIp), 0);
    assert.equal(getActiveVoiceSessions().length, 10);

    // 11th connection attempt with a freshly rotated X-Forwarded-For header must STILL be rejected with 429
    await assert.rejects(
      async () => {
        await connectWs('203.0.113.250');
      },
      /Unexpected server response: 429/
    );

    // Close 2 sockets and verify connection count drops to 8
    sockets[0].close();
    sockets[1].close();
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(getVoiceIpConnectionCount(realPeerIp), 8);

    // Clean up remaining sockets
    for (const ws of sockets.slice(2)) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    }
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(getVoiceIpConnectionCount(realPeerIp), 0);
  } finally {
    if (prevTrustProxy === undefined) {
      delete process.env.TRUST_PROXY;
    } else {
      process.env.TRUST_PROXY = prevTrustProxy;
    }
    resetVoiceWebSocketStateForTesting();
    resetFirebaseAuthForTesting();
    await resetRedisClientForTesting();
    await srv.close();
  }
});

test('Upload quota concurrency: concurrent reserveUploadSlot bursts respect daily limit without retries failure', async () => {
  await resetQuotaForTesting();
  const userId = 'user-concurrency-test-1';
  const identity = { type: 'auth' as const, id: userId, key: `auth_${userId}` };

  const promises = Array.from({ length: 30 }, () =>
    reserveUploadSlot(identity)
  );

  const results = await Promise.all(promises);
  const allowed = results.filter((r) => r.allowed);
  const rejected = results.filter((r) => !r.allowed);

  assert.equal(allowed.length, 5, 'Exactly 5 upload slots should be granted');
  assert.equal(rejected.length, 25, 'Remaining 25 requests must be rejected');

  for (const res of allowed) {
    if (res.allowed) {
      assert.ok(res.reservation);
    }
  }
});

test('Direct upload ticket concurrency: claim and cancel transactional race protection', async () => {
  resetDirectUploadTicketsForTesting();
  await resetQuotaForTesting();

  const userId = 'user-ticket-race';
  const chatId = 'chat-race-1';
  const attId = 'att-race-123';
  const identity = { type: 'auth' as const, id: userId, key: `auth_${userId}` };

  const reservation = await reserveUploadSlot(identity);
  assert.ok(reservation.allowed);

  const now = Date.now();
  await createDurableUploadTicket({
    attachmentId: attId,
    userId,
    chatId,
    storagePath: `${userId}/${chatId}/test.txt`,
    bucket: 'attachments',
    fileName: 'test.txt',
    extension: 'txt',
    mimeType: 'text/plain',
    size: 1024,
    quotaReservation: (reservation as any).reservation,
    expiresAt: now + 60_000,
    createdAt: now
  });

  const claim1 = claimDirectUploadTicketForCompletion(attId, userId, chatId);
  const cancel1 = cancelDurableUploadTicket(attId, userId);

  const [claimRes, cancelRes] = await Promise.all([claim1, cancel1]);

  if (claimRes.success) {
    assert.equal(cancelRes.code, 'CONCURRENT_COMPLETION');
    assert.equal(cancelRes.status, 409);
  } else {
    assert.equal(claimRes.success, false);
  }

  resetDirectUploadTicketsForTesting();
  await resetQuotaForTesting();
});
