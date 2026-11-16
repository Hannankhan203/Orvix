import crypto from 'crypto';
import type express from 'express';
import type { IncomingMessage } from 'http';
import { authenticateRequest } from './firebaseAuthHelper.ts';
import {
  ensureRedisReady,
  getRedisClient,
  getRedisCommandTimeoutMs,
  getRedisHealthStatus,
  isRedisConfigured,
  type RedisLikeClient
} from './redisClient.ts';
import { sanitizeErrorLog } from './diagnosticLogger.ts';
import {
  extractClientIp,
  resolveTrustedProxyPolicy,
  parseAndNormalizeIp,
  type TrustedProxyPolicy
} from './trustedProxy.ts';

export { extractClientIp, resolveTrustedProxyPolicy, parseAndNormalizeIp, type TrustedProxyPolicy };

export type RateLimitPolicyName =
  | 'chat'
  | 'transcribe'
  | 'upload'
  | 'uploadRead'
  | 'config'
  | 'voiceWs'
  | 'voiceWsHandshake';

export type RateLimitHeaderMode = 'all' | 'ietf-only';
export type RateLimitBackend = 'redis' | 'memory' | 'fail-closed';
export type RateLimitFailureMode = 'fail-closed' | 'memory';

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
  failureMode?: RateLimitFailureMode;
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
  backend: RateLimitBackend;
  distributed: boolean;
  degraded: boolean;
  failureReason?: string;
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
    case 'voiceWsHandshake':
      return {
        policy: 'voiceWsHandshake',
        max: parsePositiveEnvInt('RATE_LIMIT_VOICE_WS_HANDSHAKE_MAX', 60),
        windowMs: parsePositiveEnvInt('RATE_LIMIT_VOICE_WS_HANDSHAKE_WINDOW_MS', 60_000),
        headerMode: 'all',
        message: 'Too many WebSocket connection attempts from this IP. Please wait before retrying.'
      };
  }
}

const COSTLY_FAIL_CLOSED_POLICIES = new Set([
  'chat',
  'transcribe',
  'upload',
  'voiceWs',
  'voiceWsHandshake'
]);

export function isDistributedProductionRuntime(): boolean {
  if (process.env.NODE_ENV === 'production') {
    return true;
  }
  if (Boolean(process.env.VERCEL)) {
    return !process.env.NODE_TEST_CONTEXT;
  }
  if (Boolean(process.env.K_SERVICE)) {
    return process.env.NODE_ENV !== 'development' && !process.env.NODE_TEST_CONTEXT;
  }
  return false;
}

export function isDistributedRateLimitRequired(): boolean {
  const raw = String(process.env.RATE_LIMIT_REQUIRE_DISTRIBUTED || '').trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes';
}

export function resolveRateLimitFailureMode(
  policy: string,
  explicitMode?: RateLimitFailureMode,
  hasConfiguredRedis = isRedisConfigured()
): RateLimitFailureMode {
  if (explicitMode) {
    return explicitMode;
  }

  if (isDistributedRateLimitRequired()) {
    return 'fail-closed';
  }

  const envMode = String(process.env.RATE_LIMIT_FAILURE_MODE || '').trim().toLowerCase();
  if (envMode === 'fail-closed' || envMode === 'closed') {
    return 'fail-closed';
  }
  if (envMode === 'memory' || envMode === 'fail-open' || envMode === 'open') {
    return 'memory';
  }

  // In production, when Redis is configured for multi-instance limiting, never silently downgrade
  // high-cost AI / upload / voice endpoints to isolated per-instance memory on Redis failure.
  if (isDistributedProductionRuntime() && hasConfiguredRedis && COSTLY_FAIL_CLOSED_POLICIES.has(policy)) {
    return 'fail-closed';
  }

  return 'memory';
}

export function getRateLimitBackendStatus() {
  const redis = getRedisHealthStatus();
  const proxyPolicy = resolveTrustedProxyPolicy();
  const productionRuntime = isDistributedProductionRuntime();
  const requireDistributed = isDistributedRateLimitRequired();
  return {
    distributedReady: redis.configured && redis.connected,
    backend:
      redis.configured && redis.connected
        ? 'redis'
        : requireDistributed
          ? 'fail-closed'
          : 'memory',
    redis,
    trustedProxyMode: proxyPolicy.mode,
    requireDistributed,
    productionRuntime
  };
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

function buildFailClosedDecision(
  policy: string,
  limit: number,
  nowMs: number,
  key: string,
  failureReason: string
): RateLimitDecision {
  const retryAfterSeconds = 5;
  const resetAtMs = nowMs + retryAfterSeconds * 1000;
  return {
    allowed: false,
    policy,
    limit,
    remaining: 0,
    count: limit + 1,
    resetAtMs,
    resetAtIso: new Date(resetAtMs).toISOString(),
    retryAfterSeconds,
    backend: 'fail-closed',
    distributed: false,
    degraded: true,
    failureReason,
    key
  };
}

/**
 * Atomically consumes 1 request unit against the configured distributed rate limit.
 * Awaits cold-start Redis readiness when actively connecting. Never silently claims distributed
 * protection from an in-memory fallback, and fails closed when configured production distributed stores fail.
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
  const hasConfiguredRedis =
    options.redisClient !== undefined ? Boolean(options.redisClient) : isRedisConfigured();
  const timeoutMs = options.commandTimeoutMs ?? getRedisCommandTimeoutMs();

  if (redisClient) {
    const ready = await ensureRedisReady(redisClient, Math.min(timeoutMs, 1000));
    if (ready) {
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
          distributed: true,
          degraded: false,
          key
        };
      } catch (err: unknown) {
        const msg = sanitizeErrorLog(err instanceof Error ? err.message : String(err));
        const failureMode = resolveRateLimitFailureMode(
          options.policy,
          options.failureMode,
          hasConfiguredRedis
        );
        if (failureMode === 'fail-closed') {
          logFallbackWarningThrottled(
            `[RateLimiter] Redis command failed for policy '${options.policy}' (${msg}); failing closed (503) to preserve distributed limits.`
          );
          return buildFailClosedDecision(options.policy, limit, nowMs, key, 'REDIS_COMMAND_FAILED');
        }

        logFallbackWarningThrottled(
          `[RateLimiter] Redis command failed for policy '${options.policy}' (${msg}); falling back to non-distributed in-memory store.`
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
          distributed: false,
          degraded: true,
          key
        };
      }
    }

    const failureMode = resolveRateLimitFailureMode(
      options.policy,
      options.failureMode,
      hasConfiguredRedis
    );
    if (failureMode === 'fail-closed') {
      logFallbackWarningThrottled(
        `[RateLimiter] Redis not ready (status=${redisClient.status}) for policy '${options.policy}'; failing closed (503).`
      );
      return buildFailClosedDecision(options.policy, limit, nowMs, key, 'REDIS_NOT_READY');
    }

    logFallbackWarningThrottled(
      `[RateLimiter] Redis not ready (status=${redisClient.status}) for policy '${options.policy}'; falling back to non-distributed in-memory store.`
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
      distributed: false,
      degraded: true,
      key
    };
  }

  const failureMode = resolveRateLimitFailureMode(
    options.policy,
    options.failureMode,
    hasConfiguredRedis
  );
  if (failureMode === 'fail-closed') {
    logFallbackWarningThrottled(
      `[RateLimiter] Distributed Redis store required/configured but unavailable for policy '${options.policy}'; failing closed (503).`
    );
    return buildFailClosedDecision(options.policy, limit, nowMs, key, 'REDIS_UNAVAILABLE');
  }

  const inProd = isDistributedProductionRuntime();
  if (inProd) {
    logFallbackWarningThrottled(
      `[RateLimiter] REDIS_URL not configured in production for policy '${options.policy}'; using per-instance in-memory store (limits are NOT shared across instances).`
    );
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
    distributed: false,
    degraded: inProd || isRedisConfigured(),
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

export function buildRateLimiterUnavailablePayload(decision: RateLimitDecision) {
  return {
    error: 'Rate-limiting protection service is temporarily unavailable. Please retry shortly.',
    code: 'RATE_LIMITER_UNAVAILABLE',
    status: 'UNAVAILABLE',
    policy: decision.policy,
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
  failureMode?: RateLimitFailureMode;
}

function isKnownPolicy(policy: string): policy is RateLimitPolicyName {
  return (
    policy === 'chat' ||
    policy === 'transcribe' ||
    policy === 'upload' ||
    policy === 'uploadRead' ||
    policy === 'config' ||
    policy === 'voiceWs' ||
    policy === 'voiceWsHandshake'
  );
}

/**
 * Express middleware factory enforcing distributed rate limits with explicit fail-closed
 * or non-distributed fallback semantics.
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
          commandTimeoutMs: options.commandTimeoutMs,
          failureMode: options.failureMode
        },
        identity
      );

      applyRateLimitHeaders(res, decision, headerMode);

      if (!decision.allowed) {
        if (decision.backend === 'fail-closed') {
          return res.status(503).json(buildRateLimiterUnavailablePayload(decision));
        }
        return res.status(429).json(buildRateLimitExceededPayload(decision, message));
      }

      return next();
    } catch (err) {
      console.warn(
        '[RateLimiter] Unexpected middleware notice:',
        sanitizeErrorLog(err instanceof Error ? err.message : String(err))
      );
      if (resolveRateLimitFailureMode(options.policy, options.failureMode) === 'fail-closed') {
        const nowMs = Date.now();
        res.setHeader('Retry-After', '5');
        return res.status(503).json({
          error: 'Rate-limiting protection service is temporarily unavailable. Please retry shortly.',
          code: 'RATE_LIMITER_UNAVAILABLE',
          status: 'UNAVAILABLE',
          policy: options.policy,
          retryAfterSeconds: 5,
          resetAt: new Date(nowMs + 5000).toISOString(),
          retryable: true,
          canFallback: false
        });
      }
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
    failureMode?: RateLimitFailureMode;
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
      distributed: false,
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
      memoryStore: options?.memoryStore,
      failureMode: options?.failureMode
    },
    identity
  );
}

/**
 * Pre-authentication IP flood protection for WebSocket HTTP upgrades.
 * Runs BEFORE expensive Firebase RSA JWT signature verification so unauthenticated floods
 * cannot exhaust CPU or starve legitimate traffic.
 */
export async function checkWebSocketHandshakeFloodLimit(
  req: IncomingMessage,
  options?: {
    max?: number;
    windowMs?: number;
    redisClient?: RedisLikeClient | null;
    memoryStore?: InMemoryRateLimitStore;
    failureMode?: RateLimitFailureMode;
  }
): Promise<RateLimitDecision> {
  const policyDefaults = getRateLimitPolicyConfig('voiceWsHandshake');
  if (!isRateLimitingEnabled()) {
    const nowMs = Date.now();
    return {
      allowed: true,
      policy: 'voiceWsHandshake',
      limit: policyDefaults.max,
      remaining: policyDefaults.max,
      count: 0,
      resetAtMs: nowMs + policyDefaults.windowMs,
      resetAtIso: new Date(nowMs + policyDefaults.windowMs).toISOString(),
      retryAfterSeconds: 0,
      backend: 'memory',
      distributed: false,
      degraded: false,
      key: 'disabled'
    };
  }

  const clientIp = extractClientIp(req);
  return consumeRateLimit(
    {
      policy: 'voiceWsHandshake',
      max: options?.max ?? policyDefaults.max,
      windowMs: options?.windowMs ?? policyDefaults.windowMs,
      redisClient: options?.redisClient,
      memoryStore: options?.memoryStore,
      failureMode: options?.failureMode
    },
    {
      type: 'ip',
      hashedId: hashRateLimitIdentifier(`ip:${clientIp}`)
    }
  );
}

/**
 * Test helper: clears the default in-memory rate-limit store.
 */
export function resetRateLimitersForTesting(): void {
  defaultMemoryStore.clear();
  lastFallbackLogMs = 0;
}
