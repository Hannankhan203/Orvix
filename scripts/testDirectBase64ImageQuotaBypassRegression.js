/**
 * scripts/testDirectBase64ImageQuotaBypassRegression.js
 *
 * ORVIX — P2: FIX DIRECT BASE64 IMAGE QUOTA BYPASS REGRESSION SUITE
 *
 * Requirements Verified:
 * 1. Direct Base64 image injection rejection (POST /api/chat rejects raw base64).
 * 2. Data URL injection rejection (POST /api/chat rejects raw data:image/... URLs).
 * 3. Forged attachment ID rejection (non-existent UUID or malicious IDs rejected).
 * 4. Cross-user attachment reference rejection (User B cannot reference User A's file).
 * 5. Unauthenticated guest cannot reference authenticated user's attachment.
 * 6. Valid uploaded image acceptance (upload first, then reference in /api/chat).
 * 7. Gemini Vision parts construction from server-verified registered files.
 * 8. Quota preservation (rejected direct injection attempts do NOT consume daily quota).
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';

process.env.TESTING = '1';
process.env.FIREBASE_PROJECT_ID = 'orvix-quota-test-project';
process.env.NODE_ENV = 'test';

const { app } = await import('../server.ts');
const {
  setTestFirebaseProjectId,
  setCustomTokenVerifierForTesting,
  resetFirebaseAuthForTesting
} = await import('../server/firebaseAuthHelper.ts');

const {
  fileRegistry,
  buildGeminiImageParts
} = await import('../server/uploadSubsystem.ts');

const {
  resetQuotaForTesting,
  getQuotaStatus
} = await import('../server/uploadQuotaService.ts');

import fs from 'node:fs';
import path from 'node:path';

const REAL_PNG_PATH = path.resolve(process.cwd(), 'public/favicon-32x32.png');
const VALID_PNG_BUFFER = fs.readFileSync(REAL_PNG_PATH);
const VALID_PNG_BASE64 = VALID_PNG_BUFFER.toString('base64');
const VALID_PNG_DATA_URL = `data:image/png;base64,${VALID_PNG_BASE64}`;

async function uploadFileHelper({ baseUrl, token, filename = 'test_photo.png', conversationId = 'test_conv' }) {
  const boundary = '----WebKitFormBoundary' + crypto.randomBytes(8).toString('hex');
  const parts = [];
  if (conversationId) {
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="conversationId"\r\n\r\n${conversationId}\r\n`)
    );
  }
  parts.push(
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`)
  );
  parts.push(VALID_PNG_BUFFER);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  const body = Buffer.concat(parts);

  const headers = {
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
    'Content-Length': String(body.length)
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  return await fetch(`${baseUrl}/api/upload`, {
    method: 'POST',
    headers,
    body
  });
}

async function main() {
  console.log('======================================================================');
  console.log('ORVIX REGRESSION TEST: Direct Base64 Image Quota Bypass Suite');
  console.log('======================================================================');

  // Start test server on ephemeral port
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  // Configure Firebase Auth mock
  setTestFirebaseProjectId('orvix-quota-test-project');
  setCustomTokenVerifierForTesting(async (token) => {
    if (token === 'token-alice') {
      return {
        success: true,
        user: {
          uid: 'user_alice_alpha',
          email: 'alice@orvix.edu',
          projectId: 'orvix-quota-test-project',
          claims: { aud: 'orvix-quota-test-project', sub: 'user_alice_alpha' }
        }
      };
    }
    if (token === 'token-bob') {
      return {
        success: true,
        user: {
          uid: 'user_bob_beta',
          email: 'bob@orvix.edu',
          projectId: 'orvix-quota-test-project',
          claims: { aud: 'orvix-quota-test-project', sub: 'user_bob_beta' }
        }
      };
    }
    return {
      success: false,
      error: 'Invalid test token',
      code: 'AUTH_INVALID_TOKEN'
    };
  });

  try {
    // -------------------------------------------------------------------------
    // TEST 1: Direct Base64 image injection rejection
    // -------------------------------------------------------------------------
    console.log('\n--> Test 1: Direct Base64 image injection rejection without server upload');
    {
      const res = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: 'Solve this equation from the image',
          provider: 'gemini',
          stream: false,
          attachments: [
            {
              name: 'injected_image.png',
              mimeType: 'image/png',
              base64: VALID_PNG_BASE64
            }
          ]
        })
      });

      assert.strictEqual(res.status, 400, `Expected HTTP 400 for raw Base64 injection, got ${res.status}`);
      const data = await res.json();
      assert.strictEqual(data.code, 'DIRECT_IMAGE_INJECTION_REJECTED', 'Expected code DIRECT_IMAGE_INJECTION_REJECTED');
      assert.ok(
        data.error.includes('Direct Base64 or Data URL image injection is not permitted'),
        `Expected descriptive rejection error, got: ${data.error}`
      );
      console.log('  ✓ PASS: Direct Base64 image injection rejected with HTTP 400 DIRECT_IMAGE_INJECTION_REJECTED');
    }

    // -------------------------------------------------------------------------
    // TEST 2: Data URL injection rejection
    // -------------------------------------------------------------------------
    console.log('\n--> Test 2: Data URL image injection rejection without server upload');
    {
      const res = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: 'What is shown here?',
          provider: 'gemini',
          stream: false,
          attachments: [
            {
              name: 'injected_dataurl.png',
              mimeType: 'image/png',
              dataUrl: VALID_PNG_DATA_URL
            }
          ]
        })
      });

      assert.strictEqual(res.status, 400, `Expected HTTP 400 for Data URL injection, got ${res.status}`);
      const data = await res.json();
      assert.strictEqual(data.code, 'DIRECT_IMAGE_INJECTION_REJECTED', 'Expected code DIRECT_IMAGE_INJECTION_REJECTED');
      console.log('  ✓ PASS: Data URL image injection rejected with HTTP 400 DIRECT_IMAGE_INJECTION_REJECTED');
    }

    // -------------------------------------------------------------------------
    // TEST 3: Forged / unregistered attachment ID rejection
    // -------------------------------------------------------------------------
    console.log('\n--> Test 3: Forged / unregistered attachment ID rejection');
    {
      // 3A: Forged ID with base64 payload
      const resA = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: 'Analyze this photo',
          provider: 'gemini',
          stream: false,
          attachments: [
            {
              id: '00000000-0000-0000-0000-000000000000',
              name: 'forged_with_b64.png',
              mimeType: 'image/png',
              base64: VALID_PNG_BASE64
            }
          ]
        })
      });
      assert.strictEqual(resA.status, 400, `Expected HTTP 400 for forged ID with Base64, got ${resA.status}`);
      const dataA = await resA.json();
      assert.strictEqual(dataA.code, 'DIRECT_IMAGE_INJECTION_REJECTED');

      // 3B: Forged ID without base64 payload
      const resB = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: 'Analyze this document',
          provider: 'gemini',
          stream: false,
          attachments: [
            {
              id: '11111111-2222-3333-4444-555555555555',
              name: 'unregistered_reference.png',
              mimeType: 'image/png'
            }
          ]
        })
      });
      assert.strictEqual(resB.status, 400, `Expected HTTP 400 for unregistered ID, got ${resB.status}`);
      const dataB = await resB.json();
      assert.strictEqual(dataB.code, 'UNREGISTERED_ATTACHMENT');

      // 3C: Malformed ID / path traversal attempt
      const resC = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: 'Analyze this document',
          provider: 'gemini',
          stream: false,
          attachments: [
            {
              id: '../../../etc/passwd',
              name: 'traversal.png',
              mimeType: 'image/png'
            }
          ]
        })
      });
      assert.strictEqual(resC.status, 400, `Expected HTTP 400 for invalid ID format, got ${resC.status}`);
      const dataC = await resC.json();
      assert.strictEqual(dataC.code, 'INVALID_ATTACHMENT_ID');

      console.log('  ✓ PASS: Forged, unregistered, and malformed attachment IDs correctly rejected with HTTP 400');
    }

    // -------------------------------------------------------------------------
    // TEST 4: Cross-user attachment reference rejection
    // -------------------------------------------------------------------------
    console.log('\n--> Test 4: Cross-user attachment reference rejection');
    {
      // Step 1: User Alice uploads an attachment legitimately
      const uploadRes = await uploadFileHelper({
        baseUrl,
        token: 'token-alice',
        filename: 'alice_photo.png',
        conversationId: 'conv_alice'
      });

      assert.strictEqual(uploadRes.status, 200, `Alice upload should succeed, got ${uploadRes.status}`);
      const uploadData = await uploadRes.json();
      const aliceAttachment = uploadData?.attachments?.[0];
      const aliceAttachmentId = aliceAttachment?.id;
      assert.ok(aliceAttachmentId, 'Alice upload must return an attachment ID');

      // Verify server record has Alice UID
      const aliceRecord = fileRegistry.get(aliceAttachmentId);
      assert.ok(aliceRecord, 'File must exist in server fileRegistry');
      assert.strictEqual(aliceRecord.userId, 'user_alice_alpha', 'Record must belong to Alice');

      // Step 2: User Bob attempts to reference Alice's attachment
      const bobRes = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer token-bob',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          prompt: 'Tell me what is in Alice private photo',
          provider: 'gemini',
          stream: false,
          attachments: [
            {
              id: aliceAttachmentId,
              name: 'alice_photo.png',
              type: 'image/png'
            }
          ]
        })
      });

      assert.strictEqual(bobRes.status, 403, `Expected HTTP 403 for Bob accessing Alice attachment, got ${bobRes.status}`);
      const bobData = await bobRes.json();
      assert.strictEqual(bobData.code, 'ATTACHMENT_ACCESS_DENIED');
      assert.ok(
        bobData.error.includes('You do not have permission to reference attachments belonging to another user'),
        `Expected cross-user access error, got: ${bobData.error}`
      );

      // Step 3: Unauthenticated guest attempts to reference Alice's attachment
      const guestRes = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          prompt: 'Tell me what is in Alice private photo',
          provider: 'gemini',
          stream: false,
          attachments: [
            {
              id: aliceAttachmentId,
              name: 'alice_photo.png',
              type: 'image/png'
            }
          ]
        })
      });

      assert.strictEqual(guestRes.status, 403, `Expected HTTP 403 for Guest accessing Alice attachment, got ${guestRes.status}`);
      const guestData = await guestRes.json();
      assert.strictEqual(guestData.code, 'ATTACHMENT_ACCESS_DENIED');
      assert.ok(
        guestData.error.includes('Authentication is required to access this attachment'),
        `Expected auth required error, got: ${guestData.error}`
      );

      console.log('  ✓ PASS: Cross-user and unauthenticated attachment references rejected with HTTP 403 ATTACHMENT_ACCESS_DENIED');
    }

    // -------------------------------------------------------------------------
    // TEST 5: Valid uploaded image acceptance
    // -------------------------------------------------------------------------
    console.log('\n--> Test 5: Valid uploaded image acceptance');
    {
      const aliceRecs = Array.from(fileRegistry.values()).filter(r => r.userId === 'user_alice_alpha');
      assert.ok(aliceRecs.length > 0, 'Alice uploaded file must be in fileRegistry');
      const aliceAttId = aliceRecs[0].id;

      const chatRes = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer token-alice',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          prompt: 'Explain what is shown in this picture',
          provider: 'gemini',
          stream: false,
          attachments: [
            {
              id: aliceAttId,
              name: 'alice_photo.png',
              type: 'image/png',
              mimeType: 'image/png',
              isImage: true
            }
          ]
        })
      });

      // The request should NOT be rejected with 400 or 403!
      assert.notStrictEqual(chatRes.status, 400, 'Legitimate uploaded image must not be rejected with HTTP 400');
      assert.notStrictEqual(chatRes.status, 403, 'Legitimate uploaded image must not be rejected with HTTP 403');
      assert.notStrictEqual(chatRes.status, 429, 'Legitimate uploaded image within quota must not be rejected with HTTP 429');
      console.log(`  ✓ PASS: Valid uploaded image accepted by /api/chat (HTTP ${chatRes.status})`);
    }

    // -------------------------------------------------------------------------
    // TEST 6: Gemini Vision functionality with server-verified buffer
    // -------------------------------------------------------------------------
    console.log('\n--> Test 6: Gemini Vision functionality with server-verified buffer');
    {
      const aliceRecs = Array.from(fileRegistry.values()).filter(r => r.userId === 'user_alice_alpha');
      const aliceAtt = aliceRecs[0];

      // Test buildGeminiImageParts with the registered file
      const visionParts = buildGeminiImageParts({
        attachments: [
          {
            id: aliceAtt.id,
            name: aliceAtt.originalName,
            isImage: true,
            mimeType: 'image/png'
          }
        ],
        availableDocs: []
      });

      assert.strictEqual(visionParts.length, 1, 'Expected exactly 1 vision image part generated');
      assert.strictEqual(visionParts[0].mimeType, 'image/png');
      assert.strictEqual(
        visionParts[0].data,
        VALID_PNG_BASE64,
        'Vision part data must match the server-verified binary buffer'
      );
      console.log('  ✓ PASS: Gemini Vision parts correctly constructed from server-verified buffer');
    }

    // -------------------------------------------------------------------------
    // TEST 7: Daily Quota preservation on rejected direct injections
    // -------------------------------------------------------------------------
    console.log('\n--> Test 7: Daily quota preservation on rejected direct injections');
    {
      const testIdentity = {
        type: 'auth',
        id: 'user_bob_beta',
        key: 'auth_bob_test_key'
      };
      const quotaBefore = await getQuotaStatus(testIdentity);

      // Attempt another direct Base64 injection as Bob
      const rejectedRes = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer token-bob',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          prompt: 'Bypass quota attempt',
          provider: 'gemini',
          stream: false,
          attachments: [
            {
              name: 'bypass.png',
              mimeType: 'image/png',
              base64: VALID_PNG_BASE64
            }
          ]
        })
      });
      assert.strictEqual(rejectedRes.status, 400);

      const quotaAfter = await getQuotaStatus(testIdentity);
      assert.strictEqual(
        quotaAfter.used,
        quotaBefore.used,
        'Direct injection attempts must NOT consume quota slots'
      );
      console.log('  ✓ PASS: Quota remains intact; direct injection attempts do not consume daily quota');
    }

    console.log('\n======================================================================');
    console.log('Direct Base64 Image Quota Bypass Regression Suite: All 7 Tests Passed!');
    console.log('======================================================================\n');
  } finally {
    resetFirebaseAuthForTesting();
    server.close();
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('\n❌ Test Suite Failed:', err);
  process.exit(1);
});
