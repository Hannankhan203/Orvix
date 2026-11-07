import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type {
  VerifiedUserIdentity,
  QuotaReservation,
  QuotaStatus,
  QuotaStorageDriver,
  QuotaInfrastructureStatus
} from './serverTypes.ts';
import { resolveUploadDirectory } from './uploadSubsystem.ts';

export const DAILY_LIMIT_ATTACHMENTS = 5;
export const DAILY_LIMIT_ERROR_CODE = 'DAILY_LIMIT_EXCEEDED';
export const DAILY_LIMIT_EXCEEDED_MESSAGE =
  'Daily attachment limit reached. You can upload a maximum of 5 PDFs and images per UTC day.';

export const DAILY_LIMIT_ERROR_RESPONSE = {
  error: DAILY_LIMIT_EXCEEDED_MESSAGE,
  code: DAILY_LIMIT_ERROR_CODE
};

// Supported quota-tracked file extensions (PDF + Images)
export const QUOTA_TRACKED_EXTENSIONS = new Set([
  '.pdf',
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.bmp',
  '.heic',
  '.heif'
]);

export const QUOTA_TRACKED_MIMES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/pjpeg',
  'image/jpg',
  'image/png',
  'image/x-png',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/x-ms-bmp',
  'image/x-bmp',
  'image/heic',
  'image/heif'
]);

// 5 minutes reservation TTL before automatic timeout reclamation
export const RESERVATION_TTL_MS = 5 * 60 * 1000;
// Maximum wait time for atomic file lock acquisition (3000ms)
const LOCK_TIMEOUT_MS = 3000;
const LOCK_STALE_MS = 6000;

let quotaStorageDirOverride: string | null = null;

export function _setQuotaStorageDirForTesting(dir: string | null): void {
  quotaStorageDirOverride = dir;
}

export function getQuotaStorageDirectory(): string {
  if (quotaStorageDirOverride) {
    try {
      if (!fs.existsSync(quotaStorageDirOverride)) {
        fs.mkdirSync(quotaStorageDirOverride, { recursive: true });
      }
      return quotaStorageDirOverride;
    } catch (_) {}
  }

  const baseDir = resolveUploadDirectory();
  const quotaDir = path.join(baseDir, 'quota');
  try {
    if (!fs.existsSync(quotaDir)) {
      fs.mkdirSync(quotaDir, { recursive: true });
    }
  } catch (_) {}
  return quotaDir;
}

/**
 * Checks whether an attachment is a quota-tracked format (PDF or image).
 * Non-PDF/image documents (e.g. TXT, DOCX, CSV, JSON, MD) return false.
 *
 * @param file - Multer file object, attachment metadata object, or string filename/MIME
 */
export function isQuotaTrackedAttachment(file: any): boolean {
  if (!file) return false;

  let ext = '';
  let mime = '';

  if (typeof file === 'string') {
    const trimmed = file.trim().toLowerCase();
    if (trimmed.startsWith('image/')) return true;
    if (trimmed === 'application/pdf') return true;
    ext = path.extname(trimmed);
    if (!ext && trimmed.startsWith('.')) ext = trimmed;
  } else if (typeof file === 'object') {
    const originalName = file.originalname || file.name || file.filename || file.originalName || '';
    if (typeof originalName === 'string') {
      ext = path.extname(originalName).toLowerCase();
    }
    if (!ext && typeof file.extension === 'string') {
      const cleanExt = file.extension.trim().toLowerCase().replace(/^\.+/, '');
      ext = cleanExt ? `.${cleanExt}` : '';
    }
    if (!ext && typeof file.format === 'string') {
      const cleanFormat = file.format.trim().toLowerCase().replace(/^\.+/, '');
      ext = cleanFormat ? `.${cleanFormat}` : '';
    }

    mime = (file.mimetype || file.type || file.mimeType || '').toLowerCase();
  }

  if (ext && QUOTA_TRACKED_EXTENSIONS.has(ext)) {
    return true;
  }

  if (mime) {
    if (mime.startsWith('image/')) return true;
    if (mime === 'application/pdf') return true;
    if (QUOTA_TRACKED_MIMES.has(mime)) return true;
  }

  return false;
}

/**
 * Returns the standard UTC date key in YYYY-MM-DD format.
 *
 * @param date - Optional Date object, timestamp, or date string (defaults to current UTC time)
 */
export function getUtcDateKey(date: Date | string | number = new Date()): string {
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }
  return d.toISOString().slice(0, 10);
}

/**
 * Resolves an isolated, canonical storage key for the given identity.
 * Authenticated and guest users are partitioned with distinct prefixes.
 */
export function resolveUserQuotaKey(identity: VerifiedUserIdentity): string {
  if (!identity || !identity.uid) {
    return 'guest:anonymous';
  }
  const cleanUid = String(identity.uid).trim();
  if (identity.type === 'authenticated' && !identity.isGuest) {
    return `auth:${cleanUid}`;
  }
  return `guest:${cleanUid}`;
}

function getSafeFileSlug(userKey: string, utcDate: string): string {
  const sanitized = `${userKey}_${utcDate}`.replace(/[^a-zA-Z0-9_-]/g, '_');
  const hash = crypto.createHash('sha256').update(`${userKey}_${utcDate}`).digest('hex').slice(0, 12);
  return `${sanitized.slice(0, 60)}_${hash}`;
}

interface StoredQuotaRecord {
  userKey: string;
  utcDate: string;
  committedCount: number;
  reservations: Record<string, { reservedAt: number; expiresAt: number }>;
  updatedAt: number;
}

function pruneStaleReservations(record: StoredQuotaRecord): void {
  const now = Date.now();
  if (!record.reservations) {
    record.reservations = {};
    return;
  }
  for (const [id, res] of Object.entries(record.reservations)) {
    if (!res || typeof res.expiresAt !== 'number' || res.expiresAt <= now) {
      delete record.reservations[id];
    }
  }
}

function countActiveReservations(record: StoredQuotaRecord): number {
  pruneStaleReservations(record);
  return Object.keys(record.reservations).length;
}

// ===========================================================================
// Driver 1: LocalFilesystemAtomicDriver
// Uses POSIX atomic file locking (O_CREAT | O_EXCL via 'wx') on shared local disk.
// Works across processes on a single filesystem, but NOT across serverless instances.
// ===========================================================================
export class LocalFilesystemAtomicDriver implements QuotaStorageDriver {
  getDriverName(): string {
    return 'local-filesystem';
  }

  isDistributed(): boolean {
    return false;
  }

  private async withAtomicLock<T>(
    userKey: string,
    utcDate: string,
    operation: (recordFilePath: string) => Promise<T> | T
  ): Promise<T> {
    const quotaDir = getQuotaStorageDirectory();
    const slug = getSafeFileSlug(userKey, utcDate);
    const lockFilePath = path.join(quotaDir, `${slug}.lock`);
    const recordFilePath = path.join(quotaDir, `${slug}.json`);

    const startTime = Date.now();
    let lockFd: number | null = null;

    while (Date.now() - startTime < LOCK_TIMEOUT_MS) {
      try {
        lockFd = fs.openSync(lockFilePath, 'wx');
        break;
      } catch (err: any) {
        if (err?.code === 'EEXIST') {
          try {
            const stats = fs.statSync(lockFilePath);
            if (Date.now() - stats.mtimeMs > LOCK_STALE_MS) {
              try {
                fs.unlinkSync(lockFilePath);
              } catch (_) {}
            }
          } catch (_) {}
          const jitter = Math.floor(Math.random() * 25) + 10;
          await new Promise((r) => setTimeout(r, jitter));
        } else {
          throw err;
        }
      }
    }

    if (lockFd === null) {
      throw new Error(`Timeout acquiring atomic quota lock for ${userKey} (${utcDate})`);
    }

    try {
      return await operation(recordFilePath);
    } finally {
      try {
        fs.closeSync(lockFd);
      } catch (_) {}
      try {
        fs.unlinkSync(lockFilePath);
      } catch (_) {}
    }
  }

  private readRecordFromFile(recordFilePath: string, userKey: string, utcDate: string): StoredQuotaRecord {
    if (fs.existsSync(recordFilePath)) {
      try {
        const raw = fs.readFileSync(recordFilePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.committedCount === 'number') {
          return {
            userKey,
            utcDate,
            committedCount: parsed.committedCount,
            reservations: parsed.reservations || {},
            updatedAt: parsed.updatedAt || Date.now()
          };
        }
      } catch (_) {}
    }
    return {
      userKey,
      utcDate,
      committedCount: 0,
      reservations: {},
      updatedAt: Date.now()
    };
  }

  private writeRecordToFile(recordFilePath: string, record: StoredQuotaRecord): void {
    const tmpPath = `${recordFilePath}.${crypto.randomUUID()}.tmp`;
    record.updatedAt = Date.now();
    fs.writeFileSync(tmpPath, JSON.stringify(record), 'utf8');
    fs.renameSync(tmpPath, recordFilePath);
  }

  async reserve(identity: VerifiedUserIdentity, file: any, utcDate: string): Promise<QuotaReservation> {
    const tracked = isQuotaTrackedAttachment(file);
    if (!tracked) {
      return {
        allowed: true,
        quotaTracked: false,
        reservationId: null,
        remaining: DAILY_LIMIT_ATTACHMENTS,
        _status: 'committed'
      };
    }

    const userKey = resolveUserQuotaKey(identity);

    return this.withAtomicLock(userKey, utcDate, (recordFilePath) => {
      const record = this.readRecordFromFile(recordFilePath, userKey, utcDate);
      const activeReserved = countActiveReservations(record);
      const totalActive = record.committedCount + activeReserved;

      if (totalActive >= DAILY_LIMIT_ATTACHMENTS) {
        return {
          allowed: false,
          quotaTracked: true,
          userKey,
          utcDate,
          currentCount: totalActive,
          remaining: 0,
          status: 429,
          code: DAILY_LIMIT_ERROR_CODE,
          error: DAILY_LIMIT_EXCEEDED_MESSAGE
        };
      }

      const reservationId = `res_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
      const now = Date.now();
      record.reservations[reservationId] = {
        reservedAt: now,
        expiresAt: now + RESERVATION_TTL_MS
      };

      this.writeRecordToFile(recordFilePath, record);

      const newActive = totalActive + 1;
      return {
        allowed: true,
        quotaTracked: true,
        reservationId,
        userKey,
        utcDate,
        currentCount: newActive,
        remaining: Math.max(0, DAILY_LIMIT_ATTACHMENTS - newActive),
        _status: 'reserved'
      };
    });
  }

  async commit(
    reservation: QuotaReservation
  ): Promise<{ success: boolean; committed: boolean; alreadyFinalized?: boolean; committedCount?: number }> {
    if (!reservation || !reservation.quotaTracked || !reservation.reservationId) {
      return { success: true, committed: false };
    }

    if (reservation._status === 'committed') {
      return { success: true, committed: false, alreadyFinalized: true };
    }

    const userKey = reservation.userKey || 'unknown';
    const utcDate = reservation.utcDate || getUtcDateKey();
    const reservationId = reservation.reservationId;

    return this.withAtomicLock(userKey, utcDate, (recordFilePath) => {
      const record = this.readRecordFromFile(recordFilePath, userKey, utcDate);
      if (!record.reservations || !record.reservations[reservationId]) {
        return { success: true, committed: false, alreadyFinalized: true };
      }

      delete record.reservations[reservationId];
      record.committedCount += 1;
      this.writeRecordToFile(recordFilePath, record);

      reservation._status = 'committed';
      return {
        success: true,
        committed: true,
        committedCount: record.committedCount
      };
    });
  }

  async release(
    reservation: QuotaReservation
  ): Promise<{ success: boolean; released: boolean; alreadyFinalized?: boolean }> {
    if (!reservation || !reservation.quotaTracked || !reservation.reservationId) {
      return { success: true, released: false };
    }

    if (reservation._status === 'released' || reservation._status === 'committed') {
      return { success: true, released: false, alreadyFinalized: true };
    }

    const userKey = reservation.userKey || 'unknown';
    const utcDate = reservation.utcDate || getUtcDateKey();
    const reservationId = reservation.reservationId;

    return this.withAtomicLock(userKey, utcDate, (recordFilePath) => {
      const record = this.readRecordFromFile(recordFilePath, userKey, utcDate);
      if (!record.reservations || !record.reservations[reservationId]) {
        return { success: true, released: false, alreadyFinalized: true };
      }

      delete record.reservations[reservationId];
      this.writeRecordToFile(recordFilePath, record);

      reservation._status = 'released';
      return {
        success: true,
        released: true
      };
    });
  }

  async getStatus(identity: VerifiedUserIdentity, utcDate: string): Promise<QuotaStatus> {
    const userKey = resolveUserQuotaKey(identity);

    return this.withAtomicLock(userKey, utcDate, (recordFilePath) => {
      const record = this.readRecordFromFile(recordFilePath, userKey, utcDate);
      const activeReserved = countActiveReservations(record);
      const totalActive = record.committedCount + activeReserved;
      return {
        userKey,
        utcDate,
        committedCount: record.committedCount,
        reservedCount: activeReserved,
        activeCount: totalActive,
        remaining: Math.max(0, DAILY_LIMIT_ATTACHMENTS - totalActive),
        limit: DAILY_LIMIT_ATTACHMENTS
      };
    });
  }

  async reset(identity: VerifiedUserIdentity, utcDate: string): Promise<void> {
    const userKey = resolveUserQuotaKey(identity);

    await this.withAtomicLock(userKey, utcDate, (recordFilePath) => {
      if (fs.existsSync(recordFilePath)) {
        try {
          fs.unlinkSync(recordFilePath);
        } catch (_) {}
      }
    });
  }
}

// ===========================================================================
// Driver 2: FirestoreDistributedDriver
// Designed for server-side transactions via Firebase Admin SDK.
// Enforces serializable optimistic concurrency control (OCC) across all
// serverless instances worldwide without weakening client Firestore security rules.
// ===========================================================================
export class FirestoreDistributedDriver implements QuotaStorageDriver {
  private firestoreInstance: any = null;
  private readonly collectionName = 'systemDailyQuotas';

  constructor(customFirestoreInstance?: any) {
    if (customFirestoreInstance) {
      this.firestoreInstance = customFirestoreInstance;
    }
  }

  getDriverName(): string {
    return 'firestore-admin-distributed';
  }

  isDistributed(): boolean {
    return true;
  }

  private getFirestore(): any {
    if (this.firestoreInstance) {
      return this.firestoreInstance;
    }
    throw new Error(
      'FirestoreDistributedDriver requires an initialized Firebase Admin Firestore instance. ' +
      'Missing FIREBASE_SERVICE_ACCOUNT_KEY or GOOGLE_APPLICATION_CREDENTIALS.'
    );
  }

  private getDocRef(userKey: string, utcDate: string): any {
    const db = this.getFirestore();
    const docId = `${userKey}_${utcDate}`;
    return db.collection(this.collectionName).doc(docId);
  }

  async reserve(identity: VerifiedUserIdentity, file: any, utcDate: string): Promise<QuotaReservation> {
    const tracked = isQuotaTrackedAttachment(file);
    if (!tracked) {
      return {
        allowed: true,
        quotaTracked: false,
        reservationId: null,
        remaining: DAILY_LIMIT_ATTACHMENTS,
        _status: 'committed'
      };
    }

    const userKey = resolveUserQuotaKey(identity);
    const db = this.getFirestore();
    const docRef = this.getDocRef(userKey, utcDate);

    return db.runTransaction(async (transaction: any) => {
      const snap = await transaction.get(docRef);
      const data: StoredQuotaRecord = snap.exists
        ? (snap.data() as StoredQuotaRecord)
        : { userKey, utcDate, committedCount: 0, reservations: {}, updatedAt: Date.now() };

      const activeReserved = countActiveReservations(data);
      const totalActive = (data.committedCount || 0) + activeReserved;

      if (totalActive >= DAILY_LIMIT_ATTACHMENTS) {
        return {
          allowed: false,
          quotaTracked: true,
          userKey,
          utcDate,
          currentCount: totalActive,
          remaining: 0,
          status: 429,
          code: DAILY_LIMIT_ERROR_CODE,
          error: DAILY_LIMIT_EXCEEDED_MESSAGE
        };
      }

      const reservationId = `res_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
      const now = Date.now();
      data.reservations = data.reservations || {};
      data.reservations[reservationId] = {
        reservedAt: now,
        expiresAt: now + RESERVATION_TTL_MS
      };
      data.updatedAt = now;

      transaction.set(docRef, data, { merge: true });

      const newActive = totalActive + 1;
      return {
        allowed: true,
        quotaTracked: true,
        reservationId,
        userKey,
        utcDate,
        currentCount: newActive,
        remaining: Math.max(0, DAILY_LIMIT_ATTACHMENTS - newActive),
        _status: 'reserved'
      };
    });
  }

  async commit(
    reservation: QuotaReservation
  ): Promise<{ success: boolean; committed: boolean; alreadyFinalized?: boolean; committedCount?: number }> {
    if (!reservation || !reservation.quotaTracked || !reservation.reservationId) {
      return { success: true, committed: false };
    }

    if (reservation._status === 'committed') {
      return { success: true, committed: false, alreadyFinalized: true };
    }

    const userKey = reservation.userKey || 'unknown';
    const utcDate = reservation.utcDate || getUtcDateKey();
    const reservationId = reservation.reservationId;
    const db = this.getFirestore();
    const docRef = this.getDocRef(userKey, utcDate);

    return db.runTransaction(async (transaction: any) => {
      const snap = await transaction.get(docRef);
      if (!snap.exists) {
        return { success: true, committed: false, alreadyFinalized: true };
      }

      const data = snap.data() as StoredQuotaRecord;
      if (!data.reservations || !data.reservations[reservationId]) {
        return { success: true, committed: false, alreadyFinalized: true };
      }

      delete data.reservations[reservationId];
      data.committedCount = (data.committedCount || 0) + 1;
      data.updatedAt = Date.now();

      transaction.set(docRef, data, { merge: true });
      reservation._status = 'committed';

      return {
        success: true,
        committed: true,
        committedCount: data.committedCount
      };
    });
  }

  async release(
    reservation: QuotaReservation
  ): Promise<{ success: boolean; released: boolean; alreadyFinalized?: boolean }> {
    if (!reservation || !reservation.quotaTracked || !reservation.reservationId) {
      return { success: true, released: false };
    }

    if (reservation._status === 'released' || reservation._status === 'committed') {
      return { success: true, released: false, alreadyFinalized: true };
    }

    const userKey = reservation.userKey || 'unknown';
    const utcDate = reservation.utcDate || getUtcDateKey();
    const reservationId = reservation.reservationId;
    const db = this.getFirestore();
    const docRef = this.getDocRef(userKey, utcDate);

    return db.runTransaction(async (transaction: any) => {
      const snap = await transaction.get(docRef);
      if (!snap.exists) {
        return { success: true, released: false, alreadyFinalized: true };
      }

      const data = snap.data() as StoredQuotaRecord;
      if (!data.reservations || !data.reservations[reservationId]) {
        return { success: true, released: false, alreadyFinalized: true };
      }

      delete data.reservations[reservationId];
      data.updatedAt = Date.now();

      transaction.set(docRef, data, { merge: true });
      reservation._status = 'released';

      return {
        success: true,
        released: true
      };
    });
  }

  async getStatus(identity: VerifiedUserIdentity, utcDate: string): Promise<QuotaStatus> {
    const userKey = resolveUserQuotaKey(identity);
    const docRef = this.getDocRef(userKey, utcDate);
    const snap = await docRef.get();

    if (!snap.exists) {
      return {
        userKey,
        utcDate,
        committedCount: 0,
        reservedCount: 0,
        activeCount: 0,
        remaining: DAILY_LIMIT_ATTACHMENTS,
        limit: DAILY_LIMIT_ATTACHMENTS
      };
    }

    const data = snap.data() as StoredQuotaRecord;
    const activeReserved = countActiveReservations(data);
    const totalActive = (data.committedCount || 0) + activeReserved;

    return {
      userKey,
      utcDate,
      committedCount: data.committedCount || 0,
      reservedCount: activeReserved,
      activeCount: totalActive,
      remaining: Math.max(0, DAILY_LIMIT_ATTACHMENTS - totalActive),
      limit: DAILY_LIMIT_ATTACHMENTS
    };
  }

  async reset(identity: VerifiedUserIdentity, utcDate: string): Promise<void> {
    const userKey = resolveUserQuotaKey(identity);
    const docRef = this.getDocRef(userKey, utcDate);
    await docRef.delete();
  }
}

// ===========================================================================
// Driver 3: SimulatedDistributedClusterDriver
// Simulates an asynchronous, remote distributed transaction store (such as
// a remote Redis cluster or Firestore instance) accessed across simulated
// isolated serverless micro-instances without shared local files.
// Used for automated verification of distributed race condition behavior.
// ===========================================================================
export class SimulatedDistributedClusterDriver implements QuotaStorageDriver {
  private static sharedClusterStorage: Map<string, StoredQuotaRecord> = new Map();
  private static clusterMutex: Map<string, Promise<void>> = new Map();

  getDriverName(): string {
    return 'simulated-distributed-cluster';
  }

  isDistributed(): boolean {
    return true;
  }

  private async executeAtomicDistributedTransaction<T>(
    key: string,
    operation: (record: StoredQuotaRecord) => Promise<{ result: T; updatedRecord?: StoredQuotaRecord }>
  ): Promise<T> {
    // Simulate remote network latency (5-20ms)
    await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 15) + 5));

    while (SimulatedDistributedClusterDriver.clusterMutex.has(key)) {
      await SimulatedDistributedClusterDriver.clusterMutex.get(key);
      await new Promise((r) => setTimeout(r, 5));
    }

    let releaseMutex: () => void = () => {};
    const lockPromise = new Promise<void>((resolve) => {
      releaseMutex = resolve;
    });
    SimulatedDistributedClusterDriver.clusterMutex.set(key, lockPromise);

    try {
      let record: StoredQuotaRecord;
      const existing = SimulatedDistributedClusterDriver.sharedClusterStorage.get(key);
      if (!existing) {
        const [userKey, utcDate] = key.split('::');
        record = {
          userKey,
          utcDate,
          committedCount: 0,
          reservations: {},
          updatedAt: Date.now()
        };
      } else {
        // Deep clone to simulate transaction snapshot isolation
        record = JSON.parse(JSON.stringify(existing));
      }

      const { result, updatedRecord } = await operation(record);
      if (updatedRecord) {
        SimulatedDistributedClusterDriver.sharedClusterStorage.set(key, updatedRecord);
      }
      return result;
    } finally {
      SimulatedDistributedClusterDriver.clusterMutex.delete(key);
      releaseMutex();
    }
  }

  async reserve(identity: VerifiedUserIdentity, file: any, utcDate: string): Promise<QuotaReservation> {
    const tracked = isQuotaTrackedAttachment(file);
    if (!tracked) {
      return {
        allowed: true,
        quotaTracked: false,
        reservationId: null,
        remaining: DAILY_LIMIT_ATTACHMENTS,
        _status: 'committed'
      };
    }

    const userKey = resolveUserQuotaKey(identity);
    const clusterKey = `${userKey}::${utcDate}`;

    return this.executeAtomicDistributedTransaction<QuotaReservation>(clusterKey, async (record): Promise<{ result: QuotaReservation; updatedRecord?: StoredQuotaRecord }> => {
      const activeReserved = countActiveReservations(record);
      const totalActive = record.committedCount + activeReserved;

      if (totalActive >= DAILY_LIMIT_ATTACHMENTS) {
        return {
          result: {
            allowed: false,
            quotaTracked: true,
            userKey,
            utcDate,
            currentCount: totalActive,
            remaining: 0,
            status: 429,
            code: DAILY_LIMIT_ERROR_CODE,
            error: DAILY_LIMIT_EXCEEDED_MESSAGE
          }
        };
      }

      const reservationId = `res_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
      const now = Date.now();
      record.reservations[reservationId] = {
        reservedAt: now,
        expiresAt: now + RESERVATION_TTL_MS
      };
      record.updatedAt = now;

      const newActive = totalActive + 1;
      return {
        result: {
          allowed: true,
          quotaTracked: true,
          reservationId,
          userKey,
          utcDate,
          currentCount: newActive,
          remaining: Math.max(0, DAILY_LIMIT_ATTACHMENTS - newActive),
          _status: 'reserved'
        },
        updatedRecord: record
      };
    });
  }

  async commit(
    reservation: QuotaReservation
  ): Promise<{ success: boolean; committed: boolean; alreadyFinalized?: boolean; committedCount?: number }> {
    if (!reservation || !reservation.quotaTracked || !reservation.reservationId) {
      return { success: true, committed: false };
    }

    if (reservation._status === 'committed') {
      return { success: true, committed: false, alreadyFinalized: true };
    }

    const userKey = reservation.userKey || 'unknown';
    const utcDate = reservation.utcDate || getUtcDateKey();
    const reservationId = reservation.reservationId;
    const clusterKey = `${userKey}::${utcDate}`;

    return this.executeAtomicDistributedTransaction<{
      success: boolean;
      committed: boolean;
      alreadyFinalized?: boolean;
      committedCount?: number;
    }>(clusterKey, async (record): Promise<{
      result: { success: boolean; committed: boolean; alreadyFinalized?: boolean; committedCount?: number };
      updatedRecord?: StoredQuotaRecord;
    }> => {
      if (!record.reservations || !record.reservations[reservationId]) {
        return { result: { success: true, committed: false, alreadyFinalized: true } };
      }

      delete record.reservations[reservationId];
      record.committedCount += 1;
      record.updatedAt = Date.now();
      reservation._status = 'committed';

      return {
        result: {
          success: true,
          committed: true,
          committedCount: record.committedCount
        },
        updatedRecord: record
      };
    });
  }

  async release(
    reservation: QuotaReservation
  ): Promise<{ success: boolean; released: boolean; alreadyFinalized?: boolean }> {
    if (!reservation || !reservation.quotaTracked || !reservation.reservationId) {
      return { success: true, released: false };
    }

    if (reservation._status === 'released' || reservation._status === 'committed') {
      return { success: true, released: false, alreadyFinalized: true };
    }

    const userKey = reservation.userKey || 'unknown';
    const utcDate = reservation.utcDate || getUtcDateKey();
    const reservationId = reservation.reservationId;
    const clusterKey = `${userKey}::${utcDate}`;

    return this.executeAtomicDistributedTransaction<{
      success: boolean;
      released: boolean;
      alreadyFinalized?: boolean;
    }>(clusterKey, async (record): Promise<{
      result: { success: boolean; released: boolean; alreadyFinalized?: boolean };
      updatedRecord?: StoredQuotaRecord;
    }> => {
      if (!record.reservations || !record.reservations[reservationId]) {
        return { result: { success: true, released: false, alreadyFinalized: true } };
      }

      delete record.reservations[reservationId];
      record.updatedAt = Date.now();
      reservation._status = 'released';

      return {
        result: {
          success: true,
          released: true
        },
        updatedRecord: record
      };
    });
  }

  async getStatus(identity: VerifiedUserIdentity, utcDate: string): Promise<QuotaStatus> {
    const userKey = resolveUserQuotaKey(identity);
    const clusterKey = `${userKey}::${utcDate}`;

    const record = SimulatedDistributedClusterDriver.sharedClusterStorage.get(clusterKey);
    if (!record) {
      return {
        userKey,
        utcDate,
        committedCount: 0,
        reservedCount: 0,
        activeCount: 0,
        remaining: DAILY_LIMIT_ATTACHMENTS,
        limit: DAILY_LIMIT_ATTACHMENTS
      };
    }

    const activeReserved = countActiveReservations(record);
    const totalActive = record.committedCount + activeReserved;
    return {
      userKey,
      utcDate,
      committedCount: record.committedCount,
      reservedCount: activeReserved,
      activeCount: totalActive,
      remaining: Math.max(0, DAILY_LIMIT_ATTACHMENTS - totalActive),
      limit: DAILY_LIMIT_ATTACHMENTS
    };
  }

  async reset(identity: VerifiedUserIdentity, utcDate: string): Promise<void> {
    const userKey = resolveUserQuotaKey(identity);
    const clusterKey = `${userKey}::${utcDate}`;
    SimulatedDistributedClusterDriver.sharedClusterStorage.delete(clusterKey);
  }

  static clearAll(): void {
    SimulatedDistributedClusterDriver.sharedClusterStorage.clear();
    SimulatedDistributedClusterDriver.clusterMutex.clear();
  }
}

// ===========================================================================
// Active Driver Selection & Infrastructure Inspection
// ===========================================================================
let activeStorageDriver: QuotaStorageDriver = new LocalFilesystemAtomicDriver();

export function setQuotaStorageDriver(driver: QuotaStorageDriver): void {
  activeStorageDriver = driver;
}

export function getQuotaStorageDriver(): QuotaStorageDriver {
  return activeStorageDriver;
}

/**
 * Inspects system environment and determines whether distributed infrastructure is available.
 * Reports exact blocker details and prevents silent false assumptions.
 */
export function getQuotaInfrastructureStatus(): QuotaInfrastructureStatus {
  const hasFirebaseAdminKey = Boolean(
    process.env.FIREBASE_SERVICE_ACCOUNT_KEY ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    process.env.FIREBASE_CONFIG_ADMIN
  );

  const hasRedis = Boolean(
    process.env.UPSTASH_REDIS_REST_URL ||
    process.env.REDIS_URL
  );

  let blocker: string | null = null;
  let blockerDetails: string | undefined;

  if (!hasFirebaseAdminKey && !hasRedis) {
    blocker = 'MISSING_FIREBASE_ADMIN_CREDENTIALS';
    blockerDetails =
      'Neither Firebase Admin credentials (FIREBASE_SERVICE_ACCOUNT_KEY / GOOGLE_APPLICATION_CREDENTIALS) ' +
      'nor a distributed Redis endpoint (UPSTASH_REDIS_REST_URL) are configured on the server. ' +
      'The active driver (local-filesystem) uses POSIX file locking, which operates across processes ' +
      'on a shared filesystem, but CANNOT enforce atomic quotas across isolated serverless instances.';
  }

  return {
    distributedReady: hasFirebaseAdminKey || hasRedis,
    activeDriver: activeStorageDriver.getDriverName(),
    isDistributed: activeStorageDriver.isDistributed(),
    blocker,
    blockerDetails,
    availableDrivers: ['local-filesystem', 'firestore-admin-distributed', 'simulated-distributed-cluster'],
    supportedBackends: {
      firestoreAdmin: {
        available: hasFirebaseAdminKey,
        reason: hasFirebaseAdminKey
          ? 'Firebase Admin credentials detected.'
          : 'Missing server-side Google Cloud service account key.'
      },
      redis: {
        available: hasRedis,
        reason: hasRedis
          ? 'Distributed Redis connection detected.'
          : 'Missing UPSTASH_REDIS_REST_URL or REDIS_URL.'
      },
      localFilesystem: {
        available: true,
        reason: 'Operational on local or mounted POSIX filesystems.'
      }
    }
  };
}

// ===========================================================================
// Public Standard Quota Engine Interface
// Delegates to the active storage driver
// ===========================================================================

export async function reserveAttachmentQuota(
  identity: VerifiedUserIdentity,
  file: any
): Promise<QuotaReservation> {
  const utcDate = getUtcDateKey();
  return activeStorageDriver.reserve(identity, file, utcDate);
}

export async function commitAttachmentQuota(
  reservation: QuotaReservation
): Promise<{ success: boolean; committed: boolean; alreadyFinalized?: boolean; committedCount?: number }> {
  return activeStorageDriver.commit(reservation);
}

export async function releaseAttachmentQuota(
  reservation: QuotaReservation
): Promise<{ success: boolean; released: boolean; alreadyFinalized?: boolean }> {
  return activeStorageDriver.release(reservation);
}

export async function getQuotaStatus(
  identity: VerifiedUserIdentity,
  date: Date | string | number = new Date()
): Promise<QuotaStatus> {
  const utcDate = getUtcDateKey(date);
  return activeStorageDriver.getStatus(identity, utcDate);
}

export async function resetQuotaForTesting(
  identity: VerifiedUserIdentity,
  date: Date | string | number = new Date()
): Promise<void> {
  const utcDate = getUtcDateKey(date);
  return activeStorageDriver.reset(identity, utcDate);
}
