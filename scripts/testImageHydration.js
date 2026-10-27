/**
 * Focused Regression Suite for Phase 2B & Phase 2B.2:
 * Image Attachment Hydration, Single-Field Canonical Encoding, Request-Size Budgets,
 * MIME & Magic-Byte Validation, Persistence Sanitization, and Server Image-Part Construction.
 */

import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  saveAttachmentBlob,
  getAttachmentRecord,
  getAttachmentBlob,
  convertBlobToDataUrl,
  hydrateAttachmentsWithImageBytes,
  sanitizeAttachmentForNetwork,
  prepareChatRequestBody,
  buildVisionImageParts,
  parseEncodedImagePayload,
  resolveSupportedImageMime,
  detectImageMimeFromBytes,
  MAX_VISION_IMAGE_BYTES,
  MAX_CHAT_REQUEST_BYTES,
  ImagePayloadLimitError,
  ImagePayloadValidationError
} from '../src/services/attachmentStorageService.js';

import {
  prepareDocumentContext,
  adaptDocumentContextForProvider,
  isVisionCapableProvider
} from '../src/services/documentContextService.js';
import { streamAIMessage } from '../src/services/aiRouter.js';
import { sendGeminiMessage, streamGeminiMessage } from '../src/services/geminiService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Minimal Environment Shims for Browser Storage APIs in Node.js
// (Production functions themselves are imported and executed directly)
// ---------------------------------------------------------------------------
const memoryStores = new Map();
let idbGetCount = 0;

globalThis.indexedDB = {
  open(_dbName, _version) {
    const req = {
      result: {
        objectStoreNames: {
          contains: (name) => memoryStores.has(name)
        },
        createObjectStore: (name) => {
          if (!memoryStores.has(name)) memoryStores.set(name, new Map());
          return {
            createIndex: () => {}
          };
        },
        transaction: (storeNames, _mode) => {
          const storeName = Array.isArray(storeNames) ? storeNames[0] : storeNames;
          if (!memoryStores.has(storeName)) {
            memoryStores.set(storeName, new Map());
          }
          const map = memoryStores.get(storeName);
          return {
            objectStore: () => ({
              put: (record) => {
                const putReq = {};
                setTimeout(() => {
                  map.set(record.id, record);
                  if (putReq.onsuccess) putReq.onsuccess({ target: putReq });
                }, 0);
                return putReq;
              },
              get: (id) => {
                idbGetCount += 1;
                const getReq = { result: map.get(id) || null };
                setTimeout(() => {
                  getReq.result = map.get(id) || null;
                  if (getReq.onsuccess) getReq.onsuccess({ target: getReq });
                }, 0);
                return getReq;
              }
            })
          };
        }
      }
    };
    setTimeout(() => {
      if (req.onupgradeneeded) {
        req.onupgradeneeded({ target: req });
      }
      if (req.onsuccess) {
        req.onsuccess({ target: req });
      }
    }, 0);
    return req;
  }
};

const localStorageMap = new Map();
const localStorageShim = {
  getItem: (key) => (localStorageMap.has(key) ? localStorageMap.get(key) : null),
  setItem: (key, value) => localStorageMap.set(String(key), String(value)),
  removeItem: (key) => localStorageMap.delete(String(key)),
  clear: () => localStorageMap.clear()
};

globalThis.localStorage = localStorageShim;
globalThis.window = {
  localStorage: localStorageShim,
  addEventListener: () => {},
  removeEventListener: () => {}
};
try {
  Object.defineProperty(globalThis, 'navigator', {
    value: { onLine: false },
    configurable: true,
    writable: true
  });
} catch (_) {}

// Import real persistence functions after window/localStorage shims are initialized
const {
  saveCachedChatMessages,
  getCachedChatMessages,
  saveChatMessage,
  serializeAttachmentForStorage,
  sanitizeMessageForStorage
} = await import('../src/services/chatStorageService.js');

// Deterministic valid 1x1 PNG binary fixture
const VALID_1X1_PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,
  0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
  0x00, 0x03, 0x01, 0x01, 0x00, 0x18, 0xdd, 0x8d,
  0xb0, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
  0x44, 0xae, 0x42, 0x60, 0x82
]);

const VALID_JPEG_BYTES = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46,
  0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xd9
]);

function makeSizedPngBuffer(totalLength) {
  const buf = Buffer.alloc(totalLength, 0x41);
  VALID_1X1_PNG_BYTES.copy(buf, 0, 0, Math.min(VALID_1X1_PNG_BYTES.length, totalLength));
  return buf;
}

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ FAIL: ${name}`);
    console.error(err);
    failed++;
  }
}

console.log('=== Starting Phase 2B.2 Image Payload & Persistence Safety Suite ===\n');

// ---------------------------------------------------------------------------
// Assertion 1: A valid image is encoded ONLY ONCE in the outgoing payload
// ---------------------------------------------------------------------------
await test('Assertion 1: Valid image is encoded exactly once in hydrated attachment and outgoing /api/chat JSON body', async () => {
  const imageId = 'att-single-encode-1';
  const pngBytes = Buffer.concat([VALID_1X1_PNG_BYTES, Buffer.from('UNIQUE_MARKER_BYTES_2B2')]);
  const expectedRawB64 = pngBytes.toString('base64');

  await saveAttachmentBlob(imageId, new Blob([pngBytes], { type: 'image/png' }), {
    name: 'diagram.png',
    originalName: 'diagram.png',
    type: 'image/png',
    size: pngBytes.length,
    isImage: true
  });

  // Case A: Hydrated from IndexedDB
  const [hydratedFromIdb] = await hydrateAttachmentsWithImageBytes([
    {
      id: imageId,
      name: 'diagram.png',
      type: 'image/png',
      isImage: true
    }
  ]);

  assert.strictEqual(hydratedFromIdb.base64, expectedRawB64, 'base64 must hold raw base64 without data: prefix');
  assert.strictEqual(hydratedFromIdb.mimeType, 'image/png');
  assert.strictEqual(hydratedFromIdb.type, 'image/png');
  assert.strictEqual('dataUrl' in hydratedFromIdb, false, 'dataUrl must not be present on hydrated attachment');
  assert.strictEqual('data' in hydratedFromIdb, false, 'data must not be present on hydrated attachment');
  assert.strictEqual('previewUrl' in hydratedFromIdb, false, 'previewUrl must not be present on hydrated attachment');

  // Case B: Pre-existing attachment with legacy duplicate base64 + dataUrl + data: previewUrl is normalized
  const legacyDupAtt = {
    id: 'att-legacy-dup',
    name: 'legacy.png',
    type: 'image/png',
    isImage: true,
    base64: `data:image/png;base64,${expectedRawB64}`,
    dataUrl: `data:image/png;base64,${expectedRawB64}`,
    previewUrl: `data:image/png;base64,${expectedRawB64}`
  };
  const [normalizedLegacy] = await hydrateAttachmentsWithImageBytes([legacyDupAtt]);
  assert.strictEqual(normalizedLegacy.base64, expectedRawB64);
  assert.strictEqual(normalizedLegacy.dataUrl, undefined);
  assert.strictEqual(normalizedLegacy.previewUrl, undefined);

  // Serialize outgoing /api/chat payload via production prepareChatRequestBody()
  const outgoingBody = prepareChatRequestBody({
    provider: 'gemini',
    mode: 'general',
    prompt: 'Explain this diagram',
    history: [
      {
        id: 'msg-prev-1',
        sender: 'user',
        content: 'Previous turn',
        attachments: [legacyDupAtt]
      }
    ],
    attachments: [hydratedFromIdb]
  });

  const occurrences = outgoingBody.split(expectedRawB64).length - 1;
  assert.strictEqual(occurrences, 1, `Expected base64 payload to appear exactly once in outgoing JSON, found ${occurrences}`);
  assert.strictEqual(outgoingBody.includes('"dataUrl"'), false, 'Outgoing JSON must not contain dataUrl key');
});

// ---------------------------------------------------------------------------
// Assertion 2: In-memory and IndexedDB image paths enforce the same per-image limit
// ---------------------------------------------------------------------------
await test('Assertion 2: In-memory (att.file) and IndexedDB (record.blob) enforce the exact same per-image byte limit', async () => {
  const overLimitBytes = makeSizedPngBuffer(MAX_VISION_IMAGE_BYTES + 2048); // > 3.0 MB
  const overLimitBlob = new Blob([overLimitBytes], { type: 'image/png' });

  // 2A: In-memory att.file path rejects above MAX_VISION_IMAGE_BYTES
  let inMemoryError = null;
  try {
    await hydrateAttachmentsWithImageBytes([
      {
        id: 'att-over-mem',
        name: 'oversized_mem.png',
        type: 'image/png',
        isImage: true,
        file: overLimitBlob
      }
    ]);
  } catch (err) {
    inMemoryError = err;
  }
  assert.ok(inMemoryError instanceof ImagePayloadLimitError, 'In-memory oversized image must throw ImagePayloadLimitError');
  assert.strictEqual(inMemoryError.code, 413);
  assert.strictEqual(inMemoryError.status, 'PAYLOAD_TOO_LARGE');

  // 2B: IndexedDB record.blob path rejects at the exact same threshold
  const idbOverId = 'att-over-idb';
  await saveAttachmentBlob(idbOverId, overLimitBlob, {
    name: 'oversized_idb.png',
    type: 'image/png',
    size: overLimitBytes.length,
    isImage: true
  });

  let idbError = null;
  try {
    await hydrateAttachmentsWithImageBytes([
      {
        id: idbOverId,
        name: 'oversized_idb.png',
        type: 'image/png',
        isImage: true
      }
    ]);
  } catch (err) {
    idbError = err;
  }
  assert.ok(idbError instanceof ImagePayloadLimitError, 'IndexedDB oversized image must throw ImagePayloadLimitError');
  assert.strictEqual(idbError.code, 413);
  assert.strictEqual(idbError.maxImageBytes, inMemoryError.maxImageBytes);

  // 2C: Both paths succeed identically just under the per-image limit (e.g. 512 KB)
  const validBytes = makeSizedPngBuffer(512 * 1024);
  const validBlob = new Blob([validBytes], { type: 'image/png' });
  const idbValidId = 'att-under-idb';
  await saveAttachmentBlob(idbValidId, validBlob, {
    name: 'under_limit.png',
    type: 'image/png',
    size: validBytes.length,
    isImage: true
  });

  const [memOk] = await hydrateAttachmentsWithImageBytes([
    { id: 'att-under-mem', name: 'under_limit.png', type: 'image/png', isImage: true, file: validBlob }
  ]);
  const [idbOk] = await hydrateAttachmentsWithImageBytes([
    { id: idbValidId, name: 'under_limit.png', type: 'image/png', isImage: true }
  ]);
  assert.strictEqual(memOk.base64, idbOk.base64);
  assert.strictEqual(memOk.base64.length, Math.ceil(validBytes.length / 3) * 4);
});

// ---------------------------------------------------------------------------
// Assertion 3: Multiple images cannot exceed cumulative request budget unnoticed
// ---------------------------------------------------------------------------
await test('Assertion 3: Multiple carried-forward images individually within limit fail deterministically when exceeding cumulative budget', async () => {
  // Two 2.0 MB images: each <= 3.0 MB per-image limit, but combined base64 (~5.33 MB) > MAX_CHAT_REQUEST_BYTES (~4.20 MiB)
  const twoMbBytesA = makeSizedPngBuffer(2 * 1024 * 1024);
  const twoMbBytesB = makeSizedPngBuffer(2 * 1024 * 1024);

  await saveAttachmentBlob('att-multi-a', new Blob([twoMbBytesA], { type: 'image/png' }), {
    name: 'slide_a.png',
    type: 'image/png',
    size: twoMbBytesA.length,
    isImage: true
  });
  await saveAttachmentBlob('att-multi-b', new Blob([twoMbBytesB], { type: 'image/png' }), {
    name: 'slide_b.png',
    type: 'image/png',
    size: twoMbBytesB.length,
    isImage: true
  });

  // Verify each image individually succeeds
  const [singleA] = await hydrateAttachmentsWithImageBytes([
    { id: 'att-multi-a', name: 'slide_a.png', type: 'image/png', isImage: true }
  ]);
  assert.ok(singleA.base64.length > 0, 'Single 2 MB image must fit within request budget');

  // Verify carrying forward both images together throws ImagePayloadLimitError
  let cumulativeErr = null;
  try {
    await hydrateAttachmentsWithImageBytes([
      { id: 'att-multi-a', name: 'slide_a.png', type: 'image/png', isImage: true },
      { id: 'att-multi-b', name: 'slide_b.png', type: 'image/png', isImage: true }
    ]);
  } catch (err) {
    cumulativeErr = err;
  }
  assert.ok(cumulativeErr instanceof ImagePayloadLimitError, 'Combined 2x2MB images must throw ImagePayloadLimitError');
  assert.strictEqual(cumulativeErr.code, 413);
  assert.ok(cumulativeErr.message.includes('chat request budget'), 'Error must explain cumulative request budget');

  // Also verify prepareChatRequestBody catches cumulative overflow when a large image + large prompt/history exceed MAX_CHAT_REQUEST_BYTES
  const nearLimitImgBytes = makeSizedPngBuffer(3 * 1024 * 1024); // ~4.0 MiB base64
  const [hydratedNearLimit] = await hydrateAttachmentsWithImageBytes([
    { id: 'att-near-limit', name: 'near.png', type: 'image/png', isImage: true, file: new Blob([nearLimitImgBytes], { type: 'image/png' }) }
  ]);
  assert.throws(
    () =>
      prepareChatRequestBody({
        provider: 'gemini',
        prompt: 'X'.repeat(350 * 1024), // pushes total JSON past 4,400,000 bytes
        history: [],
        attachments: [hydratedNearLimit]
      }),
    (err) => err instanceof ImagePayloadLimitError && err.code === 413
  );
});

// ---------------------------------------------------------------------------
// Assertion 4: Browser FileReader behavior when Blob MIME is empty, inconsistent, or unsupported
// ---------------------------------------------------------------------------
await test('Assertion 4: Browser FileReader path normalizes empty/inconsistent Blob MIME and rejects unsupported SVG/TIFF', async () => {
  const previousFileReader = globalThis.FileReader;

  // Simulate standard browser FileReader.readAsDataURL(blob) which uses blob.type || 'application/octet-stream'
  // and completely ignores any external mimeType parameter unless convertBlobToDataUrl normalizes it.
  globalThis.FileReader = class MockBrowserFileReader {
    readAsDataURL(blob) {
      blob
        .arrayBuffer()
        .then((ab) => {
          const b64 = Buffer.from(ab).toString('base64');
          const emittedMime = blob.type || 'application/octet-stream';
          this.result = `data:${emittedMime};base64,${b64}`;
          if (typeof this.onload === 'function') this.onload({ target: this });
        })
        .catch((err) => {
          if (typeof this.onerror === 'function') this.onerror(err);
        });
    }
  };

  try {
    // 4a. Empty blob.type ("") with PNG bytes -> must emit data:image/png;base64,... (NOT application/octet-stream)
    const untypedPngBlob = new Blob([VALID_1X1_PNG_BYTES], { type: '' });
    assert.strictEqual(untypedPngBlob.type, '');
    const pngDataUrl = await convertBlobToDataUrl(untypedPngBlob, '');
    assert.strictEqual(
      pngDataUrl,
      `data:image/png;base64,${VALID_1X1_PNG_BYTES.toString('base64')}`,
      'Empty blob.type with PNG bytes must resolve to data:image/png'
    );

    // 4b. Inconsistent blob.type ("image/png") when actual binary bytes are JPEG -> must emit data:image/jpeg;base64,...
    const mislabeledJpegBlob = new Blob([VALID_JPEG_BYTES], { type: 'image/png' });
    const fixedJpegDataUrl = await convertBlobToDataUrl(mislabeledJpegBlob, 'image/png');
    assert.strictEqual(
      fixedJpegDataUrl,
      `data:image/jpeg;base64,${VALID_JPEG_BYTES.toString('base64')}`,
      'Mislabeled PNG blob containing JPEG magic bytes must resolve to data:image/jpeg'
    );

    // 4c. Hydrate attachment with extension without dot ("PNG") and untyped Blob in IndexedDB under FileReader
    await saveAttachmentBlob('att-filereader-nodot', untypedPngBlob, {
      name: 'clipboard_capture',
      type: 'application/octet-stream',
      extension: 'PNG',
      size: VALID_1X1_PNG_BYTES.length,
      isImage: false
    });
    const [hydratedNoDot] = await hydrateAttachmentsWithImageBytes([
      {
        id: 'att-filereader-nodot',
        name: 'clipboard_capture',
        type: '',
        extension: 'PNG'
      }
    ]);
    assert.strictEqual(hydratedNoDot.mimeType, 'image/png');
    assert.strictEqual(hydratedNoDot.base64, VALID_1X1_PNG_BYTES.toString('base64'));

    // 4d. Unsupported SVG and TIFF formats must NOT enter the vision path
    const svgBytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>', 'utf8');
    const svgBlob = new Blob([svgBytes], { type: 'image/svg+xml' });
    assert.strictEqual(await convertBlobToDataUrl(svgBlob, 'image/svg+xml'), null, 'SVG must be rejected by convertBlobToDataUrl');

    const tiffBytes = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]);
    const tiffBlob = new Blob([tiffBytes], { type: 'image/tiff' });
    assert.strictEqual(await convertBlobToDataUrl(tiffBlob, 'image/tiff'), null, 'TIFF must be rejected by convertBlobToDataUrl');

    const [svgHydrated] = await hydrateAttachmentsWithImageBytes([
      { id: 'att-svg', name: 'vector.svg', type: 'image/svg+xml', isImage: true, file: svgBlob }
    ]);
    assert.strictEqual(svgHydrated.base64, undefined, 'SVG must not receive vision base64 payload');
  } finally {
    globalThis.FileReader = previousFileReader;
  }
});

// ---------------------------------------------------------------------------
// Assertions 5 & 6: Decoded image bytes match original bytes exactly AND declared MIME matches validated format
// (Includes direct verification of server-side image-part construction with an empty fileRegistry)
// ---------------------------------------------------------------------------
await test('Assertions 5 & 6: Hydrated and server-constructed imageParts preserve exact binary bytes and validated MIME type', async () => {
  const imageId = 'att-exact-bytes-jpeg';
  // Save JPEG bytes with alias/mismatched metadata ('image/jpg') into IndexedDB
  await saveAttachmentBlob(imageId, new Blob([VALID_JPEG_BYTES], { type: 'image/jpg' }), {
    name: 'camera_shot.jpg',
    type: 'image/jpg',
    size: VALID_JPEG_BYTES.length,
    isImage: true
  });

  const [hydrated] = await hydrateAttachmentsWithImageBytes([
    {
      id: imageId,
      name: 'camera_shot.jpg',
      type: 'image/jpg',
      isImage: true
    }
  ]);

  assert.strictEqual(hydrated.mimeType, 'image/jpeg', 'Alias image/jpg must normalize to image/jpeg');
  assert.strictEqual(hydrated.type, 'image/jpeg');
  assert.deepStrictEqual(Buffer.from(hydrated.base64, 'base64'), VALID_JPEG_BYTES);

  // Also test Data URL prefix with non-matching regex chars (e.g. image/x-png;charset=utf-8)
  const trickyDataUrl = `data:image/x-png;charset=utf-8;base64,${VALID_1X1_PNG_BYTES.toString('base64')}`;
  const parsedTricky = parseEncodedImagePayload(trickyDataUrl, { name: 'icon.png' });
  assert.strictEqual(parsedTricky.valid, true);
  assert.strictEqual(parsedTricky.mimeType, 'image/png');
  assert.deepStrictEqual(Buffer.from(parsedTricky.base64, 'base64'), VALID_1X1_PNG_BYTES);

  // Direct unit test of production buildVisionImageParts with an empty server registry (cold-start simulation)
  const emptyRegistry = new Map();
  const constructedParts = buildVisionImageParts({
    attachments: [hydrated, { id: 'tricky-png', name: 'icon.png', base64: trickyDataUrl, isImage: true }],
    availableDocs: [],
    resolveRegisteredFile: (id) => emptyRegistry.get(id) || null
  });

  assert.strictEqual(constructedParts.length, 2, 'Server builder must construct exactly 2 imageParts');
  assert.strictEqual(constructedParts[0].mimeType, 'image/jpeg');
  assert.deepStrictEqual(Buffer.from(constructedParts[0].data, 'base64'), VALID_JPEG_BYTES);
  assert.strictEqual(constructedParts[1].mimeType, 'image/png');
  assert.deepStrictEqual(Buffer.from(constructedParts[1].data, 'base64'), VALID_1X1_PNG_BYTES);

  // Reject arbitrary/unsupported image/* in server builder
  assert.throws(
    () =>
      buildVisionImageParts({
        attachments: [
          {
            id: 'bad-svg',
            name: 'chart.svg',
            type: 'image/svg+xml',
            isImage: true,
            base64: Buffer.from('<svg></svg>').toString('base64')
          }
        ]
      }),
    (err) => err instanceof ImagePayloadValidationError && err.code === 400
  );
});

// Direct execution check of exported buildGeminiImageParts in server.ts via tsx
await test('Server export check: server.ts buildGeminiImageParts constructs verified imagePart with empty registry', async () => {
  const probeScript = `
    process.env.TESTING = '1';
    import assert from 'node:assert';
    import { buildGeminiImageParts } from './server.ts';
    const pngBytes = Buffer.from(${JSON.stringify(Array.from(VALID_1X1_PNG_BYTES))});
    const emptyRegistry = new Map();
    const parts = buildGeminiImageParts({
      attachments: [{
        id: 'coldstart-tsx-1',
        name: 'cold.png',
        type: 'image/png',
        mimeType: 'image/png',
        isImage: true,
        base64: pngBytes.toString('base64')
      }],
      availableDocs: [],
      registry: emptyRegistry,
      uploadDir: ''
    });
    assert.strictEqual(parts.length, 1);
    assert.strictEqual(parts[0].mimeType, 'image/png');
    assert.deepStrictEqual(Buffer.from(parts[0].data, 'base64'), pngBytes);
  `;

  const tsxBin = path.resolve(__dirname, '..', 'node_modules', '.bin', 'tsx');
  const res = spawnSync(tsxBin, ['--input-type=module', '-e', probeScript], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, TESTING: '1' },
    encoding: 'utf8'
  });

  assert.strictEqual(res.status, 0, `server.ts buildGeminiImageParts probe failed: ${res.stderr || res.stdout}`);
});

// ---------------------------------------------------------------------------
// Assertion 7: Actual saveCachedChatMessages() and saveChatMessage() do not store base64 or dataUrl
// ---------------------------------------------------------------------------
await test('Assertion 7: Real saveCachedChatMessages() and saveChatMessage() strip base64, dataUrl, previewUrl, and Blob from localStorage', async () => {
  localStorageShim.clear();
  const userId = 'user-persist-test-2b2';
  const chatIdA = 'chat-direct-cache';
  const chatIdB = 'chat-save-message';
  const secretMarker = 'TRANSIENT_SECRET_BASE64_PAYLOAD_DO_NOT_PERSIST';

  const dirtyAttachment = {
    id: 'att-persist-real-1',
    name: 'receipt.png',
    originalName: 'receipt.png',
    size: 4096,
    formattedSize: '4.0 KB',
    type: 'image/png',
    mimeType: 'image/png',
    extension: '.png',
    isImage: true,
    status: 'ready',
    base64: secretMarker,
    dataUrl: `data:image/png;base64,${secretMarker}`,
    data: secretMarker,
    previewUrl: `data:image/png;base64,${secretMarker}`,
    file: new Blob(['binary'], { type: 'image/png' }),
    extraction: {
      status: 'ready',
      hasText: true,
      text: 'Total: $19.99',
      base64: secretMarker,
      dataUrl: `data:image/png;base64,${secretMarker}`
    }
  };

  const dirtyUserMsg = {
    id: 'msg-user-dirty-1',
    sender: 'user',
    content: 'Check this receipt',
    timestamp: '10:00 AM',
    attachments: [dirtyAttachment]
  };

  const dirtyAssistantMsg = {
    id: 'msg-assistant-dirty-1',
    sender: 'assistant',
    parentMessageId: 'msg-user-dirty-1',
    provider: 'gemini',
    modelUsed: 'gemini-3.1-flash-lite',
    content: 'The receipt total is $19.99.',
    timestamp: '10:00 AM',
    referencedAttachments: [dirtyAttachment],
    alternatives: [
      {
        id: 'alt-1',
        parentMessageId: 'msg-user-dirty-1',
        sender: 'assistant',
        content: 'The receipt total is $19.99.',
        provider: 'gemini',
        referencedAttachments: [dirtyAttachment]
      }
    ]
  };

  // Path 1: Direct saveCachedChatMessages() (used by handleEditResend & loadConversationMessages)
  saveCachedChatMessages(userId, chatIdA, [dirtyUserMsg, dirtyAssistantMsg]);
  const rawCacheA = localStorageShim.getItem(`orvix_user_messages_${userId}_${chatIdA}`);
  assert.ok(rawCacheA, 'saveCachedChatMessages must write message cache entry');
  assert.strictEqual(rawCacheA.includes(secretMarker), false, 'saveCachedChatMessages must NOT persist base64/dataUrl/previewUrl');
  assert.strictEqual(rawCacheA.includes('"base64"'), false);
  assert.strictEqual(rawCacheA.includes('"dataUrl"'), false);
  assert.strictEqual(rawCacheA.includes('"previewUrl"'), false);

  const parsedCacheA = getCachedChatMessages(userId, chatIdA);
  assert.strictEqual(parsedCacheA.length, 2);
  assert.strictEqual(parsedCacheA[0].attachments[0].id, 'att-persist-real-1');
  assert.strictEqual(parsedCacheA[0].attachments[0].name, 'receipt.png');
  assert.strictEqual(parsedCacheA[0].attachments[0].extraction.text, 'Total: $19.99');
  assert.strictEqual(parsedCacheA[0].attachments[0].base64, undefined);
  assert.strictEqual(parsedCacheA[0].attachments[0].dataUrl, undefined);
  assert.strictEqual(parsedCacheA[1].referencedAttachments[0].base64, undefined);
  assert.strictEqual(parsedCacheA[1].alternatives[0].referencedAttachments[0].base64, undefined);

  // Path 2: Real saveChatMessage() (used by persistMessageSafe on normal send, retry, regenerate, edit-resend)
  await saveChatMessage(userId, chatIdB, dirtyUserMsg);
  await saveChatMessage(userId, chatIdB, dirtyAssistantMsg);

  const rawCacheB = localStorageShim.getItem(`orvix_user_messages_${userId}_${chatIdB}`);
  assert.ok(rawCacheB, 'saveChatMessage must populate localStorage message cache');
  assert.strictEqual(rawCacheB.includes(secretMarker), false, 'saveChatMessage must NOT persist base64/dataUrl/previewUrl');
  assert.strictEqual(rawCacheB.includes('"base64"'), false);
  assert.strictEqual(rawCacheB.includes('"dataUrl"'), false);
  assert.strictEqual(rawCacheB.includes('"previewUrl"'), false);

  const parsedCacheB = getCachedChatMessages(userId, chatIdB);
  assert.strictEqual(parsedCacheB.length, 2);
  assert.strictEqual(parsedCacheB[0].attachments[0].extraction.text, 'Total: $19.99');
  assert.strictEqual(parsedCacheB[0].attachments[0].isImage, true);
});

// ---------------------------------------------------------------------------
// Graceful Degradation: Missing or 0-byte IndexedDB blobs do not fabricate bytes
// ---------------------------------------------------------------------------
await test('Graceful fallback: Missing IndexedDB record or 0-byte blob degrades cleanly without fabricating bytes', async () => {
  const [missingHydrated] = await hydrateAttachmentsWithImageBytes([
    {
      id: 'att-non-existent-999',
      name: 'missing.png',
      type: 'image/png',
      isImage: true,
      extraction: null
    }
  ]);
  assert.strictEqual(missingHydrated.base64, undefined);
  assert.strictEqual(missingHydrated.dataUrl, undefined);

  const emptyBlobId = 'att-empty-blob';
  await saveAttachmentBlob(emptyBlobId, new Blob([], { type: 'image/png' }), {
    name: 'empty.png',
    type: 'image/png',
    isImage: true
  });
  const [emptyHydrated] = await hydrateAttachmentsWithImageBytes([
    { id: emptyBlobId, name: 'empty.png', type: 'image/png', isImage: true }
  ]);
  assert.strictEqual(emptyHydrated.base64, undefined, 'Must not fabricate base64 for 0-byte blob');
});

// ---------------------------------------------------------------------------
// Assertion 8: Oversized payloads & live cold-start /api/chat produce clear results
// ---------------------------------------------------------------------------
await test('Assertion 8: Live POST /api/chat rejects oversized or omitted-oversized images with clear JSON 413 error and accepts valid cold-start PNG', async () => {
  // 8A: Oversized encoded image sent to /api/chat returns structured 413 JSON with actionable message
  const oversizedBytes = makeSizedPngBuffer(MAX_VISION_IMAGE_BYTES + 64 * 1024);
  const overRes = await fetch('http://127.0.0.1:3000/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: 'Analyze this huge image',
      provider: 'gemini',
      stream: false,
      attachments: [
        {
          id: `over-live-${Date.now()}`,
          name: 'huge_scan.png',
          type: 'image/png',
          mimeType: 'image/png',
          isImage: true,
          base64: oversizedBytes.toString('base64'),
          extraction: { status: 'NO_TEXT_DETECTED', hasText: false, text: '' }
        }
      ]
    })
  });

  assert.strictEqual(overRes.status, 413, 'Oversized image request must return HTTP 413');
  const overData = await overRes.json();
  assert.strictEqual(overData.code, 413);
  assert.strictEqual(overData.status, 'PAYLOAD_TOO_LARGE');
  assert.strictEqual(overData.retryable, false);
  assert.ok(
    overData.error && overData.error.includes('huge_scan.png') && overData.error.includes('MB'),
    `Expected actionable error message naming file and MB limit, got: ${overData.error}`
  );

  // 8B: Omitted bytes for an oversized image must NOT silently claim success
  const omittedOverRes = await fetch('http://127.0.0.1:3000/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: 'What is in this omitted oversized photo?',
      provider: 'gemini',
      stream: false,
      attachments: [
        {
          id: `omitted-over-${Date.now()}`,
          name: 'omitted_8mb.png',
          type: 'image/png',
          size: 8 * 1024 * 1024,
          isImage: true,
          extraction: { status: 'NO_TEXT_DETECTED', hasText: false, text: '' }
        }
      ]
    })
  });

  assert.strictEqual(omittedOverRes.status, 413, 'Omitted oversized image must return HTTP 413 instead of silent omission');
  const omittedOverData = await omittedOverRes.json();
  assert.strictEqual(omittedOverData.status, 'PAYLOAD_TOO_LARGE');
  assert.ok(omittedOverData.error.includes('omitted_8mb.png'));

  // 8C: Valid hydrated cold-start PNG (single canonical base64 field, unregistered ID) succeeds end-to-end
  await saveAttachmentBlob('att-live-coldstart', new Blob([VALID_1X1_PNG_BYTES], { type: 'image/png' }), {
    name: 'coldstart_photo.png',
    type: 'image/png',
    size: VALID_1X1_PNG_BYTES.length,
    isImage: true
  });
  const [hydratedCold] = await hydrateAttachmentsWithImageBytes([
    {
      id: 'att-live-coldstart',
      name: 'coldstart_photo.png',
      type: 'image/png',
      isImage: true,
      extraction: { status: 'NO_TEXT_DETECTED', hasText: false, text: '' }
    }
  ]);
  // Re-assign unregistered ID to guarantee empty server fileRegistry hit
  const unregisteredAtt = { ...hydratedCold, id: `unregistered-coldstart-${Date.now()}` };

  const okBody = prepareChatRequestBody({
    prompt: 'What image did I upload? Reply in one short sentence.',
    provider: 'gemini',
    stream: false,
    attachments: [unregisteredAtt]
  });

  let okRes;
  for (let attempt = 1; attempt <= 3; attempt++) {
    okRes = await fetch('http://127.0.0.1:3000/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: okBody
    });
    if (okRes.status !== 503 && okRes.status !== 429) break;
    if (attempt < 3) {
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }

  assert.strictEqual(okRes.status, 200, 'Valid hydrated cold-start image request must return HTTP 200');
  const okData = await okRes.json();
  assert.ok(okData.text, 'Must return generated response text');
  assert.strictEqual(okData.provider, 'gemini');
});

// ---------------------------------------------------------------------------
// Assertion 9: Existing OCR text and document attachment behavior remain intact
// ---------------------------------------------------------------------------
await test('Assertion 9: Existing OCR text on images and non-image document attachments remain completely intact', async () => {
  // 9A: Non-image DOCX attachment
  const docxAtt = {
    id: 'att-docx-intact',
    name: 'spec.docx',
    originalName: 'spec.docx',
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    isImage: false,
    extraction: {
      status: 'ready',
      success: true,
      format: 'DOCX',
      text: 'Section 1: Architecture Overview and System Goals',
      totalCharacters: 49,
      totalWords: 7
    }
  };

  // 9B: Image attachment WITH extracted OCR text
  const ocrImgId = 'att-ocr-img-intact';
  await saveAttachmentBlob(ocrImgId, new Blob([VALID_1X1_PNG_BYTES], { type: 'image/png' }), {
    name: 'invoice_ocr.png',
    type: 'image/png',
    size: VALID_1X1_PNG_BYTES.length,
    isImage: true
  });

  const ocrImgAtt = {
    id: ocrImgId,
    name: 'invoice_ocr.png',
    originalName: 'invoice_ocr.png',
    type: 'image/png',
    isImage: true,
    extraction: {
      status: 'ready',
      success: true,
      isImage: true,
      hasText: true,
      text: 'INVOICE #4021 — Amount Due: $128.50',
      totalCharacters: 35,
      totalWords: 6
    }
  };

  const hydratedList = await hydrateAttachmentsWithImageBytes([docxAtt, ocrImgAtt]);
  assert.strictEqual(hydratedList.length, 2);

  // DOCX untouched, no base64 fabricated
  assert.strictEqual(hydratedList[0].isImage, false);
  assert.strictEqual(hydratedList[0].base64, undefined);
  assert.strictEqual(hydratedList[0].extraction.text, 'Section 1: Architecture Overview and System Goals');

  // OCR image has BOTH its intact OCR text AND single canonical base64 payload
  assert.strictEqual(hydratedList[1].isImage, true);
  assert.strictEqual(hydratedList[1].mimeType, 'image/png');
  assert.strictEqual(hydratedList[1].base64, VALID_1X1_PNG_BYTES.toString('base64'));
  assert.strictEqual(hydratedList[1].dataUrl, undefined);
  assert.strictEqual(hydratedList[1].extraction.text, 'INVOICE #4021 — Amount Due: $128.50');

  // Verify prepareDocumentContext still delivers OCR text to both Gemini (vision) and Groq (text-only)
  const docRecord = {
    ...hydratedList[1].extraction,
    fileId: ocrImgId,
    originalName: 'invoice_ocr.png',
    filename: 'invoice_ocr.png',
    format: 'PNG',
    mimeType: 'image/png'
  };
  const geminiCtx = prepareDocumentContext('What is the amount due?', [docRecord], { provider: 'gemini' });
  const groqCtx = prepareDocumentContext('What is the amount due?', [docRecord], { provider: 'groq' });
  assert.strictEqual(geminiCtx.directAnswer, undefined);
  assert.strictEqual(groqCtx.directAnswer, undefined);
  assert.ok(geminiCtx.formattedContext.includes('INVOICE #4021 — Amount Due: $128.50'));
  assert.ok(groqCtx.formattedContext.includes('INVOICE #4021 — Amount Due: $128.50'));
});

// ---------------------------------------------------------------------------
// Phase 2B.3 — Test 10: Gemini receives hydrated image bytes & direct Gemini service calls validate payloads
// ---------------------------------------------------------------------------
await test('Phase 2B.3 — Gemini provider hydrates image bytes from IndexedDB and direct geminiService calls enforce payload validation', async () => {
  const gemId = 'att-2b3-gemini-vision';
  await saveAttachmentBlob(gemId, new Blob([VALID_1X1_PNG_BYTES], { type: 'image/png' }), {
    name: 'gemini_diagram.png',
    type: 'image/png',
    size: VALID_1X1_PNG_BYTES.length,
    isImage: true
  });

  assert.strictEqual(isVisionCapableProvider('gemini'), true);

  idbGetCount = 0;
  const [hydratedGem] = await hydrateAttachmentsWithImageBytes(
    [
      {
        id: gemId,
        name: 'gemini_diagram.png',
        type: 'image/png',
        isImage: true,
        extraction: { status: 'NO_TEXT_DETECTED', hasText: false, text: '' }
      }
    ],
    { provider: 'gemini', model: 'gemini-3.1-flash-lite' }
  );

  assert.strictEqual(idbGetCount, 1, 'Gemini vision path must read image Blob from IndexedDB');
  assert.strictEqual(hydratedGem.base64, VALID_1X1_PNG_BYTES.toString('base64'));
  assert.strictEqual(hydratedGem.dataUrl, undefined);
  assert.strictEqual(hydratedGem.mimeType, 'image/png');

  // Verify direct sendGeminiMessage & streamGeminiMessage calls enforce deduplication and size limits before fetch
  const originalFetch = globalThis.fetch;
  let capturedBodies = [];
  globalThis.fetch = async (_url, init) => {
    capturedBodies.push(String(init?.body || ''));
    return new Response(JSON.stringify({ text: 'Direct Gemini verified', modelUsed: 'gemini-3.1-flash-lite' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    const expectedB64 = VALID_1X1_PNG_BYTES.toString('base64');
    const dupAtt = {
      id: gemId,
      name: 'gemini_diagram.png',
      type: 'image/png',
      isImage: true,
      base64: expectedB64,
      dataUrl: `data:image/png;base64,${expectedB64}`
    };

    const directRes = await sendGeminiMessage({
      prompt: 'Describe this diagram',
      attachments: [dupAtt]
    });
    assert.strictEqual(directRes.text, 'Direct Gemini verified');
    assert.strictEqual(capturedBodies.length, 1);
    const parsedDirectBody = JSON.parse(capturedBodies[0]);
    assert.strictEqual(parsedDirectBody.provider, 'gemini');
    assert.strictEqual(parsedDirectBody.attachments[0].base64, expectedB64);
    assert.strictEqual(parsedDirectBody.attachments[0].dataUrl, undefined);

    // Direct oversized image must throw ImagePayloadLimitError before fetch is called
    const oversizedAtt = {
      id: 'att-direct-oversized',
      name: 'oversized_direct.png',
      type: 'image/png',
      isImage: true,
      base64: makeSizedPngBuffer(MAX_VISION_IMAGE_BYTES + 4096).toString('base64')
    };

    await assert.rejects(
      () => sendGeminiMessage({ prompt: 'Inspect', attachments: [oversizedAtt] }),
      (err) => err instanceof ImagePayloadLimitError && err.code === 413
    );
    await assert.rejects(
      () => streamGeminiMessage({ prompt: 'Inspect stream', attachments: [oversizedAtt] }),
      (err) => err instanceof ImagePayloadLimitError && err.code === 413
    );
    assert.strictEqual(capturedBodies.length, 1, 'Oversized direct Gemini calls must fail before network fetch');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// Phase 2B.3 — Test 11: Text-only providers do NOT trigger IndexedDB hydration or upload raw image bytes
// ---------------------------------------------------------------------------
await test('Phase 2B.3 — Groq, OpenRouter, Cloudflare, Ollama, and WebLLM skip IndexedDB hydration and never upload raw image bytes', async () => {
  const textOnlyProviders = ['groq', 'openrouter', 'cloudflare', 'ollama', 'webllm'];

  const idbImageId = 'att-2b3-textonly-idb';
  await saveAttachmentBlob(idbImageId, new Blob([VALID_1X1_PNG_BYTES], { type: 'image/png' }), {
    name: 'whiteboard_notes.png',
    type: 'image/png',
    size: VALID_1X1_PNG_BYTES.length,
    isImage: true
  });

  // Also store a 5 MB OCR image (> 3 MB raw vision limit, valid under 25 MB upload policy)
  const largeOcrId = 'att-2b3-5mb-ocr';
  const fiveMbBytes = makeSizedPngBuffer(5 * 1024 * 1024);
  await saveAttachmentBlob(largeOcrId, new Blob([fiveMbBytes], { type: 'image/png' }), {
    name: 'highres_scan_5mb.png',
    type: 'image/png',
    size: fiveMbBytes.length,
    isImage: true
  });

  // In-memory Blob trap that would throw if read
  let inMemoryBlobReadCount = 0;
  const trapBlob = {
    size: 1024,
    type: 'image/png',
    async arrayBuffer() {
      inMemoryBlobReadCount += 1;
      throw new Error('In-memory Blob should never be read for text-only providers');
    }
  };

  const sampleAttachments = [
    {
      id: idbImageId,
      name: 'whiteboard_notes.png',
      originalName: 'whiteboard_notes.png',
      type: 'image/png',
      size: VALID_1X1_PNG_BYTES.length,
      formattedSize: '68 B',
      isImage: true,
      previewUrl: 'blob:http://localhost:3000/mock-preview',
      extraction: {
        status: 'ready',
        success: true,
        isImage: true,
        hasText: true,
        text: 'Sprint Goal: Zero unnecessary image hydration',
        totalCharacters: 45,
        totalWords: 6
      }
    },
    {
      id: largeOcrId,
      name: 'highres_scan_5mb.png',
      originalName: 'highres_scan_5mb.png',
      type: 'image/png',
      size: fiveMbBytes.length,
      formattedSize: '5.0 MB',
      isImage: true,
      extraction: {
        status: 'ready',
        success: true,
        isImage: true,
        hasText: true,
        text: 'Quarterly Revenue: $4.2M',
        totalCharacters: 24,
        totalWords: 3
      }
    },
    {
      id: 'att-2b3-trap',
      name: 'trap.png',
      type: 'image/png',
      isImage: true,
      file: trapBlob,
      extraction: {
        status: 'NO_TEXT_DETECTED',
        hasText: false,
        text: ''
      }
    }
  ];

  idbGetCount = 0;
  for (const prov of textOnlyProviders) {
    assert.strictEqual(isVisionCapableProvider(prov), false, `${prov} must be classified as non-vision`);

    const prepared = await hydrateAttachmentsWithImageBytes(sampleAttachments, { provider: prov });
    assert.strictEqual(idbGetCount, 0, `${prov} must trigger 0 IndexedDB getAttachmentRecord reads`);
    assert.strictEqual(inMemoryBlobReadCount, 0, `${prov} must trigger 0 in-memory Blob reads`);
    assert.strictEqual(prepared.length, 3);

    for (const item of prepared) {
      assert.strictEqual(item.base64, undefined, `${prov} attachment must not carry base64`);
      assert.strictEqual(item.dataUrl, undefined, `${prov} attachment must not carry dataUrl`);
      assert.strictEqual(item.file, undefined, `${prov} attachment must not carry File/Blob`);
      assert.strictEqual(item.previewUrl, undefined, `${prov} attachment must not carry previewUrl`);
    }

    assert.strictEqual(prepared[0].extraction.text, 'Sprint Goal: Zero unnecessary image hydration');
    assert.strictEqual(prepared[1].extraction.text, 'Quarterly Revenue: $4.2M');
    assert.strictEqual(prepared[2].extraction.status, 'NO_TEXT_DETECTED');
  }

  // Verify streamAIMessage outgoing /api/chat network payloads for Groq, OpenRouter, Cloudflare, and Ollama
  // strip base64/dataUrl even if caller passed pre-encoded image strings, while preserving OCR text
  const originalFetch = globalThis.fetch;
  const capturedByProvider = new Map();
  globalThis.fetch = async (url, init) => {
    const rawBody = String(init?.body || '');
    const parsed = JSON.parse(rawBody);
    capturedByProvider.set(parsed.provider, { url: String(url), rawBody, parsed });
    return new Response(
      JSON.stringify({
        text: `Grounded response for ${parsed.provider}`,
        modelUsed: `${parsed.provider}-test-model`,
        provider: parsed.provider
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  };

  try {
    const preEncodedSecret = VALID_1X1_PNG_BYTES.toString('base64');
    for (const netProv of ['groq', 'openrouter', 'cloudflare', 'ollama']) {
      const res = await streamAIMessage({
        provider: netProv,
        prompt: 'What is the sprint goal?',
        attachments: [
          {
            ...sampleAttachments[0],
            base64: preEncodedSecret,
            dataUrl: `data:image/png;base64,${preEncodedSecret}`
          }
        ]
      });

      assert.strictEqual(res.provider, netProv);
      const captured = capturedByProvider.get(netProv);
      assert.ok(captured, `Expected /api/chat call for ${netProv}`);
      assert.ok(!captured.rawBody.includes(preEncodedSecret), `${netProv} request body must not upload raw base64 bytes`);
      assert.ok(!captured.rawBody.includes('"base64"'), `${netProv} request body must not include "base64" key`);
      assert.ok(!captured.rawBody.includes('"dataUrl"'), `${netProv} request body must not include "dataUrl" key`);
      assert.strictEqual(
        captured.parsed.attachments[0].extraction.text,
        'Sprint Goal: Zero unnecessary image hydration'
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// Phase 2B.3 — Test 12: OCR text remains available to text-only providers end-to-end & switching back to Gemini hydrates
// ---------------------------------------------------------------------------
await test('Phase 2B.3 — Text-only providers receive OCR text on live /api/chat and switching to Gemini hydrates from IndexedDB', async () => {
  const switchId = `unregistered-2b3-switch-${Date.now()}`;
  await saveAttachmentBlob(switchId, new Blob([VALID_JPEG_BYTES], { type: 'image/jpeg' }), {
    name: 'menu_board.jpg',
    type: 'image/jpeg',
    size: VALID_JPEG_BYTES.length,
    isImage: true
  });

  // Sanitized message attachment as stored in conversation history / localStorage
  const storedUserMsg = sanitizeMessageForStorage({
    id: 'msg-2b3-1',
    sender: 'user',
    content: 'What is on the menu board?',
    attachments: [
      {
        id: switchId,
        name: 'menu_board.jpg',
        originalName: 'menu_board.jpg',
        type: 'image/jpeg',
        size: VALID_JPEG_BYTES.length,
        formattedSize: '22 B',
        isImage: true,
        base64: VALID_JPEG_BYTES.toString('base64'),
        extraction: {
          status: 'ready',
          success: true,
          isImage: true,
          hasText: true,
          format: 'JPG',
          text: 'DAILY SPECIAL: Espresso Tonic $5.50',
          totalCharacters: 35,
          totalWords: 5
        }
      }
    ]
  });
  assert.strictEqual(storedUserMsg.attachments[0].base64, undefined, 'Stored attachment must remain sanitized');

  // Turn 1: Dispatch to Cloudflare (text-only, simulated demo path on live /api/chat without raw bytes)
  idbGetCount = 0;
  const cfAttachments = await hydrateAttachmentsWithImageBytes(storedUserMsg.attachments, {
    provider: 'cloudflare'
  });
  assert.strictEqual(idbGetCount, 0, 'Cloudflare turn must not read IndexedDB');
  assert.strictEqual(cfAttachments[0].base64, undefined);

  const cfBody = prepareChatRequestBody({
    provider: 'cloudflare',
    stream: false,
    prompt: 'What is the daily special in menu_board.jpg?',
    attachments: cfAttachments
  });
  assert.ok(!cfBody.includes('"base64"'));

  const cfRes = await fetch('http://127.0.0.1:3000/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: cfBody
  });
  assert.strictEqual(cfRes.status, 200, 'Live /api/chat for text-only provider must return HTTP 200');
  const cfData = await cfRes.json();
  assert.strictEqual(cfData.provider, 'cloudflare');
  assert.ok(
    cfData.text.includes('Espresso Tonic') || cfData.text.includes('menu_board.jpg'),
    `Expected text-only response grounded in OCR text, got: ${cfData.text}`
  );

  // Verify WebLLM & Ollama context adaptation also retain full OCR text without raw image bytes
  for (const localProv of ['ollama', 'webllm']) {
    const docEntry = {
      ...cfAttachments[0].extraction,
      id: switchId,
      fileId: switchId,
      originalName: 'menu_board.jpg',
      filename: 'menu_board.jpg'
    };
    const prep = prepareDocumentContext('What is the daily special?', [docEntry], { provider: localProv });
    const adapted = adaptDocumentContextForProvider({
      provider: localProv,
      prompt: 'What is the daily special?',
      preparedContext: prep
    });
    assert.ok(adapted.effectivePrompt.includes('DAILY SPECIAL: Espresso Tonic $5.50'));
  }

  // Turn 2: User switches to Gemini in the same conversation -> IndexedDB hydrates exact JPEG bytes
  idbGetCount = 0;
  const geminiAttachments = await hydrateAttachmentsWithImageBytes(storedUserMsg.attachments, {
    provider: 'gemini'
  });
  assert.strictEqual(idbGetCount, 1, 'Switching to Gemini must hydrate image bytes from IndexedDB');
  assert.strictEqual(geminiAttachments[0].mimeType, 'image/jpeg');
  assert.strictEqual(geminiAttachments[0].base64, VALID_JPEG_BYTES.toString('base64'));

  const geminiParts = buildVisionImageParts({ attachments: geminiAttachments });
  assert.strictEqual(geminiParts.length, 1);
  assert.strictEqual(geminiParts[0].mimeType, 'image/jpeg');
  assert.deepStrictEqual(Buffer.from(geminiParts[0].data, 'base64'), VALID_JPEG_BYTES);
});

console.log(`\n=== Image Hydration & Safety Tests Complete: ${passed} Passed, ${failed} Failed ===`);

if (failed > 0) {
  process.exit(1);
} else {
  process.exit(0);
}


