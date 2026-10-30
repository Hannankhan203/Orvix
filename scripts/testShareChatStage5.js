/**
 * scripts/testShareChatStage5.js
 * Comprehensive verification test suite for Orvix Share Chat Stage 5:
 * Authenticated Shared Chat Viewing & Permissions
 */

import assert from 'node:assert';
import {
  isValidShareId,
  parseSharePath,
  getShareRouteDetails,
  isEligibleShareUser,
  isAuthenticatedSharedPreview,
  getSharedPreviewActionPermissions,
  createSharedPreviewState,
  evaluateShareEligibility,
  validateSharedSnapshotPayload
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
console.log('Orvix Share Chat Stage 5 — Verification Test Suite');
console.log('======================================================\n');

// 1. Account Eligibility Validation
runTest('1. isEligibleShareUser correctly classifies real non-anonymous Firebase accounts', () => {
  const realUser = {
    uid: 'firebase_user_abc123',
    email: 'user@example.com',
    isAnonymous: false
  };
  assert.strictEqual(isEligibleShareUser(realUser), true);

  const realUserWithoutFlag = {
    uid: 'firebase_user_xyz789',
    displayName: 'Orvix User'
  };
  assert.strictEqual(isEligibleShareUser(realUserWithoutFlag), true);
});

runTest('2. isEligibleShareUser rejects null, undefined, guest, and anonymous sessions', () => {
  assert.strictEqual(isEligibleShareUser(null), false);
  assert.strictEqual(isEligibleShareUser(undefined), false);
  assert.strictEqual(isEligibleShareUser({}), false);
  assert.strictEqual(isEligibleShareUser({ uid: '' }), false);
  assert.strictEqual(isEligibleShareUser({ uid: '   ' }), false);

  // Anonymous user
  assert.strictEqual(isEligibleShareUser({ uid: 'anon_123', isAnonymous: true }), false);

  // Guest demo sessions
  assert.strictEqual(isEligibleShareUser({ uid: 'guest-1730000000000' }), false);
  assert.strictEqual(isEligibleShareUser({ uid: 'guest-temp-user' }), false);
});

// 2. Authenticated Preview Route Detection
runTest('3. isAuthenticatedSharedPreview verifies both route and real authentication', () => {
  const realUser = { uid: 'user_123', email: 'user@example.com' };
  const anonUser = { uid: 'anon_456', isAnonymous: true };

  // On share route with real user -> true
  assert.strictEqual(isAuthenticatedSharedPreview({ isShareRoute: true, user: realUser }), true);

  // On share route with unauthenticated visitor -> false
  assert.strictEqual(isAuthenticatedSharedPreview({ isShareRoute: true, user: null }), false);

  // On share route with anonymous visitor -> false
  assert.strictEqual(isAuthenticatedSharedPreview({ isShareRoute: true, user: anonUser }), false);

  // Not on share route -> false regardless of user
  assert.strictEqual(isAuthenticatedSharedPreview({ isShareRoute: false, user: realUser }), false);
  assert.strictEqual(isAuthenticatedSharedPreview({ isShareRoute: false, user: null }), false);
});

// 3. Centralized Action Permissions Matrix
runTest('4. getSharedPreviewActionPermissions preserves Prompt 4 unauthenticated public viewer', () => {
  const perms = getSharedPreviewActionPermissions({
    isShareRoute: true,
    user: null
  });

  // Reading allowed
  assert.strictEqual(perms.canReadOriginal, true);
  assert.strictEqual(perms.canCopy, true);
  assert.strictEqual(perms.canReadAloud, true);

  // Messaging disabled
  assert.strictEqual(perms.canType, false);
  assert.strictEqual(perms.canSubmitFirstMessage, false);
  assert.strictEqual(perms.canAttach, false);
  assert.strictEqual(perms.canDictate, false);
  assert.strictEqual(perms.canDragDrop, false);
  assert.strictEqual(perms.canPasteFile, false);

  // Modification disabled
  assert.strictEqual(perms.canEditOriginal, false);
  assert.strictEqual(perms.canRegenerateOriginal, false);
  assert.strictEqual(perms.canRegenerateAlternative, false);
  assert.strictEqual(perms.canShareChat, false);
  assert.strictEqual(perms.canPin, false);
  assert.strictEqual(perms.canDelete, false);
  assert.strictEqual(perms.canNewChat, true);
  assert.strictEqual(perms.isHistoryCreated, false);
  assert.strictEqual(perms.isPublicSharedViewer, true);
  assert.strictEqual(perms.isAuthenticatedSharedPreview, false);
});

runTest('5. getSharedPreviewActionPermissions enables typing for authenticated previewer', () => {
  const realUser = { uid: 'real_user_456', email: 'tester@orvix.ai' };
  const perms = getSharedPreviewActionPermissions({
    isShareRoute: true,
    user: realUser,
    hasSentFirstMessage: false
  });

  // Reading allowed
  assert.strictEqual(perms.canReadOriginal, true);
  assert.strictEqual(perms.canCopy, true);
  assert.strictEqual(perms.canReadAloud, true);

  // Typing & First message submission ENABLED
  assert.strictEqual(perms.canType, true);
  assert.strictEqual(perms.canSubmitFirstMessage, true);

  // Attachments, microphone, drag-and-drop, and file paste remain disabled
  assert.strictEqual(perms.canAttach, false);
  assert.strictEqual(perms.canDictate, false);
  assert.strictEqual(perms.canDragDrop, false);
  assert.strictEqual(perms.canPasteFile, false);

  // Original snapshot modifications strictly DISABLED
  assert.strictEqual(perms.canEditOriginal, false);
  assert.strictEqual(perms.canRegenerateOriginal, false);
  assert.strictEqual(perms.canRegenerateAlternative, false);
  assert.strictEqual(perms.canShareChat, false);
  assert.strictEqual(perms.canPin, false);
  assert.strictEqual(perms.canDelete, false);
  assert.strictEqual(perms.canNewChat, true);

  // Prompt 5 isolation guarantees
  assert.strictEqual(perms.isHistoryCreated, false);
  assert.strictEqual(perms.isPublicSharedViewer, false);
  assert.strictEqual(perms.isAuthenticatedSharedPreview, true);
});

runTest('6. getSharedPreviewActionPermissions for normal conversation view outside shared route', () => {
  const realUser = { uid: 'real_user_456', email: 'tester@orvix.ai' };
  const perms = getSharedPreviewActionPermissions({
    isShareRoute: false,
    user: realUser
  });

  assert.strictEqual(perms.canType, true);
  assert.strictEqual(perms.canAttach, true);
  assert.strictEqual(perms.canDictate, true);
  assert.strictEqual(perms.canEditOriginal, true);
  assert.strictEqual(perms.canRegenerateOriginal, true);
  assert.strictEqual(perms.canRegenerateAlternative, true);
  assert.strictEqual(perms.canPin, true);
  assert.strictEqual(perms.canDelete, true);
  assert.strictEqual(perms.isSharedPreview, false);
});

// 4. Centralized Shared Preview State Machine
runTest('7. createSharedPreviewState initializes consistent state machine', () => {
  const realUser = { uid: 'auth_usr_777' };
  const previewState = createSharedPreviewState({
    isShareRoute: true,
    user: realUser,
    hasSentFirstMessage: false,
    isSubmitting: false,
    hasFailed: false
  });

  assert.strictEqual(previewState.isSharedPreview, true);
  assert.strictEqual(previewState.isAuthenticatedSharedPreview, true);
  assert.strictEqual(previewState.isPublicSharedViewer, false);
  assert.strictEqual(previewState.hasSentFirstMessage, false);
  assert.strictEqual(previewState.isSubmitting, false);
  assert.strictEqual(previewState.hasFailed, false);
  assert.strictEqual(previewState.submissionState, 'idle');
  assert.strictEqual(previewState.permissions.canType, true);
  assert.strictEqual(previewState.permissions.canAttach, false);
  assert.strictEqual(previewState.permissions.canRegenerateOriginal, false);
});

runTest('8. createSharedPreviewState reflects submitting, failure, and completion transitions', () => {
  const realUser = { uid: 'auth_usr_777' };

  // Submitting state
  const submittingState = createSharedPreviewState({
    isShareRoute: true,
    user: realUser,
    hasSentFirstMessage: true,
    isSubmitting: true,
    hasFailed: false
  });
  assert.strictEqual(submittingState.isSubmitting, true);
  assert.strictEqual(submittingState.submissionState, 'submitting');

  // Failed state
  const failedState = createSharedPreviewState({
    isShareRoute: true,
    user: realUser,
    hasSentFirstMessage: true,
    isSubmitting: false,
    hasFailed: true
  });
  assert.strictEqual(failedState.hasFailed, true);
  assert.strictEqual(failedState.submissionState, 'failed');

  // Complete state
  const completeState = createSharedPreviewState({
    isShareRoute: true,
    user: realUser,
    hasSentFirstMessage: true,
    isSubmitting: false,
    hasFailed: false
  });
  assert.strictEqual(completeState.submissionState, 'complete');
});

// 5. Evaluate Share Eligibility in Shared View
runTest('9. evaluateShareEligibility blocks re-sharing during shared preview', () => {
  const realUser = { uid: 'real_user_123', email: 'user@example.com' };
  const mockChat = { id: 'shared-preview-123', title: 'Shared Chat' };
  const mockMessages = [
    { id: 'msg1', sender: 'user', content: 'Hello' },
    { id: 'msg2', sender: 'assistant', content: 'Hi there' }
  ];

  const eligibility = evaluateShareEligibility({
    user: realUser,
    chat: mockChat,
    messages: mockMessages,
    isLoading: false,
    isSharedPreview: true
  });

  assert.strictEqual(eligibility.eligible, false);
  assert.strictEqual(eligibility.reason, 'Shared conversation previews cannot be re-shared until imported into your account.');
});

// 6. Snapshot Payload and Immutability Safeguards
runTest('10. Original shared snapshot payload remains strictly valid and immutable', () => {
  const originalSnapshot = {
    id: '20261030_stage5test0001',
    schemaVersion: 1,
    title: 'Stage 5 Snapshot',
    mode: 'general',
    messageCount: 2,
    byteSize: 512,
    createdAt: new Date().toISOString(),
    messages: [
      { id: 'm1', sender: 'user', content: 'Original prompt' },
      { id: 'm2', sender: 'assistant', content: 'Original response' }
    ]
  };

  const validated = validateSharedSnapshotPayload(originalSnapshot);
  assert.strictEqual(validated.id, '20261030_stage5test0001');
  assert.strictEqual(validated.messages.length, 2);
  assert.strictEqual(validated.messages[0].content, 'Original prompt');
  assert.strictEqual(validated.messages[1].content, 'Original response');

  // Snapshot has no user-specific ownership or mutable foreign keys
  assert.strictEqual(validated.importedFromShareId, undefined);
  assert.strictEqual(validated.isImported, undefined);
});

// 7. Route string and parser details
runTest('11. parseSharePath and getShareRouteDetails correctly handle /share/{shareId}', () => {
  const path = '/share/20261030_stage5test0001';
  const shareId = parseSharePath(path);
  assert.strictEqual(shareId, '20261030_stage5test0001');
  assert.strictEqual(isValidShareId(shareId), true);

  const routeDetails = getShareRouteDetails(path);
  assert.strictEqual(routeDetails.isShareRoute, true);
  assert.strictEqual(routeDetails.isValid, true);
  assert.strictEqual(routeDetails.shareId, '20261030_stage5test0001');
});

// Summary
console.log('\n------------------------------------------------------');
console.log(`Test Execution Summary: ${passedTests}/${totalTests} tests passed.`);
console.log('------------------------------------------------------\n');

if (passedTests !== totalTests) {
  process.exit(1);
} else {
  console.log('All Orvix Share Chat Stage 5 tests PASSED cleanly.\n');
}
