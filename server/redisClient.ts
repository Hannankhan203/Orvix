import EventEmitter from 'events';
import { Redis, type RedisOptions as IoRedisOptions } from 'ioredis';
import { isConfiguredCredential, resolveEnvCredential } from './serverConfig.ts';
import { sanitizeErrorLog } from './diagnosticLogger.ts';

// Shared in-memory store for fallback / mock rate-limit counters
const store = new Map<string, any>();
export const redis = {
  get: async (k: string) => store.get(k) ?? null,
  set: async (k: string, v: any) => {
    store.set(k, v);
    return 'OK';
  },
  del: async (k: string) => store.delete(k),
  incr: async (k: string) => {
    const n = (Number(store.get(k)) || 0) + 1;
    store.set(k, n);
    return n;
  }
};

export interface RedisOptions {
  lazyConnect?: boolean;
  enableOfflineQueue?: boolean;
  maxRetriesPerRequest?: number;
  connectTimeout?: number;
  commandTimeout?: number;
  enableReadyCheck?: boolean;
  retryStrategy?: (times: number) => number | null;
  tls?: { rejectUnauthorized?: boolean };
}

/**
 * In-memory Redis mock supporting both fixed-window rate-limiting Lua scripts
 * (`ATOMIC_RATE_LIMIT_LUA`) and WebSocket ZSET connection-slot Lua scripts
 * (`ATOMIC_WS_SLOT_ACQUIRE_LUA`, `ATOMIC_WS_SLOT_RELEASE_LUA`, `ATOMIC_WS_SLOT_REFRESH_LUA`).
 */
export class InMemoryRedisMock extends EventEmitter implements RedisLikeClient {
  public status: string = 'wait';
  public readonly isMock = true;
  private expirations = new Map<string, { wallExpiresAt: number; logicalExpiresAt: number }>();
  private zsets = new Map<string, Map<string, number>>();

  constructor(_url = 'redis://in-memory-mock', _options?: RedisOptions) {
    super();
  }

  async connect(): Promise<void> {
    this.status = 'ready';
    this.emit('ready');
  }

  private setKeyExpiration(key: string, ttlMs: number, logicalNowMs?: number): void {
    const wallNow = Date.now();
    const logicalNow = logicalNowMs !== undefined && Number.isFinite(logicalNowMs) ? logicalNowMs : wallNow;
    this.expirations.set(key, {
      wallExpiresAt: wallNow + ttlMs,
      logicalExpiresAt: logicalNow + ttlMs
    });
  }

  private expireKeyIfNeeded(key: string, logicalNowMs?: number): boolean {
    const exp = this.expirations.get(key);
    if (!exp) return false;
    const isExpired =
      logicalNowMs !== undefined && Number.isFinite(logicalNowMs)
        ? logicalNowMs >= exp.logicalExpiresAt
        : Date.now() >= exp.wallExpiresAt;
    if (isExpired) {
      store.delete(key);
      this.zsets.delete(key);
      this.expirations.delete(key);
      return true;
    }
    return false;
  }

  async eval(script: unknown, _numKeys: unknown, ...args: unknown[]): Promise<unknown> {
    if (this.status !== 'ready') {
      throw new Error(`Redis mock is not ready (status=${this.status})`);
    }

    const scriptStr = typeof script === 'string' ? script : '';
    const key = String(args[0] ?? '');

    // 1. WebSocket Slot Acquire (ZREMRANGEBYSCORE + ZCARD + ZADD + PEXPIRE)
    if (scriptStr.includes('ZREMRANGEBYSCORE') && scriptStr.includes('ZADD')) {
      const parsedNow = Number(args[1]);
      const nowMs = Number.isFinite(parsedNow) ? parsedNow : Date.now();
      const parsedTtl = Number(args[2]);
      const ttlMs = Number.isFinite(parsedTtl) && parsedTtl > 0 ? parsedTtl : 60_000;
      const parsedMax = Number(args[3]);
      const maxSlots = Number.isFinite(parsedMax) ? Math.max(0, Math.floor(parsedMax)) : 0;
      const member = String(args[4] ?? '').trim();

      this.expireKeyIfNeeded(key, nowMs);

      let zset = this.zsets.get(key);
      if (zset) {
        for (const [existingMember, score] of zset.entries()) {
          if (score <= nowMs) {
            zset.delete(existingMember);
          }
        }
        if (zset.size === 0) {
          this.zsets.delete(key);
          this.expirations.delete(key);
          zset = undefined;
        }
      }

      const current = zset ? zset.size : 0;
      if (!key || !member || maxSlots <= 0) {
        return [0, current];
      }

      // If this exact member does not already hold an active slot and we are at capacity, reject
      const alreadyPresent = Boolean(zset && zset.has(member));
      if (!alreadyPresent && current >= maxSlots) {
        return [0, current];
      }

      if (!zset) {
        zset = new Map<string, number>();
        this.zsets.set(key, zset);
      }

      zset.set(member, nowMs + ttlMs);
      this.setKeyExpiration(key, ttlMs, nowMs);
      return [1, zset.size];
    }

    // 2. WebSocket Slot Release (ZREM + ZCARD)
    if (scriptStr.includes('ZREM') && !scriptStr.includes('ZREMRANGEBYSCORE')) {
      const member = String(args[1] ?? '');

      this.expireKeyIfNeeded(key);

      const zset = this.zsets.get(key);
      if (!zset) {
        return 0;
      }

      zset.delete(member);
      if (zset.size === 0) {
        this.zsets.delete(key);
        this.expirations.delete(key);
        return 0;
      }

      return zset.size;
    }

    // 3. WebSocket Slot Refresh (ZSCORE + ZADD + PEXPIRE)
    if (scriptStr.includes('ZSCORE')) {
      const parsedNow = Number(args[1]);
      const nowMs = Number.isFinite(parsedNow) ? parsedNow : Date.now();
      const parsedTtl = Number(args[2]);
      const ttlMs = Number.isFinite(parsedTtl) && parsedTtl > 0 ? parsedTtl : 60_000;
      const member = String(args[3] ?? '');

      this.expireKeyIfNeeded(key, nowMs);

      const zset = this.zsets.get(key);
      if (!zset || !zset.has(member)) {
        return 0;
      }

      const memberScore = zset.get(member)!;
      if (memberScore <= nowMs) {
        zset.delete(member);
        if (zset.size === 0) {
          this.zsets.delete(key);
          this.expirations.delete(key);
        }
        return 0;
      }

      zset.set(member, nowMs + ttlMs);
      this.setKeyExpiration(key, ttlMs, nowMs);
      return 1;
    }

    // 4. Default / Fixed-Window Rate Limit (ATOMIC_RATE_LIMIT_LUA: INCR + PEXPIRE + PTTL)
    const windowMs = Number(args[1]) || 60_000;
    const now = Date.now();
    this.expireKeyIfNeeded(key);

    const count = await redis.incr(key);
    let currentExp = this.expirations.get(key);
    if (!currentExp || now >= currentExp.wallExpiresAt) {
      this.setKeyExpiration(key, windowMs, now);
      currentExp = this.expirations.get(key)!;
    }
    const pttl = Math.max(1, currentExp.wallExpiresAt - now);
    return [count, pttl];
  }

  clearAllForTesting(): void {
    store.clear();
    this.expirations.clear();
    this.zsets.clear();
  }

  async quit(): Promise<string> {
    this.status = 'end';
    this.emit('end');
    return 'OK';
  }

  disconnect(): void {
    this.status = 'end';
    this.emit('end');
  }
}

export interface RedisLikeClient {
  status: string;
  eval(...args: unknown[]): Promise<unknown>;
  on?(event: string, listener: (...args: any[]) => void): unknown;
  once?(event: string, listener: (...args: any[]) => void): unknown;
  removeListener?(event: string, listener: (...args: any[]) => void): unknown;
  off?(event: string, listener: (...args: any[]) => void): unknown;
  connect?(): Promise<unknown>;
  quit?(): Promise<unknown>;
  disconnect?(): void;
}

export interface RedisHealthStatus {
  configured: boolean;
  connected: boolean;
  status: string;
}

function shouldAllowInMemoryRedisFallback(): boolean {
  const explicitMock = String(process.env.REDIS_USE_MOCK || '').trim().toLowerCase();
  if (explicitMock === 'true' || explicitMock === '1') {
    return true;
  }
  const explicitDisable = String(process.env.REDIS_FALLBACK_TO_MOCK || '').trim().toLowerCase();
  if (explicitDisable === 'false' || explicitDisable === '0') {
    return false;
  }
  const requireDistributed = String(process.env.RATE_LIMIT_REQUIRE_DISTRIBUTED || '').trim().toLowerCase();
  if (requireDistributed === 'true' || requireDistributed === '1') {
    return false;
  }
  const failureMode = String(process.env.RATE_LIMIT_FAILURE_MODE || '').trim().toLowerCase();
  if (failureMode === 'fail-closed') {
    return false;
  }
  return true;
}

/**
 * Managed Redis client that connects using a real `ioredis` instance when `REDIS_URL`
 * is configured, and gracefully falls back to `InMemoryRedisMock` when the Redis
 * server is unreachable (unless strict fail-closed mode is configured).
 */
export class ManagedRedisClient extends EventEmitter implements RedisLikeClient {
  private realClient: Redis | null = null;
  private fallbackMock: InMemoryRedisMock | null = null;
  private usingFallback = false;
  private readonly url: string;
  private readonly options: RedisOptions;

  constructor(url: string, options: RedisOptions) {
    super();
    this.url = url;
    this.options = options;

    const forceMock =
      String(process.env.REDIS_USE_MOCK || '').trim().toLowerCase() === 'true' ||
      url.toLowerCase().startsWith('redis://in-memory-mock');

    if (forceMock) {
      this.activateFallbackMock();
    } else {
      this.initRealClient();
    }
  }

  private initRealClient(): void {
    const ioOptions: IoRedisOptions = {
      lazyConnect: this.options.lazyConnect ?? true,
      enableOfflineQueue: this.options.enableOfflineQueue ?? false,
      maxRetriesPerRequest: this.options.maxRetriesPerRequest ?? 1,
      connectTimeout: this.options.connectTimeout,
      commandTimeout: this.options.commandTimeout,
      enableReadyCheck: this.options.enableReadyCheck ?? true,
      retryStrategy: this.options.retryStrategy,
      tls: this.options.tls
    };

    const real = new Redis(this.url, ioOptions);
    this.realClient = real;

    real.on('ready', () => {
      this.usingFallback = false;
      this.emit('ready');
    });

    real.on('error', (err: Error) => {
      const canFallback = real.status !== 'ready' && shouldAllowInMemoryRedisFallback() && !isShuttingDown;
      if (canFallback) {
        this.prepareFallbackMock();
      }
      this.emit('error', err);
      if (canFallback) {
        this.emit('ready');
      }
    });

    real.on('close', () => {
      if (!this.usingFallback) {
        if (shouldAllowInMemoryRedisFallback() && !isShuttingDown) {
          this.activateFallbackMock();
        } else {
          this.emit('close');
        }
      }
    });

    real.on('end', () => {
      if (!this.usingFallback) {
        if (shouldAllowInMemoryRedisFallback() && !isShuttingDown) {
          this.activateFallbackMock();
        } else {
          this.emit('end');
        }
      }
    });
  }

  private prepareFallbackMock(): boolean {
    if (this.usingFallback && this.fallbackMock) {
      return false;
    }
    this.usingFallback = true;

    if (this.realClient) {
      const oldReal = this.realClient;
      this.realClient = null;
      try {
        oldReal.removeAllListeners();
        oldReal.on('error', () => {});
        oldReal.disconnect();
      } catch (_) {}
    }

    const mock = new InMemoryRedisMock(this.url, this.options);
    this.fallbackMock = mock;
    mock.status = 'ready';
    return true;
  }

  private activateFallbackMock(): void {
    if (this.prepareFallbackMock()) {
      this.emit('ready');
    }
  }

  get status(): string {
    if (this.usingFallback && this.fallbackMock) {
      return this.fallbackMock.status;
    }
    return this.realClient ? String(this.realClient.status) : 'end';
  }

  get isRealRedis(): boolean {
    return !this.usingFallback && this.realClient !== null;
  }

  get isFallbackMock(): boolean {
    return this.usingFallback && this.fallbackMock !== null;
  }

  getUnderlyingClient(): Redis | InMemoryRedisMock | null {
    return this.usingFallback ? this.fallbackMock : this.realClient;
  }

  async connect(): Promise<void> {
    if (this.usingFallback && this.fallbackMock) {
      await this.fallbackMock.connect();
      return;
    }
    if (!this.realClient) {
      if (shouldAllowInMemoryRedisFallback()) {
        this.activateFallbackMock();
        return;
      }
      throw new Error('Redis client is not initialized');
    }
    try {
      await this.realClient.connect();
    } catch (err) {
      if (shouldAllowInMemoryRedisFallback() && !isShuttingDown) {
        this.activateFallbackMock();
        return;
      }
      throw err;
    }
  }

  async eval(script: unknown, numKeys: unknown, ...args: unknown[]): Promise<unknown> {
    if (this.usingFallback && this.fallbackMock) {
      return await this.fallbackMock.eval(script, numKeys, ...args);
    }
    if (this.realClient && this.realClient.status === 'ready') {
      try {
        return await (this.realClient as any).eval(script, numKeys, ...args);
      } catch (err) {
        if (shouldAllowInMemoryRedisFallback() && !isShuttingDown) {
          this.activateFallbackMock();
          return await this.fallbackMock!.eval(script, numKeys, ...args);
        }
        throw err;
      }
    }
    if (shouldAllowInMemoryRedisFallback() && !isShuttingDown) {
      this.activateFallbackMock();
      return await this.fallbackMock!.eval(script, numKeys, ...args);
    }
    throw new Error(`Redis client is not ready (status=${this.status})`);
  }

  async quit(): Promise<string> {
    if (this.realClient) {
      const real = this.realClient;
      this.realClient = null;
      try {
        await real.quit();
      } catch (_) {
        try {
          real.disconnect();
        } catch (_) {}
      }
    }
    if (this.fallbackMock) {
      await this.fallbackMock.quit();
    }
    this.emit('end');
    return 'OK';
  }

  disconnect(): void {
    if (this.realClient) {
      const real = this.realClient;
      this.realClient = null;
      try {
        real.disconnect();
      } catch (_) {}
    }
    if (this.fallbackMock) {
      this.fallbackMock.disconnect();
    }
    this.emit('end');
  }
}

const DEFAULT_CONNECT_TIMEOUT_MS = 3000;
const DEFAULT_COMMAND_TIMEOUT_MS = 1500;
const ERROR_LOG_THROTTLE_MS = 30_000;

let singletonClient: ManagedRedisClient | null = null;
let initializedForUrl: string | null = null;
let testClientOverride: RedisLikeClient | null = null;
let isShuttingDown = false;
let lastErrorLogMs = 0;
let lastLoggedStatus: string | null = null;

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  if (Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  return fallback;
}

export function getRedisConnectTimeoutMs(): number {
  return parsePositiveIntEnv('REDIS_CONNECT_TIMEOUT_MS', DEFAULT_CONNECT_TIMEOUT_MS);
}

export function getRedisCommandTimeoutMs(): number {
  return parsePositiveIntEnv('REDIS_COMMAND_TIMEOUT_MS', DEFAULT_COMMAND_TIMEOUT_MS);
}

/**
 * Resolves the optional REDIS_URL connection string from environment configuration.
 * Returns an empty string if unconfigured or set to a placeholder literal.
 */
export function getConfiguredRedisUrl(): string {
  const rawUrl = resolveEnvCredential('REDIS_URL', 'ORVIX_REDIS_URL');
  if (!isConfiguredCredential(rawUrl)) {
    return '';
  }

  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
      console.warn(
        `[Redis] Ignoring REDIS_URL with unsupported protocol '${parsed.protocol}'. Expected 'redis://' or 'rediss://'.`
      );
      return '';
    }
    return rawUrl;
  } catch (_) {
    console.warn('[Redis] Ignoring malformed REDIS_URL environment variable.');
    return '';
  }
}

export function isRedisConfigured(): boolean {
  if (testClientOverride) {
    return true;
  }
  return Boolean(getConfiguredRedisUrl());
}

function logRedisWarningThrottled(message: string): void {
  const now = Date.now();
  if (now - lastErrorLogMs >= ERROR_LOG_THROTTLE_MS) {
    lastErrorLogMs = now;
    console.warn(message);
  }
}

export function buildRedisOptions(redisUrl: string): RedisOptions {
  const connectTimeout = getRedisConnectTimeoutMs();
  const commandTimeout = getRedisCommandTimeoutMs();
  const useTls = redisUrl.toLowerCase().startsWith('rediss://');

  const options: RedisOptions = {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout,
    commandTimeout,
    enableReadyCheck: true,
    retryStrategy(times: number) {
      if (isShuttingDown || shouldAllowInMemoryRedisFallback()) {
        return null;
      }
      const baseDelay = Math.min(500 * Math.pow(2, Math.min(times - 1, 5)), 15_000);
      const jitter = Math.floor(Math.random() * 250);
      return baseDelay + jitter;
    }
  };

  if (useTls) {
    options.tls = {
      rejectUnauthorized: process.env.REDIS_TLS_REJECT_UNAUTHORIZED !== 'false'
    };
  }

  return options;
}

function attachRedisLifecycleListeners(client: ManagedRedisClient): void {
  client.on('ready', () => {
    if (lastLoggedStatus !== 'ready') {
      lastLoggedStatus = 'ready';
      if (client.isFallbackMock) {
        logRedisWarningThrottled(
          '[Redis] Using in-memory Redis fallback mock for rate limiting and WebSocket slots.'
        );
      } else {
        console.log('[Redis] Connected and ready for distributed rate limiting.');
      }
    }
  });

  client.on('error', (err: Error) => {
    const safeMsg = sanitizeErrorLog(err?.message || String(err));
    logRedisWarningThrottled(
      `[Redis] Connection error (${safeMsg}). Shared distributed rate-limit store unavailable.`
    );
  });

  client.on('close', () => {
    if (!isShuttingDown && lastLoggedStatus === 'ready') {
      lastLoggedStatus = 'closed';
      logRedisWarningThrottled(
        '[Redis] Connection closed. Shared distributed rate-limit store temporarily unavailable until reconnected.'
      );
    }
  });

  client.on('end', () => {
    if (lastLoggedStatus !== 'end') {
      lastLoggedStatus = 'end';
    }
  });
}

/**
 * Returns the active Redis client (or test override).
 * Returns null immediately when REDIS_URL is unconfigured so local development
 * never attempts network connections or emits errors.
 */
export function getRedisClient(): RedisLikeClient | null {
  if (testClientOverride) {
    return testClientOverride;
  }

  if (isShuttingDown) {
    return null;
  }

  const redisUrl = getConfiguredRedisUrl();
  if (!redisUrl) {
    return null;
  }

  if (!singletonClient || initializedForUrl !== redisUrl) {
    if (singletonClient) {
      try {
        singletonClient.disconnect();
      } catch (_) {}
      singletonClient = null;
    }

    const client = new ManagedRedisClient(redisUrl, buildRedisOptions(redisUrl));
    attachRedisLifecycleListeners(client);
    singletonClient = client;
    initializedForUrl = redisUrl;

    // Trigger non-blocking background connection; errors are handled by 'error' listener / fallback
    client.connect().catch(() => {});
  }

  return singletonClient;
}

/**
 * Returns true only when Redis is configured and currently in the 'ready' state.
 */
export function isRedisReady(): boolean {
  const client = getRedisClient();
  return Boolean(client && client.status === 'ready');
}

const REDIS_CONNECTING_STATUSES = new Set(['wait', 'connecting', 'connect']);

/**
 * Awaits Redis readiness on cold starts while actively connecting (`wait` / `connecting` / `connect`),
 * bounded by `timeoutMs`. Fails fast when disconnected/reconnecting/ended so requests do not stall.
 */
export async function ensureRedisReady(
  client: RedisLikeClient | null = getRedisClient(),
  timeoutMs = Math.min(getRedisConnectTimeoutMs(), 1000)
): Promise<boolean> {
  if (!client) return false;
  if (client.status === 'ready') return true;
  if (!REDIS_CONNECTING_STATUSES.has(client.status)) return false;
  if (typeof client.once !== 'function') return false;

  const waitMs = Math.max(1, Math.floor(timeoutMs));
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const detach = (event: string, fn: (...args: unknown[]) => void) => {
      if (typeof client.off === 'function') {
        client.off(event, fn);
      } else if (typeof client.removeListener === 'function') {
        client.removeListener(event, fn);
      }
    };

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      detach('ready', onReady);
      detach('error', onFail);
      detach('close', onFail);
      detach('end', onFail);
    };

    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(ready);
    };

    const onReady = () => finish(true);
    const onFail = () => {
      // If ManagedRedisClient activated its fallback mock on error/close, status is now 'ready'
      finish(client.status === 'ready');
    };

    client.once!('ready', onReady);
    client.once!('error', onFail);
    client.once!('close', onFail);
    client.once!('end', onFail);

    timer = setTimeout(() => finish(client.status === 'ready'), waitMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }

    if (client.status === 'ready') {
      finish(true);
    }
  });
}

/**
 * Returns sanitized Redis connection status without exposing credentials or URLs.
 */
export function getRedisHealthStatus(): RedisHealthStatus {
  if (testClientOverride) {
    const status = String(testClientOverride.status || 'unknown');
    return {
      configured: true,
      connected: status === 'ready',
      status
    };
  }

  const configured = Boolean(getConfiguredRedisUrl());
  if (!configured) {
    return {
      configured: false,
      connected: false,
      status: 'unconfigured'
    };
  }

  const client = singletonClient;
  const status = client ? String(client.status) : 'idle';
  return {
    configured: true,
    connected: status === 'ready',
    status
  };
}

/**
 * Gracefully shuts down the singleton Redis connection on server termination.
 */
export async function closeRedisClient(): Promise<void> {
  isShuttingDown = true;

  if (testClientOverride) {
    try {
      if (typeof testClientOverride.quit === 'function') {
        await testClientOverride.quit();
      } else if (typeof testClientOverride.disconnect === 'function') {
        testClientOverride.disconnect();
      }
    } catch (_) {
      try {
        testClientOverride.disconnect?.();
      } catch (_) {}
    }
    return;
  }

  const client = singletonClient;
  singletonClient = null;
  initializedForUrl = null;
  lastLoggedStatus = null;

  if (!client) {
    return;
  }

  try {
    await Promise.race([
      client.quit(),
      new Promise<void>((resolve) => setTimeout(resolve, 2000))
    ]);
  } catch (_) {
    // Ignore quit errors during shutdown
  } finally {
    try {
      client.disconnect();
    } catch (_) {}
  }
}

/**
 * Test helper: injects a mock or custom Redis client.
 */
export function setRedisClientForTesting(client: RedisLikeClient | null): void {
  testClientOverride = client;
  isShuttingDown = false;
}

/**
 * Test helper: resets singleton and test override state.
 */
export async function resetRedisClientForTesting(): Promise<void> {
  testClientOverride = null;
  lastErrorLogMs = 0;
  lastLoggedStatus = null;
  store.clear();
  await closeRedisClient();
  isShuttingDown = false;
}