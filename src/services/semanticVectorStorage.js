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

let vectorDbPromise = null;

// Headless in-memory fallback store for Node.js tests / environments without IndexedDB
const memoryVectorStore = new Map();

/**
 * Initializes and returns the IndexedDB instance for vector storage.
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

  vectorDbPromise = new Promise((resolve) => {
    try {
      const request = idb.open(VECTOR_DB_NAME, VECTOR_DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(VECTOR_STORE_NAME)) {
          const store = db.createObjectStore(VECTOR_STORE_NAME, { keyPath: 'id' });
          store.createIndex('docId', 'docId', { unique: false });
          store.createIndex('conversationId', 'conversationId', { unique: false });
          store.createIndex('createdAt', 'createdAt', { unique: false });
        }
      };

      request.onsuccess = (event) => {
        resolve(event.target.result);
      };

      request.onerror = (err) => {
        console.warn('[Vector Storage] IndexedDB open error, using memory fallback:', err);
        resolve(null);
      };
    } catch (e) {
      console.warn('[Vector Storage] IndexedDB initialization exception, using memory fallback:', e);
      resolve(null);
    }
  });

  return vectorDbPromise;
}

/**
 * Stores an array of chunk records (with their embeddings) into IndexedDB.
 * Updates in-memory fallback simultaneously for high-reliability retrieval.
 *
 * @param {string} docId - Target document identifier
 * @param {Array<Object>} chunks - Chunks with embeddings
 * @param {string} [conversationId] - Associated conversation identifier
 * @returns {Promise<boolean>}
 */
export async function storeDocumentChunks(docId, chunks = [], conversationId = null) {
  if (!docId || !Array.isArray(chunks) || chunks.length === 0) return false;

  const now = Date.now();
  const preparedChunks = chunks.map((c) => ({
    ...c,
    docId,
    conversationId: conversationId || c.conversationId || null,
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
      const finish = (val) => {
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
 * @returns {Promise<Array<Object>>}
 */
export async function getChunksForDocuments(docIds = []) {
  if (!Array.isArray(docIds) || docIds.length === 0) return [];
  const targetIds = new Set(docIds.filter(Boolean));
  if (targetIds.size === 0) return [];

  try {
    const db = await getVectorDB();
    if (!db) {
      // Use memory fallback
      const results = [];
      for (const chunk of memoryVectorStore.values()) {
        if (targetIds.has(chunk.docId)) {
          results.push(chunk);
        }
      }
      return results;
    }

    return new Promise((resolve) => {
      let resolved = false;
      const finish = (res) => {
        if (!resolved) {
          resolved = true;
          resolve(res);
        }
      };

      try {
        const tx = db.transaction([VECTOR_STORE_NAME], 'readonly');
        const store = tx.objectStore(VECTOR_STORE_NAME);
        const index = store.index('docId');
        const collected = [];
        let pending = targetIds.size;

        if (pending === 0) {
          finish([]);
          return;
        }

        for (const docId of targetIds) {
          const req = typeof index.getAll === 'function' ? index.getAll(docId) : null;
          if (req) {
            req.onsuccess = (e) => {
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
              cursorReq.onsuccess = (e) => {
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
        tx.onerror = () => finish(collected);
      } catch (_) {
        // Fall back to memory
        const results = [];
        for (const chunk of memoryVectorStore.values()) {
          if (targetIds.has(chunk.docId)) results.push(chunk);
        }
        finish(results);
      }
    });
  } catch (_) {
    const results = [];
    for (const chunk of memoryVectorStore.values()) {
      if (targetIds.has(chunk.docId)) results.push(chunk);
    }
    return results;
  }
}

/**
 * Retrieves all chunk records associated with a conversation ID.
 *
 * @param {string} conversationId
 * @returns {Promise<Array<Object>>}
 */
export async function getChunksForConversation(conversationId) {
  if (!conversationId) return [];

  try {
    const db = await getVectorDB();
    if (!db) {
      const results = [];
      for (const chunk of memoryVectorStore.values()) {
        if (chunk.conversationId === conversationId) results.push(chunk);
      }
      return results;
    }

    return new Promise((resolve) => {
      let resolved = false;
      const finish = (res) => {
        if (!resolved) {
          resolved = true;
          resolve(res);
        }
      };

      try {
        const tx = db.transaction([VECTOR_STORE_NAME], 'readonly');
        const store = tx.objectStore(VECTOR_STORE_NAME);
        const index = store.index('conversationId');

        if (typeof index.getAll === 'function') {
          const req = index.getAll(conversationId);
          req.onsuccess = (e) => finish(e.target.result || []);
          req.onerror = () => finish([]);
        } else {
          const collected = [];
          const cursorReq = index.openCursor(typeof IDBKeyRange !== 'undefined' ? IDBKeyRange.only(conversationId) : undefined);
          cursorReq.onsuccess = (e) => {
            const cursor = e.target.result;
            if (cursor) {
              if (cursor.value?.conversationId === conversationId) collected.push(cursor.value);
              cursor.continue();
            } else {
              finish(collected);
            }
          };
          cursorReq.onerror = () => finish(collected);
        }
      } catch (_) {
        const results = [];
        for (const chunk of memoryVectorStore.values()) {
          if (chunk.conversationId === conversationId) results.push(chunk);
        }
        finish(results);
      }
    });
  } catch (_) {
    const results = [];
    for (const chunk of memoryVectorStore.values()) {
      if (chunk.conversationId === conversationId) results.push(chunk);
    }
    return results;
  }
}

/**
 * Retrieves all indexed chunks across all documents.
 * @returns {Promise<Array<Object>>}
 */
export async function getAllIndexedChunks() {
  try {
    const db = await getVectorDB();
    if (!db) {
      return Array.from(memoryVectorStore.values());
    }

    return new Promise((resolve) => {
      let resolved = false;
      const finish = (res) => {
        if (!resolved) {
          resolved = true;
          resolve(res);
        }
      };

      try {
        const tx = db.transaction([VECTOR_STORE_NAME], 'readonly');
        const store = tx.objectStore(VECTOR_STORE_NAME);
        const req = store.getAll();
        req.onsuccess = (e) => finish(e.target.result || []);
        req.onerror = () => finish(Array.from(memoryVectorStore.values()));
      } catch (_) {
        finish(Array.from(memoryVectorStore.values()));
      }
    });
  } catch (_) {
    return Array.from(memoryVectorStore.values());
  }
}

/**
 * Deletes all chunks associated with a specific document ID.
 *
 * @param {string} docId
 * @returns {Promise<number>} Number of deleted chunks
 */
export async function deleteChunksForDocument(docId) {
  if (!docId) return 0;

  // Clean memory fallback
  let memCount = 0;
  for (const [key, val] of memoryVectorStore.entries()) {
    if (val.docId === docId) {
      memoryVectorStore.delete(key);
      memCount++;
    }
  }

  try {
    const db = await getVectorDB();
    if (!db) return memCount;

    return new Promise((resolve) => {
      let resolved = false;
      const finish = (c) => {
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

        const cursorReq = index.openCursor(typeof IDBKeyRange !== 'undefined' ? IDBKeyRange.only(docId) : undefined);
        cursorReq.onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor) {
            cursor.delete();
            deleted++;
            cursor.continue();
          } else {
            finish(deleted || memCount);
          }
        };
        cursorReq.onerror = () => finish(memCount);
        tx.oncomplete = () => finish(deleted || memCount);
      } catch (_) {
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
      const finish = (c) => {
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

        const cursorReq = index.openCursor(typeof IDBKeyRange !== 'undefined' ? IDBKeyRange.only(conversationId) : undefined);
        cursorReq.onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor) {
            cursor.delete();
            deleted++;
            cursor.continue();
          } else {
            finish(deleted || memCount);
          }
        };
        cursorReq.onerror = () => finish(memCount);
        tx.oncomplete = () => finish(deleted || memCount);
      } catch (_) {
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
      const finish = (val) => {
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
      } catch (_) {
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
