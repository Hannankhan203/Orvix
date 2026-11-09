import crypto from 'crypto';
import type express from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

import {
  authenticateRequest,
  type AuthRequestResult
} from './firebaseAuthHelper.ts';
import { resolveUploadDirectory } from './uploadSubsystem.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DAILY_UPLOAD_LIMIT = 5;
export const RESERVATION_TTL_MS = 120_000; // 2 minutes reservation TTL
export const LOCK_TIMEOUT_MS = 15_000; // 15 seconds max lock wait

export interface QuotaIdentity {
  type: 'auth' | 'guest';
  id: string; // verified Firebase UID for auth, or verified server-issued ID for guest
  key: string; // internal storage key: 'auth_<sha256>' or 'guest_<sha256>'
  guestToken?: string;
  isNewGuest?: boolean;
}

export interface QuotaReservation {
  reservationId: string;
  identityKey: string;
  utcDay: string;
  expiresAt: number;
  createdAt: number;
}

export interface QuotaStatus {
  limit: number;
  committed: number;
  activeReservations: number;
  remaining: number;
  resetAt: string;
}

export interface QuotaRecord {
  identityKey: string;
  utcDay: string;
  committed: number;
  reservations: Record<string, { expiresAt: number; createdAt: number }>;
  lastUpdated: number;
}

export type ReservationResult =
  | {
      allowed: true;
      reservation: QuotaReservation;
      remaining: number;
      resetAt: string;
      limit: number;
    }
  | {
      allowed: false;
      limit: number;
      remaining: number;
      resetAt: string;
      error: string;
    };

// Test hooks for deterministic time travel and isolated testing
let customDateHook: (() => Date) | null = null;
let serverSecretOverride: string | null = null;

export function setCustomDateHookForTesting(hook: (() => Date) | null): void {
  customDateHook = hook;
}

export function setServerSecretOverrideForTesting(secret: string | null): void {
  serverSecretOverride = secret;
}

/**
 * Returns current Date according to active test hook or system time.
 */
export function getCurrentDate(): Date {
  if (customDateHook) {
    return customDateHook();
  }
  return new Date();
}

/**
 * Returns YYYY-MM-DD UTC date string.
 */
export function getUtcDayString(date: Date = getCurrentDate()): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Returns the exact Date of the next UTC midnight.
 */
export function getNextUtcMidnight(date: Date = getCurrentDate()): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1, 0, 0, 0, 0));
}

/**
 * Resolves the persistent directory where quota records and lockfiles reside.
 * Persists across server restarts.
 */
export function resolveQuotaDirectory(): string {
  if (process.env.QUOTA_DIR) {
    const dir = path.resolve(process.env.QUOTA_DIR);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  // Derive quota directory alongside upload storage
  const baseUploadDir = resolveUploadDirectory();
  const quotaDir = path.resolve(baseUploadDir, '..', 'quotas');
  try {
    if (!fs.existsSync(quotaDir)) {
      fs.mkdirSync(quotaDir, { recursive: true });
    }
    return quotaDir;
  } catch (_) {
    const fallback = path.join(os.tmpdir(), 'orvix_quotas');
    if (!fs.existsSync(fallback)) {
      fs.mkdirSync(fallback, { recursive: true });
    }
    return fallback;
  }
}

/**
 * Retrieves or initializes the HMAC secret used to sign server-issued guest tokens.
 * Persisted to disk to remain stable across process restarts.
 */
export function getOrInitServerSecret(): string {
  if (serverSecretOverride) {
    return serverSecretOverride;
  }

  if (process.env.ORVIX_GUEST_SECRET && process.env.ORVIX_GUEST_SECRET.trim().length >= 16) {
    return process.env.ORVIX_GUEST_SECRET.trim();
  }

  const quotaDir = resolveQuotaDirectory();
  const secretFile = path.join(quotaDir, '.guest_secret');
  try {
    if (fs.existsSync(secretFile)) {
      const stored = fs.readFileSync(secretFile, 'utf8').trim();
      if (stored.length >= 32) {
        return stored;
      }
    }
  } catch (_) {}

  const newSecret = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(secretFile, newSecret, { mode: 0o600 });
  } catch (_) {}

  return newSecret;
}

/**
 * Computes HMAC-SHA256 signature for a guest identifier.
 */
export function signGuestId(guestId: string, secret = getOrInitServerSecret()): string {
  return crypto.createHmac('sha256', secret).update(guestId).digest('hex');
}

/**
 * Verifies a server-issued guest token format: `<guestId>.<hmacSignature>`.
 * Returns valid: true and extracted guestId if signature matches.
 */
export function verifyGuestToken(
  token: unknown,
  secret = getOrInitServerSecret()
): { valid: boolean; guestId?: string } {
  if (typeof token !== 'string' || !token.trim()) {
    return { valid: false };
  }

  const trimmed = token.trim();
  const dotIndex = trimmed.lastIndexOf('.');
  if (dotIndex <= 0 || dotIndex >= trimmed.length - 1) {
    return { valid: false };
  }

  const guestId = trimmed.slice(0, dotIndex);
  const signature = trimmed.slice(dotIndex + 1);

  if (!guestId.startsWith('guest_') || guestId.length < 10 || guestId.length > 64) {
    return { valid: false };
  }

  const expectedSignature = signGuestId(guestId, secret);
  try {
    const sigBuffer = Buffer.from(signature, 'hex');
    const expectedBuffer = Buffer.from(expectedSignature, 'hex');
    if (sigBuffer.length !== expectedBuffer.length) {
      return { valid: false };
    }
    if (crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
      return { valid: true, guestId };
    }
  } catch (_) {}

  return { valid: false };
}

/**
 * Creates a brand new, cryptographically signed server-issued guest token.
 */
export function createServerIssuedGuestToken(secret = getOrInitServerSecret()): {
  guestId: string;
  guestToken: string;
} {
  const guestId = 'guest_' + crypto.randomBytes(16).toString('hex');
  const signature = signGuestId(guestId, secret);
  return {
    guestId,
    guestToken: `${guestId}.${signature}`
  };
}

/**
 * Resolves request identity according to strict security rules:
 * 1. Authenticated users: Cryptographically verified Firebase ID token -> verified UID.
 * 2. Guests: Server-issued signed guest token from cookies or X-Guest-Token header.
 * 3. Never trusts arbitrary client-supplied user IDs or IP headers!
 */
export async function resolveUploadIdentity(req: express.Request): Promise<QuotaIdentity> {
  const authStatus: AuthRequestResult = await authenticateRequest(req);

  // Authenticated user with verified Firebase UID
  if (authStatus.status === 'authenticated' && authStatus.userId) {
    const verifiedUid = authStatus.userId;
    const hashedUid = crypto.createHash('sha256').update(`auth:${verifiedUid}`).digest('hex').slice(0, 32);
    return {
      type: 'auth',
      id: verifiedUid,
      key: `auth_${hashedUid}`
    };
  }

  // Guest user: Inspect signed cookie or X-Guest-Token header
  let rawToken: string | undefined;

  // 1. Check cookies
  const cookieHeader = req.headers?.cookie;
  if (cookieHeader) {
    const match = cookieHeader.match(/(?:^|;\s*)orvix_guest_token=([^;]+)/);
    if (match && match[1]) {
      rawToken = decodeURIComponent(match[1].trim());
    }
  }

  // 2. Check X-Guest-Token header
  if (!rawToken) {
    const headerToken = (req.headers?.['x-guest-token'] || req.headers?.['X-Guest-Token']) as string | undefined;
    if (headerToken && typeof headerToken === 'string') {
      rawToken = headerToken.trim();
    }
  }

  const verification = verifyGuestToken(rawToken);
  if (verification.valid && verification.guestId) {
    const guestId = verification.guestId;
    const hashedGuest = crypto.createHash('sha256').update(`guest:${guestId}`).digest('hex').slice(0, 32);
    return {
      type: 'guest',
      id: guestId,
      guestToken: rawToken,
      isNewGuest: false,
      key: `guest_${hashedGuest}`
    };
  }

  // Issue a fresh server-issued guest token
  const { guestId, guestToken } = createServerIssuedGuestToken();
  const hashedGuest = crypto.createHash('sha256').update(`guest:${guestId}`).digest('hex').slice(0, 32);
  return {
    type: 'guest',
    id: guestId,
    guestToken,
    isNewGuest: true,
    key: `guest_${hashedGuest}`
  };
}

/**
 * File-locking wrapper enforcing atomic transactions across concurrent requests and processes.
 */
async function withFileLock<T>(lockKey: string, fn: () => Promise<T>): Promise<T> {
  const quotaDir = resolveQuotaDirectory();
  const lockPath = path.join(quotaDir, `${lockKey}.lock`);
  const startTime = Date.now();

  while (true) {
    try {
      // 'wx' flag: Open for writing. The file is created (if not exists) or fails with EEXIST.
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, `${Date.now()}:${process.pid}`);
      fs.closeSync(fd);
      break;
    } catch (err: any) {
      if (err?.code === 'EEXIST') {
        // Stale lock recovery: If lock is older than 10 seconds, remove it
        try {
          const stats = fs.statSync(lockPath);
          if (Date.now() - stats.mtimeMs > 10000) {
            fs.unlinkSync(lockPath);
            continue;
          }
        } catch (_) {}

        if (Date.now() - startTime > LOCK_TIMEOUT_MS) {
          throw new Error(`Timeout waiting for quota lock (${lockKey})`);
        }
        await new Promise((r) => setTimeout(r, 10 + Math.random() * 20));
      } else {
        throw err;
      }
    }
  }

  try {
    return await fn();
  } finally {
    try {
      if (fs.existsSync(lockPath)) {
        fs.unlinkSync(lockPath);
      }
    } catch (_) {}
  }
}

/**
 * Reads the persistent QuotaRecord for an identity and UTC day.
 * Must be invoked inside withFileLock.
 */
function readQuotaRecordSync(identityKey: string, utcDay: string): QuotaRecord {
  const quotaDir = resolveQuotaDirectory();
  const filePath = path.join(quotaDir, `${identityKey}_${utcDay}.json`);

  if (fs.existsSync(filePath)) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object') {
        return {
          identityKey,
          utcDay,
          committed: typeof parsed.committed === 'number' ? parsed.committed : 0,
          reservations: parsed.reservations && typeof parsed.reservations === 'object' ? parsed.reservations : {},
          lastUpdated: parsed.lastUpdated || Date.now()
        };
      }
    } catch (_) {}
  }

  return {
    identityKey,
    utcDay,
    committed: 0,
    reservations: {},
    lastUpdated: Date.now()
  };
}

/**
 * Writes the QuotaRecord atomically to disk using write-to-temp and atomic rename.
 * Must be invoked inside withFileLock.
 */
function writeQuotaRecordSync(record: QuotaRecord): void {
  const quotaDir = resolveQuotaDirectory();
  const filePath = path.join(quotaDir, `${record.identityKey}_${record.utcDay}.json`);
  const tempPath = path.join(quotaDir, `${record.identityKey}_${record.utcDay}.${crypto.randomUUID()}.tmp`);

  record.lastUpdated = Date.now();
  const json = JSON.stringify(record, null, 2);
  fs.writeFileSync(tempPath, json, 'utf8');
  fs.renameSync(tempPath, filePath);
}

/**
 * Prunes expired reservations from a record in-place.
 */
function pruneExpiredReservations(record: QuotaRecord, nowMs: number): number {
  let activeCount = 0;
  for (const [resId, res] of Object.entries(record.reservations)) {
    if (!res || typeof res.expiresAt !== 'number' || res.expiresAt <= nowMs) {
      delete record.reservations[resId];
    } else {
      activeCount++;
    }
  }
  return activeCount;
}

/**
 * Atomically reserves 1 upload slot for an identity on the current UTC calendar day.
 * Prevents concurrent requests from exceeding the limit of 5.
 */
export async function reserveUploadSlot(
  identity: QuotaIdentity,
  options: { customNow?: Date } = {}
): Promise<ReservationResult> {
  const now = options.customNow || getCurrentDate();
  const nowMs = now.getTime();
  const utcDay = getUtcDayString(now);
  const resetAt = getNextUtcMidnight(now).toISOString();
  const lockKey = `${identity.key}_${utcDay}`;

  return withFileLock(lockKey, async () => {
    const record = readQuotaRecordSync(identity.key, utcDay);
    const activeReservationsCount = pruneExpiredReservations(record, nowMs);

    const totalUsage = record.committed + activeReservationsCount;
    if (totalUsage >= DAILY_UPLOAD_LIMIT) {
      const remaining = Math.max(0, DAILY_UPLOAD_LIMIT - totalUsage);
      return {
        allowed: false,
        limit: DAILY_UPLOAD_LIMIT,
        remaining,
        resetAt,
        error: `Daily attachment upload limit of ${DAILY_UPLOAD_LIMIT} uploads per day exceeded. Quota resets at midnight UTC.`
      };
    }

    const reservationId = 'res_' + crypto.randomUUID();
    const expiresAt = nowMs + RESERVATION_TTL_MS;

    record.reservations[reservationId] = {
      expiresAt,
      createdAt: nowMs
    };

    writeQuotaRecordSync(record);

    const remaining = Math.max(0, DAILY_UPLOAD_LIMIT - (record.committed + activeReservationsCount + 1));

    return {
      allowed: true,
      reservation: {
        reservationId,
        identityKey: identity.key,
        utcDay,
        expiresAt,
        createdAt: nowMs
      },
      remaining,
      resetAt,
      limit: DAILY_UPLOAD_LIMIT
    };
  });
}

/**
 * Commits a reservation upon successful upload completion.
 * Increments committed count and removes reservation atomically.
 */
export async function commitUploadSlot(reservation: QuotaReservation): Promise<QuotaStatus> {
  const lockKey = `${reservation.identityKey}_${reservation.utcDay}`;
  const now = getCurrentDate();
  const resetAt = getNextUtcMidnight(now).toISOString();

  return withFileLock(lockKey, async () => {
    const record = readQuotaRecordSync(reservation.identityKey, reservation.utcDay);
    pruneExpiredReservations(record, now.getTime());

    // Remove the reservation
    delete record.reservations[reservation.reservationId];

    // Increment committed count
    record.committed = Math.min(DAILY_UPLOAD_LIMIT, record.committed + 1);

    writeQuotaRecordSync(record);

    const activeCount = Object.keys(record.reservations).length;
    const remaining = Math.max(0, DAILY_UPLOAD_LIMIT - (record.committed + activeCount));

    return {
      limit: DAILY_UPLOAD_LIMIT,
      committed: record.committed,
      activeReservations: activeCount,
      remaining,
      resetAt
    };
  });
}

/**
 * Releases a reserved slot when an upload fails or is cancelled.
 * Does NOT increment committed count, ensuring failed uploads never consume quota.
 */
export async function releaseUploadSlot(reservation: QuotaReservation): Promise<QuotaStatus> {
  const lockKey = `${reservation.identityKey}_${reservation.utcDay}`;
  const now = getCurrentDate();
  const resetAt = getNextUtcMidnight(now).toISOString();

  return withFileLock(lockKey, async () => {
    const record = readQuotaRecordSync(reservation.identityKey, reservation.utcDay);
    pruneExpiredReservations(record, now.getTime());

    // Safely remove the reservation if present
    delete record.reservations[reservation.reservationId];

    writeQuotaRecordSync(record);

    const activeCount = Object.keys(record.reservations).length;
    const remaining = Math.max(0, DAILY_UPLOAD_LIMIT - (record.committed + activeCount));

    return {
      limit: DAILY_UPLOAD_LIMIT,
      committed: record.committed,
      activeReservations: activeCount,
      remaining,
      resetAt
    };
  });
}

/**
 * Retrieves the current quota status for an identity without modifying records.
 */
export async function getQuotaStatus(
  identity: QuotaIdentity,
  options: { customNow?: Date } = {}
): Promise<QuotaStatus> {
  const now = options.customNow || getCurrentDate();
  const utcDay = getUtcDayString(now);
  const resetAt = getNextUtcMidnight(now).toISOString();
  const lockKey = `${identity.key}_${utcDay}`;

  return withFileLock(lockKey, async () => {
    const record = readQuotaRecordSync(identity.key, utcDay);
    const activeCount = pruneExpiredReservations(record, now.getTime());
    const totalUsage = record.committed + activeCount;
    const remaining = Math.max(0, DAILY_UPLOAD_LIMIT - totalUsage);

    return {
      limit: DAILY_UPLOAD_LIMIT,
      committed: record.committed,
      activeReservations: activeCount,
      remaining,
      resetAt
    };
  });
}

/**
 * Attaches standard HTTP rate limit headers to response.
 * Also attaches Set-Cookie and X-Guest-Token for guests.
 */
export function attachQuotaHeaders(
  res: express.Response,
  status: { limit: number; remaining: number; resetAt: string },
  identity?: QuotaIdentity
): void {
  try {
    res.setHeader('X-RateLimit-Limit', String(status.limit));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, status.remaining)));
    res.setHeader('X-RateLimit-Reset-UTC', status.resetAt);

    if (identity && identity.type === 'guest' && identity.guestToken) {
      res.setHeader('X-Guest-Token', identity.guestToken);
      res.setHeader(
        'Set-Cookie',
        `orvix_guest_token=${encodeURIComponent(identity.guestToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`
      );
    }
  } catch (_) {}
}

/**
 * Testing utility: Clears quota records on disk.
 */
export async function resetQuotaForTesting(identityKey?: string): Promise<void> {
  const quotaDir = resolveQuotaDirectory();
  try {
    const files = fs.readdirSync(quotaDir);
    for (const file of files) {
      if (file.endsWith('.json') || file.endsWith('.lock') || file.endsWith('.tmp')) {
        if (!identityKey || file.startsWith(identityKey)) {
          try {
            fs.unlinkSync(path.join(quotaDir, file));
          } catch (_) {}
        }
      }
    }
  } catch (_) {}
}
