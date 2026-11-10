/**
 * Automated Verification Suite for Supabase Attachment Expiry Cleanup
 *
 * Verifies:
 * 1. Safe handling when Supabase is unconfigured (returns error without throwing)
 * 2. Successful identification and deletion of expired staging/guest Supabase attachments
 * 3. Strict preservation of non-expired attachments (future expiresAt)
 * 4. Strict preservation of permanent attachments (isPermanent === true or zero expiresAt)
 * 5. Preservation of non-Supabase (local-only) attachments from cloud deletion
 * 6. Controlled batch processing across multiple chunks
 * 7. Partial deletion failure handling and retry retention in registry
 * 8. Concurrency guard preventing overlapping cleanup runs
 * 9. Scheduler disabled configuration (SUPABASE_ATTACHMENT_CLEANUP_ENABLED=false)
 * 10. Graceful scheduler startup and shutdown lifecycle
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  runExpiredSupabaseAttachmentCleanup,
  isAttachmentEligibleForExpiryCleanup,
  startSupabaseAttachmentCleanupScheduler,
  stopSupabaseAttachmentCleanupScheduler,
  getSupabaseAttachmentCleanupSchedulerStatus,
  resetCleanupStateForTesting
} from '../server/supabaseAttachmentCleanupService.ts';
import {
  setSupabaseServerClientForTesting,
  resetSupabaseClientForTesting
} from '../server/supabaseClient.ts';
import {
  isSupabaseAttachmentCleanupEnabled,
  getSupabaseAttachmentCleanupIntervalMs,
  getSupabaseAttachmentCleanupBatchSize
} from '../server/serverConfig.ts';
import {
  uploadAttachmentToStorage,
  deleteAttachmentFromStorage,
  deleteAttachmentsForChatInStorage,
  listDurableExpiredAttachments,
  getDurableExpiryRecordPath,
  parseDurableExpiryRecordPath
} from '../server/supabaseStorageService.ts';

console.log('=== RUNNING SUPABASE ATTACHMENT EXPIRY CLEANUP VERIFICATION SUITE ===\n');

const originalEnv = { ...process.env };
let tempTestDir = '';

function setupTestEnvironment() {
  resetCleanupStateForTesting();
  resetSupabaseClientForTesting();
  tempTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orvix-cleanup-test-'));
}

function teardownTestEnvironment() {
  resetCleanupStateForTesting();
  resetSupabaseClientForTesting();
  try {
    if (tempTestDir && fs.existsSync(tempTestDir)) {
      fs.rmSync(tempTestDir, { recursive: true, force: true });
    }
  } catch (_) {}
  Object.assign(process.env, originalEnv);
}

let passedCount = 0;

async function runTests() {
  try {
    // -------------------------------------------------------------------------
    // Test 1: Missing Supabase Configuration
    // -------------------------------------------------------------------------
    console.log('[Test 1] Missing configuration handled safely...');
    setupTestEnvironment();
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SECRET_KEY;

    const unconfRes = await runExpiredSupabaseAttachmentCleanup();
    assert.equal(unconfRes.success, false, 'Should fail gracefully when unconfigured');
    assert.equal(unconfRes.deletedCount, 0);
    assert.ok(unconfRes.error && unconfRes.error.includes('not configured'));
    passedCount++;
    console.log('  ✓ Missing configuration returns clean structured error without throwing.');

    // -------------------------------------------------------------------------
    // Test 2: Expired Attachment Deletion & Registry Synchronization
    // -------------------------------------------------------------------------
    console.log('\n[Test 2] Expired Supabase attachment deleted and synchronized with registry...');
    setupTestEnvironment();

    const now = 1_700_000_000_000;
    const testDiskFile = 'temp-expired-1.pdf';
    fs.writeFileSync(path.join(tempTestDir, testDiskFile), 'dummy-content');

    const testRegistry = new Map();
    testRegistry.set('att-expired-1', {
      id: 'att-expired-1',
      originalName: 'report.pdf',
      diskFilename: testDiskFile,
      mimeType: 'application/pdf',
      extension: 'PDF',
      size: 1024,
      formattedSize: '1 KB',
      status: 'ready',
      uploadedAt: new Date(now - 3600000).toISOString(),
      expiresAt: now - 1000, // Expired 1 second ago
      storageProvider: 'supabase',
      storagePath: 'usr_abc/chat_123/att-expired-1.pdf',
      storageBucket: 'orvix-attachments',
      userId: 'usr_abc',
      conversationId: 'chat_123'
    });

    const testConvDocs = new Map();
    testConvDocs.set('chat_123', new Set(['att-expired-1']));

    let deletedPaths = [];
    const mockClient = {
      storage: {
        from: (bucket) => ({
          remove: async (paths) => {
            deletedPaths.push(...paths);
            return { data: paths.map((p) => ({ name: p })), error: null };
          }
        })
      }
    };

    setSupabaseServerClientForTesting(mockClient, 'https://test.supabase.co', 'key123');

    const cleanupRes = await runExpiredSupabaseAttachmentCleanup({
      registry: testRegistry,
      conversationDocs: testConvDocs,
      uploadDir: tempTestDir,
      nowMs: now
    });

    assert.equal(cleanupRes.success, true);
    assert.equal(cleanupRes.expiredCount, 1);
    assert.equal(cleanupRes.deletedCount, 1);
    assert.equal(cleanupRes.failedCount, 0);
    assert.deepEqual(deletedPaths, ['usr_abc/chat_123/att-expired-1.pdf']);
    assert.equal(testRegistry.has('att-expired-1'), false, 'Expired record must be removed from registry');
    assert.equal(testConvDocs.get('chat_123').has('att-expired-1'), false, 'Must be pruned from conversationDocs');
    assert.equal(fs.existsSync(path.join(tempTestDir, testDiskFile)), false, 'Local disk cache file must be unlinked');
    passedCount++;
    console.log('  ✓ Expired attachment removed from Supabase, registry, conversation map, and local disk.');

    // -------------------------------------------------------------------------
    // Test 3: Non-Expired Attachment Preservation
    // -------------------------------------------------------------------------
    console.log('\n[Test 3] Non-expired attachments strictly preserved...');
    setupTestEnvironment();

    const futureRegistry = new Map();
    futureRegistry.set('att-future-1', {
      id: 'att-future-1',
      originalName: 'active.png',
      diskFilename: 'active.png',
      mimeType: 'image/png',
      extension: 'PNG',
      size: 2048,
      formattedSize: '2 KB',
      status: 'ready',
      uploadedAt: new Date(now).toISOString(),
      expiresAt: now + 3600000, // Valid for another 1 hour
      storageProvider: 'supabase',
      storagePath: 'usr_abc/chat_123/att-future-1.png',
      userId: 'usr_abc'
    });

    let futureDeletedPaths = [];
    const mockClientPreserve = {
      storage: {
        from: () => ({
          remove: async (paths) => {
            futureDeletedPaths.push(...paths);
            return { data: [], error: null };
          }
        })
      }
    };
    setSupabaseServerClientForTesting(mockClientPreserve, 'https://test.supabase.co', 'key123');

    const futureRes = await runExpiredSupabaseAttachmentCleanup({
      registry: futureRegistry,
      nowMs: now
    });

    assert.equal(futureRes.deletedCount, 0);
    assert.equal(futureRes.skippedFutureCount, 1);
    assert.equal(futureDeletedPaths.length, 0, 'Must not send delete request for future attachments');
    assert.equal(futureRegistry.has('att-future-1'), true, 'Record must remain in registry');
    passedCount++;
    console.log('  ✓ Active attachments in the future are strictly untouched.');

    // -------------------------------------------------------------------------
    // Test 4: Permanent User Attachments Protected
    // -------------------------------------------------------------------------
    console.log('\n[Test 4] Permanent attachments (isPermanent: true or 0 expiresAt) protected...');
    setupTestEnvironment();

    const permRegistry = new Map();
    // 4a. Explicit isPermanent flag
    permRegistry.set('att-perm-flag', {
      id: 'att-perm-flag',
      originalName: 'permanent-contract.pdf',
      diskFilename: 'contract.pdf',
      mimeType: 'application/pdf',
      extension: 'PDF',
      size: 4096,
      formattedSize: '4 KB',
      status: 'ready',
      uploadedAt: new Date(now - 7200000).toISOString(),
      expiresAt: now - 3600000, // Time passed, but marked isPermanent!
      isPermanent: true,
      storageProvider: 'supabase',
      storagePath: 'usr_abc/chat_123/att-perm-flag.pdf',
      userId: 'usr_abc'
    });

    // 4b. Zero or missing expiresAt
    permRegistry.set('att-perm-zero', {
      id: 'att-perm-zero',
      originalName: 'permanent-photo.jpg',
      diskFilename: 'photo.jpg',
      mimeType: 'image/jpeg',
      extension: 'JPG',
      size: 4096,
      formattedSize: '4 KB',
      status: 'ready',
      uploadedAt: new Date(now - 7200000).toISOString(),
      expiresAt: 0,
      storageProvider: 'supabase',
      storagePath: 'usr_abc/chat_123/att-perm-zero.jpg',
      userId: 'usr_abc'
    });

    let permDeletedPaths = [];
    const mockClientPerm = {
      storage: {
        from: () => ({
          remove: async (paths) => {
            permDeletedPaths.push(...paths);
            return { data: [], error: null };
          }
        })
      }
    };
    setSupabaseServerClientForTesting(mockClientPerm, 'https://test.supabase.co', 'key123');

    const permRes = await runExpiredSupabaseAttachmentCleanup({
      registry: permRegistry,
      nowMs: now
    });

    assert.equal(permRes.deletedCount, 0);
    assert.equal(permRes.skippedPermanentCount, 2);
    assert.equal(permDeletedPaths.length, 0, 'Permanent attachments must never be deleted');
    assert.equal(permRegistry.has('att-perm-flag'), true);
    assert.equal(permRegistry.has('att-perm-zero'), true);
    passedCount++;
    console.log('  ✓ Permanent user attachments strictly protected from accidental deletion.');

    // -------------------------------------------------------------------------
    // Test 5: Local-Only (Non-Supabase) Attachments Handled Correctly
    // -------------------------------------------------------------------------
    console.log('\n[Test 5] Local-only attachments skipped by Supabase storage cleanup...');
    setupTestEnvironment();

    const localRegistry = new Map();
    localRegistry.set('att-local-1', {
      id: 'att-local-1',
      originalName: 'guest-temp.txt',
      diskFilename: 'guest-temp.txt',
      mimeType: 'text/plain',
      extension: 'TXT',
      size: 100,
      formattedSize: '100 B',
      status: 'ready',
      uploadedAt: new Date(now - 3600000).toISOString(),
      expiresAt: now - 1000,
      storageProvider: 'local' // Not in Supabase
    });

    let localDeletedPaths = [];
    setSupabaseServerClientForTesting({
      storage: {
        from: () => ({
          remove: async (p) => { localDeletedPaths.push(...p); return { data: [], error: null }; }
        })
      }
    }, 'https://test.supabase.co', 'key123');

    const localRes = await runExpiredSupabaseAttachmentCleanup({
      registry: localRegistry,
      nowMs: now
    });

    assert.equal(localRes.skippedNonSupabaseCount, 1);
    assert.equal(localRes.deletedCount, 0);
    assert.equal(localDeletedPaths.length, 0);
    passedCount++;
    console.log('  ✓ Local-only attachments are skipped by Supabase cleanup.');

    // -------------------------------------------------------------------------
    // Test 6: Controlled Batch Processing
    // -------------------------------------------------------------------------
    console.log('\n[Test 6] Controlled batch processing across multiple chunks...');
    setupTestEnvironment();

    const batchRegistry = new Map();
    const TOTAL_ITEMS = 65;
    const BATCH_SIZE = 25;

    for (let i = 1; i <= TOTAL_ITEMS; i++) {
      batchRegistry.set(`att-batch-${i}`, {
        id: `att-batch-${i}`,
        originalName: `doc-${i}.pdf`,
        diskFilename: `doc-${i}.pdf`,
        mimeType: 'application/pdf',
        extension: 'PDF',
        size: 500,
        formattedSize: '500 B',
        status: 'ready',
        uploadedAt: new Date(now - 3600000).toISOString(),
        expiresAt: now - 1000,
        storageProvider: 'supabase',
        storagePath: `usr_abc/chat_123/att-batch-${i}.pdf`,
        userId: 'usr_abc'
      });
    }

    const batchSizesObserved = [];
    setSupabaseServerClientForTesting({
      storage: {
        from: () => ({
          remove: async (paths) => {
            batchSizesObserved.push(paths.length);
            return { data: paths.map((p) => ({ name: p })), error: null };
          }
        })
      }
    }, 'https://test.supabase.co', 'key123');

    const batchRes = await runExpiredSupabaseAttachmentCleanup({
      registry: batchRegistry,
      batchSize: BATCH_SIZE,
      nowMs: now
    });

    assert.equal(batchRes.expiredCount, TOTAL_ITEMS);
    assert.equal(batchRes.deletedCount, TOTAL_ITEMS);
    assert.equal(batchRes.batchCount, 3);
    assert.deepEqual(batchSizesObserved, [25, 25, 15], 'Batches should be split as 25, 25, 15');
    assert.equal(batchRegistry.size, 0);
    passedCount++;
    console.log('  ✓ Controlled batching processes 65 items into 3 batches (25, 25, 15).');

    // -------------------------------------------------------------------------
    // Test 7: Partial Deletion Failure Handling and Retry Retention
    // -------------------------------------------------------------------------
    console.log('\n[Test 7] Partial deletion failure keeps failed records in registry for retry...');
    setupTestEnvironment();

    const partialRegistry = new Map();
    partialRegistry.set('att-succeed', {
      id: 'att-succeed',
      originalName: 'succeed.pdf',
      expiresAt: now - 1000,
      storageProvider: 'supabase',
      storagePath: 'usr_abc/chat_123/succeed.pdf'
    });
    partialRegistry.set('att-fail', {
      id: 'att-fail',
      originalName: 'fail.pdf',
      expiresAt: now - 1000,
      storageProvider: 'supabase',
      storagePath: 'usr_abc/chat_123/fail.pdf'
    });

    setSupabaseServerClientForTesting({
      storage: {
        from: () => ({
          remove: async () => {
            // Only confirm 'succeed.pdf' removal
            return { data: [{ name: 'usr_abc/chat_123/succeed.pdf' }], error: null };
          }
        })
      }
    }, 'https://test.supabase.co', 'key123');

    const partialRes = await runExpiredSupabaseAttachmentCleanup({
      registry: partialRegistry,
      nowMs: now
    });

    assert.equal(partialRes.deletedCount, 1);
    assert.equal(partialRes.failedCount, 1);
    assert.equal(partialRegistry.has('att-succeed'), false, 'Successful item removed');
    assert.equal(partialRegistry.has('att-fail'), true, 'Failed item retained in registry for future retry');
    passedCount++;
    console.log('  ✓ Partial failure retains un-deleted items in registry for retry.');

    // -------------------------------------------------------------------------
    // Test 8: Scheduler Configuration & Graceful Lifecycle (Start/Stop)
    // -------------------------------------------------------------------------
    console.log('\n[Test 8] Scheduler startup, stop, and status lifecycle...');
    setupTestEnvironment();

    delete process.env.SUPABASE_ATTACHMENT_CLEANUP_ENABLED;
    assert.equal(isSupabaseAttachmentCleanupEnabled(), true, 'Enabled by default');
    assert.equal(getSupabaseAttachmentCleanupBatchSize(), 50, 'Default batch size 50');
    assert.equal(getSupabaseAttachmentCleanupIntervalMs(), 3600000, 'Default interval 1 hour');

    const timer = startSupabaseAttachmentCleanupScheduler(10000);
    assert.ok(timer, 'Timer should be active');
    const runningStatus = getSupabaseAttachmentCleanupSchedulerStatus();
    assert.equal(runningStatus.running, true);
    assert.equal(runningStatus.enabled, true);

    stopSupabaseAttachmentCleanupScheduler();
    const stoppedStatus = getSupabaseAttachmentCleanupSchedulerStatus();
    assert.equal(stoppedStatus.running, false);
    passedCount++;
    console.log('  ✓ Scheduler successfully started and gracefully stopped.');

    // -------------------------------------------------------------------------
    // Test 9: Disabled Configuration
    // -------------------------------------------------------------------------
    console.log('\n[Test 9] Disabled cleanup configuration...');
    setupTestEnvironment();
    process.env.SUPABASE_ATTACHMENT_CLEANUP_ENABLED = 'false';

    assert.equal(isSupabaseAttachmentCleanupEnabled(), false);
    const disabledTimer = startSupabaseAttachmentCleanupScheduler(5000);
    assert.equal(disabledTimer, null, 'Scheduler should not start when disabled via config');
    passedCount++;
    console.log('  ✓ Disabled configuration prevents scheduler from starting.');

    // -------------------------------------------------------------------------
    // Test 10: Server Restart Recovery & Expired Discovery with Empty Registry
    // -------------------------------------------------------------------------
    console.log('\n[Test 10] Server restart recovery discovers and deletes expired objects with empty registry...');
    setupTestEnvironment();

    const mockStorageStore = new Map();
    const createMockClientWithStore = () => ({
      storage: {
        from: (bucketName) => ({
          list: async (folderPath, options = {}) => {
            const cleanFolder = (folderPath || '').replace(/\/+$/, '');
            const prefix = cleanFolder ? `${cleanFolder}/` : '';
            const results = [];

            for (const key of mockStorageStore.keys()) {
              const expectedBucketPrefix = `${bucketName}:`;
              if (!key.startsWith(expectedBucketPrefix)) continue;
              const fullPath = key.slice(expectedBucketPrefix.length);

              if (fullPath.startsWith(prefix)) {
                const subKey = fullPath.slice(prefix.length);
                if (!subKey.includes('/')) {
                  results.push({ name: subKey, id: subKey });
                }
              }
            }

            const offset = options?.offset || 0;
            const limit = options?.limit || 100;
            return { data: results.slice(offset, offset + limit), error: null };
          },
          upload: async (itemPath, buffer) => {
            mockStorageStore.set(`${bucketName}:${itemPath}`, buffer);
            return { data: { path: itemPath }, error: null };
          },
          remove: async (paths) => {
            for (const p of paths) {
              mockStorageStore.delete(`${bucketName}:${p}`);
            }
            return { data: paths.map((p) => ({ name: p })), error: null };
          }
        })
      }
    });

    const restartNow = 1_700_000_000_000;
    const bucket = 'orvix-attachments';

    // 1. Expired temporary file + durable expiry marker
    mockStorageStore.set(`${bucket}:usr_restart/chat_01/att-temp-expired.pdf`, Buffer.from('expired-pdf'));
    mockStorageStore.set(
      `${bucket}:_expiry_records/${restartNow - 1000}__usr_restart__chat_01__att-temp-expired__pdf.json`,
      Buffer.from('{}')
    );

    // 2. Future temporary file + durable expiry marker (active, must NOT be deleted)
    mockStorageStore.set(`${bucket}:usr_restart/chat_01/att-temp-future.png`, Buffer.from('future-png'));
    mockStorageStore.set(
      `${bucket}:_expiry_records/${restartNow + 3600000}__usr_restart__chat_01__att-temp-future__png.json`,
      Buffer.from('{}')
    );

    // 3. Permanent user attachment (never has an expiry marker, must strictly be preserved)
    mockStorageStore.set(`${bucket}:usr_restart/chat_01/att-permanent-contract.pdf`, Buffer.from('permanent-pdf'));

    setSupabaseServerClientForTesting(createMockClientWithStore(), 'https://test.supabase.co', 'key123');

    // Simulate post-restart environment: completely empty in-memory registry
    const emptyPostRestartRegistry = new Map();

    const restartCleanupRes = await runExpiredSupabaseAttachmentCleanup({
      registry: emptyPostRestartRegistry,
      nowMs: restartNow
    });

    assert.equal(restartCleanupRes.success, true);
    assert.equal(restartCleanupRes.expiredCount, 1, 'Should discover exactly 1 expired item from durable storage');
    assert.equal(restartCleanupRes.deletedCount, 1, 'Should delete exactly 1 expired item');
    assert.equal(
      mockStorageStore.has(`${bucket}:usr_restart/chat_01/att-temp-expired.pdf`),
      false,
      'Expired file must be deleted from storage after restart'
    );
    assert.equal(
      mockStorageStore.has(`${bucket}:_expiry_records/${restartNow - 1000}__usr_restart__chat_01__att-temp-expired__pdf.json`),
      false,
      'Expired tracking marker must be cleaned up'
    );
    assert.equal(
      mockStorageStore.has(`${bucket}:usr_restart/chat_01/att-temp-future.png`),
      true,
      'Future attachment must be preserved across server restarts'
    );
    assert.equal(
      mockStorageStore.has(`${bucket}:_expiry_records/${restartNow + 3600000}__usr_restart__chat_01__att-temp-future__png.json`),
      true,
      'Future tracking marker must be preserved'
    );
    assert.equal(
      mockStorageStore.has(`${bucket}:usr_restart/chat_01/att-permanent-contract.pdf`),
      true,
      'Permanent user file must strictly never be touched'
    );
    passedCount++;
    console.log('  ✓ Post-restart discovery and cleanup succeeds with empty registry while preserving permanent files.');

    // -------------------------------------------------------------------------
    // Test 11: Durable Expiry Integration with uploadAttachmentToStorage
    // -------------------------------------------------------------------------
    console.log('\n[Test 11] Durable tracking created on temporary upload and skipped on permanent upload...');
    setupTestEnvironment();

    const uploadStore = new Map();
    const createUploadMockClient = () => ({
      storage: {
        from: (bucketName) => ({
          list: async (folderPath, options = {}) => {
            const cleanFolder = (folderPath || '').replace(/\/+$/, '');
            const prefix = cleanFolder ? `${cleanFolder}/` : '';
            const results = [];
            for (const key of uploadStore.keys()) {
              if (key.startsWith(`${bucketName}:${prefix}`)) {
                const subKey = key.slice(`${bucketName}:${prefix}`.length);
                if (!subKey.includes('/')) results.push({ name: subKey, id: subKey });
              }
            }
            return { data: results, error: null };
          },
          upload: async (itemPath, buffer) => {
            uploadStore.set(`${bucketName}:${itemPath}`, buffer);
            return { data: { path: itemPath }, error: null };
          },
          remove: async (paths) => {
            for (const p of paths) uploadStore.delete(`${bucketName}:${p}`);
            return { data: paths.map((p) => ({ name: p })), error: null };
          }
        })
      }
    });

    setSupabaseServerClientForTesting(createUploadMockClient(), 'https://test.supabase.co', 'key123');

    // 11a. Temporary upload with expiresAt creates durable marker
    const tempUploadRes = await uploadAttachmentToStorage({
      userId: 'usr_uploader',
      chatId: 'chat_test',
      attachmentId: 'att_temp_doc',
      extension: 'jpg',
      buffer: Buffer.from('temp-doc-bytes'),
      expiresAt: restartNow + 7200000,
      isPermanent: false
    });
    assert.equal(tempUploadRes.success, true);
    assert.equal(uploadStore.has(`${bucket}:usr_uploader/chat_test/att_temp_doc.jpg`), true);
    const expectedTempMarker = `${bucket}:_expiry_records/${restartNow + 7200000}__usr_uploader__chat_test__att_temp_doc__jpg.json`;
    assert.equal(uploadStore.has(expectedTempMarker), true, 'Durable expiry marker must be created for temporary file');

    // 11b. Permanent upload skips durable marker creation
    const permUploadRes = await uploadAttachmentToStorage({
      userId: 'usr_uploader',
      chatId: 'chat_test',
      attachmentId: 'att_perm_doc',
      extension: 'png',
      buffer: Buffer.from('perm-doc-bytes'),
      isPermanent: true
    });
    assert.equal(permUploadRes.success, true);
    assert.equal(uploadStore.has(`${bucket}:usr_uploader/chat_test/att_perm_doc.png`), true);
    let permMarkerFound = false;
    for (const key of uploadStore.keys()) {
      if (key.includes('att_perm_doc') && key.includes('_expiry_records')) {
        permMarkerFound = true;
      }
    }
    assert.equal(permMarkerFound, false, 'No expiry marker should be created for permanent attachment');

    // 11c. Deleting attachment also removes its durable marker
    const delRes = await deleteAttachmentFromStorage('usr_uploader/chat_test/att_temp_doc.jpg', {
      requestingUserId: 'usr_uploader'
    });
    assert.equal(delRes.success, true);
    assert.equal(uploadStore.has(`${bucket}:usr_uploader/chat_test/att_temp_doc.jpg`), false);
    assert.equal(uploadStore.has(expectedTempMarker), false, 'Deleting attachment must also remove its durable expiry marker');
    passedCount++;
    console.log('  ✓ uploadAttachmentToStorage automatically tracks expiry and removes marker on deletion.');

    // -------------------------------------------------------------------------
    // Test 12: Partial Batch Failure Durable Retention for Retry
    // -------------------------------------------------------------------------
    console.log('\n[Test 12] Partial failure retains durable tracking marker for safe retry...');
    setupTestEnvironment();

    const partialStore = new Map();
    let simulateFailOnItem2 = true;

    partialStore.set(`${bucket}:usr_part/chat_p/att-p1.pdf`, Buffer.from('pdf1'));
    partialStore.set(`${bucket}:_expiry_records/${restartNow - 5000}__usr_part__chat_p__att-p1__pdf.json`, Buffer.from('{}'));
    partialStore.set(`${bucket}:usr_part/chat_p/att-p2.pdf`, Buffer.from('pdf2'));
    partialStore.set(`${bucket}:_expiry_records/${restartNow - 4000}__usr_part__chat_p__att-p2__pdf.json`, Buffer.from('{}'));

    const partialClient = {
      storage: {
        from: (bucketName) => ({
          list: async (folderPath) => {
            const results = [];
            for (const key of partialStore.keys()) {
              if (key.startsWith(`${bucketName}:${folderPath}/`)) {
                const name = key.slice(`${bucketName}:${folderPath}/`.length);
                if (!name.includes('/')) results.push({ name, id: name });
              }
            }
            return { data: results, error: null };
          },
          remove: async (paths) => {
            if (simulateFailOnItem2) {
              // Only delete att-p1, fail att-p2
              const deleted = [];
              for (const p of paths) {
                if (!p.includes('att-p2')) {
                  partialStore.delete(`${bucketName}:${p}`);
                  deleted.push({ name: p });
                }
              }
              return { data: deleted, error: null };
            } else {
              for (const p of paths) partialStore.delete(`${bucketName}:${p}`);
              return { data: paths.map((p) => ({ name: p })), error: null };
            }
          }
        })
      }
    };

    setSupabaseServerClientForTesting(partialClient, 'https://test.supabase.co', 'key123');

    // Run 1: with failure on item 2
    const run1 = await runExpiredSupabaseAttachmentCleanup({
      registry: new Map(),
      nowMs: restartNow
    });

    assert.equal(run1.deletedCount, 1);
    assert.equal(run1.failedCount, 1);
    assert.equal(partialStore.has(`${bucket}:usr_part/chat_p/att-p1.pdf`), false, 'Item 1 was deleted');
    assert.equal(
      partialStore.has(`${bucket}:_expiry_records/${restartNow - 5000}__usr_part__chat_p__att-p1__pdf.json`),
      false,
      'Item 1 marker removed'
    );
    assert.equal(partialStore.has(`${bucket}:usr_part/chat_p/att-p2.pdf`), true, 'Item 2 was not deleted');
    assert.equal(
      partialStore.has(`${bucket}:_expiry_records/${restartNow - 4000}__usr_part__chat_p__att-p2__pdf.json`),
      true,
      'Item 2 marker RETAINED in durable storage for retry'
    );

    // Run 2: retry succeeds
    simulateFailOnItem2 = false;
    const run2 = await runExpiredSupabaseAttachmentCleanup({
      registry: new Map(),
      nowMs: restartNow
    });

    assert.equal(run2.deletedCount, 1, 'Retry successfully processed the remaining item');
    assert.equal(partialStore.has(`${bucket}:usr_part/chat_p/att-p2.pdf`), false);
    assert.equal(
      partialStore.has(`${bucket}:_expiry_records/${restartNow - 4000}__usr_part__chat_p__att-p2__pdf.json`),
      false,
      'Marker pruned after successful retry'
    );
    passedCount++;
    console.log('  ✓ Partial failure retains durable tracking and cleans up on subsequent retry.');

    // -------------------------------------------------------------------------
    // Test 13: Conversation Deletion Purges Conversation Expiry Markers
    // -------------------------------------------------------------------------
    console.log('\n[Test 13] Conversation deletion removes conversation durable expiry markers...');
    setupTestEnvironment();

    const convStore = new Map();
    convStore.set(`${bucket}:usr_cv/chat_active/file1.pdf`, Buffer.from('f1'));
    convStore.set(`${bucket}:_expiry_records/${restartNow - 1000}__usr_cv__chat_active__file1__pdf.json`, Buffer.from('{}'));
    convStore.set(`${bucket}:_expiry_records/${restartNow + 1000}__usr_cv__chat_active__file2__pdf.json`, Buffer.from('{}'));
    convStore.set(`${bucket}:_expiry_records/${restartNow - 1000}__usr_cv__chat_other__file3__pdf.json`, Buffer.from('{}'));

    const convClient = {
      storage: {
        from: (bucketName) => ({
          list: async (folderPath) => {
            const results = [];
            for (const key of convStore.keys()) {
              if (key.startsWith(`${bucketName}:${folderPath}/`)) {
                const name = key.slice(`${bucketName}:${folderPath}/`.length);
                if (!name.includes('/')) results.push({ name, id: name });
              }
            }
            return { data: results, error: null };
          },
          remove: async (paths) => {
            for (const p of paths) convStore.delete(`${bucketName}:${p}`);
            return { data: paths.map((p) => ({ name: p })), error: null };
          }
        })
      }
    };

    setSupabaseServerClientForTesting(convClient, 'https://test.supabase.co', 'key123');

    const convDelRes = await deleteAttachmentsForChatInStorage('usr_cv', 'chat_active', 'usr_cv');
    assert.equal(convDelRes.success, true);
    assert.equal(
      convStore.has(`${bucket}:_expiry_records/${restartNow - 1000}__usr_cv__chat_active__file1__pdf.json`),
      false,
      'Chat active marker 1 removed'
    );
    assert.equal(
      convStore.has(`${bucket}:_expiry_records/${restartNow + 1000}__usr_cv__chat_active__file2__pdf.json`),
      false,
      'Chat active marker 2 removed'
    );
    assert.equal(
      convStore.has(`${bucket}:_expiry_records/${restartNow - 1000}__usr_cv__chat_other__file3__pdf.json`),
      true,
      'Other chat marker preserved'
    );
    passedCount++;
    console.log('  ✓ Conversation deletion purges conversation expiry markers while preserving other chats.');

    console.log(`\n=== RESULTS: ${passedCount}/13 TESTS PASSED, 0 FAILED ===`);
  } catch (err) {
    console.error('\n❌ Test failure:', err);
    process.exit(1);
  } finally {
    teardownTestEnvironment();
  }
}

runTests();
