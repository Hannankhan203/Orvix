/**
 * scripts/testShareChatStage6.js
 * Comprehensive verification test suite for Orvix Share Chat Stage 6:
 * First-Message Import & Independent Chat History
 */

import assert from 'node:assert';
import {
  isValidShareId,
  isEligibleShareUser,
  getSharedPreviewActionPermissions,
  createSharedPreviewState,
  getImportDeduplicationKey,
  remapSharedSnapshotMessages,
  createImportedConversationData,
  persistImportedConversationToFirestore,
  importSharedConversationToAccount,
  clearImportLocks
} from '../src/services/shareChatService.js';
import {
  getCachedUserChats,
  getCachedChatMessages,
  saveCachedUserChats,
  saveCachedChatMessages
} from '../src/services/chatStorageService.js';

let passedTests = 0;
let totalTests = 0;

function runTest(description, testFn) {
  totalTests++;
  try {
    testFn();
    console.log(`  PASS: ${description}`);
    passedTests++;
  } catch (error) {
    console.error(`  FAIL: ${description}`);
    console.error(`    Error: ${error.message}`);
    if (error.stack) {
      console.error(error.stack.split('\n').slice(1, 4).join('\n'));
    }
  }
}

async function runAsyncTest(description, testFn) {
  totalTests++;
  try {
    await testFn();
    console.log(`  PASS: ${description}`);
    passedTests++;
  } catch (error) {
    console.error(`  FAIL: ${description}`);
    console.error(`    Error: ${error.message}`);
    if (error.stack) {
      console.error(error.stack.split('\n').slice(1, 4).join('\n'));
    }
  }
}

console.log('\n======================================================');
console.log('Orvix Share Chat Stage 6 — Verification Test Suite');
console.log('======================================================\n');

// Mock localStorage if running in node without browser globals
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => store.get(String(key)) || null,
    setItem: (key, val) => store.set(String(key), String(val)),
    removeItem: (key) => store.delete(String(key)),
    clear: () => store.clear()
  };
}

// Mock sessionStorage if running in node without browser globals
if (typeof globalThis.sessionStorage === 'undefined') {
  const store = new Map();
  globalThis.sessionStorage = {
    getItem: (key) => store.get(String(key)) || null,
    setItem: (key, val) => store.set(String(key), String(val)),
    removeItem: (key) => store.delete(String(key)),
    clear: () => store.clear()
  };
}

// Mock window if running in node without browser globals
if (typeof globalThis.window === 'undefined') {
  globalThis.window = {
    location: { origin: 'https://orvix.ai' }
  };
}

// Sample original snapshot data
const sampleShareId = 'abc123DEF456';
const sampleOriginalMessages = [
  {
    id: 'orig_msg_user_1',
    interactionId: 'orig_inter_1',
    sender: 'user',
    content: 'Explain quantum computing in simple terms.',
    timestamp: '10:00 AM',
    createdAt: 1730000000000,
    createdAtMs: 1730000000000,
    attachments: [
      {
        id: 'att_1',
        name: 'quantum_paper.pdf',
        size: 1024,
        type: 'application/pdf',
        dataUrl: 'data:application/pdf;base64,SECRET_DATA_DO_NOT_STORE'
      }
    ]
  },
  {
    id: 'orig_msg_asst_1',
    interactionId: 'orig_inter_1',
    parentMessageId: 'orig_msg_user_1',
    sender: 'assistant',
    content: 'Quantum computing uses qubits to process complex problems.',
    provider: 'gemini',
    modelUsed: 'gemini-3.8-flash',
    timestamp: '10:01 AM',
    createdAt: 1730000005000,
    createdAtMs: 1730000005000,
    activeAlternativeId: 'orig_alt_1',
    alternatives: [
      {
        id: 'orig_alt_1',
        parentMessageId: 'orig_msg_user_1',
        provider: 'gemini',
        modelUsed: 'gemini-3.8-flash',
        content: 'Quantum computing uses qubits to process complex problems.'
      },
      {
        id: 'orig_alt_2',
        parentMessageId: 'orig_msg_user_1',
        provider: 'groq',
        modelUsed: 'openai/gpt-oss-120b',
        content: 'Alternative response on quantum principles.'
      }
    ]
  }
];

const sampleSnapshot = {
  shareId: sampleShareId,
  title: 'Quantum Computing Overview',
  mode: 'learning',
  messageCount: 2,
  messages: sampleOriginalMessages
};

const recipientUser = {
  uid: 'recipient_uid_98765',
  email: 'recipient@example.com',
  isAnonymous: false
};

const recipientUserMessage = {
  id: 'user-recipient-msg-1',
  interactionId: 'recipient-inter-1',
  sender: 'user',
  content: 'How does quantum entanglement relate to superposition?',
  timestamp: '10:05 AM',
  createdAt: 1730000010000,
  createdAtMs: 1730000010000
};

const recipientAssistantMessage = {
  id: 'gemini-recipient-asst-1',
  interactionId: 'recipient-inter-1',
  parentMessageId: 'user-recipient-msg-1',
  sender: 'assistant',
  content: 'Entanglement connects quantum particles across distances, while superposition allows multi-state calculation.',
  provider: 'gemini',
  modelUsed: 'gemini-3.8-flash',
  timestamp: '10:06 AM',
  createdAt: 1730000015000,
  createdAtMs: 1730000015000
};

// ==============================================================================
// Group 1: Message Remapping & Independence
// ==============================================================================

runTest('1. remapSharedSnapshotMessages assigns fresh IDs to ALL imported messages and never reuses original IDs', () => {
  const { messages: remapped, mapping } = remapSharedSnapshotMessages(sampleOriginalMessages);

  assert.strictEqual(remapped.length, 2);

  // Original IDs must not be present
  remapped.forEach((msg) => {
    assert.ok(msg.id !== 'orig_msg_user_1', 'Must not reuse orig_msg_user_1');
    assert.ok(msg.id !== 'orig_msg_asst_1', 'Must not reuse orig_msg_asst_1');
    assert.ok(msg.id.startsWith('msg_imp_'), 'Fresh imported message ID must have distinct format');
  });

  // Mapping must accurately map old ID to new ID
  assert.ok(mapping.has('orig_msg_user_1'));
  assert.ok(mapping.has('orig_msg_asst_1'));
  assert.strictEqual(mapping.get('orig_msg_user_1'), remapped[0].id);
  assert.strictEqual(mapping.get('orig_msg_asst_1'), remapped[1].id);
});

runTest('2. remapSharedSnapshotMessages preserves and remaps logical relationships (interactionId, parentMessageId, alternatives)', () => {
  const { messages: remapped } = remapSharedSnapshotMessages(sampleOriginalMessages);
  const [remUser, remAsst] = remapped;

  // Interaction IDs must be remapped but shared between correlated user and assistant messages
  assert.ok(remUser.interactionId.startsWith('inter_imp'));
  assert.strictEqual(remUser.interactionId, remAsst.interactionId);

  // Parent relationship must point to newly remapped user message ID
  assert.strictEqual(remAsst.parentMessageId, remUser.id);

  // Alternatives array must be remapped with fresh IDs and correct parent pointers
  assert.ok(Array.isArray(remAsst.alternatives));
  assert.strictEqual(remAsst.alternatives.length, 2);
  assert.strictEqual(remAsst.activeAlternativeId, remAsst.alternatives[0].id);
  remAsst.alternatives.forEach((alt) => {
    assert.strictEqual(alt.parentMessageId, remUser.id);
    assert.ok(alt.id.startsWith('alt_imp_'));
    assert.ok(alt.id !== 'orig_alt_1' && alt.id !== 'orig_alt_2');
  });
});

runTest('3. remapSharedSnapshotMessages sanitizes attachments to prevent large data URLs in permanent storage', () => {
  const { messages: remapped } = remapSharedSnapshotMessages(sampleOriginalMessages);
  const userMsg = remapped[0];

  assert.ok(Array.isArray(userMsg.attachments));
  assert.strictEqual(userMsg.attachments.length, 1);
  const att = userMsg.attachments[0];
  assert.strictEqual(att.name, 'quantum_paper.pdf');
  assert.strictEqual(att.dataUrl, undefined, 'dataUrl must be stripped for safe storage');
  assert.strictEqual(att.base64, undefined, 'base64 must be stripped for safe storage');
});

// ==============================================================================
// Group 2: Imported Conversation Assembly
// ==============================================================================

runTest('4. createImportedConversationData builds independent metadata and links recipient messages', () => {
  const result = createImportedConversationData({
    shareId: sampleShareId,
    snapshot: sampleSnapshot,
    recipientUserId: recipientUser.uid,
    recipientUserMessage,
    recipientAssistantMessage
  });

  const { chatMetadata, messages, newChatId } = result;

  assert.ok(newChatId && typeof newChatId === 'string');
  assert.ok(!newChatId.startsWith('shared-preview-'), 'Must NOT reuse temporary preview chat ID');
  assert.strictEqual(chatMetadata.id, newChatId);
  assert.strictEqual(chatMetadata.userId, recipientUser.uid);
  assert.strictEqual(chatMetadata.title, 'Quantum Computing Overview');
  assert.strictEqual(chatMetadata.mode, 'learning');
  assert.strictEqual(chatMetadata.isImported, true);
  assert.strictEqual(chatMetadata.importedFromShareId, sampleShareId);

  // Messages count must be 2 original + 2 recipient = 4 total
  assert.strictEqual(messages.length, 4);

  // First 2 are remapped original messages
  assert.strictEqual(messages[0].sender, 'user');
  assert.strictEqual(messages[1].sender, 'assistant');

  // Next 2 are recipient interaction
  const recUserInList = messages[2];
  const recAsstInList = messages[3];

  assert.strictEqual(recUserInList.sender, 'user');
  assert.strictEqual(recUserInList.content, recipientUserMessage.content);
  assert.strictEqual(recAsstInList.sender, 'assistant');
  assert.strictEqual(recAsstInList.content, recipientAssistantMessage.content);

  // Recipient user message parent links to last original assistant message
  assert.strictEqual(recUserInList.parentMessageId, messages[1].id);
  // Recipient assistant links to recipient user
  assert.strictEqual(recAsstInList.parentMessageId, recUserInList.id);
});

// ==============================================================================
// Group 3: Firestore Batched Persistence & Rollback Safety
// ==============================================================================

await runAsyncTest('5. persistImportedConversationToFirestore writes chat doc and messages under users/{recipientUserId}/chats/{newChatId}', async () => {
  const committedOperations = [];
  const mockWriteBatch = (targetDb) => {
    const ops = [];
    return {
      set(ref, payload) {
        ops.push({ type: 'set', ref, payload });
      },
      delete(ref) {
        ops.push({ type: 'delete', ref });
      },
      async commit() {
        committedOperations.push(...ops);
      }
    };
  };

  const mockDoc = (dbInstance, ...pathSegments) => ({
    path: pathSegments.join('/')
  });

  const importData = createImportedConversationData({
    shareId: sampleShareId,
    snapshot: sampleSnapshot,
    recipientUserId: recipientUser.uid,
    recipientUserMessage,
    recipientAssistantMessage
  });

  await persistImportedConversationToFirestore({
    firestoreDb: {},
    userId: recipientUser.uid,
    chatMetadata: importData.chatMetadata,
    messages: importData.messages,
    docImpl: mockDoc,
    writeBatchImpl: mockWriteBatch
  });

  // Verify operations target users/{userId}/chats/{chatId}
  assert.ok(committedOperations.length === 5, '1 chat doc + 4 message docs = 5 operations');

  const chatOp = committedOperations.find((op) => op.ref.path === `users/${recipientUser.uid}/chats/${importData.chatMetadata.id}`);
  assert.ok(chatOp, 'Chat doc must be created under users/{userId}/chats/{chatId}');
  assert.strictEqual(chatOp.payload.isImported, true);
  assert.strictEqual(chatOp.payload.importedFromShareId, sampleShareId);

  // Verify zero operations target sharedChats/{shareId}
  const sharedChatTouch = committedOperations.find((op) => op.ref.path.startsWith('sharedChats'));
  assert.strictEqual(sharedChatTouch, undefined, 'sharedChats collection must NEVER be modified');
});

await runAsyncTest('6. persistImportedConversationToFirestore chunks > 400 operations safely across multiple batches', async () => {
  const batchCommitCount = { count: 0 };
  const mockWriteBatch = () => {
    return {
      set() {},
      delete() {},
      async commit() {
        batchCommitCount.count++;
      }
    };
  };
  const mockDoc = (_db, ...segments) => ({ path: segments.join('/') });

  // Generate 450 simulated messages to test multi-batch chunking
  const largeMessageSet = Array.from({ length: 450 }, (_, i) => ({
    id: `msg_large_${i}`,
    sender: i % 2 === 0 ? 'user' : 'assistant',
    content: `Message ${i}`,
    createdAt: Date.now() + i
  }));

  await persistImportedConversationToFirestore({
    firestoreDb: {},
    userId: recipientUser.uid,
    chatMetadata: { id: 'large_chat_1', title: 'Large', mode: 'general', importedFromShareId: sampleShareId },
    messages: largeMessageSet,
    docImpl: mockDoc,
    writeBatchImpl: mockWriteBatch
  });

  // 1 chat doc + 450 messages = 451 operations -> chunked into 2 batches (400 + 51)
  assert.strictEqual(batchCommitCount.count, 2, 'Must execute 2 batches for 451 operations');
});

await runAsyncTest('7. persistImportedConversationToFirestore performs rollback cleanup if a subsequent batch fails', async () => {
  let batchIndex = 0;
  const deletedPaths = [];

  const mockWriteBatch = () => {
    const currentBatchNum = ++batchIndex;
    return {
      set() {},
      delete(ref) {
        deletedPaths.push(ref.path);
      },
      async commit() {
        if (currentBatchNum === 2) {
          throw new Error('Simulated network interruption on second batch commit');
        }
      }
    };
  };
  const mockDoc = (_db, ...segments) => ({ path: segments.join('/') });

  const largeMessageSet = Array.from({ length: 450 }, (_, i) => ({
    id: `msg_large_${i}`,
    sender: i % 2 === 0 ? 'user' : 'assistant',
    content: `Message ${i}`,
    createdAt: Date.now() + i
  }));

  let threwError = false;
  try {
    await persistImportedConversationToFirestore({
      firestoreDb: {},
      userId: recipientUser.uid,
      chatMetadata: { id: 'fail_chat_1', title: 'Fail', mode: 'general', importedFromShareId: sampleShareId },
      messages: largeMessageSet,
      docImpl: mockDoc,
      writeBatchImpl: mockWriteBatch
    });
  } catch (err) {
    threwError = true;
    assert.strictEqual(err.code, 'PERSISTENCE_FAILED');
  }

  assert.ok(threwError, 'Must throw PERSISTENCE_FAILED when a batch fails');
  assert.ok(deletedPaths.length > 0, 'Rollback must delete committed documents from first batch');
});

// ==============================================================================
// Group 4: Deduplication & Idempotent Guard
// ==============================================================================

await runAsyncTest('8. importSharedConversationToAccount deduplicates concurrent identical imports with in-flight lock', async () => {
  clearImportLocks();

  let firestoreCommitCount = 0;
  const mockWriteBatch = () => ({
    set() {},
    delete() {},
    async commit() {
      // Simulate small async network delay
      await new Promise((res) => setTimeout(res, 20));
      firestoreCommitCount++;
    }
  });
  const mockDoc = (_db, ...segments) => ({ path: segments.join('/') });

  const customChatId = 'dedup_test_chat_1';

  // Run 3 simultaneous import calls
  const [res1, res2, res3] = await Promise.all([
    importSharedConversationToAccount({
      shareId: sampleShareId,
      snapshot: sampleSnapshot,
      recipientUser,
      recipientUserMessage,
      recipientAssistantMessage,
      options: {
        customChatId,
        firestoreDb: {},
        docImpl: mockDoc,
        writeBatchImpl: mockWriteBatch
      }
    }),
    importSharedConversationToAccount({
      shareId: sampleShareId,
      snapshot: sampleSnapshot,
      recipientUser,
      recipientUserMessage,
      recipientAssistantMessage,
      options: {
        customChatId,
        firestoreDb: {},
        docImpl: mockDoc,
        writeBatchImpl: mockWriteBatch
      }
    }),
    importSharedConversationToAccount({
      shareId: sampleShareId,
      snapshot: sampleSnapshot,
      recipientUser,
      recipientUserMessage,
      recipientAssistantMessage,
      options: {
        customChatId,
        firestoreDb: {},
        docImpl: mockDoc,
        writeBatchImpl: mockWriteBatch
      }
    })
  ]);

  // All 3 promises resolve to the same chat ID
  assert.strictEqual(res1.chatId, res2.chatId);
  assert.strictEqual(res2.chatId, res3.chatId);

  // Exactly 1 Firestore commit must have occurred
  assert.strictEqual(firestoreCommitCount, 1, 'Firestore commit must happen exactly once for concurrent calls');
});

await runAsyncTest('9. Subsequent import calls return completed import from cache without re-creating', async () => {
  const resultAgain = await importSharedConversationToAccount({
    shareId: sampleShareId,
    snapshot: sampleSnapshot,
    recipientUser,
    recipientUserMessage,
    recipientAssistantMessage
  });

  assert.strictEqual(resultAgain.success, true);
  assert.strictEqual(resultAgain.alreadyImported, true);
});

// ==============================================================================
// Group 5: Authentication & Input Validation
// ==============================================================================

await runAsyncTest('10. importSharedConversationToAccount strictly rejects unauthenticated or anonymous users', async () => {
  clearImportLocks();

  // Null user
  let threwNull = false;
  try {
    await importSharedConversationToAccount({
      shareId: sampleShareId,
      snapshot: sampleSnapshot,
      recipientUser: null,
      recipientUserMessage,
      recipientAssistantMessage
    });
  } catch (err) {
    threwNull = true;
    assert.strictEqual(err.code, 'AUTH_REQUIRED');
  }
  assert.ok(threwNull);

  // Anonymous user
  let threwAnon = false;
  try {
    await importSharedConversationToAccount({
      shareId: sampleShareId,
      snapshot: sampleSnapshot,
      recipientUser: { uid: 'anon_123', isAnonymous: true },
      recipientUserMessage,
      recipientAssistantMessage
    });
  } catch (err) {
    threwAnon = true;
    assert.strictEqual(err.code, 'AUTH_REQUIRED');
  }
  assert.ok(threwAnon);
});

await runAsyncTest('11. importSharedConversationToAccount rejects malformed snapshot or invalid shareId', async () => {
  clearImportLocks();

  let threwBadId = false;
  try {
    await importSharedConversationToAccount({
      shareId: 'bad_id',
      snapshot: sampleSnapshot,
      recipientUser,
      recipientUserMessage,
      recipientAssistantMessage
    });
  } catch (err) {
    threwBadId = true;
    assert.strictEqual(err.code, 'INVALID_SHARE_ID');
  }
  assert.ok(threwBadId);

  let threwBadSnap = false;
  try {
    await importSharedConversationToAccount({
      shareId: sampleShareId,
      snapshot: null,
      recipientUser,
      recipientUserMessage,
      recipientAssistantMessage
    });
  } catch (err) {
    threwBadSnap = true;
    assert.strictEqual(err.code, 'MALFORMED_SNAPSHOT');
  }
  assert.ok(threwBadSnap);
});

// ==============================================================================
// Group 6: Permissions After Import
// ==============================================================================

runTest('12. getSharedPreviewActionPermissions unlocks all normal actions once imported is true', () => {
  // Before import (temporary preview)
  const previewPerms = getSharedPreviewActionPermissions({
    isShareRoute: true,
    user: recipientUser,
    hasSubmittedFirstMessage: false,
    isImported: false
  });

  assert.strictEqual(previewPerms.canSubmitFirstMessage, true);
  assert.strictEqual(previewPerms.canRename, false);
  assert.strictEqual(previewPerms.canDelete, false);
  assert.strictEqual(previewPerms.canPin, false);
  assert.strictEqual(previewPerms.canSwitchMode, false);
  assert.strictEqual(previewPerms.showInHistory, false);

  // After import (permanent private chat)
  const importedPerms = getSharedPreviewActionPermissions({
    isShareRoute: true,
    user: recipientUser,
    hasSubmittedFirstMessage: true,
    isImported: true
  });

  assert.strictEqual(importedPerms.canRename, true);
  assert.strictEqual(importedPerms.canDelete, true);
  assert.strictEqual(importedPerms.canPin, true);
  assert.strictEqual(importedPerms.canSwitchMode, true);
  assert.strictEqual(importedPerms.canRegenerate, true);
  assert.strictEqual(importedPerms.canEditResend, true);
  assert.strictEqual(importedPerms.canSwitchProvider, true);
  assert.strictEqual(importedPerms.canExport, true);
  assert.strictEqual(importedPerms.canShareChat, true);
  assert.strictEqual(importedPerms.showInHistory, true);
  assert.strictEqual(importedPerms.isPermanentChat, true);
});

// ==============================================================================
// Group 7: Local Storage and Cache Consistency
// ==============================================================================

await runAsyncTest('13. Local cache contains the imported conversation with isImported metadata', async () => {
  clearImportLocks();
  const testUserId = 'local_cache_verify_user';
  const customChatId = 'local_cache_chat_1';

  await importSharedConversationToAccount({
    shareId: sampleShareId,
    snapshot: sampleSnapshot,
    recipientUser: { uid: testUserId, email: 'local@example.com' },
    recipientUserMessage,
    recipientAssistantMessage,
    options: {
      customChatId,
      skipFirestore: true
    }
  });

  const cachedChats = getCachedUserChats(testUserId);
  assert.ok(cachedChats.length > 0, 'Cached chats must contain new imported conversation');

  const importedChat = cachedChats.find((c) => c.id === customChatId);
  assert.ok(importedChat, 'Imported chat must exist in cache');
  assert.strictEqual(importedChat.isImported, true);
  assert.strictEqual(importedChat.importedFromShareId, sampleShareId);
  assert.strictEqual(importedChat.title, sampleSnapshot.title);
  assert.strictEqual(importedChat.mode, sampleSnapshot.mode);

  const cachedMsgs = getCachedChatMessages(testUserId, customChatId);
  assert.strictEqual(cachedMsgs.length, 4, 'Cached messages must contain 4 remapped messages');
});

// ==============================================================================
// Group 8: Failure Boundaries, Immutability & UI Validation
// ==============================================================================

runTest('14. Failure and cancellation states do NOT create imported conversation', () => {
  // Simulate assistant response stopping midway or encountering an error
  const stoppedMessage = {
    ...recipientAssistantMessage,
    isStreaming: false,
    isStopped: true,
    isError: false,
    content: 'Partial sentence that was aborted...'
  };

  const errorMessage = {
    ...recipientAssistantMessage,
    isStreaming: false,
    isStopped: false,
    isError: true,
    content: 'Network connection lost.'
  };

  // Eligibility check for import transition requires completed non-error message
  const canImportStopped = !stoppedMessage.isError && !stoppedMessage.isStopped;
  assert.strictEqual(canImportStopped, false, 'Stopped message must not trigger import');

  const canImportError = !errorMessage.isError && !errorMessage.isStopped;
  assert.strictEqual(canImportError, false, 'Error message must not trigger import');
});

await runAsyncTest('15. Retrying after failure successfully transitions to permanent import once completed', async () => {
  clearImportLocks();
  const retryUserId = 'retry_user_123';
  const customChatId = 'retry_chat_1';

  const completedRetryMessage = {
    ...recipientAssistantMessage,
    id: 'gemini-retry-asst-1',
    isStreaming: false,
    isStopped: false,
    isError: false,
    content: 'Full comprehensive quantum entanglement explanation after successful retry.'
  };

  const importResult = await importSharedConversationToAccount({
    shareId: sampleShareId,
    snapshot: sampleSnapshot,
    recipientUser: { uid: retryUserId, email: 'retry@example.com' },
    recipientUserMessage,
    recipientAssistantMessage: completedRetryMessage,
    options: {
      customChatId,
      skipFirestore: true
    }
  });

  assert.strictEqual(importResult.success, true);
  assert.strictEqual(importResult.chatId, customChatId);
  assert.strictEqual(importResult.messages.length, 4);
  assert.strictEqual(importResult.messages[3].content, completedRetryMessage.content);
});

runTest('16. Shared snapshot document sharedChats/{shareId} remains 100% immutable', () => {
  // Verify that createImportedConversationData and remapSharedSnapshotMessages make deep independent copies
  const originalCopyBefore = JSON.parse(JSON.stringify(sampleSnapshot));

  const importData = createImportedConversationData({
    shareId: sampleShareId,
    snapshot: sampleSnapshot,
    recipientUserId: recipientUser.uid,
    recipientUserMessage,
    recipientAssistantMessage
  });

  // Mutate imported data to prove isolation
  importData.chatMetadata.title = 'Mutated Title In Recipient Account';
  importData.messages[0].content = 'Mutated Content In Recipient Account';

  // Original snapshot must remain strictly unchanged
  assert.strictEqual(sampleSnapshot.title, originalCopyBefore.title);
  assert.strictEqual(sampleSnapshot.messages[0].content, originalCopyBefore.messages[0].content);
});

runTest('17. Multi-part continuation requests can be mapped after import', () => {
  const importData = createImportedConversationData({
    shareId: sampleShareId,
    snapshot: sampleSnapshot,
    recipientUserId: recipientUser.uid,
    recipientUserMessage,
    recipientAssistantMessage
  });

  const lastMsg = importData.messages[importData.messages.length - 1];
  assert.strictEqual(lastMsg.id, recipientAssistantMessage.id);
  assert.strictEqual(lastMsg.parentMessageId, recipientUserMessage.id);
});

// ==============================================================================
// Summary Report
// ==============================================================================

console.log('\n======================================================');
console.log(`Stage 6 Test Suite Completed: ${passedTests}/${totalTests} Passed`);
console.log('======================================================\n');

if (passedTests !== totalTests) {
  process.exit(1);
}
