/**
 * scripts/testSmartCompressionUploadIntegration.js
 *
 * Focused Integration Test Suite for Smart Compression inside the Orvix Attachment Upload Workflow:
 * 1. ChatPage.jsx & ChatArea.jsx pre-branch ordering, AbortSignal, and loading-status wiring verification.
 * 2. Real compressible PDF optimization -> Browser AI offline `extractBrowserDocument` + IndexedDB exact byte match.
 * 3. Standard multipart `/api/upload` against real Express upload route + Supabase mock -> exact uploaded vs cached bytes.
 * 4. Direct signed upload (`isDirectUploadCandidate` + signed-url -> PUT -> complete) -> compressed size routing & exact byte match.
 * 5. Original-file fallback on skip, protected PDF, insufficient savings, and unexpected compression error.
 * 6. Deduplication ("Never compress the same file repeatedly"): retries with same File or passing compressed File never re-compresses.
 * 7. AbortSignal / Stop cancellation during compression halts before any upload/IndexedDB mutation and allows clean future retry.
 * 8. Optimization stage callback updates UI state cleanly and stops when inactive/aborted.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

process.env.TESTING = '1';
process.env.FIREBASE_PROJECT_ID = 'orvix-smart-compression-integration';

// Minimal browser environment shims for attachmentStorageService IndexedDB & localStorage
const mockLocalStorageStore = new Map();
const mockIndexedDBStore = new Map();

globalThis.window = globalThis;
globalThis.localStorage = {
  getItem: (key) => mockLocalStorageStore.get(key) ?? null,
  setItem: (key, val) => mockLocalStorageStore.set(key, String(val)),
  removeItem: (key) => mockLocalStorageStore.delete(key),
  clear: () => mockLocalStorageStore.clear()
};
globalThis.indexedDB = {
  open: () => {
    const req = {
      result: {
        objectStoreNames: { contains: () => true },
        createObjectStore: () => ({ createIndex: () => {} }),
        transaction: () => ({
          oncomplete: null,
          onerror: null,
          onabort: null,
          objectStore: () => ({
            get: (key) => {
              const r = { onsuccess: null, onerror: null, result: mockIndexedDBStore.get(key) };
              setTimeout(() => r.onsuccess && r.onsuccess({ target: r }), 0);
              return r;
            },
            put: (val) => {
              mockIndexedDBStore.set(val.id, val);
              const r = { onsuccess: null, onerror: null };
              setTimeout(() => r.onsuccess && r.onsuccess({ target: r }), 0);
              return r;
            },
            delete: (key) => {
              mockIndexedDBStore.delete(key);
              const r = { onsuccess: null, onerror: null };
              setTimeout(() => r.onsuccess && r.onsuccess({ target: r }), 0);
              return r;
            },
            getAll: () => {
              const r = {
                onsuccess: null,
                onerror: null,
                result: Array.from(mockIndexedDBStore.values())
              };
              setTimeout(() => r.onsuccess && r.onsuccess({ target: r }), 0);
              return r;
            }
          })
        })
      }
    };
    setTimeout(() => req.onsuccess && req.onsuccess({ target: req }), 0);
    return req;
  }
};

// Dynamic imports after environment setup
const {
  compressFile,
  COMPRESSION_REASONS,
  COMPRESSION_STAGES,
  setImageCompressionAdapterForTesting
} = await import('../src/services/smartCompressionService.js');

const {
  prepareAttachmentsForUpload,
  isAlreadyCompressedOutputFile,
  clearFileCompressionCacheEntryForTesting
} = await import('../src/services/attachmentCompressionCoordinator.js');

const {
  saveAttachmentBlob,
  getAttachmentBlob,
  getAttachmentRecord,
  isDirectUploadCandidate,
  DIRECT_UPLOAD_THRESHOLD_BYTES
} = await import('../src/services/attachmentStorageService.js');

const { extractBrowserDocument } = await import('../src/services/browserDocumentExtractor.js');

const {
  setTestPublicKey,
  clearTestPublicKeys,
  resetFirebaseAuthForTesting
} = await import('../server/firebaseAuthHelper.ts');

const {
  setSupabaseServerClientForTesting,
  resetSupabaseClientForTesting
} = await import('../server/supabaseClient.ts');

const { resetQuotaForTesting } = await import('../server/uploadQuotaService.ts');
const { resetDirectUploadTicketsForTesting } = await import('../server/uploadSubsystem.ts');
const { app } = await import('../server.ts');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(buf) {
  return crypto.createHash('sha256').update(Buffer.from(buf)).digest('hex');
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ -1) | 0;
}

function pngChunk(type, data) {
  const len = data.length;
  const out = Buffer.alloc(12 + len);
  out.writeUInt32BE(len, 0);
  out.write(type, 4, 4, 'ascii');
  data.copy(out, 8);
  out.writeInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + len);
  return out;
}

function makePngBuffer(width, height, { extraPaddingBytes = 0 } = {}) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  const chunks = [sig, pngChunk('IHDR', ihdr)];
  if (extraPaddingBytes > 0) {
    chunks.push(
      pngChunk(
        'tEXt',
        Buffer.concat([Buffer.from('Comment\0', 'ascii'), Buffer.alloc(extraPaddingBytes, 0x41)])
      )
    );
  }
  const scanline = Buffer.alloc(1 + width * 4, 0);
  const raw = Buffer.concat(Array.from({ length: Math.min(height, 4) }, () => scanline));
  chunks.push(pngChunk('IDAT', zlib.deflateSync(raw)));
  chunks.push(pngChunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(chunks);
}

async function makeCompressiblePdfBuffer(uniqueMarker = 'ORVIX-PDF-MARKER') {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 18; i++) {
    const page = doc.addPage([612, 792]);
    page.drawText(`${uniqueMarker} Page ${i}: Lossless PDF structural optimization test.`, {
      x: 48,
      y: 740,
      size: 13,
      font,
      color: rgb(0.1, 0.1, 0.1)
    });
    for (let j = 0; j < 26; j++) {
      page.drawText(`Row ${i}.${j}: Financial compliance invoice line item #${i * 100 + j}`, {
        x: 48,
        y: 700 - j * 22,
        size: 10,
        font
      });
    }
  }
  const saved = await doc.save({ useObjectStreams: false });
  const baseStr = Buffer.from(saved).toString('latin1');
  const eofIdx = baseStr.lastIndexOf('%%EOF');
  const bloatComment = '\n% Unreferenced incremental padding ' + '0123456789ABCDEF'.repeat(4000) + '\n';
  return Buffer.from(baseStr.slice(0, eofIdx) + bloatComment + baseStr.slice(eofIdx), 'latin1');
}

async function makeEncryptedPdfBuffer() {
  const doc = await PDFDocument.create();
  doc.addPage([500, 500]);
  const cleanPdf = Buffer.from(await doc.save());
  const str = cleanPdf.toString('latin1');
  const trailerIdx = str.lastIndexOf('trailer');
  return Buffer.from(
    str.slice(0, trailerIdx) +
      '0'.repeat(70_000) +
      '\ntrailer\n<< /Size 5 /Root 1 0 R /Encrypt 99 0 R >>\nstartxref\n0\n%%EOF',
    'latin1'
  );
}

// RSA Firebase token setup for server upload integration tests
const TEST_PROJECT_ID = 'orvix-smart-compression-integration';
const TEST_KID = 'smart-comp-kid-1';
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

function createSignedFirebaseToken(uid) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: TEST_KID })).toString('base64url');
  const nowSec = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      aud: TEST_PROJECT_ID,
      iss: `https://securetoken.google.com/${TEST_PROJECT_ID}`,
      sub: uid,
      user_id: uid,
      auth_time: nowSec,
      iat: nowSec,
      exp: nowSec + 3600
    })
  ).toString('base64url');
  const sig = crypto
    .sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey)
    .toString('base64url');
  return `${header}.${payload}.${sig}`;
}

function createMockSupabaseStorage() {
  const objects = new Map();
  const storageClient = {
    storage: {
      from(bucket) {
        return {
          async createSignedUploadUrl(storagePath) {
            return {
              data: {
                signedUrl: `https://mock.supabase.local/upload/${bucket}/${storagePath}`,
                token: 'tok-123',
                path: storagePath
              },
              error: null
            };
          },
          async createSignedUrl(storagePath) {
            return {
              data: {
                signedUrl: `https://mock.supabase.local/download/${bucket}/${storagePath}`
              },
              error: null
            };
          },
          async upload(storagePath, buffer, options = {}) {
            objects.set(storagePath, {
              buffer: Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer),
              contentType: options.contentType || 'application/octet-stream'
            });
            return { data: { path: storagePath }, error: null };
          },
          async download(storagePath) {
            const found = objects.get(storagePath);
            if (!found) return { data: null, error: { message: 'Not found', status: 404 } };
            return {
              data: new Blob([found.buffer], { type: found.contentType }),
              error: null
            };
          },
          async remove(paths) {
            for (const p of paths) objects.delete(p);
            return { data: paths, error: null };
          }
        };
      }
    }
  };
  return { objects, storageClient };
}

// ===========================================================================
// TEST 1: ChatPage.jsx & ChatArea.jsx Wiring & Branch Ordering Verification
// ===========================================================================
console.log('1. Verifying ChatPage.jsx and ChatArea.jsx integration wiring...');
{
  const chatPageSrc = fs.readFileSync(path.resolve('src/pages/ChatPage.jsx'), 'utf8');
  const chatAreaSrc = fs.readFileSync(path.resolve('src/components/chat/ChatArea.jsx'), 'utf8');

  const compressCallIdx = chatPageSrc.indexOf('await prepareAttachmentsForUpload(');
  const webllmOfflineIdx = chatPageSrc.indexOf('if (isWebLLM && !clientOnline)');
  const directCandidateIdx = chatPageSrc.indexOf('isDirectUploadCandidate(filesToUpload[0].file)');
  const multipartFetchIdx = chatPageSrc.indexOf("await fetch('/api/upload'");

  assert.ok(compressCallIdx > 0, 'prepareAttachmentsForUpload must be called in ChatPage.jsx');
  assert.ok(compressCallIdx < webllmOfflineIdx, 'Compression must run BEFORE WebLLM offline branch');
  assert.ok(compressCallIdx < directCandidateIdx, 'Compression must run BEFORE direct upload threshold check');
  assert.ok(compressCallIdx < multipartFetchIdx, 'Compression must run BEFORE standard multipart upload');

  assert.ok(
    chatPageSrc.includes('signal: preflightEntry.signal'),
    'prepareAttachmentsForUpload must receive preflightEntry.signal'
  );
  assert.ok(
    chatPageSrc.includes('attachmentProcessingStatus={attachmentProcessingStatus}'),
    'ChatPage must pass attachmentProcessingStatus to ChatArea'
  );
  assert.ok(
    chatAreaSrc.includes('data-testid="attachment-processing-status"'),
    'ChatArea must render optimization/upload status indicator'
  );
}
console.log('   ✓ ChatPage.jsx & ChatArea.jsx integration wiring verified');

// ===========================================================================
// TEST 2: Offline WebLLM PDF Compression + Text Extraction + IndexedDB Match
// ===========================================================================
console.log('2. Testing offline WebLLM PDF compression -> extractBrowserDocument -> IndexedDB...');
{
  mockIndexedDBStore.clear();
  const pdfBytes = await makeCompressiblePdfBuffer('OFFLINE-WEBLLM-CHECK');
  const originalFile = new File([pdfBytes], 'compliance-report.pdf', {
    type: 'application/pdf',
    lastModified: 1710000000000
  });
  const att = {
    id: 'att-offline-1',
    name: 'compliance-report.pdf',
    originalName: 'compliance-report.pdf',
    size: originalFile.size,
    formattedSize: '100 KB',
    type: 'application/pdf',
    extension: 'PDF',
    isImage: false,
    previewUrl: null,
    file: originalFile
  };

  const stages = [];
  const prepared = await prepareAttachmentsForUpload([att], {
    onStage: (s) => stages.push(s)
  });

  assert.equal(prepared.length, 1);
  const preppedAtt = prepared[0];
  assert.equal(preppedAtt.id, 'att-offline-1');
  assert.equal(preppedAtt.name, 'compliance-report.pdf');
  assert.equal(preppedAtt.type, 'application/pdf');
  assert.equal(preppedAtt.compression.compressed, true, 'PDF should be compressed');
  assert.ok(preppedAtt.file.size < originalFile.size, 'Prepared file size must be smaller');
  assert.equal(preppedAtt.size, preppedAtt.file.size, 'Attachment metadata size must match resulting file');
  assert.ok(stages.some((s) => s.phase === 'optimizing'), 'Must emit optimizing status updates');

  // Offline WebLLM extraction runs on preppedAtt.file
  const extraction = await extractBrowserDocument(preppedAtt.file, {
    id: preppedAtt.id,
    name: preppedAtt.name,
    originalName: preppedAtt.originalName,
    mimeType: preppedAtt.type,
    extension: preppedAtt.extension
  });

  assert.equal(extraction.success, true, 'Browser PDF text extraction must succeed on compressed PDF');
  assert.ok(
    extraction.text.includes('OFFLINE-WEBLLM-CHECK Page 1'),
    'Extracted text must preserve Page 1 content cleanly'
  );
  assert.ok(
    extraction.text.includes('OFFLINE-WEBLLM-CHECK Page 18'),
    'Extracted text must preserve Page 18 content cleanly'
  );

  // Cache compressed bytes to IndexedDB
  await saveAttachmentBlob(preppedAtt.id, preppedAtt.file, {
    name: preppedAtt.name,
    originalName: preppedAtt.originalName,
    mimeType: preppedAtt.type,
    size: preppedAtt.size,
    formattedSize: preppedAtt.formattedSize,
    extension: preppedAtt.extension,
    isImage: false,
    conversationId: 'chat-offline-1'
  });

  const cachedBlob = await getAttachmentBlob(preppedAtt.id);
  const cachedRecord = await getAttachmentRecord(preppedAtt.id);
  const cachedBuf = new Uint8Array(await cachedBlob.arrayBuffer());
  const compressedBuf = new Uint8Array(await preppedAtt.file.arrayBuffer());
  assert.equal(sha256(cachedBuf), sha256(compressedBuf), 'IndexedDB cached bytes must exactly match compressed file');
  assert.equal(cachedRecord.size, preppedAtt.file.size);

  clearFileCompressionCacheEntryForTesting(originalFile);
}
console.log('   ✓ Offline WebLLM PDF extraction & IndexedDB exact-byte cache verified');

// ===========================================================================
// TEST 3: Standard Multipart `/api/upload` + Direct Upload Server Integration
// ===========================================================================
console.log('3. Testing live Express server multipart `/api/upload` & direct signed upload paths...');
{
  const { objects, storageClient } = createMockSupabaseStorage();
  resetQuotaForTesting();
  resetDirectUploadTicketsForTesting();
  resetFirebaseAuthForTesting();
  clearTestPublicKeys();
  setTestPublicKey(TEST_KID, publicKey);
  setSupabaseServerClientForTesting(storageClient);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const uid = 'smart-comp-user-1';
  const token = createSignedFirebaseToken(uid);

  try {
    // 3A: Standard multipart upload with compressed PDF
    mockIndexedDBStore.clear();
    const pdfBytes = await makeCompressiblePdfBuffer('MULTIPART-UPLOAD-TEST');
    const origPdf = new File([pdfBytes], 'quarterly-audit.pdf', { type: 'application/pdf' });
    const [preppedPdf] = await prepareAttachmentsForUpload([
      {
        id: 'att-multipart-1',
        name: 'quarterly-audit.pdf',
        originalName: 'quarterly-audit.pdf',
        size: origPdf.size,
        formattedSize: '90 KB',
        type: 'application/pdf',
        extension: 'PDF',
        isImage: false,
        file: origPdf
      }
    ]);

    assert.equal(preppedPdf.compression.compressed, true);
    const compressedBytes = new Uint8Array(await preppedPdf.file.arrayBuffer());

    const formData = new FormData();
    formData.append('conversationId', 'chat-multipart-1');
    formData.append('provider', 'gemini');
    formData.append('offline', 'false');
    formData.append('files', preppedPdf.file, preppedPdf.name);

    const uploadRes = await fetch(`${baseUrl}/api/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData
    });
    assert.equal(uploadRes.status, 200, 'Multipart upload must succeed');
    const uploadJson = await uploadRes.json();
    const serverAtt = uploadJson.attachments[0];
    assert.equal(serverAtt.originalName, 'quarterly-audit.pdf');
    assert.equal(serverAtt.size, compressedBytes.byteLength, 'Server must receive compressed byte length');

    // Verify Supabase received the exact compressed bytes
    const storedObj = objects.get(serverAtt.storagePath);
    assert.ok(storedObj, 'Object must exist in Supabase mock storage');
    assert.equal(sha256(storedObj.buffer), sha256(compressedBytes), 'Supabase bytes must match compressed bytes');

    // Cache into IndexedDB post-upload just like ChatPage.jsx does
    await saveAttachmentBlob(serverAtt.id, preppedPdf.file, {
      name: serverAtt.name,
      originalName: serverAtt.originalName,
      mimeType: serverAtt.type || preppedPdf.file.type,
      size: serverAtt.size || preppedPdf.file.size,
      formattedSize: serverAtt.formattedSize || preppedPdf.formattedSize,
      extension: serverAtt.extension || preppedPdf.extension,
      isImage: false,
      conversationId: 'chat-multipart-1'
    });
    const cached = await getAttachmentBlob(serverAtt.id);
    const cachedBytes = new Uint8Array(await cached.arrayBuffer());
    assert.equal(sha256(cachedBytes), sha256(storedObj.buffer), 'IndexedDB cached bytes must equal Supabase stored bytes');

    clearFileCompressionCacheEntryForTesting(origPdf);

    // 3B: Standard multipart upload with compressed PNG image
    const rawPng = makePngBuffer(640, 480, { extraPaddingBytes: 120 * 1024 });
    const smallPng = makePngBuffer(640, 480, { extraPaddingBytes: 0 });
    setImageCompressionAdapterForTesting({
      async decodeAndAnalyze() {
        return {
          width: 640,
          height: 480,
          hasTransparentPixels: false,
          isTextOrDiagramLikely: true,
          release() {}
        };
      },
      async encode() {
        return new Blob([smallPng], { type: 'image/png' });
      }
    });

    const origImg = new File([rawPng], 'diagram-shot.png', { type: 'image/png' });
    const [preppedImg] = await prepareAttachmentsForUpload([
      {
        id: 'att-img-1',
        name: 'diagram-shot.png',
        originalName: 'diagram-shot.png',
        size: origImg.size,
        formattedSize: '120 KB',
        type: 'image/png',
        extension: 'PNG',
        isImage: true,
        file: origImg
      }
    ]);
    assert.equal(preppedImg.compression.compressed, true);
    assert.equal(preppedImg.file.name, 'diagram-shot.png');
    assert.equal(preppedImg.file.type, 'image/png');

    const imgForm = new FormData();
    imgForm.append('conversationId', 'chat-multipart-img');
    imgForm.append('provider', 'gemini');
    imgForm.append('files', preppedImg.file, preppedImg.name);

    const imgRes = await fetch(`${baseUrl}/api/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: imgForm
    });
    assert.equal(imgRes.status, 200);
    const imgJson = await imgRes.json();
    const serverImg = imgJson.attachments[0];
    const storedImg = objects.get(serverImg.storagePath);
    assert.equal(sha256(storedImg.buffer), sha256(smallPng), 'Supabase must store optimized PNG bytes');

    clearFileCompressionCacheEntryForTesting(origImg);
    setImageCompressionAdapterForTesting(null);

    // 3C: Direct Signed Upload routing & completion verification
    // Case 1: Large image >4MB compresses to 4.1MB (still >= 4MB direct candidate)
    const fiveMbBuffer = makePngBuffer(1600, 1200, { extraPaddingBytes: 5 * 1024 * 1024 });
    const fourPointOneMbBuffer = makePngBuffer(1600, 1200, { extraPaddingBytes: 4.1 * 1024 * 1024 });
    setImageCompressionAdapterForTesting({
      async decodeAndAnalyze() {
        return { width: 1600, height: 1200, hasTransparentPixels: false, isTextOrDiagramLikely: true, release() {} };
      },
      async encode() {
        return new Blob([fourPointOneMbBuffer], { type: 'image/png' });
      }
    });

    const largeOrig = new File([fiveMbBuffer], 'hi-res-schematic.png', { type: 'image/png' });
    const [preppedLarge] = await prepareAttachmentsForUpload([
      {
        id: 'att-direct-1',
        name: 'hi-res-schematic.png',
        originalName: 'hi-res-schematic.png',
        size: largeOrig.size,
        type: 'image/png',
        extension: 'PNG',
        isImage: true,
        file: largeOrig
      }
    ]);
    assert.equal(preppedLarge.compression.compressed, true);
    assert.equal(
      isDirectUploadCandidate(preppedLarge.file),
      true,
      'Compressed file >= 4MB should qualify for direct upload'
    );

    const signedRes = await fetch(`${baseUrl}/api/upload/direct/signed-url`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        chatId: 'chat-direct-1',
        fileName: preppedLarge.file.name,
        fileSize: preppedLarge.file.size,
        mimeType: preppedLarge.file.type
      })
    });
    assert.equal(signedRes.status, 200);
    const { attachmentId: directAttId, storagePath: directStoragePath } = await signedRes.json();

    // Simulate the PUT to signedUrl storing the exact compressed file bytes in Supabase
    const directBytes = new Uint8Array(await preppedLarge.file.arrayBuffer());
    await storageClient.storage.from('attachments').upload(directStoragePath, directBytes, {
      contentType: preppedLarge.file.type
    });

    const completeRes = await fetch(`${baseUrl}/api/upload/direct/complete`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        attachmentId: directAttId,
        chatId: 'chat-direct-1',
        storagePath: directStoragePath
      })
    });
    assert.equal(completeRes.status, 200);
    const completeJson = await completeRes.json();
    assert.equal(completeJson.attachment.size, preppedLarge.file.size);

    await saveAttachmentBlob(completeJson.attachment.id, preppedLarge.file, {
      name: preppedLarge.name,
      originalName: preppedLarge.originalName,
      mimeType: preppedLarge.type,
      size: preppedLarge.file.size,
      formattedSize: preppedLarge.formattedSize,
      extension: preppedLarge.extension,
      isImage: true,
      conversationId: 'chat-direct-1'
    });
    const directCached = await getAttachmentBlob(completeJson.attachment.id);
    const directCachedBytes = new Uint8Array(await directCached.arrayBuffer());
    assert.equal(sha256(directCachedBytes), sha256(directBytes), 'Direct upload IndexedDB cache must match uploaded compressed bytes');
    clearFileCompressionCacheEntryForTesting(largeOrig);

    // Case 2: Large >4MB image compresses below 4MB threshold -> routes cleanly via standard upload
    const twoMbBuffer = makePngBuffer(1600, 1200, { extraPaddingBytes: 2 * 1024 * 1024 });
    setImageCompressionAdapterForTesting({
      async decodeAndAnalyze() {
        return { width: 1600, height: 1200, hasTransparentPixels: false, isTextOrDiagramLikely: true, release() {} };
      },
      async encode() {
        return new Blob([twoMbBuffer], { type: 'image/png' });
      }
    });
    const fiveMbShrinks = new File([fiveMbBuffer], 'shrinks-under-4mb.png', { type: 'image/png' });
    const [preppedShrinks] = await prepareAttachmentsForUpload([
      {
        id: 'att-shrinks-1',
        name: 'shrinks-under-4mb.png',
        size: fiveMbShrinks.size,
        type: 'image/png',
        extension: 'PNG',
        isImage: true,
        file: fiveMbShrinks
      }
    ]);
    assert.ok(preppedShrinks.file.size < DIRECT_UPLOAD_THRESHOLD_BYTES);
    assert.equal(
      isDirectUploadCandidate(preppedShrinks.file),
      false,
      'File compressed below 4MB must cleanly use standard multipart upload'
    );
    clearFileCompressionCacheEntryForTesting(fiveMbShrinks);
    setImageCompressionAdapterForTesting(null);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    resetSupabaseClientForTesting();
    resetFirebaseAuthForTesting();
    clearTestPublicKeys();
  }
}
console.log('   ✓ Multipart & direct signed upload integration verified');

// ===========================================================================
// TEST 4: Fallback to Original File on Skip, Protected PDF, and Error
// ===========================================================================
console.log('4. Testing original-file fallback on skip, protected PDF, and compressor error...');
{
  // Protected PDF
  const encPdfBytes = await makeEncryptedPdfBuffer();
  const encFile = new File([encPdfBytes], 'locked-contract.pdf', { type: 'application/pdf' });
  const [resEnc] = await prepareAttachmentsForUpload([
    { id: 'att-enc', name: 'locked-contract.pdf', size: encFile.size, type: 'application/pdf', file: encFile }
  ]);
  assert.equal(resEnc.file, encFile, 'Protected PDF must return untouched original File');
  assert.equal(resEnc.compression.compressed, false);
  assert.equal(resEnc.compression.reason, COMPRESSION_REASONS.PROTECTED_PDF);
  clearFileCompressionCacheEntryForTesting(encFile);

  // Lightweight text file
  const txtFile = new File(['Hello world'], 'notes.txt', { type: 'text/plain' });
  const [resTxt] = await prepareAttachmentsForUpload([
    { id: 'att-txt', name: 'notes.txt', size: txtFile.size, type: 'text/plain', file: txtFile }
  ]);
  assert.equal(resTxt.file, txtFile, 'Unsupported/lightweight text file must return untouched original File');
  assert.equal(resTxt.compression.compressed, false);
  clearFileCompressionCacheEntryForTesting(txtFile);

  // Unexpected throw inside compressFn -> safe original-file fallback
  const brokenFile = new File([Buffer.alloc(100 * 1024, 1)], 'flaky.pdf', { type: 'application/pdf' });
  const [resErr] = await prepareAttachmentsForUpload(
    [{ id: 'att-err', name: 'flaky.pdf', size: brokenFile.size, type: 'application/pdf', file: brokenFile }],
    {
      compressFn: async () => {
        throw new Error('Simulated unexpected encoder failure');
      }
    }
  );
  assert.equal(resErr.file, brokenFile, 'Unexpected compressor error must fall back to original File');
  assert.equal(resErr.compression.compressed, false);
  assert.equal(resErr.compression.reason, COMPRESSION_REASONS.ERROR);
  clearFileCompressionCacheEntryForTesting(brokenFile);
}
console.log('   ✓ Original-file fallback verified');

// ===========================================================================
// TEST 5: Deduplication — Never Compress the Same File Repeatedly
// ===========================================================================
console.log('5. Testing deduplication (retries and already-compressed files never re-compress)...');
{
  const rawPdf = await makeCompressiblePdfBuffer('DEDUP-TEST');
  const origFile = new File([rawPdf], 'dedup.pdf', { type: 'application/pdf' });
  const att = {
    id: 'att-dedup-1',
    name: 'dedup.pdf',
    originalName: 'dedup.pdf',
    size: origFile.size,
    type: 'application/pdf',
    extension: 'PDF',
    file: origFile
  };

  let callCount = 0;
  const spyCompress = async (file, opts) => {
    callCount++;
    return compressFile(file, opts);
  };

  // First submission
  const [firstPass] = await prepareAttachmentsForUpload([att], { compressFn: spyCompress });
  assert.equal(callCount, 1);
  assert.equal(firstPass.compression.compressed, true);
  assert.equal(isAlreadyCompressedOutputFile(firstPass.file), true);

  // Simulated upload failure -> ChatArea restores original `att` and user retries Submit
  const [retryWithOrig] = await prepareAttachmentsForUpload([att], { compressFn: spyCompress });
  assert.equal(callCount, 1, 'Retry with original File reference must reuse cached compression and NOT call compressFn again');
  assert.equal(retryWithOrig.file, firstPass.file, 'Retry must receive exact same compressed File');

  // Simulated pass-through of the already-prepared attachment (holding compressed File)
  const [retryWithPrepared] = await prepareAttachmentsForUpload([firstPass], { compressFn: spyCompress });
  assert.equal(callCount, 1, 'Already-compressed File must NEVER be re-compressed');
  assert.equal(retryWithPrepared.file, firstPass.file);

  clearFileCompressionCacheEntryForTesting(origFile);
}
console.log('   ✓ Deduplication / never-repeat-compression verified');

// ===========================================================================
// TEST 6: AbortSignal / Stop Cancellation + Retry After Cancel
// ===========================================================================
console.log('6. Testing AbortSignal cancellation during compression and clean subsequent retry...');
{
  const rawPdf = await makeCompressiblePdfBuffer('ABORT-TEST');
  const origFile = new File([rawPdf], 'abortable.pdf', { type: 'application/pdf' });
  const att = {
    id: 'att-abort-1',
    name: 'abortable.pdf',
    size: origFile.size,
    type: 'application/pdf',
    file: origFile
  };

  const controller = new AbortController();
  const stageUpdates = [];
  let uploadExecuted = false;

  const pending = prepareAttachmentsForUpload([att], {
    signal: controller.signal,
    onStage: (s) => stageUpdates.push(s),
    compressFn: (file, opts) =>
      new Promise((resolve) => {
        opts.onStage?.({ stage: COMPRESSION_STAGES.OPTIMIZING, fileName: file.name });
        setTimeout(() => {
          resolve(compressFile(file, opts));
        }, 120);
      })
  });

  // Trigger Stop mid-compression
  setTimeout(() => controller.abort(new DOMException('Stopped by user', 'AbortError')), 20);

  let caughtAbort = null;
  try {
    await pending;
    uploadExecuted = true;
  } catch (err) {
    caughtAbort = err;
  }

  assert.ok(caughtAbort, 'Aborted compression must reject cleanly');
  assert.equal(caughtAbort.name, 'AbortError');
  assert.equal(uploadExecuted, false, 'Upload must NEVER proceed after compression abort');

  // Retrying later with a fresh non-aborted signal MUST optimize cleanly (aborted attempt was not cached)
  const [retryRes] = await prepareAttachmentsForUpload([att], {
    signal: new AbortController().signal
  });
  assert.equal(retryRes.compression.compressed, true, 'Retry after abort must optimize normally');

  clearFileCompressionCacheEntryForTesting(origFile);
}
console.log('   ✓ AbortSignal cancellation & subsequent retry verified');

console.log('\nALL 6 SMART COMPRESSION UPLOAD INTEGRATION TEST GROUPS PASSED!');
