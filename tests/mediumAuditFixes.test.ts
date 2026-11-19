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
import {
  registerUploadRoutes,
  fileRegistry,
  conversationDocuments,
  UPLOAD_DIR,
  resetUploadRegistryForTesting,
  resolveRegisteredAttachmentForChat,
  getDurableConversationUploadRecords
} from '../server/uploadSubsystem.ts';
import { RESERVATION_TTL_MS, reserveUploadSlot, getQuotaStatus } from '../server/uploadQuotaService.ts';
import { createDurableUploadTicket, claimDirectUploadTicketForCompletion } from '../server/directUploadTicketService.ts';
import {
  applyJsonBodyMiddleware,
  DEFAULT_JSON_BODY_LIMIT,
  SHARE_JSON_BODY_LIMIT,
  CHAT_JSON_BODY_LIMIT
} from '../server/serverConfig.ts';
import { registerShareRoutes } from '../server/shareSubsystem.ts';
import { resetRateLimitersForTesting } from '../server/rateLimiter.ts';
import fs from 'node:fs';
import path from 'node:path';
// @ts-ignore
import { MAX_SHARED_SNAPSHOT_BYTES, createSharedChatSnapshot } from '../src/services/shareChatService.js';
// @ts-ignore
import { GEMINI_PRIMARY_MODEL, GEMINI_FALLBACK_MODEL, GEMINI_FALLBACK_CANDIDATES } from '../src/config/appConfig.js';
// @ts-ignore
import { sanitizeStoredDisplayModel, validateServerModelForProvider } from '../src/services/providerModelSanitizer.js';
// @ts-ignore
import { PROVIDER_OPTIONS } from '../src/services/aiRouter.js';
// @ts-ignore
import { PROVIDER_PROFILES } from '../src/services/documentContextService.js';

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
  applyJsonBodyMiddleware(app);
  registerUploadRoutes(app);
  registerShareRoutes(app);
  app.post('/api/echo-json', (req, res) => {
    res.status(200).json({ ok: true, size: JSON.stringify(req.body || {}).length });
  });
  app.post('/api/chat', (req, res) => {
    res.status(200).json({ ok: true, size: JSON.stringify(req.body || {}).length });
  });

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

test('ORVIX-MED-01: Share snapshot size limit (900 KB) matches README documentation everywhere', () => {
  assert.equal(MAX_SHARED_SNAPSHOT_BYTES, 900 * 1024);
  const readmeContent = fs.readFileSync(path.resolve(process.cwd(), 'README.md'), 'utf8');
  assert.equal(readmeContent.includes('950 KB'), false, 'README.md must not contain outdated 950 KB share size limit');
  assert.equal(readmeContent.includes('900 KB'), true, 'README.md must document the 900 KB share snapshot size limit');
});

test('ORVIX-MED-02: Direct client-side Firestore share branch and unused isValidSharedMessageItem rule are removed', async () => {
  const rulesContent = fs.readFileSync(path.resolve(process.cwd(), 'firestore.rules'), 'utf8');
  assert.equal(
    rulesContent.includes('isValidSharedMessageItem'),
    false,
    'Unused isValidSharedMessageItem helper must be removed from firestore.rules'
  );
  assert.equal(
    rulesContent.includes('match /sharedChats/{shareId}'),
    true,
    'sharedChats security rules must remain intact'
  );

  let directSetDocCalled = false;
  let apiShareCalled = false;

  const result = await createSharedChatSnapshot(
    { id: 'chat-med-02', title: 'Test Share', mode: 'general' },
    [{ id: 'm1', sender: 'user', content: 'Hello Orvix', createdAtMs: Date.now() }],
    {
      user: {
        uid: 'user-med-02',
        isAnonymous: false,
        getIdToken: async () => 'fake-id-token'
      },
      // Even if legacy direct-Firestore options are passed, createSharedChatSnapshot must use /api/share
      useDirectFirestore: true,
      firestoreDb: {},
      setDocImpl: async () => {
        directSetDocCalled = true;
      },
      baseUrl: 'https://orvix.test',
      fetchImpl: async (url: string, init: any) => {
        apiShareCalled = true;
        assert.equal(url, '/api/share');
        assert.equal(init.method, 'POST');
        const parsedBody = JSON.parse(init.body);
        return new Response(
          JSON.stringify({
            shareId: parsedBody.shareId,
            shareUrl: `https://orvix.test/share/${parsedBody.shareId}`,
            title: parsedBody.chat.title,
            mode: parsedBody.chat.mode,
            messageCount: parsedBody.messages.length,
            createdAtMs: Date.now()
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } }
        );
      }
    } as any
  );

  assert.equal(directSetDocCalled, false, 'Direct client-side Firestore setDoc must never be called');
  assert.equal(apiShareCalled, true, 'Share creation must always publish via POST /api/share');
  assert.ok(result.shareId);
  assert.ok(result.shareUrl.includes(result.shareId));
});

test('ORVIX-MED-03: All Gemini model identifiers use supported Gemini 2.5 models and legacy stored IDs sanitize cleanly', () => {
  assert.equal(GEMINI_PRIMARY_MODEL, 'gemini-2.5-flash');
  assert.equal(GEMINI_FALLBACK_MODEL, 'gemini-2.5-flash-lite');
  assert.deepEqual(GEMINI_FALLBACK_CANDIDATES, ['gemini-2.5-flash', 'gemini-2.5-flash-lite']);

  const geminiOption = PROVIDER_OPTIONS.find((p: any) => p.id === 'gemini');
  assert.ok(geminiOption);
  assert.equal(geminiOption.defaultModel, 'gemini-2.5-flash');
  assert.equal(geminiOption.modelTag, 'Gemini 2.5 Flash');
  assert.equal(PROVIDER_PROFILES.gemini.modelTag, 'gemini-2.5-flash');

  // Legacy stored identifiers in localStorage migrate cleanly to supported models
  assert.equal(sanitizeStoredDisplayModel('gemini', 'gemini-4-hydrogen'), 'gemini-2.5-flash');
  assert.equal(sanitizeStoredDisplayModel('gemini', 'gemini-3.8-flash'), 'gemini-2.5-flash');
  assert.equal(sanitizeStoredDisplayModel('gemini', 'gemini-3.5-flash-lite'), 'gemini-2.5-flash-lite');
  assert.equal(sanitizeStoredDisplayModel('gemini', 'gemini-3.1-flash-lite'), 'gemini-2.5-flash-lite');

  // Server validation rejects all fictional/invalid identifiers
  for (const badModel of ['gemini-4-hydrogen', 'gemini-3.5-flash-lite', 'gemini-3.5-transcribe', 'gemini-3.8-flash', 'gemini-3.1-flash-lite']) {
    const check = validateServerModelForProvider('gemini', badModel);
    assert.equal(check.valid, false, `Model ${badModel} must be rejected`);
  }
});

test('ORVIX-MED-04: Upload metadata and extracted text persist in Firestore and re-hydrate across serverless instances without Supabase', async () => {
  resetFirebaseAuthForTesting();
  await resetFirestoreForTesting();
  resetUploadRegistryForTesting();
  resetRateLimitersForTesting();

  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const projectId = 'orvix-med04-test';
  setTestFirebaseProjectId(projectId);
  setTestPublicKey('med-test-kid', publicKey.export({ type: 'spki', format: 'pem' }).toString());

  const nowSec = Math.floor(Date.now() / 1000);
  const aliceToken = buildSignedJwt(
    {
      sub: 'alice-med04-uid',
      user_id: 'alice-med04-uid',
      aud: projectId,
      iss: `https://securetoken.google.com/${projectId}`,
      iat: nowSec - 10,
      exp: nowSec + 3600
    },
    privateKey
  );
  const bobToken = buildSignedJwt(
    {
      sub: 'bob-med04-uid',
      user_id: 'bob-med04-uid',
      aud: projectId,
      iss: `https://securetoken.google.com/${projectId}`,
      iat: nowSec - 10,
      exp: nowSec + 3600
    },
    privateKey
  );

  const srv = await startUploadTestServer();
  try {
    const conversationId = 'conv-med04-cross-instance';
    const docContent = '# Orvix Serverless Architecture\nUpload metadata and extracted text persist across instances via Firestore.';
    const formData = new FormData();
    formData.append('conversationId', conversationId);
    formData.append(
      'files',
      new Blob([docContent], { type: 'text/markdown' }),
      'architecture-notes.md'
    );

    // 1. Upload document on Instance 1
    const uploadRes = await fetch(`${srv.baseUrl}/api/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${aliceToken}` },
      body: formData
    });
    assert.equal(uploadRes.status, 200);
    const uploadBody = (await uploadRes.json()) as any;
    assert.equal(uploadBody.success, true);
    const uploadedAtt = uploadBody.attachment;
    assert.ok(uploadedAtt?.id);
    assert.ok(uploadedAtt?.extraction?.text?.includes('Orvix Serverless Architecture'));

    const fileId = uploadedAtt.id;
    const diskPath = path.join(UPLOAD_DIR, `${fileId}.md`);

    // 2. Simulate request hitting a separate serverless instance:
    //    Clear in-memory fileRegistry, conversationDocuments, and local disk file.
    resetUploadRegistryForTesting({ memoryOnly: true });
    try {
      if (fs.existsSync(diskPath)) {
        fs.unlinkSync(diskPath);
      }
    } catch (_) {}
    assert.equal(fileRegistry.has(fileId), false);
    assert.equal(conversationDocuments.has(conversationId), false);

    // 3. Verify GET /api/upload/:id re-hydrates metadata + extraction on Instance 2 for Alice
    const metaRes = await fetch(`${srv.baseUrl}/api/upload/${fileId}`, {
      headers: { Authorization: `Bearer ${aliceToken}` }
    });
    assert.equal(metaRes.status, 200);
    const metaJson = (await metaRes.json()) as any;
    assert.equal(metaJson.id, fileId);
    assert.equal(metaJson.originalName, 'architecture-notes.md');
    assert.ok(metaJson.extraction?.text?.includes('Orvix Serverless Architecture'));

    // 4. Clear memory again and verify GET /api/upload/:id/extraction returns extracted text on Instance 3
    resetUploadRegistryForTesting({ memoryOnly: true });
    const extRes = await fetch(`${srv.baseUrl}/api/upload/${fileId}/extraction`, {
      headers: { Authorization: `Bearer ${aliceToken}` }
    });
    assert.equal(extRes.status, 200);
    const extJson = (await extRes.json()) as any;
    assert.ok(extJson.text?.includes('Orvix Serverless Architecture'));

    // 5. Verify cross-user isolation: Bob is rejected with 403 even on a cold instance
    resetUploadRegistryForTesting({ memoryOnly: true });
    const bobRes = await fetch(`${srv.baseUrl}/api/upload/${fileId}`, {
      headers: { Authorization: `Bearer ${bobToken}` }
    });
    assert.equal(bobRes.status, 403);

    const bobChatResolve = await resolveRegisteredAttachmentForChat(
      { id: fileId },
      { authenticatedUserId: 'bob-med04-uid', conversationId }
    );
    assert.equal(bobChatResolve.status, 'forbidden');

    // 6. Verify resolveRegisteredAttachmentForChat and getDurableConversationUploadRecords succeed for Alice on a cold instance
    resetUploadRegistryForTesting({ memoryOnly: true });
    const aliceChatResolve = await resolveRegisteredAttachmentForChat(
      { id: fileId },
      { authenticatedUserId: 'alice-med04-uid', conversationId }
    );
    assert.equal(aliceChatResolve.status, 'ok');
    assert.ok(aliceChatResolve.record?.extraction?.text?.includes('Orvix Serverless Architecture'));

    resetUploadRegistryForTesting({ memoryOnly: true });
    const convRecords = await getDurableConversationUploadRecords(conversationId, 'alice-med04-uid');
    assert.equal(convRecords.length, 1);
    assert.equal(convRecords[0].id, fileId);
    assert.ok(convRecords[0].extraction?.text?.includes('Orvix Serverless Architecture'));
  } finally {
    await srv.close();
    resetUploadRegistryForTesting();
    await resetFirestoreForTesting();
    resetFirebaseAuthForTesting();
  }
});

test('ORVIX-MED-05: Route-specific and global JSON request body limits reject oversized payloads with HTTP 413', async () => {
  assert.equal(DEFAULT_JSON_BODY_LIMIT, '1mb');
  assert.equal(SHARE_JSON_BODY_LIMIT, '2mb');
  assert.equal(CHAT_JSON_BODY_LIMIT, '5mb');

  const srv = await startUploadTestServer();
  try {
    // 1. Normal small JSON request on general endpoint succeeds
    const smallRes = await fetch(`${srv.baseUrl}/api/echo-json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello world' })
    });
    assert.equal(smallRes.status, 200);

    // 2. Oversized (> 1 MB) JSON payload on general endpoint is rejected with HTTP 413 PAYLOAD_TOO_LARGE
    const over1MbPayload = JSON.stringify({ data: 'x'.repeat(1.2 * 1024 * 1024) });
    const generalOversizedRes = await fetch(`${srv.baseUrl}/api/echo-json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: over1MbPayload
    });
    assert.equal(generalOversizedRes.status, 413);
    const generalOversizedBody = (await generalOversizedRes.json()) as any;
    assert.equal(generalOversizedBody.code, 413);
    assert.equal(generalOversizedBody.status, 'PAYLOAD_TOO_LARGE');

    // 3. 1.2 MB JSON payload on /api/chat is permitted by route-specific 5 MB parser
    const chatAllowedRes = await fetch(`${srv.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: over1MbPayload
    });
    assert.equal(chatAllowedRes.status, 200);

    // 4. Oversized (> 5 MB) JSON payload on /api/chat is rejected with HTTP 413 PAYLOAD_TOO_LARGE
    const over5MbPayload = JSON.stringify({ data: 'x'.repeat(5.3 * 1024 * 1024) });
    const chatOversizedRes = await fetch(`${srv.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: over5MbPayload
    });
    assert.equal(chatOversizedRes.status, 413);
    const chatOversizedBody = (await chatOversizedRes.json()) as any;
    assert.equal(chatOversizedBody.code, 413);
    assert.equal(chatOversizedBody.status, 'PAYLOAD_TOO_LARGE');

    // 5. Oversized (> 2 MB) JSON payload on /api/share is rejected with HTTP 413 PAYLOAD_TOO_LARGE
    const over2MbPayload = JSON.stringify({ data: 'x'.repeat(2.2 * 1024 * 1024) });
    const shareOversizedRes = await fetch(`${srv.baseUrl}/api/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: over2MbPayload
    });
    assert.equal(shareOversizedRes.status, 413);
    const shareOversizedBody = (await shareOversizedRes.json()) as any;
    assert.equal(shareOversizedBody.code, 413);
    assert.equal(shareOversizedBody.status, 'PAYLOAD_TOO_LARGE');
  } finally {
    await srv.close();
  }
});

test('MED-01, MED-02, MED-03: InMemoryRedisMock deterministic TTL + instance isolation, scoped Vercel OCR functions, and serverless persistence safeguards', async () => {
  const { InMemoryRedisMock } = await import('../server/redisClient.ts');
  const { ATOMIC_RATE_LIMIT_LUA } = await import('../server/rateLimiter.ts');
  const { getServerPersistenceStatus } = await import('../server/serverConfig.ts');

  // MED-01: Instance-scoped kvStore and deterministic PTTL bounded by windowMs
  const mockA = new InMemoryRedisMock();
  const mockB = new InMemoryRedisMock();
  await mockA.connect();
  await mockB.connect();
  const windowMs = 10_000;
  for (let i = 0; i < 20; i++) {
    const resA = (await mockA.eval(ATOMIC_RATE_LIMIT_LUA, 1, `med01:key:${i}`, windowMs)) as [number, number];
    assert.equal(resA[0], 1);
    assert.ok(resA[1] >= 1 && resA[1] <= windowMs, `Expected pttl in [1, ${windowMs}], got ${resA[1]}`);
  }
  const isolatedResB = (await mockB.eval(ATOMIC_RATE_LIMIT_LUA, 1, 'med01:key:0', windowMs)) as [number, number];
  assert.equal(isolatedResB[0], 1, 'Separate InMemoryRedisMock instances must not leak key counters');

  // MED-02: vercel.json scopes OCR bundle and 300s/1024MB limits only to api/chat.ts and api/upload.ts
  const vercelRaw = fs.readFileSync(path.resolve(process.cwd(), 'vercel.json'), 'utf8');
  const vercelJson = JSON.parse(vercelRaw);
  assert.equal(vercelJson.functions['api/*.ts'], undefined, 'Wildcard api/*.ts function config must be removed');
  assert.deepEqual(Object.keys(vercelJson.functions).sort(), ['api/chat.ts', 'api/upload.ts']);
  assert.equal(vercelJson.functions['api/chat.ts'].maxDuration, 300);
  assert.equal(vercelJson.functions['api/upload.ts'].maxDuration, 300);

  // MED-03: getServerPersistenceStatus reports non-persistent backends and warnings in serverless mode when unconfigured
  const status = getServerPersistenceStatus(true);
  assert.equal(status.runtime, 'serverless');
  if (!status.firestoreConfigured || !status.supabaseConfigured || !status.redisConfigured) {
    assert.equal(status.persistenceReady, false);
    assert.ok(status.warnings.length > 0, 'Unconfigured serverless persistence must emit explicit health warnings');
  }
});


