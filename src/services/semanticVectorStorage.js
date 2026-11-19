/**
 * Orvix Client-Side Vector Storage Engine
 * Persists and indexes document chunk embeddings in IndexedDB (`orvix_vector_db`).
 * Supports fast multi-document vector queries, atomic batch saves,
 * and automated lifecycle deletions on document/chat cleanup.
 *
 * Includes an in-memory fallback adapter for Node.js test execution and environments without IDB.
 */

const VECTOR_DB_NAME = 'orvix_vector_db';
const VECTOR_DB_VERSION = 1;
const VECTOR_STORE_NAME = 'vector_chunks';

/** @type {Promise<any>|null} */
let vectorDbPromise = null;

// Headless in-memory fallback store for Node.js tests / environments without IndexedDB
const memoryVectorStore = new Map();

const VECTOR_DB_BLOCKED_TIMEOUT_MS = 2500;

/**
 * Initializes and returns the IndexedDB instance for vector storage.
 * Resets cached promise on open error, blocked upgrade, close, or versionchange.
 * @returns {Promise<IDBDatabase|null>}
 */
export function getVectorDB() {
  const idb =
    typeof indexedDB !== 'undefined'
      ? indexedDB
      : typeof window !== 'undefined' && window.indexedDB
      ? window.indexedDB
      : null;

  if (!idb) {
    return Promise.resolve(null);
  }

  if (vectorDbPromise) return vectorDbPromise;

  /** @type {Promise<any>|null} */
  let currentPromise = null;
  currentPromise = new Promise((resolve) => {
    let settled = false;
    /** @type {any} */
    let blockedTimer = null;

    const clearBlockedTimer = () => {
      if (blockedTimer) {
        clearTimeout(blockedTimer);
        blockedTimer = null;
      }
    };

    const failOpen = (/** @type {any} */ reason) => {
      if (settled) return;
      settled = true;
      clearBlockedTimer();
      if (vectorDbPromise === currentPromise) {
        vectorDbPromise = null;
      }
      if (reason) {
        console.warn('[Vector Storage] IndexedDB open failed/blocked, using memory fallback:', reason);
      }
      resolve(null);
    };

    try {
      const request = idb.open(VECTOR_DB_NAME, VECTOR_DB_VERSION);

      request.onupgradeneeded = (/** @type {any} */ event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(VECTOR_STORE_NAME)) {
          const store = db.createObjectStore(VECTOR_STORE_NAME, { keyPath: 'id' });
          store.createIndex('docId', 'docId', { unique: false });
          store.createIndex('conversationId', 'conversationId', { unique: false });
          store.createIndex('createdAt', 'createdAt', { unique: false });
        }
      };

      request.onblocked = () => {
        if (settled || blockedTimer) return;
        blockedTimer = setTimeout(() => {
          failOpen('IndexedDB upgrade blocked by another open tab');
        }, VECTOR_DB_BLOCKED_TIMEOUT_MS);
      };

      request.onsuccess = (/** @type {any} */ event) => {
        const db = event.target.result;
        clearBlockedTimer();
        if (settled) {
          try {
            db?.close?.();
          } catch (_) {}
          return;
        }
        settled = true;
        if (db && typeof db === 'object') {
          db.onversionchange = () => {
            try {
              db.close?.();
            } catch (_) {}
            if (vectorDbPromise === currentPromise) {
              vectorDbPromise = null;
            }
          };
          db.onclose = () => {
            if (vectorDbPromise === currentPromise) {
              vectorDbPromise = null;
            }
          };
        }
        resolve(db);
      };

      request.onerror = (err) => {
        failOpen(err);
      };
    } catch (e) {
      failOpen(e);
    }
  });

  vectorDbPromise = currentPromise;
  return vectorDbPromise;
}

/**
 * @param {any} chunk
 * @param {any} [options={}]
 */
function matchesChunkScope(chunk, options = {}) {
  if (!chunk || typeof chunk !== 'object') return false;
  if (options?.conversationId !== undefined && options?.conversationId !== null) {
    if (chunk.conversationId !== options.conversationId) return false;
  }
  if (options?.userId !== undefined) {
    if (options.userId === null) {
      if (chunk.userId) return false;
    } else if (chunk.userId !== options.userId) {
      return false;
    }
  }
  return true;
}

/**
 * Stores an array of chunk records (with their embeddings) into IndexedDB.
 * Updates in-memory fallback simultaneously for high-reliability retrieval.
 *
 * @param {string} docId - Target document identifier
 * @param {Array<any>} chunks - Chunks with embeddings
 * @param {string|null} [conversationId] - Associated conversation identifier
 * @param {Object} [options] - Optional storage metadata
 * @returns {Promise<boolean>}
 */
export async function storeDocumentChunks(docId, chunks = [], conversationId = null, options = {}) {
  if (!docId || !Array.isArray(chunks) || chunks.length === 0) return false;

  const now = Date.now();
  const resolvedUserId = options?.userId !== undefined ? options.userId : undefined;
  const resolvedContentHash = options?.contentHash !== undefined ? options.contentHash : undefined;
  const preparedChunks = chunks.map((c) => ({
    ...c,
    docId,
    conversationId: conversationId || c.conversationId || null,
    userId: resolvedUserId !== undefined ? resolvedUserId : (c.userId || null),
    expectedChunkCount: typeof c.expectedChunkCount === 'number' ? c.expectedChunkCount : chunks.length,
    ...(resolvedContentHash !== undefined ? { contentHash: resolvedContentHash } : {}),
    createdAt: c.createdAt || now
  }));

  // Always update in-memory fallback
  for (const c of preparedChunks) {
    memoryVectorStore.set(c.id, c);
  }

  try {
    const db = await getVectorDB();
    if (!db) return true; // Memory store updated

    return new Promise((resolve) => {
      let resolved = false;
      const finish = (/** @type {any} */ val) => {
        if (!resolved) {
          resolved = true;
          resolve(val);
        }
      };

      try {
        const tx = db.transaction([VECTOR_STORE_NAME], 'readwrite');
        const store = tx.objectStore(VECTOR_STORE_NAME);

        for (const chunk of preparedChunks) {
          store.put(chunk);
        }

        tx.oncomplete = () => finish(true);
        tx.onerror = () => finish(false);
        tx.onabort = () => finish(false);
      } catch (_) {
        finish(false);
      }
    });
  } catch (_) {
    return false;
  }
}

/**
 * Retrieves all chunk records associated with a set of document IDs.
 *
 * @param {string[]} docIds - Array of document IDs
 * @param {Object} [options] - Optional conversationId / userId scope filters
 * @returns {Promise<Array<Object>>}
 */
export async function getChunksForDocuments(docIds = [], options = {}) {
  if (!Array.isArray(docIds) || docIds.length === 0) return [];
  const targetIds = new Set(docIds.filter(Boolean));
  if (targetIds.size === 0) return [];

  const filterMemory = () => {
    const results = [];
    for (const chunk of memoryVectorStore.values()) {
      if (targetIds.has(chunk.docId) && matchesChunkScope(chunk, options)) {
        results.push(chunk);
      }
    }
    return results;
  };

  try {
    const db = await getVectorDB();
    if (!db) {
      return filterMemory();
    }

    return new Promise((resolve) => {
      let resolved = false;
      const finish = (/** @type {any[]} */ res) => {
        if (!resolved) {
          resolved = true;
          resolve(res.filter((c) => matchesChunkScope(c, options)));
        }
      };

      try {
        const tx = db.transaction([VECTOR_STORE_NAME], 'readonly');
        const store = tx.objectStore(VECTOR_STORE_NAME);
        const index = store.index('docId');
        /** @type {any[]} */
        const collected = [];
        let pending = targetIds.size;

        if (pending === 0) {
          finish([]);
          return;
        }

        for (const docId of targetIds) {
          const req = typeof index.getAll === 'function' ? index.getAll(docId) : null;
          if (req) {
            req.onsuccess = (/** @type {any} */ e) => {
              if (Array.isArray(e.target.result)) {
                collected.push(...e.target.result);
              }
              pending--;
              if (pending <= 0) finish(collected);
            };
            req.onerror = () => {
              pending--;
              if (pending <= 0) finish(collected);
            };
          } else {
            // Cursor fallback
            const cursorReq = index.openCursor(typeof IDBKeyRange !== 'undefined' ? IDBKeyRange.only(docId) : undefined);
            if (cursorReq) {
              cursorReq.onsuccess = (/** @type {any} */ e) => {
                const cursor = e.target.result;
                if (cursor) {
                  if (cursor.value?.docId === docId) collected.push(cursor.value);
                  cursor.continue();
                } else {
                  pending--;
                  if (pending <= 0) finish(collected);
                }
              };
              cursorReq.onerror = () => {
                pending--;
                if (pending <= 0) finish(collected);
              };
            } else {
              pending--;
              if (pending <= 0) finish(collected);
            }
          }
        }

        tx.oncomplete = () => finish(collected);
        tx.onerror = () => finish(collected.length > 0 ? collected : filterMemory());
        tx.onabort = () => finish(collected.length > 0 ? collected : filterMemory());
      } catch (/** @type {any} */ err) {
        if (err?.name === 'InvalidStateError') {
          vectorDbPromise = null;
        }
        finish(filterMemory());
      }
    });
  } catch (_) {
    return filterMemory();
  }
}

/**
 * Retrieves all chunk records associated with a conversation ID.
 *
 * @param {string} conversationId
 * @param {Object} [options] - Optional userId scope filter
 * @returns {Promise<Array<Object>>}
 */
export async function getChunksForConversation(conversationId, options = {}) {
  if (!conversationId) return [];
  const scope = { ...options, conversationId };

  const filterMemory = () => {
    const results = [];
    for (const chunk of memoryVectorStore.values()) {
      if (matchesChunkScope(chunk, scope)) results.push(chunk);
    }
    return results;
  };

  try {
    const db = await getVectorDB();
    if (!db) {
      return filterMemory();
    }

    return new Promise((resolve) => {
      let resolved = false;
      const finish = (/** @type {any[]} */ res) => {
        if (!resolved) {
          resolved = true;
          resolve(res.filter((c) => matchesChunkScope(c, scope)));
        }
      };

      try {
        const tx = db.transaction([VECTOR_STORE_NAME], 'readonly');
        const store = tx.objectStore(VECTOR_STORE_NAME);
        const index = store.index('conversationId');

        tx.onerror = () => finish(filterMemory());
        tx.onabort = () => finish(filterMemory());

        if (typeof index.getAll === 'function') {
          const req = index.getAll(conversationId);
          if (!req) {
            finish(filterMemory());
            return;
          }
          req.onsuccess = (/** @type {any} */ e) => finish(e.target.result || []);
          req.onerror = () => finish(filterMemory());
        } else {
          /** @type {any[]} */
          const collected = [];
          const cursorReq = index.openCursor(typeof IDBKeyRange !== 'undefined' ? IDBKeyRange.only(conversationId) : undefined);
          if (!cursorReq) {
            finish(filterMemory());
            return;
          }
          cursorReq.onsuccess = (/** @type {any} */ e) => {
            const cursor = e.target.result;
            if (cursor) {
              if (cursor.value?.conversationId === conversationId) collected.push(cursor.value);
              try {
                cursor.continue();
              } catch (_) {
                finish(collected);
              }
            } else {
              finish(collected);
            }
          };
          cursorReq.onerror = () => finish(collected);
        }
      } catch (/** @type {any} */ err) {
        if (err?.name === 'InvalidStateError') {
          vectorDbPromise = null;
        }
        finish(filterMemory());
      }
    });
  } catch (_) {
    return filterMemory();
  }
}

/**
 * Retrieves all indexed chunks across all documents (optionally scoped by conversationId/userId).
 * @param {Object} [options]
 * @returns {Promise<Array<Object>>}
 */
export async function getAllIndexedChunks(options = {}) {
  const filterMemory = () =>
    Array.from(memoryVectorStore.values()).filter((c) => matchesChunkScope(c, options));

  try {
    const db = await getVectorDB();
    if (!db) {
      return filterMemory();
    }

    return new Promise((resolve) => {
      let resolved = false;
      const finish = (/** @type {any[]} */ res) => {
        if (!resolved) {
          resolved = true;
          resolve(res.filter((c) => matchesChunkScope(c, options)));
        }
      };

      try {
        const tx = db.transaction([VECTOR_STORE_NAME], 'readonly');
        const store = tx.objectStore(VECTOR_STORE_NAME);
        tx.onerror = () => finish(filterMemory());
        tx.onabort = () => finish(filterMemory());
        const req = store.getAll();
        if (!req) {
          finish(filterMemory());
          return;
        }
        req.onsuccess = (/** @type {any} */ e) => finish(e.target.result || []);
        req.onerror = () => finish(filterMemory());
      } catch (/** @type {any} */ err) {
        if (err?.name === 'InvalidStateError') {
          vectorDbPromise = null;
        }
        finish(filterMemory());
      }
    });
  } catch (_) {
    return filterMemory();
  }
}

/**
 * Deletes all chunks associated with a specific document ID (and optional conversationId/userId scope).
 *
 * @param {string} docId
 * @param {Object} [options]
 * @returns {Promise<number>} Number of deleted chunks
 */
export async function deleteChunksForDocument(docId, options = {}) {
  if (!docId) return 0;

  // Clean memory fallback
  let memCount = 0;
  for (const [key, val] of memoryVectorStore.entries()) {
    if (val.docId === docId && matchesChunkScope(val, options)) {
      memoryVectorStore.delete(key);
      memCount++;
    }
  }

  try {
    const db = await getVectorDB();
    if (!db) return memCount;

    return new Promise((resolve) => {
      let resolved = false;
      const finish = (/** @type {number} */ c) => {
        if (!resolved) {
          resolved = true;
          resolve(c);
        }
      };

      try {
        const tx = db.transaction([VECTOR_STORE_NAME], 'readwrite');
        const store = tx.objectStore(VECTOR_STORE_NAME);
        const index = store.index('docId');
        let deleted = 0;

        tx.oncomplete = () => finish(deleted || memCount);
        tx.onerror = () => finish(memCount);
        tx.onabort = () => finish(memCount);

        const cursorReq = index.openCursor(typeof IDBKeyRange !== 'undefined' ? IDBKeyRange.only(docId) : undefined);
        if (!cursorReq) {
          finish(memCount);
          return;
        }
        cursorReq.onsuccess = (/** @type {any} */ e) => {
          const cursor = e.target.result;
          if (cursor) {
            if (matchesChunkScope(cursor.value, options)) {
              cursor.delete();
              deleted++;
            }
            try {
              cursor.continue();
            } catch (_) {
              finish(deleted || memCount);
            }
          } else {
            finish(deleted || memCount);
          }
        };
        cursorReq.onerror = () => finish(memCount);
      } catch (/** @type {any} */ err) {
        if (err?.name === 'InvalidStateError') {
          vectorDbPromise = null;
        }
        finish(memCount);
      }
    });
  } catch (_) {
    return memCount;
  }
}

/**
 * Deletes all chunks for an array of document IDs.
 *
 * @param {string[]} docIds
 * @returns {Promise<number>}
 */
export async function deleteChunksForDocuments(docIds = []) {
  if (!Array.isArray(docIds) || docIds.length === 0) return 0;
  let totalDeleted = 0;
  for (const docId of docIds) {
    totalDeleted += await deleteChunksForDocument(docId);
  }
  return totalDeleted;
}

/**
 * Deletes all chunks belonging to a specific conversation ID.
 *
 * @param {string} conversationId
 * @returns {Promise<number>}
 */
export async function deleteChunksForConversation(conversationId) {
  if (!conversationId) return 0;

  let memCount = 0;
  for (const [key, val] of memoryVectorStore.entries()) {
    if (val.conversationId === conversationId) {
      memoryVectorStore.delete(key);
      memCount++;
    }
  }

  try {
    const db = await getVectorDB();
    if (!db) return memCount;

    return new Promise((resolve) => {
      let resolved = false;
      const finish = (/** @type {number} */ c) => {
        if (!resolved) {
          resolved = true;
          resolve(c);
        }
      };

      try {
        const tx = db.transaction([VECTOR_STORE_NAME], 'readwrite');
        const store = tx.objectStore(VECTOR_STORE_NAME);
        const index = store.index('conversationId');
        let deleted = 0;

        tx.oncomplete = () => finish(deleted || memCount);
        tx.onerror = () => finish(memCount);
        tx.onabort = () => finish(memCount);

        const cursorReq = index.openCursor(typeof IDBKeyRange !== 'undefined' ? IDBKeyRange.only(conversationId) : undefined);
        if (!cursorReq) {
          finish(memCount);
          return;
        }
        cursorReq.onsuccess = (/** @type {any} */ e) => {
          const cursor = e.target.result;
          if (cursor) {
            cursor.delete();
            deleted++;
            try {
              cursor.continue();
            } catch (_) {
              finish(deleted || memCount);
            }
          } else {
            finish(deleted || memCount);
          }
        };
        cursorReq.onerror = () => finish(memCount);
      } catch (/** @type {any} */ err) {
        if (err?.name === 'InvalidStateError') {
          vectorDbPromise = null;
        }
        finish(memCount);
      }
    });
  } catch (_) {
    return memCount;
  }
}

/**
 * Completely clears the vector storage store (useful for resets or testing).
 * @returns {Promise<boolean>}
 */
export async function clearAllChunks() {
  memoryVectorStore.clear();

  try {
    const db = await getVectorDB();
    if (!db) return true;

    return new Promise((resolve) => {
      let resolved = false;
      const finish = (/** @type {boolean} */ val) => {
        if (!resolved) {
          resolved = true;
          resolve(val);
        }
      };

      try {
        const tx = db.transaction([VECTOR_STORE_NAME], 'readwrite');
        const store = tx.objectStore(VECTOR_STORE_NAME);
        store.clear();
        tx.oncomplete = () => finish(true);
        tx.onerror = () => finish(false);
        tx.onabort = () => finish(false);
      } catch (/** @type {any} */ err) {
        if (err?.name === 'InvalidStateError') {
          vectorDbPromise = null;
        }
        finish(false);
      }
    });
  } catch (_) {
    return false;
  }
}

/**
 * Returns diagnostic statistics on the vector store.
 * @returns {Promise<{ chunkCount: number, docCount: number, memoryEstimatedKB: number }>}
 */
export async function getVectorStoreStats() {
  const all = await getAllIndexedChunks();
  const docIds = new Set(all.map((c) => c.docId));
  const estimatedBytes = all.reduce((acc, c) => acc + (c.text?.length || 0) + (c.embedding?.length || 0) * 4 + 200, 0);

  return {
    chunkCount: all.length,
    docCount: docIds.size,
    memoryEstimatedKB: Math.round(estimatedBytes / 1024)
  };
}

/**
 * Resets database promise for unit tests.
 */
export function resetVectorDBForTesting() {
  vectorDbPromise = null;
  memoryVectorStore.clear();
}
