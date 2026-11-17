import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { Redis } from 'ioredis';

import {
  ATOMIC_RATE_LIMIT_LUA,
  InMemoryRateLimitStore,
  buildRateLimitKey,
  checkWebSocketUpgradeRateLimit,
  consumeRateLimit,
  createRateLimiterMiddleware,
  resetRateLimitersForTesting
} from '../server/rateLimiter.ts';
import {
  InMemoryRedisMock,
  ManagedRedisClient,
  closeRedisClient,
  ensureRedisReady,
  getRedisClient,
  getRedisHealthStatus,
  resetRedisClientForTesting,
  setRedisClientForTesting,
  type RedisLikeClient
} from '../server/redisClient.ts';
import {
  ATOMIC_WS_SLOT_ACQUIRE_LUA,
  ATOMIC_WS_SLOT_REFRESH_LUA,
  ATOMIC_WS_SLOT_RELEASE_LUA,
  refreshDistributedWsSlot,
  releaseDistributedWsSlot,
  tryAcquireDistributedWsSlot
} from '../server/voiceWebSocketSubsystem.ts';
import {
  resetFirebaseAuthForTesting,
  setTestFirebaseProjectId,
  setTestPublicKey
} from '../server/firebaseAuthHelper.ts';
import { registerUploadRoutes } from '../server/uploadSubsystem.ts';
import { resetQuotaForTesting } from '../server/uploadQuotaService.ts';
import { ensureServerEnvLoaded } from '../server/serverConfig.ts';

/**
 * In-memory deterministic Redis mock supporting atomic Lua rate-limit EVAL execution,
 * TTL tracking, simulated disconnects, command errors, and artificial hangs/timeouts.
 */
class MockRedisClient implements RedisLikeClient {
  public status: string = 'ready';
  private data = new Map<string, { value: number; expiresAtMs: number | null }>();
  private nowOffsetMs = 0;
  public failNextEval = false;
  public hangEvalMs = 0;
  public evalCount = 0;

  now(): number {
    return Date.now() + this.nowOffsetMs;
  }

  advanceTime(ms: number): void {
    this.nowOffsetMs += ms;
  }

  setRawKeyWithoutTtl(key: string, value: number): void {
    this.data.set(key, { value, expiresAtMs: null });
  }

  keys(): string[] {
    return Array.from(this.data.keys());
  }

  async eval(script: unknown, numKeys: unknown, ...args: unknown[]): Promise<unknown> {
    this.evalCount += 1;
    if (this.status !== 'ready') {
      throw new Error(`Connection is closed (status=${this.status})`);
    }
    if (this.hangEvalMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.hangEvalMs));
    }
    if (this.failNextEval) {
      this.failNextEval = false;
      throw new Error('READONLY You cannot write against a read only replica');
    }

    assert.equal(script, ATOMIC_RATE_LIMIT_LUA);
    assert.equal(Number(numKeys), 1);

    const key = String(args[0]);
    const windowMs = Number(args[1]);
    const currentNow = this.now();

    const existing = this.data.get(key);
    if (existing && existing.expiresAtMs !== null && currentNow >= existing.expiresAtMs) {
      this.data.delete(key);
    }

    let entry = this.data.get(key);
    if (!entry) {
      entry = { value: 1, expiresAtMs: currentNow + windowMs };
      this.data.set(key, entry);
    } else {
      entry.value += 1;
      if (entry.expiresAtMs === null || entry.expiresAtMs <= currentNow) {
        entry.expiresAtMs = currentNow + windowMs;
      }
    }

    const pttl = entry.expiresAtMs !== null ? Math.max(1, entry.expiresAtMs - currentNow) : windowMs;
    return [entry.value, pttl];
  }

  async quit(): Promise<string> {
    this.status = 'end';
    return 'OK';
  }

  disconnect(): void {
    this.status = 'end';
  }
}

async function startTestHttpServer(app: express.Express): Promise<{
  server: http.Server;
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return {
    server,
    baseUrl,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      })
  };
}

function createSignedTestJwt(uid: string, projectId: string, privateKey: crypto.KeyObject, kid: string): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      iss: `https://securetoken.google.com/${projectId}`,
      aud: projectId,
      sub: uid,
      user_id: uid,
      iat: nowSec - 10,
      exp: nowSec + 3600,
      auth_time: nowSec - 10,
      email: `${uid}@example.com`
    })
  ).toString('base64url');
  const signature = crypto
    .createSign('RSA-SHA256')
    .update(`${header}.${payload}`)
    .sign(privateKey)
    .toString('base64url');
  return `${header}.${payload}.${signature}`;
}

test('Unconfigured REDIS_URL falls back to in-memory cleanly without errors', async () => {
  const isRedisEnvKey = (key: string): boolean => {
    const normalized = key.trim().toUpperCase();
    return normalized === 'REDIS_URL' || normalized === 'ORVIX_REDIS_URL';
  };

  const savedRedisEnv = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(process.env)) {
    if (isRedisEnvKey(key)) {
      savedRedisEnv.set(key, value);
    }
  }

  // Trigger .env loading once before clearing env vars so resolveEnvCredential()
  // does not re-populate REDIS_URL / ORVIX_REDIS_URL from a local .env file during the test.
  ensureServerEnvLoaded();
  for (const key of Object.keys(process.env)) {
    if (isRedisEnvKey(key)) {
      delete process.env[key];
    }
  }

  await resetRedisClientForTesting();
  resetRateLimitersForTesting();

  try {
    assert.equal(getRedisClient(), null);
    assert.deepEqual(getRedisHealthStatus(), {
      configured: false,
      connected: false,
      status: 'unconfigured'
    });

    const app = express();
    app.post('/api/chat', createRateLimiterMiddleware({ policy: 'chat', max: 2, windowMs: 10_000 }), (_req, res) => {
      res.status(200).json({ ok: true });
    });

    const srv = await startTestHttpServer(app);
    try {
      const r1 = await fetch(`${srv.baseUrl}/api/chat`, { method: 'POST', headers: { 'x-forwarded-for': '203.0.113.10' } });
      assert.equal(r1.status, 200);
      assert.equal(r1.headers.get('x-ratelimit-limit'), '2');
      assert.equal(r1.headers.get('x-ratelimit-remaining'), '1');

      const r2 = await fetch(`${srv.baseUrl}/api/chat`, { method: 'POST', headers: { 'x-forwarded-for': '203.0.113.10' } });
      assert.equal(r2.status, 200);
      assert.equal(r2.headers.get('x-ratelimit-remaining'), '0');

      const r3 = await fetch(`${srv.baseUrl}/api/chat`, { method: 'POST', headers: { 'x-forwarded-for': '203.0.113.10' } });
      assert.equal(r3.status, 429);
      assert.ok(Number(r3.headers.get('retry-after')) >= 1);
      const body = (await r3.json()) as any;
      assert.equal(body.code, 'RATE_LIMIT_EXCEEDED');
      assert.equal(body.policy, 'chat');
      assert.equal(body.remaining, 0);
    } finally {
      await srv.close();
    }
  } finally {
    for (const key of Object.keys(process.env)) {
      if (isRedisEnvKey(key)) {
        delete process.env[key];
      }
    }
    for (const [key, value] of savedRedisEnv.entries()) {
      if (value !== undefined) {
        process.env[key] = value;
      }
    }
    await resetRedisClientForTesting();
    resetRateLimitersForTesting();
  }
});

test('Shared rate limits across two simulated server instances via Redis', async () => {
  const mockRedis = new MockRedisClient();
  setRedisClientForTesting(mockRedis);

  const memA = new InMemoryRateLimitStore(false);
  const memB = new InMemoryRateLimitStore(false);

  const appA = express();
  appA.post(
    '/api/chat',
    createRateLimiterMiddleware({ policy: 'chat', max: 3, windowMs: 30_000, memoryStore: memA }),
    (_req, res) => res.json({ instance: 'A' })
  );

  const appB = express();
  appB.post(
    '/api/chat',
    createRateLimiterMiddleware({ policy: 'chat', max: 3, windowMs: 30_000, memoryStore: memB }),
    (_req, res) => res.json({ instance: 'B' })
  );

  const srvA = await startTestHttpServer(appA);
  const srvB = await startTestHttpServer(appB);

  try {
    const headers = { 'x-forwarded-for': '198.51.100.42' };

    const r1 = await fetch(`${srvA.baseUrl}/api/chat`, { method: 'POST', headers });
    assert.equal(r1.status, 200);
    assert.equal(r1.headers.get('x-ratelimit-remaining'), '2');

    const r2 = await fetch(`${srvB.baseUrl}/api/chat`, { method: 'POST', headers });
    assert.equal(r2.status, 200);
    assert.equal(r2.headers.get('x-ratelimit-remaining'), '1');

    const r3 = await fetch(`${srvA.baseUrl}/api/chat`, { method: 'POST', headers });
    assert.equal(r3.status, 200);
    assert.equal(r3.headers.get('x-ratelimit-remaining'), '0');

    // 4th request hitting Instance B must be blocked by shared Redis counter
    const r4 = await fetch(`${srvB.baseUrl}/api/chat`, { method: 'POST', headers });
    assert.equal(r4.status, 429);
    const errBody = (await r4.json()) as any;
    assert.equal(errBody.code, 'RATE_LIMIT_EXCEEDED');
    assert.equal(errBody.limit, 3);
    assert.equal(errBody.remaining, 0);
    assert.ok(Number(r4.headers.get('retry-after')) >= 1);

    // Ensure raw IP is NOT exposed in Redis keys
    const storedKeys = mockRedis.keys();
    assert.equal(storedKeys.length, 1);
    assert.ok(!storedKeys[0].includes('198.51.100.42'), 'Redis key must not expose raw IP');
    assert.match(storedKeys[0], /^orvix:rl:chat:ip:[a-f0-9]{24}$/);
  } finally {
    await srvA.close();
    await srvB.close();
    memA.dispose();
    memB.dispose();
    await resetRedisClientForTesting();
  }
});

test('Concurrent requests across instances respect atomic limit without race conditions', async () => {
  const mockRedis = new MockRedisClient();
  setRedisClientForTesting(mockRedis);

  const memA = new InMemoryRateLimitStore(false);
  const memB = new InMemoryRateLimitStore(false);

  const appA = express();
  appA.post(
    '/api/transcribe',
    createRateLimiterMiddleware({ policy: 'transcribe', max: 10, windowMs: 60_000, memoryStore: memA }),
    (_req, res) => res.json({ ok: true })
  );

  const appB = express();
  appB.post(
    '/api/transcribe',
    createRateLimiterMiddleware({ policy: 'transcribe', max: 10, windowMs: 60_000, memoryStore: memB }),
    (_req, res) => res.json({ ok: true })
  );

  const srvA = await startTestHttpServer(appA);
  const srvB = await startTestHttpServer(appB);

  try {
    const headers = { 'x-forwarded-for': '203.0.113.77' };
    const requests = Array.from({ length: 24 }, (_, idx) =>
      fetch(`${idx % 2 === 0 ? srvA.baseUrl : srvB.baseUrl}/api/transcribe`, {
        method: 'POST',
        headers
      })
    );

    const responses = await Promise.all(requests);
    const statuses = responses.map((r) => r.status);
    const okCount = statuses.filter((s) => s === 200).length;
    const limitedCount = statuses.filter((s) => s === 429).length;

    assert.equal(okCount, 10, 'Exactly 10 concurrent requests should be allowed');
    assert.equal(limitedCount, 14, 'Remaining 14 concurrent requests must be rejected with 429');
  } finally {
    await srvA.close();
    await srvB.close();
    memA.dispose();
    memB.dispose();
    await resetRedisClientForTesting();
  }
});

test('Window expiration resets counters in Redis and in-memory fallback, and self-heals missing TTL', async () => {
  const mockRedis = new MockRedisClient();
  const identity = { type: 'ip' as const, hashedId: 'abcd1234abcd1234abcd1234' };
  const key = buildRateLimitKey('chat', identity);

  // Simulate key left without TTL before self-healing Lua script runs
  mockRedis.setRawKeyWithoutTtl(key, 1);
  const second = await consumeRateLimit(
    { policy: 'chat', max: 2, windowMs: 5000, redisClient: mockRedis },
    identity
  );
  assert.equal(second.allowed, true);
  assert.equal(second.count, 2);
  assert.equal(second.remaining, 0);

  const blocked = await consumeRateLimit(
    { policy: 'chat', max: 2, windowMs: 5000, redisClient: mockRedis },
    identity
  );
  assert.equal(blocked.allowed, false);

  // Advance mock Redis time past 5000ms window -> counter resets
  mockRedis.advanceTime(5100);
  const afterReset = await consumeRateLimit(
    { policy: 'chat', max: 2, windowMs: 5000, redisClient: mockRedis },
    identity
  );
  assert.equal(afterReset.allowed, true);
  assert.equal(afterReset.count, 1);
  assert.equal(afterReset.remaining, 1);

  // Verify in-memory fallback window reset
  const mem = new InMemoryRateLimitStore(false);
  try {
    const t0 = 1_700_000_000_000;
    const m1 = await consumeRateLimit(
      { policy: 'chat', max: 1, windowMs: 2000, redisClient: null, memoryStore: mem, nowMs: t0 },
      identity
    );
    assert.equal(m1.allowed, true);

    const m2 = await consumeRateLimit(
      { policy: 'chat', max: 1, windowMs: 2000, redisClient: null, memoryStore: mem, nowMs: t0 + 500 },
      identity
    );
    assert.equal(m2.allowed, false);

    const m3 = await consumeRateLimit(
      { policy: 'chat', max: 1, windowMs: 2000, redisClient: null, memoryStore: mem, nowMs: t0 + 2100 },
      identity
    );
    assert.equal(m3.allowed, true);
    assert.equal(m3.count, 1);
  } finally {
    mem.dispose();
  }
});

test('Redis disconnect, error, timeout fallback, and automatic recovery', async () => {
  const mockRedis = new MockRedisClient();
  const mem = new InMemoryRateLimitStore(false);
  const identity = { type: 'user' as const, hashedId: '111122223333444455556666' };

  try {
    // 1. Healthy Redis
    const d1 = await consumeRateLimit(
      { policy: 'chat', max: 3, windowMs: 10_000, redisClient: mockRedis, memoryStore: mem },
      identity
    );
    assert.equal(d1.backend, 'redis');
    assert.equal(d1.degraded, false);
    assert.equal(d1.allowed, true);
    assert.equal(d1.count, 1);

    // 2. Redis disconnects -> immediate in-memory fallback without throwing
    mockRedis.status = 'reconnecting';
    const d2 = await consumeRateLimit(
      { policy: 'chat', max: 3, windowMs: 10_000, redisClient: mockRedis, memoryStore: mem },
      identity
    );
    assert.equal(d2.backend, 'memory');
    assert.equal(d2.degraded, true);
    assert.equal(d2.allowed, true);
    assert.equal(d2.count, 1);

    // 3. Redis ready again, but command throws -> fallback to memory
    mockRedis.status = 'ready';
    mockRedis.failNextEval = true;
    const d3 = await consumeRateLimit(
      { policy: 'chat', max: 3, windowMs: 10_000, redisClient: mockRedis, memoryStore: mem },
      identity
    );
    assert.equal(d3.backend, 'memory');
    assert.equal(d3.degraded, true);
    assert.equal(d3.count, 2);

    // 4. Redis command hangs beyond timeout -> times out fast and falls back
    mockRedis.hangEvalMs = 200;
    const d4 = await consumeRateLimit(
      {
        policy: 'chat',
        max: 3,
        windowMs: 10_000,
        redisClient: mockRedis,
        memoryStore: mem,
        commandTimeoutMs: 30
      },
      identity
    );
    assert.equal(d4.backend, 'memory');
    assert.equal(d4.degraded, true);
    assert.equal(d4.count, 3);
    assert.equal(d4.allowed, true);

    // Wait for hanging eval promise to settle cleanly on the mock server (increments Redis to 2)
    await new Promise((r) => setTimeout(r, 220));
    mockRedis.hangEvalMs = 0;

    // 5. Redis recovers -> resumes using shared Redis counter seamlessly (count becomes 3)
    const d5 = await consumeRateLimit(
      { policy: 'chat', max: 3, windowMs: 10_000, redisClient: mockRedis, memoryStore: mem },
      identity
    );
    assert.equal(d5.backend, 'redis');
    assert.equal(d5.degraded, false);
    assert.equal(d5.count, 3);
    assert.equal(d5.allowed, true);
  } finally {
    mem.dispose();
  }
});

test('Authenticated UID keys isolate users behind shared IP and preserve upload quota headers & auth', async () => {
  const prevProjectId = process.env.FIREBASE_PROJECT_ID;
  process.env.FIREBASE_PROJECT_ID = 'orvix-test-project';
  setTestFirebaseProjectId('orvix-test-project');

  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'test-key-1';
  setTestPublicKey(kid, publicKey.export({ type: 'spki', format: 'pem' }).toString());

  const mockRedis = new MockRedisClient();
  setRedisClientForTesting(mockRedis);
  await resetQuotaForTesting();

  const tokenAlice = createSignedTestJwt('alice-secret-uid-123', 'orvix-test-project', privateKey, kid);
  const tokenBob = createSignedTestJwt('bob-secret-uid-456', 'orvix-test-project', privateKey, kid);

  const app = express();
  app.use(express.json());
  app.post('/api/chat', createRateLimiterMiddleware({ policy: 'chat', max: 2, windowMs: 30_000 }), (_req, res) => {
    res.json({ ok: true });
  });
  registerUploadRoutes(app);

  const srv = await startTestHttpServer(app);

  try {
    // Both users share the exact same IP, yet each gets their own 2-request bucket
    const sharedIp = '192.0.2.55';
    const a1 = await fetch(`${srv.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'x-forwarded-for': sharedIp, authorization: `Bearer ${tokenAlice}` }
    });
    const a2 = await fetch(`${srv.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'x-forwarded-for': sharedIp, authorization: `Bearer ${tokenAlice}` }
    });
    const a3 = await fetch(`${srv.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'x-forwarded-for': sharedIp, authorization: `Bearer ${tokenAlice}` }
    });
    assert.equal(a1.status, 200);
    assert.equal(a2.status, 200);
    assert.equal(a3.status, 429);

    // Bob behind the same IP is NOT blocked by Alice's quota
    const b1 = await fetch(`${srv.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'x-forwarded-for': sharedIp, authorization: `Bearer ${tokenBob}` }
    });
    assert.equal(b1.status, 200);

    // Keys must never contain raw UIDs or raw IPs
    for (const key of mockRedis.keys()) {
      assert.ok(!key.includes('alice-secret-uid-123'));
      assert.ok(!key.includes('bob-secret-uid-456'));
      assert.ok(!key.includes(sharedIp));
    }

    // Existing upload authentication remains enforced (guest -> 401)
    const guestQuota = await fetch(`${srv.baseUrl}/api/upload/quota`, {
      headers: { 'x-forwarded-for': sharedIp }
    });
    assert.equal(guestQuota.status, 401);
    // Burst rate limiter on uploadRead must NOT overwrite X-RateLimit-* daily quota headers
    assert.equal(guestQuota.headers.get('x-ratelimit-limit'), null);
    assert.ok(guestQuota.headers.get('ratelimit-limit'));

    // Authenticated GET /api/upload/quota preserves daily 5-upload X-RateLimit-* headers
    const aliceQuota = await fetch(`${srv.baseUrl}/api/upload/quota`, {
      headers: { 'x-forwarded-for': sharedIp, authorization: `Bearer ${tokenAlice}` }
    });
    assert.equal(aliceQuota.status, 200);
    assert.equal(aliceQuota.headers.get('x-ratelimit-limit'), '5');
    assert.equal(aliceQuota.headers.get('x-ratelimit-remaining'), '5');
    assert.ok(aliceQuota.headers.get('x-ratelimit-reset-utc'));
    assert.ok(aliceQuota.headers.get('ratelimit-limit'));
  } finally {
    await srv.close();
    await resetRedisClientForTesting();
    resetFirebaseAuthForTesting();
    await resetQuotaForTesting();
    if (prevProjectId !== undefined) {
      process.env.FIREBASE_PROJECT_ID = prevProjectId;
    } else {
      delete process.env.FIREBASE_PROJECT_ID;
    }
  }
});

test('WebSocket upgrade rate limiting and graceful Redis shutdown', async () => {
  const mockRedis = new MockRedisClient();
  setRedisClientForTesting(mockRedis);

  const fakeReq = {
    headers: { 'x-forwarded-for': '198.51.100.99' },
    socket: { remoteAddress: '198.51.100.99' }
  } as unknown as http.IncomingMessage;

  const w1 = await checkWebSocketUpgradeRateLimit(fakeReq, null, { max: 2, windowMs: 10_000 });
  const w2 = await checkWebSocketUpgradeRateLimit(fakeReq, null, { max: 2, windowMs: 10_000 });
  const w3 = await checkWebSocketUpgradeRateLimit(fakeReq, null, { max: 2, windowMs: 10_000 });

  assert.equal(w1.allowed, true);
  assert.equal(w2.allowed, true);
  assert.equal(w3.allowed, false);
  assert.equal(w3.backend, 'redis');
  assert.ok(w3.retryAfterSeconds >= 1);

  await closeRedisClient();
  assert.equal(mockRedis.status, 'end');
  await resetRedisClientForTesting();
});

test('ORVIX-HIGH-01: InMemoryRedisMock.eval supports WebSocket acquire, release, refresh Lua contracts alongside fixed-window rate limiting', async () => {
  const mock = new InMemoryRedisMock();
  await mock.connect();
  assert.equal(mock.status, 'ready');

  try {
    const slotKey = 'orvix:rl:wsslots:uid:test-user-slots';
    const otherUserSlotKey = 'orvix:rl:wsslots:uid:other-user-slots';
    const rateKey = 'orvix:rl:chat:uid:test-user-rate';
    const t0 = 1_750_000_000_000;
    const ttlMs = 60_000;
    const maxSlots = 3;

    // 1. Acquire slots 1, 2, and 3 -> returns [1, currentCount]
    const acq1 = await mock.eval(ATOMIC_WS_SLOT_ACQUIRE_LUA, 1, slotKey, String(t0), String(ttlMs), String(maxSlots), 'conn-1');
    assert.deepEqual(acq1, [1, 1]);

    // Duplicate acquisition for same member ('conn-1') renews score without inflating slot count
    const acq1Dup = await mock.eval(ATOMIC_WS_SLOT_ACQUIRE_LUA, 1, slotKey, String(t0 + 5), String(ttlMs), String(maxSlots), 'conn-1');
    assert.deepEqual(acq1Dup, [1, 1]);

    // Invalid empty member is rejected without corrupting state
    const acqInvalid = await mock.eval(ATOMIC_WS_SLOT_ACQUIRE_LUA, 1, slotKey, String(t0 + 5), String(ttlMs), String(maxSlots), '   ');
    assert.deepEqual(acqInvalid, [0, 1]);

    const acq2 = await mock.eval(ATOMIC_WS_SLOT_ACQUIRE_LUA, 1, slotKey, String(t0 + 10), String(ttlMs), String(maxSlots), 'conn-2');
    assert.deepEqual(acq2, [1, 2]);

    const acq3 = await mock.eval(ATOMIC_WS_SLOT_ACQUIRE_LUA, 1, slotKey, String(t0 + 20), String(ttlMs), String(maxSlots), 'conn-3');
    assert.deepEqual(acq3, [1, 3]);

    // 2. 4th slot exceeds maxSlots (3) -> rejected with [0, 3]
    const acq4Rejected = await mock.eval(ATOMIC_WS_SLOT_ACQUIRE_LUA, 1, slotKey, String(t0 + 30), String(ttlMs), String(maxSlots), 'conn-4');
    assert.deepEqual(acq4Rejected, [0, 3]);

    // Multiple independent users/keys do not interfere with each other
    const otherUserAcq = await mock.eval(ATOMIC_WS_SLOT_ACQUIRE_LUA, 1, otherUserSlotKey, String(t0 + 30), String(ttlMs), String(maxSlots), 'other-conn-1');
    assert.deepEqual(otherUserAcq, [1, 1]);

    // 3. Release 'conn-2' -> decrements ZCARD from 3 to 2 (never increments or corrupts other users!)
    const relConn2 = await mock.eval(ATOMIC_WS_SLOT_RELEASE_LUA, 1, slotKey, 'conn-2');
    assert.equal(relConn2, 2);

    // Repeated release of 'conn-2' or releasing a missing member is idempotent and keeps count at 2
    const relConn2Repeat = await mock.eval(ATOMIC_WS_SLOT_RELEASE_LUA, 1, slotKey, 'conn-2');
    assert.equal(relConn2Repeat, 2);
    const relMissingMember = await mock.eval(ATOMIC_WS_SLOT_RELEASE_LUA, 1, slotKey, 'conn-nonexistent');
    assert.equal(relMissingMember, 2);
    const relMissingKey = await mock.eval(ATOMIC_WS_SLOT_RELEASE_LUA, 1, 'orvix:rl:wsslots:uid:missing-key', 'conn-1');
    assert.equal(relMissingKey, 0);

    // Releasing on slotKey did not affect otherUserSlotKey
    const otherUserRefresh = await mock.eval(ATOMIC_WS_SLOT_REFRESH_LUA, 1, otherUserSlotKey, String(t0 + 35), String(ttlMs), 'other-conn-1');
    assert.equal(otherUserRefresh, 1);

    // Now 'conn-4' can acquire the freed 3rd slot
    const acq4Success = await mock.eval(ATOMIC_WS_SLOT_ACQUIRE_LUA, 1, slotKey, String(t0 + 50), String(ttlMs), String(maxSlots), 'conn-4');
    assert.deepEqual(acq4Success, [1, 3]);

    // 4. Refresh TTL for 'conn-1' at t0 + 40_000 -> returns 1 and extends conn-1 expiry to t0 + 100_000
    const refreshConn1 = await mock.eval(ATOMIC_WS_SLOT_REFRESH_LUA, 1, slotKey, String(t0 + 40_000), String(ttlMs), 'conn-1');
    assert.equal(refreshConn1, 1);

    // Refreshing a removed/missing member returns 0
    const refreshMissing = await mock.eval(ATOMIC_WS_SLOT_REFRESH_LUA, 1, slotKey, String(t0 + 40_000), String(ttlMs), 'conn-2');
    assert.equal(refreshMissing, 0);

    // 5. Advance time to t0 + 70_000:
    // 'conn-3' (expires t0 + 60_020) and 'conn-4' (expires t0 + 60_050) have expired,
    // while 'conn-1' (refreshed at t0 + 40_000, expires t0 + 100_000) remains active!
    const acqAfterPartialExpiry = await mock.eval(
      ATOMIC_WS_SLOT_ACQUIRE_LUA,
      1,
      slotKey,
      String(t0 + 70_000),
      String(ttlMs),
      String(maxSlots),
      'conn-5'
    );
    // Pruned conn-3 and conn-4 (leaving conn-1 = 1), then added conn-5 -> count is 2!
    assert.deepEqual(acqAfterPartialExpiry, [1, 2]);

    // Refreshing an expired member after full key expiration returns 0
    const refreshAfterFullExpiry = await mock.eval(
      ATOMIC_WS_SLOT_REFRESH_LUA,
      1,
      slotKey,
      String(t0 + 200_000),
      String(ttlMs),
      'conn-1'
    );
    assert.equal(refreshAfterFullExpiry, 0);

    // 6. Concurrent acquire/release burst via Promise.all
    const concurrentKey = 'orvix:rl:wsslots:uid:concurrent-burst-user';
    const concurrentNow = Date.now();
    const burstResults = (await Promise.all(
      Array.from({ length: 8 }, (_, idx) =>
        mock.eval(
          ATOMIC_WS_SLOT_ACQUIRE_LUA,
          1,
          concurrentKey,
          String(concurrentNow),
          String(ttlMs),
          '3',
          `burst-conn-${idx + 1}`
        )
      )
    )) as [number, number][];
    const acquiredBurstCount = burstResults.filter((r) => r[0] === 1).length;
    const rejectedBurstCount = burstResults.filter((r) => r[0] === 0).length;
    assert.equal(acquiredBurstCount, 3);
    assert.equal(rejectedBurstCount, 5);

    await Promise.all(
      Array.from({ length: 8 }, (_, idx) =>
        mock.eval(ATOMIC_WS_SLOT_RELEASE_LUA, 1, concurrentKey, `burst-conn-${idx + 1}`)
      )
    );
    const countAfterConcurrentRelease = await mock.eval(ATOMIC_WS_SLOT_RELEASE_LUA, 1, concurrentKey, 'burst-conn-1');
    assert.equal(countAfterConcurrentRelease, 0);

    // 7. Wall-clock TTL expiration check
    const shortTtlKey = 'orvix:rl:wsslots:uid:short-ttl-user';
    const wallT0 = Date.now();
    const shortAcq = await mock.eval(ATOMIC_WS_SLOT_ACQUIRE_LUA, 1, shortTtlKey, String(wallT0), '35', '1', 'short-conn-1');
    assert.deepEqual(shortAcq, [1, 1]);
    await new Promise((r) => setTimeout(r, 55));
    const refreshAfterWallExpiry = await mock.eval(ATOMIC_WS_SLOT_REFRESH_LUA, 1, shortTtlKey, String(Date.now()), '35', 'short-conn-1');
    assert.equal(refreshAfterWallExpiry, 0);

    // 8. Existing fixed-window rate limiting on the same mock instance remains completely intact
    const rl1 = (await mock.eval(ATOMIC_RATE_LIMIT_LUA, 1, rateKey, '10000')) as [number, number];
    const rl2 = (await mock.eval(ATOMIC_RATE_LIMIT_LUA, 1, rateKey, '10000')) as [number, number];
    assert.equal(rl1[0], 1);
    assert.equal(rl2[0], 2);
    assert.ok(rl1[1] > 0 && rl1[1] <= 10_000);
  } finally {
    mock.clearAllForTesting();
    await mock.quit();
  }
});

test('ORVIX-HIGH-01: voiceWebSocketSubsystem slot helpers and REDIS_URL selection with real ioredis + fallback', async () => {
  const savedRedisUrl = process.env.REDIS_URL;
  const savedOrvixRedisUrl = process.env.ORVIX_REDIS_URL;
  const savedConnectTimeout = process.env.REDIS_CONNECT_TIMEOUT_MS;

  try {
    await resetRedisClientForTesting();

    // 1. Test voiceWebSocketSubsystem slot lifecycle using InMemoryRedisMock
    const mock = new InMemoryRedisMock();
    await mock.connect();
    setRedisClientForTesting(mock);

    const s1 = await tryAcquireDistributedWsSlot('uid', 'user-ws-1', 2, 'sock-1');
    const s2 = await tryAcquireDistributedWsSlot('uid', 'user-ws-1', 2, 'sock-2');
    const s3 = await tryAcquireDistributedWsSlot('uid', 'user-ws-1', 2, 'sock-3');

    assert.equal(s1.status, 'acquired');
    assert.ok(s1.redisKey);
    assert.equal(s2.status, 'acquired');
    assert.equal(s3.status, 'limit-exceeded');
    assert.equal(s3.redisKey, null);

    // Refresh sock-1 and release sock-2
    refreshDistributedWsSlot(s1.redisKey, 'sock-1');
    releaseDistributedWsSlot(s2.redisKey, 'sock-2');
    await new Promise((r) => setTimeout(r, 20));

    // After releasing sock-2, sock-3 can now acquire the slot!
    const s3Retry = await tryAcquireDistributedWsSlot('uid', 'user-ws-1', 2, 'sock-3');
    assert.equal(s3Retry.status, 'acquired');

    await resetRedisClientForTesting();

    // 2. Verify real ioredis selection when REDIS_URL is configured against a live local RESP TCP server
    const respCommands: string[] = [];
    const activeSockets = new Set<net.Socket>();
    const respServer = net.createServer((socket) => {
      activeSockets.add(socket);
      socket.on('close', () => activeSockets.delete(socket));
      socket.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        // Split pipelined RESP arrays (*<count>\r\n...)
        const frames = text.split(/(?=\*\d+\r\n)/).filter((f) => f.trim().length > 0);
        for (const frame of frames) {
          const lines = frame.split('\r\n');
          const cmd = (lines[2] || '').toUpperCase();
          if (cmd) {
            respCommands.push(cmd);
          }
          if (cmd === 'HELLO') {
            socket.write("-ERR unknown command 'hello'\r\n");
          } else if (cmd === 'INFO') {
            const infoPayload = 'redis_version:7.2.0\r\nrole:master\r\n';
            socket.write(`$${infoPayload.length}\r\n${infoPayload}\r\n`);
          } else if (cmd === 'EVAL') {
            // Return [1, 1] array in RESP protocol: *2\r\n:1\r\n:1\r\n
            socket.write('*2\r\n:1\r\n:1\r\n');
          } else if (cmd === 'QUIT') {
            socket.write('+OK\r\n');
            socket.end();
          } else {
            socket.write('+OK\r\n');
          }
        }
      });
    });

    await new Promise<void>((resolve) => respServer.listen(0, '127.0.0.1', () => resolve()));
    const respPort = (respServer.address() as AddressInfo).port;

    try {
      process.env.REDIS_URL = `redis://127.0.0.1:${respPort}`;
      process.env.REDIS_CONNECT_TIMEOUT_MS = '500';
      await resetRedisClientForTesting();

      const client = getRedisClient() as ManagedRedisClient;
      assert.ok(client instanceof ManagedRedisClient);
      assert.equal(client.isRealRedis, true);
      assert.ok(client.getUnderlyingClient() instanceof Redis);

      const ready = await ensureRedisReady(client, 500);
      assert.equal(ready, true);
      assert.equal(client.isRealRedis, true);
      assert.equal(client.isFallbackMock, false);

      const evalRes = await client.eval(ATOMIC_WS_SLOT_ACQUIRE_LUA, 1, 'test:key', '1000', '60000', '3', 'm1');
      assert.deepEqual(evalRes, [1, 1]);
      assert.ok(respCommands.includes('EVAL'));
    } finally {
      await resetRedisClientForTesting();
      for (const s of activeSockets) {
        s.destroy();
      }
      await new Promise<void>((resolve) => respServer.close(() => resolve()));
    }

    // 3. Verify graceful fallback to InMemoryRedisMock when REDIS_URL points to an unreachable port
    const closedServer = net.createServer();
    await new Promise<void>((resolve) => closedServer.listen(0, '127.0.0.1', () => resolve()));
    const unusedPort = (closedServer.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closedServer.close(() => resolve()));

    process.env.REDIS_URL = `redis://127.0.0.1:${unusedPort}`;
    process.env.REDIS_CONNECT_TIMEOUT_MS = '250';
    await resetRedisClientForTesting();

    const fallbackClient = getRedisClient() as ManagedRedisClient;
    assert.ok(fallbackClient instanceof ManagedRedisClient);

    const readyAfterFallback = await ensureRedisReady(fallbackClient, 500);
    assert.equal(readyAfterFallback, true);
    assert.equal(fallbackClient.isFallbackMock, true);
    assert.equal(fallbackClient.status, 'ready');

    // WebSocket slot acquisition works seamlessly on the activated fallback mock
    const fbSlot1 = await tryAcquireDistributedWsSlot('ip', '203.0.113.88', 2, 'fb-1');
    const fbSlot2 = await tryAcquireDistributedWsSlot('ip', '203.0.113.88', 2, 'fb-2');
    const fbSlot3 = await tryAcquireDistributedWsSlot('ip', '203.0.113.88', 2, 'fb-3');
    assert.equal(fbSlot1.status, 'acquired');
    assert.equal(fbSlot2.status, 'acquired');
    assert.equal(fbSlot3.status, 'limit-exceeded');
  } finally {
    if (savedRedisUrl === undefined) {
      delete process.env.REDIS_URL;
    } else {
      process.env.REDIS_URL = savedRedisUrl;
    }
    if (savedOrvixRedisUrl === undefined) {
      delete process.env.ORVIX_REDIS_URL;
    } else {
      process.env.ORVIX_REDIS_URL = savedOrvixRedisUrl;
    }
    if (savedConnectTimeout === undefined) {
      delete process.env.REDIS_CONNECT_TIMEOUT_MS;
    } else {
      process.env.REDIS_CONNECT_TIMEOUT_MS = savedConnectTimeout;
    }
    await resetRedisClientForTesting();
  }
});

