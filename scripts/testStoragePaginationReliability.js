/**
 * Regression Test Suite: Complete Phase 5 Pagination Reliability
 *
 * Verifies:
 * 1. findAttachmentPathInStorage() retrieves files located beyond the legacy 50-page ceiling (>50 pages).
 * 2. findAttachmentPathInStorage() safely returns 404 when listing ends without matching.
 * 3. findAttachmentPathInStorage() returns explicit PAGINATION_LIMIT_EXCEEDED error when safety limit is reached.
 * 4. deleteAttachmentsForChatInStorage() deletes conversations spanning >100 pages without stopping early.
 * 5. deleteAttachmentsForChatInStorage() maintains offset: 0 reset behavior as mutable listing shrinks.
 * 6. deleteAttachmentsForChatInStorage() never reports success if matching files remain (INCOMPLETE_DELETION).
 * 7. deleteAttachmentsForChatInStorage() halts cleanly with DELETE_STALLED when progress cannot be made.
 * 8. deleteAttachmentsForChatInStorage() returns explicit MAX_PAGES_EXCEEDED error if maxPages cap is reached.
 * 9. Authentication, path segment validation, and cross-user boundaries are strictly enforced.
 */

import assert from 'node:assert/strict';
import {
  findAttachmentPathInStorage,
  deleteAttachmentsForChatInStorage,
  isValidPathSegment
} from '../server/supabaseStorageService.ts';
import {
  setSupabaseServerClientForTesting,
  resetSupabaseClientForTesting
} from '../server/supabaseClient.ts';

console.log('================================================================');
console.log('REGRESSION SUITE: Phase 5 Storage Pagination Reliability');
console.log('================================================================\n');

const userAlice = 'user_alice_paginated';
const userBob = 'user_bob_paginated';
const testChatId = 'chat_deep_pagination';

let passedCount = 0;
let totalCount = 0;

async function runTest(name, fn) {
  totalCount++;
  try {
    await fn();
    console.log(`  ✓ PASS: ${name}`);
    passedCount++;
  } catch (err) {
    console.error(`  ✗ FAIL: ${name}`);
    console.error(`    ${err?.stack || err?.message || err}`);
    process.exitCode = 1;
  }
}

// In-memory mock storage backend
const mockStorageStore = new Map();
let listHook = null;
let removeHook = null;

const mockClient = {
  storage: {
    from: (bucket) => ({
      list: async (folderPath, options = {}) => {
        if (typeof listHook === 'function') {
          const hooked = listHook(folderPath, options);
          if (hooked !== undefined) return hooked;
        }

        const prefix = folderPath.endsWith('/') ? folderPath : `${folderPath}/`;
        const matching = [];

        for (const [key, val] of mockStorageStore.entries()) {
          if (key.startsWith(prefix)) {
            const rel = key.slice(prefix.length);
            // Folder contents at current level
            if (!rel.includes('/')) {
              matching.push({
                name: val.name || rel,
                id: val.id || rel,
                metadata: val.metadata || { size: val.buffer?.length || 100 }
              });
            }
          }
        }

        const offset = options.offset || 0;
        const limit = options.limit || 1000;
        const paged = matching.slice(offset, offset + limit);

        return { data: paged, error: null };
      },

      remove: async (paths = []) => {
        if (typeof removeHook === 'function') {
          const hooked = removeHook(paths);
          if (hooked !== undefined) return hooked;
        }

        const removed = [];
        for (const p of paths) {
          if (mockStorageStore.has(p)) {
            mockStorageStore.delete(p);
            removed.push({ name: p });
          }
        }
        return { data: removed, error: null };
      }
    })
  }
};

setSupabaseServerClientForTesting(mockClient, 'https://test-pagination.supabase.co', 'test-key-paged');

// ============================================================================
// PART 1: Retrieval Beyond 50-Page Ceiling
// ============================================================================

await runTest('1. findAttachmentPathInStorage retrieves attachment located on Page 55 (>50 pages)', async () => {
  mockStorageStore.clear();
  const deepChatId = 'chat_page_55';
  const targetId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

  // Seed 54 pages of 10 items (540 items), target is placed on Page 55 (item 545)
  const pageSize = 10;
  const totalItemsBeforeTarget = 540;

  for (let i = 0; i < totalItemsBeforeTarget; i++) {
    const fakeId = `filler_${String(i).padStart(4, '0')}`;
    const p = `${userAlice}/${deepChatId}/${fakeId}.txt`;
    mockStorageStore.set(p, { name: `${fakeId}.txt` });
  }

  // Put target item on Page 55
  const targetPath = `${userAlice}/${deepChatId}/${targetId}.pdf`;
  mockStorageStore.set(targetPath, { name: `${targetId}.pdf` });

  // Add 20 more items on Page 55 and beyond
  for (let i = totalItemsBeforeTarget + 1; i < totalItemsBeforeTarget + 30; i++) {
    const fakeId = `filler_${String(i).padStart(4, '0')}`;
    const p = `${userAlice}/${deepChatId}/${fakeId}.txt`;
    mockStorageStore.set(p, { name: `${fakeId}.txt` });
  }

  const result = await findAttachmentPathInStorage(userAlice, deepChatId, targetId, { pageSize });
  assert.equal(result.found, true, 'Must locate target file past 50 pages');
  assert.equal(result.path, targetPath);
  assert.equal(result.filename, `${targetId}.pdf`);
  assert.equal(result.status, 200);
});

await runTest('2. findAttachmentPathInStorage safely returns 404 when file is absent across >50 pages', async () => {
  mockStorageStore.clear();
  const deepChatId = 'chat_absent_60_pages';
  const nonExistentId = '00000000-0000-0000-0000-000000000000';
  const pageSize = 10;

  // Seed 60 pages of items (600 items)
  for (let i = 0; i < 600; i++) {
    const fakeId = `filler_${String(i).padStart(4, '0')}`;
    mockStorageStore.set(`${userAlice}/${deepChatId}/${fakeId}.txt`, { name: `${fakeId}.txt` });
  }

  const result = await findAttachmentPathInStorage(userAlice, deepChatId, nonExistentId, { pageSize });
  assert.equal(result.found, false);
  assert.equal(result.status, 404);
});

await runTest('3. findAttachmentPathInStorage returns explicit PAGINATION_LIMIT_EXCEEDED when safety cap is reached', async () => {
  mockStorageStore.clear();
  const deepChatId = 'chat_cap_exceeded';
  const targetId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
  const pageSize = 10;

  // Seed 30 pages
  for (let i = 0; i < 300; i++) {
    const fakeId = `filler_${String(i).padStart(4, '0')}`;
    mockStorageStore.set(`${userAlice}/${deepChatId}/${fakeId}.txt`, { name: `${fakeId}.txt` });
  }

  // Put target on Page 25
  mockStorageStore.set(`${userAlice}/${deepChatId}/${targetId}.pdf`, { name: `${targetId}.pdf` });

  // Limit search to 10 pages
  const result = await findAttachmentPathInStorage(userAlice, deepChatId, targetId, { pageSize, maxPages: 10 });
  assert.equal(result.found, false);
  assert.equal(result.code, 'PAGINATION_LIMIT_EXCEEDED');
  assert.equal(result.status, 500);
  assert.ok(result.error.includes('Exceeded maximum pagination limit'));
});

// ============================================================================
// PART 2: Deletion Beyond 100-Page Ceiling
// ============================================================================

await runTest('4. deleteAttachmentsForChatInStorage deletes conversations spanning 125 pages (>100 pages)', async () => {
  mockStorageStore.clear();
  const massiveChatId = 'chat_125_pages';
  const pageSize = 10;
  const totalPages = 125;
  const totalFiles = totalPages * pageSize; // 1,250 files

  for (let i = 0; i < totalFiles; i++) {
    const fakeId = `att_${String(i).padStart(4, '0')}`;
    const p = `${userAlice}/${massiveChatId}/${fakeId}.txt`;
    mockStorageStore.set(p, { name: `${fakeId}.txt` });
  }

  assert.equal(mockStorageStore.size, totalFiles, 'Must seed all 1,250 files');

  let listCallCount = 0;
  let allQueriesUsedOffsetZero = true;

  listHook = (folderPath, options) => {
    listCallCount++;
    if (options.limit === pageSize && options.offset !== 0) {
      allQueriesUsedOffsetZero = false;
    }
    return undefined;
  };

  const result = await deleteAttachmentsForChatInStorage(userAlice, massiveChatId, userAlice, { pageSize });
  listHook = null;

  assert.equal(result.success, true, 'Deletion must succeed across >100 pages');
  assert.equal(result.deletedCount, totalFiles, 'All 1,250 files must be deleted');
  assert.equal(mockStorageStore.size, 0, 'Store must be completely empty');
  assert.ok(allQueriesUsedOffsetZero, 'All batch queries must query offset 0 because listing shrinks');
  // 125 batches + 1 final verification call = 126 list calls
  assert.ok(listCallCount >= 125, 'Must execute at least 125 list batches');
});

await runTest('5. deleteAttachmentsForChatInStorage never reports success if matching files remain (INCOMPLETE_DELETION)', async () => {
  mockStorageStore.clear();
  const stubChatId = 'chat_stubborn_file';
  const pageSize = 10;

  // Seed 15 files (2 pages)
  for (let i = 0; i < 15; i++) {
    const fakeId = `att_${String(i).padStart(2, '0')}`;
    mockStorageStore.set(`${userAlice}/${stubChatId}/${fakeId}.txt`, { name: `${fakeId}.txt` });
  }

  // Hook remove: refuses to delete att_14.txt
  removeHook = (paths) => {
    const removed = [];
    for (const p of paths) {
      if (!p.endsWith('att_14.txt')) {
        mockStorageStore.delete(p);
        removed.push({ name: p });
      }
    }
    return { data: removed, error: null };
  };

  const result = await deleteAttachmentsForChatInStorage(userAlice, stubChatId, userAlice, { pageSize });
  removeHook = null;

  assert.equal(result.success, false, 'Must NOT report success when file remains');
  assert.ok(result.code === 'PARTIAL_DELETE_FAILURE' || result.code === 'INCOMPLETE_DELETION' || result.code === 'DELETE_STALLED');
  assert.equal(result.status, 500);
  assert.ok(mockStorageStore.size > 0, 'Stubborn file remained');
});

await runTest('6. deleteAttachmentsForChatInStorage triggers DELETE_STALLED when deletion makes no progress', async () => {
  mockStorageStore.clear();
  const stallChatId = 'chat_stall_test';
  const pageSize = 10;

  for (let i = 0; i < 20; i++) {
    const fakeId = `att_${String(i).padStart(2, '0')}`;
    mockStorageStore.set(`${userAlice}/${stallChatId}/${fakeId}.txt`, { name: `${fakeId}.txt` });
  }

  // Hook remove: returns success but deletes nothing, causing stall
  removeHook = (paths) => {
    // Return empty removal or fail to delete from store
    return { data: paths.map((p) => ({ name: p })), error: null };
  };

  const result = await deleteAttachmentsForChatInStorage(userAlice, stallChatId, userAlice, { pageSize });
  removeHook = null;

  assert.equal(result.success, false);
  assert.equal(result.code, 'DELETE_STALLED');
  assert.equal(result.status, 500);
  assert.ok(result.error.includes('deletion stalled'));
});

await runTest('7. deleteAttachmentsForChatInStorage returns MAX_PAGES_EXCEEDED when maxPages cap is hit', async () => {
  mockStorageStore.clear();
  const largeChatId = 'chat_max_cap';
  const pageSize = 10;

  for (let i = 0; i < 50; i++) {
    const fakeId = `att_${String(i).padStart(2, '0')}`;
    mockStorageStore.set(`${userAlice}/${largeChatId}/${fakeId}.txt`, { name: `${fakeId}.txt` });
  }

  // Cap deletion at 2 pages
  const result = await deleteAttachmentsForChatInStorage(userAlice, largeChatId, userAlice, { pageSize, maxPages: 2 });
  assert.equal(result.success, false);
  assert.equal(result.code, 'MAX_PAGES_EXCEEDED');
  assert.equal(result.status, 500);
});

// ============================================================================
// PART 3: Security & Authorization Boundaries
// ============================================================================

await runTest('8. Cross-user access control is strictly enforced on deletion', async () => {
  const result = await deleteAttachmentsForChatInStorage(userAlice, 'any_chat', userBob);
  assert.equal(result.success, false);
  assert.equal(result.code, 'STORAGE_ACCESS_DENIED');
  assert.equal(result.status, 403);
});

await runTest('9. Invalid path segments (traversal, slashes) are rejected with 400', async () => {
  const resultDel1 = await deleteAttachmentsForChatInStorage('../user', 'chat_1', '../user');
  assert.equal(resultDel1.code, 'INVALID_PATH_SEGMENT');
  assert.equal(resultDel1.status, 400);

  const resultDel2 = await deleteAttachmentsForChatInStorage('user', 'chat/../../traversal', 'user');
  assert.equal(resultDel2.code, 'INVALID_PATH_SEGMENT');
  assert.equal(resultDel2.status, 400);

  const resultFind = await findAttachmentPathInStorage('user', 'chat', '../traversal.txt');
  assert.equal(resultFind.code, 'INVALID_PATH_SEGMENT');
  assert.equal(resultFind.status, 400);
});

await runTest('10. Safe handling when Supabase client is unconfigured', async () => {
  resetSupabaseClientForTesting();

  const findRes = await findAttachmentPathInStorage('user_1', 'chat_1', 'att_1');
  assert.equal(findRes.code, 'STORAGE_UNCONFIGURED');
  assert.equal(findRes.status, 503);

  const delRes = await deleteAttachmentsForChatInStorage('user_1', 'chat_1', 'user_1');
  assert.equal(delRes.code, 'STORAGE_UNCONFIGURED');
  assert.equal(delRes.status, 503);

  // Restore client
  setSupabaseServerClientForTesting(mockClient);
});

console.log('\n================================================================');
console.log(`PAGINATION RELIABILITY SUMMARY: ${passedCount} / ${totalCount} tests passed.`);
console.log('================================================================');

if (passedCount !== totalCount) {
  process.exit(1);
}
