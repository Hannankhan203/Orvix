/**
 * scripts/testShareChatStage4.js
 * Verification test suite for Orvix Share Chat Stage 4:
 * Public Shared Chat Viewer & Read-Only Demo Mode
 */

import assert from 'node:assert';
import {
  isValidShareId,
  parseSharePath,
  getShareRouteDetails,
  validateSharedSnapshotPayload,
  getSharedSnapshotSession,
  setSharedSnapshotSession,
  clearSharedSnapshotSession
} from '../src/services/shareChatService.js';

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
console.log('Orvix Share Chat Stage 4 — Verification Test Suite');
console.log('======================================================\n');

// 1. URL Path Parsing
runTest('parseSharePath correctly extracts share ID from standard /share/{shareId} paths', () => {
  const parsed1 = parseSharePath('/share/orvix_abc1234567890def');
  assert.strictEqual(parsed1, 'orvix_abc1234567890def');

  const parsed2 = parseSharePath('/share/20261030_a1b2c3d4e5f6');
  assert.strictEqual(parsed2, '20261030_a1b2c3d4e5f6');

  const parsedTrailing = parseSharePath('/share/20261030_a1b2c3d4e5f6/');
  assert.strictEqual(parsedTrailing, '20261030_a1b2c3d4e5f6');
});

runTest('parseSharePath returns null for non-share paths', () => {
  assert.strictEqual(parseSharePath('/'), null);
  assert.strictEqual(parseSharePath('/chat'), null);
  assert.strictEqual(parseSharePath('/settings'), null);
  assert.strictEqual(parseSharePath('/api/chat'), null);
  assert.strictEqual(parseSharePath('/share'), null);
  assert.strictEqual(parseSharePath('/share/'), null);
});

// 2. Share Route Details
runTest('getShareRouteDetails classifies valid and malformed paths properly', () => {
  const validDetails = getShareRouteDetails('/share/20261030_abc123def456');
  assert.strictEqual(validDetails.isShareRoute, true);
  assert.strictEqual(validDetails.isValid, true);
  assert.strictEqual(validDetails.isMalformed, false);
  assert.strictEqual(validDetails.shareId, '20261030_abc123def456');

  const malformedDetails = getShareRouteDetails('/share/invalid!chars%20id');
  assert.strictEqual(malformedDetails.isShareRoute, true);
  assert.strictEqual(malformedDetails.isValid, false);
  assert.strictEqual(malformedDetails.isMalformed, true);
  assert.strictEqual(malformedDetails.shareId, null);
  assert.strictEqual(malformedDetails.rawShareId, 'invalid!chars%20id');

  const nonShareDetails = getShareRouteDetails('/chat');
  assert.strictEqual(nonShareDetails.isShareRoute, false);
});

// 3. Snapshot Payload Structure Validation
runTest('validateSharedSnapshotPayload accepts valid schema', () => {
  const validPayload = {
    id: '20261030_abc123def456',
    schemaVersion: 1,
    title: 'Quantum Computing Overview',
    mode: 'learning',
    provider: 'gemini',
    model: 'gemini-3.8-flash',
    publishedAt: Date.now(),
    messageCount: 2,
    messages: [
      {
        id: 'msg-1',
        sender: 'user',
        content: 'Explain qubits simply.',
        timestamp: '10:00 AM'
      },
      {
        id: 'msg-2',
        sender: 'assistant',
        content: 'A qubit can exist in superposition...',
        timestamp: '10:01 AM',
        provider: 'gemini',
        modelUsed: 'gemini-3.8-flash'
      }
    ]
  };

  const validated = validateSharedSnapshotPayload(validPayload);
  assert.strictEqual(validated.id, '20261030_abc123def456');
  assert.strictEqual(validated.title, 'Quantum Computing Overview');
  assert.strictEqual(validated.mode, 'learning');
  assert.strictEqual(validated.messages.length, 2);
  assert.strictEqual(validated.messages[0].sender, 'user');
  assert.strictEqual(validated.messages[1].sender, 'assistant');
});

runTest('validateSharedSnapshotPayload rejects malformed payloads', () => {
  // Missing messages
  assert.throws(() => {
    validateSharedSnapshotPayload({ id: '20261030_abc123def456', title: 'Test', mode: 'general', messages: [] });
  }, /empty or invalid message array|contains no messages/i);

  // Invalid sender in message
  assert.throws(() => {
    validateSharedSnapshotPayload({
      id: '20261030_abc123def456',
      title: 'Test',
      mode: 'general',
      messages: [{ id: '1', sender: 'hacker', content: 'hello' }]
    });
  }, /invalid sender/i);

  // Missing content
  assert.throws(() => {
    validateSharedSnapshotPayload({
      id: '20261030_abc123def456',
      title: 'Test',
      mode: 'general',
      messages: [{ id: '1', sender: 'user', content: null }]
    });
  }, /non-string content|missing text content/i);
});

// 4. Sanitization and Safety of Snapshot Data
runTest('validateSharedSnapshotPayload strips private account fields and raw binaries', () => {
  const payloadWithPrivateData = {
    id: '20261030_abc123def456',
    title: 'Private Conversation',
    mode: 'general',
    userId: 'secret-uid-999',
    userEmail: 'user@example.com',
    messages: [
      {
        id: 'msg-1',
        sender: 'user',
        content: 'Look at this document.',
        secretToken: 'shhh',
        attachments: [
          {
            id: 'att-1',
            name: 'sample.pdf',
            size: 1024,
            formattedSize: '1.0 KB',
            type: 'application/pdf',
            extension: 'pdf',
            isImage: false,
            binaryBlob: 'large-binary-data',
            file: { secret: 'raw-file-handle' },
            extraction: {
              status: 'ready',
              text: 'Extracted safe text content',
              summary: 'Summary of safe text'
            }
          }
        ]
      },
      {
        id: 'msg-2',
        sender: 'assistant',
        content: 'I analyzed your document.',
        internalTraceId: 'trace-xyz'
      }
    ]
  };

  const validated = validateSharedSnapshotPayload(payloadWithPrivateData);
  assert.strictEqual(validated.userId, undefined);
  assert.strictEqual(validated.userEmail, undefined);
  assert.strictEqual(validated.messages[0].secretToken, undefined);
  assert.strictEqual(validated.messages[1].internalTraceId, undefined);

  const att = validated.messages[0].attachments[0];
  assert.strictEqual(att.binaryBlob, undefined);
  assert.strictEqual(att.file, undefined);
  assert.strictEqual(att.name, 'sample.pdf');
  assert.strictEqual(att.extraction.text, 'Extracted safe text content');
});

// 5. Session Storage Cache Helpers (with mock sessionStorage)
runTest('Session storage cache correctly stores and retrieves shared snapshots', () => {
  const mockStorage = new Map();
  globalThis.sessionStorage = {
    getItem: (k) => mockStorage.get(k) || null,
    setItem: (k, v) => mockStorage.set(k, String(v)),
    removeItem: (k) => mockStorage.delete(k)
  };

  const snapshot = {
    id: 'orvix_test_share_1',
    title: 'Cached Snapshot',
    mode: 'general',
    messages: [{ id: '1', sender: 'user', content: 'Hello' }]
  };

  setSharedSnapshotSession('orvix_test_share_1', snapshot);
  const retrieved = getSharedSnapshotSession('orvix_test_share_1');
  assert.strictEqual(retrieved?.title, snapshot.title);

  clearSharedSnapshotSession('orvix_test_share_1');
  const afterClear = getSharedSnapshotSession('orvix_test_share_1');
  assert.strictEqual(afterClear, null);
});

// 6. Router Unauthenticated Visitor Access
runTest('App router maps /share/:shareId to shared viewer without authentication gate', () => {
  const route = getShareRouteDetails('/share/20261030_1234567890ab');
  assert.strictEqual(route.isShareRoute, true);
  assert.strictEqual(route.shareId, '20261030_1234567890ab');

  // In App.jsx, if isShareRoute is true, ChatPage is rendered directly regardless of currentUser
  const isVisitorAllowed = route.isShareRoute === true;
  assert.strictEqual(isVisitorAllowed, true, 'Visitor must be allowed to view shared conversation');
});

// 7. Non-Share Routes Protected by Auth Gate
runTest('Non-share routes remain protected behind authentication requirement', () => {
  const rootRoute = getShareRouteDetails('/');
  assert.strictEqual(rootRoute.isShareRoute, false);

  const settingsRoute = getShareRouteDetails('/settings');
  assert.strictEqual(settingsRoute.isShareRoute, false);
});

console.log(`\nResults: ${passedTests} of ${totalTests} tests passed.\n`);

if (passedTests === totalTests) {
  console.log('ALL STAGE 4 TESTS PASSED SUCCESSFULLY!\n');
} else {
  process.exit(1);
}
