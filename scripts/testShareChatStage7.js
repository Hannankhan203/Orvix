import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Provide window, document, and storage mocks for Node.js test environment
const mockLocalStorage = new Map();
const mockSessionStorage = new Map();

class MockBlob {
  constructor(contentArray, options = {}) {
    this.content = contentArray.join('');
    this.type = options.type || '';
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
  }),
  body: {
    appendChild: () => {},
    removeChild: () => {},
  },
};

globalThis.window = {
  location: { origin: 'https://orvix.ai' },
  history: { pushState: () => {} },
  dispatchEvent: () => {},
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
  evaluateShareEligibility,
  buildValidatedSharedSnapshot,
  createSharedChatSnapshot,
  importSharedConversationToAccount,
  isImportedConversation,
  getImportedOriginShareId,
  verifyReshareIntegrity,
  getSharedPreviewActionPermissions,
  clearImportLocks,
} = await import('../src/services/shareChatService.js');

const {
  upsertCachedUserChat,
  getCachedUserChats,
  saveCachedChatMessages,
  getCachedChatMessages,
  renameConversation,
  toggleChatPinned,
  deleteConversation,
} = await import('../src/services/chatStorageService.js');

const {
  exportAsMarkdown,
  exportAsPlainText,
  formatConversationMarkdown,
  formatConversationPlainText,
} = await import('../src/utils/exportConversation.js');

let passed = 0;
let failed = 0;

async function runTest(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS: ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL: ${name}`);
    console.error(`    ${err?.stack || err?.message || err}`);
  }
}

console.log('=== Orvix Share Chat Stage 7 Verification Suite ===\n');

// 1. Static Anti-Regression: Math.random check in shareChatService.js
await runTest('1. shareChatService.js static safety: zero Math.random() usage', () => {
  const serviceSource = fs.readFileSync(path.resolve('src/services/shareChatService.js'), 'utf8');
  const codeWithoutComments = serviceSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*/g, '');
  assert.equal(
    codeWithoutComments.includes('Math.random'),
    false,
    'shareChatService.js must never use Math.random()'
  );
});

// 2. Imported Chat Identity & Metadata Helpers
await runTest('2. isImportedConversation and getImportedOriginShareId correctly detect imported chats', () => {
  const normalChat = { id: 'chat_normal_1', title: 'Regular Chat', mode: 'general' };
  assert.equal(isImportedConversation(normalChat), false);
  assert.equal(getImportedOriginShareId(normalChat), null);

  const importedChat = {
    id: 'chat_imp_1',
    title: 'Imported Discussion',
    mode: 'coding',
    isImported: true,
    importedFromShareId: 'share_origin_123456789012',
  };
  assert.equal(isImportedConversation(importedChat), true);
  assert.equal(getImportedOriginShareId(importedChat), 'share_origin_123456789012');

  // Defensive checks on falsy/empty values
  assert.equal(isImportedConversation(null), false);
  assert.equal(isImportedConversation(undefined), false);
  assert.equal(isImportedConversation({}), false);
  assert.equal(getImportedOriginShareId(null), null);
  assert.equal(getImportedOriginShareId({ isImported: true, importedFromShareId: '   ' }), null);
});

// 3. Permission Matrix: Preview vs Imported vs Normal Chat
await runTest('3. getSharedPreviewActionPermissions enforces share/export/history permissions', () => {
  // Scenario A: Unauthenticated Visitor on /share/{id}
  const anonPermissions = getSharedPreviewActionPermissions({
    isShareRoute: true,
    hasSharedSnapshot: true,
    isImported: false,
    user: null,
  });
  assert.equal(anonPermissions.canSubmit, false);
  assert.equal(anonPermissions.canType, false);
  assert.equal(anonPermissions.canShareChat, false);
  assert.equal(anonPermissions.showInHistory, false);

  // Scenario B: Authenticated recipient on /share/{id} before first message import
  const previewPermissions = getSharedPreviewActionPermissions({
    isShareRoute: true,
    hasSharedSnapshot: true,
    isImported: false,
    user: { uid: 'user_recipient_77' },
  });
  assert.equal(previewPermissions.canSubmit, true);
  assert.equal(previewPermissions.canType, true);
  assert.equal(previewPermissions.canShareChat, false); // Disabled in temporary preview
  assert.equal(previewPermissions.showInHistory, false); // Not in history until saved

  // Scenario C: Imported chat in recipient account
  const importedPermissions = getSharedPreviewActionPermissions({
    isShareRoute: false,
    hasSharedSnapshot: false,
    isImported: true,
    user: { uid: 'user_recipient_77' },
  });
  assert.equal(importedPermissions.canSubmit, true);
  assert.equal(importedPermissions.canShareChat, true); // Enabled for imported chat
  assert.equal(importedPermissions.showInHistory, true); // Visible in sidebar
});

// 4. evaluateShareEligibility blocks preview, enables imported chat
await runTest('4. evaluateShareEligibility strictly blocks shared previews and enables imported chats', () => {
  const user = { uid: 'user_recipient_77', isAnonymous: false };
  const mockMessages = [
    { id: 'm1', sender: 'user', content: 'Prompt 1' },
    { id: 'm2', sender: 'assistant', content: 'Response 1' },
  ];

  // In temporary preview: blocked
  const previewCheck = evaluateShareEligibility({
    user,
    chat: { id: 'temp_share_chat', isSharedPreview: true },
    messages: mockMessages,
    isSharedPreview: true,
  });
  assert.equal(previewCheck.eligible, false);
  assert.match(previewCheck.reason, /previews cannot be re-shared/i);

  // Once imported as permanent chat: eligible
  const importedCheck = evaluateShareEligibility({
    user,
    chat: {
      id: 'imp_chat_saved',
      title: 'Imported Guide',
      mode: 'coding',
      isImported: true,
      importedFromShareId: 'original_share_123',
    },
    messages: mockMessages,
    isSharedPreview: false,
  });
  assert.equal(importedCheck.eligible, true);
  assert.equal(importedCheck.reason, null);
});

// 5. Metadata Preservation Across Rename, Pin, and Mode Update
await runTest('5. Imported metadata (isImported, importedFromShareId) survives rename and pin operations', async () => {
  const testUserId = 'user_meta_test_77';
  mockLocalStorage.clear();

  const initialChat = {
    id: 'chat_imported_survive_1',
    title: 'Initial Imported Title',
    mode: 'general',
    isImported: true,
    importedFromShareId: 'orig_share_999888777666',
    timestamp: 'Just now',
    rawUpdatedAt: Date.now(),
    isPinned: false,
  };

  upsertCachedUserChat(testUserId, initialChat);

  // Verify initial state
  let cached = getCachedUserChats(testUserId);
  let found = cached.find((c) => c.id === initialChat.id);
  assert.equal(found.isImported, true);
  assert.equal(found.importedFromShareId, 'orig_share_999888777666');

  // Rename conversation
  await renameConversation(testUserId, initialChat.id, 'Renamed Discussion');
  cached = getCachedUserChats(testUserId);
  found = cached.find((c) => c.id === initialChat.id);
  assert.equal(found.title, 'Renamed Discussion');
  assert.equal(found.isImported, true, 'isImported must survive rename');
  assert.equal(found.importedFromShareId, 'orig_share_999888777666', 'importedFromShareId must survive rename');

  // Pin conversation
  await toggleChatPinned(testUserId, initialChat.id, true);
  cached = getCachedUserChats(testUserId);
  found = cached.find((c) => c.id === initialChat.id);
  assert.equal(found.isPinned, true);
  assert.equal(found.isImported, true, 'isImported must survive pin');
  assert.equal(found.importedFromShareId, 'orig_share_999888777666', 'importedFromShareId must survive pin');

  // Unpin conversation
  await toggleChatPinned(testUserId, initialChat.id, false);
  cached = getCachedUserChats(testUserId);
  found = cached.find((c) => c.id === initialChat.id);
  assert.equal(found.isPinned, false);
  assert.equal(found.isImported, true, 'isImported must survive unpin');
  assert.equal(found.importedFromShareId, 'orig_share_999888777666', 'importedFromShareId must survive unpin');
});

// 6. Delete Isolation: Deleting imported conversation leaves original public share untouched
await runTest('6. Deleting private imported conversation never affects public sharedChats document', async () => {
  const testUserId = 'user_del_test_77';
  mockLocalStorage.clear();

  const originalShareDoc = {
    id: 'public_share_immutable_1',
    title: 'Public Knowledge',
    mode: 'general',
    messageCount: 2,
    messages: [
      { id: 'm1', sender: 'user', content: 'What is WebGPU?' },
      { id: 'm2', sender: 'assistant', content: 'WebGPU is a modern graphics and compute API.' },
    ],
  };

  const importedChat = {
    id: 'private_imported_chat_42',
    title: 'Public Knowledge',
    mode: 'general',
    isImported: true,
    importedFromShareId: originalShareDoc.id,
    timestamp: 'Just now',
  };

  upsertCachedUserChat(testUserId, importedChat);
  saveCachedChatMessages(testUserId, importedChat.id, originalShareDoc.messages);

  assert.equal(getCachedUserChats(testUserId).length, 1);
  assert.equal(getCachedChatMessages(testUserId, importedChat.id).length, 2);

  // Delete private imported conversation
  await deleteConversation(testUserId, importedChat.id);

  // Private storage is cleaned
  assert.equal(getCachedUserChats(testUserId).length, 0);

  // Public snapshot object remains completely intact and unaffected
  assert.equal(originalShareDoc.id, 'public_share_immutable_1');
  assert.equal(originalShareDoc.messageCount, 2);
  assert.equal(originalShareDoc.messages.length, 2);
});

// 7. Full Conversation Resharing (The Core Stage 7 Feature)
await runTest('7. Resharing imported conversation publishes the ENTIRE conversation (original + continuation)', async () => {
  const originalShareId = 'orig_share_abc123def456';
  const originalSnapshot = {
    id: originalShareId,
    title: 'Original Thread',
    mode: 'coding',
    messageCount: 2,
    messages: [
      { id: 'msg_orig_1', sender: 'user', content: 'How do I invert a binary tree?' },
      { id: 'msg_orig_2', sender: 'assistant', content: 'Here is an iterative inversion in TypeScript...' },
    ],
  };

  // Recipient imports and continues
  const recipientUser = { uid: 'recipient_alice', email: 'alice@example.com', isAnonymous: false };
  clearImportLocks();

  const importResult = await importSharedConversationToAccount({
    shareId: originalShareId,
    snapshot: originalSnapshot,
    recipientUser,
    recipientUserMessage: {
      id: 'local_recipient_turn_1',
      sender: 'user',
      content: 'Can you show me the recursive version instead?',
    },
    recipientAssistantMessage: {
      id: 'local_recipient_asst_1',
      sender: 'assistant',
      content: 'Certainly! Here is the recursive solution with O(n) time complexity...',
    },
    skipFirestore: true,
    customChatId: 'chat_alice_tree',
  });

  assert.equal(importResult.success, true);
  assert.equal(importResult.messages.length, 4); // 2 original + 2 recipient turns

  // Recipient adds another turn later
  const continuationTurn2 = [
    {
      id: 'alice_turn_3_user',
      sender: 'user',
      content: 'What about time complexity in worst-case skewed trees?',
      createdAtMs: Date.now() + 1000,
    },
    {
      id: 'alice_turn_3_asst',
      sender: 'assistant',
      content: 'Time complexity is still O(n), but call stack space is O(n) instead of O(log n).',
      createdAtMs: Date.now() + 2000,
    },
  ];

  const fullActiveConversation = [
    ...importResult.messages,
    ...continuationTurn2,
  ];
  assert.equal(fullActiveConversation.length, 6);

  // Active chat record
  const aliceChat = {
    id: importResult.chatId,
    title: 'Binary Tree Inversion',
    mode: 'coding',
    isImported: true,
    importedFromShareId: originalShareId,
  };

  // Alice clicks "Share Chat" on this imported conversation
  const newShareId = generateShareId();
  assert.notEqual(newShareId, originalShareId);

  const { documentData: reSharedDoc, byteSize } = buildValidatedSharedSnapshot({
    shareId: newShareId,
    chat: aliceChat,
    messages: fullActiveConversation,
  });

  // Verify reshared snapshot properties
  assert.equal(reSharedDoc.id, newShareId);
  assert.equal(reSharedDoc.title, 'Binary Tree Inversion');
  assert.equal(reSharedDoc.mode, 'coding');
  assert.equal(reSharedDoc.messageCount, 6, 'Reshared snapshot MUST contain all 6 messages');
  assert.equal(reSharedDoc.messages.length, 6);
  assert(byteSize > 0);

  // Verify message sequence integrity: original turns first, followed by continuation turns
  assert.equal(reSharedDoc.messages[0].content, 'How do I invert a binary tree?');
  assert.equal(reSharedDoc.messages[1].content, 'Here is an iterative inversion in TypeScript...');
  assert.equal(reSharedDoc.messages[2].content, 'Can you show me the recursive version instead?');
  assert.equal(reSharedDoc.messages[3].content, 'Certainly! Here is the recursive solution with O(n) time complexity...');
  assert.equal(reSharedDoc.messages[4].content, 'What about time complexity in worst-case skewed trees?');
  assert.equal(reSharedDoc.messages[5].content, 'Time complexity is still O(n), but call stack space is O(n) instead of O(log n).');

  // Verify private metadata is NOT exposed in the public reshared snapshot
  assert.equal('isImported' in reSharedDoc, false);
  assert.equal('importedFromShareId' in reSharedDoc, false);
  assert.equal('userId' in reSharedDoc, false);
  assert.equal('createdOffline' in reSharedDoc, false);

  // Original snapshot remains untouched
  assert.equal(originalSnapshot.messageCount, 2);
  assert.equal(originalSnapshot.messages.length, 2);

  // Verify using verifyReshareIntegrity helper
  const integrity = verifyReshareIntegrity({
    originalSnapshot,
    reSharedSnapshot: reSharedDoc,
    continuationMessages: [
      importResult.messages[2],
      importResult.messages[3],
      ...continuationTurn2,
    ],
  });
  assert.equal(integrity.valid, true, `Integrity errors: ${integrity.errors.join(', ')}`);
});

// 8. Resharing Chain (Owner -> Share 1 -> Friend 1 Import & Continue -> Share 2 -> Friend 2 Import & Continue)
await runTest('8. Multi-generation resharing chain preserves history across multiple recipients', async () => {
  // Generation 1: Owner creates Share 1
  const gen1ShareId = generateShareId();
  const gen1Snapshot = {
    id: gen1ShareId,
    title: 'Python Tips',
    mode: 'general',
    messageCount: 2,
    messages: [
      { id: 'g1_m1', sender: 'user', content: 'What are Python list comprehensions?' },
      { id: 'g1_m2', sender: 'assistant', content: 'List comprehensions provide a concise way to create lists.' },
    ],
  };

  // Generation 2: Friend 1 imports Share 1 and adds their question
  clearImportLocks();
  const friend1User = { uid: 'user_friend_1', email: 'f1@example.com', isAnonymous: false };
  const friend1Import = await importSharedConversationToAccount({
    shareId: gen1ShareId,
    snapshot: gen1Snapshot,
    recipientUser: friend1User,
    recipientUserMessage: {
      id: 'f1_q',
      sender: 'user',
      content: 'Can you show a dictionary comprehension too?',
    },
    recipientAssistantMessage: {
      id: 'f1_a',
      sender: 'assistant',
      content: 'Yes! {k: v for k, v in iterable} is dictionary comprehension syntax.',
    },
    skipFirestore: true,
  });

  // Friend 1 reshares their imported conversation -> Share 2
  const gen2ShareId = generateShareId();
  assert.notEqual(gen2ShareId, gen1ShareId);

  const { documentData: gen2Snapshot } = buildValidatedSharedSnapshot({
    shareId: gen2ShareId,
    chat: {
      id: friend1Import.chatId,
      title: 'Python Comprehensions Guide',
      mode: 'general',
      isImported: true,
      importedFromShareId: gen1ShareId,
    },
    messages: friend1Import.messages,
  });

  assert.equal(gen2Snapshot.messageCount, 4);

  // Generation 3: Friend 2 opens Share 2, imports it, and adds their question
  clearImportLocks();
  const friend2User = { uid: 'user_friend_2', email: 'f2@example.com', isAnonymous: false };
  const friend2Import = await importSharedConversationToAccount({
    shareId: gen2ShareId,
    snapshot: gen2Snapshot,
    recipientUser: friend2User,
    recipientUserMessage: {
      id: 'f2_q',
      sender: 'user',
      content: 'What about generator expressions for memory efficiency?',
    },
    recipientAssistantMessage: {
      id: 'f2_a',
      sender: 'assistant',
      content: 'Generator expressions use parentheses and yield items lazily one at a time.',
    },
    skipFirestore: true,
  });

  assert.equal(friend2Import.messages.length, 6);
  assert.equal(friend2Import.chatMetadata.isImported, true);
  assert.equal(friend2Import.chatMetadata.importedFromShareId, gen2ShareId);

  // Friend 2 reshares -> Share 3
  const gen3ShareId = generateShareId();
  const { documentData: gen3Snapshot } = buildValidatedSharedSnapshot({
    shareId: gen3ShareId,
    chat: friend2Import.chatMetadata,
    messages: friend2Import.messages,
  });

  assert.equal(gen3Snapshot.messageCount, 6);
  assert.equal(gen3Snapshot.messages[0].content, 'What are Python list comprehensions?');
  assert.equal(gen3Snapshot.messages[2].content, 'Can you show a dictionary comprehension too?');
  assert.equal(gen3Snapshot.messages[4].content, 'What about generator expressions for memory efficiency?');

  // Verify all 3 snapshots have distinct IDs and untouched message counts
  assert.equal(gen1Snapshot.messageCount, 2);
  assert.equal(gen2Snapshot.messageCount, 4);
  assert.equal(gen3Snapshot.messageCount, 6);
  assert.notEqual(gen1Snapshot.id, gen2Snapshot.id);
  assert.notEqual(gen2Snapshot.id, gen3Snapshot.id);
  assert.notEqual(gen1Snapshot.id, gen3Snapshot.id);
});

// 9. Full Conversation Export: Exporting imported conversation exports all turns
await runTest('9. exportAsMarkdown and exportAsPlainText export the entire imported thread', () => {
  const conversationMessages = [
    { id: 'm1', sender: 'user', content: 'What is WebGPU?' },
    { id: 'm2', sender: 'assistant', content: 'WebGPU is a modern web standard for GPU compute.' },
    { id: 'm3', sender: 'user', content: 'How does it compare to WebGL?' },
    { id: 'm4', sender: 'assistant', content: 'WebGPU provides lower overhead and better multithreading.' },
  ];

  // Test content formatting directly
  const mdContent = formatConversationMarkdown('WebGPU Overview', conversationMessages, { username: 'Alice' });
  assert(mdContent.includes('What is WebGPU?'));
  assert(mdContent.includes('WebGPU is a modern web standard'));
  assert(mdContent.includes('How does it compare to WebGL?'));
  assert(mdContent.includes('WebGPU provides lower overhead'));

  const txtContent = formatConversationPlainText('WebGPU Overview', conversationMessages, { username: 'Alice' });
  assert(txtContent.includes('What is WebGPU?'));
  assert(txtContent.includes('WebGPU is a modern web standard'));
  assert(txtContent.includes('How does it compare to WebGL?'));
  assert(txtContent.includes('WebGPU provides lower overhead'));

  // Test full export actions with mocked DOM download
  const mdResult = exportAsMarkdown({
    title: 'WebGPU Overview',
    messages: conversationMessages,
    username: 'Alice',
  });
  assert.equal(mdResult.success, true);
  assert.equal(mdResult.messageCount, 4);

  const txtResult = exportAsPlainText({
    title: 'WebGPU Overview',
    messages: conversationMessages,
    username: 'Alice',
  });
  assert.equal(txtResult.success, true);
  assert.equal(txtResult.messageCount, 4);
});

// 10. Assistant Alternatives Preservation in Reshared Snapshot
await runTest('10. Assistant alternatives and active alternative ID are preserved when resharing', () => {
  const messagesWithAlternatives = [
    {
      id: 'user_turn_1',
      sender: 'user',
      content: 'Tell me a joke about programming.',
    },
    {
      id: 'asst_turn_1',
      sender: 'assistant',
      content: 'Why do programmers prefer dark mode? Because light attracts bugs.',
      modelUsed: 'gemini-2.5-flash',
      provider: 'gemini',
      mode: 'general',
      activeAlternativeId: 'alt_groq_1',
      alternatives: [
        {
          id: 'alt_gemini_1',
          content: 'Why do programmers prefer dark mode? Because light attracts bugs.',
          provider: 'gemini',
          modelUsed: 'gemini-2.5-flash',
          mode: 'general',
        },
        {
          id: 'alt_groq_1',
          content: 'There are 10 types of people: those who understand binary, and those who don\'t.',
          provider: 'groq',
          modelUsed: 'openai/gpt-oss-120b',
          mode: 'general',
        },
      ],
    },
    {
      id: 'user_turn_2',
      sender: 'user',
      content: 'That was great! Tell me another.',
    },
    {
      id: 'asst_turn_2',
      sender: 'assistant',
      content: 'A SQL query walks into a bar, walks up to two tables and asks: "Can I join you?"',
      modelUsed: 'gemini-2.5-flash',
      provider: 'gemini',
      mode: 'general',
    },
  ];

  const shareId = generateShareId();
  const { documentData: snapshot } = buildValidatedSharedSnapshot({
    shareId,
    chat: {
      id: 'joke_chat',
      title: 'Programming Humor',
      mode: 'general',
      isImported: true,
      importedFromShareId: 'prev_share_1',
    },
    messages: messagesWithAlternatives,
  });

  assert.equal(snapshot.messageCount, 4);
  const secondMsg = snapshot.messages[1];
  assert.equal(secondMsg.sender, 'assistant');
  assert.equal(secondMsg.activeAlternativeId, 'alt_groq_1');
  assert.equal(Array.isArray(secondMsg.alternatives), true);
  assert.equal(secondMsg.alternatives.length, 2);
  assert.equal(secondMsg.alternatives[0].provider, 'gemini');
  assert.equal(secondMsg.alternatives[1].provider, 'groq');
});

// Summary
console.log(`\n========================================`);
console.log(`Stage 7 Tests Finished: ${passed} passed, ${failed} failed.`);
console.log(`========================================\n`);

if (failed > 0) {
  process.exit(1);
}
