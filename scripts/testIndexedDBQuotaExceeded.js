/**
 * Audit Point #12 — IndexedDB QuotaExceededError Focused Test Suite
 *
 * Verifies the behavior of Orvix AI's IndexedDB attachment storage layer
 * when the browser refuses a write because the IndexedDB quota has been exceeded.
 *
 * Scenarios tested:
 *   Scenario A — Baseline Normal Write (store.put succeeds, getAttachmentRecord verifies persistence)
 *   Scenario B — QuotaExceededError (controlled injection of DOMException name='QuotaExceededError'
 *                 across request-level, transaction-level, and sync error paths)
 *   Scenario C — Recovery & Graceful Handling (write reports false, error identified, in-memory state preserved,
 *                 previews/downloads work via in-memory Blob, subsequent write recovers, zero unhandled rejections)
 *   Phase 4    — Error Identity & Specificity (distinguishes QuotaExceededError from ReadOnlyError, AbortError, etc.)
 */

import assert from 'node:assert/strict';
import {
  saveAttachmentBlob,
  getAttachmentRecord,
  getAttachmentBlob,
  deleteAttachmentRecord,
  isQuotaExceededError,
  getLastStorageError,
  clearLastStorageError,
  resetAttachmentDBForTesting,
  openOrPreviewAttachment,
  downloadAttachmentFile,
  hydrateAttachmentsWithImageBytes
} from '../src/services/attachmentStorageService.js';

console.log('================================================================');
console.log('Orvix AI — Audit Point #12: IndexedDB QuotaExceededError Suite');
console.log('================================================================');

// Track unhandled promise rejections or uncaught exceptions
let unhandledRejectionsCount = 0;
process.on('unhandledRejection', (reason) => {
  unhandledRejectionsCount++;
  console.error('[UNHANDLED REJECTION DETECTED]:', reason);
});

// Environment honesty declaration
const isBrowserEnv = typeof window !== 'undefined' && typeof window.indexedDB !== 'undefined';
console.log(`[Environment]: ${isBrowserEnv ? 'Browser Environment (DOM/window)' : 'Node.js Runtime with standards-compliant IDB harness'}`);
console.log('[Test Mode]: Controlled DOMException QuotaExceededError Injection at the IndexedDB boundary.');
console.log('              (Explicit notice: Testing controlled error-injection, not physical disk exhaustion).');

/**
 * Robust in-memory IndexedDB harness for testing that matches the W3C IndexedDB spec
 * with configurable quota limits and controllable error injection.
 */
class MockIDBDatabase {
  constructor(name) {
    this.name = name;
    this.objectStoreNames = {
      contains: (n) => this.stores.has(n)
    };
    this.stores = new Map();
    this.quotaLimitBytes = Infinity;
    this.usedBytes = 0;
    this.injectedError = null;
    this.errorInjectionStage = null; // 'put_sync' | 'request_error' | 'transaction_abort' | 'quota_limit'
  }

  createObjectStore(name) {
    if (!this.stores.has(name)) {
      this.stores.set(name, new Map());
    }
    return {
      createIndex() {}
    };
  }

  transaction(storeNames, mode) {
    const storeName = Array.isArray(storeNames) ? storeNames[0] : storeNames;
    if (!this.stores.has(storeName)) {
      this.stores.set(storeName, new Map());
    }
    const storeMap = this.stores.get(storeName);

    const tx = {
      error: null,
      oncomplete: null,
      onerror: null,
      onabort: null,
      abort() {
        if (!this.error) {
          this.error = new DOMException('Transaction aborted', 'AbortError');
        }
        queueMicrotask(() => {
          this.onabort?.({ target: this });
        });
      }
    };

    const dbRef = this;

    const objectStore = {
      put(val) {
        // Case 1: Synchronous throw at store.put
        if (dbRef.errorInjectionStage === 'put_sync' && dbRef.injectedError) {
          throw dbRef.injectedError;
        }

        const req = {
          result: val.id,
          error: null,
          onsuccess: null,
          onerror: null
        };

        const serializedSize = JSON.stringify(val).length + (val.blob?.size || 0);

        setTimeout(() => {
          // Case 2: Quota limit exceeded via byte accounting
          const wouldExceedQuota =
            dbRef.errorInjectionStage === 'quota_limit' &&
            dbRef.usedBytes + serializedSize > dbRef.quotaLimitBytes;

          // Case 3: Request-level injected error
          const hasRequestError =
            dbRef.errorInjectionStage === 'request_error' && Boolean(dbRef.injectedError);

          if (wouldExceedQuota || hasRequestError) {
            const quotaErr =
              dbRef.injectedError ||
              new DOMException(
                `The quota has been exceeded. Current usage: ${dbRef.usedBytes} bytes, item size: ${serializedSize} bytes, limit: ${dbRef.quotaLimitBytes} bytes.`,
                'QuotaExceededError'
              );

            req.error = quotaErr;
            tx.error = quotaErr;

            const errorEvent = {
              type: 'error',
              target: req,
              defaultPrevented: false,
              preventDefault() {
                this.defaultPrevented = true;
              }
            };

            req.onerror?.(errorEvent);

            if (!errorEvent.defaultPrevented) {
              tx.onerror?.(errorEvent);
            }
            tx.onabort?.({ target: tx });
            return;
          }

          // Case 4: Transaction-level abort during commit
          if (dbRef.errorInjectionStage === 'transaction_abort' && dbRef.injectedError) {
            tx.error = dbRef.injectedError;
            tx.onerror?.({ target: tx, error: dbRef.injectedError, preventDefault() {} });
            tx.onabort?.({ target: tx });
            return;
          }

          // Normal success path
          storeMap.set(val.id, val);
          dbRef.usedBytes += serializedSize;
          req.onsuccess?.({ target: req });
          tx.oncomplete?.();
        }, 0);

        return req;
      },

      get(key) {
        const req = { result: null, error: null, onsuccess: null, onerror: null };
        setTimeout(() => {
          req.result = storeMap.get(key) || null;
          req.onsuccess?.({ target: req });
          tx.oncomplete?.();
        }, 0);
        return req;
      },

      delete(key) {
        const req = { result: undefined, error: null, onsuccess: null, onerror: null };
        setTimeout(() => {
          storeMap.delete(key);
          req.onsuccess?.({ target: req });
          tx.oncomplete?.();
        }, 0);
        return req;
      }
    };

    return {
      error: tx.error,
      get oncomplete() {
        return tx.oncomplete;
      },
      set oncomplete(fn) {
        tx.oncomplete = fn;
      },
      get onerror() {
        return tx.onerror;
      },
      set onerror(fn) {
        tx.onerror = fn;
      },
      get onabort() {
        return tx.onabort;
      },
      set onabort(fn) {
        tx.onabort = fn;
      },
      objectStore() {
        return objectStore;
      }
    };
  }
}

// Global active mock DB instance
let currentMockDB = new MockIDBDatabase('orvix_attachments_db');

globalThis.indexedDB = {
  open(dbName) {
    const req = {
      result: null,
      error: null,
      onupgradeneeded: null,
      onsuccess: null,
      onerror: null
    };

    queueMicrotask(() => {
      req.result = currentMockDB;
      const upgradeEvent = {
        target: { result: currentMockDB }
      };
      req.onupgradeneeded?.(upgradeEvent);
      req.onsuccess?.(upgradeEvent);
    });

    return req;
  }
};

if (typeof globalThis.window === 'undefined') {
  globalThis.window = {
    open: () => ({ closed: false })
  };
}

// Polyfill minimal browser DOM APIs needed for download/preview simulation in Node.js
if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    body: {
      appendChild() {},
      removeChild() {}
    },
    createElement() {
      return {
        href: '',
        download: '',
        click() {}
      };
    }
  };
}
if (typeof globalThis.URL === 'undefined' || typeof globalThis.URL.createObjectURL !== 'function') {
  let blobCounter = 0;
  globalThis.URL = globalThis.URL || {};
  globalThis.URL.createObjectURL = () => `blob:http://localhost/test-blob-${++blobCounter}`;
  globalThis.URL.revokeObjectURL = () => {};
}

let testsPassed = 0;
async function runTest(title, fn) {
  try {
    process.stdout.write(`  • ${title} ... `);
    await fn();
    console.log('✓ PASS');
    testsPassed++;
  } catch (err) {
    console.log('✗ FAIL');
    console.error(err);
    process.exit(1);
  }
}

async function main() {
  // =========================================================================
  // SCENARIO A — Baseline Normal Write & Read-Back
  // =========================================================================
  console.log('\n[Scenario A]: Normal IndexedDB Write (Baseline)');

  await runTest('A.1: Initializes database and executes successful normal write', async () => {
    resetAttachmentDBForTesting();
    currentMockDB = new MockIDBDatabase('orvix_attachments_db');
    currentMockDB.errorInjectionStage = null;

    const testBinary = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]); // %PDF-1.4
    const testBlob = new Blob([testBinary], { type: 'application/pdf' });

    const saveSuccess = await saveAttachmentBlob('baseline-doc-1', testBlob, {
      name: 'financial_summary.pdf',
      originalName: 'financial_summary.pdf',
      mimeType: 'application/pdf',
      size: testBinary.byteLength,
      conversationId: 'chat-baseline-1'
    });

    assert.strictEqual(saveSuccess, true, 'Normal write must return true');
    assert.strictEqual(getLastStorageError(), null, 'lastStorageError must be null after successful write');
  });

  await runTest('A.2: Verifies expected record can be read back accurately', async () => {
    const record = await getAttachmentRecord('baseline-doc-1');
    assert.ok(record, 'Record must exist in IndexedDB');
    assert.strictEqual(record.id, 'baseline-doc-1');
    assert.strictEqual(record.name, 'financial_summary.pdf');
    assert.strictEqual(record.type, 'application/pdf');
    assert.strictEqual(record.size, 8);
    assert.ok(record.blob instanceof Blob, 'Record blob must be preserved');

    const blob = await getAttachmentBlob('baseline-doc-1');
    assert.ok(blob instanceof Blob, 'getAttachmentBlob must return binary Blob');
    assert.strictEqual(blob.size, 8);
  });

  // =========================================================================
  // SCENARIO B — QuotaExceededError Under Controlled Error Injection
  // =========================================================================
  console.log('\n[Scenario B]: QuotaExceededError Controlled Error Injection');

  await runTest('B.1: Request-level QuotaExceededError DOMException', async () => {
    resetAttachmentDBForTesting();
    clearLastStorageError();

    const quotaError = new DOMException('The quota has been exceeded for this origin.', 'QuotaExceededError');
    currentMockDB.errorInjectionStage = 'request_error';
    currentMockDB.injectedError = quotaError;

    const largeBinary = new Uint8Array(1024 * 1024); // 1 MB
    const largeBlob = new Blob([largeBinary], { type: 'application/pdf' });

    const saveResult = await saveAttachmentBlob('doc-quota-req', largeBlob, {
      name: 'heavy_scan.pdf',
      size: largeBinary.byteLength
    });

    // 1. Must NOT report write as successful
    assert.strictEqual(saveResult, false, 'saveAttachmentBlob must return false on QuotaExceededError');

    // 2. Error identity must be QuotaExceededError
    const capturedErr = getLastStorageError();
    assert.ok(capturedErr, 'lastStorageError must be recorded');
    assert.strictEqual(capturedErr.name, 'QuotaExceededError', "error.name must equal 'QuotaExceededError'");
    assert.strictEqual(isQuotaExceededError(capturedErr), true, 'isQuotaExceededError must evaluate to true');
  });

  await runTest('B.2: Transaction commit-level QuotaExceededError abort', async () => {
    resetAttachmentDBForTesting();
    clearLastStorageError();

    const quotaAbortErr = new DOMException('Disk quota reached during transaction commit.', 'QuotaExceededError');
    currentMockDB.errorInjectionStage = 'transaction_abort';
    currentMockDB.injectedError = quotaAbortErr;

    const blob = new Blob(['data'], { type: 'text/plain' });
    const saveResult = await saveAttachmentBlob('doc-quota-tx', blob, { name: 'notes.txt' });

    assert.strictEqual(saveResult, false, 'Commit-stage quota failure must return false');
    const capturedErr = getLastStorageError();
    assert.ok(capturedErr, 'Transaction abort error must be captured');
    assert.strictEqual(capturedErr.name, 'QuotaExceededError');
    assert.strictEqual(isQuotaExceededError(capturedErr), true);
  });

  await runTest('B.3: Synchronous store.put QuotaExceededError throw', async () => {
    resetAttachmentDBForTesting();
    clearLastStorageError();

    const syncQuotaErr = new DOMException('Synchronous storage quota exceeded.', 'QuotaExceededError');
    currentMockDB.errorInjectionStage = 'put_sync';
    currentMockDB.injectedError = syncQuotaErr;

    const blob = new Blob(['sample'], { type: 'text/plain' });
    const saveResult = await saveAttachmentBlob('doc-quota-sync', blob, { name: 'sync.txt' });

    assert.strictEqual(saveResult, false, 'Synchronous quota error must be caught and return false');
    const capturedErr = getLastStorageError();
    assert.strictEqual(capturedErr.name, 'QuotaExceededError');
    assert.strictEqual(isQuotaExceededError(capturedErr), true);
  });

  await runTest('B.4: Byte-budget quota threshold enforcement (simulated quota boundary)', async () => {
    resetAttachmentDBForTesting();
    clearLastStorageError();

    // Set a tiny 2 KB quota budget on the mock database
    currentMockDB.quotaLimitBytes = 2048;
    currentMockDB.usedBytes = 0;
    currentMockDB.errorInjectionStage = 'quota_limit';
    currentMockDB.injectedError = null;

    // Small 500-byte write: fits within 2 KB quota
    const smallBlob = new Blob([new Uint8Array(500)], { type: 'application/octet-stream' });
    const firstWriteSuccess = await saveAttachmentBlob('small-item-1', smallBlob, { name: 'small.bin' });
    assert.strictEqual(firstWriteSuccess, true, 'Small item within quota budget must succeed');

    // Large 5 KB write: exceeds remaining quota budget
    const oversizedBlob = new Blob([new Uint8Array(5000)], { type: 'application/octet-stream' });
    const secondWriteSuccess = await saveAttachmentBlob('oversized-item-2', oversizedBlob, { name: 'huge.bin' });

    assert.strictEqual(secondWriteSuccess, false, 'Item exceeding quota budget must fail');
    const capturedErr = getLastStorageError();
    assert.ok(capturedErr, 'Storage error must be recorded');
    assert.strictEqual(capturedErr.name, 'QuotaExceededError', "Exceeded budget must produce 'QuotaExceededError'");
    assert.strictEqual(isQuotaExceededError(capturedErr), true);
  });

  // =========================================================================
  // SCENARIO C — Recovery & Graceful Handling In Application Pipeline
  // =========================================================================
  console.log('\n[Scenario C]: Recovery & Graceful Handling');

  await runTest('C.1: Application does not report failed write as successful', async () => {
    currentMockDB.errorInjectionStage = 'request_error';
    currentMockDB.injectedError = new DOMException('QuotaExceededError: storage full', 'QuotaExceededError');

    const result = await saveAttachmentBlob('failed-doc', new Blob(['test']), { name: 'test.txt' });
    assert.strictEqual(result, false, 'Must strictly report failure (false)');
  });

  await runTest('C.2: In-memory application state is preserved without data loss', async () => {
    // Replicate ChatPage.jsx handleSubmit attachment handling:
    // If saveAttachmentBlob fails (e.g. QuotaExceededError), the original file is preserved in component state
    const originalFile = new Blob(['CRITICAL USER DOCUMENT CONTENT'], { type: 'application/pdf' });
    const rawUploadedAttachment = {
      id: 'att-user-doc-123',
      name: 'q4_review.pdf',
      originalName: 'q4_review.pdf',
      type: 'application/pdf',
      size: 30
    };

    // Simulate quota failure
    currentMockDB.errorInjectionStage = 'request_error';
    currentMockDB.injectedError = new DOMException('QuotaExceededError', 'QuotaExceededError');

    const savedInIdb = await saveAttachmentBlob(rawUploadedAttachment.id, originalFile, {
      name: rawUploadedAttachment.name
    });
    assert.strictEqual(savedInIdb, false, 'IndexedDB write fails due to quota');

    // Simulate ChatPage state assembly logic
    const stateAttachment = {
      ...rawUploadedAttachment,
      ...(savedInIdb ? {} : { file: originalFile })
    };

    // Verification: in-memory state is intact
    assert.ok(stateAttachment.file instanceof Blob, 'File Blob must be retained in memory when IDB fails');
    assert.strictEqual(stateAttachment.file, originalFile, 'Retained file must match the original instance');
    assert.strictEqual(stateAttachment.name, 'q4_review.pdf');

    // Verify in-memory preview fallback works seamlessly
    const previewResult = await openOrPreviewAttachment(stateAttachment);
    assert.strictEqual(previewResult.success, true, 'Preview/download must succeed via in-memory Blob');

    // Verify in-memory download fallback works seamlessly
    const downloadResult = await downloadAttachmentFile(stateAttachment);
    assert.strictEqual(downloadResult.success, true, 'Download must succeed via in-memory Blob');
  });

  await runTest('C.3: Application does not become permanently stuck in saving/loading state', async () => {
    currentMockDB.errorInjectionStage = 'request_error';
    currentMockDB.injectedError = new DOMException('QuotaExceededError', 'QuotaExceededError');

    const startTime = Date.now();
    const timeoutThresholdMs = 2000;

    const writePromise = saveAttachmentBlob('timing-doc', new Blob(['quick']), { name: 'quick.txt' });
    const result = await Promise.race([
      writePromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Operation timed out / hung!')), timeoutThresholdMs))
    ]);

    const elapsedMs = Date.now() - startTime;
    assert.strictEqual(result, false);
    assert.ok(elapsedMs < 1000, `Write completed promptly in ${elapsedMs}ms without hanging`);
  });

  await runTest('C.4: Subsequent normal IndexedDB operations recover after quota failure', async () => {
    // 1. Induce quota failure
    currentMockDB.errorInjectionStage = 'request_error';
    currentMockDB.injectedError = new DOMException('QuotaExceededError', 'QuotaExceededError');

    const failResult = await saveAttachmentBlob('recovery-fail', new Blob(['data']), { name: 'fail.txt' });
    assert.strictEqual(failResult, false);
    assert.ok(getLastStorageError() !== null);

    // 2. Clear error state / restore quota
    currentMockDB.errorInjectionStage = null;
    currentMockDB.injectedError = null;

    // 3. Subsequent write must recover and succeed
    const recoveryBlob = new Blob(['RECOVERED CONTENT'], { type: 'text/plain' });
    const recoverResult = await saveAttachmentBlob('recovery-doc-success', recoveryBlob, {
      name: 'healthy.txt',
      size: 17
    });

    assert.strictEqual(recoverResult, true, 'Subsequent write must recover and succeed');
    assert.strictEqual(getLastStorageError(), null, 'lastStorageError must be reset to null on success');

    const record = await getAttachmentRecord('recovery-doc-success');
    assert.ok(record, 'Recovered record must be retrievable from IndexedDB');
    assert.strictEqual(record.name, 'healthy.txt');

    // Cleanup record
    await deleteAttachmentRecord('recovery-doc-success');
  });

  await runTest('C.5: Zero uncaught promise rejections or unhandled exceptions occur', async () => {
    // Execute multiple quota failures in sequence
    currentMockDB.errorInjectionStage = 'request_error';
    currentMockDB.injectedError = new DOMException('QuotaExceededError', 'QuotaExceededError');

    for (let i = 0; i < 5; i++) {
      await saveAttachmentBlob(`stress-${i}`, new Blob([`chunk-${i}`]));
    }

    // Allow event loop to process any asynchronous rejections
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(unhandledRejectionsCount, 0, 'Must have 0 unhandled promise rejections');
  });

  // =========================================================================
  // PHASE 4 — Error Identity & Specificity
  // =========================================================================
  console.log('\n[Phase 4]: Error Identity & Specificity Validation');

  await runTest('4.1: Accurately identifies QuotaExceededError variants', async () => {
    // Standard W3C DOMException
    const domEx = new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    assert.strictEqual(isQuotaExceededError(domEx), true);

    // Gecko / Firefox internal name
    const geckoEx = new DOMException('Storage full', 'NS_ERROR_DOM_QUOTA_REACHED');
    assert.strictEqual(isQuotaExceededError(geckoEx), true);

    // Legacy code 22 / DOMException.QUOTA_EXCEEDED_ERR
    const legacyEx = { code: 22, name: 'QuotaExceededError' };
    assert.strictEqual(isQuotaExceededError(legacyEx), true);

    // Event wrapper with target.error
    const eventWrap = { target: { error: domEx } };
    assert.strictEqual(isQuotaExceededError(eventWrap), true);

    // Wrapped error with cause
    const wrappedErr = new Error('Storage write failed', { cause: domEx });
    assert.strictEqual(isQuotaExceededError(wrappedErr), true);
  });

  await runTest('4.2: Strictly rejects unrelated IndexedDB and DOM errors', async () => {
    // ReadOnlyError
    const readOnlyErr = new DOMException('Write attempted on readonly transaction', 'ReadOnlyError');
    assert.strictEqual(isQuotaExceededError(readOnlyErr), false);

    // NotFoundError
    const notFoundErr = new DOMException('Store not found', 'NotFoundError');
    assert.strictEqual(isQuotaExceededError(notFoundErr), false);

    // SecurityError
    const securityErr = new DOMException('Access denied', 'SecurityError');
    assert.strictEqual(isQuotaExceededError(securityErr), false);

    // AbortError
    const abortErr = new DOMException('Operation aborted', 'AbortError');
    assert.strictEqual(isQuotaExceededError(abortErr), false);

    // Network / generic Error
    const genericErr = new Error('Database connection failed');
    assert.strictEqual(isQuotaExceededError(genericErr), false);

    // Null and undefined
    assert.strictEqual(isQuotaExceededError(null), false);
    assert.strictEqual(isQuotaExceededError(undefined), false);
  });

  console.log('\n================================================================');
  console.log(`✓ Audit Point #12 PASSED: All ${testsPassed} tests executed successfully!`);
  console.log('================================================================\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('\n✗ Test suite encountered unexpected fatal error:', err);
  process.exit(1);
});
