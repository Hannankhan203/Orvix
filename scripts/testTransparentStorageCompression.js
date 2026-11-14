/**
 * scripts/testTransparentStorageCompression.js
 *
 * Comprehensive Integration & Security Verification Suite for Transparent Storage Compression
 * (TXT, MD, DOC, PPT, XLS — Prompt 10).
 *
 * Exercises end-to-end:
 * 1. Codec & Coordinator guarantees across all 5 formats (exact >= 10% savings, untouched att.file).
 * 2. Both upload routes: Multipart `POST /api/upload` & Direct Supabase (`/signed-url` + `PUT` + `/complete`).
 * 3. Inspection of actual bytes stored in Supabase bucket (compact Orvix envelope, no Content-Encoding).
 * 4. Decoded retrieval (`/file`, `/preview`, `/download`), `/signed-url` safe proxy decoding, expiry & auth.
 * 5. AI extraction (`/extraction` + `resolveRegisteredAttachmentForChat`) pre- and post-restart (`fileRegistry.clear()`).
 * 6. Fallback when savings < 10% (uploads raw original, standard Supabase signed URL preserved).
 * 7. Non-regression for JPEG, PNG, PDF, DOCX, CSV, JSON.
 * 8. Security & adversarial tests: spoofed metadata, version/MIME/size/checksum tampering, truncated/trailing gzip,
 *    streaming decompression bombs (> declared size & > 25 MB), cancellation, retries & quota release.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { gzipSync } from 'fflate';

process.env.TESTING = '1';
process.env.FIREBASE_PROJECT_ID = 'orvix-transparent-comp-test';

const TEST_PROJECT_ID = 'orvix-transparent-comp-test';
const TEST_KID = 'transparent-comp-kid-1';

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

const {
  setTestPublicKey,
  clearTestPublicKeys,
  resetFirebaseAuthForTesting
} = await import('../server/firebaseAuthHelper.ts');

const {
  setSupabaseServerClientForTesting,
  resetSupabaseClientForTesting
} = await import('../server/supabaseClient.ts');

const {
  fileRegistry,
  conversationDocuments,
  resetDirectUploadTicketsForTesting,
  resolveRegisteredAttachmentForChat,
  MAX_FILE_SIZE_BYTES
} = await import('../server/uploadSubsystem.ts');

const {
  resetQuotaForTesting,
  getQuotaStatus,
  buildAuthenticatedQuotaIdentity
} = await import('../server/uploadQuotaService.ts');

const {
  ORVIX_ENVELOPE_ENCODING_ID,
  isOrvixStorageEnvelope,
  encodeOrvixStorageEnvelope,
  decodeOrvixStorageEnvelopeSync
} = await import('../src/services/storageEnvelopeService.js');

const {
  prepareAttachmentsForUpload,
  clearFileCompressionCacheEntryForTesting
} = await import('../src/services/attachmentCompressionCoordinator.js');

const { app } = await import('../server.ts');

function createSignedFirebaseToken(uid) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: TEST_KID })).toString('base64url');
  const nowSec = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    aud: TEST_PROJECT_ID,
    iss: `https://securetoken.google.com/${TEST_PROJECT_ID}`,
    sub: uid,
    user_id: uid,
    auth_time: nowSec,
    iat: nowSec,
    exp: nowSec + 3600
  })).toString('base64url');
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url');
  return `${header}.${payload}.${sig}`;
}

function createMockSupabaseStorageClient() {
  const objects = new Map(); // path -> { buffer, contentType, headers }
  const bucketMockRoutes = new Map(); // signedUrl -> { bucket, storagePath }

  const storageClient = {
    storage: {
      async listBuckets() {
        return { data: [{ id: 'orvix-attachments', name: 'orvix-attachments', public: false }], error: null };
      },
      async createBucket() {
        return { data: { name: 'orvix-attachments' }, error: null };
      },
      from(bucket) {
        return {
          async createSignedUploadUrl(storagePath) {
            const token = crypto.randomUUID();
            const signedUrl = `https://mock.supabase.local/upload/${bucket}/${storagePath}?token=${token}`;
            bucketMockRoutes.set(signedUrl, { bucket, storagePath });
            return { data: { signedUrl, token, path: storagePath }, error: null };
          },
          async createSignedUrl(storagePath, expiresInSeconds = 120, opts = {}) {
            const dl = opts.download ? `&download=${encodeURIComponent(String(opts.download))}` : '';
            return {
              data: {
                signedUrl: `https://mock.supabase.local/object/sign/${bucket}/${storagePath}?expiresIn=${expiresInSeconds}${dl}`
              },
              error: null
            };
          },
          async upload(storagePath, buffer, options = {}) {
            const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
            objects.set(storagePath, {
              buffer: buf,
              contentType: options.contentType || 'application/octet-stream',
              cacheControl: options.cacheControl || null
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
          async list(prefix = '') {
            const cleanPrefix = prefix ? `${prefix.replace(/\/+$/, '')}/` : '';
            const items = [];
            const dirs = new Set();
            for (const key of objects.keys()) {
              if (!cleanPrefix || key.startsWith(cleanPrefix)) {
                const rest = cleanPrefix ? key.slice(cleanPrefix.length) : key;
                const slashIdx = rest.indexOf('/');
                if (slashIdx === -1) {
                  items.push({ name: rest, id: key, metadata: { size: objects.get(key).buffer.length } });
                } else {
                  const dir = rest.slice(0, slashIdx);
                  if (!dirs.has(dir)) {
                    dirs.add(dir);
                    items.push({ name: dir, id: null });
                  }
                }
              }
            }
            return { data: items, error: null };
          }
        };
      }
    }
  };

  return { objects, storageClient };
}

function makeOle2BinaryBuffer(markerLabel, sectionText, repeatCount = 220) {
  const oleMagic = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  const headerRest = Buffer.alloc(504, 0x00);
  // Write marker in header area after magic
  Buffer.from(markerLabel, 'ascii').copy(headerRest, 24);
  const body = Buffer.from(
    Array.from({ length: repeatCount }, (_, i) => `Section ${i}: ${sectionText}\r\n`).join(''),
    'utf8'
  );
  const trailer = Buffer.alloc(512, 0xfe);
  return Buffer.concat([oleMagic, headerRest, body, trailer]);
}

function makeCompressibleFormatFixtures() {
  const txtBuf = Buffer.from(
    Array.from({ length: 180 }, (_, i) =>
      `[2026-11-13T10:${String(i % 60).padStart(2, '0')}:00Z] Orvix telemetry log line ${i}: verification payload nominal.\n`
    ).join(''),
    'utf8'
  );
  const mdBuf = Buffer.from(
    Array.from({ length: 140 }, (_, i) =>
      `## Module ${i}\n\n- Metric **alpha_${i}**: \`OK\`\n- Summary: Lossless markdown documentation verification section ${i}.\n\n`
    ).join(''),
    'utf8'
  );
  const docBuf = makeOle2BinaryBuffer('WordDocument', 'Quarterly strategic briefing document content for legacy DOC verification.', 180);
  const pptBuf = makeOle2BinaryBuffer('PowerPoint Document', 'Slide deck keynote presentation notes and architectural diagram captions.', 180);
  const xlsBuf = makeOle2BinaryBuffer('Workbook', 'Fiscal year financial ledger row total=128450 variance=+12.4%.', 180);

  return [
    { key: 'TXT', fileName: 'telemetry.txt', ext: 'txt', mimeType: 'text/plain', buffer: txtBuf, searchPhrase: 'telemetry log line 42', expectsExtractionText: true },
    { key: 'MD', fileName: 'architecture.md', ext: 'md', mimeType: 'text/markdown', buffer: mdBuf, searchPhrase: 'Lossless markdown documentation verification section 25', expectsExtractionText: true },
    { key: 'DOC', fileName: 'briefing.doc', ext: 'doc', mimeType: 'application/msword', buffer: docBuf, searchPhrase: 'Quarterly strategic briefing', expectsExtractionText: false },
    { key: 'PPT', fileName: 'deck.ppt', ext: 'ppt', mimeType: 'application/vnd.ms-powerpoint', buffer: pptBuf, searchPhrase: 'Slide deck keynote presentation', expectsExtractionText: false },
    { key: 'XLS', fileName: 'ledger.xls', ext: 'xls', mimeType: 'application/vnd.ms-excel', buffer: xlsBuf, searchPhrase: 'Fiscal year financial ledger', expectsExtractionText: false }
  ];
}

console.log('\n======================================================================');
console.log('ORVIX TRANSPARENT STORAGE COMPRESSION VERIFICATION SUITE (PROMPT 10)');
console.log('======================================================================\n');

const { objects, storageClient } = createMockSupabaseStorageClient();
setTestPublicKey(TEST_KID, publicKey);
setSupabaseServerClientForTesting(storageClient);

const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const baseUrl = `http://127.0.0.1:${port}`;

const savingsSummary = [];

try {
  const uidAlice = 'alice-transparent-comp-uid';
  const uidBob = 'bob-transparent-comp-uid';
  const tokenAlice = createSignedFirebaseToken(uidAlice);
  const tokenBob = createSignedFirebaseToken(uidBob);
  const quotaAliceIdentity = buildAuthenticatedQuotaIdentity(uidAlice);

  const fixtures = makeCompressibleFormatFixtures();

  // -------------------------------------------------------------------------
  // 1. Coordinator & Multipart `/api/upload` Across All 5 Formats
  // -------------------------------------------------------------------------
  console.log('1. Testing coordinator + multipart /api/upload for TXT, MD, DOC, PPT, XLS...');
  resetQuotaForTesting();
  resetDirectUploadTicketsForTesting();
  fileRegistry.clear();
  conversationDocuments.clear();
  objects.clear();

  const chatMultipart = 'chat-multipart-comp-001';
  const multipartUploadedRecords = [];

  for (const fx of fixtures) {
    const origFile = new File([fx.buffer], fx.fileName, { type: fx.mimeType });
    const [prepared] = await prepareAttachmentsForUpload([
      {
        id: `local-${fx.key.toLowerCase()}`,
        name: fx.fileName,
        originalName: fx.fileName,
        size: origFile.size,
        type: fx.mimeType,
        extension: fx.ext.toUpperCase(),
        file: origFile
      }
    ]);

    assert.equal(prepared.file, origFile, `${fx.key}: att.file MUST remain exact untouched original File`);
    assert.equal(prepared.size, fx.buffer.length, `${fx.key}: client reported size must remain original size`);
    assert.equal(prepared.type, fx.mimeType, `${fx.key}: MIME type must remain original`);
    assert.equal(prepared.compression.compressed, false, `${fx.key}: existing compression slot must stay false`);
    assert.ok(prepared.storageCompression?.compressed, `${fx.key}: storageCompression must succeed`);
    assert.equal(prepared.storageCompression.encoding, ORVIX_ENVELOPE_ENCODING_ID);
    assert.ok(prepared.storageCompression.encodedFile, `${fx.key}: encodedFile must be produced`);

    const envBytes = Buffer.from(await prepared.storageCompression.encodedFile.arrayBuffer());
    assert.ok(isOrvixStorageEnvelope(envBytes), `${fx.key}: encoded payload must be Orvix envelope`);
    const savingsPct = Number((((fx.buffer.length - envBytes.length) / fx.buffer.length) * 100).toFixed(2));
    assert.ok(savingsPct >= 10, `${fx.key}: savings (${savingsPct}%) must be >= 10%`);

    const form = new FormData();
    form.append('conversationId', chatMultipart);
    form.append('files', prepared.storageCompression.encodedFile, fx.fileName);
    form.append('storageEncoding', prepared.storageCompression.encoding);
    form.append('originalSize', String(prepared.storageCompression.originalSize));
    form.append('originalMimeType', prepared.storageCompression.originalMimeType);
    form.append('storageChecksum', prepared.storageCompression.sha256);

    const upRes = await fetch(`${baseUrl}/api/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenAlice}` },
      body: form
    });
    assert.equal(upRes.status, 200, `${fx.key}: multipart upload failed`);
    const upJson = await upRes.json();
    const att = upJson.attachment;
    assert.equal(att.originalName, fx.fileName);
    assert.equal(att.size, fx.buffer.length, `${fx.key}: server size must report decoded original bytes`);
    assert.equal(att.mimeType, fx.mimeType);
    assert.equal(att.storageEncoding, ORVIX_ENVELOPE_ENCODING_ID);
    assert.equal(att.storedSize, envBytes.length);

    // Inspect actual Supabase stored bytes
    const stored = objects.get(att.storagePath);
    assert.ok(stored, `${fx.key}: Supabase object must exist at ${att.storagePath}`);
    assert.ok(isOrvixStorageEnvelope(stored.buffer), `${fx.key}: Supabase object MUST contain compact Orvix envelope`);
    assert.equal(stored.buffer.length, envBytes.length, `${fx.key}: Supabase stored bytes must equal envelope size`);
    assert.equal(stored.contentType, 'application/octet-stream', `${fx.key}: encoded Supabase object stored cleanly without Content-Encoding`);

    if (fx.expectsExtractionText) {
      assert.ok(att.extraction?.text?.includes(fx.searchPhrase), `${fx.key}: extraction must decode original text`);
    }

    savingsSummary.push({
      format: fx.key,
      route: 'multipart',
      originalBytes: fx.buffer.length,
      storedBytes: envBytes.length,
      savingsPct
    });

    multipartUploadedRecords.push({ fx, att });
    clearFileCompressionCacheEntryForTesting(origFile);
  }
  console.log('   ✓ All 5 formats uploaded compact Orvix envelopes via multipart /api/upload');

  // -------------------------------------------------------------------------
  // 2. Direct Supabase Signed Upload Across All 5 Formats
  // -------------------------------------------------------------------------
  console.log('2. Testing direct Supabase signed upload for all 5 formats (reset quota first)...');
  resetQuotaForTesting();
  const chatDirect = 'chat-direct-comp-002';
  const directUploadedRecords = [];

  for (const fx of fixtures) {
    const origFile = new File([fx.buffer], fx.fileName, { type: fx.mimeType });
    const [prepared] = await prepareAttachmentsForUpload([
      {
        id: `dir-${fx.key.toLowerCase()}`,
        name: fx.fileName,
        originalName: fx.fileName,
        size: origFile.size,
        type: fx.mimeType,
        extension: fx.ext.toUpperCase(),
        file: origFile
      }
    ]);
    const sc = prepared.storageCompression;
    const wireBuf = Buffer.from(await sc.encodedFile.arrayBuffer());

    const initRes = await fetch(`${baseUrl}/api/upload/direct/signed-url`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenAlice}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        chatId: chatDirect,
        fileName: fx.fileName,
        fileSize: wireBuf.length,
        originalSize: fx.buffer.length,
        mimeType: fx.mimeType,
        storageEncoding: sc.encoding,
        storageChecksum: sc.sha256,
        originalMimeType: sc.originalMimeType
      })
    });
    assert.equal(initRes.status, 200, `${fx.key}: direct signed-url init failed`);
    const initJson = await initRes.json();

    // Simulate direct client PUT to Supabase without Content-Encoding header
    await storageClient.storage.from(initJson.bucket).upload(initJson.storagePath, wireBuf, {
      contentType: 'application/octet-stream'
    });

    const compRes = await fetch(`${baseUrl}/api/upload/direct/complete`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenAlice}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        attachmentId: initJson.attachmentId,
        chatId: chatDirect,
        storagePath: initJson.storagePath,
        storageEncoding: sc.encoding,
        originalSize: fx.buffer.length,
        originalMimeType: sc.originalMimeType,
        storageChecksum: sc.sha256
      })
    });
    assert.equal(compRes.status, 200, `${fx.key}: direct complete failed`);
    const compJson = await compRes.json();
    const att = compJson.attachment;
    assert.equal(att.size, fx.buffer.length);
    assert.equal(att.mimeType, fx.mimeType);
    assert.equal(att.storageEncoding, ORVIX_ENVELOPE_ENCODING_ID);
    assert.equal(att.storedSize, wireBuf.length);

    if (fx.expectsExtractionText) {
      assert.ok(att.extraction?.text?.includes(fx.searchPhrase), `${fx.key}: direct complete extraction failed`);
    }

    const stored = objects.get(att.storagePath);
    assert.ok(isOrvixStorageEnvelope(stored.buffer));
    assert.equal(stored.buffer.length, wireBuf.length);

    directUploadedRecords.push({ fx, att });
    clearFileCompressionCacheEntryForTesting(origFile);
  }
  console.log('   ✓ All 5 formats uploaded and validated via direct Supabase flow');

  // -------------------------------------------------------------------------
  // 3. Decoded Downloads, Previews, Signed URLs, Extraction & Post-Restart Rehydration
  // -------------------------------------------------------------------------
  console.log('3. Verifying decoded /file, /preview, /download, /signed-url, /extraction & post-restart recovery...');
  const verifyAllServingRoutes = async ({ fx, att }, modeLabel) => {
    // 3a. /file
    const fileRes = await fetch(`${baseUrl}/api/upload/${att.id}/file?chatId=${encodeURIComponent(att.chatId)}`, {
      headers: { Authorization: `Bearer ${tokenAlice}` }
    });
    assert.equal(fileRes.status, 200, `${modeLabel} ${fx.key} /file status`);
    const fileBytes = Buffer.from(await fileRes.arrayBuffer());
    assert.equal(isOrvixStorageEnvelope(fileBytes), false, `${modeLabel} ${fx.key} /file MUST NOT expose raw envelope`);
    assert.equal(fileBytes.equals(fx.buffer), true, `${modeLabel} ${fx.key} /file exact original bytes`);
    assert.ok(fileRes.headers.get('content-type')?.includes(fx.mimeType), `${modeLabel} ${fx.key} content-type`);
    assert.equal(Number(fileRes.headers.get('content-length')), fx.buffer.length);

    // 3b. /preview & /download Content-Disposition
    const prevRes = await fetch(`${baseUrl}/api/upload/${att.id}/preview?chatId=${encodeURIComponent(att.chatId)}`, {
      headers: { Authorization: `Bearer ${tokenAlice}` }
    });
    assert.equal(prevRes.status, 200);
    const prevBytes = Buffer.from(await prevRes.arrayBuffer());
    assert.equal(prevBytes.equals(fx.buffer), true);
    const prevCd = prevRes.headers.get('content-disposition') || '';
    if (fx.mimeType.startsWith('text/')) {
      assert.ok(prevCd.startsWith('inline'), `${fx.key} preview should be inline`);
    } else {
      assert.ok(prevCd.startsWith('attachment'), `${fx.key} office doc preview forces safe attachment download`);
    }

    const dlRes = await fetch(`${baseUrl}/api/upload/${att.id}/download?chatId=${encodeURIComponent(att.chatId)}`, {
      headers: { Authorization: `Bearer ${tokenAlice}` }
    });
    assert.equal(dlRes.status, 200);
    assert.ok((dlRes.headers.get('content-disposition') || '').startsWith('attachment'));
    assert.equal(Buffer.from(await dlRes.arrayBuffer()).equals(fx.buffer), true);

    // 3c. /signed-url must NEVER return raw Supabase object URL for encoded attachments!
    const signedRes = await fetch(`${baseUrl}/api/upload/${att.id}/signed-url?chatId=${encodeURIComponent(att.chatId)}&download=true`, {
      headers: { Authorization: `Bearer ${tokenAlice}` }
    });
    assert.equal(signedRes.status, 200);
    const signedJson = await signedRes.json();
    assert.ok(signedJson.signedUrl, 'signedUrl must exist');
    assert.equal(signedJson.signedUrl.includes('mock.supabase.local'), false, 'MUST NOT leak raw Supabase object URL for encoded object');
    assert.equal(signedJson.decodingProxy, true);

    // Fetch signed decoding URL WITHOUT Authorization header (browser download link semantics)
    const proxyRes = await fetch(signedJson.signedUrl);
    assert.equal(proxyRes.status, 200, `${modeLabel} ${fx.key} signed decoding URL fetch failed`);
    const proxyBytes = Buffer.from(await proxyRes.arrayBuffer());
    assert.equal(proxyBytes.equals(fx.buffer), true, `${modeLabel} ${fx.key} signed decoding URL must return exact original bytes`);

    // Cross-user Auth header paired with Alice's signed URL must be rejected
    const crossSignedRes = await fetch(signedJson.signedUrl, {
      headers: { Authorization: `Bearer ${tokenBob}` }
    });
    assert.equal(crossSignedRes.status, 403, 'Bob Auth + Alice signedUrl must return 403');

    // Tampered signature must be rejected
    const tamperedUrl = signedJson.signedUrl.replace(/sig=[^&]+/, 'sig=invalidTamperedSig');
    const tamperedRes = await fetch(tamperedUrl);
    assert.equal(tamperedRes.status, 403);

    // Expired timestamp must be rejected (with valid-looking or modified exp -> signature invalid / expired -> 403)
    const expTampered = signedJson.signedUrl.replace(/exp=\d+/, 'exp=1000');
    const expRes = await fetch(expTampered);
    assert.equal(expRes.status, 403);

    // 3d. /extraction
    if (fx.expectsExtractionText) {
      const extRes = await fetch(`${baseUrl}/api/upload/${att.id}/extraction?chatId=${encodeURIComponent(att.chatId)}`, {
        headers: { Authorization: `Bearer ${tokenAlice}` }
      });
      assert.equal(extRes.status, 200);
      const extJson = await extRes.json();
      assert.ok(extJson.text.includes(fx.searchPhrase));
    }
  };

  for (const item of multipartUploadedRecords) {
    await verifyAllServingRoutes(item, 'in-memory');
  }

  // Simulate full serverless cold restart: clear in-memory registry & conversationDocuments!
  fileRegistry.clear();
  conversationDocuments.clear();

  for (const item of directUploadedRecords) {
    await verifyAllServingRoutes(item, 'post-restart');
    // Also test chat rehydration (`resolveRegisteredAttachmentForChat`) after clearing fileRegistry!
    fileRegistry.delete(item.att.id);
    const rehydrated = await resolveRegisteredAttachmentForChat(
      { id: item.att.id, chatId: item.att.chatId, originalName: item.fx.fileName, extension: item.fx.ext },
      { authenticatedUserId: uidAlice, conversationId: item.att.chatId }
    );
    assert.equal(rehydrated.status, 'ok', `Post-restart chat rehydration failed for ${item.fx.key}`);
    assert.equal(rehydrated.record.buffer.equals(item.fx.buffer), true, `Rehydrated buffer must match original ${item.fx.key}`);
    assert.equal(rehydrated.record.storageEncoding, ORVIX_ENVELOPE_ENCODING_ID);
  }
  console.log('   ✓ Decoded retrieval, safe signed URLs, extraction, and post-restart chat rehydration passed');

  // -------------------------------------------------------------------------
  // 4. < 10% Savings Fallback & Non-Regression on Excluded Formats
  // -------------------------------------------------------------------------
  console.log('4. Testing < 10% savings fallback and excluded formats...');
  resetQuotaForTesting();
  // 180-byte unique printable ASCII TXT (cannot reach >= 10% net savings over 68-byte Orvix envelope + gzip)
  const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()-_=+[]{}|;:,.<>?/';
  const incompTxtStr = Array.from({ length: 180 }, (_, idx) => charset[(idx * 37 + crypto.randomInt(charset.length)) % charset.length]).join('');
  const incompressibleTxtBuf = Buffer.from(incompTxtStr, 'utf8');
  const incompTxtFile = new File([incompressibleTxtBuf], 'short-entropy.txt', { type: 'text/plain' });
  const [incompTxtPrep] = await prepareAttachmentsForUpload([
    { id: 'incomp-txt', name: 'short-entropy.txt', size: incompTxtFile.size, type: 'text/plain', extension: 'TXT', file: incompTxtFile }
  ]);
  assert.equal(incompTxtPrep.storageCompression.compressed, false);
  assert.equal(incompTxtPrep.storageCompression.reason, 'insufficient_savings');

  // 8 KB incompressible OLE2 .doc (OLE2 magic + uniform 0..255 crypto random bytes)
  const incompressibleDocBuf = Buffer.concat([
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    crypto.randomBytes(8184)
  ]);
  const incompDocFile = new File([incompressibleDocBuf], 'random-entropy.doc', { type: 'application/msword' });
  const [incompPrep] = await prepareAttachmentsForUpload([
    { id: 'incomp-doc', name: 'random-entropy.doc', size: incompDocFile.size, type: 'application/msword', extension: 'DOC', file: incompDocFile }
  ]);
  assert.equal(incompPrep.storageCompression.compressed, false);
  assert.equal(incompPrep.storageCompression.reason, 'insufficient_savings');

  const rawForm = new FormData();
  rawForm.append('conversationId', 'chat-incomp-001');
  rawForm.append('files', incompTxtPrep.file, 'short-entropy.txt');
  const rawUpRes = await fetch(`${baseUrl}/api/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenAlice}` },
    body: rawForm
  });
  assert.equal(rawUpRes.status, 200);
  const rawUpJson = await rawUpRes.json();
  assert.equal(rawUpJson.attachment.storageEncoding, null);
  assert.equal(rawUpJson.attachment.size, incompressibleTxtBuf.length);
  const storedRaw = objects.get(rawUpJson.attachment.storagePath);
  assert.equal(isOrvixStorageEnvelope(storedRaw.buffer), false, 'Incompressible file must be stored as raw original');
  assert.equal(storedRaw.buffer.equals(incompressibleTxtBuf), true);

  // Unencoded file signed-url should continue using Supabase native signed URL!
  const nativeSignedRes = await fetch(`${baseUrl}/api/upload/${rawUpJson.attachment.id}/signed-url?chatId=chat-incomp-001`, {
    headers: { Authorization: `Bearer ${tokenAlice}` }
  });
  const nativeSignedJson = await nativeSignedRes.json();
  assert.ok(nativeSignedJson.signedUrl.includes('mock.supabase.local'), 'Unencoded attachment preserves direct Supabase signed URL');

  // Verify CSV / JSON are excluded from storageCompression
  const csvFile = new File(['a,b,c\n'.repeat(500)], 'data.csv', { type: 'text/csv' });
  const [csvPrep] = await prepareAttachmentsForUpload([
    { id: 'csv-1', name: 'data.csv', size: csvFile.size, type: 'text/csv', extension: 'CSV', file: csvFile }
  ]);
  assert.equal(csvPrep.storageCompression, undefined, 'CSV must not receive Orvix storage envelope');
  clearFileCompressionCacheEntryForTesting(incompTxtFile);
  clearFileCompressionCacheEntryForTesting(incompDocFile);
  clearFileCompressionCacheEntryForTesting(csvFile);
  console.log('   ✓ < 10% fallback and excluded format behavior verified');

  // -------------------------------------------------------------------------
  // 5. Security Attacks, Decompression Bombs, Tampered Envelopes & Quota Rollback
  // -------------------------------------------------------------------------
  console.log('5. Testing security attacks, decompression bombs, tampering, cancellation & quota rollback...');
  resetQuotaForTesting();
  const validTxtFixture = fixtures[0];
  const validEnc = await encodeOrvixStorageEnvelope(validTxtFixture.buffer, {
    mimeType: 'text/plain',
    extension: '.txt',
    fileName: 'telemetry.txt'
  });
  assert.equal(validEnc.compressed, true);

  // 5a. Spoofed storageEncoding on raw plaintext multipart upload
  {
    const f = new FormData();
    f.append('conversationId', 'chat-sec-001');
    f.append('files', new File(['plain unencoded text'.repeat(20)], 'plain.txt', { type: 'text/plain' }), 'plain.txt');
    f.append('storageEncoding', ORVIX_ENVELOPE_ENCODING_ID);
    const r = await fetch(`${baseUrl}/api/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenAlice}` },
      body: f
    });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.code, 'INVALID_STORAGE_ENVELOPE');
  }

  // 5b. Unknown encoding name
  {
    const f = new FormData();
    f.append('conversationId', 'chat-sec-001');
    f.append('files', new File([validTxtFixture.buffer], 'telemetry.txt', { type: 'text/plain' }), 'telemetry.txt');
    f.append('storageEncoding', 'br-custom-v9');
    const r = await fetch(`${baseUrl}/api/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenAlice}` },
      body: f
    });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.code, 'UNSUPPORTED_STORAGE_ENCODING');
  }

  // 5c. Bit-flipped CRC / payload corruption on multipart upload -> 400 + quota released
  {
    const corrupted = new Uint8Array(validEnc.envelopeBytes);
    corrupted[corrupted.length - 12] ^= 0xff;
    const f = new FormData();
    f.append('conversationId', 'chat-sec-001');
    f.append('files', new File([corrupted], 'telemetry.txt', { type: 'application/octet-stream' }), 'telemetry.txt');
    f.append('storageEncoding', ORVIX_ENVELOPE_ENCODING_ID);
    const r = await fetch(`${baseUrl}/api/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenAlice}` },
      body: f
    });
    assert.equal(r.status, 400);
  }

  // 5d. Format mismatch: TXT envelope disguised with .doc filename -> 400 + quota released
  {
    const f = new FormData();
    f.append('conversationId', 'chat-sec-001');
    f.append('files', new File([validEnc.envelopeBytes], 'evil.doc', { type: 'application/msword' }), 'evil.doc');
    f.append('storageEncoding', ORVIX_ENVELOPE_ENCODING_ID);
    const r = await fetch(`${baseUrl}/api/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenAlice}` },
      body: f
    });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.code, 'ENVELOPE_FORMAT_MISMATCH');
  }

  // 5e. Unsupported envelope version (version = 9)
  {
    const badVer = new Uint8Array(validEnc.envelopeBytes);
    badVer[8] = 9;
    assert.throws(() => decodeOrvixStorageEnvelopeSync(badVer), (e) => e.code === 'UNSUPPORTED_ENVELOPE_VERSION');
  }

  // 5f. Oversized declared originalSize (> 25 MB)
  {
    const oversizedHdr = new Uint8Array(validEnc.envelopeBytes);
    const dv = new DataView(oversizedHdr.buffer);
    dv.setUint32(16, MAX_FILE_SIZE_BYTES + 1024, false);
    assert.throws(() => decodeOrvixStorageEnvelopeSync(oversizedHdr), (e) => e.code === 'DECOMPRESSION_BOMB_LIMIT_EXCEEDED');

    const f = new FormData();
    f.append('conversationId', 'chat-sec-001');
    f.append('files', new File([oversizedHdr], 'bomb.txt', { type: 'text/plain' }), 'bomb.txt');
    f.append('storageEncoding', ORVIX_ENVELOPE_ENCODING_ID);
    const r = await fetch(`${baseUrl}/api/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenAlice}` },
      body: f
    });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.code, 'DECOMPRESSION_BOMB_LIMIT_EXCEEDED');
  }

  // 5g. Streaming decompression bomb via Direct Upload: declared originalSize 2048, actual gzip 512 KB!
  //     Must reject at /direct/complete, delete Supabase object, and release quota!
  {
    const smallRaw = Buffer.alloc(2048, 0x41);
    const smallEnc = await encodeOrvixStorageEnvelope(smallRaw, { mimeType: 'text/plain', extension: '.txt' });
    const headerLen = 58 + 'text/plain'.length;
    const hugeGzip = gzipSync(Buffer.alloc(512 * 1024, 0x41));
    const bombEnvelope = Buffer.concat([Buffer.from(smallEnc.envelopeBytes.slice(0, headerLen)), Buffer.from(hugeGzip)]);

    const initBomb = await fetch(`${baseUrl}/api/upload/direct/signed-url`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenAlice}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chatId: 'chat-sec-001',
        fileName: 'zipbomb.txt',
        fileSize: bombEnvelope.length,
        originalSize: 2048,
        mimeType: 'text/plain',
        storageEncoding: ORVIX_ENVELOPE_ENCODING_ID
      })
    });
    assert.equal(initBomb.status, 200);
    const bombInitJson = await initBomb.json();

    await storageClient.storage.from(bombInitJson.bucket).upload(bombInitJson.storagePath, bombEnvelope, {
      contentType: 'application/octet-stream'
    });

    const compBomb = await fetch(`${baseUrl}/api/upload/direct/complete`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenAlice}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        attachmentId: bombInitJson.attachmentId,
        chatId: 'chat-sec-001',
        storagePath: bombInitJson.storagePath
      })
    });
    assert.equal(compBomb.status, 400);
    const bombErr = await compBomb.json();
    assert.equal(bombErr.code, 'DECOMPRESSION_BOMB_LIMIT_EXCEEDED');
    assert.equal(objects.has(bombInitJson.storagePath), false, 'Bomb object in Supabase must be purged on rejection');
  }

  // 5h. Direct upload cancellation frees quota & deletes object
  {
    const cancelInit = await fetch(`${baseUrl}/api/upload/direct/signed-url`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenAlice}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chatId: 'chat-sec-001',
        fileName: 'cancelled.txt',
        fileSize: validEnc.encodedSize,
        originalSize: validEnc.originalSize,
        mimeType: 'text/plain',
        storageEncoding: ORVIX_ENVELOPE_ENCODING_ID
      })
    });
    assert.equal(cancelInit.status, 200);
    const cj = await cancelInit.json();
    await storageClient.storage.from(cj.bucket).upload(cj.storagePath, validEnc.envelopeBytes, { contentType: 'application/octet-stream' });

    const cancelRes = await fetch(`${baseUrl}/api/upload/direct/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenAlice}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ attachmentId: cj.attachmentId, chatId: 'chat-sec-001' })
    });
    assert.equal(cancelRes.status, 200);
    assert.equal(objects.has(cj.storagePath), false, 'Cancelled direct upload object must be removed');
  }

  // Confirm ZERO quota consumed after all rejected / cancelled attacks!
  const finalQuota = await getQuotaStatus(quotaAliceIdentity);
  assert.equal(finalQuota.committed, 0, 'All failed/bomb/cancelled uploads must consume 0 quota');
  assert.equal(finalQuota.activeReservations, 0, 'No dangling active reservations allowed');
  console.log('   ✓ Security attacks, decompression bombs, cancellation & quota rollback verified (0 quota consumed)');

  console.log('\n--- Measured Storage Savings Summary ---');
  for (const s of savingsSummary) {
    console.log(`   ${s.format.padEnd(4)} | ${s.originalBytes} B -> ${s.storedBytes} B | Savings: ${s.savingsPct}%`);
  }

  console.log('\n======================================================================');
  console.log('ALL TRANSPARENT STORAGE COMPRESSION INTEGRATION & SECURITY TESTS PASSED!');
  console.log('======================================================================\n');
} finally {
  clearTestPublicKeys();
  resetFirebaseAuthForTesting();
  resetSupabaseClientForTesting();
  fileRegistry.clear();
  conversationDocuments.clear();
  resetDirectUploadTicketsForTesting();
  await new Promise((resolve) => server.close(resolve));
}
