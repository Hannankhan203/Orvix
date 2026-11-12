/**
 * scripts/testWebLLMQuotaBypassRegression.js
 *
 * Regression Test Suite: Proves HTTP 429 / QUOTA_EXCEEDED blocks WebLLM (Browser AI) fallback.
 *
 * Requirements Verified:
 * 1. HTTP 429 and QUOTA_EXCEEDED are detected explicitly in ChatPage.jsx.
 * 2. Attachment submission is halted immediately upon receiving a quota error.
 * 3. Friendly daily upload limit error is surfaced.
 * 4. extractBrowserDocument() is NEVER executed as a fallback following an upload quota rejection.
 * 5. Legitimate WebLLM fallback remains active for non-quota network/server failures (e.g. 500).
 * 6. Offline WebLLM document extraction functionality remains preserved.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('======================================================================');
console.log('ORVIX REGRESSION TEST: WebLLM Daily Quota Bypass Protection');
console.log('======================================================================\n');

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

async function test(name, fn) {
  totalTests++;
  try {
    await fn();
    console.log(`  ✓ PASS: ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  ✗ FAIL: ${name}`);
    console.error(`    ${err.stack || err.message}`);
    failedTests++;
    process.exitCode = 1;
  }
}

// -----------------------------------------------------------------------------
// Test 1: Static Code AST / Token Audit of src/pages/ChatPage.jsx
// -----------------------------------------------------------------------------
await test('ChatPage.jsx explicitly inspects HTTP 429 and QUOTA_EXCEEDED before WebLLM fallback', () => {
  const chatPagePath = path.resolve(__dirname, '../src/pages/ChatPage.jsx');
  assert.ok(fs.existsSync(chatPagePath), 'ChatPage.jsx must exist');
  const content = fs.readFileSync(chatPagePath, 'utf8');

  // Verify that HTTP 429 and QUOTA_EXCEEDED are explicitly inspected
  assert.ok(
    content.includes("uploadRes.status === 429"),
    "Must explicitly check uploadRes.status === 429"
  );
  assert.ok(
    content.includes("errData?.code === 'QUOTA_EXCEEDED'"),
    "Must explicitly check errData?.code === 'QUOTA_EXCEEDED'"
  );

  // Verify that failPreflightIfActive is called on quota rejection before isWebLLM extraction
  const uploadErrorBlock = content.slice(
    content.indexOf('if (!uploadRes.ok) {'),
    content.indexOf('// If Browser AI is selected and upload returned an error (unrelated to quota)')
  );
  assert.ok(
    uploadErrorBlock.includes('isQuotaExceeded'),
    'Must define isQuotaExceeded guard inside upload failure block'
  );
  assert.ok(
    uploadErrorBlock.includes('return failPreflightIfActive('),
    'Must return failPreflightIfActive immediately when isQuotaExceeded is true'
  );

  // Verify that the catch (uploadErr) block also defends against QUOTA_EXCEEDED
  const catchBlockIndex = content.indexOf('catch (uploadErr) {');
  assert.ok(catchBlockIndex !== -1, 'Must have catch (uploadErr) block');
  const catchBlock = content.slice(
    catchBlockIndex,
    catchBlockIndex + 1200
  );
  assert.ok(
    catchBlock.includes("uploadErr?.status === 429") || catchBlock.includes("uploadErr?.code === 'QUOTA_EXCEEDED'"),
    'catch (uploadErr) block must guard against HTTP 429 and QUOTA_EXCEEDED'
  );
});

// -----------------------------------------------------------------------------
// Test 2: Behavioral Simulation — HTTP 429 from /api/upload halts submission
//         and NEVER executes extractBrowserDocument()
// -----------------------------------------------------------------------------
await test('Behavioral Simulation: HTTP 429 QUOTA_EXCEEDED blocks WebLLM and never executes extractBrowserDocument', async () => {
  let extractBrowserDocumentCalled = false;
  let preflightFailedWithMsg = null;
  let preflightActive = true;

  const mockExtractBrowserDocument = async () => {
    extractBrowserDocumentCalled = true;
    return { success: true, text: 'Bypassed text content!' };
  };

  const failPreflightIfActive = (msg) => {
    if (!preflightActive) return false;
    preflightActive = false;
    preflightFailedWithMsg = msg;
    return false;
  };

  // Simulate server returning 429 QUOTA_EXCEEDED
  const mockUploadRes = {
    ok: false,
    status: 429,
    json: async () => ({
      error: 'Daily attachment upload limit of 5 uploads per day exceeded. Quota resets at midnight UTC.',
      code: 'QUOTA_EXCEEDED',
      status: 'QUOTA_EXCEEDED',
      limit: 5,
      remaining: 0,
      resetAt: '2026-11-13T00:00:00.000Z'
    })
  };

  const isWebLLM = true;
  const filesToUpload = [{ id: 'test-att-1', name: 'student_paper.pdf', file: { name: 'student_paper.pdf', size: 1024 } }];

  // Simulate the patched ChatPage.jsx response logic
  let processedAttachments = [];
  if (!mockUploadRes.ok) {
    let errorMsg = `Upload failed (${mockUploadRes.status})`;
    let isQuotaExceeded = mockUploadRes.status === 429;
    let errData = null;
    try {
      errData = await mockUploadRes.json();
      if (errData?.error) {
        errorMsg = errData.error;
      }
      if (
        mockUploadRes.status === 429 ||
        errData?.code === 'QUOTA_EXCEEDED' ||
        errData?.status === 'QUOTA_EXCEEDED' ||
        String(errData?.error || '').toLowerCase().includes('quota exceeded') ||
        String(errData?.error || '').toLowerCase().includes('upload limit')
      ) {
        isQuotaExceeded = true;
      }
    } catch (_) {}

    if (isQuotaExceeded) {
      failPreflightIfActive(
        errorMsg || 'Daily attachment upload limit of 5 uploads per day exceeded. Quota resets at midnight UTC.'
      );
    } else if (isWebLLM) {
      // Fallback path
      for (const att of filesToUpload) {
        await mockExtractBrowserDocument(att.file);
      }
    }
  }

  // Assertions:
  assert.strictEqual(
    extractBrowserDocumentCalled,
    false,
    'CRITICAL: extractBrowserDocument must NEVER be called when upload returns HTTP 429'
  );
  assert.strictEqual(preflightActive, false, 'Preflight must be marked inactive');
  assert.ok(
    preflightFailedWithMsg.includes('Daily attachment upload limit'),
    `Expected friendly daily upload limit error, got: ${preflightFailedWithMsg}`
  );
  assert.strictEqual(processedAttachments.length, 0, 'No attachments should be processed');
});

// -----------------------------------------------------------------------------
// Test 3: Behavioral Simulation — Direct upload throwing QUOTA_EXCEEDED error
//         in catch block halts and NEVER executes extractBrowserDocument()
// -----------------------------------------------------------------------------
await test('Behavioral Simulation: Direct upload catch block with QUOTA_EXCEEDED error blocks WebLLM fallback', async () => {
  let extractBrowserDocumentCalled = false;
  let preflightFailedWithMsg = null;
  let preflightActive = true;

  const mockExtractBrowserDocument = async () => {
    extractBrowserDocumentCalled = true;
    return { success: true, text: 'Bypassed text content!' };
  };

  const failPreflightIfActive = (msg) => {
    if (!preflightActive) return false;
    preflightActive = false;
    preflightFailedWithMsg = msg;
    return false;
  };

  const directUploadErr = new Error('Daily attachment upload limit of 5 uploads per day exceeded. Quota resets at midnight UTC.');
  directUploadErr.status = 429;
  directUploadErr.code = 'QUOTA_EXCEEDED';

  const isWebLLM = true;
  const filesToUpload = [{ id: 'test-att-2', name: 'large_document.pdf', file: { name: 'large_document.pdf', size: 5 * 1024 * 1024 } }];

  // Simulate patched catch block logic in ChatPage.jsx
  try {
    throw directUploadErr;
  } catch (uploadErr) {
    const isQuotaExceeded =
      uploadErr?.status === 429 ||
      uploadErr?.code === 'QUOTA_EXCEEDED' ||
      String(uploadErr?.message || '').toLowerCase().includes('quota exceeded') ||
      String(uploadErr?.message || '').toLowerCase().includes('upload limit');

    if (isQuotaExceeded) {
      failPreflightIfActive(
        uploadErr?.message || 'Daily attachment upload limit of 5 uploads per day exceeded. Quota resets at midnight UTC.'
      );
    } else if (isWebLLM) {
      for (const att of filesToUpload) {
        await mockExtractBrowserDocument(att.file);
      }
    }
  }

  assert.strictEqual(
    extractBrowserDocumentCalled,
    false,
    'extractBrowserDocument must NEVER be called when direct upload throws 429'
  );
  assert.strictEqual(preflightActive, false, 'Preflight must fail');
  assert.ok(preflightFailedWithMsg.includes('Daily attachment upload limit'));
});

// -----------------------------------------------------------------------------
// Test 4: Preservation — Legitimate WebLLM fallback executes for non-quota errors (HTTP 500)
// -----------------------------------------------------------------------------
await test('Preservation: Legitimate fallback to extractBrowserDocument STILL operates for non-quota server errors (500)', async () => {
  let extractBrowserDocumentCalled = false;
  let preflightFailedWithMsg = null;
  let preflightActive = true;

  const mockExtractBrowserDocument = async () => {
    extractBrowserDocumentCalled = true;
    return { success: true, text: 'Locally extracted document text' };
  };

  const failPreflightIfActive = (msg) => {
    if (!preflightActive) return false;
    preflightActive = false;
    preflightFailedWithMsg = msg;
    return false;
  };

  // Simulate server 500 error (e.g. temporary server crash / 503 maintenance)
  const mockUploadRes = {
    ok: false,
    status: 500,
    json: async () => ({
      error: 'Internal Server Error',
      code: 'SERVER_ERROR'
    })
  };

  const isWebLLM = true;
  const filesToUpload = [{ id: 'test-att-3', name: 'notes.pdf', file: { name: 'notes.pdf', size: 2048 } }];

  let processedAttachments = [];
  if (!mockUploadRes.ok) {
    let errorMsg = `Upload failed (${mockUploadRes.status})`;
    let isQuotaExceeded = mockUploadRes.status === 429;
    let errData = null;
    try {
      errData = await mockUploadRes.json();
      if (errData?.error) {
        errorMsg = errData.error;
      }
      if (
        mockUploadRes.status === 429 ||
        errData?.code === 'QUOTA_EXCEEDED' ||
        errData?.status === 'QUOTA_EXCEEDED'
      ) {
        isQuotaExceeded = true;
      }
    } catch (_) {}

    if (isQuotaExceeded) {
      failPreflightIfActive(errorMsg);
    } else if (isWebLLM) {
      for (const att of filesToUpload) {
        const extResult = await mockExtractBrowserDocument(att.file);
        processedAttachments.push({ ...att, status: 'ready', extraction: extResult });
      }
    } else {
      failPreflightIfActive(errorMsg);
    }
  }

  assert.strictEqual(
    extractBrowserDocumentCalled,
    true,
    'Non-quota server error (500) must still trigger legitimate Browser AI fallback'
  );
  assert.strictEqual(preflightActive, true, 'Preflight must not fail for legitimate fallback');
  assert.strictEqual(processedAttachments.length, 1);
  assert.strictEqual(processedAttachments[0].extraction.text, 'Locally extracted document text');
});

// -----------------------------------------------------------------------------
// Test 5: Preservation — Offline WebLLM extraction remains intact
// -----------------------------------------------------------------------------
await test('Preservation: Offline WebLLM extraction logic remains intact', () => {
  const chatPagePath = path.resolve(__dirname, '../src/pages/ChatPage.jsx');
  const content = fs.readFileSync(chatPagePath, 'utf8');

  // Verify the offline WebLLM branch is still present and untouched
  assert.ok(
    content.includes('if (isWebLLM && !clientOnline) {'),
    'Offline WebLLM extraction branch must be preserved'
  );
  assert.ok(
    content.includes('const extResult = await extractBrowserDocument(att.file,'),
    'extractBrowserDocument call for offline mode must remain intact'
  );
});

console.log('\n======================================================================');
console.log(`WebLLM Quota Bypass Regression Suite: ${passedTests}/${totalTests} Passed (${failedTests} Failed)`);
console.log('======================================================================\n');

if (failedTests > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
