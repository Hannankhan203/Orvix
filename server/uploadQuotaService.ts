import crypto from 'crypto';
import type express from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { getApps, initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

import {
  authenticateRequest,
  type AuthRequestResult,
  getConfiguredFirebaseProjectId
} from './firebaseAuthHelper.ts';
import { logUploadDiagnostic } from './diagnosticLogger.ts';
import { resolveUploadDirectory } from './uploadSubsystem.ts';

export const DAILY_UPLOAD_LIMIT = 5;
export const RESERVATION_TTL_MS =
  parseInt(process.env.ORVIX_UPLOAD_RESERVATION_TTL_MS || '', 10) || 120_000; // 120 seconds (2 minutes)
export const LOCK_TIMEOUT_MS = 15_000;

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
  pktDay?: string;
  /** @deprecated Legacy alias for pktDay (Asia/Karachi PKT calendar date). */
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
  pktDay?: string;
  /** @deprecated Legacy alias for pktDay (Asia/Karachi PKT calendar date). */
  utcDay?: string;
}

export interface QuotaRecord {
  identityKey: string;
  pktDay?: string;
  /** @deprecated Legacy alias for pktDay (Asia/Karachi PKT calendar date). */
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
let customFirestoreOverride: any | null = null;

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

export const PKT_TIMEZONE = 'Asia/Karachi';

const PKT_DATE_TIME_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: PKT_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23'
});

interface PktDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function getPktDateParts(date: Date): PktDateParts {
  const parts = PKT_DATE_TIME_FORMATTER.formatToParts(date);
  let year = 0;
  let month = 0;
  let day = 0;
  let hour = 0;
  let minute = 0;
  let second = 0;

  for (const part of parts) {
    if (part.type === 'year') year = Number(part.value);
    else if (part.type === 'month') month = Number(part.value);
    else if (part.type === 'day') day = Number(part.value);
    else if (part.type === 'hour') hour = Number(part.value);
    else if (part.type === 'minute') minute = Number(part.value);
    else if (part.type === 'second') second = Number(part.value);
  }

  return {
    year,
    month,
    day,
    hour: hour === 24 ? 0 : hour,
    minute,
    second
  };
}

/**
 * Returns YYYY-MM-DD calendar date string in Asia/Karachi (PKT).
 */
export function getPktDayString(date: Date = getCurrentDate()): string {
  const { year, month, day } = getPktDateParts(date);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Returns YYYY-MM-DD quota day string (Asia/Karachi PKT).
 * @deprecated Use `getPktDayString` instead. Preserved for backwards compatibility across server routes and tests.
 */
export function getUtcDayString(date: Date = getCurrentDate()): string {
  return getPktDayString(date);
}

/**
 * Returns the exact Date (UTC instant) of the next midnight in Asia/Karachi (00:00:00.000 PKT).
 */
export function getNextPktMidnight(date: Date = getCurrentDate()): Date {
  const { year, month, day } = getPktDateParts(date);
  const nextWallMidnightUtcMs = Date.UTC(year, month - 1, day + 1, 0, 0, 0, 0);

  let guessMs = nextWallMidnightUtcMs;
  for (let i = 0; i < 4; i++) {
    const guessParts = getPktDateParts(new Date(guessMs));
    const guessWallMs = Date.UTC(
      guessParts.year,
      guessParts.month - 1,
      guessParts.day,
      guessParts.hour,
      guessParts.minute,
      guessParts.second,
      0
    );
    const deltaMs = nextWallMidnightUtcMs - guessWallMs;
    if (deltaMs === 0) {
      break;
    }
    guessMs += deltaMs;
  }

  return new Date(guessMs);
}

/**
 * Returns the exact Date of the next quota reset midnight (00:00:00.000 PKT).
 * @deprecated Use `getNextPktMidnight` instead. Preserved for backwards compatibility across server routes and tests.
 */
export function getNextUtcMidnight(date: Date = getCurrentDate()): Date {
  return getNextPktMidnight(date);
}

/**
 * Resolves the persistent directory where quota records and lockfiles resided previously.
 * Kept for backward compatibility with testing suites and migrations.
 */
export function resolveQuotaDirectory(): string {
  if (process.env.QUOTA_DIR) {
    const dir = path.resolve(process.env.QUOTA_DIR);
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (_) {}
    }
    return dir;
  }

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
      try {
        fs.mkdirSync(fallback, { recursive: true });
      } catch (_) {}
    }
    return fallback;
  }
}

/**
 * Retrieves or initializes the HMAC secret used to sign server-issued guest tokens.
 * Persisted in memory or env to remain stable across distributed instances.
 */
let inMemoryServerSecret: string | null = null;

export function getOrInitServerSecret(): string {
  if (serverSecretOverride) {
    return serverSecretOverride;
  }

  if (process.env.ORVIX_GUEST_SECRET && process.env.ORVIX_GUEST_SECRET.trim().length >= 16) {
    return process.env.ORVIX_GUEST_SECRET.trim();
  }

  if (inMemoryServerSecret) {
    return inMemoryServerSecret;
  }

  const quotaDir = resolveQuotaDirectory();
  const secretFile = path.join(quotaDir, '.guest_secret');
  try {
    if (fs.existsSync(secretFile)) {
      const stored = fs.readFileSync(secretFile, 'utf8').trim();
      if (stored.length >= 32) {
        inMemoryServerSecret = stored;
        return stored;
      }
    }
  } catch (_) {}

  const newSecret = crypto.randomBytes(32).toString('hex');
  inMemoryServerSecret = newSecret;
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
): { valid: boolean; guestId?: string; expired?: boolean } {
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

  if (!guestId.startsWith('guest_') || guestId.length < 10 || guestId.length > 80) {
    return { valid: false };
  }

  const expectedSignature = signGuestId(guestId, secret);
  try {
    const sigBuffer = Buffer.from(signature, 'hex');
    const expectedBuffer = Buffer.from(expectedSignature, 'hex');
    if (sigBuffer.length !== expectedBuffer.length) {
      return { valid: false };
    }
    if (!crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
      return { valid: false };
    }

    // Cryptographic signature verified. Now check if token has an explicit expiration timestamp
    // Supported formats: guest_exp_<timestamp>_<random> or guest_<random>_exp_<timestamp>
    const expMatch = guestId.match(/_exp_(\d{10,15})/);
    if (expMatch && expMatch[1]) {
      const expMs = parseInt(expMatch[1], 10);
      const nowMs = getCurrentDate().getTime();
      if (!isNaN(expMs) && expMs > 0 && nowMs > expMs) {
        return { valid: false, guestId, expired: true };
      }
    }

    return { valid: true, guestId };
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
 * Creates an expiring server-issued guest token for testing and session management.
 */
export function createExpiringGuestToken(
  ttlMs = 3600_000,
  secret = getOrInitServerSecret()
): {
  guestId: string;
  guestToken: string;
  expiresAt: number;
} {
  const expiresAt = getCurrentDate().getTime() + ttlMs;
  const guestId = `guest_exp_${expiresAt}_${crypto.randomBytes(12).toString('hex')}`;
  const signature = signGuestId(guestId, secret);
  return {
    guestId,
    guestToken: `${guestId}.${signature}`,
    expiresAt
  };
}

/**
 * Builds a QuotaIdentity exclusively from a cryptographically verified Firebase UID.
 * Never trusts client-provided user IDs, guest tokens, cookies, or identity headers.
 */
export function buildAuthenticatedQuotaIdentity(verifiedUid: string): QuotaIdentity {
  const cleanUid = typeof verifiedUid === 'string' ? verifiedUid.trim() : '';
  if (!cleanUid) {
    throw new Error('A verified Firebase UID is required to construct upload quota identity.');
  }
  const hashedUid = crypto.createHash('sha256').update(`auth:${cleanUid}`).digest('hex').slice(0, 32);
  return {
    type: 'auth',
    id: cleanUid,
    key: `auth_${hashedUid}`
  };
}

/**
 * Resolves upload quota identity exclusively from a verified Firebase ID token on the request.
 * Returns null if the request is unauthenticated, missing a token, expired, or forged.
 * Never falls back to guest identity, guest cookies, or client headers.
 */
export async function resolveAuthenticatedUploadIdentity(req: express.Request): Promise<QuotaIdentity | null> {
  const authStatus: AuthRequestResult = await authenticateRequest(req);
  if (authStatus.status !== 'authenticated' || !authStatus.userId) {
    return null;
  }
  return buildAuthenticatedQuotaIdentity(authStatus.userId);
}

/**
 * Resolves request identity according to strict security rules:
 * 1. Authenticated users: Cryptographically verified Firebase ID token -> verified UID.
 * 2. Guests: Server-issued signed guest token from cookies or X-Guest-Token header (used only for non-upload guest subsystems).
 * 3. Never trusts arbitrary client-supplied user IDs or IP headers!
 */
export async function resolveUploadIdentity(req: express.Request): Promise<QuotaIdentity> {
  const authStatus: AuthRequestResult = await authenticateRequest(req);

  // Authenticated user with verified Firebase UID
  if (authStatus.status === 'authenticated' && authStatus.userId) {
    return buildAuthenticatedQuotaIdentity(authStatus.userId);
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

// ==============================================================================
// Distributed Firestore Transaction Engine & Provider
// ==============================================================================

/**
 * Shared in-memory document state representation for testing and offline/local fallback.
 * Allows simulating multiple concurrent serverless instances sharing a single database.
 */
interface StoredDoc {
  data: any;
  version: number;
}

const sharedInMemoryFirestoreStore = new Map<string, StoredDoc>();

export function getSharedInMemoryFirestoreStore(): Map<string, StoredDoc> {
  return sharedInMemoryFirestoreStore;
}

/**
 * Creates an in-memory Firestore transaction adapter implementing the official
 * Firestore transaction interface with optimistic concurrency control, document operations,
 * and collection querying.
 */
export function createSimulatedFirestoreInstance(): any {
  return {
    collection(colName: string) {
      const createQuery = (filters: Array<{ field: string; op: string; value: any }> = []) => ({
        where(field: string, op: string, value: any) {
          return createQuery([...filters, { field, op, value }]);
        },
        async get() {
          const prefix = `${colName}/`;
          const docs: any[] = [];
          for (const [path, stored] of sharedInMemoryFirestoreStore.entries()) {
            if (path.startsWith(prefix)) {
              const docId = path.slice(prefix.length);
              if (!docId.includes('/')) {
                const data = JSON.parse(JSON.stringify(stored.data));
                let matches = true;
                for (const f of filters) {
                  const val = data?.[f.field];
                  if (f.op === '==' && val !== f.value) matches = false;
                  else if (f.op === '<=' && !(val <= f.value)) matches = false;
                  else if (f.op === '>=' && !(val >= f.value)) matches = false;
                  else if (f.op === '<' && !(val < f.value)) matches = false;
                  else if (f.op === '>' && !(val > f.value)) matches = false;
                  else if (f.op === 'in' && Array.isArray(f.value) && !f.value.includes(val)) matches = false;
                }
                if (matches) {
                  docs.push({
                    exists: true,
                    id: docId,
                    path,
                    ref: { id: docId, path, parent: { id: colName } },
                    data: () => data
                  });
                }
              }
            }
          }
          return {
            docs,
            empty: docs.length === 0,
            size: docs.length
          };
        }
      });

      const queryObj = createQuery();

      return {
        ...queryObj,
        doc(docId: string) {
          const docPath = `${colName}/${docId}`;
          const docRef = {
            id: docId,
            path: docPath,
            parent: { id: colName },
            async get() {
              const existing = sharedInMemoryFirestoreStore.get(docPath);
              if (!existing) {
                return {
                  exists: false,
                  id: docId,
                  path: docPath,
                  ref: docRef,
                  data: () => undefined
                };
              }
              return {
                exists: true,
                id: docId,
                path: docPath,
                ref: docRef,
                data: () => JSON.parse(JSON.stringify(existing.data))
              };
            },
            async set(data: any, options: { merge?: boolean } = {}) {
              const current = sharedInMemoryFirestoreStore.get(docPath);
              const merged = options?.merge && current
                ? { ...current.data, ...JSON.parse(JSON.stringify(data)) }
                : JSON.parse(JSON.stringify(data));
              const nextVersion = (current ? current.version : 0) + 1;
              sharedInMemoryFirestoreStore.set(docPath, {
                data: merged,
                version: nextVersion
              });
              return { writeTime: Date.now() };
            },
            async delete() {
              sharedInMemoryFirestoreStore.delete(docPath);
              return { writeTime: Date.now() };
            }
          };
          return docRef;
        }
      };
    },
    async runTransaction<T>(updateFunction: (transaction: any) => Promise<T>): Promise<T> {
      const maxRetries = 10;
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        const readVersions = new Map<string, number>();
        const pendingMutations = new Map<string, any>();
        const deletedInTransaction = new Set<string>();

        const transaction = {
          async get(docRef: any) {
            const path = docRef.path;
            const existing = sharedInMemoryFirestoreStore.get(path);
            readVersions.set(path, existing ? existing.version : 0);

            if (!existing) {
              return {
                exists: false,
                id: docRef.id,
                path: docRef.path,
                ref: docRef,
                data: () => undefined
              };
            }

            return {
              exists: true,
              id: docRef.id,
              path: docRef.path,
              ref: docRef,
              data: () => JSON.parse(JSON.stringify(existing.data))
            };
          },
          set(docRef: any, data: any, options: { merge?: boolean } = {}) {
            const path = docRef.path;
            deletedInTransaction.delete(path);
            if (options.merge) {
              const current = pendingMutations.get(path) ||
                (sharedInMemoryFirestoreStore.has(path)
                  ? JSON.parse(JSON.stringify(sharedInMemoryFirestoreStore.get(path)!.data))
                  : {});
              pendingMutations.set(path, { ...current, ...JSON.parse(JSON.stringify(data)) });
            } else {
              pendingMutations.set(path, JSON.parse(JSON.stringify(data)));
            }
            return transaction;
          },
          update(docRef: any, data: any) {
            return this.set(docRef, data, { merge: true });
          },
          delete(docRef: any) {
            pendingMutations.delete(docRef.path);
            deletedInTransaction.add(docRef.path);
            return transaction;
          }
        };

        try {
          const result = await updateFunction(transaction);

          // Atomic validation: verify that no document read during this transaction was
          // mutated by another concurrent transaction
          let conflict = false;
          for (const [path, expectedVersion] of readVersions.entries()) {
            const current = sharedInMemoryFirestoreStore.get(path);
            const currentVersion = current ? current.version : 0;
            if (currentVersion !== expectedVersion) {
              conflict = true;
              break;
            }
          }

          if (conflict) {
            // Concurrent transaction conflict detected — back off and retry atomically
            await new Promise((r) => setTimeout(r, 5 + Math.random() * 25));
            continue;
          }

          // Commit deletions and mutations atomically
          for (const delPath of deletedInTransaction) {
            sharedInMemoryFirestoreStore.delete(delPath);
          }
          for (const [path, newData] of pendingMutations.entries()) {
            if (!deletedInTransaction.has(path)) {
              const current = sharedInMemoryFirestoreStore.get(path);
              const nextVersion = (current ? current.version : 0) + 1;
              sharedInMemoryFirestoreStore.set(path, {
                data: newData,
                version: nextVersion
              });
            }
          }

          return result;
        } catch (err) {
          // If the updateFunction itself threw an error (like Quota Exceeded), rethrow immediately
          throw err;
        }
      }

      throw new Error('Firestore transaction failed after maximum optimistic concurrency retries');
    }
  };
}

let simulatedFirestoreSingleton: any = null;
let forceProductionModeForTesting: boolean | null = null;

/**
 * Test hook to simulate production deployment fail-closed behavior during automated test suites.
 */
export function setForceProductionModeForTesting(forced: boolean | null): void {
  forceProductionModeForTesting = forced;
}

/**
 * Determines whether the current process is running in a production or serverless deployment.
 */
export function isProductionEnvironment(): boolean {
  if (forceProductionModeForTesting !== null) {
    return forceProductionModeForTesting;
  }
  const isHostedOrProd =
    process.env.NODE_ENV === 'production' ||
    Boolean(process.env.VERCEL) ||
    process.env.VERCEL_ENV === 'production' ||
    process.env.VERCEL_ENV === 'preview' ||
    Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME) ||
    Boolean(process.env.LAMBDA_TASK_ROOT) ||
    Boolean(process.env.SERVERLESS) ||
    Boolean(process.env.RENDER) ||
    Boolean(process.env.FLY_APP_NAME) ||
    Boolean(process.env.RAILWAY_ENVIRONMENT);

  if (isHostedOrProd) {
    return true;
  }
  if (process.env.TESTING === '1' || process.env.TESTING === 'true') {
    return false;
  }
  if ((process.env.K_SERVICE || process.env.CLOUD_RUN_JOB) && process.env.NODE_ENV !== 'development') {
    return true;
  }
  return false;
}

/**
 * Sets a custom Firestore database instance for testing (e.g. simulated serverless instances).
 */
export function setFirestoreForTesting(db: any): void {
  customFirestoreOverride = db;
}

/**
 * Resets Firestore test overrides.
 */
export function resetFirestoreForTesting(): void {
  customFirestoreOverride = null;
  forceProductionModeForTesting = null;
  sharedInMemoryFirestoreStore.clear();
}

/**
 * Resolves Firebase service account credentials from environment variables:
 * Accepts both FIREBASE_SERVICE_ACCOUNT and FIREBASE_SERVICE_ACCOUNT_KEY.
 * Prefers FIREBASE_SERVICE_ACCOUNT if both are set.
 * Returns the raw string and source variable name, or null if neither is configured.
 */
export function getFirebaseServiceAccountCredentials(): { raw: string; sourceVar: string } | null {
  if (process.env.FIREBASE_SERVICE_ACCOUNT && process.env.FIREBASE_SERVICE_ACCOUNT.trim()) {
    return {
      raw: process.env.FIREBASE_SERVICE_ACCOUNT.trim(),
      sourceVar: 'FIREBASE_SERVICE_ACCOUNT'
    };
  }
  if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY && process.env.FIREBASE_SERVICE_ACCOUNT_KEY.trim()) {
    return {
      raw: process.env.FIREBASE_SERVICE_ACCOUNT_KEY.trim(),
      sourceVar: 'FIREBASE_SERVICE_ACCOUNT_KEY'
    };
  }
  return null;
}

/**
 * Safely parses a Firebase Service Account credential string.
 * Supports:
 * 1. Raw JSON string.
 * 2. Base64-encoded JSON string (e.g., standard Vercel environment variable encoding starting with 'ewog...').
 *
 * Validates that the parsed credential is a service-account object before passing it to cert().
 * SECURITY: Never logs or exposes credential contents.
 */
export function parseServiceAccountCredential(raw: string, sourceVar: string): any {
  const trimmed = (raw || '').replace(/^\uFEFF/, '').trim();
  if (!trimmed) {
    const emptyErr: any = new Error(`${sourceVar} is empty.`);
    emptyErr.diagnosticStage = 'service_account_parse';
    throw emptyErr;
  }

  let parsed: any;
  let rawJsonError: Error | null = null;

  // 1. Attempt raw JSON parsing (unwrapping optional outer quotes or double-encoded strings)
  try {
    parsed = JSON.parse(trimmed);
    if (typeof parsed === 'string') {
      try {
        const inner = JSON.parse(parsed);
        if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
          parsed = inner;
        }
      } catch (_) {}
    }
  } catch (err: any) {
    rawJsonError = err;
    if (
      (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"'))
    ) {
      try {
        const unwrapped = JSON.parse(trimmed.slice(1, -1));
        if (unwrapped && typeof unwrapped === 'object' && !Array.isArray(unwrapped)) {
          parsed = unwrapped;
        }
      } catch (_) {}
    }
  }

  // 2. If raw JSON parsing fails, safely attempt Base64 decoding using Node.js Buffer
  if (parsed === undefined) {
    try {
      const candidateB64 =
        (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
        (trimmed.startsWith('"') && trimmed.endsWith('"'))
          ? trimmed.slice(1, -1).trim()
          : trimmed;
      const decoded = Buffer.from(candidateB64, 'base64').toString('utf8');
      parsed = JSON.parse(decoded);
      if (typeof parsed === 'string') {
        try {
          const inner = JSON.parse(parsed);
          if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
            parsed = inner;
          }
        } catch (_) {}
      }
    } catch (_) {
      const parseErr: any = new Error(
        `${sourceVar} contains invalid JSON: ${rawJsonError?.message || 'Failed to parse JSON or Base64-encoded JSON.'}`
      );
      parseErr.diagnosticStage = 'service_account_parse';
      throw parseErr;
    }
  }

  // 3. Validate that the parsed credential is a service-account object
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const typeErr: any = new Error(
      `${sourceVar} contains invalid JSON: Parsed credential must be an object.`
    );
    typeErr.diagnosticStage = 'service_account_parse';
    throw typeErr;
  }

  const isServiceAccount =
    parsed.type === 'service_account' ||
    Boolean(
      (parsed.project_id || parsed.projectId) &&
        (parsed.private_key || parsed.privateKey || parsed.client_email || parsed.clientEmail)
    );

  if (!isServiceAccount) {
    const shapeErr: any = new Error(
      `${sourceVar} contains invalid JSON: Expected a service-account object with type "service_account" or project_id.`
    );
    shapeErr.diagnosticStage = 'service_account_parse';
    throw shapeErr;
  }

  // Normalize literal "\\r\\n" and "\\n" escapes inside PEM private keys pasted into hosting dashboards
  if (
    typeof parsed.private_key === 'string' &&
    (parsed.private_key.includes('\\n') || parsed.private_key.includes('\\r\\n'))
  ) {
    parsed.private_key = parsed.private_key.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n');
  }
  if (
    typeof parsed.privateKey === 'string' &&
    (parsed.privateKey.includes('\\n') || parsed.privateKey.includes('\\r\\n'))
  ) {
    parsed.privateKey = parsed.privateKey.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n');
  }

  return parsed;
}

/**
 * Resolves the Firestore database client to use.
 *
 * PRODUCTION REQUIREMENT:
 * In production or Vercel deployments, Firebase Admin Firestore is MANDATORY.
 * If credentials are missing, invalid, or initialization fails, a clear fatal error is thrown.
 * Never falls back to simulated or in-memory Firestore in production.
 *
 * The in-memory transactional adapter is preserved exclusively for tests and permitted development environments.
 */
export function getFirestoreDb(): any {
  if (customFirestoreOverride) {
    return customFirestoreOverride;
  }

  const isProd = isProductionEnvironment();

  // In production or Vercel deployments, Firebase Admin Firestore is MANDATORY.
  // Never fall back to simulated or in-memory Firestore in production.
  if (isProd) {
    const projectId = getConfiguredFirebaseProjectId();
    if (!projectId) {
      const err: any = new Error(
        '[UploadQuota] Fatal: Production deployment requires a valid FIREBASE_PROJECT_ID (or VITE_FIREBASE_PROJECT_ID). In-memory fallback is strictly forbidden in production.'
      );
      err.diagnosticStage = 'project_id_resolution';
      err._loggedUploadDiagnostic = true;
      logUploadDiagnostic({
        stage: 'project_id_resolution',
        code: 'MISSING_PROJECT_ID',
        message: err.message,
        details: {
          envPresence: {
            FIREBASE_PROJECT_ID: Boolean(process.env.FIREBASE_PROJECT_ID?.trim()),
            VITE_FIREBASE_PROJECT_ID: Boolean(process.env.VITE_FIREBASE_PROJECT_ID?.trim()),
            NEXT_PUBLIC_FIREBASE_PROJECT_ID: Boolean(process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID?.trim()),
            FIREBASE_SERVICE_ACCOUNT: Boolean(process.env.FIREBASE_SERVICE_ACCOUNT?.trim()),
            FIREBASE_SERVICE_ACCOUNT_KEY: Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_KEY?.trim())
          }
        }
      });
      throw err;
    }

    const existingApps = getApps();
    if (existingApps.length > 0) {
      try {
        return getFirestore();
      } catch (err: any) {
        const wrappedErr: any = new Error(
          `[UploadQuota] Fatal: Failed to acquire initialized Firestore instance in production: ${err?.message || err}`
        );
        wrappedErr.diagnosticStage = 'firebase_admin_init';
        wrappedErr._loggedUploadDiagnostic = true;
        logUploadDiagnostic({
          stage: 'firebase_admin_init',
          code: err?.code ? String(err.code) : 'GET_FIRESTORE_FAILED',
          message: wrappedErr.message,
          details: {
            existingAppsCount: existingApps.length
          }
        });
        throw wrappedErr;
      }
    }

    const saCred = getFirebaseServiceAccountCredentials();
    const hasServiceAccount = Boolean(saCred);
    const gacRaw = (process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim();
    const hasGoogleCredentials = Boolean(gacRaw);

    if (!hasServiceAccount && !hasGoogleCredentials) {
      const err: any = new Error(
        '[UploadQuota] Fatal: Production deployment requires Firebase Admin credentials (FIREBASE_SERVICE_ACCOUNT or GOOGLE_APPLICATION_CREDENTIALS). In-memory fallback is strictly forbidden in production.'
      );
      err.diagnosticStage = 'service_account_lookup';
      err._loggedUploadDiagnostic = true;
      logUploadDiagnostic({
        stage: 'service_account_lookup',
        code: 'MISSING_ADMIN_CREDENTIALS',
        message: err.message,
        details: {
          envPresence: {
            FIREBASE_SERVICE_ACCOUNT: false,
            FIREBASE_SERVICE_ACCOUNT_KEY: false,
            GOOGLE_APPLICATION_CREDENTIALS: false
          }
        }
      });
      throw err;
    }

    let saShape: Record<string, boolean> | undefined;
    try {
      if (saCred) {
        const sa = parseServiceAccountCredential(saCred.raw, saCred.sourceVar);
        const pk = sa.private_key || sa.privateKey || '';
        const clientEmail = sa.client_email || sa.clientEmail || '';
        saShape = {
          hasProjectId: Boolean(sa.project_id || sa.projectId),
          hasClientEmail: typeof clientEmail === 'string' && clientEmail.includes('@'),
          hasPrivateKey: typeof pk === 'string' && pk.length > 0,
          privateKeyHasPemHeader: typeof pk === 'string' && pk.includes('-----BEGIN')
        };
        initializeApp({
          credential: cert(sa),
          projectId: sa.project_id || sa.projectId || projectId
        });
      } else {
        initializeApp({ projectId });
      }
      return getFirestore();
    } catch (initErr: any) {
      const stage = initErr?.diagnosticStage || 'firebase_admin_init';
      logUploadDiagnostic({
        stage,
        code: initErr?.code ? String(initErr.code) : stage === 'service_account_parse' ? 'INVALID_SERVICE_ACCOUNT' : 'ADMIN_INIT_FAILED',
        message: initErr?.message || String(initErr),
        details: {
          credentialSource: saCred ? saCred.sourceVar : 'GOOGLE_APPLICATION_CREDENTIALS',
          ...(saShape ? { saShape } : {}),
          ...(!saCred && hasGoogleCredentials
            ? {
                gacLooksLikeJson: gacRaw.startsWith('{'),
                gacFileExists: !gacRaw.startsWith('{') && fs.existsSync(gacRaw)
              }
            : {})
        }
      });
      if (initErr?.message && initErr.message.includes('contains invalid JSON')) {
        initErr._loggedUploadDiagnostic = true;
        throw initErr;
      }
      const wrappedErr: any = new Error(
        `[UploadQuota] Fatal: Failed to initialize Firebase Admin Firestore in production: ${initErr?.message || initErr}`
      );
      wrappedErr.diagnosticStage = stage;
      wrappedErr._loggedUploadDiagnostic = true;
      throw wrappedErr;
    }
  }

  // Development & Testing environment logic:
  // Try connecting to Firebase Admin if configured, otherwise fall back to simulated in-memory Firestore
  try {
    const projectId = getConfiguredFirebaseProjectId();
    const existingApps = getApps();
    if (projectId && existingApps.length > 0) {
      return getFirestore();
    }

    const saCred = getFirebaseServiceAccountCredentials();
    if (projectId && (saCred || process.env.GOOGLE_APPLICATION_CREDENTIALS)) {
      if (existingApps.length === 0) {
        if (saCred) {
          try {
            const sa = parseServiceAccountCredential(saCred.raw, saCred.sourceVar);
            initializeApp({
              credential: cert(sa),
              projectId: sa.project_id || sa.projectId || projectId
            });
          } catch (saErr: any) {
            console.warn(
              '[UploadQuota] Warning: Failed to parse configured Firebase service account in dev/test mode:',
              saErr?.message || saErr
            );
            initializeApp({ projectId });
          }
        } else {
          initializeApp({ projectId });
        }
      }
      return getFirestore();
    }
  } catch (devInitErr: any) {
    console.warn(
      '[UploadQuota] Warning: Firebase Admin initialization failed in dev/test mode; using in-memory Firestore fallback:',
      devInitErr?.message || devInitErr
    );
  }

  // Defense-in-depth: never return in-memory simulated Firestore in production
  if (isProductionEnvironment()) {
    throw new Error('[UploadQuota] Fatal: In-memory Firestore fallback is strictly forbidden in production.');
  }

  // Fallback to resilient in-memory simulated Firestore exclusively in tests and development
  if (!simulatedFirestoreSingleton) {
    simulatedFirestoreSingleton = createSimulatedFirestoreInstance();
  }
  return simulatedFirestoreSingleton;
}

/**
 * Prunes expired reservations from a record in-place.
 */
function pruneExpiredReservations(record: QuotaRecord, nowMs: number): number {
  let activeCount = 0;
  if (!record.reservations || typeof record.reservations !== 'object') {
    record.reservations = {};
    return 0;
  }

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
 * Atomically reserves 1 upload slot for an identity on the current Asia/Karachi (PKT) calendar day
 * using an atomic Firestore transaction.
 * Prevents concurrent requests across serverless instances from exceeding the limit of 5.
 */
export async function reserveUploadSlot(
  identity: QuotaIdentity,
  options: { customNow?: Date } = {}
): Promise<ReservationResult> {
  const now = options.customNow || getCurrentDate();
  const nowMs = now.getTime();
  const pktDay = getPktDayString(now);
  const resetAt = getNextPktMidnight(now).toISOString();
  const docId = `${identity.key}_${pktDay}`;
  const db = getFirestoreDb();

  return await db.runTransaction(async (transaction: any) => {
    const docRef = db.collection('uploadQuotas').doc(docId);
    const snap = await transaction.get(docRef);

    const record: QuotaRecord = (snap.exists && snap.data())
      ? (snap.data() as QuotaRecord)
      : {
          identityKey: identity.key,
          pktDay,
          utcDay: pktDay,
          committed: 0,
          reservations: {},
          lastUpdated: nowMs
        };

    if (!record.pktDay) {
      record.pktDay = record.utcDay || pktDay;
    }
    if (!record.utcDay) {
      record.utcDay = record.pktDay;
    }
    if (!record.reservations || typeof record.reservations !== 'object') {
      record.reservations = {};
    }
    if (typeof record.committed !== 'number') {
      record.committed = 0;
    }

    const activeReservationsCount = pruneExpiredReservations(record, nowMs);
    const totalUsage = record.committed + activeReservationsCount;

    if (totalUsage >= DAILY_UPLOAD_LIMIT) {
      const remaining = Math.max(0, DAILY_UPLOAD_LIMIT - totalUsage);
      return {
        allowed: false as const,
        limit: DAILY_UPLOAD_LIMIT,
        remaining,
        resetAt,
        error: `Daily attachment upload limit of ${DAILY_UPLOAD_LIMIT} uploads per day exceeded. Quota resets at midnight PKT.`
      };
    }

    const reservationId = 'res_' + crypto.randomUUID();
    const expiresAt = nowMs + RESERVATION_TTL_MS;

    record.reservations[reservationId] = {
      expiresAt,
      createdAt: nowMs
    };
    record.lastUpdated = nowMs;

    transaction.set(docRef, record, { merge: true });

    const remaining = Math.max(0, DAILY_UPLOAD_LIMIT - (record.committed + activeReservationsCount + 1));

    return {
      allowed: true as const,
      reservation: {
        reservationId,
        identityKey: identity.key,
        pktDay,
        utcDay: pktDay,
        expiresAt,
        createdAt: nowMs
      },
      remaining,
      resetAt,
      limit: DAILY_UPLOAD_LIMIT
    };
  });
}

function computeCurrentDayStatusFromSnapshot(
  snap: any,
  nowMs: number,
  resetAt: string,
  currentDay: string
): QuotaStatus {
  if (!snap || !snap.exists || !snap.data()) {
    return {
      limit: DAILY_UPLOAD_LIMIT,
      committed: 0,
      activeReservations: 0,
      remaining: DAILY_UPLOAD_LIMIT,
      resetAt,
      pktDay: currentDay,
      utcDay: currentDay
    };
  }

  const raw = snap.data() as QuotaRecord;
  const clonedRecord: QuotaRecord = {
    ...raw,
    reservations: raw.reservations && typeof raw.reservations === 'object' ? { ...raw.reservations } : {}
  };
  const activeCount = pruneExpiredReservations(clonedRecord, nowMs);
  const committed = typeof clonedRecord.committed === 'number' ? clonedRecord.committed : 0;
  const remaining = Math.max(0, DAILY_UPLOAD_LIMIT - (committed + activeCount));

  return {
    limit: DAILY_UPLOAD_LIMIT,
    committed,
    activeReservations: activeCount,
    remaining,
    resetAt,
    pktDay: currentDay,
    utcDay: currentDay
  };
}

/**
 * Commits a reservation upon successful upload completion within an atomic Firestore transaction.
 *
 * Expiration Invariant (Requirement 5):
 * If a reservation expired before completion:
 * - It checks whether other active reservations or committed uploads now consume the quota.
 * - If committed + other active reservations >= DAILY_UPLOAD_LIMIT, the expired reservation CANNOT commit
 *   and throws QUOTA_EXCEEDED, ensuring expired reservations never cause active uploads to exceed quota.
 * - Otherwise, it safely commits the upload without exceeding the quota.
 *
 * Cross-Midnight PKT Handling:
 * If a reservation was created before midnight PKT and completes after midnight PKT,
 * accounting stays on the original reservation day (`reservation.pktDay || reservation.utcDay`), while the
 * returned QuotaStatus reflects the current PKT day.
 */
export async function commitUploadSlot(
  reservation: QuotaReservation,
  options: { customNow?: Date } = {}
): Promise<QuotaStatus> {
  const now = options.customNow || getCurrentDate();
  const nowMs = now.getTime();
  const currentDay = getPktDayString(now);
  const resetAt = getNextPktMidnight(now).toISOString();
  const reservationDay = reservation.pktDay || reservation.utcDay;
  const docId = `${reservation.identityKey}_${reservationDay}`;
  const isCrossMidnight = reservationDay !== currentDay;
  const db = getFirestoreDb();

  return await db.runTransaction(async (transaction: any) => {
    const docRef = db.collection('uploadQuotas').doc(docId);
    const currentDocRef = isCrossMidnight
      ? db.collection('uploadQuotas').doc(`${reservation.identityKey}_${currentDay}`)
      : docRef;

    const snap = await transaction.get(docRef);
    const currentSnap = isCrossMidnight ? await transaction.get(currentDocRef) : snap;

    const record: QuotaRecord = (snap.exists && snap.data())
      ? (snap.data() as QuotaRecord)
      : {
          identityKey: reservation.identityKey,
          pktDay: reservationDay,
          utcDay: reservationDay,
          committed: 0,
          reservations: {},
          lastUpdated: nowMs
        };

    if (!record.pktDay) {
      record.pktDay = record.utcDay || reservationDay;
    }
    if (!record.utcDay) {
      record.utcDay = record.pktDay;
    }
    if (!record.reservations || typeof record.reservations !== 'object') {
      record.reservations = {};
    }
    if (typeof record.committed !== 'number') {
      record.committed = 0;
    }

    const targetRes = record.reservations[reservation.reservationId];
    const isTargetStillValid = targetRes && targetRes.expiresAt > nowMs;

    // Prune all other expired reservations
    let otherActiveCount = 0;
    for (const [resId, res] of Object.entries(record.reservations)) {
      if (resId === reservation.reservationId) continue;
      if (!res || typeof res.expiresAt !== 'number' || res.expiresAt <= nowMs) {
        delete record.reservations[resId];
      } else {
        otherActiveCount++;
      }
    }

    // 1. Normal path: target reservation is active and unexpired
    if (isTargetStillValid) {
      delete record.reservations[reservation.reservationId];
      record.committed = Math.min(DAILY_UPLOAD_LIMIT, record.committed + 1);
      record.lastUpdated = nowMs;

      transaction.set(docRef, record, { merge: true });

      if (isCrossMidnight) {
        return computeCurrentDayStatusFromSnapshot(currentSnap, nowMs, resetAt, currentDay);
      }

      const remaining = Math.max(0, DAILY_UPLOAD_LIMIT - (record.committed + otherActiveCount));
      return {
        limit: DAILY_UPLOAD_LIMIT,
        committed: record.committed,
        activeReservations: otherActiveCount,
        remaining,
        resetAt,
        pktDay: currentDay,
        utcDay: currentDay
      };
    }

    // 2. Expired reservation path:
    // Check if committing this expired reservation would cause active uploads or committed total to exceed quota
    if (record.committed + otherActiveCount >= DAILY_UPLOAD_LIMIT) {
      // Quota is full! Active uploads or committed slots occupy all available quota.
      delete record.reservations[reservation.reservationId];
      record.lastUpdated = nowMs;
      transaction.set(docRef, record, { merge: true });

      const responseStatus = isCrossMidnight
        ? computeCurrentDayStatusFromSnapshot(currentSnap, nowMs, resetAt, currentDay)
        : {
            limit: DAILY_UPLOAD_LIMIT,
            committed: record.committed,
            activeReservations: otherActiveCount,
            remaining: 0,
            resetAt,
            pktDay: currentDay,
            utcDay: currentDay
          };

      const error: any = new Error(
        `Upload reservation ${reservation.reservationId} expired and daily quota is exhausted.`
      );
      error.code = 'QUOTA_EXCEEDED';
      error.status = 'QUOTA_EXCEEDED';
      error.limit = DAILY_UPLOAD_LIMIT;
      error.remaining = responseStatus.remaining;
      error.resetAt = resetAt;
      error.pktDay = currentDay;
      error.utcDay = currentDay;
      error.currentDayStatus = responseStatus;
      throw error;
    }

    // Unclaimed slot exists: safely commit on the reservation's original day
    delete record.reservations[reservation.reservationId];
    record.committed = Math.min(DAILY_UPLOAD_LIMIT, record.committed + 1);
    record.lastUpdated = nowMs;

    transaction.set(docRef, record, { merge: true });

    if (isCrossMidnight) {
      return computeCurrentDayStatusFromSnapshot(currentSnap, nowMs, resetAt, currentDay);
    }

    const remaining = Math.max(0, DAILY_UPLOAD_LIMIT - (record.committed + otherActiveCount));
    return {
      limit: DAILY_UPLOAD_LIMIT,
      committed: record.committed,
      activeReservations: otherActiveCount,
      remaining,
      resetAt,
      pktDay: currentDay,
      utcDay: currentDay
    };
  });
}

/**
 * Releases a reserved slot when an upload fails or is cancelled within an atomic Firestore transaction.
 * Does NOT increment committed count, ensuring failed uploads never consume quota.
 *
 * Cross-Midnight PKT Handling:
 * Removes the reservation from its original day (`reservation.pktDay || reservation.utcDay`), while returning
 * the current PKT day's quota status.
 */
export async function releaseUploadSlot(
  reservation: QuotaReservation,
  options: { customNow?: Date } = {}
): Promise<QuotaStatus> {
  const now = options.customNow || getCurrentDate();
  const nowMs = now.getTime();
  const currentDay = getPktDayString(now);
  const resetAt = getNextPktMidnight(now).toISOString();
  const reservationDay = reservation.pktDay || reservation.utcDay;
  const docId = `${reservation.identityKey}_${reservationDay}`;
  const isCrossMidnight = reservationDay !== currentDay;
  const db = getFirestoreDb();

  return await db.runTransaction(async (transaction: any) => {
    const docRef = db.collection('uploadQuotas').doc(docId);
    const currentDocRef = isCrossMidnight
      ? db.collection('uploadQuotas').doc(`${reservation.identityKey}_${currentDay}`)
      : docRef;

    const snap = await transaction.get(docRef);
    const currentSnap = isCrossMidnight ? await transaction.get(currentDocRef) : snap;

    if (!snap.exists || !snap.data()) {
      if (isCrossMidnight) {
        return computeCurrentDayStatusFromSnapshot(currentSnap, nowMs, resetAt, currentDay);
      }
      return {
        limit: DAILY_UPLOAD_LIMIT,
        committed: 0,
        activeReservations: 0,
        remaining: DAILY_UPLOAD_LIMIT,
        resetAt,
        pktDay: currentDay,
        utcDay: currentDay
      };
    }

    const record = snap.data() as QuotaRecord;
    if (!record.pktDay) {
      record.pktDay = record.utcDay || reservationDay;
    }
    if (!record.utcDay) {
      record.utcDay = record.pktDay;
    }
    if (!record.reservations || typeof record.reservations !== 'object') {
      record.reservations = {};
    }

    delete record.reservations[reservation.reservationId];
    const activeCount = pruneExpiredReservations(record, nowMs);

    record.lastUpdated = nowMs;
    transaction.set(docRef, record, { merge: true });

    if (isCrossMidnight) {
      return computeCurrentDayStatusFromSnapshot(currentSnap, nowMs, resetAt, currentDay);
    }

    const remaining = Math.max(0, DAILY_UPLOAD_LIMIT - ((record.committed || 0) + activeCount));
    return {
      limit: DAILY_UPLOAD_LIMIT,
      committed: record.committed || 0,
      activeReservations: activeCount,
      remaining,
      resetAt,
      pktDay: currentDay,
      utcDay: currentDay
    };
  });
}

/**
 * Retrieves the current quota status for an identity without modifying committed records.
 */
export async function getQuotaStatus(
  identity: QuotaIdentity,
  options: { customNow?: Date } = {}
): Promise<QuotaStatus> {
  const now = options.customNow || getCurrentDate();
  const nowMs = now.getTime();
  const pktDay = getPktDayString(now);
  const resetAt = getNextPktMidnight(now).toISOString();
  const docId = `${identity.key}_${pktDay}`;
  const db = getFirestoreDb();

  try {
    return await db.runTransaction(async (transaction: any) => {
      const docRef = db.collection('uploadQuotas').doc(docId);
      const snap = await transaction.get(docRef);

      return computeCurrentDayStatusFromSnapshot(snap, nowMs, resetAt, pktDay);
    });
  } catch (txErr: any) {
    if (!txErr?.diagnosticStage) {
      txErr.diagnosticStage = 'firestore_transaction';
    }
    if (!txErr?._loggedUploadDiagnostic) {
      txErr._loggedUploadDiagnostic = true;
      logUploadDiagnostic({
        stage: txErr.diagnosticStage,
        code: txErr?.code !== undefined ? String(txErr.code) : 'FIRESTORE_TRANSACTION_FAILED',
        message: txErr?.message || String(txErr),
        details: {
          operation: 'getQuotaStatus',
          collection: 'uploadQuotas'
        }
      });
    }
    throw txErr;
  }
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
 * Testing utility: Clears quota records in Firestore and on disk.
 */
export async function resetQuotaForTesting(identityKey?: string): Promise<void> {
  // Clear simulated in-memory Firestore records
  if (identityKey) {
    for (const key of Array.from(sharedInMemoryFirestoreStore.keys())) {
      if (key.includes(identityKey)) {
        sharedInMemoryFirestoreStore.delete(key);
      }
    }
  } else {
    sharedInMemoryFirestoreStore.clear();
  }

  // Clear legacy directory files if any existed
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
