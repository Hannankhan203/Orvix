import test from 'node:test';
import assert from 'node:assert/strict';
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
  resetVoiceWebSocketStateForTesting();
  const app = express();
  const srv = await startTestHttpServer(app);

  try {
    const ip = '198.51.100.123';
    const connectWs = () =>
      new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(srv.wsUrl, {
          headers: { 'x-forwarded-for': ip }
        });
        ws.on('open', () => resolve(ws));
        ws.on('error', (err) => reject(err));
      });

    // Connect 10 sockets concurrently (max allowed per IP)
    const sockets: WebSocket[] = [];
    for (let i = 0; i < 10; i++) {
      const ws = await connectWs();
      sockets.push(ws);
    }

    assert.equal(getVoiceIpConnectionCount(ip), 10);
    assert.equal(getActiveVoiceSessions().length, 10);

    // 11th connection attempt from the same IP must be rejected with 429
    await assert.rejects(
      async () => {
        await new Promise((resolve, reject) => {
          const ws = new WebSocket(srv.wsUrl, {
            headers: { 'x-forwarded-for': ip }
          });
          ws.on('open', () => resolve(ws));
          ws.on('error', (err) => reject(err));
        });
      },
      /Unexpected server response: 429/
    );

    // Close 2 sockets and verify connection count drops to 8
    sockets[0].close();
    sockets[1].close();
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(getVoiceIpConnectionCount(ip), 8);

    // Clean up remaining sockets
    for (const ws of sockets.slice(2)) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    }
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(getVoiceIpConnectionCount(ip), 0);
  } finally {
    resetVoiceWebSocketStateForTesting();
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
