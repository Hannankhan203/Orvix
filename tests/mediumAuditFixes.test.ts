import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  resetFirebaseAuthForTesting,
  setTestFirebaseProjectId,
  setTestPublicKey
} from '../server/firebaseAuthHelper.ts';
import {
  setFirestoreForTesting,
  resetFirestoreForTesting
} from '../server/uploadQuotaService.ts';
import { registerUploadRoutes } from '../server/uploadSubsystem.ts';
import { RESERVATION_TTL_MS, reserveUploadSlot, getQuotaStatus } from '../server/uploadQuotaService.ts';
import { createDurableUploadTicket, claimDirectUploadTicketForCompletion } from '../server/directUploadTicketService.ts';

function buildSignedJwt(claims: Record<string, any>, privateKey: crypto.KeyObject): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'med-test-kid' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = crypto
    .createSign('RSA-SHA256')
    .update(`${header}.${payload}`)
    .sign(privateKey)
    .toString('base64url');
  return `${header}.${payload}.${signature}`;
}

async function startUploadTestServer() {
  const app = express();
  app.use(express.json());
  registerUploadRoutes(app);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  };
}

test('ORVIX-M01 upload status: unauthenticated requests cannot probe serverless or storage upload status (401/404)', async () => {
  resetFirebaseAuthForTesting();
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const projectId = 'orvix-m01-test';
  setTestFirebaseProjectId(projectId);
  setTestPublicKey('med-test-kid', publicKey.export({ type: 'spki', format: 'pem' }).toString());

  const nowSec = Math.floor(Date.now() / 1000);
  const validToken = buildSignedJwt(
    {
      sub: 'user-m01-owner',
      user_id: 'user-m01-owner',
      aud: projectId,
      iss: `https://securetoken.google.com/${projectId}`,
      iat: nowSec - 10,
      exp: nowSec + 3600
    },
    privateKey
  );

  const srv = await startUploadTestServer();
  try {
    const fakeUuid = '12345678-1234-1234-1234-123456789abc';

    // 1. Unauthenticated request to /api/upload/:id must return 401 Unauthorized (preventing unauth probing)
    const unauthRes = await fetch(`${srv.baseUrl}/api/upload/${fakeUuid}`);
    assert.equal(unauthRes.status, 401);
    const unauthJson = (await unauthRes.json()) as any;
    assert.equal(unauthJson.code, 'AUTH_REQUIRED');

    // 2. Authenticated request with valid token succeeds (or 404 if not found)
    const authRes = await fetch(`${srv.baseUrl}/api/upload/${fakeUuid}`, {
      headers: { Authorization: `Bearer ${validToken}` }
    });
    // If serverless is true, authenticated request receives ready status; if not serverless, 404 ATTACHMENT_NOT_FOUND
    assert.ok(authRes.status === 200 || authRes.status === 404);
  } finally {
    await srv.close();
    resetFirebaseAuthForTesting();
  }
});

test('ORVIX-M05 quota reservation TTL: default reservation TTL matches 7200-second direct upload ticket window', async () => {
  assert.equal(
    RESERVATION_TTL_MS,
    7_200_000,
    'RESERVATION_TTL_MS must be aligned to 7200 seconds (2 hours)'
  );

  await resetFirestoreForTesting();
  const identity = { type: 'auth' as const, id: 'user-m05', key: 'auth_user_m05' };
  const reserveRes = await reserveUploadSlot(identity);
  assert.equal(reserveRes.allowed, true);
  if (!reserveRes.allowed) return;

  const reservationWindowMs = reserveRes.reservation.expiresAt - reserveRes.reservation.createdAt;
  assert.equal(reservationWindowMs, 7_200_000, 'Created reservation must expire in exactly 7200 seconds');

  // Verify direct upload ticket expiry compatibility
  const ticket = await createDurableUploadTicket({
    attachmentId: 'att-m05-ticket',
    userId: 'user-m05',
    chatId: 'chat-m05',
    storagePath: 'user-m05/chat-m05/file.pdf',
    bucket: 'test-bucket',
    fileName: 'file.pdf',
    extension: 'pdf',
    mimeType: 'application/pdf',
    size: 2048,
    quotaReservation: reserveRes.reservation,
    expiresAt: reserveRes.reservation.expiresAt,
    createdAt: Date.now(),
    status: 'pending'
  });

  assert.equal(ticket.expiresAt, reserveRes.reservation.expiresAt, 'Ticket expiry must match quota reservation expiry');
  
  const claimRes = await claimDirectUploadTicketForCompletion('att-m05-ticket', 'user-m05', 'chat-m05');
  assert.equal(claimRes.success, true);
});
