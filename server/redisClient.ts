import { Redis, type RedisOptions } from 'ioredis';
import { isConfiguredCredential, resolveEnvCredential } from './serverConfig.ts';
import { sanitizeErrorLog } from './diagnosticLogger.ts';

export interface RedisLikeClient {
  status: string;
  eval(...args: unknown[]): Promise<unknown>;
  quit?(): Promise<unknown>;
  disconnect?(): void;
}

export interface RedisHealthStatus {
  configured: boolean;
  connected: boolean;
  status: string;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 3000;
const DEFAULT_COMMAND_TIMEOUT_MS = 1500;
const ERROR_LOG_THROTTLE_MS = 30_000;

let singletonClient: Redis | null = null;
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

function buildRedisOptions(redisUrl: string): RedisOptions {
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
      if (isShuttingDown) {
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

function attachRedisLifecycleListeners(client: Redis): void {
  client.on('ready', () => {
    if (lastLoggedStatus !== 'ready') {
      lastLoggedStatus = 'ready';
      console.log('[Redis] Connected and ready for distributed rate limiting.');
    }
  });

  client.on('error', (err: Error) => {
    const safeMsg = sanitizeErrorLog(err?.message || String(err));
    logRedisWarningThrottled(
      `[Redis] Connection error (${safeMsg}). Falling back to in-memory rate limiting.`
    );
  });

  client.on('close', () => {
    if (!isShuttingDown && lastLoggedStatus === 'ready') {
      lastLoggedStatus = 'closed';
      logRedisWarningThrottled(
        '[Redis] Connection closed. Temporarily using in-memory rate limiting until reconnected.'
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

    const client = new Redis(redisUrl, buildRedisOptions(redisUrl));
    attachRedisLifecycleListeners(client);
    singletonClient = client;
    initializedForUrl = redisUrl;

    // Trigger non-blocking background connection; errors are handled by 'error' listener
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
  await closeRedisClient();
  isShuttingDown = false;
}
