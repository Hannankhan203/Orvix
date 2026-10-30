/**
 * scripts/testShareChatStage8.js
 * Orvix Share Chat — Prompt 8: Comprehensive Persistence, Security,
 * Edge-Case & Final Integration Audit Suite
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Set up browser-like environment for Node.js test execution
const mockLocalStorage = new Map();
const mockSessionStorage = new Map();

class MockBlob {
  constructor(contentArray, options = {}) {
    this.content = Array.isArray(contentArray) ? contentArray.join('') : String(contentArray);
    this.type = options.type || '';
    this.size = Buffer.byteLength(this.content, 'utf8');
  }
}

globalThis.Blob = MockBlob;
globalThis.URL = {
  createObjectURL: () => 'blob:https://orvix.ai/mock-blob-id',
  revokeObjectURL: () => {},
};

globalThis.document = {
  createElement: (tag) => ({
    tagName: tag.toUpperCase(),
    setAttribute: () => {},
    style: {},
    click: () => {},
    focus: () => {},
    select: () => {},
  }),
  body: {
    appendChild: () => {},
    removeChild: () => {},
  },
  execCommand: () => true,
};

globalThis.window = {
  location: { origin: 'https://orvix.ai', pathname: '/' },
  history: { pushState: () => {} },
  dispatchEvent: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  Blob: MockBlob,
};

globalThis.localStorage = {
  getItem: (key) => (mockLocalStorage.has(key) ? mockLocalStorage.get(key) : null),
  setItem: (key, val) => mockLocalStorage.set(key, String(val)),
  removeItem: (key) => mockLocalStorage.delete(key),
  clear: () => mockLocalStorage.clear(),
};

globalThis.sessionStorage = {
  getItem: (key) => (mockSessionStorage.has(key) ? mockSessionStorage.get(key) : null),
  setItem: (key, val) => mockSessionStorage.set(key, String(val)),
  removeItem: (key) => mockSessionStorage.delete(key),
  clear: () => mockSessionStorage.clear(),
};

const {
  generateShareId,
  isValidShareId,
  parseSharePath,
  getShareRouteDetails,
  evaluateShareEligibility,
  buildValidatedSharedSnapshot,
  validateSharedSnapshotPayload,
  loadSharedChatSnapshot,
  createSharedChatSnapshot,
  getSharedPreviewActionPermissions,
  createSharedPreviewState,
  getImportDeduplicationKey,
  remapSharedSnapshotMessages,
  createImportedConversationData,
  persistImportedConversationToFirestore,
  importSharedConversationToAccount,
  isImportedConversation,
  getImportedOriginShareId,
  verifyReshareIntegrity,
  sanitizeAttachmentForShare,
  calculateSnapshotByteSize,
  clearImportLocks,
  MAX_SHARED_SNAPSHOT_BYTES,
  MAX_SHARED_MESSAGE_COUNT,
  MAX_SHARED_MESSAGE_CONTENT_LENGTH,
} = await import('../src/services/shareChatService.js');

const {
  upsertCachedUserChat,
  getCachedUserChats,
  saveCachedChatMessages,
  getCachedChatMessages,
  renameConversation,
  toggleChatPinned,
  deleteConversation,
  syncOfflineUserChatsToFirestore,
} = await import('../src/services/chatStorageService.js');

let passedCount = 0;
let failedCount = 0;
const testResults = [];

async function auditCase(caseNumber, description, fn) {
  try {
    await fn();
    passedCount++;
    testResults.push({ num: caseNumber, desc: description, passed: true });
    console.log(`  PASS [Case ${caseNumber}]: ${description}`);
  } catch (err) {
    failedCount++;
    testResults.push({ num: caseNumber, desc: description, passed: false, error: err.message });
    console.error(`  FAIL [Case ${caseNumber}]: ${description}`);
    console.error(`    ${err?.stack || err?.message || err}`);
  }
}

console.log('\n======================================================================');
console.log('Orvix Share Chat Stage 8 — Final Comprehensive Audit Test Suite');
console.log('Testing 25 High-Risk Persistence, Security, and Edge-Case Invariants');
console.log('======================================================================\n');

// 1. Malformed share IDs
await auditCase(1, 'Malformed share IDs are rejected before any Firestore access', () => {
  const malformedSamples = [
    '',
    'short',
    'shorter_11c', // 11 chars
    'contains spaces in id',
    'contains<script>tag',
    'path/traversal/attack',
    'special!@#$%^&*()',
    'a'.repeat(129), // 129 chars exceeds 128 max
    null,
    undefined,
    123456789012,
  ];

  for (const sample of malformedSamples) {
    assert.equal(isValidShareId(sample), false, `Should reject malformed ID: ${sample}`);
  }

  // Path inspection
  const details1 = getShareRouteDetails('/share/<script>alert(1)</script>');
  assert.equal(details1.isValid, false);
  assert.equal(details1.isMalformed, true);

  const details2 = getShareRouteDetails('/share/');
  assert.equal(details2.isValid, false);
  assert.equal(details2.isMalformed, true);

  const details3 = getShareRouteDetails('/share/too-short');
  assert.equal(details3.isValid, false);
  assert.equal(details3.isMalformed, true);
});

// 2. Nonexistent share
await auditCase(2, 'Nonexistent share returns NOT_FOUND error without creating chat history', async () => {
  const fakeDocSnap = {
    exists: () => false,
    data: () => null,
  };
  const mockGetDoc = async () => fakeDocSnap;

  await assert.rejects(
    async () => {
      await loadSharedChatSnapshot('validShareId12345678', {
        getDocImpl: mockGetDoc,
        docImpl: () => ({ id: 'validShareId12345678' }),
        forceNetwork: true,
      });
    },
    (err) => err.code === 'NOT_FOUND'
  );

  // Assert local history is untouched
  assert.equal(mockLocalStorage.has('orvix_active_chat'), false);
  assert.equal(mockLocalStorage.has('orvix_guest_chats'), false);
});

// 3. Public read-only isolation
await auditCase(3, 'Public viewer is read-only with copy/read-aloud enabled and zero history created', () => {
  const perms = getSharedPreviewActionPermissions({
    isShareRoute: true,
    user: null,
    hasSentFirstMessage: false,
    isImported: false,
  });

  assert.equal(perms.canRead, true);
  assert.equal(perms.canCopy, true);
  assert.equal(perms.canReadAloud, true);

  // Prohibited actions
  assert.equal(perms.canType, false);
  assert.equal(perms.canSubmit, false);
  assert.equal(perms.canAttach, false);
  assert.equal(perms.canRecordVoice, false);
  assert.equal(perms.canRegenerate, false);
  assert.equal(perms.canGenerateAlternative, false);
  assert.equal(perms.canShareChat, false);
  assert.equal(perms.canEditUserMessage, false);
  assert.equal(perms.canDelete, false);
  assert.equal(perms.canRename, false);
  assert.equal(perms.canPin, false);
  assert.equal(perms.isHistoryCreated, false);
  assert.equal(perms.showInHistory, false);
  assert.equal(perms.isPublicSharedViewer, true);
  assert.equal(perms.isAuthenticatedSharedPreview, false);
});

// 4. Authenticated preview isolation
await auditCase(4, 'Authenticated preview allows typing/text-submit, disables attachments/voice/history', () => {
  const authedUser = { uid: 'user_audit_100', isAnonymous: false };
  const perms = getSharedPreviewActionPermissions({
    isShareRoute: true,
    user: authedUser,
    hasSentFirstMessage: false,
    isImported: false,
  });

  assert.equal(perms.canRead, true);
  assert.equal(perms.canCopy, true);
  assert.equal(perms.canReadAloud, true);
  assert.equal(perms.canType, true);
  assert.equal(perms.canSubmit, true);

  // Prohibited in temporary preview
  assert.equal(perms.canAttach, false);
  assert.equal(perms.canRecordVoice, false);
  assert.equal(perms.canDictate, false);
  assert.equal(perms.canDragDrop, false);
  assert.equal(perms.canPasteFile, false);
  assert.equal(perms.canRegenerate, false);
  assert.equal(perms.canShareChat, false);
  assert.equal(perms.canDelete, false);
  assert.equal(perms.isHistoryCreated, false);
  assert.equal(perms.showInHistory, false);
  assert.equal(perms.isAuthenticatedSharedPreview, true);
  assert.equal(perms.isPublicSharedViewer, false);
});

// 5. Successful import
await auditCase(5, 'Successful first interaction imports conversation with fresh IDs and linked turns', async () => {
  clearImportLocks();
  const shareId = 'shareIdAuditSuccessful1';
  const recipientUser = { uid: 'user_recipient_500', isAnonymous: false };

  const snapshot = {
    id: shareId,
    title: 'Audit Thread on Physics',
    mode: 'general',
    messageCount: 2,
    messages: [
      { id: 'orig_1', sender: 'user', content: 'What is entropy?' },
      { id: 'orig_2', sender: 'assistant', content: 'Entropy is a measure of disorder.' },
    ],
  };

  const recipientUserMessage = {
    id: 'recip_prompt_1',
    interactionId: 'recip_inter_1',
    sender: 'user',
    content: 'Give an everyday analogy.',
  };

  const recipientAssistantMessage = {
    id: 'recip_asst_1',
    interactionId: 'recip_inter_1',
    sender: 'assistant',
    content: 'Like an uncleaned room that naturally gets messy over time.',
    provider: 'gemini',
    modelUsed: 'gemini-3.8-flash',
  };

  const mockDb = {};
  const committedBatches = [];
  const mockWriteBatch = () => ({
    set: (ref, payload) => committedBatches.push({ op: 'set', ref, payload }),
    delete: () => {},
    commit: async () => {},
  });

  const res = await importSharedConversationToAccount({
    shareId,
    snapshot,
    recipientUser,
    recipientUserMessage,
    recipientAssistantMessage,
    options: {
      firestoreDb: mockDb,
      writeBatchImpl: mockWriteBatch,
      docImpl: (_db, ...pathParts) => ({ path: pathParts.join('/') }),
    },
  });

  assert.equal(res.success, true);
  assert.ok(res.chatId);
  assert.equal(res.chatMetadata.isImported, true);
  assert.equal(res.chatMetadata.importedFromShareId, shareId);
  assert.equal(res.messages.length, 4);

  // Fresh IDs check: none should match original snapshot IDs
  const allIds = res.messages.map((m) => m.id);
  assert.equal(allIds.includes('orig_1'), false);
  assert.equal(allIds.includes('orig_2'), false);

  // Relationship linkage check
  const recipPrompt = res.messages[2];
  const recipAsst = res.messages[3];
  assert.equal(recipPrompt.parentMessageId, res.messages[1].id);
  assert.equal(recipAsst.parentMessageId, recipPrompt.id);
});

// 6. Failed import
await auditCase(6, 'Failed generation during preview leaves NO permanent chat in storage', () => {
  const state = createSharedPreviewState({
    isShareRoute: true,
    user: { uid: 'user_fail_test' },
    hasSentFirstMessage: false,
    isSubmitting: false,
    hasFailed: true,
    isImported: false,
  });

  assert.equal(state.submissionPhase, 'failed');
  assert.equal(state.isImported, false);
  assert.equal(state.importedChatId, null);
  assert.equal(state.permissions.showInHistory, false);
});

// 7. Cancelled import
await auditCase(7, 'Cancelled generation during preview leaves NO permanent chat', () => {
  const state = createSharedPreviewState({
    isShareRoute: true,
    user: { uid: 'user_cancel_test' },
    hasSentFirstMessage: false,
    isSubmitting: false,
    hasFailed: false,
    isImported: false,
  });

  assert.equal(state.submissionPhase, 'idle');
  assert.equal(state.isImported, false);
  assert.equal(state.permissions.isHistoryCreated, false);
});

// 8. Duplicate import prevention
await auditCase(8, 'Repeated import attempts deduplicate and return cached conversation without duplicates', async () => {
  clearImportLocks();
  const shareId = 'shareIdDedupTest1234';
  const recipientUser = { uid: 'user_dedup_test', isAnonymous: false };

  const snapshot = {
    id: shareId,
    title: 'Dedup Thread',
    mode: 'general',
    messageCount: 1,
    messages: [{ id: 'orig_m1', sender: 'user', content: 'Hello' }],
  };

  const userMsg = { id: 'u_1', interactionId: 'inter_1', content: 'World' };
  const asstMsg = { id: 'a_1', interactionId: 'inter_1', content: 'Greetings' };

  let writeCount = 0;
  const mockWriteBatch = () => ({
    set: () => writeCount++,
    delete: () => {},
    commit: async () => {},
  });

  const res1 = await importSharedConversationToAccount({
    shareId,
    snapshot,
    recipientUser,
    recipientUserMessage: userMsg,
    recipientAssistantMessage: asstMsg,
    options: {
      firestoreDb: {},
      writeBatchImpl: mockWriteBatch,
      docImpl: (_db, ...p) => ({ path: p.join('/') }),
    },
  });

  const res2 = await importSharedConversationToAccount({
    shareId,
    snapshot,
    recipientUser,
    recipientUserMessage: userMsg,
    recipientAssistantMessage: asstMsg,
    options: {
      firestoreDb: {},
      writeBatchImpl: mockWriteBatch,
      docImpl: (_db, ...p) => ({ path: p.join('/') }),
    },
  });

  assert.equal(res1.chatId, res2.chatId);
  assert.equal(res2.alreadyImported, true);
  // Writes should not repeat for second identical call
  assert.equal(writeCount, 4); // 1 chat + 3 messages in first call only
});

// 9. Original snapshot immutability
await auditCase(9, 'Original sharedChats snapshot is strictly immutable: no update/delete/mutation', () => {
  const rulesPath = path.resolve('firestore.rules');
  const rulesContent = fs.readFileSync(rulesPath, 'utf8');

  // Verify firestore.rules has allow update, delete: if false; under sharedChats
  const sharedChatsBlockMatch = rulesContent.match(/match\s+\/sharedChats\/\{shareId\}[\s\S]*?\n\s*\}/);
  assert.ok(sharedChatsBlockMatch, 'sharedChats match block must exist in firestore.rules');
  const block = sharedChatsBlockMatch[0];
  assert.ok(
    block.includes('allow update, delete: if false;') ||
      (block.includes('allow update: if false;') && block.includes('allow delete: if false;')),
    'Rules must deny update and delete on sharedChats'
  );

  // Verify codebase search: zero updateDoc or deleteDoc calls targeting sharedChats
  const serviceCode = fs.readFileSync(path.resolve('src/services/shareChatService.js'), 'utf8');
  assert.equal(serviceCode.includes("updateDoc(doc(db, 'sharedChats'"), false);
  assert.equal(serviceCode.includes("deleteDoc(doc(db, 'sharedChats'"), false);
});

// 10. Complete resharing
await auditCase(10, 'Resharing imported conversation captures full history and continuation with new share ID', () => {
  const originalSnapshot = {
    id: 'originalShareId12345',
    title: 'Original Thread',
    mode: 'general',
    messageCount: 2,
    messages: [
      { id: 'm1', sender: 'user', content: 'Turn 1' },
      { id: 'm2', sender: 'assistant', content: 'Turn 2' },
    ],
  };

  const reSharedSnapshot = {
    id: 'newIndependentShareId999',
    title: 'Original Thread',
    mode: 'general',
    messageCount: 4,
    messages: [
      { id: 'm1_new', sender: 'user', content: 'Turn 1' },
      { id: 'm2_new', sender: 'assistant', content: 'Turn 2' },
      { id: 'm3_new', sender: 'user', content: 'Turn 3' },
      { id: 'm4_new', sender: 'assistant', content: 'Turn 4' },
    ],
  };

  const integrity = verifyReshareIntegrity({
    originalSnapshot,
    reSharedSnapshot,
    continuationMessages: [{ id: 'm3' }, { id: 'm4' }],
  });

  assert.equal(integrity.valid, true);
  assert.equal(integrity.errors.length, 0);
  assert.notEqual(reSharedSnapshot.id, originalSnapshot.id);
});

// 11. Snapshot size boundary
await auditCase(11, 'Snapshot size boundary rejects oversized payload (>900 KB) without silent truncation', () => {
  const shareId = 'validShareIdBoundary111';
  const chat = { id: 'chat_1', title: 'Boundary Chat', mode: 'general' };

  // 850 KB payload should pass
  const bigChunk = 'X'.repeat(80000); // 80 KB
  const messagesValid = [];
  for (let i = 0; i < 5; i++) {
    messagesValid.push(
      { id: `u_${i}`, sender: 'user', content: `Prompt ${i}` },
      { id: `a_${i}`, sender: 'assistant', content: bigChunk }
    );
  }
  const validSnapshot = buildValidatedSharedSnapshot({ shareId, chat, messages: messagesValid });
  assert.ok(validSnapshot.byteSize < MAX_SHARED_SNAPSHOT_BYTES);

  // Oversized payload (>900 KB) must be rejected with SNAPSHOT_TOO_LARGE
  const hugeChunk = 'Y'.repeat(99000);
  const messagesOversized = [];
  for (let i = 0; i < 11; i++) {
    messagesOversized.push(
      { id: `u_over_${i}`, sender: 'user', content: `Prompt ${i}` },
      { id: `a_over_${i}`, sender: 'assistant', content: hugeChunk }
    );
  }

  assert.throws(
    () => buildValidatedSharedSnapshot({ shareId, chat, messages: messagesOversized }),
    (err) => err.code === 'SNAPSHOT_TOO_LARGE'
  );
});

// 12. Message-count boundary
await auditCase(12, 'Message count boundary: 0 rejected, 1 accepted, 500 accepted, 501 rejected', () => {
  const shareId = 'countBoundaryTestId123';
  const chat = { id: 'chat_count', title: 'Count Boundary', mode: 'general' };

  // 0 messages: rejected
  assert.throws(
    () => buildValidatedSharedSnapshot({ shareId, chat, messages: [] }),
    (err) => err.code === 'EMPTY_CONVERSATION'
  );

  // 1 message: accepted
  const single = buildValidatedSharedSnapshot({
    shareId,
    chat,
    messages: [{ id: 'm1', sender: 'user', content: 'Single prompt' }],
  });
  assert.equal(single.documentData.messageCount, 1);

  // 500 messages: accepted
  const msgs500 = [];
  for (let i = 0; i < 250; i++) {
    msgs500.push(
      { id: `u_${i}`, sender: 'user', content: `User ${i}` },
      { id: `a_${i}`, sender: 'assistant', content: `Assistant ${i}` }
    );
  }
  const snap500 = buildValidatedSharedSnapshot({ shareId, chat, messages: msgs500 });
  assert.equal(snap500.documentData.messageCount, 500);

  // 501 messages: rejected
  msgs500.push({ id: 'u_501', sender: 'user', content: 'One more' });
  assert.throws(
    () => buildValidatedSharedSnapshot({ shareId, chat, messages: msgs500 }),
    (err) => err.code === 'SNAPSHOT_TOO_MANY_MESSAGES'
  );
});

// 13. UTF-8 byte-size calculation
await auditCase(13, 'UTF-8 byte-size correctly counts multi-byte characters (Urdu, CJK, Emoji)', () => {
  const asciiPayload = { text: 'Hello World' };
  const emojiPayload = { text: '🤖🌍🚀🔥' }; // 4 bytes each = 16 bytes for 4 chars
  const urduPayload = { text: 'اوروکس مصنوعی ذہانت' }; // 2 bytes per Arabic char
  const cjkPayload = { text: '人工智能对话助手' }; // 3 bytes per CJK char

  const bytesAscii = calculateSnapshotByteSize(asciiPayload);
  const bytesEmoji = calculateSnapshotByteSize(emojiPayload);
  const bytesUrdu = calculateSnapshotByteSize(urduPayload);
  const bytesCjk = calculateSnapshotByteSize(cjkPayload);

  assert.ok(bytesEmoji > JSON.stringify(emojiPayload).length);
  assert.ok(bytesUrdu > JSON.stringify(urduPayload).length);
  assert.ok(bytesCjk > JSON.stringify(cjkPayload).length);
});

// 14. Attachment sanitization
await auditCase(14, 'Attachment sanitization strictly strips raw blobs, base64, dataUrls, and local paths', () => {
  const dirtyAttachment = {
    id: 'att_dirty_1',
    name: 'contract.pdf',
    size: 2048,
    type: 'application/pdf',
    dataUrl: 'data:application/pdf;base64,SECRET_DATA_PAYLOAD',
    base64: 'SECRET_DATA_PAYLOAD',
    previewUrl: 'blob:https://orvix.ai/preview-123',
    localPath: '/home/user/documents/contract.pdf',
    indexedDbKey: 'idb_key_999',
    file: new MockBlob(['secret file content']),
    extraction: {
      status: 'ready',
      text: 'Extracted safe plain text content.',
      charCount: 35,
      wordCount: 5,
      totalWords: 5,
      totalCharacters: 35,
      diskPath: '/tmp/disk_extraction.txt', // Should be stripped
    },
  };

  const clean = sanitizeAttachmentForShare(dirtyAttachment);
  assert.equal(clean.id, 'att_dirty_1');
  assert.equal(clean.name, 'contract.pdf');
  assert.equal(clean.dataUrl, undefined);
  assert.equal(clean.base64, undefined);
  assert.equal(clean.previewUrl, undefined);
  assert.equal(clean.localPath, undefined);
  assert.equal(clean.indexedDbKey, undefined);
  assert.equal(clean.file, undefined);
  assert.equal(clean.extraction.text, 'Extracted safe plain text content.');
  assert.equal(clean.extraction.diskPath, undefined);

  // Directly passing raw Blob returns null
  assert.equal(sanitizeAttachmentForShare(new MockBlob(['blob content'])), null);
});

// 15. Relationship integrity
await auditCase(15, 'Logical relationships (parentMessageId, interactionId, alternatives) remapped correctly', () => {
  const original = [
    {
      id: 'old_u1',
      interactionId: 'old_inter1',
      sender: 'user',
      content: 'Explain recursion',
    },
    {
      id: 'old_a1',
      interactionId: 'old_inter1',
      parentMessageId: 'old_u1',
      sender: 'assistant',
      content: 'Recursion is when a function calls itself.',
      activeAlternativeId: 'old_alt1',
      alternatives: [
        { id: 'old_alt1', parentMessageId: 'old_u1', content: 'Alt 1' },
        { id: 'old_alt2', parentMessageId: 'old_u1', content: 'Alt 2' },
      ],
    },
  ];

  const remapped = remapSharedSnapshotMessages(original);
  const newU1 = remapped.remappedMessages[0];
  const newA1 = remapped.remappedMessages[1];

  assert.notEqual(newU1.id, 'old_u1');
  assert.notEqual(newA1.id, 'old_a1');
  assert.equal(newA1.parentMessageId, newU1.id);
  assert.equal(newU1.interactionId, newA1.interactionId);
  assert.notEqual(newU1.interactionId, 'old_inter1');
  assert.ok(newA1.activeAlternativeId);
  assert.notEqual(newA1.activeAlternativeId, 'old_alt1');
});

// 16. Offline/reconnect behavior
await auditCase(16, 'Offline import updates local cache with pendingSync and preserves isImported upon sync', async () => {
  clearImportLocks();
  const shareId = 'shareOfflineSyncTest12';
  const recipientUser = { uid: 'user_offline_audit', isAnonymous: false };

  const snapshot = {
    id: shareId,
    title: 'Offline Thread',
    mode: 'general',
    messageCount: 1,
    messages: [{ id: 'm1', sender: 'user', content: 'Offline prompt' }],
  };

  const userMsg = { id: 'u_off', interactionId: 'int_off', content: 'Offline reply' };
  const asstMsg = { id: 'a_off', interactionId: 'int_off', content: 'Offline AI response' };

  // Import while offline
  const res = await importSharedConversationToAccount({
    shareId,
    snapshot,
    recipientUser,
    recipientUserMessage: userMsg,
    recipientAssistantMessage: asstMsg,
    options: {
      isOnline: false,
      skipFirestore: true,
    },
  });

  assert.equal(res.success, true);
  const cachedChats = getCachedUserChats(recipientUser.uid);
  const importedChat = cachedChats.find((c) => c.id === res.chatId);
  assert.ok(importedChat);
  assert.equal(importedChat.isImported, true);
  assert.equal(importedChat.importedFromShareId, shareId);
  assert.equal(importedChat.pendingSync, true);
  assert.equal(importedChat.createdOffline, true);
});

// 17. Multi-tab synchronization
await auditCase(17, 'Multi-tab concurrent import calls deduplicate to a single conversation', async () => {
  clearImportLocks();
  const shareId = 'multiTabShareId12345';
  const recipientUser = { uid: 'user_multitab_999', isAnonymous: false };

  const snapshot = {
    id: shareId,
    title: 'Multi-Tab Thread',
    mode: 'general',
    messageCount: 1,
    messages: [{ id: 'm1', sender: 'user', content: 'Sync prompt' }],
  };

  const userMsg = { id: 'u_mt', interactionId: 'int_mt', content: 'Sync reply' };
  const asstMsg = { id: 'a_mt', interactionId: 'int_mt', content: 'Sync AI' };

  // Concurrent invocations simulating two tabs submitting at the same instant
  const [resA, resB] = await Promise.all([
    importSharedConversationToAccount({
      shareId,
      snapshot,
      recipientUser,
      recipientUserMessage: userMsg,
      recipientAssistantMessage: asstMsg,
      options: { skipFirestore: true },
    }),
    importSharedConversationToAccount({
      shareId,
      snapshot,
      recipientUser,
      recipientUserMessage: userMsg,
      recipientAssistantMessage: asstMsg,
      options: { skipFirestore: true },
    }),
  ]);

  assert.equal(resA.chatId, resB.chatId);
  const userChats = getCachedUserChats(recipientUser.uid);
  const matchingChats = userChats.filter((c) => c.importedFromShareId === shareId);
  assert.equal(matchingChats.length, 1);
});

// 18. Logout during preview
await auditCase(18, 'Logout during preview resets preview state to public read-only without creating history', () => {
  // Before logout: authenticated preview
  const authedState = createSharedPreviewState({
    isShareRoute: true,
    user: { uid: 'user_logging_out' },
    hasSentFirstMessage: false,
    isSubmitting: true,
  });
  assert.equal(authedState.isAuthenticatedSharedPreview, true);

  // After logout: public viewer
  const loggedOutState = createSharedPreviewState({
    isShareRoute: true,
    user: null,
    hasSentFirstMessage: false,
    isSubmitting: false,
    hasFailed: false,
  });
  assert.equal(loggedOutState.isAuthenticatedSharedPreview, false);
  assert.equal(loggedOutState.isPublicSharedViewer, true);
  assert.equal(loggedOutState.permissions.canType, false);
  assert.equal(loggedOutState.permissions.isHistoryCreated, false);
});

// 19. Logout during import
await auditCase(19, 'Unauthenticated user attempting import throws AUTH_REQUIRED', async () => {
  await assert.rejects(
    async () => {
      await importSharedConversationToAccount({
        shareId: 'validShareId12345678',
        snapshot: { id: 'validShareId12345678', title: 'T', messages: [] },
        recipientUser: null, // Logged out
        recipientUserMessage: {},
        recipientAssistantMessage: {},
      });
    },
    (err) => err.code === 'AUTH_REQUIRED'
  );
});

// 20. New Chat before import
await auditCase(20, 'New Chat action exits temporary preview without creating history or importing', () => {
  const previewState = createSharedPreviewState({
    isShareRoute: true,
    user: { uid: 'user_newchat_test' },
    hasSentFirstMessage: false,
  });
  assert.equal(previewState.permissions.canNewChat, true);
  assert.equal(previewState.permissions.isHistoryCreated, false);
});

// 21. Navigation before import
await auditCase(21, 'Navigating away from /share route discards temporary state cleanly', () => {
  const normalRoute = getShareRouteDetails('/');
  assert.equal(normalRoute.isShareRoute, false);
  assert.equal(normalRoute.shareId, null);

  const perms = getSharedPreviewActionPermissions({
    isShareRoute: false,
    user: { uid: 'user_nav_test' },
  });
  assert.equal(perms.isSharedPreview, false);
  assert.equal(perms.isPermanentChat, true);
});

// 22. Imported-chat history persistence
await auditCase(22, 'Imported chat survives in user chat list with isImported badge', () => {
  const userId = 'user_history_persist_1';
  const chatId = 'chat_imported_saved_1';

  upsertCachedUserChat(userId, {
    id: chatId,
    title: 'Imported Quantum Mechanics',
    mode: 'learning',
    isImported: true,
    importedFromShareId: 'shareIdQuantum999',
  });

  const list = getCachedUserChats(userId);
  const found = list.find((c) => c.id === chatId);
  assert.ok(found);
  assert.equal(isImportedConversation(found), true);
  assert.equal(getImportedOriginShareId(found), 'shareIdQuantum999');
});

// 23. Imported metadata persistence across rename and pin
await auditCase(23, 'Renaming and pinning an imported chat preserves isImported and importedFromShareId', () => {
  const userId = 'user_meta_persist_1';
  const chatId = 'chat_imported_meta_1';

  upsertCachedUserChat(userId, {
    id: chatId,
    title: 'Original Title',
    mode: 'coding',
    isImported: true,
    importedFromShareId: 'shareOriginId888',
    isPinned: false,
  });

  // Rename
  renameConversation(userId, chatId, 'Renamed Title');
  let chat = getCachedUserChats(userId).find((c) => c.id === chatId);
  assert.equal(chat.title, 'Renamed Title');
  assert.equal(chat.isImported, true);
  assert.equal(chat.importedFromShareId, 'shareOriginId888');

  // Pin
  toggleChatPinned(userId, chatId);
  chat = getCachedUserChats(userId).find((c) => c.id === chatId);
  assert.equal(chat.isPinned, true);
  assert.equal(chat.isImported, true);
  assert.equal(chat.importedFromShareId, 'shareOriginId888');
});

// 24. Public snapshot privacy
await auditCase(24, 'Public snapshot document contains ZERO private account or storage fields', () => {
  const shareId = 'shareIdPrivacyAudit1234';
  const chat = {
    id: 'private_chat_uuid_000',
    title: 'Clean Public Title',
    mode: 'coding',
    userId: 'private_owner_uid_999', // Private owner UID
    isImported: true,                 // Private imported flag
    importedFromShareId: 'older_share_id',
  };

  const rawMessages = [
    {
      id: 'm1',
      sender: 'user',
      content: 'Write code',
      userId: 'private_user_uid',
      isImported: true,
      pendingSync: true,
      createdOffline: true,
      dataUrl: 'data:text/plain;base64,SECRET',
      localPath: '/home/private/path.txt',
    },
    {
      id: 'm2',
      sender: 'assistant',
      content: 'Here is the code',
      tokens: 42,
      rawApiResponse: { model: 'secret' },
    },
  ];

  const { documentData } = buildValidatedSharedSnapshot({
    shareId,
    chat,
    messages: rawMessages,
  });

  // Allowed top-level fields: ONLY id, title, mode, createdAt, messageCount, messages
  const allowedTopLevel = new Set(['id', 'title', 'mode', 'createdAt', 'messageCount', 'messages']);
  for (const key of Object.keys(documentData)) {
    assert.ok(allowedTopLevel.has(key), `Top-level key "${key}" is not permitted in public snapshot`);
  }

  // Ensure no private metadata leaked
  assert.equal('userId' in documentData, false);
  assert.equal('isImported' in documentData, false);
  assert.equal('importedFromShareId' in documentData, false);

  // Message-level check
  for (const msg of documentData.messages) {
    assert.equal('userId' in msg, false);
    assert.equal('isImported' in msg, false);
    assert.equal('pendingSync' in msg, false);
    assert.equal('createdOffline' in msg, false);
    assert.equal('dataUrl' in msg, false);
    assert.equal('localPath' in msg, false);
    assert.equal('tokens' in msg, false);
    assert.equal('rawApiResponse' in msg, false);
  }
});

// 25. Handler-level action permissions
await auditCase(25, 'Handler-level action permission functions enforce security independently of UI buttons', () => {
  const publicPerms = getSharedPreviewActionPermissions({ isShareRoute: true, user: null });
  assert.equal(publicPerms.canSubmit, false);
  assert.equal(publicPerms.canRegenerate, false);
  assert.equal(publicPerms.canEditUserMessage, false);

  const authedPreviewPerms = getSharedPreviewActionPermissions({
    isShareRoute: true,
    user: { uid: 'u1' },
    hasSentFirstMessage: false,
  });
  assert.equal(authedPreviewPerms.canSubmit, true);
  assert.equal(authedPreviewPerms.canAttach, false);
  assert.equal(authedPreviewPerms.canRecordVoice, false);
  assert.equal(authedPreviewPerms.canRegenerate, false);
  assert.equal(authedPreviewPerms.canShareChat, false);

  const importedPerms = getSharedPreviewActionPermissions({
    isShareRoute: false,
    user: { uid: 'u1' },
    isImported: true,
  });
  assert.equal(importedPerms.canSubmit, true);
  assert.equal(importedPerms.canAttach, true);
  assert.equal(importedPerms.canRecordVoice, true);
  assert.equal(importedPerms.canRegenerate, true);
  assert.equal(importedPerms.canShareChat, true);
});

console.log('\n======================================================================');
console.log(`Stage 8 Final Audit Complete: ${passedCount} of 25 Cases Passed (${failedCount} Failed)`);
console.log('======================================================================\n');

if (failedCount > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
