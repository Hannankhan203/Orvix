import test from 'node:test';
import assert from 'node:assert/strict';

import {
  saveAttachmentBlob,
  getAttachmentRecord,
  deleteAttachmentsForConversation,
  subscribeStorageQuotaExceeded,
  isStorageQuotaExhausted,
  resetAttachmentDBForTesting,
  fetchWithAuth,
  uploadFileDirectToSupabase,
  setClientQuotaFetchForTesting
} from '../src/services/attachmentStorageService.js';

import {
  storeDocumentChunks,
  getChunksForConversation,
  getAllIndexedChunks,
  deleteChunksForDocument,
  resetVectorDBForTesting
} from '../src/services/semanticVectorStorage.js';

import {
  fetchProviderConfig,
  resetCachedProviderConfig,
  streamAIMessage
} from '../src/services/aiRouter.js';

import {
  saveCachedUserChats,
  getCachedUserChats,
  saveCachedChatMessages,
  getCachedChatMessages,
  getPendingDeletedQueue,
  savePendingDeletedQueue,
  getPendingMessageDeletionIds,
  deleteChatMessages,
  saveChatMessage,
  updateChatMode,
  renameConversation,
  toggleChatPinned,
  replayPendingDeletions,
  setFirestoreInstanceForTesting
} from '../src/services/chatStorageService.js';

import { VoiceStreamClient } from '../src/services/voiceStreamClient.js';
import { transcribeAudioBlob, createMinimalWavBlob } from '../src/services/transcriptionService.js';

import {
  createDurableUploadTicket,
  claimDirectUploadTicketForCompletion,
  finalizeCompletedDirectUploadTicket,
  cancelDurableUploadTicket,
  pruneExpiredDirectUploadTickets,
  pendingDirectUploads,
  resetDirectUploadTicketsForTesting
} from '../server/directUploadTicketService.ts';

import {
  deleteDurableAttachmentExpiry,
  deleteDurableExpiryForChatInStorage,
  checkDurableAttachmentExpiry,
  getDurableExpiryRecordPath
} from '../server/supabaseStorageService.ts';

import {
  setFirestoreForTesting,
  resetFirestoreForTesting,
  resetQuotaForTesting,
  reserveUploadSlot
} from '../server/uploadQuotaService.ts';

// ---------------------------------------------------------------------------
// Minimal Browser Environment Test Shims
// ---------------------------------------------------------------------------

function installMemoryLocalStorage({
  maxKeys = Infinity,
  quotaKeysFail = (_k: string, _v: string, _store: Map<string, string>) => false
}: {
  maxKeys?: number;
  quotaKeysFail?: (k: string, v: string, store: Map<string, string>) => boolean;
} = {}) {
  const store = new Map<string, string>();
  const storageShim: Storage = {
    get length() {
      return store.size;
    },
    key(idx: number) {
      return Array.from(store.keys())[idx] ?? null;
    },
    getItem(k: string) {
      return store.has(k) ? store.get(k)! : null;
    },
    setItem(k: string, v: string) {
      const strVal = String(v);
      if (!store.has(k) && store.size >= maxKeys) {
        const err: any = new Error('QuotaExceededError: storage limit reached');
        err.name = 'QuotaExceededError';
        err.code = 22;
        throw err;
      }
      if (quotaKeysFail(k, strVal, store)) {
        const err: any = new Error('QuotaExceededError: quota exceeded');
        err.name = 'QuotaExceededError';
        err.code = 22;
        throw err;
      }
      store.set(k, strVal);
    },
    removeItem(k: string) {
      store.delete(k);
    },
    clear() {
      store.clear();
    }
  };
  return { store, storageShim };
}

function setGlobalProp(name: string, value: any) {
  const hadOwn = Object.prototype.hasOwnProperty.call(globalThis, name);
  const prevDesc = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
    enumerable: true
  });
  return () => {
    if (hadOwn && prevDesc) {
      Object.defineProperty(globalThis, name, prevDesc);
    } else {
      delete (globalThis as any)[name];
    }
  };
}

function setOnlineStatus(isOnline: boolean) {
  const prevNav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: { ...(globalThis.navigator || {}), onLine: isOnline },
    configurable: true
  });
  return () => {
    if (prevNav) {
      Object.defineProperty(globalThis, 'navigator', prevNav);
    } else {
      delete (globalThis as any).navigator;
    }
  };
}

// ---------------------------------------------------------------------------
// 1. attachmentStorageService.js: IndexedDB Recovery & Native Lifecycle
// ---------------------------------------------------------------------------

test('attachmentStorageService: recovers from IDB open error and onversionchange', async () => {
  resetAttachmentDBForTesting();
  let openAttempts = 0;
  const stored = new Map<string, any>();

  const mockIDB = {
    open() {
      openAttempts++;
      const req: any = {};
      queueMicrotask(() => {
        if (openAttempts === 1) {
          req.onerror?.({ target: { error: new Error('transient open failure') } });
          return;
        }
        const db: any = {
          objectStoreNames: { contains: () => true },
          close() {},
          transaction() {
            const tx: any = {
              oncomplete: null,
              onerror: null,
              onabort: null,
              objectStore() {
                return {
                  put(record: any) {
                    const putReq: any = {};
                    stored.set(record.id, record);
                    queueMicrotask(() => {
                      putReq.onsuccess?.({ target: { result: record.id } });
                      queueMicrotask(() => tx.oncomplete?.({}));
                    });
                    return putReq;
                  },
                  get(id: string) {
                    const getReq: any = {};
                    queueMicrotask(() => {
                      getReq.result = stored.get(id) || null;
                      getReq.onsuccess?.({ target: getReq });
                      queueMicrotask(() => tx.oncomplete?.({}));
                    });
                    return getReq;
                  }
                };
              }
            };
            return tx;
          }
        };
        req.onsuccess?.({ target: { result: db } });
        // Trigger versionchange right after returning second handle if this was attempt 2
        if (openAttempts === 2) {
          setTimeout(() => db.onversionchange?.(), 5);
        }
      });
      return req;
    }
  };

  const restoreIdb = setGlobalProp('indexedDB', mockIDB);
  try {
    // Attempt 1 fails open -> must not wedge dbPromise
    const first = await saveAttachmentBlob('att-1', new Blob(['hello']), { name: 'a.txt' });
    assert.equal(first, false);

    // Attempt 2 succeeds after failure recovery
    const second = await saveAttachmentBlob('att-2', new Blob(['world']), { name: 'b.txt' });
    assert.equal(second, true);

    // Wait for onversionchange to clear dbPromise, then verify attempt 3 reopens cleanly
    await new Promise((r) => setTimeout(r, 20));
    const rec = (await getAttachmentRecord('att-2')) as any;
    assert.equal(rec?.id, 'att-2');
    assert.equal(openAttempts, 3);
  } finally {
    restoreIdb();
    resetAttachmentDBForTesting();
  }
});

test('attachmentStorageService: saveAttachmentBlob detects commit-time QuotaExceededError abort', async () => {
  resetAttachmentDBForTesting();
  const quotaEvents: any[] = [];
  const unsub = subscribeStorageQuotaExceeded((err: any) => quotaEvents.push(err));

  const mockIDB = {
    open() {
      const req: any = {};
      queueMicrotask(() => {
        const db: any = {
          objectStoreNames: { contains: () => true },
          transaction() {
            const tx: any = {
              error: Object.assign(new Error('QuotaExceededError'), { name: 'QuotaExceededError', code: 22 }),
              oncomplete: null,
              onerror: null,
              onabort: null,
              objectStore() {
                return {
                  put() {
                    const putReq: any = {};
                    // Synchronous request succeeds, but async transaction aborts on commit
                    queueMicrotask(() => {
                      putReq.onsuccess?.({});
                      setTimeout(() => {
                        tx.onabort?.({ target: tx });
                      }, 5);
                    });
                    return putReq;
                  }
                };
              }
            };
            return tx;
          }
        };
        req.onsuccess?.({ target: { result: db } });
      });
      return req;
    }
  };

  const restoreIdb = setGlobalProp('indexedDB', mockIDB);
  try {
    const saved = await saveAttachmentBlob('att-quota', new Blob(['big']), { name: 'big.bin' });
    assert.equal(saved, false, 'Must return false when native transaction aborts on commit');
    assert.equal(isStorageQuotaExhausted(), true);
    assert.equal(quotaEvents.length, 1);
  } finally {
    unsub();
    restoreIdb();
    resetAttachmentDBForTesting();
  }
});

test('attachmentStorageService: getAttachmentRecord resolves null on TX abort & deleteAttachmentsForConversation waits for native TX complete', async () => {
  resetAttachmentDBForTesting();
  const records = new Map<string, any>([
    ['r1', { id: 'r1', conversationId: 'chat-del' }],
    ['r2', { id: 'r2', conversationId: 'chat-del' }],
    ['r3', { id: 'r3', conversationId: 'chat-del' }]
  ]);

  const mockIDB = {
    open() {
      const req: any = {};
      queueMicrotask(() => {
        const db: any = {
          objectStoreNames: { contains: () => true },
          transaction(_stores: string[], mode: string) {
            const tx: any = {
              oncomplete: null,
              onerror: null,
              onabort: null,
              objectStore() {
                return {
                  indexNames: { contains: () => false },
                  get() {
                    const r: any = {};
                    // Never fires r.onsuccess — only tx aborts
                    setTimeout(() => tx.onabort?.({}), 5);
                    return r;
                  },
                  delete(id: string) {
                    records.delete(id);
                    return {};
                  },
                  openCursor() {
                    const cReq: any = {};
                    const items = Array.from(records.values());
                    let idx = 0;
                    const step = () => {
                      if (idx < items.length) {
                        const item = items[idx++];
                        cReq.result = {
                          key: item.id,
                          primaryKey: item.id,
                          value: item,
                          continue: () => setTimeout(step, 12) // > 15ms total across 3 items
                        };
                        cReq.onsuccess?.({ target: cReq });
                      } else {
                        cReq.result = null;
                        cReq.onsuccess?.({ target: cReq });
                        if (mode === 'readwrite') {
                          setTimeout(() => tx.oncomplete?.({}), 2);
                        }
                      }
                    };
                    setTimeout(step, 5);
                    return cReq;
                  }
                };
              }
            };
            return tx;
          }
        };
        req.onsuccess?.({ target: { result: db } });
      });
      return req;
    }
  };

  const restoreIdb = setGlobalProp('indexedDB', mockIDB);
  try {
    const rec = await getAttachmentRecord('missing');
    assert.equal(rec, null);

    const deletedCount = await deleteAttachmentsForConversation('chat-del');
    assert.equal(deletedCount, 3, 'Must wait for cursor + native transaction completion past 15ms');
    assert.equal(records.size, 0);
  } finally {
    restoreIdb();
    resetAttachmentDBForTesting();
  }
});

// ---------------------------------------------------------------------------
// 2. attachmentStorageService.js: fetchWithAuth timeout + direct upload cancel
// ---------------------------------------------------------------------------

test('attachmentStorageService: fetchWithAuth bounds hangs with timeoutMs and cancels 401 TOKEN_EXPIRED stream', async () => {
  let cancelledFirstBody = false;
  let fetchCalls = 0;

  const restoreFetch = setGlobalProp('fetch', async (_url: string, init: any) => {
    fetchCalls++;
    if (fetchCalls === 1) {
      // Simulate hung request that listens for abort
      return await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const e = new Error('Aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    }
    if (fetchCalls === 2) {
      return {
        ok: false,
        status: 401,
        clone: () => ({
          json: async () => ({ code: 'TOKEN_EXPIRED' })
        }),
        body: {
          cancel: async () => {
            cancelledFirstBody = true;
          }
        }
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true })
    };
  });

  try {
    await assert.rejects(
      () => fetchWithAuth('/api/test-hang', { timeoutMs: 25 }),
      (err: any) => err?.name === 'TimeoutError'
    );

    const res = await fetchWithAuth('/api/test-401', { timeoutMs: 1000 });
    assert.equal(res.status, 200);
    assert.equal(cancelledFirstBody, true, 'Must cancel 401 TOKEN_EXPIRED response body before retry');
  } finally {
    restoreFetch();
  }
});

test('attachmentStorageService: uploadFileDirectToSupabase cancels ticket on step-3 failure except 409 conflict', async () => {
  const fetchCalls: string[] = [];
  let capturedXhrTimeout = 0;
  let step3Mode: 'fail500' | 'conflict409' = 'fail500';

  class MockXHR {
    timeout = 0;
    status = 200;
    responseText = '';
    upload: any = {};
    onload: any = null;
    onerror: any = null;
    ontimeout: any = null;
    onabort: any = null;
    open() {}
    setRequestHeader() {}
    abort() {}
    send() {
      capturedXhrTimeout = this.timeout;
      queueMicrotask(() => this.onload?.());
    }
  }

  const restoreXhr = setGlobalProp('XMLHttpRequest', MockXHR);
  const restoreQuotaFetch = setClientQuotaFetchForTesting(null);
  const restoreFetch = setGlobalProp('fetch', async (url: string) => {
    fetchCalls.push(url);
    if (url === '/api/upload/direct/signed-url') {
      return new Response(
        JSON.stringify({
          signedUrl: 'https://storage.example/upload',
          attachmentId: 'att-direct-1',
          storagePath: 'u1/c1/att-direct-1.pdf'
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (url === '/api/upload/direct/complete') {
      if (step3Mode === 'fail500') {
        return new Response(JSON.stringify({ error: 'Server failed', code: 'COMPLETE_ERR' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return new Response(JSON.stringify({ error: 'Busy', code: 'CONCURRENT_COMPLETION' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    if (url === '/api/upload/direct/cancel') {
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response('{}', { status: 404 });
  });

  try {
    step3Mode = 'fail500';
    await assert.rejects(() =>
      uploadFileDirectToSupabase(new File(['data'], 'doc.pdf', { type: 'application/pdf' }), {
        chatId: 'c1',
        uploadTimeoutMs: 45_000
      })
    );
    assert.equal(capturedXhrTimeout, 45_000);
    assert.ok(
      fetchCalls.includes('/api/upload/direct/cancel'),
      'Step-3 500 failure must invoke /api/upload/direct/cancel to release quota & clean storage'
    );

    fetchCalls.length = 0;
    step3Mode = 'conflict409';
    await assert.rejects(() =>
      uploadFileDirectToSupabase(new File(['data'], 'doc.pdf', { type: 'application/pdf' }), {
        chatId: 'c1'
      })
    );
    assert.equal(
      fetchCalls.includes('/api/upload/direct/cancel'),
      false,
      '409 CONCURRENT_COMPLETION must NOT cancel the active peer upload'
    );
  } finally {
    restoreFetch();
    restoreXhr();
    restoreQuotaFetch;
  }
});

// ---------------------------------------------------------------------------
// 3. semanticVectorStorage.js: IDB recovery, aborted reads, cursor errors
// ---------------------------------------------------------------------------

test('semanticVectorStorage: recovers from IDB open failure and falls back cleanly on tx abort', async () => {
  resetVectorDBForTesting();
  let mode: 'openFail' | 'txAbort' | 'cursorThrow' = 'openFail';

  const mockIDB = {
    open() {
      const req: any = {};
      queueMicrotask(() => {
        if (mode === 'openFail') {
          req.onerror?.({ target: { error: new Error('blocked/failed') } });
          return;
        }
        const db: any = {
          objectStoreNames: { contains: () => true },
          transaction() {
            const tx: any = {
              oncomplete: null,
              onerror: null,
              onabort: null,
              objectStore() {
                return {
                  put() {
                    if (mode === 'txAbort') {
                      setTimeout(() => tx.onabort?.({}), 2);
                    }
                    return {};
                  },
                  getAll() {
                    const r: any = {};
                    setTimeout(() => tx.onabort?.({}), 2);
                    return r;
                  },
                  index() {
                    return {
                      getAll() {
                        const r: any = {};
                        setTimeout(() => tx.onabort?.({}), 2);
                        return r;
                      },
                      openCursor() {
                        const cReq: any = {};
                        queueMicrotask(() => {
                          cReq.result = {
                            delete() {},
                            continue() {
                              if (mode === 'cursorThrow') {
                                throw new Error('cursor invalidated');
                              }
                            }
                          };
                          cReq.onsuccess?.({ target: cReq });
                        });
                        return cReq;
                      }
                    };
                  }
                };
              }
            };
            return tx;
          }
        };
        req.onsuccess?.({ target: { result: db } });
      });
      return req;
    }
  };

  const restoreIdb = setGlobalProp('indexedDB', mockIDB);
  try {
    mode = 'openFail';
    const storedOpenFail = await storeDocumentChunks('doc-1', [{ id: 'ch-1', text: 'alpha' }], 'conv-1');
    assert.equal(storedOpenFail, true);

    mode = 'txAbort';
    await storeDocumentChunks('doc-2', [{ id: 'ch-2', text: 'beta' }], 'conv-2');
    const byConv = (await getChunksForConversation('conv-2')) as any[];
    assert.equal(byConv.length, 1);
    assert.equal(byConv[0].id, 'ch-2');

    const all = await getAllIndexedChunks();
    assert.equal(all.length, 2);

    mode = 'cursorThrow';
    const deleted = await deleteChunksForDocument('doc-1');
    assert.equal(deleted, 1);
  } finally {
    restoreIdb();
    resetVectorDBForTesting();
  }
});

// ---------------------------------------------------------------------------
// 4. aiRouter.js: config fetch timeout/abort & continuation retry guard
// ---------------------------------------------------------------------------

test('aiRouter: fetchProviderConfig enforces timeoutMs and protects cached state from caller aborts', async () => {
  resetCachedProviderConfig();
  let mode: 'hang' | 'ok' = 'hang';

  const restoreFetch = setGlobalProp('fetch', async (_url: string, init: any) => {
    if (mode === 'hang') {
      return await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const e = new Error('Aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    }
    return new Response(
      JSON.stringify({
        geminiConfigured: true,
        groqConfigured: false
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  });

  try {
    const timedOutState = await fetchProviderConfig({ forceRefresh: true, timeoutMs: 20 });
    assert.equal(timedOutState.status, 'unavailable');

    mode = 'ok';
    const readyState = await fetchProviderConfig({ forceRefresh: true, timeoutMs: 500 });
    assert.equal(readyState.status, 'ready');

    // Aborted caller must NOT overwrite 'ready' state
    const ac = new AbortController();
    ac.abort();
    const afterAbort = await fetchProviderConfig({ signal: ac.signal, forceRefresh: true });
    assert.equal(afterAbort.status, 'ready');
  } finally {
    restoreFetch();
    resetCachedProviderConfig();
  }
});

test('aiRouter: cancels 401 TOKEN_EXPIRED response body before retry and bounds non-streaming res.json()', async () => {
  let cancelled401 = false;
  let cancelledJson = false;
  let callNum = 0;

  const restoreFetch = setGlobalProp('fetch', async () => {
    callNum++;
    if (callNum === 1) {
      return {
        ok: false,
        status: 401,
        headers: new Headers({ 'content-type': 'application/json' }),
        clone: () => ({ json: async () => ({ code: 'TOKEN_EXPIRED' }) }),
        body: { cancel: async () => { cancelled401 = true; } }
      };
    }
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => new Promise(() => {}), // hangs forever
      body: { cancel: async () => { cancelledJson = true; } }
    };
  });

  try {
    await assert.rejects(
      () =>
        streamAIMessage({
          provider: 'gemini',
          prompt: 'hello',
          stream: false,
          streamInactivityTimeoutMs: 25,
          retryBaseDelayMs: 0
        }),
      (err: any) => err?.timeoutStage === 'json_read_timeout' && err?.code === 504
    );
    assert.equal(cancelled401, true, '401 TOKEN_EXPIRED body must be cancelled prior to retry');
    assert.equal(cancelledJson, true, 'Hung non-streaming response body must be cancelled on json timeout');
  } finally {
    restoreFetch();
  }
});

test('aiRouter: streamAIMessage Part 2 continuation failure preserves partial text and never restarts Part 1', async () => {
  let chatRequests = 0;

  const restoreFetch = setGlobalProp('fetch', async () => {
    chatRequests++;
    if (chatRequests === 1) {
      // Part 1: emits start + chunk then closes cleanly without [DONE] so continuation triggers
      const stream = new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          controller.enqueue(enc.encode('data: {"type":"start","provider":"gemini","modelUsed":"gemini-2.5-flash"}\n\n'));
          controller.enqueue(enc.encode('data: {"type":"chunk","text":"PartOneText "}\n\n'));
          controller.close();
        }
      });
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' }
      });
    }
    // Part 2 fails with retryable 503 BEFORE emitting Part 2 tokens
    return new Response(
      JSON.stringify({ error: 'Upstream unavailable', code: 503, status: 'UNAVAILABLE', retryable: true }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  });

  try {
    await assert.rejects(
      () =>
        streamAIMessage({
          provider: 'gemini',
          model: 'gemini-2.5-flash',
          prompt: 'Write a very long story',
          retryBaseDelayMs: 0
        }),
      (err: any) => {
        assert.equal(err.partial, true);
        assert.equal(err.partialText, 'PartOneText ');
        assert.equal(err.retryable, false, 'Outer loop must NOT restart Part 1 after Part 2 failure');
        assert.equal(err.canFallback, false);
        return true;
      }
    );

    // Exactly 1 request for Part 1 + at most 2 inner attempts for Part 2 (3 total, NOT restarting Part 1)
    assert.equal(chatRequests, 3);
  } finally {
    restoreFetch();
  }
});

// ---------------------------------------------------------------------------
// 5. chatStorageService.js: Quota eviction, pin fallback, meta fields, truncated msg deletes
// ---------------------------------------------------------------------------

test('chatStorageService: localStorage QuotaExceededError evicts oldest non-pending cache and spares pendingSync', () => {
  // Reserve 4 max keys so saving a 5th triggers eviction of oldest non-pending cache
  const { store, storageShim } = installMemoryLocalStorage({ maxKeys: 4 });
  const restoreWin = setGlobalProp('window', globalThis);
  const restoreLS = setGlobalProp('localStorage', storageShim);

  try {
    const uid = 'user-quota';
    saveCachedUserChats(uid, [
      { id: 'chat-old', rawUpdatedAt: 1000, title: 'Old' },
      { id: 'chat-pending', rawUpdatedAt: 500, title: 'Offline Unsynced' }
    ]);
    // Store oldest synced chat cache (key #2) and older unsynced pendingSync cache (key #3)
    store.set(`orvix_user_messages_${uid}_chat-old`, JSON.stringify([{ id: 'm1', content: 'old', pendingSync: false }]));
    store.set(`orvix_user_messages_${uid}_chat-pending`, JSON.stringify([{ id: 'm2', content: 'unsynced', pendingSync: true }]));
    // Store critical deletion queue (key #4)
    store.set(`orvix_user_deleted_chats_${uid}`, JSON.stringify([{ chatId: 'deleted-chat', userId: uid }]));

    // Adding new message cache hits maxKeys=4 -> must evict chat-old, preserve chat-pending & deleted queue!
    saveCachedChatMessages(uid, 'chat-new', [{ id: 'm3', content: 'fresh' }]);

    assert.equal(store.has(`orvix_user_messages_${uid}_chat-old`), false, 'Oldest non-pending cache must be evicted');
    assert.equal(store.has(`orvix_user_messages_${uid}_chat-pending`), true, 'pendingSync cache must never be evicted');
    assert.equal(store.has(`orvix_user_deleted_chats_${uid}`), true, 'Pending deletion queue must never be evicted');
    assert.equal(store.has(`orvix_user_messages_${uid}_chat-new`), true, 'New message cache must succeed after eviction');
  } finally {
    restoreLS();
    restoreWin();
  }
});

test('chatStorageService: offline toggleChatPinned without arg uses targetPinnedState and updateChatMode preserves dirty fields', async () => {
  const { storageShim } = installMemoryLocalStorage();
  const restoreWin = setGlobalProp('window', globalThis);
  const restoreLS = setGlobalProp('localStorage', storageShim);
  const restoreOnline = setOnlineStatus(false);

  try {
    const uid = 'u-meta';
    const cid = 'c-meta';
    saveCachedUserChats(uid, [
      { id: cid, title: 'Original', mode: 'general', isPinned: false, rawUpdatedAt: 1000 }
    ]);

    // 1. Offline toggleChatPinned without 3rd boolean argument
    const resultingPin = await toggleChatPinned(uid, cid);
    assert.equal(resultingPin, true);
    let chat = getCachedUserChats(uid).find((c: any) => c.id === cid);
    assert.equal(chat.isPinned, true);
    assert.equal(chat.pendingMetaSync, true);
    assert.equal(chat.pendingMetaFields?.isPinned, true);

    // 2. Offline updateChatMode adds mode: true while keeping isPinned: true
    await updateChatMode(uid, cid, 'coding');
    chat = getCachedUserChats(uid).find((c: any) => c.id === cid);
    assert.equal(chat.mode, 'coding');
    assert.equal(chat.pendingMetaFields?.isPinned, true);
    assert.equal(chat.pendingMetaFields?.mode, true);

    // 3. Offline renameConversation keeps both prior dirty flags intact
    await renameConversation(uid, cid, 'Renamed Offline', true);
    chat = getCachedUserChats(uid).find((c: any) => c.id === cid);
    assert.equal(chat.title, 'Renamed Offline');
    assert.equal(chat.pendingMetaSync, true);
    assert.deepEqual(chat.pendingMetaFields, { isPinned: true, mode: true, title: true });
  } finally {
    restoreOnline();
    restoreLS();
    restoreWin();
  }
});

test('chatStorageService: offline deleteChatMessages durably tracks deleted IDs until Firestore commit succeeds', async () => {
  const { storageShim } = installMemoryLocalStorage();
  const restoreWin = setGlobalProp('window', globalThis);
  const restoreLS = setGlobalProp('localStorage', storageShim);
  let restoreOnline = setOnlineStatus(false);

  const firestoreDeletedIds: string[] = [];
  let shouldFailFirestoreDelete = true;

  setFirestoreInstanceForTesting({
    deleteChatMessages: async (_u: string, _c: string, ids: string[]) => {
      if (shouldFailFirestoreDelete) {
        const err: any = new Error('Firestore offline');
        err.code = 'unavailable';
        throw err;
      }
      firestoreDeletedIds.push(...ids);
    }
  });

  try {
    const uid = 'u-delmsg';
    const cid = 'c-delmsg';
    const msgs = [
      { id: 'm1', sender: 'user', content: 'Keep' },
      { id: 'm2', sender: 'assistant', content: 'Truncate 1' },
      { id: 'm3', sender: 'user', content: 'Truncate 2' }
    ];
    saveCachedChatMessages(uid, cid, msgs);

    // Offline delete
    await deleteChatMessages(uid, cid, ['m2', 'm3']);
    assert.deepEqual(getPendingMessageDeletionIds(uid, cid), ['m2', 'm3']);
    assert.deepEqual(getCachedChatMessages(uid, cid).map((m: any) => m.id), ['m1']);

    // Saving a message with ID m2 clears m2 from pending deletions if reused
    await saveChatMessage(uid, cid, { id: 'm2', sender: 'user', content: 'Reused' });
    assert.deepEqual(getPendingMessageDeletionIds(uid, cid), ['m3']);

    // Go online, fail Firestore batch once -> m3 remains pending
    restoreOnline();
    restoreOnline = setOnlineStatus(true);
    shouldFailFirestoreDelete = true;
    await deleteChatMessages(uid, cid, ['m3']);
    assert.deepEqual(getPendingMessageDeletionIds(uid, cid), ['m3']);

    // Succeed online -> m3 is deleted and removed from pending queue
    shouldFailFirestoreDelete = false;
    await deleteChatMessages(uid, cid, ['m3']);
    assert.deepEqual(getPendingMessageDeletionIds(uid, cid), []);
    assert.deepEqual(firestoreDeletedIds, ['m3']);
  } finally {
    setFirestoreInstanceForTesting(null);
    restoreOnline();
    restoreLS();
    restoreWin();
  }
});

test('chatStorageService: replayPendingDeletions accurately counts completions & preserves attempts when offline/unauth', async () => {
  const { storageShim } = installMemoryLocalStorage();
  const restoreWin = setGlobalProp('window', globalThis);
  const restoreLS = setGlobalProp('localStorage', storageShim);
  const restoreOnline = setOnlineStatus(true);

  try {
    const uid = 'u-replay';
    savePendingDeletedQueue(uid, [
      { chatId: 'chat-auth-wait', userId: uid, attempts: 0, storageDeleted: false, firestoreDeleted: false }
    ]);

    // No Firebase auth user active => cleanUpSupabaseConversationStorage returns AUTH_REQUIRED (re-queued, NOT completed)
    const summary = await replayPendingDeletions(uid, { force: true });
    assert.equal(summary.replayed, 0, 'Must not count re-queued deletion as replayed');
    assert.equal(summary.remaining, 1);

    const queue = getPendingDeletedQueue(uid) as any[];
    assert.equal(queue[0].attempts, 0, 'AUTH_REQUIRED deferral must not burn retry budget');
  } finally {
    restoreOnline();
    restoreLS();
    restoreWin();
  }
});

// ---------------------------------------------------------------------------
// 6. voiceStreamClient.js & transcriptionService.js
// ---------------------------------------------------------------------------

test('VoiceStreamClient: rejects connect immediately on premature ws.onclose and tears down audio context safely', async () => {
  let closeCalled = false;
  let lastWs: any = null;

  class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    readyState = MockWebSocket.CONNECTING;
    binaryType = 'blob';
    onopen: any = null;
    onmessage: any = null;
    onerror: any = null;
    onclose: any = null;
    constructor() {
      lastWs = this;
      setTimeout(() => {
        this.readyState = MockWebSocket.CLOSED;
        this.onclose?.({ code: 1006, reason: 'unexpected close' });
      }, 10);
    }
    send() {}
    close() {}
  }

  const restoreWs = setGlobalProp('WebSocket', MockWebSocket);
  const client = new VoiceStreamClient({ url: 'wss://example.test/voice' });
  client.audioContext = ({
    close: () => {
      closeCalled = true;
      return Promise.reject(new Error('already closed'));
    }
  }) as any;

  try {
    const startMs = Date.now();
    await assert.rejects(
      () => client.connect(),
      (err: any) => err?.code === 'WS_CONNECTION_CLOSED'
    );
    const elapsed = Date.now() - startMs;
    assert.ok(elapsed < 1000, `Expected immediate close rejection instead of 4s timer (took ${elapsed}ms)`);
    assert.equal(closeCalled, true, 'Must invoke audioContext.close() safely on ws.onclose');
    assert.ok(lastWs);
  } finally {
    restoreWs();
  }
});

test('transcriptionService: transcribeAudioBlob times out cleanly with structured TRANSCRIPTION_TIMEOUT error', async () => {
  const restoreFetch = setGlobalProp('fetch', async (_url: string, init: any) => {
    return await new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const err = new Error('Aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  });

  try {
    await assert.rejects(
      () =>
        transcribeAudioBlob({
          audioBlob: createMinimalWavBlob(),
          timeoutMs: 25
        }),
      (err: any) => {
        assert.equal(err.code, 'TRANSCRIPTION_TIMEOUT');
        assert.equal(err.statusCode, 504);
        assert.equal(err.isTimeout, true);
        assert.equal(err.retryable, true);
        return true;
      }
    );
  } finally {
    restoreFetch();
  }
});

// ---------------------------------------------------------------------------
// 7. directUploadTicketService.ts & supabaseStorageService.ts
// ---------------------------------------------------------------------------

test('directUploadTicketService: transaction abort does not leak state, cancel rejects completed tickets, and prune retries failed storage deletes', async () => {
  await resetQuotaForTesting();
  resetDirectUploadTicketsForTesting();

  // 1. Completed ticket cannot be cancelled via late cancel call
  const reserveRes = await reserveUploadSlot({ type: 'auth', id: 'u-srv', key: 'auth_u_srv' });
  assert.equal(reserveRes.allowed, true);
  if (!reserveRes.allowed) return;

  await createDurableUploadTicket({
    attachmentId: 'att-done',
    userId: 'u-srv',
    chatId: 'chat-srv',
    storagePath: 'u-srv/chat-srv/att-done.pdf',
    bucket: 'test-bucket',
    fileName: 'att-done.pdf',
    extension: 'pdf',
    mimeType: 'application/pdf',
    size: 1024,
    quotaReservation: reserveRes.reservation,
    expiresAt: Date.now() + 60_000,
    createdAt: Date.now(),
    status: 'pending'
  });

  const claimRes = await claimDirectUploadTicketForCompletion('att-done', 'u-srv', 'chat-srv');
  assert.equal(claimRes.success, true);
  await finalizeCompletedDirectUploadTicket('att-done');

  const lateCancelRes = await cancelDurableUploadTicket('att-done', 'u-srv');
  assert.equal(lateCancelRes.success, false);
  assert.equal(lateCancelRes.status, 409);
  assert.equal(lateCancelRes.code, 'ALREADY_COMPLETED');

  // 2. Aborted claim transaction must NOT pollute pendingDirectUploads cache
  const abortingDb = {
    collection: () => ({
      doc: () => ({
        get: async () => ({ exists: false }),
        set: async () => {}
      })
    }),
    runTransaction: async (fn: any) => {
      await fn({
        get: async () => ({
          exists: true,
          data: () => ({
            attachmentId: 'att-abort-tx',
            userId: 'u-srv',
            chatId: 'chat-srv',
            storagePath: 'u-srv/chat-srv/att-abort-tx.pdf',
            bucket: 'test-bucket',
            status: 'pending',
            expiresAt: Date.now() + 60_000
          })
        }),
        set: () => {}
      });
      throw new Error('TX_ABORTED_ON_COMMIT');
    }
  };
  setFirestoreForTesting(abortingDb);
  const abortedClaim = await claimDirectUploadTicketForCompletion('att-abort-tx', 'u-srv', 'chat-srv');
  assert.equal(abortedClaim.success, false);
  assert.equal(pendingDirectUploads.has('att-abort-tx'), false, 'Failed transaction must not leak state to memory cache');
  resetFirestoreForTesting();

  // 3. pruneExpiredDirectUploadTickets retains ticket when Supabase client is configured & storage delete fails transiently
  const docsMap = new Map<string, any>([
    [
      'att-exp',
      {
        attachmentId: 'att-exp',
        userId: 'u-srv',
        chatId: 'chat-srv',
        storagePath: 'u-srv/chat-srv/att-exp.pdf',
        bucket: 'test-bucket',
        status: 'pending',
        expiresAt: Date.now() - 10_000,
        quotaReservation: reserveRes.reservation
      }
    ]
  ]);
  const sweepDb = {
    collection: (_col: string) => ({
      doc: (id: string) => ({
        get: async () => ({ exists: docsMap.has(id), data: () => docsMap.get(id) }),
        set: async (data: any) => {
          docsMap.set(id, { ...(docsMap.get(id) || {}), ...data });
        },
        delete: async () => {
          docsMap.delete(id);
        }
      }),
      where: (_f: string, _op: string, statuses: string[]) => ({
        get: async () => ({
          docs: Array.from(docsMap.entries())
            .filter(([, d]) => statuses.includes(d.status))
            .map(([id, d]) => ({
              id,
              data: () => d,
              ref: {
                set: async (patch: any) => {
                  docsMap.set(id, { ...docsMap.get(id), ...patch });
                },
                delete: async () => {
                  docsMap.delete(id);
                }
              }
            }))
        })
      }),
      get: async () => ({
        docs: Array.from(docsMap.entries()).map(([id, d]) => ({
          id,
          data: () => d,
          ref: { delete: async () => docsMap.delete(id) }
        }))
      })
    }),
    runTransaction: async (fn: any) => fn({ get: async () => ({ exists: false }), set: () => {} })
  };

  setFirestoreForTesting(sweepDb);
  // Configure Supabase env vars + mock global fetch failing storage delete with 503
  const prevUrl = process.env.SUPABASE_URL;
  const prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL = 'https://mock.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'mock-service-role-key';

  let failStorageDelete = true;
  const restoreFetch = setGlobalProp('fetch', async () => {
    if (failStorageDelete) {
      return new Response(JSON.stringify({ message: 'Transient error' }), { status: 503 });
    }
    return new Response(JSON.stringify([]), { status: 200 });
  });

  try {
    const firstPruneCount = await pruneExpiredDirectUploadTickets();
    assert.equal(firstPruneCount, 0, 'Must not count ticket pruned while storage delete failed');
    assert.equal(docsMap.get('att-exp')?.status, 'expired', 'Ticket must transition to expired for next sweep retry');

    failStorageDelete = false;
    const secondPruneCount = await pruneExpiredDirectUploadTickets();
    assert.equal(secondPruneCount, 1, 'Retry sweep must finish cleanup once storage succeeds');
    assert.equal(docsMap.has('att-exp'), false, 'Ticket doc should be deleted once storage is removed');
  } finally {
    restoreFetch();
    resetFirestoreForTesting();
    if (prevUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = prevUrl;
    if (prevKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey;
    resetDirectUploadTicketsForTesting();
    await resetQuotaForTesting();
  }
});

test('supabaseStorageService: expiry lookup, single delete, and chat delete paginate past 1000 records', async () => {
  const pastExp = Date.now() - 10_000;
  const targetPath = getDurableExpiryRecordPath({
    userId: 'u-page',
    chatId: 'chat-page',
    attachmentId: 'att-on-page-2',
    extension: 'pdf',
    expiresAt: pastExp
  });
  const markerName = targetPath.split('/').pop()!;

  // Page 1 has 1000 filler records (none matching), Page 2 has target marker
  const page1 = Array.from({ length: 1000 }, (_, i) => ({ name: `other__${i}` }));
  const page2 = [{ name: markerName }];

  const removedPaths: string[] = [];
  const mockClient = {
    storage: {
      from: () => ({
        list: async (_prefix: string, opts: { limit: number; offset?: number }) => {
          const offset = opts?.offset || 0;
          if (offset === 0) return { data: page1, error: null };
          if (offset === 1000) return { data: page2, error: null };
          return { data: [], error: null };
        },
        remove: async (paths: string[]) => {
          removedPaths.push(...paths);
          return { data: paths, error: null };
        }
      })
    }
  };

  // 1. checkDurableAttachmentExpiry finds & deletes expired item on page 2
  const checkRes = await checkDurableAttachmentExpiry({
    userId: 'u-page',
    chatId: 'chat-page',
    attachmentId: 'att-on-page-2',
    client: mockClient
  });
  assert.equal(checkRes.expired, true);
  assert.ok(removedPaths.includes(targetPath));

  // 2. deleteDurableAttachmentExpiry finds item on page 2
  removedPaths.length = 0;
  const singleDelRes = await deleteDurableAttachmentExpiry({
    userId: 'u-page',
    chatId: 'chat-page',
    attachmentId: 'att-on-page-2',
    client: mockClient
  });
  assert.equal(singleDelRes.success, true);
  assert.deepEqual(removedPaths, [targetPath]);

  // 3. deleteDurableExpiryForChatInStorage finds item on page 2
  removedPaths.length = 0;
  const chatDelCount = await deleteDurableExpiryForChatInStorage('u-page', 'chat-page', undefined, mockClient);
  assert.equal(chatDelCount, 1);
  assert.deepEqual(removedPaths, [targetPath]);
});
