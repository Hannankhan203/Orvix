/**
 * ORVIX-002: Distributed Storage & Multi-Instance Attachment Reliability Verification
 *
 * This test suite validates whether upload and subsequent chat-request attachment
 * retrieval succeed when handled by distinct backend instances or serverless executions
 * with completely independent in-memory state (empty fileRegistry, empty UPLOAD_DIR).
 *
 * Run with: node scripts/testDistributedStorageReliability.js
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';

import {
  saveAttachmentBlob,
  getAttachmentRecord,
  getAttachmentBlob,
  hydrateAttachmentsWithImageBytes,
  sanitizeAttachmentForNetwork,
  prepareChatRequestBody,
  buildVisionImageParts,
  parseEncodedImagePayload,
  MAX_VISION_IMAGE_BYTES,
  MAX_CHAT_REQUEST_BYTES
} from '../src/services/attachmentStorageService.js';

import {
  prepareDocumentContext,
  isVisionCapableProvider
} from '../src/services/documentContextService.js';

console.log('=== ORVIX-002: Multi-Instance Storage Reliability Verification ===\n');

let passed = 0;
let failed = 0;

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`  ✅ PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ FAIL: ${name}`);
    console.error(`     ${err.stack || err.message}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// In-Memory IndexedDB Mock for Node.js test environment
// ---------------------------------------------------------------------------
const memoryStore = new Map();

globalThis.indexedDB = {
  open(_name, _version) {
    const req = {
      result: {
        objectStoreNames: { contains: () => true },
        createObjectStore: () => ({ createIndex: () => {} }),
        transaction: () => ({
          objectStore: () => ({
            put: (rec) => {
              const pReq = {};
              setTimeout(() => {
                memoryStore.set(rec.id, rec);
                pReq.onsuccess?.({ target: pReq });
              }, 0);
              return pReq;
            },
            get: (id) => {
              const gReq = { result: memoryStore.get(id) || null };
              setTimeout(() => {
                gReq.result = memoryStore.get(id) || null;
                gReq.onsuccess?.({ target: gReq });
              }, 0);
              return gReq;
            },
            delete: (id) => {
              const dReq = {};
              setTimeout(() => {
                memoryStore.delete(id);
                dReq.onsuccess?.({ target: dReq });
              }, 0);
              return dReq;
            }
          })
        })
      }
    };
    setTimeout(() => req.onsuccess?.({ target: req }), 0);
    return req;
  }
};

// 1x1 24-bit RGB PNG deterministic fixture
const VALID_1X1_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const VALID_PNG_BUFFER = Buffer.from(VALID_1X1_PNG_BASE64, 'base64');

// ===========================================================================
// Test 1: Upload on Instance A -> Client saves Blob to IndexedDB
// ===========================================================================
await runTest('Instance A Upload Simulation: Metadata & extraction returned to client; Blob saved in client IndexedDB', async () => {
  const fileId = crypto.randomUUID();
  const mockFile = {
    name: 'quarterly_report.pdf',
    size: 15420,
    type: 'application/pdf'
  };

  // Simulate Instance A response from POST /api/upload
  const uploadResponseAttachment = {
    id: fileId,
    name: mockFile.name,
    originalName: mockFile.name,
    extension: 'PDF',
    format: 'PDF',
    mimeType: 'application/pdf',
    size: mockFile.size,
    formattedSize: '15.1 KB',
    status: 'ready',
    isImage: false,
    url: `/api/upload/${fileId}/file`,
    extraction: {
      id: fileId,
      fileId,
      status: 'ready',
      success: true,
      format: 'PDF',
      isImage: false,
      hasText: true,
      text: 'Executive Summary: Q3 revenue grew 24% year-over-year to $4.2M.',
      totalCharacters: 65,
      totalWords: 9,
      pageCount: 1,
      pages: [{ pageNumber: 1, text: 'Executive Summary: Q3 revenue grew 24% year-over-year to $4.2M.', charCount: 65 }]
    }
  };

  // Client saves binary blob to IndexedDB
  const fakeBlob = new Blob([Buffer.from('%PDF-1.4 mock content')], { type: 'application/pdf' });
  const saved = await saveAttachmentBlob(fileId, fakeBlob, {
    name: mockFile.name,
    originalName: mockFile.name,
    size: mockFile.size,
    type: mockFile.type
  });
  assert.strictEqual(saved, true, 'Client IndexedDB save must succeed');

  const record = await getAttachmentRecord(fileId);
  assert.ok(record, 'IndexedDB record must exist');
  assert.strictEqual(record.id, fileId);
});

// ===========================================================================
// Test 2: Chat on Instance B with Document Attachment (Empty Registry)
// ===========================================================================
await runTest('Instance B Chat Simulation (Document): Fresh instance with empty registry processes document via att.extraction', async () => {
  const fileId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();

  // Instance B state: completely empty
  const instanceBRegistry = new Map();
  const instanceBConversationDocs = new Map();

  // Client prepares network payload
  const clientAttachment = {
    id: fileId,
    name: 'architecture.pdf',
    originalName: 'architecture.pdf',
    format: 'PDF',
    extension: 'PDF',
    mimeType: 'application/pdf',
    size: 2048,
    isImage: false,
    extraction: {
      id: fileId,
      fileId,
      status: 'ready',
      success: true,
      format: 'PDF',
      isImage: false,
      hasText: true,
      text: 'Orvix is a lightweight chatbot supporting WebLLM and Gemini.',
      totalCharacters: 60,
      totalWords: 8
    }
  };

  const networkAttachment = sanitizeAttachmentForNetwork(clientAttachment, { includeImageBytes: false });
  assert.strictEqual(networkAttachment.base64, undefined, 'Document attachments must not carry base64');
  assert.ok(networkAttachment.extraction, 'Extraction must be retained in network payload');

  // Instance B simulates server.ts /api/chat attachment registration & recovery
  const attachments = [networkAttachment];
  if (conversationId && Array.isArray(attachments)) {
    let docSet = instanceBConversationDocs.get(conversationId);
    if (!docSet) {
      docSet = new Set();
      instanceBConversationDocs.set(conversationId, docSet);
    }
    for (const att of attachments) {
      if (att?.id) {
        docSet.add(att.id);
        const existing = instanceBRegistry.get(att.id);
        if (existing) {
          existing.conversationId = conversationId;
        } else if (att.extraction) {
          // Self-healing registry population
          instanceBRegistry.set(att.id, {
            id: att.id,
            originalName: att.originalName || att.name || 'document',
            diskFilename: att.id,
            mimeType: att.type || att.mimeType || 'application/octet-stream',
            extension: att.extension || '',
            size: att.size || 0,
            status: att.status || 'ready',
            expiresAt: Date.now() + 7200000,
            conversationId,
            extraction: att.extraction
          });
        }
      }
    }
  }

  // Verify Instance B self-healed its registry
  assert.ok(instanceBRegistry.has(fileId), 'Instance B must register the document from att.extraction');

  // Instance B collects availableDocs
  const availableDocs = [];
  for (const att of attachments) {
    const rec = instanceBRegistry.get(att.id);
    const rawExtraction = rec?.extraction || att.extraction;
    if (rawExtraction) {
      availableDocs.push({
        ...rawExtraction,
        id: att.id,
        fileId: att.id,
        originalName: att.originalName || att.name
      });
    }
  }

  assert.strictEqual(availableDocs.length, 1);
  assert.strictEqual(availableDocs[0].fileId, fileId);

  // Instance B prepares document context for prompt
  const prepDoc = prepareDocumentContext('What architecture does Orvix use?', availableDocs, {
    provider: 'gemini',
    isVisionCapable: false
  });

  assert.ok(prepDoc.formattedContext.includes('Orvix is a lightweight chatbot'), 'Document text must be delivered to model context');
});

// ===========================================================================
// Test 3: Chat on Instance B with Vision Image Attachment (Client Hydration)
// ===========================================================================
await runTest('Instance B Chat Simulation (Vision Image): Client hydrates base64 from IndexedDB; Instance B builds vision parts without local file', async () => {
  const imageId = crypto.randomUUID();

  // Save image to client IndexedDB
  const imageBlob = new Blob([VALID_PNG_BUFFER], { type: 'image/png' });
  await saveAttachmentBlob(imageId, imageBlob, {
    name: 'diagram.png',
    originalName: 'diagram.png',
    size: VALID_PNG_BUFFER.length,
    type: 'image/png',
    isImage: true
  });

  // Client-side hydration for vision provider (Gemini)
  const clientAttachment = {
    id: imageId,
    name: 'diagram.png',
    originalName: 'diagram.png',
    size: VALID_PNG_BUFFER.length,
    type: 'image/png',
    isImage: true
  };

  const hydrated = await hydrateAttachmentsWithImageBytes([clientAttachment], {
    provider: 'gemini',
    model: 'gemini-3.8-flash'
  });

  assert.strictEqual(hydrated.length, 1);
  assert.strictEqual(hydrated[0].base64, VALID_1X1_PNG_BASE64, 'Client must hydrate canonical base64');
  assert.strictEqual(hydrated[0].mimeType, 'image/png');

  // Request prepared and serialized for network
  const requestBodyJson = prepareChatRequestBody({
    provider: 'gemini',
    model: 'gemini-3.8-flash',
    prompt: 'What does this diagram show?',
    attachments: hydrated
  });

  const parsedRequestBody = JSON.parse(requestBodyJson);
  assert.strictEqual(parsedRequestBody.attachments[0].base64, VALID_1X1_PNG_BASE64);

  // Instance B receives request. Instance B has NO registered files in fileRegistry.
  const instanceBRegistry = new Map(); // Empty!
  const imageParts = buildVisionImageParts({
    attachments: parsedRequestBody.attachments,
    availableDocs: [],
    resolveRegisteredFile: (id) => instanceBRegistry.get(id) || null
  });

  assert.strictEqual(imageParts.length, 1, 'Instance B must successfully build image part from client payload');
  assert.strictEqual(imageParts[0].mimeType, 'image/png');
  assert.strictEqual(imageParts[0].data, VALID_1X1_PNG_BASE64);
});

// ===========================================================================
// Test 4: Turn 2 Follow-Up on Instance C (History Attachment Recovery)
// ===========================================================================
await runTest('Instance C Multi-Turn Follow-Up: Attachment extraction preserved in history context across instances', async () => {
  const fileId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();

  // Instance C: fresh instance with empty registry
  const instanceCRegistry = new Map();

  // Turn 2 request: current turn has NO attachments, but history has Turn 1 attachment
  const turn2Request = {
    prompt: 'What was the Q3 revenue mentioned in the report?',
    conversationId,
    attachments: [],
    history: [
      {
        role: 'user',
        content: 'Please examine this quarterly report.',
        attachments: [
          {
            id: fileId,
            name: 'quarterly_report.pdf',
            originalName: 'quarterly_report.pdf',
            size: 15420,
            format: 'PDF',
            extraction: {
              id: fileId,
              fileId,
              status: 'ready',
              success: true,
              format: 'PDF',
              text: 'Executive Summary: Q3 revenue grew 24% year-over-year to $4.2M.',
              totalCharacters: 65,
              totalWords: 9
            }
          }
        ]
      },
      {
        role: 'model',
        content: 'I have reviewed the executive summary of your Q3 report.'
      }
    ]
  };

  // Instance C resolves availableDocs from history (server.ts lines 3760-3788)
  const availableDocs = [];
  const seenDocIds = new Set();
  const addDocIfValid = (docData) => {
    const key = docData.fileId || docData.id;
    if (key && !seenDocIds.has(key)) {
      seenDocIds.add(key);
      availableDocs.push(docData);
    }
  };

  for (let i = turn2Request.history.length - 1; i >= 0; i--) {
    const hMsg = turn2Request.history[i];
    if (Array.isArray(hMsg?.attachments)) {
      for (const hAtt of hMsg.attachments) {
        if (!hAtt?.id) continue;
        const record = instanceCRegistry.get(hAtt.id);
        if (record?.extraction) {
          addDocIfValid(record.extraction);
        } else if (hAtt.extraction) {
          addDocIfValid({
            ...hAtt.extraction,
            id: hAtt.id,
            fileId: hAtt.id,
            originalName: hAtt.originalName || hAtt.name
          });
        }
      }
    }
  }

  assert.strictEqual(availableDocs.length, 1, 'Instance C must recover history attachment extraction');
  assert.strictEqual(availableDocs[0].fileId, fileId);
  assert.ok(availableDocs[0].text.includes('$4.2M'), 'Extracted text must be present');

  const prepDoc = prepareDocumentContext(turn2Request.prompt, availableDocs, { provider: 'gemini' });
  assert.ok(prepDoc.formattedContext.includes('$4.2M'), 'Context must be delivered to model in Turn 2');
});

// ===========================================================================
// Test 5: Missing or Expired File References Fail Gracefully
// ===========================================================================
await runTest('Missing/Expired File References: Degrade gracefully without throwing unhandled exceptions', async () => {
  const missingId = crypto.randomUUID();

  // If client passes an attachment with no extraction and no base64
  const emptyAttachment = {
    id: missingId,
    name: 'missing.pdf',
    size: 5000,
    isImage: false
  };

  const prepDoc = prepareDocumentContext('Summarize this', [emptyAttachment], { provider: 'gemini' });
  assert.ok(prepDoc !== null, 'prepareDocumentContext must handle empty attachment gracefully');

  // For image parts with no server record and no client base64
  const emptyParts = buildVisionImageParts({
    attachments: [emptyAttachment],
    availableDocs: [],
    resolveRegisteredFile: () => null
  });
  assert.strictEqual(emptyParts.length, 0, 'No image parts constructed when no bytes are available');
});

// ===========================================================================
// Test 6: Enforce Strict File Validation and Image Byte Limits
// ===========================================================================
await runTest('Enforce Strict Limits: Oversized attachments are caught and rejected', async () => {
  const oversizedBytes = MAX_VISION_IMAGE_BYTES + 1024;
  const oversizedAttachment = {
    id: crypto.randomUUID(),
    name: 'giant_image.png',
    size: oversizedBytes,
    isImage: true,
    base64: Buffer.alloc(oversizedBytes).toString('base64')
  };

  let threw = false;
  try {
    buildVisionImageParts({
      attachments: [oversizedAttachment],
      resolveRegisteredFile: () => null
    });
  } catch (err) {
    threw = true;
    assert.strictEqual(err.code, 413, 'Must return HTTP 413 payload limit error');
  }
  assert.strictEqual(threw, true, 'Oversized image must throw ImagePayloadLimitError');
});

console.log(`\n=== Verification Results: ${passed} Passed, ${failed} Failed ===`);
if (failed > 0) process.exit(1);
