import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import EventEmitter from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { WebSocket } from 'ws';

import {
  extractClientIp,
  resolveTrustedProxyPolicy
} from '../server/trustedProxy.ts';
import {
  ATOMIC_RATE_LIMIT_LUA,
  InMemoryRateLimitStore,
  checkWebSocketHandshakeFloodLimit,
  checkWebSocketUpgradeRateLimit,
  consumeRateLimit,
  createRateLimiterMiddleware,
  getRateLimitBackendStatus,
  resetRateLimitersForTesting
} from '../server/rateLimiter.ts';
import {
  ensureRedisReady,
  resetRedisClientForTesting,
  setRedisClientForTesting,
  type RedisLikeClient
} from '../server/redisClient.ts';
import {
  ATOMIC_WS_SLOT_ACQUIRE_LUA,
  ATOMIC_WS_SLOT_REFRESH_LUA,
  ATOMIC_WS_SLOT_RELEASE_LUA,
  MAX_WS_PAYLOAD_BYTES,
  getVoiceIpConnectionCount,
  resetVoiceWebSocketStateForTesting,
  setupVoiceWebSocketServer
} from '../server/voiceWebSocketSubsystem.ts';
import {
  resetFirebaseAuthForTesting,
  setTestFirebaseProjectId,
  setTestPublicKey
} from '../server/firebaseAuthHelper.ts';
import { applyCorsMiddleware } from '../server/serverConfig.ts';

/**
 * Shared atomic Redis mock supporting both fixed-window rate-limit Lua scripts
 * and ZSET WebSocket concurrent slot Lua scripts, plus cold-start state transitions.
 */
class SharedAtomicMockRedis extends EventEmitter implements RedisLikeClient {
  public status: string = 'ready';
  private rateData = new Map<string, { value: number; expiresAtMs: number }>();
  private zsetData = new Map<string, Map<string, number>>();
  public failNextEval = false;
  public hangEvalMs = 0;

  setReady(): void {
    this.status = 'ready';
    this.emit('ready');
  }

  zcard(key: string): number {
    return this.zsetData.get(key)?.size || 0;
  }

  async eval(script: unknown, numKeys: unknown, ...args: unknown[]): Promise<unknown> {
    if (this.status !== 'ready') {
      throw new Error(`Connection closed (status=${this.status})`);
    }
    if (this.hangEvalMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.hangEvalMs));
    }
    if (this.failNextEval) {
      this.failNextEval = false;
      throw new Error('READONLY You cannot write against a read only replica');
    }

    assert.equal(Number(numKeys), 1);
    const key = String(args[0]);
    const now = Date.now();

    if (script === ATOMIC_RATE_LIMIT_LUA) {
      const windowMs = Number(args[1]);
      const existing = this.rateData.get(key);
      if (existing && now >= existing.expiresAtMs) {
        this.rateData.delete(key);
      }
      let entry = this.rateData.get(key);
      if (!entry) {
        entry = { value: 1, expiresAtMs: now + windowMs };
        this.rateData.set(key, entry);
      } else {
        entry.value += 1;
      }
      return [entry.value, Math.max(1, entry.expiresAtMs - now)];
    }

    if (script === ATOMIC_WS_SLOT_ACQUIRE_LUA) {
      const argNow = Number(args[1]);
      const ttlMs = Number(args[2]);
      const maxSlots = Number(args[3]);
      const member = String(args[4]);

      let zset = this.zsetData.get(key);
      if (!zset) {
        zset = new Map();
        this.zsetData.set(key, zset);
      }
      for (const [m, score] of zset.entries()) {
        if (score <= argNow) zset.delete(m);
      }
      if (zset.size >= maxSlots) {
        return [0, zset.size];
      }
      zset.set(member, argNow + ttlMs);
      return [1, zset.size];
    }

    if (script === ATOMIC_WS_SLOT_RELEASE_LUA) {
      const member = String(args[1]);
      const zset = this.zsetData.get(key);
      if (!zset) return 0;
      zset.delete(member);
      if (zset.size === 0) this.zsetData.delete(key);
      return zset.size;
    }

    if (script === ATOMIC_WS_SLOT_REFRESH_LUA) {
      const argNow = Number(args[1]);
      const ttlMs = Number(args[2]);
      const member = String(args[3]);
      const zset = this.zsetData.get(key);
      if (zset && zset.has(member)) {
        zset.set(member, argNow + ttlMs);
        return 1;
      }
      return 0;
    }

    throw new Error('Unexpected Lua script passed to SharedAtomicMockRedis');
  }

  async quit(): Promise<string> {
    this.status = 'end';
    return 'OK';
  }

  disconnect(): void {
    this.status = 'end';
  }
}

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

async function withSavedEnv<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
  const backup = new Map<string, string | undefined>();
  for (const key of keys) {
    backup.set(key, process.env[key]);
  }
  try {
    return await fn();
  } finally {
    for (const key of keys) {
      const prev = backup.get(key);
      if (prev === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = prev;
      }
    }
  }
}

async function startTestServer(app: express.Express, withWs = false): Promise<{
  server: http.Server;
  wss?: ReturnType<typeof setupVoiceWebSocketServer>;
  baseUrl: string;
  wsUrl: string;
  close: () => Promise<void>;
}> {
  const server = http.createServer(app);
  const wss = withWs ? setupVoiceWebSocketServer(server) : undefined;
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  return {
    server,
    wss,
    baseUrl: `http://127.0.0.1:${addr.port}`,
    wsUrl: `ws://127.0.0.1:${addr.port}/api/voice-stream`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      })
  };
}

test('ORVIX-CRIT-04: Spoofed X-Forwarded-For headers are ignored without trusted proxy configuration', async () => {
  await withSavedEnv(['TRUST_PROXY', 'ORVIX_TRUST_PROXY', 'VERCEL', 'VERCEL_ENV', 'K_SERVICE'], async () => {
    delete process.env.TRUST_PROXY;
    delete process.env.ORVIX_TRUST_PROXY;
    delete process.env.VERCEL;
    delete process.env.VERCEL_ENV;
    delete process.env.K_SERVICE;

    assert.equal(resolveTrustedProxyPolicy().mode, 'disabled');

    const mem = new InMemoryRateLimitStore(false);
    const app = express();
    applyCorsMiddleware(app);
    app.post(
      '/api/chat',
      createRateLimiterMiddleware({ policy: 'chat', max: 2, windowMs: 30_000, redisClient: null, memoryStore: mem }),
      (_req, res) => res.json({ ok: true })
    );

    const srv = await startTestServer(app);
    try {
      // Attacker rotates X-Forwarded-For on every request, yet socket IP (127.0.0.1) triggers 429 on 3rd request
      const r1 = await fetch(`${srv.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'x-forwarded-for': '1.1.1.1' }
      });
      const r2 = await fetch(`${srv.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'x-forwarded-for': '2.2.2.2, 3.3.3.3' }
      });
      const r3 = await fetch(`${srv.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'x-forwarded-for': '4.4.4.4' }
      });

      assert.equal(r1.status, 200);
      assert.equal(r2.status, 200);
      assert.equal(r3.status, 429);
    } finally {
      mem.dispose();
      await srv.close();
    }
  });
});

test('ORVIX-CRIT-04: Trusted proxy resolution honors rightmost proxy hops, Vercel, Cloud Run, and allowlists', async () => {
  await withSavedEnv(['TRUST_PROXY', 'ORVIX_TRUST_PROXY', 'VERCEL', 'VERCEL_ENV', 'K_SERVICE'], async () => {
    // 1. Explicit hop count (e.g. single reverse proxy): ignores client-prepended spoofed IPs on the left
    delete process.env.VERCEL;
    delete process.env.VERCEL_ENV;
    delete process.env.K_SERVICE;
    process.env.TRUST_PROXY = '1';

    assert.equal(
      extractClientIp({
        headers: { 'x-forwarded-for': '9.9.9.9, 8.8.8.8, 203.0.113.50' },
        socket: { remoteAddress: '10.0.0.5' } as any
      }),
      '203.0.113.50'
    );

    // Malformed X-Forwarded-For safely falls back to TCP socket peer IP
    assert.equal(
      extractClientIp({
        headers: { 'x-forwarded-for': 'not-an-ip-address' },
        socket: { remoteAddress: '::ffff:198.51.100.12' } as any
      }),
      '198.51.100.12'
    );

    // 2. Two trusted proxy hops (e.g. CDN -> Load Balancer -> Origin)
    process.env.TRUST_PROXY = '2';
    assert.equal(
      extractClientIp({
        headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.77, 198.51.100.4' },
        socket: { remoteAddress: '10.0.0.8' } as any
      }),
      '203.0.113.77'
    );

    // 3. Trusted proxy CIDR allowlist: ignores XFF from untrusted direct peer; trusts XFF from allowlisted peer
    process.env.TRUST_PROXY = '10.0.0.0/8, 127.0.0.1';
    assert.equal(
      extractClientIp({
        headers: { 'x-forwarded-for': '9.9.9.9, 203.0.113.88, 10.2.3.4' },
        socket: { remoteAddress: '10.0.0.2' } as any
      }),
      '203.0.113.88'
    );
    assert.equal(
      extractClientIp({
        headers: { 'x-forwarded-for': '9.9.9.9' },
        socket: { remoteAddress: '198.51.100.77' } as any
      }),
      '198.51.100.77'
    );

    // 4. Google Cloud Run topology auto-detection (K_SERVICE)
    delete process.env.TRUST_PROXY;
    process.env.K_SERVICE = 'orvix-api';
    assert.equal(resolveTrustedProxyPolicy().mode, 'platform-cloud-run');
    assert.equal(
      extractClientIp({
        headers: { 'x-forwarded-for': '1.2.3.4, 192.0.2.44' },
        socket: { remoteAddress: '169.254.1.1' } as any
      }),
      '192.0.2.44'
    );

    // 5. Vercel topology auto-detection (prefers x-vercel-forwarded-for over attacker XFF)
    delete process.env.K_SERVICE;
    process.env.VERCEL = '1';
    assert.equal(resolveTrustedProxyPolicy().mode, 'platform-vercel');
    assert.equal(
      extractClientIp({
        headers: {
          'x-forwarded-for': '1.2.3.4',
          'x-vercel-forwarded-for': '203.0.113.199'
        },
        socket: { remoteAddress: '127.0.0.1' } as any
      }),
      '203.0.113.199'
    );
  });
});

test('ORVIX-CRIT-04: Cold-start Redis transition (`wait` -> `ready`) is awaited cleanly and honors distributed protection', async () => {
  const coldRedis = new SharedAtomicMockRedis();
  coldRedis.status = 'connecting';
  setTimeout(() => coldRedis.setReady(), 35);

  const ready = await ensureRedisReady(coldRedis, 500);
  assert.equal(ready, true);

  // Also test directly through consumeRateLimit starting from `wait` state
  const waitRedis = new SharedAtomicMockRedis();
  waitRedis.status = 'wait';
  setTimeout(() => waitRedis.setReady(), 30);

  const decision = await consumeRateLimit(
    { policy: 'chat', max: 5, windowMs: 30_000, redisClient: waitRedis, commandTimeoutMs: 500 },
    { type: 'ip', hashedId: 'coldstart-test-key' }
  );

  assert.equal(decision.backend, 'redis');
  assert.equal(decision.distributed, true);
  assert.equal(decision.degraded, false);
  assert.equal(decision.count, 1);
});

test('ORVIX-CRIT-04: Multiple simulated instances share WebSocket connection slots atomically via Redis', async () => {
  await withSavedEnv(['TRUST_PROXY', 'VERCEL', 'K_SERVICE'], async () => {
    process.env.TRUST_PROXY = 'false';

    resetVoiceWebSocketStateForTesting();
    resetFirebaseAuthForTesting();
    resetRateLimitersForTesting();

    const mockRedis = new SharedAtomicMockRedis();
    setRedisClientForTesting(mockRedis);

    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const kid = 'multi-ws-kid';
    const projectId = 'orvix-multi-ws-project';
    setTestFirebaseProjectId(projectId);
    setTestPublicKey(kid, publicKey.export({ type: 'spki', format: 'pem' }).toString());

    // Use two different authenticated users sharing the SAME client IP to test IP global slot limit = 10 across instances
    const tokenUserA = createSignedTestJwt('multi-user-A', projectId, privateKey, kid);
    const tokenUserB = createSignedTestJwt('multi-user-B', projectId, privateKey, kid);

    const srvA = await startTestServer(express(), true);
    const srvB = await startTestServer(express(), true);

    assert.equal(srvA.wss?.options.maxPayload, MAX_WS_PAYLOAD_BYTES);

    const openSockets: WebSocket[] = [];
    const connectWs = (wsUrl: string, token: string) =>
      new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(wsUrl, {
          headers: { Authorization: `Bearer ${token}` }
        });
        ws.on('open', () => resolve(ws));
        ws.on('error', (err) => reject(err));
      });

    try {
      // Open 6 sockets on Instance A and 4 sockets on Instance B (total = 10 globally for 127.0.0.1)
      for (let i = 0; i < 6; i++) {
        openSockets.push(await connectWs(srvA.wsUrl, tokenUserA));
      }
      for (let i = 0; i < 4; i++) {
        openSockets.push(await connectWs(srvB.wsUrl, tokenUserB));
      }

      assert.equal(getVoiceIpConnectionCount('127.0.0.1'), 10);

      // 11th connection hitting Instance B (different user token!) must STILL be rejected with 429 via shared Redis IP ZSET
      await assert.rejects(
        async () => {
          await connectWs(srvB.wsUrl, tokenUserB);
        },
        /Unexpected server response: 429/
      );

      // Closing one socket on Instance A releases global slot so Instance B can accept another connection
      const closedWs = openSockets.shift()!;
      closedWs.close();
      await new Promise((r) => setTimeout(r, 80));

      const replacement = await connectWs(srvB.wsUrl, tokenUserB);
      openSockets.push(replacement);
      assert.equal(getVoiceIpConnectionCount('127.0.0.1'), 10);
    } finally {
      for (const ws of openSockets) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.close();
        }
      }
      await new Promise((r) => setTimeout(r, 60));
      resetVoiceWebSocketStateForTesting();
      resetFirebaseAuthForTesting();
      resetRateLimitersForTesting();
      await resetRedisClientForTesting();
      await srvA.close();
      await srvB.close();
    }
  });
});

test('ORVIX-CRIT-04: Pre-auth WebSocket handshake flood guard blocks unauthenticated floods before JWT verification', async () => {
  await withSavedEnv(['TRUST_PROXY', 'VERCEL', 'K_SERVICE'], async () => {
    delete process.env.TRUST_PROXY;
    delete process.env.VERCEL;
    delete process.env.K_SERVICE;

    const mem = new InMemoryRateLimitStore(false);
    const fakeReq = {
      headers: { 'x-forwarded-for': '198.51.100.1' },
      socket: { remoteAddress: '127.0.0.1' }
    } as unknown as http.IncomingMessage;

    try {
      const d1 = await checkWebSocketHandshakeFloodLimit(fakeReq, { max: 2, windowMs: 10_000, redisClient: null, memoryStore: mem });
      const d2 = await checkWebSocketHandshakeFloodLimit(fakeReq, { max: 2, windowMs: 10_000, redisClient: null, memoryStore: mem });
      // Rotating spoofed header still hits same TCP peer IP flood bucket
      const fakeReqRotated = {
        headers: { 'x-forwarded-for': '203.0.113.99' },
        socket: { remoteAddress: '127.0.0.1' }
      } as unknown as http.IncomingMessage;
      const d3 = await checkWebSocketHandshakeFloodLimit(fakeReqRotated, { max: 2, windowMs: 10_000, redisClient: null, memoryStore: mem });

      assert.equal(d1.allowed, true);
      assert.equal(d2.allowed, true);
      assert.equal(d3.allowed, false);
      assert.equal(d3.distributed, false);
    } finally {
      mem.dispose();
    }
  });
});

test('ORVIX-CRIT-04: Shared-store failures never silently claim distributed protection and fail closed in production', async () => {
  await withSavedEnv(['NODE_ENV', 'RATE_LIMIT_REQUIRE_DISTRIBUTED', 'RATE_LIMIT_FAILURE_MODE'], async () => {
    delete process.env.RATE_LIMIT_FAILURE_MODE;

    // 1. In-memory fallback ALWAYS reports distributed=false (never falsely claims distributed protection)
    const mem = new InMemoryRateLimitStore(false);
    try {
      const devMemDecision = await consumeRateLimit(
        { policy: 'chat', max: 5, windowMs: 10_000, redisClient: null, memoryStore: mem },
        { type: 'ip', hashedId: 'truthful-mem-id' }
      );
      assert.equal(devMemDecision.backend, 'memory');
      assert.equal(devMemDecision.distributed, false);

      // 2. RATE_LIMIT_REQUIRE_DISTRIBUTED=true fails closed even if Redis is null
      process.env.RATE_LIMIT_REQUIRE_DISTRIBUTED = 'true';
      const requiredFailClosed = await consumeRateLimit(
        { policy: 'chat', max: 5, windowMs: 10_000, redisClient: null, memoryStore: mem },
        { type: 'ip', hashedId: 'required-failclosed-id' }
      );
      assert.equal(requiredFailClosed.allowed, false);
      assert.equal(requiredFailClosed.backend, 'fail-closed');
      assert.equal(requiredFailClosed.distributed, false);
      assert.equal(requiredFailClosed.failureReason, 'REDIS_UNAVAILABLE');
      assert.equal(getRateLimitBackendStatus().backend, 'fail-closed');
      delete process.env.RATE_LIMIT_REQUIRE_DISTRIBUTED;

      // 3. Production + configured failing/disconnected Redis -> fail closed HTTP 503 on costly routes
      process.env.NODE_ENV = 'production';
      const failingRedis = new SharedAtomicMockRedis();
      failingRedis.status = 'reconnecting';
      setRedisClientForTesting(failingRedis);

      const app = express();
      app.post(
        '/api/chat',
        createRateLimiterMiddleware({ policy: 'chat', max: 5, windowMs: 10_000, memoryStore: mem }),
        (_req, res) => res.json({ ok: true })
      );
      const srv = await startTestServer(app);
      try {
        const res = await fetch(`${srv.baseUrl}/api/chat`, { method: 'POST' });
        assert.equal(res.status, 503);
        const body = (await res.json()) as any;
        assert.equal(body.code, 'RATE_LIMITER_UNAVAILABLE');
        assert.ok(Number(res.headers.get('retry-after')) >= 1);

        // WebSocket upgrade check in same production Redis outage also returns fail-closed (503 behavior)
        const wsDecision = await checkWebSocketUpgradeRateLimit(
          { headers: {}, socket: { remoteAddress: '127.0.0.1' } } as any,
          'prod-user-1',
          { memoryStore: mem }
        );
        assert.equal(wsDecision.allowed, false);
        assert.equal(wsDecision.backend, 'fail-closed');
        assert.equal(wsDecision.distributed, false);
      } finally {
        await srv.close();
        await resetRedisClientForTesting();
      }
    } finally {
      mem.dispose();
    }
  });
});
