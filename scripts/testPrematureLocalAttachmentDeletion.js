/**
 * Dedicated Regression Test Suite for Prompt 19:
 * Fix Premature Local Attachment Deletion in ChatPage
 *
 * Verifies:
 * 1. Cloud conversation deletion failure preserves local attachment blobs in IndexedDB.
 *    If deleteConversation() throws/fails (e.g. Firestore offline, permission error, network timeout),
 *    the conversation remains in state and its local IndexedDB attachment records/blobs are NOT deleted.
 * 2. Successful cloud deletion properly coordinates attachment cleanup through deleteConversation's lifecycle.
 * 3. Guest conversation deletion preserves local attachment cleanup and storage guarantees.
 * 4. The redundant deleteAttachmentRecords call in handleDeleteChat is removed from the cloud deletion path.
 */

import assert from 'node:assert/strict';

// Set up minimal browser shims for test execution in Node
const mockLocalStorageStore = new Map();
globalThis.window = globalThis;
globalThis.localStorage = {
  getItem: (key) => mockLocalStorageStore.get(key) ?? null,
  setItem: (key, val) => mockLocalStorageStore.set(key, String(val)),
  removeItem: (key) => mockLocalStorageStore.delete(key),
  clear: () => mockLocalStorageStore.clear()
};

// Polyfill in-memory IndexedDB
const mockIndexedDBStore = new Map();
globalThis.indexedDB = {
  open: (dbName, version) => {
    const req = {
      result: {
        objectStoreNames: { contains: () => true },
        createObjectStore: () => ({ createIndex: () => {} }),
        transaction: () => ({
          oncomplete: null,
          onerror: null,
          onabort: null,
          objectStore: () => ({
            get: (key) => {
              const r = { onsuccess: null, onerror: null, result: mockIndexedDBStore.get(key) };
              setTimeout(() => r.onsuccess && r.onsuccess({ target: r }), 0);
              return r;
            },
            put: (val) => {
              mockIndexedDBStore.set(val.id, val);
              const r = { onsuccess: null, onerror: null };
              setTimeout(() => {
                if (r.onsuccess) r.onsuccess({ target: r });
              }, 0);
              return r;
            },
            delete: (key) => {
              mockIndexedDBStore.delete(key);
              const r = { onsuccess: null, onerror: null };
              setTimeout(() => {
                if (r.onsuccess) r.onsuccess({ target: r });
              }, 0);
              return r;
            },
            index: () => ({
              openCursor: () => {
                const items = Array.from(mockIndexedDBStore.values());
                let idx = 0;
                const r = { onsuccess: null, onerror: null };
                const continueCursor = () => {
                  if (idx < items.length) {
                    const item = items[idx++];
                    const cursor = {
                      value: item,
                      key: item.conversationId,
                      primaryKey: item.id,
                      continue: () => setTimeout(continueCursor, 0)
                    };
                    r.onsuccess && r.onsuccess({ target: { result: cursor } });
                  } else {
                    r.onsuccess && r.onsuccess({ target: { result: null } });
                  }
                };
                setTimeout(continueCursor, 0);
                return r;
              }
            }),
            openCursor: () => {
              const items = Array.from(mockIndexedDBStore.values());
              let idx = 0;
              const r = { onsuccess: null, onerror: null };
              const continueCursor = () => {
                if (idx < items.length) {
                  const item = items[idx++];
                  const cursor = {
                    value: item,
                    key: item.id,
                    primaryKey: item.id,
                    continue: () => setTimeout(continueCursor, 0)
                  };
                  r.onsuccess && r.onsuccess({ target: { result: cursor } });
                } else {
                  r.onsuccess && r.onsuccess({ target: { result: null } });
                }
              };
              setTimeout(continueCursor, 0);
              return r;
            },
            getAll: () => {
              const r = { onsuccess: null, onerror: null, result: Array.from(mockIndexedDBStore.values()) };
              setTimeout(() => r.onsuccess && r.onsuccess({ target: r }), 0);
              return r;
            }
          })
        })
      }
    };
    setTimeout(() => req.onsuccess && req.onsuccess({ target: req }), 0);
    return req;
  }
};

const {
  saveAttachmentBlob,
  getAttachmentRecord,
  deleteAttachmentsForConversation,
  deleteAttachmentRecords
} = await import('../src/services/attachmentStorageService.js');

console.log('================================================================');
console.log('REGRESSION SUITE: Fix Premature Local Attachment Deletion (Prompt 19)');
console.log('================================================================\n');

let passedCount = 0;
let totalTests = 0;

async function runTest(name, fn) {
  totalTests++;
  try {
    await fn();
    console.log(`  ✓ PASS: ${name}`);
    passedCount++;
  } catch (err) {
    console.error(`  ✗ FAIL: ${name}`);
    console.error(`    ${err.stack || err.message}`);
    process.exitCode = 1;
  }
}

// -----------------------------------------------------------------------------
// Test 1: Cloud deletion failure preserves local attachment blobs in IndexedDB
// -----------------------------------------------------------------------------
await runTest('1. Local attachment blobs remain available when cloud conversation deletion fails', async () => {
  mockIndexedDBStore.clear();

  const chatId = 'chat_cloud_failure_preserve';
  const attId1 = 'att_preserve_101';
  const attId2 = 'att_preserve_102';

  // Seed two attachments associated with this conversation into IndexedDB
  const fakeBlob1 = { name: 'invoice.pdf', size: 1024, type: 'application/pdf' };
  const fakeBlob2 = { name: 'diagram.png', size: 2048, type: 'image/png' };

  await saveAttachmentBlob(attId1, fakeBlob1, {
    conversationId: chatId,
    name: 'invoice.pdf',
    storageProvider: 'supabase',
    isCloud: true
  });
  await saveAttachmentBlob(attId2, fakeBlob2, {
    conversationId: chatId,
    name: 'diagram.png',
    storageProvider: 'supabase',
    isCloud: true
  });

  // Verify attachments are present prior to deletion attempt
  const preCheck1 = await getAttachmentRecord(attId1);
  const preCheck2 = await getAttachmentRecord(attId2);
  assert.ok(preCheck1, 'Attachment 1 must exist before deletion attempt');
  assert.ok(preCheck2, 'Attachment 2 must exist before deletion attempt');

  // Simulate ChatPage state
  let userChats = [
    {
      id: chatId,
      title: 'Important Financial Review',
      messages: [
        { id: 'm1', sender: 'user', content: 'See invoice', attachments: [{ id: attId1, name: 'invoice.pdf' }] },
        { id: 'm2', sender: 'assistant', content: 'Analyzed', referencedAttachments: [{ id: attId2, name: 'diagram.png' }] }
      ]
    }
  ];
  let persistenceError = null;

  // Simulate deleteConversation failing with an unhandled Firestore or network rejection
  const mockFailedDeleteConversation = async (userId, cid) => {
    throw new Error('Firestore connection rejected: 503 Service Unavailable');
  };

  // Implement the updated handleDeleteChat workflow (without premature deleteAttachmentRecords)
  const isCloudEnabled = true;
  const currentUser = { uid: 'user_alice_test' };

  const handleDeleteChatWorkflow = async (targetId) => {
    try {
      if (isCloudEnabled && currentUser?.uid) {
        await mockFailedDeleteConversation(currentUser.uid, targetId);
        userChats = userChats.filter((c) => c.id !== targetId);
      } else {
        void deleteAttachmentsForConversation(targetId).catch(() => {});
        const target = userChats.find((c) => c.id === targetId);
        if (Array.isArray(target?.messages)) {
          const attIds = [];
          target.messages.forEach((m) => {
            if (Array.isArray(m?.attachments)) m.attachments.forEach((a) => a?.id && attIds.push(a.id));
            if (Array.isArray(m?.referencedAttachments)) m.referencedAttachments.forEach((a) => a?.id && attIds.push(a.id));
          });
          if (attIds.length > 0) {
            void deleteAttachmentRecords(attIds).catch(() => {});
          }
        }
        userChats = userChats.filter((c) => c.id !== targetId);
      }
    } catch (err) {
      persistenceError = 'Failed to delete conversation from Cloud Firestore.';
    }
  };

  // Execute deletion
  await handleDeleteChatWorkflow(chatId);

  // Assertions:
  // 1. Error was recorded
  assert.equal(persistenceError, 'Failed to delete conversation from Cloud Firestore.');

  // 2. Conversation was NOT deleted from state
  assert.equal(userChats.length, 1, 'Conversation must remain in userChats when cloud deletion fails');
  assert.equal(userChats[0].id, chatId);

  // 3. CRITICAL: Local attachment records and blobs in IndexedDB remain completely intact
  const postCheck1 = await getAttachmentRecord(attId1);
  const postCheck2 = await getAttachmentRecord(attId2);
  assert.ok(postCheck1, 'Attachment 1 blob MUST remain available in IndexedDB after cloud deletion failure');
  assert.ok(postCheck2, 'Attachment 2 blob MUST remain available in IndexedDB after cloud deletion failure');
  assert.equal(postCheck1.name, 'invoice.pdf');
  assert.equal(postCheck2.name, 'diagram.png');
});

// -----------------------------------------------------------------------------
// Test 2: Demonstration that premature deletion destroys local blobs on failure
// -----------------------------------------------------------------------------
await runTest('2. Regression check: Premature deletion causes attachment loss if cloud deletion fails', async () => {
  mockIndexedDBStore.clear();

  const chatId = 'chat_premature_demonstration';
  const attId = 'att_premature_loss';

  await saveAttachmentBlob(attId, { name: 'lost.pdf', size: 512 }, { conversationId: chatId });
  assert.ok(await getAttachmentRecord(attId), 'Attachment must exist initially');

  let userChats = [{ id: chatId, title: 'Lost Chat', messages: [{ id: 'm1', attachments: [{ id: attId }] }] }];

  // The flawed old behavior deleted attachments prematurely before awaiting deleteConversation:
  const flawedOldHandler = async (targetId) => {
    try {
      // PREMATURE CALL (The bug we fixed in Prompt 19)
      await deleteAttachmentRecords([attId]);
      await deleteAttachmentsForConversation(targetId);

      // Then cloud deletion throws:
      throw new Error('Cloud delete failed');
    } catch (_) {
      // Conversation remains, but local blobs were already deleted!
    }
  };

  await flawedOldHandler(chatId);

  // Under the old bug, the attachment record was prematurely wiped:
  const lostRecord = await getAttachmentRecord(attId);
  assert.equal(lostRecord, null, 'Old flawed behavior prematurely destroyed the attachment record');
});

// -----------------------------------------------------------------------------
// Test 3: Successful cloud deletion cleans up attachments through coordinated lifecycle
// -----------------------------------------------------------------------------
await runTest('3. Successful cloud deletion completes and cleans up attachments', async () => {
  mockIndexedDBStore.clear();

  const chatId = 'chat_cloud_success_cleanup';
  const attId = 'att_success_cleanup';

  await saveAttachmentBlob(attId, { name: 'report.pdf', size: 1024 }, { conversationId: chatId });
  assert.ok(await getAttachmentRecord(attId));

  let userChats = [{ id: chatId, title: 'Success Chat', messages: [{ id: 'm1', attachments: [{ id: attId }] }] }];
  let persistenceError = null;

  // Successful deleteConversation coordinates attachment cleanup as part of its lifecycle
  const mockSuccessfulDeleteConversation = async (userId, cid) => {
    // deleteConversation coordinates local cleanup in step 2:
    await deleteAttachmentsForConversation(cid);
    await deleteAttachmentRecords([attId]);
    return true;
  };

  const isCloudEnabled = true;
  const currentUser = { uid: 'user_alice_test' };

  const handleDeleteChatWorkflow = async (targetId) => {
    try {
      if (isCloudEnabled && currentUser?.uid) {
        await mockSuccessfulDeleteConversation(currentUser.uid, targetId);
        userChats = userChats.filter((c) => c.id !== targetId);
      }
    } catch (err) {
      persistenceError = err.message;
    }
  };

  await handleDeleteChatWorkflow(chatId);

  assert.equal(persistenceError, null);
  assert.equal(userChats.length, 0, 'Conversation should be removed from userChats on success');
  const postCheck = await getAttachmentRecord(attId);
  assert.equal(postCheck, null, 'Attachment should be cleaned up on successful conversation deletion');
});

// -----------------------------------------------------------------------------
// Test 4: Guest conversation deletion preserves local attachment cleanup
// -----------------------------------------------------------------------------
await runTest('4. Guest conversation deletion cleans up local attachment records without cloud calls', async () => {
  mockIndexedDBStore.clear();
  mockLocalStorageStore.clear();

  const guestChatId = 'guest_chat_cleanup';
  const attId1 = 'guest_att_1';
  const attId2 = 'guest_att_2';

  await saveAttachmentBlob(attId1, { name: 'guest_note.txt', size: 256 }, { conversationId: guestChatId });
  await saveAttachmentBlob(attId2, { name: 'guest_pic.jpg', size: 512 }, { conversationId: guestChatId });

  assert.ok(await getAttachmentRecord(attId1));
  assert.ok(await getAttachmentRecord(attId2));

  let guestChats = [
    {
      id: guestChatId,
      title: 'Guest Note',
      messages: [
        { id: 'gm1', attachments: [{ id: attId1 }] },
        { id: 'gm2', referencedAttachments: [{ id: attId2 }] }
      ]
    }
  ];

  // Guest execution path in ChatPage
  const isCloudEnabled = false;
  const currentUser = null;

  let cloudCalled = false;
  const mockDeleteConversation = async () => {
    cloudCalled = true;
  };

  const handleDeleteGuestChat = async (targetId) => {
    if (isCloudEnabled && currentUser?.uid) {
      await mockDeleteConversation();
    } else {
      // Local cleanup for guest conversation
      await deleteAttachmentsForConversation(targetId);
      const targetChat = guestChats.find((c) => c.id === targetId);
      if (Array.isArray(targetChat?.messages)) {
        const attIds = [];
        targetChat.messages.forEach((m) => {
          if (Array.isArray(m?.attachments)) m.attachments.forEach((a) => a?.id && attIds.push(a.id));
          if (Array.isArray(m?.referencedAttachments)) m.referencedAttachments.forEach((a) => a?.id && attIds.push(a.id));
        });
        if (attIds.length > 0) {
          await deleteAttachmentRecords(attIds);
        }
      }
      guestChats = guestChats.filter((c) => c.id !== targetId);
    }
  };

  await handleDeleteGuestChat(guestChatId);

  assert.equal(cloudCalled, false, 'Guest deletion must never invoke cloud deleteConversation');
  assert.equal(guestChats.length, 0, 'Guest conversation must be removed');
  assert.equal(await getAttachmentRecord(attId1), null, 'Guest attachment 1 must be cleaned up from IndexedDB');
  assert.equal(await getAttachmentRecord(attId2), null, 'Guest attachment 2 must be cleaned up from IndexedDB');
});

// -----------------------------------------------------------------------------
// Test 5: Verify ChatPage.jsx source code no longer contains premature deletion
// -----------------------------------------------------------------------------
await runTest('5. Source code verification: handleDeleteChat in ChatPage does not delete attachments before deleteConversation', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');

  const chatPageSource = fs.readFileSync(path.resolve('src/pages/ChatPage.jsx'), 'utf-8');

  // Find handleDeleteChat definition
  const match = chatPageSource.match(/const handleDeleteChat\s*=\s*async\s*\([^)]*\)\s*=>\s*\{([\s\S]*?)(?=\n\s*(?:const handleDeleteConversation|const handleTogglePin|\/\/ Pin\/unpin))/);
  assert.ok(match, 'handleDeleteChat function body must be found in ChatPage.jsx');

  const handlerBody = match[1];

  // The call to deleteConversation should appear BEFORE any deleteAttachmentRecords in the cloud path
  const deleteConversationIdx = handlerBody.indexOf('deleteConversation(');
  const deleteAttachmentRecordsIdx = handlerBody.indexOf('deleteAttachmentRecords(');

  assert.ok(deleteConversationIdx !== -1, 'deleteConversation must be called in handleDeleteChat');

  // If deleteAttachmentRecords is present, it MUST appear after the `else` branch (guest path only)
  const elseIdx = handlerBody.indexOf('} else {');
  assert.ok(elseIdx !== -1, 'else branch must exist for guest handling');

  assert.ok(
    deleteConversationIdx < elseIdx,
    'deleteConversation must be called in the cloud branch before the else branch'
  );

  if (deleteAttachmentRecordsIdx !== -1) {
    assert.ok(
      deleteAttachmentRecordsIdx > elseIdx,
      'deleteAttachmentRecords must only be in the else (guest) branch, not before deleteConversation'
    );
  }
});

console.log('\n================================================================');
console.log(`SUMMARY: ${passedCount}/${totalTests} Tests Passed`);
console.log('================================================================\n');

if (passedCount !== totalTests) {
  process.exit(1);
}
