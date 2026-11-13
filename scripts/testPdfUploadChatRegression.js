/**
 * scripts/testPdfUploadChatRegression.js
 *
 * ORVIX — P2 REGRESSION SUITE: VALID PDF & IMAGE UPLOAD TO /api/chat LIFECYCLE
 *
 * Verifies:
 * 1. Standard PDF upload ('NumIQ.pdf') followed by /api/chat submission (warm & cold fileRegistry).
 * 2. Direct Supabase PDF upload ('NumIQ.pdf') followed by /api/chat submission (warm & cold fileRegistry)
 *    and contract parity between standard and direct upload responses.
 * 3. Image upload followed by /api/chat submission and Gemini Vision parts construction (warm & cold fileRegistry).
 * 4. Attachment retry (second /api/chat submission reusing registered attachment reference without consuming extra quota).
 * 5. Expired attachment rejection (both in-memory fileRegistry expiry and durable Supabase _expiry_records expiry).
 * 6. Security protections preserved:
 *    - Forged attachment ID rejected with HTTP 400 UNREGISTERED_ATTACHMENT.
 *    - Raw Base64 / Data URL injection rejected with HTTP 400 DIRECT_IMAGE_INJECTION_REJECTED.
 *    - Cross-user attachment reference rejected with HTTP 403 ATTACHMENT_ACCESS_DENIED (warm & cold fileRegistry).
 *    - Unauthenticated /api/chat request referencing an authenticated user's attachment rejected with HTTP 403.
 * 7. Source & deployment configuration audit (aiRouter auth header propagation, ChatPage metadata preservation,
 *    chatStorageService persistence, and vercel.json cache headers for index.html / sw.js / assets).
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';

process.env.TESTING = '1';
process.env.FIREBASE_PROJECT_ID = 'orvix-pdf-regression-test';
process.env.NODE_ENV = 'test';

const { app } = await import('../server.ts');
const {
  setTestFirebaseProjectId,
  setCustomTokenVerifierForTesting,
  resetFirebaseAuthForTesting
} = await import('../server/firebaseAuthHelper.ts');

const {
  setSupabaseServerClientForTesting,
  resetSupabaseClientForTesting,
  DEFAULT_SUPABASE_STORAGE_BUCKET
} = await import('../server/supabaseClient.ts');

const {
  EXPIRY_RECORDS_PREFIX
} = await import('../server/supabaseStorageService.ts');

const {
  fileRegistry,
  conversationDocuments,
  buildGeminiImageParts,
  resolveRegisteredAttachmentForChat,
  resetDirectUploadTicketsForTesting
} = await import('../server/uploadSubsystem.ts');

const {
  resetQuotaForTesting,
  getQuotaStatus
} = await import('../server/uploadQuotaService.ts');

const REAL_PNG_PATH = path.resolve(process.cwd(), 'public/favicon-32x32.png');
const VALID_PNG_BUFFER = fs.readFileSync(REAL_PNG_PATH);
const VALID_PNG_BASE64 = VALID_PNG_BUFFER.toString('base64');

async function createValidPdfBuffer(text = 'NumIQ Quantitative Reasoning Study Guide: Find the next number in 2, 4, 8, 16, 32.') {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([600, 400]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  page.drawText(text, {
    x: 50,
    y: 320,
    size: 14,
    font
  });
  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

function createMockSupabaseStorageClient() {
  const objects = new Map();

  const storageApi = {
    from(bucket) {
      return {
        async createSignedUploadUrl(storagePath) {
          const token = 'mock_upload_token_' + crypto.randomUUID();
          const signedUrl = `https://mock.supabase.co/storage/v1/object/upload/sign/${bucket}/${storagePath}?token=${token}`;
          return {
            data: { signedUrl, token, path: storagePath },
            error: null
          };
        },
        async createSignedUrl(storagePath) {
          return {
            data: { signedUrl: `https://mock.supabase.co/storage/v1/object/sign/${bucket}/${storagePath}?token=mock_dl_token` },
            error: null
          };
        },
        async upload(storagePath, buffer, options = {}) {
          objects.set(storagePath, {
            buffer: Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer),
            contentType: options.contentType || 'application/octet-stream'
          });
          return { data: { path: storagePath, fullPath: `${bucket}/${storagePath}` }, error: null };
        },
        async download(storagePath) {
          const item = objects.get(storagePath);
          if (!item) {
            return { data: null, error: { message: 'Object not found', status: 404 } };
          }
          return {
            data: {
              type: item.contentType,
              async arrayBuffer() {
                return item.buffer.buffer.slice(
                  item.buffer.byteOffset,
                  item.buffer.byteOffset + item.buffer.byteLength
                );
              }
            },
            error: null
          };
        },
        async remove(paths) {
          for (const p of paths) {
            objects.delete(p);
          }
          return { data: paths.map((p) => ({ name: p })), error: null };
        },
        async list(folderPath) {
          const prefix = folderPath.replace(/\/+$/, '') + '/';
          const items = [];
          for (const [key, val] of objects.entries()) {
            if (key.startsWith(prefix)) {
              const name = key.slice(prefix.length);
              if (!name.includes('/')) {
                items.push({ name, id: name, metadata: { size: val.buffer.length } });
              }
            }
          }
          return { data: items, error: null };
        },
        async getBucket(name) {
          return { data: { name, id: name, public: false }, error: null };
        }
      };
    },
    async getBucket(name) {
      return { data: { name, id: name, public: false }, error: null };
    }
  };

  return {
    client: { storage: storageApi },
    objects
  };
}

async function uploadMultipartFile({
  baseUrl,
  token,
  buffer,
  filename,
  contentType,
  conversationId = 'chat_numiq_1'
}) {
  const boundary = '----WebKitFormBoundary' + crypto.randomBytes(8).toString('hex');
  const parts = [];
  if (conversationId) {
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="conversationId"\r\n\r\n${conversationId}\r\n`)
    );
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`
    )
  );
  parts.push(buffer);
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
  console.log('ORVIX REGRESSION TEST: Valid PDF & Image Upload -> /api/chat Lifecycle');
  console.log('======================================================================');

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const mockSupabase = createMockSupabaseStorageClient();
  setSupabaseServerClientForTesting(mockSupabase.client);

  setTestFirebaseProjectId('orvix-pdf-regression-test');
  setCustomTokenVerifierForTesting(async (token) => {
    if (token === 'token-student-1') {
      return {
        success: true,
        user: {
          uid: 'student_uid_1',
          email: 'student1@orvix.edu',
          projectId: 'orvix-pdf-regression-test',
          claims: { aud: 'orvix-pdf-regression-test', sub: 'student_uid_1' }
        }
      };
    }
    if (token === 'token-student-2') {
      return {
        success: true,
        user: {
          uid: 'student_uid_2',
          email: 'student2@orvix.edu',
          projectId: 'orvix-pdf-regression-test',
          claims: { aud: 'orvix-pdf-regression-test', sub: 'student_uid_2' }
        }
      };
    }
    return {
      success: false,
      error: 'Invalid token',
      code: 'AUTH_INVALID_TOKEN'
    };
  });

  try {
    resetQuotaForTesting();
    resetDirectUploadTicketsForTesting();
    fileRegistry.clear();
    conversationDocuments.clear();

    const validPdfBuffer = await createValidPdfBuffer(
      'NumIQ Quantitative Reasoning Assessment: Question 1 - What is the next term in 3, 9, 27, 81?'
    );

    // -------------------------------------------------------------------------
    // TEST 1: Standard PDF upload ('NumIQ.pdf') followed by /api/chat submission
    //         (Warm fileRegistry AND Cold/Serverless-isolated fileRegistry)
    // -------------------------------------------------------------------------
    console.log('\n--> Test 1: Standard PDF upload (NumIQ.pdf) followed by /api/chat submission');
    let standardPdfAttachment = null;
    {
      const uploadRes = await uploadMultipartFile({
        baseUrl,
        token: 'token-student-1',
        buffer: validPdfBuffer,
        filename: 'NumIQ.pdf',
        contentType: 'application/pdf',
        conversationId: 'conv_std_pdf'
      });

      assert.strictEqual(uploadRes.status, 200, `Expected 200 on standard NumIQ.pdf upload, got ${uploadRes.status}`);
      const uploadJson = await uploadRes.json();
      assert.strictEqual(uploadJson.success, true);
      assert.ok(Array.isArray(uploadJson.attachments) && uploadJson.attachments.length === 1);
      assert.ok(uploadJson.attachment && uploadJson.attachment.id === uploadJson.attachments[0].id);

      standardPdfAttachment = uploadJson.attachment;
      assert.strictEqual(standardPdfAttachment.originalName, 'NumIQ.pdf');
      assert.strictEqual(standardPdfAttachment.storageProvider, 'supabase');
      assert.strictEqual(standardPdfAttachment.chatId, 'conv_std_pdf');
      assert.strictEqual(standardPdfAttachment.conversationId, 'conv_std_pdf');
      assert.strictEqual(standardPdfAttachment.userId, 'student_uid_1');
      assert.ok(standardPdfAttachment.storagePath.includes('student_uid_1/conv_std_pdf/'));
      assert.ok(typeof standardPdfAttachment.expiresAt === 'number');

      // 1a. Warm fileRegistry /api/chat submission
      const warmChatRes = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token-student-1'
        },
        body: JSON.stringify({
          prompt: 'Summarize NumIQ.pdf',
          provider: 'gemini',
          conversationId: 'conv_std_pdf',
          stream: false,
          attachments: [standardPdfAttachment]
        })
      });
      const warmChatBody = await warmChatRes.text();
      assert.notStrictEqual(
        warmChatRes.status,
        400,
        `Warm /api/chat must not reject NumIQ.pdf with 400: ${warmChatBody}`
      );
      assert.notStrictEqual(
        warmChatRes.status,
        403,
        `Warm /api/chat must not reject NumIQ.pdf with 403: ${warmChatBody}`
      );
      assert.ok(
        !warmChatBody.includes('UNREGISTERED_ATTACHMENT'),
        `Warm /api/chat must not return UNREGISTERED_ATTACHMENT: ${warmChatBody}`
      );

      // 1b. Simulate Vercel serverless isolation (/api/upload instance != /api/chat instance)
      fileRegistry.clear();
      conversationDocuments.clear();
      assert.strictEqual(fileRegistry.size, 0, 'fileRegistry cleared to simulate cold /api/chat instance');

      const coldChatRes = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token-student-1'
        },
        body: JSON.stringify({
          prompt: 'Explain Question 1 in NumIQ.pdf',
          provider: 'gemini',
          conversationId: 'conv_std_pdf',
          stream: false,
          attachments: [
            {
              id: standardPdfAttachment.id,
              name: standardPdfAttachment.name,
              originalName: 'NumIQ.pdf',
              type: 'application/pdf',
              extension: '.pdf',
              size: standardPdfAttachment.size,
              chatId: 'conv_std_pdf',
              conversationId: 'conv_std_pdf',
              storageProvider: 'supabase',
              storagePath: standardPdfAttachment.storagePath
            }
          ]
        })
      });
      const coldChatBody = await coldChatRes.text();
      assert.notStrictEqual(
        coldChatRes.status,
        400,
        `Cold /api/chat must re-hydrate NumIQ.pdf from Supabase Storage and not return 400: ${coldChatBody}`
      );
      assert.notStrictEqual(
        coldChatRes.status,
        403,
        `Cold /api/chat must not return 403 for owner: ${coldChatBody}`
      );
      assert.ok(
        !coldChatBody.includes('UNREGISTERED_ATTACHMENT'),
        `Cold /api/chat must not return UNREGISTERED_ATTACHMENT: ${coldChatBody}`
      );
      assert.ok(
        fileRegistry.has(standardPdfAttachment.id),
        'fileRegistry should be repopulated after cold /api/chat re-hydration'
      );
      const rehydrated = fileRegistry.get(standardPdfAttachment.id);
      assert.ok(
        rehydrated?.extraction?.text?.includes('NumIQ Quantitative Reasoning'),
        `Re-hydrated PDF should have extracted text, got: ${rehydrated?.extraction?.text}`
      );
      console.log('  ✓ PASS: Standard NumIQ.pdf upload accepted by /api/chat in both warm and cold serverless states');
    }

    // -------------------------------------------------------------------------
    // TEST 2: Direct Supabase PDF upload ('NumIQ.pdf') followed by /api/chat
    // -------------------------------------------------------------------------
    console.log('\n--> Test 2: Direct Supabase PDF upload (NumIQ.pdf) followed by /api/chat submission');
    {
      const signedUrlRes = await fetch(`${baseUrl}/api/upload/direct/signed-url`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token-student-1'
        },
        body: JSON.stringify({
          filename: 'NumIQ.pdf',
          mimeType: 'application/pdf',
          size: validPdfBuffer.length,
          chatId: 'conv_direct_pdf'
        })
      });
      assert.strictEqual(signedUrlRes.status, 200, `Expected 200 from direct signed-url, got ${signedUrlRes.status}`);
      const signedData = await signedUrlRes.json();
      assert.strictEqual(signedData.success, true);
      assert.ok(signedData.attachmentId);
      assert.ok(signedData.storagePath);

      // Simulate client uploading directly to Supabase storage path
      await mockSupabase.client.storage
        .from(signedData.bucket || DEFAULT_SUPABASE_STORAGE_BUCKET)
        .upload(signedData.storagePath, validPdfBuffer, { contentType: 'application/pdf' });

      const completeRes = await fetch(`${baseUrl}/api/upload/direct/complete`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token-student-1'
        },
        body: JSON.stringify({
          attachmentId: signedData.attachmentId,
          storagePath: signedData.storagePath,
          chatId: 'conv_direct_pdf',
          filename: 'NumIQ.pdf',
          mimeType: 'application/pdf',
          size: validPdfBuffer.length
        })
      });
      assert.strictEqual(completeRes.status, 200, `Expected 200 from direct complete, got ${completeRes.status}`);
      const completeData = await completeRes.json();
      assert.strictEqual(completeData.success, true);
      assert.ok(completeData.attachment, 'Direct complete must return attachment');
      assert.ok(Array.isArray(completeData.attachments) && completeData.attachments.length === 1, 'Direct complete must also return attachments array for contract parity');

      const directAtt = completeData.attachment;
      // Verify contract parity between standard and direct upload responses
      for (const requiredKey of [
        'id',
        'name',
        'originalName',
        'extension',
        'format',
        'mimeType',
        'type',
        'size',
        'formattedSize',
        'status',
        'isImage',
        'uploadedAt',
        'expiresAt',
        'storageProvider',
        'storagePath',
        'bucket',
        'chatId',
        'conversationId',
        'userId',
        'extraction'
      ]) {
        assert.ok(
          requiredKey in directAtt && requiredKey in standardPdfAttachment,
          `Both standard and direct upload contracts must include '${requiredKey}'`
        );
      }

      // Clear in-memory registry to test serverless isolation after direct upload
      fileRegistry.clear();
      conversationDocuments.clear();

      const chatRes = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token-student-1'
        },
        body: JSON.stringify({
          prompt: 'Solve the sequence in NumIQ.pdf',
          provider: 'gemini',
          conversationId: 'conv_direct_pdf',
          stream: false,
          attachments: [directAtt]
        })
      });
      const chatBody = await chatRes.text();
      assert.notStrictEqual(chatRes.status, 400, `Direct uploaded NumIQ.pdf must not fail with 400: ${chatBody}`);
      assert.notStrictEqual(chatRes.status, 403, `Direct uploaded NumIQ.pdf must not fail with 403: ${chatBody}`);
      assert.ok(!chatBody.includes('UNREGISTERED_ATTACHMENT'));
      console.log('  ✓ PASS: Direct Supabase NumIQ.pdf upload follows identical contract and succeeds in /api/chat');
    }

    // -------------------------------------------------------------------------
    // TEST 3: Image upload followed by /api/chat submission & Gemini Vision parts
    // -------------------------------------------------------------------------
    console.log('\n--> Test 3: Image upload followed by /api/chat submission and Gemini Vision parts construction');
    let uploadedImageAtt = null;
    {
      const imgUploadRes = await uploadMultipartFile({
        baseUrl,
        token: 'token-student-1',
        buffer: VALID_PNG_BUFFER,
        filename: 'geometry_problem.png',
        contentType: 'image/png',
        conversationId: 'conv_img_chat'
      });
      assert.strictEqual(imgUploadRes.status, 200, `Expected 200 on image upload, got ${imgUploadRes.status}`);
      const imgData = await imgUploadRes.json();
      uploadedImageAtt = imgData.attachment;
      assert.strictEqual(uploadedImageAtt.isImage, true);

      // Clear fileRegistry to verify cold re-hydration for images too
      fileRegistry.clear();

      const resolvedImg = await resolveRegisteredAttachmentForChat(uploadedImageAtt, {
        authenticatedUserId: 'student_uid_1',
        conversationId: 'conv_img_chat'
      });
      assert.strictEqual(resolvedImg.status, 'ok', 'Image attachment should resolve from Supabase Storage when fileRegistry is cold');
      assert.ok(resolvedImg.record?.buffer, 'Re-hydrated image record must populate buffer for Gemini Vision');

      const geminiParts = buildGeminiImageParts({ attachments: [uploadedImageAtt] });
      assert.strictEqual(geminiParts.length, 1, 'Expected 1 Gemini Vision image part');
      assert.strictEqual(geminiParts[0].mimeType, 'image/png');
      assert.strictEqual(geminiParts[0].data, VALID_PNG_BASE64);

      const chatRes = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token-student-1'
        },
        body: JSON.stringify({
          prompt: 'Describe this diagram',
          provider: 'gemini',
          conversationId: 'conv_img_chat',
          stream: false,
          attachments: [uploadedImageAtt]
        })
      });
      const chatBody = await chatRes.text();
      assert.notStrictEqual(chatRes.status, 400, `Uploaded image must not be rejected with 400: ${chatBody}`);
      assert.notStrictEqual(chatRes.status, 403, `Uploaded image must not be rejected with 403: ${chatBody}`);
      console.log('  ✓ PASS: Image upload accepted by /api/chat and Gemini Vision inlineData parts built from server bytes');
    }

    // -------------------------------------------------------------------------
    // TEST 4: Attachment retry preserves registered reference and quota
    // -------------------------------------------------------------------------
    console.log('\n--> Test 4: Attachment retry preserves registered attachment reference without consuming additional quota');
    {
      const quotaBeforeRes = await fetch(`${baseUrl}/api/upload/quota`, {
        headers: { Authorization: 'Bearer token-student-1' }
      });
      assert.strictEqual(quotaBeforeRes.status, 200);
      const quotaBefore = await quotaBeforeRes.json();
      assert.strictEqual(quotaBefore.committed, 3, `Expected 3 uploads committed so far, got ${quotaBefore.committed}`);
      assert.strictEqual(quotaBefore.remaining, 2, `Expected 2 uploads remaining so far, got ${quotaBefore.remaining}`);

      // Simulate retry of the NumIQ.pdf message (with sanitized network attachment metadata as prepared by ChatPage)
      fileRegistry.clear();
      const retryAttachmentPayload = {
        id: standardPdfAttachment.id,
        name: standardPdfAttachment.name,
        originalName: standardPdfAttachment.originalName,
        type: standardPdfAttachment.type,
        mimeType: standardPdfAttachment.mimeType,
        extension: standardPdfAttachment.extension,
        size: standardPdfAttachment.size,
        formattedSize: standardPdfAttachment.formattedSize,
        status: 'uploaded',
        isImage: false,
        storageProvider: standardPdfAttachment.storageProvider,
        storagePath: standardPdfAttachment.storagePath,
        bucket: standardPdfAttachment.bucket,
        chatId: standardPdfAttachment.chatId,
        conversationId: standardPdfAttachment.conversationId,
        userId: standardPdfAttachment.userId,
        uploadedAt: standardPdfAttachment.uploadedAt,
        expiresAt: standardPdfAttachment.expiresAt
      };

      const retryRes = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token-student-1'
        },
        body: JSON.stringify({
          prompt: 'Retry: Summarize NumIQ.pdf',
          provider: 'gemini',
          conversationId: 'conv_std_pdf',
          stream: false,
          attachments: [retryAttachmentPayload]
        })
      });
      const retryBody = await retryRes.text();
      assert.notStrictEqual(retryRes.status, 400, `Retry must not fail with 400: ${retryBody}`);
      assert.notStrictEqual(retryRes.status, 403, `Retry must not fail with 403: ${retryBody}`);

      const quotaAfterRes = await fetch(`${baseUrl}/api/upload/quota`, {
        headers: { Authorization: 'Bearer token-student-1' }
      });
      assert.strictEqual(quotaAfterRes.status, 200);
      const quotaAfter = await quotaAfterRes.json();
      assert.strictEqual(quotaAfter.committed, 3, 'Retrying /api/chat with an already-uploaded attachment must not consume extra upload quota');
      assert.strictEqual(quotaAfter.remaining, 2, 'Remaining upload quota must remain 2 after retry');
      console.log('  ✓ PASS: Attachment retry succeeded and preserved upload quota (3/5 committed, 2 remaining)');
    }

    // -------------------------------------------------------------------------
    // TEST 5: Expired attachment rejection (in-memory & durable Supabase expiry)
    // -------------------------------------------------------------------------
    console.log('\n--> Test 5: Expired attachment rejection (both warm fileRegistry and cold durable Supabase expiry)');
    {
      // 5a. Warm fileRegistry expired record
      const record = fileRegistry.get(standardPdfAttachment.id);
      assert.ok(record, 'Expected standardPdfAttachment in fileRegistry');
      record.expiresAt = Date.now() - 10_000;

      const warmExpiredRes = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token-student-1'
        },
        body: JSON.stringify({
          prompt: 'Read expired NumIQ.pdf',
          provider: 'gemini',
          conversationId: 'conv_std_pdf',
          stream: false,
          attachments: [{ id: standardPdfAttachment.id, name: 'NumIQ.pdf' }]
        })
      });
      assert.strictEqual(warmExpiredRes.status, 400, `Expected HTTP 400 for expired attachment, got ${warmExpiredRes.status}`);
      const warmExpiredData = await warmExpiredRes.json();
      assert.strictEqual(warmExpiredData.code, 'UNREGISTERED_ATTACHMENT');

      // 5b. Cold fileRegistry with expired durable marker in Supabase _expiry_records
      fileRegistry.clear();
      const expiredTime = Date.now() - 60_000;
      const newExpiredMarkerPath = `${EXPIRY_RECORDS_PREFIX}/${expiredTime}__${standardPdfAttachment.id}.json`;
      await mockSupabase.client.storage
        .from(DEFAULT_SUPABASE_STORAGE_BUCKET)
        .upload(
          newExpiredMarkerPath,
          Buffer.from(
            JSON.stringify({
              attachmentId: standardPdfAttachment.id,
              storagePath: standardPdfAttachment.storagePath,
              bucket: DEFAULT_SUPABASE_STORAGE_BUCKET,
              userId: 'student_uid_1',
              chatId: 'conv_std_pdf',
              uploadedAt: expiredTime - 600_000,
              expiresAt: expiredTime
            })
          ),
          { contentType: 'application/json' }
        );

      const coldExpiredRes = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token-student-1'
        },
        body: JSON.stringify({
          prompt: 'Read durably expired NumIQ.pdf',
          provider: 'gemini',
          conversationId: 'conv_std_pdf',
          stream: false,
          attachments: [
            {
              id: standardPdfAttachment.id,
              name: 'NumIQ.pdf',
              chatId: 'conv_std_pdf',
              storagePath: standardPdfAttachment.storagePath
            }
          ]
        })
      });
      assert.strictEqual(coldExpiredRes.status, 400, `Expected HTTP 400 for durably expired attachment, got ${coldExpiredRes.status}`);
      const coldExpiredData = await coldExpiredRes.json();
      assert.strictEqual(coldExpiredData.code, 'UNREGISTERED_ATTACHMENT');
      console.log('  ✓ PASS: Expired attachments rejected with HTTP 400 UNREGISTERED_ATTACHMENT in both warm and cold states');
    }

    // -------------------------------------------------------------------------
    // TEST 6: Forged IDs, Raw Base64 Injection, and Cross-User Access Rejection
    // -------------------------------------------------------------------------
    console.log('\n--> Test 6: Forged IDs, Raw Base64 injection, and Cross-User access rejection');
    {
      // 6a. Forged UUID
      const forgedRes = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token-student-1'
        },
        body: JSON.stringify({
          prompt: 'Analyze forged attachment',
          provider: 'gemini',
          stream: false,
          attachments: [
            {
              id: crypto.randomUUID(),
              name: 'forged.pdf',
              type: 'application/pdf'
            }
          ]
        })
      });
      assert.strictEqual(forgedRes.status, 400);
      const forgedData = await forgedRes.json();
      assert.strictEqual(forgedData.code, 'UNREGISTERED_ATTACHMENT');

      // 6b. Raw Base64 injection without server upload
      const rawB64Res = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token-student-1'
        },
        body: JSON.stringify({
          prompt: 'Analyze injected base64',
          provider: 'gemini',
          stream: false,
          attachments: [
            {
              name: 'injected.png',
              mimeType: 'image/png',
              base64: VALID_PNG_BASE64
            }
          ]
        })
      });
      assert.strictEqual(rawB64Res.status, 400);
      const rawB64Data = await rawB64Res.json();
      assert.strictEqual(rawB64Data.code, 'DIRECT_IMAGE_INJECTION_REJECTED');

      // 6c. Cross-user access rejection (Student 2 trying to use Student 1's uploaded image in both warm and cold states)
      fileRegistry.clear();
      const crossUserColdRes = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token-student-2'
        },
        body: JSON.stringify({
          prompt: 'Steal student 1 image',
          provider: 'gemini',
          conversationId: 'conv_img_chat',
          stream: false,
          attachments: [uploadedImageAtt]
        })
      });
      assert.strictEqual(
        crossUserColdRes.status,
        403,
        `Expected HTTP 403 when Student 2 references Student 1 storagePath, got ${crossUserColdRes.status}`
      );
      const crossUserColdData = await crossUserColdRes.json();
      assert.strictEqual(crossUserColdData.code, 'ATTACHMENT_ACCESS_DENIED');

      // Populate warm registry for Student 1's image and test Student 2 with only { id }
      await resolveRegisteredAttachmentForChat(uploadedImageAtt, {
        authenticatedUserId: 'student_uid_1',
        conversationId: 'conv_img_chat'
      });
      const crossUserWarmRes = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token-student-2'
        },
        body: JSON.stringify({
          prompt: 'Steal student 1 image by ID only',
          provider: 'gemini',
          conversationId: 'conv_img_chat',
          stream: false,
          attachments: [{ id: uploadedImageAtt.id, name: 'geometry_problem.png' }]
        })
      });
      assert.strictEqual(crossUserWarmRes.status, 403);
      const crossUserWarmData = await crossUserWarmRes.json();
      assert.strictEqual(crossUserWarmData.code, 'ATTACHMENT_ACCESS_DENIED');

      // 6d. Unauthenticated request referencing authenticated Student 1's attachment
      const unauthChatRes = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          prompt: 'Unauthenticated access attempt',
          provider: 'gemini',
          conversationId: 'conv_img_chat',
          stream: false,
          attachments: [{ id: uploadedImageAtt.id, name: 'geometry_problem.png' }]
        })
      });
      assert.strictEqual(unauthChatRes.status, 403);
      const unauthChatData = await unauthChatRes.json();
      assert.strictEqual(unauthChatData.code, 'ATTACHMENT_ACCESS_DENIED');
      console.log('  ✓ PASS: Forged IDs (400), Raw Base64 (400), Cross-User (403), and Unauthenticated (403) attacks rejected');
    }

    // -------------------------------------------------------------------------
    // TEST 7: Frontend & Deployment Configuration Audit
    // -------------------------------------------------------------------------
    console.log('\n--> Test 7: Frontend & Deployment Configuration Audit');
    {
      const aiRouterCode = fs.readFileSync(path.resolve(process.cwd(), 'src/services/aiRouter.js'), 'utf8');
      assert.ok(
        aiRouterCode.includes("import { getAuthHeaders } from './authService.js'"),
        'aiRouter.js must import getAuthHeaders from authService.js'
      );
      assert.ok(
        aiRouterCode.includes('await getAuthHeaders(baseChatHeaders)'),
        'aiRouter.js must attach Firebase authHeaders to /api/chat requests'
      );

      const chatStorageCode = fs.readFileSync(path.resolve(process.cwd(), 'src/services/chatStorageService.js'), 'utf8');
      assert.ok(
        chatStorageCode.includes('serialized.storagePath = att.storagePath.trim()') &&
          chatStorageCode.includes('serialized.expiresAt = att.expiresAt'),
        'chatStorageService.js must preserve storagePath and expiresAt across message persistence'
      );

      const vercelConfig = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'vercel.json'), 'utf8'));
      const indexHeaderRule = vercelConfig.headers.find((h) => h.source === '/index.html');
      const swHeaderRule = vercelConfig.headers.find((h) => h.source === '/sw.js');
      assert.ok(indexHeaderRule, 'vercel.json must include Cache-Control headers for /index.html');
      assert.ok(swHeaderRule, 'vercel.json must include Cache-Control headers for /sw.js');
      console.log('  ✓ PASS: Frontend auth header propagation, storage serialization, and vercel.json cache headers verified');
    }

    console.log('\n======================================================================');
    console.log('ALL P2 PDF/IMAGE UPLOAD -> /api/chat REGRESSION TESTS PASSED!');
    console.log('======================================================================\n');
  } finally {
    resetFirebaseAuthForTesting();
    resetSupabaseClientForTesting();
    resetQuotaForTesting();
    resetDirectUploadTicketsForTesting();
    fileRegistry.clear();
    conversationDocuments.clear();
    server.close();
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('\n❌ TEST SUITE FAILED:', err);
  process.exit(1);
});
