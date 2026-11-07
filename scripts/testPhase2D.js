/**
 * ORVIX Phase 2D: Frontend Error Handling & Composer Quota UX Suite
 *
 * Validates the core Phase 2D requirements:
 * 1. Handle DAILY_LIMIT_EXCEEDED (HTTP 429) with clear daily-limit guidance.
 * 2. Handle QUOTA_STORAGE_UNAVAILABLE (HTTP 503) with clear temporary-unavailability message.
 * 3. Handle authentication failures (HTTP 401) and other upload errors gracefully.
 * 4. Remove rejected attachments from composer tray without locking or breaking the composer.
 * 5. Prevent automatic retries that could duplicate uploads or quota reservations (retryable: false, canFallback: false).
 * 6. Preserve existing drag-and-drop, paste, file-picker, one-attachment-per-message, and 25 MB limit behavior.
 * 7. Do not affect offline WebLLM uploads (safe browser-local path preserved).
 * 8. Keep quota enforcement exclusively on backend; no frontend quota tracking.
 *
 * Run with: node scripts/testPhase2D.js
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

process.env.TESTING = 'true';

// Import services and helpers
import {
  STANDARD_ERROR_CODES,
  ERROR_CATEGORIES,
  normalizeAIError
} from '../src/services/errorNormalizationService.js';

import { parseRouterError } from '../src/services/aiRouter.js';

console.log('------------------------------------------------------------');
console.log('ORVIX Phase 2D: Frontend Error Handling Verification Suite');
console.log('------------------------------------------------------------\n');

let passedTests = 0;
let totalTests = 0;

function runTest(name, fn) {
  totalTests++;
  try {
    fn();
    console.log(`[PASS] ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`[FAIL] ${name}:`, err.message);
    throw err;
  }
}

// -------------------------------------------------------------
// Test 1: DAILY_LIMIT_EXCEEDED (HTTP 429) Error Message & Normalization
// -------------------------------------------------------------
runTest('1. DAILY_LIMIT_EXCEEDED (HTTP 429) classification and message formatting', () => {
  assert.ok(STANDARD_ERROR_CODES.DAILY_LIMIT_EXCEEDED, 'DAILY_LIMIT_EXCEEDED should exist in STANDARD_ERROR_CODES');

  const normalized = normalizeAIError({
    status: 429,
    code: 'DAILY_LIMIT_EXCEEDED',
    message: 'Daily attachment limit reached. You can upload a maximum of 5 PDFs and images per UTC day.'
  });

  assert.equal(normalized.code, STANDARD_ERROR_CODES.DAILY_LIMIT_EXCEEDED);
  assert.equal(normalized.httpStatus, 429);
  assert.equal(normalized.retryable, false, 'Daily quota limit must never be auto-retryable');
  assert.equal(normalized.canFallback, false, 'Daily quota limit must never trigger provider fallback');
  assert.equal(normalized.category, ERROR_CATEGORIES.TIMEOUTS_AND_RESOURCE_LIMITS);
  assert.ok(
    normalized.message.includes('5 PDFs and images') ||
    normalized.message.includes('Daily attachment limit reached'),
    'Should contain clear daily limit explanation'
  );
});

// -------------------------------------------------------------
// Test 2: QUOTA_STORAGE_UNAVAILABLE (HTTP 503) Error Message & Normalization
// -------------------------------------------------------------
runTest('2. QUOTA_STORAGE_UNAVAILABLE (HTTP 503) classification and message formatting', () => {
  assert.ok(STANDARD_ERROR_CODES.QUOTA_STORAGE_UNAVAILABLE, 'QUOTA_STORAGE_UNAVAILABLE should exist in STANDARD_ERROR_CODES');

  const normalized = normalizeAIError({
    status: 503,
    code: 'QUOTA_STORAGE_UNAVAILABLE',
    message: 'Distributed quota storage is unavailable in production. Quota-tracked attachments (PDF and images) cannot be processed.'
  });

  assert.equal(normalized.code, STANDARD_ERROR_CODES.QUOTA_STORAGE_UNAVAILABLE);
  assert.equal(normalized.httpStatus, 503);
  assert.equal(normalized.retryable, false, 'Storage maintenance error must never auto-retry');
  assert.equal(normalized.canFallback, false, 'Storage maintenance error must never trigger fallback');
  assert.equal(normalized.category, ERROR_CATEGORIES.TIMEOUTS_AND_RESOURCE_LIMITS);
  assert.ok(
    normalized.message.includes('temporarily unavailable') ||
    normalized.message.includes('server storage maintenance'),
    'Should contain clear temporary maintenance message'
  );
});

// -------------------------------------------------------------
// Test 3: parseRouterError strictly disables retries and fallbacks on quota errors
// -------------------------------------------------------------
runTest('3. parseRouterError prevents automatic retries and fallbacks for quota errors', () => {
  // Test DAILY_LIMIT_EXCEEDED
  const err429 = parseRouterError({
    status: 429,
    errorCode: 'DAILY_LIMIT_EXCEEDED',
    message: 'Daily limit exceeded'
  });
  assert.equal(err429.retryable, false, 'DAILY_LIMIT_EXCEEDED must not be retryable');
  assert.equal(err429.canFallback, false, 'DAILY_LIMIT_EXCEEDED must not allow fallback');

  // Test QUOTA_STORAGE_UNAVAILABLE
  const err503 = parseRouterError({
    status: 503,
    errorCode: 'QUOTA_STORAGE_UNAVAILABLE',
    message: 'Storage unavailable'
  });
  assert.equal(err503.retryable, false, 'QUOTA_STORAGE_UNAVAILABLE must not be retryable');
  assert.equal(err503.canFallback, false, 'QUOTA_STORAGE_UNAVAILABLE must not allow fallback');
});

// -------------------------------------------------------------
// Test 4: Authentication Error Normalization (HTTP 401 / AUTHENTICATION_REQUIRED)
// -------------------------------------------------------------
runTest('4. Authentication failure (HTTP 401) handling and message formatting', () => {
  const normalized = normalizeAIError({
    status: 401,
    code: 'AUTHENTICATION_REQUIRED',
    message: 'Authentication required: Please provide a valid Authorization Bearer token or guest session ID.'
  });

  assert.equal(normalized.httpStatus, 401);
  assert.equal(normalized.retryable, false, 'Auth failures must never auto-retry');
});

// -------------------------------------------------------------
// Test 5: Composer Tray Attachment Removal Contract in ChatArea
// -------------------------------------------------------------
runTest('5. ChatArea composer removes rejected attachments on preflight failure without restoration', () => {
  const chatAreaPath = path.join(__dirname, '../src/components/chat/ChatArea.jsx');
  const chatAreaCode = fs.readFileSync(chatAreaPath, 'utf8');

  // Verify that setAttachments([]) is called at submission start
  assert.ok(
    chatAreaCode.includes('setAttachments([])'),
    'ChatArea must clear attachments tray at submit start'
  );

  // Verify that on failure, attachments are NOT restored to previous state
  assert.ok(
    !chatAreaCode.includes('setAttachments((prev) => (prev.length === 0 ? currentAttachments : prev))'),
    'ChatArea must not restore rejected attachments on onSubmit failure'
  );

  // Verify that previewing attachment is cleared
  assert.ok(
    chatAreaCode.includes('setPreviewingComposerAttachment(null)'),
    'ChatArea must close attachment preview on submission'
  );
});

// -------------------------------------------------------------
// Test 6: Input Prompt Preservation in ChatPage
// -------------------------------------------------------------
runTest('6. ChatPage preserves inputValue on upload/preflight error', () => {
  const chatPagePath = path.join(__dirname, '../src/pages/ChatPage.jsx');
  const chatPageCode = fs.readFileSync(chatPagePath, 'utf8');

  // Look for setInputValue('') in ChatPage
  const clearInputMatches = [...chatPageCode.matchAll(/setInputValue\(['"]\s*['"]\)/g)];
  assert.ok(clearInputMatches.length > 0, 'ChatPage must contain setInputValue("")');

  // In ChatPage, setInputValue('') only occurs after preflight succeeds and messages are committed
  // Verify failPreflightIfActive does NOT call setInputValue('')
  const failPreflightIndex = chatPageCode.indexOf('const failPreflightIfActive =');
  const failPreflightEnd = chatPageCode.indexOf('return false;\n    };', failPreflightIndex);
  const failPreflightBlock = chatPageCode.slice(failPreflightIndex, failPreflightEnd);

  assert.ok(
    !failPreflightBlock.includes('setInputValue'),
    'failPreflightIfActive must NOT clear inputValue so user input is preserved'
  );
  assert.ok(
    failPreflightBlock.includes('setLoadingAndSubmitting(false)'),
    'failPreflightIfActive must unlock the composer'
  );
});

// -------------------------------------------------------------
// Test 7: ChatPage Upload Error Handler Mapping
// -------------------------------------------------------------
runTest('7. ChatPage upload handler maps 429, 503, and 401 to clear messages', () => {
  const chatPagePath = path.join(__dirname, '../src/pages/ChatPage.jsx');
  const chatPageCode = fs.readFileSync(chatPagePath, 'utf8');

  // Verify detection of DAILY_LIMIT_EXCEEDED
  assert.ok(
    chatPageCode.includes('errorCode === \'DAILY_LIMIT_EXCEEDED\' || uploadRes.status === 429'),
    'ChatPage must identify 429 or DAILY_LIMIT_EXCEEDED'
  );

  // Verify detection of QUOTA_STORAGE_UNAVAILABLE
  assert.ok(
    chatPageCode.includes('errorCode === \'QUOTA_STORAGE_UNAVAILABLE\' || uploadRes.status === 503'),
    'ChatPage must identify 503 or QUOTA_STORAGE_UNAVAILABLE'
  );

  // Verify detection of auth errors
  assert.ok(
    chatPageCode.includes('uploadRes.status === 401'),
    'ChatPage must identify 401 auth errors'
  );

  // Verify WebLLM does not bypass quota limit or storage unavailability
  assert.ok(
    chatPageCode.includes('isWebLLM && !isDailyLimit && !isQuotaUnavailable'),
    'WebLLM local extraction must never bypass quota limit or storage safety rejections'
  );
});

// -------------------------------------------------------------
// Test 8: Single Attachment & 25MB Limit Verification
// -------------------------------------------------------------
runTest('8. Single attachment and 25MB limits are preserved in frontend', () => {
  const chatAreaPath = path.join(__dirname, '../src/components/chat/ChatArea.jsx');
  const chatAreaCode = fs.readFileSync(chatAreaPath, 'utf8');

  // Check 25MB limit in ChatArea
  assert.ok(
    chatAreaCode.includes('25 * 1024 * 1024'),
    'ChatArea must preserve 25MB file size limit'
  );

  // Check 1 attachment limit notice in ChatArea
  assert.ok(
    chatAreaCode.includes('Only one attachment can be added per message'),
    'ChatArea must preserve single attachment rule'
  );

  const chatPagePath = path.join(__dirname, '../src/pages/ChatPage.jsx');
  const chatPageCode = fs.readFileSync(chatPagePath, 'utf8');

  // Check ChatPage preflight 25MB and 1 attachment checks
  assert.ok(
    chatPageCode.includes('attachments.length > 1'),
    'ChatPage must reject multiple attachments'
  );
  assert.ok(
    chatPageCode.includes('MAX_PER_FILE_BYTES = 25 * 1024 * 1024'),
    'ChatPage preflight must enforce 25MB limit'
  );
});

// -------------------------------------------------------------
// Test 9: Offline WebLLM Upload Isolation
// -------------------------------------------------------------
runTest('9. Offline WebLLM uploads remain unaffected and bypass server quota', () => {
  const chatPagePath = path.join(__dirname, '../src/pages/ChatPage.jsx');
  const chatPageCode = fs.readFileSync(chatPagePath, 'utf8');

  assert.ok(
    chatPageCode.includes('if (isWebLLM && !clientOnline)'),
    'ChatPage must maintain browser-local offline path for WebLLM'
  );

  // In the offline path, it calls extractBrowserDocument, not fetch('/api/upload')
  const offlineWebLLMBlockStart = chatPageCode.indexOf('if (isWebLLM && !clientOnline)');
  const onlineUploadBlockStart = chatPageCode.indexOf('// Online upload path (or cloud provider)', offlineWebLLMBlockStart);
  const offlineBlock = chatPageCode.slice(offlineWebLLMBlockStart, onlineUploadBlockStart);

  assert.ok(
    !offlineBlock.includes('fetch(\'/api/upload\''),
    'Offline WebLLM path must never call server /api/upload'
  );
  assert.ok(
    offlineBlock.includes('extractBrowserDocument'),
    'Offline WebLLM path must use extractBrowserDocument'
  );
});

// -------------------------------------------------------------
// Test 10: Backend-Exclusive Quota Enforcement (No frontend tracking)
// -------------------------------------------------------------
runTest('10. Quota enforcement is strictly backend-exclusive with no frontend quota state', () => {
  const chatPagePath = path.join(__dirname, '../src/pages/ChatPage.jsx');
  const chatPageCode = fs.readFileSync(chatPagePath, 'utf8');
  const chatAreaPath = path.join(__dirname, '../src/components/chat/ChatArea.jsx');
  const chatAreaCode = fs.readFileSync(chatAreaPath, 'utf8');

  // Ensure neither file maintains a local quota counter (e.g. dailyCount, quotaUsed, remainingQuota state)
  assert.ok(
    !chatPageCode.includes('useState(0)') || !chatPageCode.includes('dailyQuotaCount'),
    'ChatPage must not track daily quota count state'
  );
  assert.ok(
    !chatAreaCode.includes('dailyQuotaCount'),
    'ChatArea must not track daily quota count state'
  );
  assert.ok(
    !chatPageCode.includes('localStorage.setItem(\'quota') &&
    !chatPageCode.includes('sessionStorage.setItem(\'quota'),
    'Frontend must not store local quota counters in storage'
  );
});

console.log('\n============================================================');
console.log(`Phase 2D Verification Complete: ${passedTests}/${totalTests} tests passed.`);
console.log('============================================================\n');
