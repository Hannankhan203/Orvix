import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  generateShareId,
  isValidShareId,
  isEligibleShareUser,
  evaluateShareEligibility,
  resolveShareBaseUrl,
  buildShareChatUrl,
  sanitizeAttachmentForShare,
  sanitizeMessageForShare,
  calculateSnapshotByteSize,
  buildValidatedSharedSnapshot,
  createSharedChatSnapshot,
  buildWhatsAppShareUrl,
  ALLOWED_SHARED_MESSAGE_KEYS,
  MAX_SHARED_SNAPSHOT_BYTES,
  ShareChatError,
} from '../src/services/shareChatService.js';

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

console.log('=== Orvix Share Chat Stage 3 Verification Suite ===\n');

// 1. Share ID Generation
await runTest('1. generateShareId produces 24-char cryptographically random URL-safe IDs', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) {
    const id = generateShareId();
    assert.equal(id.length, 24);
    assert.equal(isValidShareId(id), true);
    assert.match(id, /^[a-zA-Z0-9_-]{24}$/);
    assert.equal(seen.has(id), false, 'Generated duplicate Share ID');
    seen.add(id);
  }

  // Verify source file does not use Math.random()
  const serviceSource = fs.readFileSync(
    path.resolve('src/services/shareChatService.js'),
    'utf8'
  );
  const codeWithoutComments = serviceSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*/g, '');
  assert.equal(
    codeWithoutComments.includes('Math.random'),
    false,
    'shareChatService.js must never use Math.random()'
  );
});

// 2. User & Conversation Eligibility Rules
await runTest('2. Rejects Guest Mode, anonymous Firebase users, unauthenticated visitors, and temporary previews', () => {
  const validChat = { id: 'chat_123', title: 'Architecture Review', mode: 'coding' };
  const validMessages = [
    { id: 'msg_1', sender: 'user', content: 'Hello Orvix' },
    { id: 'msg_2', sender: 'assistant', content: 'Hi! How can I help?' },
  ];

  // Unauthenticated
  assert.equal(isEligibleShareUser(null), false);
  assert.equal(
    evaluateShareEligibility({ user: null, chat: validChat, messages: validMessages }).eligible,
    false
  );

  // Guest Mode UID
  const guestUser = { uid: 'guest-local-user', isAnonymous: false };
  assert.equal(isEligibleShareUser(guestUser), false);
  assert.equal(
    evaluateShareEligibility({ user: guestUser, chat: validChat, messages: validMessages }).eligible,
    false
  );

  // Anonymous Firebase user
  const anonUser = { uid: 'firebase_anon_abc123', isAnonymous: true };
  assert.equal(isEligibleShareUser(anonUser), false);
  assert.equal(
    evaluateShareEligibility({ user: anonUser, chat: validChat, messages: validMessages }).eligible,
    false
  );

  // Signed-in non-anonymous user with saved chat
  const realUser = { uid: 'user_real_999', email: 'dev@example.com', isAnonymous: false };
  assert.equal(isEligibleShareUser(realUser), true);
  assert.equal(
    evaluateShareEligibility({ user: realUser, chat: validChat, messages: validMessages }).eligible,
    true
  );

  // Imported conversation saved in user's own history IS eligible
  const importedChat = {
    id: 'chat_imported_456',
    title: 'Imported Discussion',
    mode: 'general',
    isImported: true,
    importedFromShareId: 'share_abcdef1234567890',
  };
  assert.equal(
    evaluateShareEligibility({ user: realUser, chat: importedChat, messages: validMessages }).eligible,
    true
  );

  // Temporary shared preview state is NOT eligible
  assert.equal(
    evaluateShareEligibility({
      user: realUser,
      chat: validChat,
      messages: validMessages,
      isSharedPreview: true,
    }).eligible,
    false
  );

  // Unsaved chat (no chat.id) is NOT eligible
  assert.equal(
    evaluateShareEligibility({
      user: realUser,
      chat: { id: '', title: 'Unsaved' },
      messages: validMessages,
    }).eligible,
    false
  );
});

// 3. Complete Conversation Snapshot & Chronological Message Ordering
await runTest('3. Captures the entire conversation and preserves chronological ordering', async () => {
  const realUser = { uid: 'user_real_999', isAnonymous: false };
  const chat = { id: 'chat_full_001', title: 'Multi-Turn Deep Dive', mode: 'learning' };

  // Provide out-of-order messages + a transient UI error bubble
  const rawMessages = [
    {
      id: 'msg_3',
      sender: 'user',
      content: 'Second user question',
      createdAtMs: 3000,
      clientTimestamp: '2026-03-30T10:00:03.000Z',
    },
    {
      id: 'msg_1',
      sender: 'user',
      content: 'First user question',
      createdAtMs: 1000,
      clientTimestamp: '2026-03-30T10:00:01.000Z',
    },
    {
      id: 'msg_err',
      sender: 'assistant',
      content: 'Transient network error',
      isError: true,
      createdAtMs: 2500,
    },
    {
      id: 'msg_2',
      sender: 'assistant',
      content: 'First assistant answer',
      parentMessageId: 'msg_1',
      modelUsed: 'gemini-3.8-flash',
      provider: 'gemini',
      responseTimeMs: 845,
      createdAtMs: 2000,
      clientTimestamp: '2026-03-30T10:00:02.000Z',
    },
    {
      id: 'msg_4',
      sender: 'assistant',
      content: 'Second assistant answer',
      parentMessageId: 'msg_3',
      modelUsed: 'openai/gpt-oss-120b',
      provider: 'groq',
      responseTimeMs: 412,
      createdAtMs: 4000,
      clientTimestamp: '2026-03-30T10:00:04.000Z',
    },
  ];

  let writtenDocPath = null;
  let writtenPayload = null;

  const result = await createSharedChatSnapshot(chat, rawMessages, {
    user: realUser,
    baseUrl: 'https://orvix.example.com/',
    docImpl: (_db, col, id) => `${col}/${id}`,
    setDocImpl: async (docRef, data) => {
      writtenDocPath = docRef;
      writtenPayload = data;
    },
  });

  assert.equal(writtenDocPath, `sharedChats/${result.shareId}`);
  assert.equal(result.shareUrl, `https://orvix.example.com/share/${result.shareId}`);
  assert.equal(result.messageCount, 4);
  assert.equal(writtenPayload.messageCount, 4);
  assert.equal(writtenPayload.title, 'Multi-Turn Deep Dive');
  assert.equal(writtenPayload.mode, 'learning');

  // Verify exact top-level keys match firestore.rules
  assert.deepEqual(
    Object.keys(writtenPayload).sort(),
    ['createdAt', 'id', 'messageCount', 'messages', 'mode', 'title']
  );

  // Verify chronological ordering was preserved across all 4 valid messages
  assert.deepEqual(
    writtenPayload.messages.map((m) => m.id),
    ['msg_1', 'msg_2', 'msg_3', 'msg_4']
  );
});

// 4. Per-Message Validation (Every Message Checked, Not Only First/Last)
await runTest('4. Validates every message in the conversation and rejects malformed middle messages', () => {
  const shareId = generateShareId();
  const chat = { id: 'chat_mid_invalid', title: 'Validation Test', mode: 'general' };

  const messagesWithInvalidMiddleSender = [
    { id: 'm1', sender: 'user', content: 'Valid first message' },
    { id: 'm2', sender: 'system', content: 'Invalid middle sender' },
    { id: 'm3', sender: 'assistant', content: 'Valid last message' },
  ];

  assert.throws(
    () =>
      buildValidatedSharedSnapshot({
        shareId,
        chat,
        messages: messagesWithInvalidMiddleSender,
      }),
    (err) => err instanceof ShareChatError && err.code === 'INVALID_MESSAGE_SENDER'
  );

  const messagesWithNonStringMiddleContent = [
    { id: 'm1', sender: 'user', content: 'Valid first message' },
    { id: 'm2', sender: 'assistant', content: null },
    { id: 'm3', sender: 'user', content: 'Valid last message' },
  ];

  assert.throws(
    () =>
      buildValidatedSharedSnapshot({
        shareId,
        chat,
        messages: messagesWithNonStringMiddleContent,
      }),
    (err) => err instanceof ShareChatError && err.code === 'INVALID_MESSAGE_CONTENT'
  );
});

// 5. Attachment & Private Field Sanitization
await runTest('5. Strips binary/private attachment data and internal message fields while preserving OCR text', () => {
  const rawMessage = {
    id: 'msg_att_1',
    sender: 'user',
    content: 'Analyze this document',
    pendingSync: true,
    isStreaming: false,
    failedPrompt: 'secret',
    authToken: 'bearer-secret-token',
    attachments: [
      {
        id: 'att_doc_1',
        name: 'financial_report.pdf',
        originalName: 'financial_report.pdf',
        size: 48120,
        type: 'application/pdf',
        extension: 'pdf',
        format: 'pdf',
        category: 'document',
        base64: 'JVBERi0xLjQKJeLjz9MK...',
        dataUrl: 'data:application/pdf;base64,JVBERi0xLjQK...',
        previewUrl: 'blob:https://orvix.ai/998877-6655',
        url: 'file:///Users/private/financial_report.pdf',
        diskFilename: '/tmp/uploads/secret_file.pdf',
        filePath: '/var/data/secret_file.pdf',
        indexedDbKey: 'idb_key_123',
        extraction: {
          status: 'ready',
          type: 'document',
          format: 'pdf',
          text: 'Quarterly revenue increased by 18%.',
          wordCount: 5,
          charCount: 35,
          hasText: true,
          rawBuffer: 'SHOULD_BE_STRIPPED',
          localPath: '/private/path',
        },
      },
    ],
  };

  const cleanMsg = sanitizeMessageForShare(rawMessage, 0, 'general');

  // Ensure only whitelisted keys exist on message
  for (const key of Object.keys(cleanMsg)) {
    assert.equal(
      ALLOWED_SHARED_MESSAGE_KEYS.includes(key),
      true,
      `Unexpected message key: ${key}`
    );
    assert.notEqual(cleanMsg[key], undefined, `Key ${key} must not be undefined`);
  }

  assert.equal('pendingSync' in cleanMsg, false);
  assert.equal('failedPrompt' in cleanMsg, false);
  assert.equal('authToken' in cleanMsg, false);

  const cleanAtt = cleanMsg.attachments[0];
  assert.equal(cleanAtt.name, 'financial_report.pdf');
  assert.equal(cleanAtt.size, 48120);
  assert.equal('base64' in cleanAtt, false);
  assert.equal('dataUrl' in cleanAtt, false);
  assert.equal('previewUrl' in cleanAtt, false);
  assert.equal('url' in cleanAtt, false);
  assert.equal('diskFilename' in cleanAtt, false);
  assert.equal('filePath' in cleanAtt, false);
  assert.equal('indexedDbKey' in cleanAtt, false);

  // Safe extracted text is preserved
  assert.equal(cleanAtt.extraction.text, 'Quarterly revenue increased by 18%.');
  assert.equal('rawBuffer' in cleanAtt.extraction, false);
  assert.equal('localPath' in cleanAtt.extraction, false);
});

// 6. UTF-8 Byte Size Validation & Oversized Snapshot Rejection
await runTest('6. Calculates UTF-8 byte size and rejects snapshots exceeding MAX_SHARED_SNAPSHOT_BYTES', () => {
  const shareId = generateShareId();
  const chat = { id: 'chat_oversized', title: 'Large Chat', mode: 'general' };

  // Create 12 messages of 85,000 chars each (~1.02 MB total > 900 KB limit, while each message is < 100,000 chars)
  const hugeMessages = Array.from({ length: 12 }, (_, idx) => ({
    id: `msg_huge_${idx}`,
    sender: idx % 2 === 0 ? 'user' : 'assistant',
    content: 'A'.repeat(85000),
    createdAtMs: (idx + 1) * 1000,
  }));

  assert.throws(
    () =>
      buildValidatedSharedSnapshot({
        shareId,
        chat,
        messages: hugeMessages,
      }),
    (err) => {
      assert.equal(err instanceof ShareChatError, true);
      assert.equal(err.code, 'SNAPSHOT_TOO_LARGE');
      assert.match(err.message, /too large to share/i);
      return true;
    }
  );

  // Verify a normal conversation is well under MAX_SHARED_SNAPSHOT_BYTES
  const normalSnapshot = buildValidatedSharedSnapshot({
    shareId,
    chat,
    messages: [
      { id: 'm1', sender: 'user', content: 'Hello world' },
      { id: 'm2', sender: 'assistant', content: 'Hello! Here is a concise response.' },
    ],
  });
  assert.equal(normalSnapshot.byteSize > 0, true);
  assert.equal(normalSnapshot.byteSize < MAX_SHARED_SNAPSHOT_BYTES, true);
});

// 7. Firestore Publication Failure & Duplicate In-Flight Guard
await runTest('7. Handles Firestore publication errors cleanly and prevents concurrent duplicate requests', async () => {
  const realUser = { uid: 'user_real_999', isAnonymous: false };
  const chat = { id: 'chat_concurrency_test', title: 'Concurrency Test', mode: 'general' };
  const messages = [
    { id: 'm1', sender: 'user', content: 'Question' },
    { id: 'm2', sender: 'assistant', content: 'Answer' },
  ];

  // Simulate slow Firestore write to test duplicate in-flight guard
  let resolveWrite;
  const slowWritePromise = new Promise((resolve) => {
    resolveWrite = resolve;
  });

  const firstCall = createSharedChatSnapshot(chat, messages, {
    user: realUser,
    docImpl: (_db, col, id) => `${col}/${id}`,
    setDocImpl: () => slowWritePromise,
  });

  await assert.rejects(
    () =>
      createSharedChatSnapshot(chat, messages, {
        user: realUser,
        docImpl: (_db, col, id) => `${col}/${id}`,
        setDocImpl: async () => {},
      }),
    (err) => err instanceof ShareChatError && err.code === 'DUPLICATE_IN_FLIGHT'
  );

  resolveWrite();
  const firstResult = await firstCall;
  assert.equal(isValidShareId(firstResult.shareId), true);

  // Simulate Firestore permission error and verify source messages array was not mutated
  const originalMessagesJson = JSON.stringify(messages);
  await assert.rejects(
    () =>
      createSharedChatSnapshot(chat, messages, {
        user: realUser,
        docImpl: (_db, col, id) => `${col}/${id}`,
        setDocImpl: async () => {
          const err = new Error('Missing or insufficient permissions.');
          err.code = 'permission-denied';
          throw err;
        },
      }),
    (err) => err instanceof ShareChatError && err.code === 'PERMISSION_DENIED'
  );
  assert.equal(JSON.stringify(messages), originalMessagesJson);
});

// 8. Share URL & WhatsApp Share Link Formatting
await runTest('8. Formats canonical share URLs and WhatsApp share URLs accurately', () => {
  const shareId = generateShareId();
  const url = buildShareChatUrl(shareId, 'https://orvix.app///');
  assert.equal(url, `https://orvix.app/share/${shareId}`);
  assert.equal(resolveShareBaseUrl('https://custom.domain.org/'), 'https://custom.domain.org');

  const waUrl = buildWhatsAppShareUrl(url, 'System Design Notes');
  assert.equal(waUrl.startsWith('https://wa.me/?text='), true);
  assert.equal(decodeURIComponent(waUrl).includes(url), true);
  assert.equal(decodeURIComponent(waUrl).includes('System Design Notes'), true);
});

console.log(`\n=== Summary: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  process.exit(1);
}
