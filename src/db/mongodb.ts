/**
 * MongoDB Atlas Connection Module for Orvix Backend
 *
 * Provides a resilient, reusable connection to MongoDB Atlas using the official
 * `mongodb` Node.js driver.
 *
 * Features:
 * - Reads `MONGODB_URI` from environment (never hardcoded)
 * - Connects to the database named 'Orvix' (configurable via MONGODB_DB_NAME)
 * - Connection pooling and client reuse
 * - Sanitized logging (masks credentials and sensitive query params)
 * - Safe error handling that prevents server crashes if MongoDB is unreachable
 * - Connection health & ping diagnostics
 */

import { MongoClient, Db, ServerApiVersion, MongoClientOptions } from 'mongodb';

export const DEFAULT_DATABASE_NAME = 'Orvix';

interface MongoConnectionState {
  client: MongoClient | null;
  db: Db | null;
  isConnected: boolean;
  isConnecting: boolean;
  lastConnectedAt: Date | null;
  lastError: string | null;
  connectionPromise: Promise<Db | null> | null;
}

const state: MongoConnectionState = {
  client: null,
  db: null,
  isConnected: false,
  isConnecting: false,
  lastConnectedAt: null,
  lastError: null,
  connectionPromise: null
};

let connectionGeneration = 0;

export type MongoClientFactory = (uri: string, options: MongoClientOptions) => MongoClient;
let testMongoClientFactory: MongoClientFactory | null = null;

/**
 * Detaches and asynchronously closes any active MongoClient, increments connectionGeneration
 * to fence off in-flight attempts, and resets connection state fields.
 */
function invalidateActiveConnection(lastError: string | null = null): void {
  connectionGeneration++;
  if (state.client) {
    const clientToClose = state.client;
    state.client = null;
    clientToClose.close().catch(() => {});
  }
  state.db = null;
  state.isConnected = false;
  state.isConnecting = false;
  state.connectionPromise = null;
  state.lastError = lastError;
}

/**
 * Purges any active or cached test database / mock state when running outside TESTING === 'true'
 * so that restoring process.env.TESTING later cannot resurrect a prior test database or mock.
 */
function purgeTestDatabaseStateIfOutsideTesting(isUsingTestDb: boolean): void {
  if (process.env.TESTING === 'true') {
    return;
  }
  const hadTestArtifacts =
    isUsingTestDb ||
    testModeInMemoryEnabled ||
    testModeInMemoryDb !== null ||
    testMockDb !== null ||
    testMongoClientFactory !== null;

  if (!hadTestArtifacts) {
    return;
  }

  testModeInMemoryEnabled = false;
  testModeInMemoryDb = null;
  testMockDb = null;
  testMongoClientFactory = null;

  if (isUsingTestDb) {
    invalidateActiveConnection(null);
  }
}

/**
 * Masks any potential connection string, username, or password from error strings.
 */
export function sanitizeMongoError(errorText: any): string {
  if (!errorText) return 'Unknown database error';
  const raw = String(errorText?.message || errorText);
  return raw
    .replace(/mongodb(?:\+srv)?:\/\/[^\s"'`]+/gi, 'mongodb+srv://[REDACTED]')
    .replace(/\/\/([^:]+):([^@]+)@/g, '//[REDACTED_USER]:[REDACTED_PASSWORD]@');
}

/**
 * Returns a safe configuration descriptor without exposing URI, username, password, or host.
 */
export function getUriConfigState(uri?: string | null): 'mongodb+srv' | 'mongodb' | 'none' {
  if (!uri) return 'none';
  if (uri.startsWith('mongodb+srv://')) return 'mongodb+srv';
  if (uri.startsWith('mongodb://')) return 'mongodb';
  return 'none';
}

/**
 * Returns the configured MongoDB database name.
 */
export function getDatabaseName(): string {
  return process.env.MONGODB_DB_NAME?.trim() || DEFAULT_DATABASE_NAME;
}

/**
 * Returns whether a MongoDB URI has been configured in the environment.
 */
export function isMongoConfigured(): boolean {
  const uri = process.env.MONGODB_URI?.trim();
  return Boolean(
    uri &&
      uri !== 'undefined' &&
      !uri.includes('YOUR_MONGODB_URI') &&
      (uri.startsWith('mongodb://') || uri.startsWith('mongodb+srv://'))
  );
}

/**
 * Builds recommended MongoClient options for MongoDB Atlas with serverless & timeout resilience.
 */
function getMongoClientOptions(): MongoClientOptions {
  return {
    serverApi: {
      version: ServerApiVersion.v1,
      strict: false,
      deprecationErrors: true
    },
    // Fail fast if cluster is unreachable so backend routes do not hang
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 10000,
    // Optimal pool sizing for Node.js / Express
    maxPoolSize: 20,
    minPoolSize: 0,
    maxIdleTimeMS: 30000
  };
}

/**
 * Connects to MongoDB Atlas using the connection string from process.env.MONGODB_URI.
 * Reuses existing connection if already established or in progress.
 *
 * @returns {Promise<Db | null>} The connected Db instance, or null if unconfigured/failed.
 */
export async function connectToDatabase(): Promise<Db | null> {
  const uri = process.env.MONGODB_URI?.trim();
  const hasValidUri = isMongoConfigured();
  const isUsingTestDb =
    (testModeInMemoryEnabled && state.db === testModeInMemoryDb) ||
    (testMockDb !== null && state.db === testMockDb);
  const hasValidTestDb = isUsingTestDb && process.env.TESTING === 'true';

  if (!hasValidTestDb) {
    purgeTestDatabaseStateIfOutsideTesting(isUsingTestDb);
  }

  if (hasValidTestDb && state.db) {
    return state.db;
  }

  // If MONGODB_URI was removed after an earlier real connection was cached, invalidate the real connection
  if (!hasValidUri || !uri) {
    invalidateActiveConnection('MONGODB_URI is not configured in environment variables.');
    return null;
  }

  // If already connected, return cached db
  if (state.isConnected && state.db) {
    return state.db;
  }

  // If a connection attempt is already in flight, await it
  if (state.connectionPromise) {
    return state.connectionPromise;
  }

  const targetDbName = getDatabaseName();
  const attemptGeneration = ++connectionGeneration;
  const previousClient = state.client;
  state.client = null;
  state.isConnecting = true;
  state.lastError = null;

  let currentPromise: Promise<Db | null> | null = null;
  currentPromise = (async () => {
    let createdClient: MongoClient | null = null;
    try {
      // Yield a microtask so currentPromise and state.connectionPromise are always assigned
      // before any synchronous exception (e.g., MongoParseError in new MongoClient) can reach finally.
      await Promise.resolve();

      if (previousClient) {
        try {
          await previousClient.close();
        } catch (_) {}
      }

      if (attemptGeneration !== connectionGeneration || !isMongoConfigured()) {
        return null;
      }

      const clientFactory: MongoClientFactory =
        process.env.TESTING === 'true' && testMongoClientFactory
          ? testMongoClientFactory
          : (u, opts) => new MongoClient(u, opts);

      createdClient = clientFactory(uri, getMongoClientOptions());
      const clientRef = createdClient;

      // Setup connection event listeners
      clientRef.on('serverClosed', () => {
        if (state.client !== clientRef || attemptGeneration !== connectionGeneration) {
          return;
        }
        console.warn('[MongoDB] Server connection closed.');
        state.isConnected = false;
      });

      clientRef.on('error', (err) => {
        console.error('[MongoDB] Client error:', sanitizeMongoError(err));
      });

      await clientRef.connect();
      if (attemptGeneration !== connectionGeneration || !isMongoConfigured()) {
        await clientRef.close().catch(() => {});
        return null;
      }

      // Verify connection with a quick ping command
      const db = clientRef.db(targetDbName);
      await db.command({ ping: 1 });
      if (attemptGeneration !== connectionGeneration || !isMongoConfigured()) {
        await clientRef.close().catch(() => {});
        return null;
      }

      state.client = clientRef;
      state.db = db;
      state.isConnected = true;
      state.isConnecting = false;
      state.lastConnectedAt = new Date();
      state.lastError = null;

      console.log(`[MongoDB] Successfully connected to database: "${targetDbName}".`);
      return db;
    } catch (error: any) {
      if (createdClient) {
        await createdClient.close().catch(() => {});
      }
      if (attemptGeneration !== connectionGeneration) {
        return null;
      }
      state.isConnected = false;
      state.isConnecting = false;
      state.client = null;
      state.db = null;
      const sanitizedMsg = sanitizeMongoError(error);
      state.lastError = sanitizedMsg;
      console.error(`[MongoDB] Failed to connect to database "${targetDbName}": ${sanitizedMsg}`);
      return null;
    } finally {
      if (attemptGeneration === connectionGeneration && state.connectionPromise === currentPromise) {
        state.connectionPromise = null;
        state.isConnecting = false;
      }
    }
  })();

  state.connectionPromise = currentPromise;
  return state.connectionPromise;
}

function cloneDocValue<T>(val: T): T {
  if (val instanceof Date) {
    return new Date(val.getTime()) as unknown as T;
  }
  if (Array.isArray(val)) {
    return val.map((item) => cloneDocValue(item)) as unknown as T;
  }
  if (val !== null && typeof val === 'object') {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(val as Record<string, any>)) {
      if (v !== undefined) {
        out[k] = cloneDocValue(v);
      }
    }
    return out as T;
  }
  return val;
}

function matchesMongoFilter(doc: any, filter: any): boolean {
  if (!filter || Object.keys(filter).length === 0) return true;
  for (const [key, value] of Object.entries(filter)) {
    if (key === '$or' && Array.isArray(value)) {
      if (!value.some((sub) => matchesMongoFilter(doc, sub))) return false;
      continue;
    }
    if (key === '$and' && Array.isArray(value)) {
      if (!value.every((sub) => matchesMongoFilter(doc, sub))) return false;
      continue;
    }
    if (value && typeof value === 'object' && !(value instanceof Date) && '$in' in value) {
      const inList = (value as any).$in;
      if (Array.isArray(inList) && !inList.includes(doc[key])) return false;
      continue;
    }
    if (doc[key] !== value) return false;
  }
  return true;
}

function createInMemoryCollection(name: string) {
  const store = new Map<string, any>();

  return {
    collectionName: name,
    createIndex: async () => `${name}_idx`,
    insertOne: async (doc: any) => {
      const cloned = cloneDocValue(doc);
      const id = String(cloned._id ?? cloned.id ?? Date.now());
      if (store.has(id)) {
        const dupErr: any = new Error(`E11000 duplicate key error collection: ${name} index: _id_ dup key: { _id: "${id}" }`);
        dupErr.code = 11000;
        throw dupErr;
      }
      cloned._id = cloned._id ?? id;
      store.set(id, cloned);
      return { acknowledged: true, insertedId: cloned._id };
    },
    findOne: async (filter: any = {}, options?: any) => {
      const docs = Array.from(store.values()).filter((d) => matchesMongoFilter(d, filter));
      if (options?.sort) {
        const entries = Object.entries(options.sort) as Array<[string, number]>;
        docs.sort((a, b) => {
          for (const [k, dir] of entries) {
            const va = a[k] instanceof Date ? a[k].getTime() : a[k];
            const vb = b[k] instanceof Date ? b[k].getTime() : b[k];
            if (va !== vb) return (va > vb ? 1 : -1) * (dir >= 0 ? 1 : -1);
          }
          return 0;
        });
      }
      return docs[0] ? cloneDocValue(docs[0]) : null;
    },
    find: (filter: any = {}) => {
      const docs = Array.from(store.values()).filter((d) => matchesMongoFilter(d, filter));
      let skipCount = 0;
      let limitCount: number | null = null;

      const cursor = {
        sort: (sortSpec: any) => {
          if (sortSpec && typeof sortSpec === 'object') {
            const entries = Object.entries(sortSpec) as Array<[string, number]>;
            docs.sort((a, b) => {
              for (const [k, dir] of entries) {
                const va = a[k] instanceof Date ? a[k].getTime() : a[k];
                const vb = b[k] instanceof Date ? b[k].getTime() : b[k];
                if (va !== vb) return (va > vb ? 1 : -1) * (dir >= 0 ? 1 : -1);
              }
              return 0;
            });
          }
          return cursor;
        },
        skip: (n: number) => {
          skipCount = Math.max(0, n || 0);
          return cursor;
        },
        limit: (n: number) => {
          limitCount = n > 0 ? n : null;
          return cursor;
        },
        toArray: async () => {
          let sliced = docs.slice(skipCount);
          if (limitCount !== null) {
            sliced = sliced.slice(0, limitCount);
          }
          return sliced.map((d) => cloneDocValue(d));
        }
      };
      return cursor;
    },
    findOneAndUpdate: async (filter: any, update: any, options?: any) => {
      let existing = Array.from(store.values()).find((d) => matchesMongoFilter(d, filter));
      if (!existing) {
        if (!options?.upsert) return null;
        const setOnInsert = cloneDocValue(update?.$setOnInsert || {});
        const setFields = cloneDocValue(update?.$set || {});
        const created: Record<string, any> = {
          ...setOnInsert,
          ...setFields
        };
        if (created._id === undefined) {
          created._id =
            filter?._id ??
            filter?.id ??
            filter?.userId ??
            created.id ??
            created.uid ??
            created.userId ??
            String(Date.now());
        }
        store.set(String(created._id), created);
        return cloneDocValue(created);
      }
      if (update?.$set) {
        Object.assign(existing, cloneDocValue(update.$set));
      }
      store.set(String(existing._id), existing);
      return cloneDocValue(existing);
    },
    updateOne: async (filter: any, update: any) => {
      const existing = Array.from(store.values()).find((d) => matchesMongoFilter(d, filter));
      if (!existing) {
        return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0, upsertedId: null };
      }
      if (update?.$set) {
        Object.assign(existing, cloneDocValue(update.$set));
      }
      store.set(String(existing._id), existing);
      return { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0, upsertedId: null };
    },
    countDocuments: async (filter: any = {}) => {
      return Array.from(store.values()).filter((d) => matchesMongoFilter(d, filter)).length;
    },
    deleteOne: async (filter: any = {}) => {
      const existing = Array.from(store.values()).find((d) => matchesMongoFilter(d, filter));
      if (!existing) return { acknowledged: true, deletedCount: 0 };
      store.delete(String(existing._id));
      return { acknowledged: true, deletedCount: 1 };
    },
    deleteMany: async (filter: any = {}) => {
      const toDelete = Array.from(store.values()).filter((d) => matchesMongoFilter(d, filter));
      for (const item of toDelete) {
        store.delete(String(item._id));
      }
      return { acknowledged: true, deletedCount: toDelete.length };
    }
  };
}

/**
 * Error thrown when a MongoDB persistence operation is requested
 * but MongoDB is not connected or MONGODB_URI is unconfigured.
 */
export class MongoNotConnectedError extends Error {
  code: string;
  statusCode: number;

  constructor(message?: string) {
    super(
      message ||
        'MongoDB Atlas database is not connected. A real MongoDB connection is required for persistent operations.'
    );
    this.name = 'MongoNotConnectedError';
    this.code = 'DATABASE_NOT_CONNECTED';
    this.statusCode = 503;
  }
}

function createInMemoryDatabaseInstance(): Db {
  const collections = new Map<string, any>();
  return {
    databaseName: getDatabaseName(),
    collection: (name: string) => {
      if (!collections.has(name)) {
        collections.set(name, createInMemoryCollection(name));
      }
      return collections.get(name);
    },
    command: async () => ({ ok: 1 }),
    listCollections: () => ({
      toArray: async () => Array.from(collections.keys()).map((name) => ({ name }))
    })
  } as unknown as Db;
}

let testModeInMemoryDb: Db | null = null;
let testModeInMemoryEnabled = false;
let testMockDb: Db | null = null;

/**
 * TEST HOOK ONLY: Explicitly enables an in-memory mock database for isolated tests.
 * STRICT SAFETY: This function throws an error if called when process.env.TESTING !== 'true'.
 * Under NO circumstances can this be activated in production or normal runtime.
 */
export function enableInMemoryTestDatabase(): Db {
  if (process.env.TESTING !== 'true') {
    throw new Error(
      '[CRITICAL] enableInMemoryTestDatabase() can only be called when process.env.TESTING === "true". ' +
        'In-memory persistence is strictly forbidden in production.'
    );
  }
  if (!testModeInMemoryDb) {
    testModeInMemoryDb = createInMemoryDatabaseInstance();
  }
  invalidateActiveConnection(null);
  testModeInMemoryEnabled = true;
  state.db = testModeInMemoryDb;
  state.isConnected = true;
  return testModeInMemoryDb;
}

/**
 * TEST HOOK ONLY: Resets test database mocks and restores strict connection requirements.
 */
export function resetTestDatabase(): void {
  testModeInMemoryEnabled = false;
  testModeInMemoryDb = null;
  testMockDb = null;
  testMongoClientFactory = null;
  invalidateActiveConnection(null);
}

/**
 * Returns the currently active Db instance.
 *
 * PRODUCTION SAFETY INVARIANT (Phase 3 Step 3.4D-1):
 * Real MongoDB connection is REQUIRED in production.
 * This function NEVER silently falls back to an in-memory database in production or normal runtime.
 * If MongoDB is not connected, it throws an explicit MongoNotConnectedError.
 *
 * An in-memory database may only be used when explicit test mode (process.env.TESTING === 'true')
 * has explicitly injected a mock or opted into enableInMemoryTestDatabase().
 */
export function getDatabase(): Db {
  const isUsingTestDb =
    (testModeInMemoryEnabled && state.db === testModeInMemoryDb) ||
    (testMockDb !== null && state.db === testMockDb);

  // If a test database or mock is active, strictly require process.env.TESTING === 'true'.
  // If test mode was exited, permanently purge cached test database/mock references so restoring
  // process.env.TESTING later cannot make them accessible again without re-enabling them.
  if (isUsingTestDb) {
    if (process.env.TESTING === 'true' && state.db) {
      return state.db;
    }
    purgeTestDatabaseStateIfOutsideTesting(true);
  } else {
    purgeTestDatabaseStateIfOutsideTesting(false);
    if (!isMongoConfigured()) {
      // MONGODB_URI was removed or is invalid; invalidate any cached real connection state
      // even if serverClosed already set state.isConnected to false.
      if (state.client || state.db || state.isConnected || state.isConnecting || state.connectionPromise) {
        invalidateActiveConnection('MONGODB_URI is not configured in environment variables.');
      }
    } else if (state.db && state.isConnected) {
      return state.db;
    }
  }

  // If in explicit test mode AND test in-memory fallback was explicitly opted into
  if (process.env.TESTING === 'true') {
    if (testMockDb) return testMockDb;
    if (testModeInMemoryEnabled && testModeInMemoryDb) return testModeInMemoryDb;
  }

  // PRODUCTION / NORMAL RUNTIME: Fail explicitly. No silent in-memory fallback.
  const reason = state.lastError
    ? state.lastError
    : isMongoConfigured()
      ? 'MongoDB connection has not been established or was lost.'
      : 'MONGODB_URI is not configured in environment variables.';

  throw new MongoNotConnectedError(
    `Database connection required: MongoDB is not connected (${reason}). ` +
      'In-memory fallback is strictly disabled to prevent silent data loss.'
  );
}

/**
 * Returns the active MongoClient instance, or null if not connected.
 */
export function getMongoClient(): MongoClient | null {
  return state.client;
}

/**
 * Returns a diagnostic snapshot of the MongoDB connection status.
 */
export interface MongoStatusInfo {
  isConfigured: boolean;
  isConnected: boolean;
  isConnecting: boolean;
  databaseName: string;
  uriScheme: 'mongodb+srv' | 'mongodb' | 'none';
  lastConnectedAt: string | null;
  lastError: string | null;
  pingLatencyMs?: number;
}

export async function getMongoStatus(): Promise<MongoStatusInfo> {
  const configured = isMongoConfigured();
  const dbName = getDatabaseName();
  const rawUri = process.env.MONGODB_URI?.trim();
  const isUsingTestDb =
    (testModeInMemoryEnabled && state.db === testModeInMemoryDb) ||
    (testMockDb !== null && state.db === testMockDb);
  const hasValidTestDb = isUsingTestDb && process.env.TESTING === 'true';

  if (!hasValidTestDb) {
    purgeTestDatabaseStateIfOutsideTesting(isUsingTestDb);
  }

  if (!configured && !hasValidTestDb) {
    if (state.client || state.db || state.isConnected || state.isConnecting || state.connectionPromise) {
      invalidateActiveConnection('MONGODB_URI is not configured in environment variables.');
    }
  }

  let pingLatencyMs: number | undefined;

  if (state.isConnected && state.db) {
    const statusGeneration = connectionGeneration;
    const targetDb = state.db;
    try {
      const start = Date.now();
      await targetDb.command({ ping: 1 });
      pingLatencyMs = Date.now() - start;
    } catch (err: any) {
      if (statusGeneration === connectionGeneration && state.db === targetDb) {
        state.isConnected = false;
        state.lastError = sanitizeMongoError(err);
      }
    }
  }

  return {
    isConfigured: configured,
    isConnected: state.isConnected,
    isConnecting: state.isConnecting,
    databaseName: dbName,
    uriScheme: getUriConfigState(rawUri),
    lastConnectedAt: state.lastConnectedAt ? state.lastConnectedAt.toISOString() : null,
    lastError: state.lastError,
    pingLatencyMs
  };
}

/**
 * Gracefully disconnects the MongoDB client on application shutdown.
 */
export async function closeDatabase(): Promise<void> {
  connectionGeneration++;
  const clientToClose = state.client;
  state.client = null;
  state.db = null;
  state.isConnected = false;
  state.isConnecting = false;
  state.connectionPromise = null;

  if (clientToClose) {
    try {
      console.log('[MongoDB] Closing database connection...');
      await clientToClose.close();
      console.log('[MongoDB] Database connection closed.');
    } catch (err) {
      console.warn('[MongoDB] Error while closing connection:', err);
    }
  }
}

/**
 * TEST HOOK: Sets an in-memory mock Db instance for isolated unit tests
 * when testing environments do not have a live MongoDB Atlas connection string.
 * Strictly permitted ONLY when process.env.TESTING === 'true'.
 */
export function setMockDatabaseForTesting(mockDb: any | null): void {
  if (mockDb) {
    if (process.env.TESTING !== 'true') {
      throw new Error(
        '[CRITICAL] setMockDatabaseForTesting can only be called when process.env.TESTING === "true". ' +
          'Test mocking is strictly forbidden in production.'
      );
    }
    invalidateActiveConnection(null);
    testMockDb = mockDb;
    state.db = mockDb;
    state.isConnected = true;
  } else {
    testMockDb = null;
    invalidateActiveConnection(null);
  }
}

/**
 * TEST HOOK ONLY: Injects a custom MongoClient factory for deterministic connection lifecycle tests.
 * Strictly permitted ONLY when process.env.TESTING === 'true'.
 */
export function setMongoClientFactoryForTesting(factory: MongoClientFactory | null): void {
  if (factory && process.env.TESTING !== 'true') {
    throw new Error(
      '[CRITICAL] setMongoClientFactoryForTesting can only be called when process.env.TESTING === "true".'
    );
  }
  testMongoClientFactory = factory;
}

