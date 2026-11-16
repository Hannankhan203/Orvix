import crypto from 'crypto';
import type express from 'express';
import type { IncomingMessage } from 'http';
import { authenticateRequest } from './firebaseAuthHelper.ts';
import {
  getRedisClient,
  getRedisCommandTimeoutMs,
  type RedisLikeClient
} from './redisClient.ts';
import { sanitizeErrorLog } from './diagnosticLogger.ts';

export type RateLimitPolicyName =
  | 'chat'
  | 'transcribe'
  | 'upload'
  | 'uploadRead'
  | 'config'
  | 'voiceWs';

export type RateLimitHeaderMode = 'all' | 'ietf-only';

export interface RateLimitPolicyConfig {
  policy: RateLimitPolicyName;
  max: number;
  windowMs: number;
  headerMode: RateLimitHeaderMode;
  message?: string;
}

export interface RateLimitConsumeOptions {
  policy: string;
  max: number;
  windowMs: number;
  keyPrefix?: string;
  headerMode?: RateLimitHeaderMode;
  redisClient?: RedisLikeClient | null;
  memoryStore?: InMemoryRateLimitStore;
  nowMs?: number;
  commandTimeoutMs?: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  policy: string;
  limit: number;
  remaining: number;
  count: number;
  resetAtMs: number;
  resetAtIso: string;
  retryAfterSeconds: number;
  backend: 'redis' | 'memory';
  degraded: boolean;
  key: string;
}

export interface RateLimitIdentity {
  type: 'user' | 'ip';
  hashedId: string;
}

interface MemoryRateLimitEntry {
  count: number;
  resetAtMs: number;
}

/**
 * Atomic fixed-window counter Lua script for Redis.
 * Ensures INCR and PEXPIRE execute in a single atomic operation so keys never leak
 * without TTL if a process crashes between commands, and self-heals missing TTLs.
 */
export const ATOMIC_RATE_LIMIT_LUA = `
local key = KEYS[1]
local window_ms = tonumber(ARGV[1])
local current = redis.call('INCR', key)
if current == 1 then
  redis.call('PEXPIRE', key, window_ms)
else
  local ttl = redis.call('PTTL', key)
  if ttl < 0 then
    redis.call('PEXPIRE', key, window_ms)
  end
end
local pttl = redis.call('PTTL', key)
if pttl < 0 then
  pttl = window_ms
end
return { current, pttl }
`;

const DEFAULT_KEY_PREFIX = 'orvix:rl';
const DEFAULT_KEY_SALT = 'orvix-rl-v1';
const MAX_MEMORY_STORE_ENTRIES = 50_000;
const MEMORY_SWEEP_INTERVAL_MS = 60_000;
const FALLBACK_LOG_THROTTLE_MS = 30_000;

let lastFallbackLogMs = 0;

function logFallbackWarningThrottled(message: string): void {
  const now = Date.now();
  if (now - lastFallbackLogMs >= FALLBACK_LOG_THROTTLE_MS) {
    lastFallbackLogMs = now;
    console.warn(message);
  }
}

export class InMemoryRateLimitStore {
  private readonly store = new Map<string, MemoryRateLimitEntry>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(enableAutoSweep = true) {
    if (enableAutoSweep) {
      this.sweepTimer = setInterval(() => {
        this.pruneExpired();
      }, MEMORY_SWEEP_INTERVAL_MS);
      if (typeof this.sweepTimer.unref === 'function') {
        this.sweepTimer.unref();
      }
    }
  }

  consume(
    key: string,
    windowMs: number,
    nowMs = Date.now()
  ): { count: number; ttlMs: number; resetAtMs: number } {
    const existing = this.store.get(key);
    if (!existing || nowMs >= existing.resetAtMs) {
      if (this.store.size >= MAX_MEMORY_STORE_ENTRIES) {
        this.pruneExpired(nowMs);
        if (this.store.size >= MAX_MEMORY_STORE_ENTRIES) {
          const oldestKey = this.store.keys().next().value;
          if (oldestKey !== undefined) {
            this.store.delete(oldestKey);
          }
        }
      }
      const resetAtMs = nowMs + windowMs;
      this.store.set(key, { count: 1, resetAtMs });
      return { count: 1, ttlMs: windowMs, resetAtMs };
    }

    existing.count += 1;
    const ttlMs = Math.max(1, existing.resetAtMs - nowMs);
    return {
      count: existing.count,
      ttlMs,
      resetAtMs: existing.resetAtMs
    };
  }

  pruneExpired(nowMs = Date.now()): number {
    let removed = 0;
    for (const [key, entry] of this.store.entries()) {
      if (nowMs >= entry.resetAtMs) {
        this.store.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  clear(): void {
    this.store.clear();
  }

  size(): number {
    return this.store.size;
  }

  dispose(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.store.clear();
  }
}

const defaultMemoryStore = new InMemoryRateLimitStore(true);

export function getDefaultInMemoryRateLimitStore(): InMemoryRateLimitStore {
  return defaultMemoryStore;
}

export function isRateLimitingEnabled(): boolean {
  const raw = String(process.env.RATE_LIMIT_ENABLED ?? 'true').trim().toLowerCase();
  return raw !== 'false' && raw !== '0' && raw !== 'no' && raw !== 'off' && raw !== 'disabled';
}

function parsePositiveEnvInt(envName: string, fallback: number): number {
  const raw = Number(process.env[envName]);
  if (Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  return fallback;
}

export function getRateLimitKeyPrefix(): string {
  const configured = (process.env.RATE_LIMIT_KEY_PREFIX || '').trim().replace(/:+$/, '');
  return configured || DEFAULT_KEY_PREFIX;
}

/**
 * Resolves rate-limit policy settings with optional environment variable overrides.
 */
export function getRateLimitPolicyConfig(policy: RateLimitPolicyName): RateLimitPolicyConfig {
  switch (policy) {
    case 'chat':
      return {
        policy: 'chat',
        max: parsePositiveEnvInt('RATE_LIMIT_CHAT_MAX', 30),
        windowMs: parsePositiveEnvInt('RATE_LIMIT_CHAT_WINDOW_MS', 60_000),
        headerMode: 'all',
        message: 'Too many AI chat requests. Please wait a moment before sending another message.'
      };
    case 'transcribe':
      return {
        policy: 'transcribe',
        max: parsePositiveEnvInt('RATE_LIMIT_TRANSCRIBE_MAX', 30),
        windowMs: parsePositiveEnvInt('RATE_LIMIT_TRANSCRIBE_WINDOW_MS', 60_000),
        headerMode: 'all',
        message: 'Too many transcription requests. Please wait a moment before trying again.'
      };
    case 'upload':
      return {
        policy: 'upload',
        max: parsePositiveEnvInt('RATE_LIMIT_UPLOAD_MAX', 30),
        windowMs: parsePositiveEnvInt('RATE_LIMIT_UPLOAD_WINDOW_MS', 60_000),
        headerMode: 'ietf-only',
        message: 'Too many attachment upload requests in a short period. Please wait a moment before trying again.'
      };
    case 'uploadRead':
      return {
        policy: 'uploadRead',
        max: parsePositiveEnvInt('RATE_LIMIT_UPLOAD_READ_MAX', 120),
        windowMs: parsePositiveEnvInt('RATE_LIMIT_UPLOAD_READ_WINDOW_MS', 60_000),
        headerMode: 'ietf-only',
        message: 'Too many attachment status requests. Please wait a moment before trying again.'
      };
    case 'config':
      return {
        policy: 'config',
        max: parsePositiveEnvInt('RATE_LIMIT_CONFIG_MAX', 120),
        windowMs: parsePositiveEnvInt('RATE_LIMIT_CONFIG_WINDOW_MS', 60_000),
        headerMode: 'all',
        message: 'Too many configuration requests. Please wait a moment before trying again.'
      };
    case 'voiceWs':
      return {
        policy: 'voiceWs',
        max: parsePositiveEnvInt('RATE_LIMIT_VOICE_WS_MAX', 20),
        windowMs: parsePositiveEnvInt('RATE_LIMIT_VOICE_WS_WINDOW_MS', 60_000),
        headerMode: 'all',
        message: 'Too many voice streaming connection attempts. Please wait a moment before reconnecting.'
      };
  }
}

/**
 * Extracts and normalizes the client IP address from Express or raw Node HTTP requests.
 */
export function extractClientIp(req: Pick<IncomingMessage, 'headers' | 'socket'> & { ip?: string }): string {
  const forwarded = req.headers?.['x-forwarded-for'];
  const rawForwarded = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  let candidate = '';

  if (typeof rawForwarded === 'string' && rawForwarded.trim()) {
    candidate = rawForwarded.split(',')[0].trim();
  } else if (typeof req.ip === 'string' && req.ip.trim()) {
    candidate = req.ip.trim();
  } else if (typeof req.socket?.remoteAddress === 'string' && req.socket.remoteAddress.trim()) {
    candidate = req.socket.remoteAddress.trim();
  }

  if (!candidate) {
    return 'unknown';
  }

  if (candidate.startsWith('::ffff:')) {
    candidate = candidate.slice(7);
  }
  if (candidate === '::1') {
    candidate = '127.0.0.1';
  }

  return candidate;
}

/**
 * Deterministically hashes an identifier (UID or IP) so Redis keys never expose raw PII.
 * Uses a deterministic salt across server instances so shared counters align cleanly.
 */
export function hashRateLimitIdentifier(rawValue: string): string {
  const salt = (process.env.ORVIX_RATE_LIMIT_KEY_SALT || '').trim() || DEFAULT_KEY_SALT;
  return crypto
    .createHmac('sha256', salt)
    .update(String(rawValue || 'unknown'))
    .digest('hex')
    .slice(0, 24);
}

/**
 * Resolves a privacy-safe rate-limit identity for an Express request.
 * Prefers cryptographically verified Firebase UID when present; falls back to hashed client IP.
 * Never trusts unverified body/header userId claims.
 */
export async function resolveRateLimitIdentity(req: express.Request): Promise<RateLimitIdentity> {
  const existingUser = (req as express.Request & { user?: { uid?: string } }).user;
  if (existingUser && typeof existingUser.uid === 'string' && existingUser.uid.trim()) {
    return {
      type: 'user',
      hashedId: hashRateLimitIdentifier(`uid:${existingUser.uid.trim()}`)
    };
  }

  if (typeof req.headers?.authorization === 'string' && req.headers.authorization.trim()) {
    try {
      const authStatus = await authenticateRequest(req);
      if (authStatus.status === 'authenticated' && authStatus.userId) {
        return {
          type: 'user',
          hashedId: hashRateLimitIdentifier(`uid:${authStatus.userId}`)
        };
      }
    } catch (_) {
      // Fall back to IP-based identity if auth lookup encounters a transient error
    }
  }

  const clientIp = extractClientIp(req);
  return {
    type: 'ip',
    hashedId: hashRateLimitIdentifier(`ip:${clientIp}`)
  };
}

export function buildRateLimitKey(
  policy: string,
  identity: RateLimitIdentity,
  keyPrefix = getRateLimitKeyPrefix()
): string {
  const cleanPolicy = policy.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${keyPrefix}:${cleanPolicy}:${identity.type}:${identity.hashedId}`;
}

async function runRedisEvalWithTimeout(
  client: RedisLikeClient,
  key: string,
  windowMs: number,
  timeoutMs: number
): Promise<{ count: number; ttlMs: number }> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const evalPromise = Promise.resolve(
      client.eval(ATOMIC_RATE_LIMIT_LUA, 1, key, String(windowMs))
    );
    // Ensure late Redis socket/command rejections after timeoutPromise wins never trigger unhandledRejection
    evalPromise.catch(() => {});

    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`Redis rate-limit command timed out after ${timeoutMs}ms`);
        err.name = 'RedisTimeoutError';
        reject(err);
      }, timeoutMs);
    });

    const rawResult = await Promise.race([evalPromise, timeoutPromise]);
    if (!Array.isArray(rawResult) || rawResult.length < 2) {
      throw new Error('Unexpected Redis rate-limit Lua response shape');
    }

    const count = Number(rawResult[0]);
    const rawTtl = Number(rawResult[1]);
    if (!Number.isFinite(count) || count < 1) {
      throw new Error('Invalid Redis rate-limit count returned');
    }

    const ttlMs = Number.isFinite(rawTtl) && rawTtl > 0 ? Math.min(windowMs, Math.ceil(rawTtl)) : windowMs;
    return { count, ttlMs };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * Atomically consumes 1 request unit against the configured distributed rate limit.
 * Uses Redis Lua EVAL when Redis is connected and ready; falls back cleanly to in-memory
 * tracking if Redis is unconfigured, disconnected, errors, or times out.
 */
export async function consumeRateLimit(
  options: RateLimitConsumeOptions,
  identity: RateLimitIdentity
): Promise<RateLimitDecision> {
  const nowMs = options.nowMs ?? Date.now();
  const limit = Math.max(1, Math.floor(options.max));
  const windowMs = Math.max(1000, Math.floor(options.windowMs));
  const keyPrefix = options.keyPrefix || getRateLimitKeyPrefix();
  const key = buildRateLimitKey(options.policy, identity, keyPrefix);
  const memoryStore = options.memoryStore || defaultMemoryStore;
  const redisClient = options.redisClient !== undefined ? options.redisClient : getRedisClient();

  if (redisClient && redisClient.status === 'ready') {
    const timeoutMs = options.commandTimeoutMs ?? getRedisCommandTimeoutMs();
    try {
      const { count, ttlMs } = await runRedisEvalWithTimeout(redisClient, key, windowMs, timeoutMs);
      const resetAtMs = nowMs + ttlMs;
      const allowed = count <= limit;
      const remaining = Math.max(0, limit - count);
      const retryAfterSeconds = allowed ? 0 : Math.max(1, Math.ceil(ttlMs / 1000));

      return {
        allowed,
        policy: options.policy,
        limit,
        remaining,
        count,
        resetAtMs,
        resetAtIso: new Date(resetAtMs).toISOString(),
        retryAfterSeconds,
        backend: 'redis',
        degraded: false,
        key
      };
    } catch (err: unknown) {
      const msg = sanitizeErrorLog(err instanceof Error ? err.message : String(err));
      logFallbackWarningThrottled(
        `[RateLimiter] Redis command failed for policy '${options.policy}' (${msg}); falling back to in-memory store.`
      );
      const mem = memoryStore.consume(key, windowMs, nowMs);
      const allowed = mem.count <= limit;
      const remaining = Math.max(0, limit - mem.count);
      const retryAfterSeconds = allowed ? 0 : Math.max(1, Math.ceil(mem.ttlMs / 1000));

      return {
        allowed,
        policy: options.policy,
        limit,
        remaining,
        count: mem.count,
        resetAtMs: mem.resetAtMs,
        resetAtIso: new Date(mem.resetAtMs).toISOString(),
        retryAfterSeconds,
        backend: 'memory',
        degraded: true,
        key
      };
    }
  }

  const mem = memoryStore.consume(key, windowMs, nowMs);
  const allowed = mem.count <= limit;
  const remaining = Math.max(0, limit - mem.count);
  const retryAfterSeconds = allowed ? 0 : Math.max(1, Math.ceil(mem.ttlMs / 1000));

  return {
    allowed,
    policy: options.policy,
    limit,
    remaining,
    count: mem.count,
    resetAtMs: mem.resetAtMs,
    resetAtIso: new Date(mem.resetAtMs).toISOString(),
    retryAfterSeconds,
    backend: 'memory',
    degraded: Boolean(redisClient),
    key
  };
}

/**
 * Applies standard rate-limit headers to HTTP responses while avoiding collisions with
 * the daily 5-upload PKT quota `X-RateLimit-*` headers on upload routes.
 */
export function applyRateLimitHeaders(
  res: express.Response,
  decision: RateLimitDecision,
  headerMode: RateLimitHeaderMode = 'all'
): void {
  try {
    const resetDeltaSeconds = Math.max(1, Math.ceil((decision.resetAtMs - Date.now()) / 1000));
    const resetEpochSeconds = Math.ceil(decision.resetAtMs / 1000);

    res.setHeader('RateLimit-Limit', String(decision.limit));
    res.setHeader('RateLimit-Remaining', String(decision.remaining));
    res.setHeader('RateLimit-Reset', String(resetDeltaSeconds));

    if (headerMode === 'all') {
      res.setHeader('X-RateLimit-Limit', String(decision.limit));
      res.setHeader('X-RateLimit-Remaining', String(decision.remaining));
      res.setHeader('X-RateLimit-Reset', String(resetEpochSeconds));
      res.setHeader('X-RateLimit-Reset-UTC', decision.resetAtIso);
    }

    if (!decision.allowed) {
      res.setHeader('Retry-After', String(decision.retryAfterSeconds));
    }
  } catch (_) {}
}

export function buildRateLimitExceededPayload(
  decision: RateLimitDecision,
  customMessage?: string
) {
  const defaultMsg = `Too many requests. Please wait ${decision.retryAfterSeconds} second${
    decision.retryAfterSeconds === 1 ? '' : 's'
  } before trying again.`;
  return {
    error: customMessage || defaultMsg,
    code: 'RATE_LIMIT_EXCEEDED',
    status: 'RESOURCE_EXHAUSTED',
    policy: decision.policy,
    limit: decision.limit,
    remaining: 0,
    retryAfterSeconds: decision.retryAfterSeconds,
    resetAt: decision.resetAtIso,
    retryable: true,
    canFallback: false
  };
}

export interface CreateRateLimiterOptions {
  policy: RateLimitPolicyName | string;
  max?: number;
  windowMs?: number;
  headerMode?: RateLimitHeaderMode;
  message?: string;
  keyPrefix?: string;
  redisClient?: RedisLikeClient | null;
  memoryStore?: InMemoryRateLimitStore;
  commandTimeoutMs?: number;
}

function isKnownPolicy(policy: string): policy is RateLimitPolicyName {
  return (
    policy === 'chat' ||
    policy === 'transcribe' ||
    policy === 'upload' ||
    policy === 'uploadRead' ||
    policy === 'config' ||
    policy === 'voiceWs'
  );
}

/**
 * Express middleware factory enforcing distributed rate limits with automatic in-memory fallback.
 */
export function createRateLimiterMiddleware(options: CreateRateLimiterOptions): express.RequestHandler {
  return async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.method === 'OPTIONS' || !isRateLimitingEnabled()) {
      return next();
    }

    try {
      const defaults = isKnownPolicy(options.policy)
        ? getRateLimitPolicyConfig(options.policy)
        : {
            policy: options.policy,
            max: 60,
            windowMs: 60_000,
            headerMode: 'all' as RateLimitHeaderMode,
            message: undefined
          };

      const max = options.max ?? defaults.max;
      const windowMs = options.windowMs ?? defaults.windowMs;
      const headerMode = options.headerMode ?? defaults.headerMode;
      const message = options.message ?? defaults.message;

      const identity = await resolveRateLimitIdentity(req);
      const decision = await consumeRateLimit(
        {
          policy: options.policy,
          max,
          windowMs,
          keyPrefix: options.keyPrefix,
          headerMode,
          redisClient: options.redisClient,
          memoryStore: options.memoryStore,
          commandTimeoutMs: options.commandTimeoutMs
        },
        identity
      );

      applyRateLimitHeaders(res, decision, headerMode);

      if (!decision.allowed) {
        return res.status(429).json(buildRateLimitExceededPayload(decision, message));
      }

      return next();
    } catch (err) {
      // Fail open on unexpected middleware error so valid requests are never broken
      console.warn(
        '[RateLimiter] Unexpected middleware notice:',
        sanitizeErrorLog(err instanceof Error ? err.message : String(err))
      );
      return next();
    }
  };
}

/**
 * Checks distributed rate limiting for WebSocket handshake upgrades (/api/voice-stream).
 */
export async function checkWebSocketUpgradeRateLimit(
  req: IncomingMessage,
  verifiedUserId: string | null,
  options?: {
    max?: number;
    windowMs?: number;
    redisClient?: RedisLikeClient | null;
    memoryStore?: InMemoryRateLimitStore;
  }
): Promise<RateLimitDecision> {
  const policyDefaults = getRateLimitPolicyConfig('voiceWs');
  if (!isRateLimitingEnabled()) {
    const nowMs = Date.now();
    return {
      allowed: true,
      policy: 'voiceWs',
      limit: policyDefaults.max,
      remaining: policyDefaults.max,
      count: 0,
      resetAtMs: nowMs + policyDefaults.windowMs,
      resetAtIso: new Date(nowMs + policyDefaults.windowMs).toISOString(),
      retryAfterSeconds: 0,
      backend: 'memory',
      degraded: false,
      key: 'disabled'
    };
  }

  const identity: RateLimitIdentity = verifiedUserId
    ? {
        type: 'user',
        hashedId: hashRateLimitIdentifier(`uid:${verifiedUserId}`)
      }
    : {
        type: 'ip',
        hashedId: hashRateLimitIdentifier(`ip:${extractClientIp(req)}`)
      };

  return consumeRateLimit(
    {
      policy: 'voiceWs',
      max: options?.max ?? policyDefaults.max,
      windowMs: options?.windowMs ?? policyDefaults.windowMs,
      redisClient: options?.redisClient,
      memoryStore: options?.memoryStore
    },
    identity
  );
}

/**
 * Test helper: clears the default in-memory rate-limit store.
 */
export function resetRateLimitersForTesting(): void {
  defaultMemoryStore.clear();
  lastFallbackLogMs = 0;
}
