import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import http from 'node:http';
import { WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';

import {
  MAX_FIRESTORE_MESSAGE_BYTES,
  MAX_FIRESTORE_DOCUMENT_BYTES,
  MAX_ATTACHMENT_EXTRACTION_BYTES,
  getUtf8ByteLength,
  calculateFirestoreDocumentByteSize,
  calculateDocumentByteSize,
  enforceFirestoreMessageSizeLimit,
  enforceFirestoreDocumentSizeLimit,
  sanitizeExtractionForStorage,
  sanitizeMessageForStorage,
  buildFirestoreMessagePayload
} from '../src/services/chatStorageService.js';
import { VoiceStreamClient } from '../src/services/voiceStreamClient.js';
import { getGeminiApiKey } from '../server/serverConfig.ts';
import { setupVoiceWebSocketServer, resetVoiceWebSocketStateForTesting } from '../server/voiceWebSocketSubsystem.ts';
import { resetFirebaseAuthForTesting, setTestFirebaseProjectId, setTestPublicKey } from '../server/firebaseAuthHelper.ts';

function buildSignedTestJwt(uid: string, projectId: string, privateKey: crypto.KeyObject, kid: string): string {
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

test('ORVIX-M02 Firestore document size limit: enforces 100KB message limit and 900KB safety ceiling accounting for Firestore encoding', () => {
  assert.equal(MAX_FIRESTORE_MESSAGE_BYTES, 100000);
  assert.equal(MAX_FIRESTORE_DOCUMENT_BYTES, 900 * 1024);
  assert.equal(MAX_ATTACHMENT_EXTRACTION_BYTES, 64 * 1024);

  // 1. Single message truncation at 100 KB
  const shortText = 'Hello world';
  const enforcedShort = enforceFirestoreMessageSizeLimit(shortText);
  assert.equal(enforcedShort.truncated, false);
  assert.equal(enforcedShort.content, shortText);

  const bulkyText = 'A'.repeat(120_000);
  const enforcedBulky = enforceFirestoreMessageSizeLimit(bulkyText);
  assert.equal(enforcedBulky.truncated, true);
  assert.ok(getUtf8ByteLength(enforcedBulky.content) <= MAX_FIRESTORE_MESSAGE_BYTES);
  assert.match(enforcedBulky.content, /\[Notice: Message exceeded 100 KB Firestore storage limit and was truncated\.\]/);

  // 2. Attachment extraction truncation at 64 KB and page limit bounding
  const bulkyExtraction = {
    text: 'X'.repeat(90_000),
    pages: Array.from({ length: 30 }, (_, i) => ({ pageNumber: i + 1, text: `Page ${i + 1}` })),
    slides: Array.from({ length: 25 }, (_, i) => ({ slideNumber: i + 1 })),
    fileType: 'pdf',
    base64: 'unwanted-raw-data',
    previewUrl: 'blob:unwanted'
  };
  const sanitizedExtraction = sanitizeExtractionForStorage(bulkyExtraction);
  assert.equal(sanitizedExtraction.base64, undefined);
  assert.equal(sanitizedExtraction.previewUrl, undefined);
  assert.equal(sanitizedExtraction.wasTruncated, true);
  assert.ok(getUtf8ByteLength(sanitizedExtraction.text) <= MAX_ATTACHMENT_EXTRACTION_BYTES);
  assert.match(sanitizedExtraction.text, /\[Notice: Extracted text truncated for Firestore document limit\.\]/);
  assert.equal(sanitizedExtraction.pages.length, 15);
  assert.equal(sanitizedExtraction.slides.length, 15);

  // 3. Official Firestore document sizing calculation verification
  const sampleDoc = {
    id: 'test-doc-1',
    count: 42,
    active: true,
    empty: null,
    items: ['alpha', 'beta'],
    metadata: { created: 1234567890 }
  };
  const exactFsSize = calculateFirestoreDocumentByteSize(sampleDoc, 'users/user-12345/chats/chat-67890/messages/msg-abcde');
  assert.ok(exactFsSize > 0);
  // Numbers must be 8 bytes, booleans 1 byte, strings len + 1
  assert.ok(exactFsSize >= 150, 'Must include document path overhead and field sizes');

  // 4. Worst-case pathological payload: 25 cumulative alternatives of 90 KB each + 20 attachments
  const activeAlternativeId = 'alt-active-keep';
  const worstCaseMsg = {
    id: 'msg-m02-worst-case',
    sender: 'assistant',
    content: 'Initial answer',
    modelUsed: 'gemini-2.5-flash',
    activeAlternativeId,
    timestamp: '12:00 PM',
    alternatives: Array.from({ length: 25 }, (_, i) => ({
      id: i === 10 ? activeAlternativeId : `alt-${i}`,
      sender: 'assistant',
      content: `Alternative ${i} ` + 'B'.repeat(90_000),
      modelUsed: 'gemini-2.5-flash',
      createdAtMs: Date.now() + i
    })),
    attachments: Array.from({ length: 20 }, (_, i) => ({
      id: `att-${i}`,
      name: `document_${i}.pdf`,
      extraction: {
        text: 'E'.repeat(80_000),
        pages: Array.from({ length: 20 }, (_, p) => ({ pageNumber: p + 1 }))
      }
    }))
  };

  const payload = buildFirestoreMessagePayload(worstCaseMsg);
  const totalFsBytes = calculateFirestoreDocumentByteSize(payload);
  const totalJsonBytes = calculateDocumentByteSize(payload);

  // Must strictly obey safety ceiling (900 KiB) under Firestore's 1 MiB limit
  assert.ok(
    totalFsBytes <= MAX_FIRESTORE_DOCUMENT_BYTES,
    `Firestore encoded bytes (${totalFsBytes}) must not exceed MAX_FIRESTORE_DOCUMENT_BYTES (${MAX_FIRESTORE_DOCUMENT_BYTES})`
  );
  assert.ok(
    totalJsonBytes <= MAX_FIRESTORE_DOCUMENT_BYTES,
    `Total byte calculation (${totalJsonBytes}) must not exceed MAX_FIRESTORE_DOCUMENT_BYTES (${MAX_FIRESTORE_DOCUMENT_BYTES})`
  );

  // Essential metadata must be strictly preserved
  assert.equal(payload.id, 'msg-m02-worst-case');
  assert.equal(payload.sender, 'assistant');
  assert.equal(payload.modelUsed, 'gemini-2.5-flash');
  assert.equal(payload.activeAlternativeId, activeAlternativeId);

  // Active alternative must never be pruned away
  const foundActive = payload.alternatives.find((alt: any) => alt.id === activeAlternativeId);
  assert.ok(foundActive, 'Active alternative must be preserved even when pruning older alternatives');
  assert.equal(foundActive.id, activeAlternativeId);
});

test('ORVIX-M03 WebSocket authentication: rejects URL query tokens and accepts Authorization Bearer and orvix-auth subprotocol', async () => {
  resetFirebaseAuthForTesting();
  resetVoiceWebSocketStateForTesting();

  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const projectId = 'orvix-m03-proj';
  const kid = 'm03-kid';
  setTestFirebaseProjectId(projectId);
  setTestPublicKey(kid, publicKey.export({ type: 'spki', format: 'pem' }).toString());

  const validToken = buildSignedTestJwt('user-m03', projectId, privateKey, kid);

  const app = express();
  const server = http.createServer(app);
  setupVoiceWebSocketServer(server);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  const wsBaseUrl = `ws://127.0.0.1:${addr.port}/api/voice-stream`;

  try {
    // 1. Unauthenticated connection (no token, no headers) MUST be rejected with HTTP 401
    await assert.rejects(
      () =>
        new Promise((resolve, reject) => {
          const ws = new WebSocket(wsBaseUrl);
          ws.on('open', () => resolve(ws));
          ws.on('error', reject);
        }),
      /Unexpected server response: 401/
    );

    // 2. Query parameter authentication (?token=...) MUST BE REJECTED with HTTP 401
    await assert.rejects(
      () =>
        new Promise((resolve, reject) => {
          const ws = new WebSocket(`${wsBaseUrl}?token=${encodeURIComponent(validToken)}`);
          ws.on('open', () => resolve(ws));
          ws.on('error', reject);
        }),
      /Unexpected server response: 401/,
      'WebSocket connection providing authentication only via ?token= query parameter must be rejected with HTTP 401'
    );

    // 3. Client resolveWebSocketUrl() does not append ?token= to the URL
    const client = new VoiceStreamClient({ url: wsBaseUrl });
    const resolvedUrl = client.resolveWebSocketUrl();
    assert.equal(resolvedUrl.includes('token='), false);

    // 4. Connection with Sec-WebSocket-Protocol ['orvix-auth', encodeURIComponent(validToken)] succeeds
    const subprotoResult = await new Promise<{ authenticated: boolean; protocol?: string }>((resolve, reject) => {
      const ws = new WebSocket(wsBaseUrl, ['orvix-auth', encodeURIComponent(validToken)]);
      ws.on('open', () => {
        // ws.protocol should negotiate 'orvix-auth' and NOT echo the raw token
        assert.equal(ws.protocol, 'orvix-auth');
      });
      ws.on('message', (msg) => {
        try {
          const data = JSON.parse(msg.toString());
          if (data.type === 'authenticated' && data.userId === 'user-m03') {
            ws.close();
            resolve({ authenticated: true, protocol: ws.protocol });
          }
        } catch (_) {}
      });
      ws.on('error', reject);
    });
    assert.equal(subprotoResult.authenticated, true);
    assert.equal(subprotoResult.protocol, 'orvix-auth');

    // 5. Connection with Bearer token in Authorization header succeeds
    const headerResult = await new Promise<{ authenticated: boolean }>((resolve, reject) => {
      const ws = new WebSocket(wsBaseUrl, {
        headers: { Authorization: `Bearer ${validToken}` }
      });
      ws.on('message', (msg) => {
        try {
          const data = JSON.parse(msg.toString());
          if (data.type === 'authenticated' && data.userId === 'user-m03') {
            ws.close();
            resolve({ authenticated: true });
          }
        } catch (_) {}
      });
      ws.on('error', reject);
    });
    assert.equal(headerResult.authenticated, true);
  } finally {
    resetVoiceWebSocketStateForTesting();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test('ORVIX-M04 Frontend credential isolation: zero server secrets in client bundle or image OCR helpers', () => {
  // 1. Verify /proc/environ scanning is absent from serverConfig.ts
  const serverConfigSrc = fs.readFileSync(path.join(process.cwd(), 'server', 'serverConfig.ts'), 'utf8');
  assert.equal(
    serverConfigSrc.includes('/proc') && serverConfigSrc.includes('environ'),
    false,
    'Unsafe /proc/PID/environ environment secret scanning must be completely removed'
  );

  const apiKey = getGeminiApiKey();
  assert.equal(typeof apiKey, 'string');

  // 2. Verify imageOcrService.js has zero direct process.env.GEMINI_API_KEY reads
  const ocrServiceSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'imageOcrService.js'), 'utf8');
  assert.equal(
    ocrServiceSrc.includes('process.env.GEMINI_API_KEY'),
    false,
    'imageOcrService.js must not contain direct process.env.GEMINI_API_KEY reads'
  );

  // 3. Verify production client bundle in dist/assets does not contain raw server API keys or unredacted secrets
  const distAssetsDir = path.join(process.cwd(), 'dist', 'assets');
  if (fs.existsSync(distAssetsDir)) {
    const jsFiles = fs.readdirSync(distAssetsDir).filter((f) => f.endsWith('.js'));
    for (const jsFile of jsFiles) {
      const content = fs.readFileSync(path.join(distAssetsDir, jsFile), 'utf8');
      // Must not contain actual raw Google API keys (AIzaSy...)
      assert.equal(
        /AIzaSy[A-Za-z0-9_-]{33}/.test(content),
        false,
        `Production client bundle (${jsFile}) must not embed raw server-side Google API keys`
      );
    }
  }
});
