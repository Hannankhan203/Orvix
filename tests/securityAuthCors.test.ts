import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import http from 'node:http';
import { WebSocket, type WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';

import {
  applyCorsMiddleware,
  applyJsonBodyMiddleware,
  isAllowedOrigin
} from '../server/serverConfig.ts';
import { registerChatRoutes } from '../server/chatSubsystem.ts';
import { registerTranscriptionRoutes } from '../server/transcriptionSubsystem.ts';
import {
  setupVoiceWebSocketServer,
  resetVoiceWebSocketStateForTesting
} from '../server/voiceWebSocketSubsystem.ts';
import {
  resetFirebaseAuthForTesting,
  setTestFirebaseProjectId,
  setTestPublicKey
} from '../server/firebaseAuthHelper.ts';
import { resetRateLimitersForTesting } from '../server/rateLimiter.ts';
import { resetRedisClientForTesting } from '../server/redisClient.ts';
import { setAuthInstanceForTesting } from '../src/services/authService.js';
import { transcribeAudioBlob, createMinimalWavBlob } from '../src/services/transcriptionService.js';
import { VoiceStreamClient } from '../src/services/voiceStreamClient.js';
import chatHandler from '../api/chat.ts';
import transcribeHandler from '../api/transcribe.ts';

function buildSignedJwt(
  claims: Record<string, any>,
  privateKey: crypto.KeyObject,
  headerOverrides: Record<string, any> = {}
): string {
  const header = Buffer.from(
    JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'sec-test-kid', ...headerOverrides })
  ).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = crypto
    .createSign('RSA-SHA256')
    .update(`${header}.${payload}`)
    .sign(privateKey)
    .toString('base64url');
  return `${header}.${payload}.${signature}`;
}

interface SecurityTestServer {
  app: express.Express;
  server: http.Server;
  wss: WebSocketServer;
  baseUrl: string;
  wsUrl: string;
  close: () => Promise<void>;
}

async function startSecurityTestServer(): Promise<SecurityTestServer> {
  const app = express();
  applyCorsMiddleware(app);
  applyJsonBodyMiddleware(app);
  registerTranscriptionRoutes(app);
  registerChatRoutes(app);

  const server = http.createServer(app);
  const wss = setupVoiceWebSocketServer(server);

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  const wsUrl = `ws://127.0.0.1:${addr.port}/api/voice-stream`;

  let isClosed = false;
  let closePromise: Promise<void> | null = null;

  const close = async (): Promise<void> => {
    if (isClosed) return;
    if (closePromise) return closePromise;

    closePromise = (async () => {
      let firstError: unknown = null;

      // 1. Terminate all active WebSocket clients and close WebSocketServer
      try {
        for (const client of wss.clients) {
          try {
            client.terminate();
          } catch (_) {}
        }
        await new Promise<void>((resolve, reject) => {
          wss.close((err) => {
            if (err && !(err as any).message?.includes('not running')) {
              reject(err);
            } else {
              resolve();
            }
          });
        });
      } catch (err) {
        firstError = firstError || err;
      }

      // 2. Remove upgrade listener on HTTP server
      try {
        server.removeAllListeners('upgrade');
      } catch (err) {
        firstError = firstError || err;
      }

      // 3. Terminate active and idle HTTP keep-alive connections
      try {
        if (typeof (server as any).closeAllConnections === 'function') {
          (server as any).closeAllConnections();
        }
      } catch (err) {
        firstError = firstError || err;
      }
      try {
        if (typeof (server as any).closeIdleConnections === 'function') {
          (server as any).closeIdleConnections();
        }
      } catch (err) {
        firstError = firstError || err;
      }

      // 4. Close the HTTP server
      try {
        await new Promise<void>((resolve, reject) => {
          server.close((err) => {
            if (err && (err as any).code !== 'ERR_SERVER_NOT_RUNNING') {
              reject(err);
            } else {
              resolve();
            }
          });
        });
      } catch (err) {
        firstError = firstError || err;
      }

      // 5. Clean up voice state and reset Redis client
      try {
        resetVoiceWebSocketStateForTesting();
      } catch (err) {
        firstError = firstError || err;
      }

      try {
        await resetRedisClientForTesting();
      } catch (err) {
        firstError = firstError || err;
      }

      isClosed = true;

      if (firstError) {
        throw firstError;
      }
    })();

    return closePromise;
  };

  return {
    app,
    server,
    wss,
    baseUrl,
    wsUrl,
    close
  };
}

function setupTestKeys() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const projectId = 'orvix-sec-test-project';
  const kid = 'sec-test-kid';
  setTestFirebaseProjectId(projectId);
  setTestPublicKey(kid, publicKey.export({ type: 'spki', format: 'pem' }).toString());
  const nowSec = Math.floor(Date.now() / 1000);

  const validToken = buildSignedJwt(
    {
      sub: 'verified-user-101',
      user_id: 'verified-user-101',
      email: 'verified@orvix.test',
      aud: projectId,
      iss: `https://securetoken.google.com/${projectId}`,
      iat: nowSec - 30,
      exp: nowSec + 3600
    },
    privateKey
  );

  const expiredToken = buildSignedJwt(
    {
      sub: 'verified-user-101',
      user_id: 'verified-user-101',
      aud: projectId,
      iss: `https://securetoken.google.com/${projectId}`,
      iat: nowSec - 7200,
      exp: nowSec - 300
    },
    privateKey
  );

  const guestUidToken = buildSignedJwt(
    {
      sub: 'guest-spoofed-123',
      user_id: 'guest-spoofed-123',
      aud: projectId,
      iss: `https://securetoken.google.com/${projectId}`,
      iat: nowSec - 30,
      exp: nowSec + 3600
    },
    privateKey
  );

  const wrongAudienceToken = buildSignedJwt(
    {
      sub: 'verified-user-101',
      user_id: 'verified-user-101',
      aud: 'other-firebase-project',
      iss: 'https://securetoken.google.com/other-firebase-project',
      iat: nowSec - 30,
      exp: nowSec + 3600
    },
    privateKey
  );

  return {
    privateKey,
    projectId,
    kid,
    validToken,
    expiredToken,
    guestUidToken,
    wrongAudienceToken
  };
}

test('ORVIX-CRIT-03 /api/chat: rejects unauthenticated, malformed, expired, and forged Firebase credentials across all routes', async () => {
  resetFirebaseAuthForTesting();
  resetRateLimitersForTesting();
  const keys = setupTestKeys();
  const srv = await startSecurityTestServer();

  const prevDemo = process.env.ORVIX_DEMO_MODE;
  const prevGemini = process.env.GEMINI_API_KEY;
  process.env.ORVIX_DEMO_MODE = 'true'; // Even with demo mode enabled, unauthenticated users must be blocked
  delete process.env.GEMINI_API_KEY;

  try {
    const payload = JSON.stringify({ provider: 'gemini', prompt: 'Hello from attacker', stream: false });

    for (const endpoint of ['/api/chat', '/chat', '/']) {
      // 1. Missing Authorization header -> 401 AUTH_REQUIRED
      const resMissing = await fetch(`${srv.baseUrl}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload
      });
      assert.equal(resMissing.status, 401, `${endpoint} must return 401 without token`);
      const bodyMissing: any = await resMissing.json();
      assert.equal(bodyMissing.code, 'AUTH_REQUIRED');

      // 2. Spoofed x-user-id or userId body without Authorization -> 401 AUTH_REQUIRED
      const resSpoof = await fetch(`${srv.baseUrl}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': 'admin-uid-999' },
        body: JSON.stringify({ provider: 'gemini', prompt: 'Spoof attempt', userId: 'admin-uid-999', stream: false })
      });
      assert.equal(resSpoof.status, 401);
      assert.equal(((await resSpoof.json()) as any).code, 'AUTH_REQUIRED');
    }

    // 3. Malformed Authorization headers -> 401 MALFORMED_AUTH_HEADER
    for (const authVal of ['Basic dXNlcjpwYXNz', 'Bearer', 'Bearer   ', 'InvalidScheme token123']) {
      const resMalformed = await fetch(`${srv.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: authVal },
        body: payload
      });
      assert.equal(resMalformed.status, 401);
      const bodyMalformed: any = await resMalformed.json();
      assert.equal(bodyMalformed.code, 'MALFORMED_AUTH_HEADER');
    }

    // 4. Expired Firebase token -> 401 TOKEN_EXPIRED
    const resExpired = await fetch(`${srv.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${keys.expiredToken}` },
      body: payload
    });
    assert.equal(resExpired.status, 401);
    assert.equal(((await resExpired.json()) as any).code, 'TOKEN_EXPIRED');

    // 5. Invalid / tampered / wrong-audience / guest-prefixed UID tokens -> 401
    const forgedToken = `${keys.validToken.slice(0, -4)}AAAA`;
    for (const badToken of [forgedToken, 'not.a.jwt', keys.wrongAudienceToken, keys.guestUidToken]) {
      const resBad = await fetch(`${srv.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${badToken}` },
        body: payload
      });
      assert.equal(resBad.status, 401);
    }

    // 6. Legitimate authenticated user preserves chat functionality
    const resValid = await fetch(`${srv.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${keys.validToken}` },
      body: payload
    });
    assert.equal(resValid.status, 200);
    const validJson: any = await resValid.json();
    assert.equal(validJson.provider, 'gemini');
    assert.ok(typeof validJson.text === 'string' && validJson.text.length > 0);
  } finally {
    if (prevDemo !== undefined) process.env.ORVIX_DEMO_MODE = prevDemo;
    else delete process.env.ORVIX_DEMO_MODE;
    if (prevGemini !== undefined) process.env.GEMINI_API_KEY = prevGemini;
    else delete process.env.GEMINI_API_KEY;
    resetFirebaseAuthForTesting();
    resetRateLimitersForTesting();
    await srv.close();
    await resetRedisClientForTesting();
  }
});

test('ORVIX-CRIT-03 /api/transcribe: rejects unauthenticated/invalid requests before multipart parsing and allows authenticated transcription', async () => {
  resetFirebaseAuthForTesting();
  resetRateLimitersForTesting();
  const keys = setupTestKeys();
  const srv = await startSecurityTestServer();

  const origFetch = globalThis.fetch;
  const prevGroq = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = 'gsk_test_fake_groq_key_1234567890';

  let upstreamGroqCalls = 0;
  globalThis.fetch = (async (input: any, init?: any) => {
    const urlStr = typeof input === 'string' ? input : input?.url || '';
    if (urlStr.includes('api.groq.com')) {
      upstreamGroqCalls += 1;
      return new Response(
        JSON.stringify({ text: 'Authenticated audio transcription succeeded.', language: 'en', duration: 1.2 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return origFetch(input, init);
  }) as typeof fetch;

  try {
    const makeBody = () => {
      const fd = new FormData();
      fd.append('file', createMinimalWavBlob(), 'test.wav');
      fd.append('language', 'en-US');
      return fd;
    };

    for (const endpoint of ['/api/transcribe', '/transcribe']) {
      // Unauthenticated -> 401 AUTH_REQUIRED, never calls upstream Groq
      const resNoAuth = await origFetch(`${srv.baseUrl}${endpoint}`, {
        method: 'POST',
        body: makeBody()
      });
      assert.equal(resNoAuth.status, 401);
      const bodyNoAuth: any = await resNoAuth.json();
      assert.equal(bodyNoAuth.code, 'AUTH_REQUIRED');
    }

    // Expired token -> 401 TOKEN_EXPIRED
    const resExpired = await origFetch(`${srv.baseUrl}/api/transcribe`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${keys.expiredToken}` },
      body: makeBody()
    });
    assert.equal(resExpired.status, 401);
    assert.equal(((await resExpired.json()) as any).code, 'TOKEN_EXPIRED');

    // Malformed header -> 401 MALFORMED_AUTH_HEADER
    const resMalformed = await origFetch(`${srv.baseUrl}/api/transcribe`, {
      method: 'POST',
      headers: { Authorization: 'Token bad-format' },
      body: makeBody()
    });
    assert.equal(resMalformed.status, 401);
    assert.equal(((await resMalformed.json()) as any).code, 'MALFORMED_AUTH_HEADER');

    assert.equal(upstreamGroqCalls, 0, 'Unauthenticated requests must never invoke upstream transcription providers');

    // Authenticated request -> 200 OK
    const resAuth = await origFetch(`${srv.baseUrl}/api/transcribe`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${keys.validToken}` },
      body: makeBody()
    });
    assert.equal(resAuth.status, 200);
    const jsonAuth: any = await resAuth.json();
    assert.equal(jsonAuth.success, true);
    assert.equal(jsonAuth.provider, 'groq');
    assert.match(jsonAuth.text, /Authenticated audio transcription succeeded/);
    assert.equal(upstreamGroqCalls, 1);
  } finally {
    globalThis.fetch = origFetch;
    if (prevGroq !== undefined) process.env.GROQ_API_KEY = prevGroq;
    else delete process.env.GROQ_API_KEY;
    resetFirebaseAuthForTesting();
    resetRateLimitersForTesting();
    await srv.close();
    await resetRedisClientForTesting();
  }
});

test('ORVIX-CRIT-03 Vercel serverless handlers /api/chat and /api/transcribe enforce auth and reject wildcard origins', async () => {
  resetFirebaseAuthForTesting();
  resetRateLimitersForTesting();
  setupTestKeys();

  const chatServer = http.createServer((req, res) => {
    chatHandler(req as any, res as any);
  });
  const transcribeServer = http.createServer((req, res) => {
    transcribeHandler(req as any, res as any);
  });

  await Promise.all([
    new Promise<void>((r) => chatServer.listen(0, '127.0.0.1', () => r())),
    new Promise<void>((r) => transcribeServer.listen(0, '127.0.0.1', () => r()))
  ]);

  const chatPort = (chatServer.address() as AddressInfo).port;
  const transcribePort = (transcribeServer.address() as AddressInfo).port;

  try {
    // 1. Direct unauthenticated POST to Vercel /api/chat handler -> 401
    const chatRes = await fetch(`http://127.0.0.1:${chatPort}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'gemini', prompt: 'hi' })
    });
    assert.equal(chatRes.status, 401);

    // 2. Arbitrary .vercel.app cross-origin request blocked by CORS (403)
    const chatCorsRes = await fetch(`http://127.0.0.1:${chatPort}/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://evil-attacker.vercel.app'
      },
      body: JSON.stringify({ provider: 'gemini', prompt: 'hi' })
    });
    assert.equal(chatCorsRes.status, 403);

    // 3. Direct unauthenticated POST to Vercel /api/transcribe handler -> 401
    const fd = new FormData();
    fd.append('transcript', 'hello world');
    fd.append('transcriptOnly', 'true');
    const transRes = await fetch(`http://127.0.0.1:${transcribePort}/`, {
      method: 'POST',
      body: fd
    });
    assert.equal(transRes.status, 401);
  } finally {
    if (typeof (chatServer as any).closeAllConnections === 'function') {
      try { (chatServer as any).closeAllConnections(); } catch (_) {}
    }
    if (typeof (transcribeServer as any).closeAllConnections === 'function') {
      try { (transcribeServer as any).closeAllConnections(); } catch (_) {}
    }
    await new Promise<void>((r) => chatServer.close(() => r()));
    await new Promise<void>((r) => transcribeServer.close(() => r()));
    resetFirebaseAuthForTesting();
    resetRateLimitersForTesting();
    await resetRedisClientForTesting();
  }
});

test('ORVIX-CRIT-03 /api/voice-stream WebSocket: rejects unauthenticated, expired, guest, and untrusted-origin upgrades; allows authenticated streaming', async () => {
  resetVoiceWebSocketStateForTesting();
  resetFirebaseAuthForTesting();
  resetRateLimitersForTesting();
  const keys = setupTestKeys();
  const srv = await startSecurityTestServer();

  try {
    // 1. Missing token -> HTTP 401 rejected at handshake
    await assert.rejects(
      () =>
        new Promise((resolve, reject) => {
          const ws = new WebSocket(srv.wsUrl);
          ws.on('open', () => resolve(ws));
          ws.on('error', reject);
        }),
      /Unexpected server response: 401/
    );

    // 2. Expired token -> HTTP 401 rejected at handshake
    await assert.rejects(
      () =>
        new Promise((resolve, reject) => {
          const ws = new WebSocket(`${srv.wsUrl}?token=${encodeURIComponent(keys.expiredToken)}`);
          ws.on('open', () => resolve(ws));
          ws.on('error', reject);
        }),
      /Unexpected server response: 401/
    );

    // 3. Malformed Authorization header even with query token -> HTTP 401 rejected
    await assert.rejects(
      () =>
        new Promise((resolve, reject) => {
          const ws = new WebSocket(`${srv.wsUrl}?token=${encodeURIComponent(keys.validToken)}`, {
            headers: { Authorization: 'Basic abc123' }
          });
          ws.on('open', () => resolve(ws));
          ws.on('error', reject);
        }),
      /Unexpected server response: 401/
    );

    // 4. Untrusted wildcard .vercel.app Origin -> HTTP 403 rejected
    await assert.rejects(
      () =>
        new Promise((resolve, reject) => {
          const ws = new WebSocket(`${srv.wsUrl}?token=${encodeURIComponent(keys.validToken)}`, {
            headers: { Origin: 'https://evil-attacker.vercel.app' }
          });
          ws.on('open', () => resolve(ws));
          ws.on('error', reject);
        }),
      /Unexpected server response: 403/
    );

    // 5. Authenticated connection succeeds, returns verified userId with isGuest=false, and rejects guest downgrade attempts
    const messages: any[] = [];
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const sock = new WebSocket(`${srv.wsUrl}?token=${encodeURIComponent(keys.validToken)}`);
      sock.on('message', (raw) => {
        try {
          messages.push(JSON.parse(raw.toString()));
        } catch (_) {}
      });
      sock.on('open', () => resolve(sock));
      sock.on('error', reject);
    });

    await new Promise((r) => setTimeout(r, 40));
    assert.ok(messages.some((m) => m.type === 'authenticated' && m.userId === 'verified-user-101' && m.isGuest === false));

    // Sending { type: 'auth', guest: true } on an already-open socket must fail closed
    const closedPromise = new Promise<{ code: number }>((resolve) => {
      ws.on('close', (code) => resolve({ code }));
    });
    ws.send(JSON.stringify({ type: 'auth', guest: true }));
    const closeEvt = await closedPromise;
    assert.equal(closeEvt.code, 4401);
    assert.ok(messages.some((m) => m.type === 'error' && m.code === 'AUTH_REQUIRED'));
  } finally {
    resetVoiceWebSocketStateForTesting();
    resetFirebaseAuthForTesting();
    resetRateLimitersForTesting();
    await srv.close();
    await resetRedisClientForTesting();
  }
});

test('ORVIX-CRIT-03 CORS policy: blocks arbitrary wildcard cloud domains and honors explicit trusted origins only', async () => {
  const prevAllowed = process.env.ALLOWED_ORIGINS;
  const prevCorsAllowed = process.env.CORS_ALLOWED_ORIGINS;
  const prevVitePublic = process.env.VITE_PUBLIC_APP_URL;
  const prevAppUrl = process.env.APP_URL;

  delete process.env.ALLOWED_ORIGINS;
  delete process.env.CORS_ALLOWED_ORIGINS;
  delete process.env.VITE_PUBLIC_APP_URL;
  delete process.env.APP_URL;

  const prodReq = {
    headers: { host: 'orvix.example.com' }
  } as unknown as express.Request;

  try {
    // Same-origin is allowed
    assert.equal(isAllowedOrigin('https://orvix.example.com', prodReq), true);

    // Wildcard deployment domains MUST be blocked when not explicitly configured
    assert.equal(isAllowedOrigin('https://evil-attacker.vercel.app', prodReq), false);
    assert.equal(isAllowedOrigin('https://phishing-clone.run.app', prodReq), false);
    assert.equal(isAllowedOrigin('https://untrusted.aistudio.google.com', prodReq), false);
    assert.equal(isAllowedOrigin('https://evil.example.com', prodReq), false);
    assert.equal(isAllowedOrigin('javascript:alert(1)', prodReq), false);

    // Explicitly configured origins ARE allowed
    process.env.ALLOWED_ORIGINS = 'https://trusted-orvix.vercel.app, https://staging.orvix.ai';
    assert.equal(isAllowedOrigin('https://trusted-orvix.vercel.app', prodReq), true);
    assert.equal(isAllowedOrigin('https://staging.orvix.ai', prodReq), true);
    assert.equal(isAllowedOrigin('https://other-attacker.vercel.app', prodReq), false);

    // HTTP preflight & POST CORS middleware enforcement
    const srv = await startSecurityTestServer();
    try {
      const preflightBlocked = await fetch(`${srv.baseUrl}/api/chat`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://evil-attacker.vercel.app',
          'Access-Control-Request-Method': 'POST'
        }
      });
      assert.equal(preflightBlocked.status, 403);

      const preflightAllowed = await fetch(`${srv.baseUrl}/api/chat`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://trusted-orvix.vercel.app',
          'Access-Control-Request-Method': 'POST'
        }
      });
      assert.equal(preflightAllowed.status, 204);
      assert.equal(
        preflightAllowed.headers.get('access-control-allow-origin'),
        'https://trusted-orvix.vercel.app'
      );

      const postBlocked = await fetch(`${srv.baseUrl}/api/transcribe`, {
        method: 'POST',
        headers: { Origin: 'https://evil-service.run.app' }
      });
      assert.equal(postBlocked.status, 403);
    } finally {
      await srv.close();
    }
  } finally {
    if (prevAllowed !== undefined) process.env.ALLOWED_ORIGINS = prevAllowed;
    else delete process.env.ALLOWED_ORIGINS;
    if (prevCorsAllowed !== undefined) process.env.CORS_ALLOWED_ORIGINS = prevCorsAllowed;
    else delete process.env.CORS_ALLOWED_ORIGINS;
    if (prevVitePublic !== undefined) process.env.VITE_PUBLIC_APP_URL = prevVitePublic;
    else delete process.env.VITE_PUBLIC_APP_URL;
    if (prevAppUrl !== undefined) process.env.APP_URL = prevAppUrl;
    else delete process.env.APP_URL;
    await resetRedisClientForTesting();
  }
});

test('ORVIX-CRIT-03 client services: transcriptionService attaches Bearer token and refreshes on TOKEN_EXPIRED; VoiceStreamClient never sends guest auth', async () => {
  let tokenCallCount = 0;
  setAuthInstanceForTesting({
    currentUser: {
      uid: 'client-user-1',
      getIdToken: async (forceRefresh?: boolean) => {
        tokenCallCount += 1;
        return forceRefresh ? 'fresh-firebase-token-2' : 'stale-firebase-token-1';
      }
    }
  } as any);

  const seenAuthHeaders: string[] = [];
  const restoreFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: any, init: any) => {
    const authHdr = init?.headers?.Authorization || init?.headers?.authorization || '';
    seenAuthHeaders.push(authHdr);
    if (seenAuthHeaders.length === 1) {
      return new Response(
        JSON.stringify({ success: false, error: 'Token expired', code: 'TOKEN_EXPIRED' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return new Response(
      JSON.stringify({ success: true, text: 'Refreshed transcription worked', provider: 'groq', model: 'whisper-large-v3-turbo' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }) as typeof fetch;

  try {
    const res = await transcribeAudioBlob({ audioBlob: createMinimalWavBlob(), timeoutMs: 5000 });
    assert.equal(res.success, true);
    assert.equal(res.text, 'Refreshed transcription worked');
    assert.deepEqual(seenAuthHeaders, [
      'Bearer stale-firebase-token-1',
      'Bearer fresh-firebase-token-2'
    ]);
    assert.equal(tokenCallCount, 2);

    // VoiceStreamClient should NOT send { type: 'auth', guest: true } on open when no token is provided
    const sentMessages: string[] = [];
    const OrigWs = globalThis.WebSocket;
    class CapturingMockWs {
      static CONNECTING = 0;
      static OPEN = 1;
      readyState = 1;
      binaryType = 'blob';
      onopen: any = null;
      onmessage: any = null;
      onerror: any = null;
      onclose: any = null;
      url: string;
      constructor(url: string) {
        this.url = url;
        setTimeout(() => {
          this.onopen?.();
          this.onmessage?.({
            data: JSON.stringify({ type: 'authenticated', sessionId: 's1', userId: 'u1', isGuest: false })
          });
        }, 5);
      }
      send(msg: string) {
        sentMessages.push(msg);
      }
      close() {}
    }

    (globalThis as any).WebSocket = CapturingMockWs;
    try {
      const client = new VoiceStreamClient({ url: 'wss://example.test/api/voice-stream' });
      assert.equal(
        client.resolveWebSocketUrl('my-jwt-token'),
        'wss://example.test/api/voice-stream?token=my-jwt-token'
      );
      await client.connect('');
      assert.equal(
        sentMessages.some((m) => m.includes('"guest":true')),
        false,
        'VoiceStreamClient must never send guest:true auth packets'
      );
    } finally {
      (globalThis as any).WebSocket = OrigWs;
    }
  } finally {
    globalThis.fetch = restoreFetch;
    setAuthInstanceForTesting(null);
    await resetRedisClientForTesting();
  }
});
