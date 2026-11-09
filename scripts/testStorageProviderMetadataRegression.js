/**
 * Dedicated Verification & Regression Suite for Prompt 18:
 * Preserve Supabase Storage Provider Metadata
 *
 * Verifies:
 * 1. Persist storageProvider when available (e.g. 'supabase', 'local').
 * 2. For existing cloud attachments with isCloud === true but no provider value,
 *    safely default storageProvider to 'supabase'.
 * 3. Preserve existing attachment serialization behavior and backward compatibility.
 * 4. Do not persist signed URLs, secrets, temporary URLs, or unnecessary storage paths.
 * 5. Verify restored Firestore attachments are correctly recognized by isCloudAttachmentRecord().
 * 6. Focused regression tests for Supabase attachments, local attachments, and legacy records without provider metadata.
 * 7. Ensure message serialization and cached message restoration preserve provider metadata.
 */

import assert from 'node:assert/strict';

// Set up minimal browser shims for test execution in Node
const mockLocalStorageStore = new Map();
globalThis.window = globalThis;
globalThis.localStorage = {
  getItem: (key) => mockLocalStorageStore.get(key) ?? null,
  setItem: (key, val) => mockLocalStorageStore.set(key, String(val)),
  removeItem: (key) => mockLocalStorageStore.delete(key),
  clear: () => mockLocalStorageStore.clear()
};

const {
  serializeAttachmentForStorage,
  restoreAttachmentFromStorage,
  sanitizeMessageForStorage,
  buildFirestoreMessagePayload,
  saveCachedChatMessages,
  getCachedChatMessages
} = await import('../src/services/chatStorageService.js');

const { isCloudAttachmentRecord } = await import('../src/services/attachmentStorageService.js');

console.log('================================================================');
console.log('REGRESSION SUITE: Supabase Storage Provider Metadata (Prompt 18)');
console.log('================================================================\n');

let passedCount = 0;
let totalTests = 0;

async function runTest(name, fn) {
  totalTests++;
  try {
    await fn();
    console.log(`  ✓ PASS: ${name}`);
    passedCount++;
  } catch (err) {
    console.error(`  ✗ FAIL: ${name}`);
    console.error(`    ${err.stack || err.message}`);
    process.exitCode = 1;
  }
}

// -----------------------------------------------------------------------------
// Test 1: Supabase attachments persist storageProvider and isCloud
// -----------------------------------------------------------------------------
await runTest('Supabase attachment serialization persists storageProvider and isCloud === true', () => {
  const input = {
    id: 'att-sb-001',
    name: 'Quarterly_Report.pdf',
    originalName: 'Quarterly_Report.pdf',
    size: 204800,
    formattedSize: '200 KB',
    type: 'application/pdf',
    mimeType: 'application/pdf',
    extension: 'pdf',
    isImage: false,
    status: 'uploaded',
    storageProvider: 'supabase'
  };

  const serialized = serializeAttachmentForStorage(input);

  assert.equal(serialized.id, 'att-sb-001');
  assert.equal(serialized.name, 'Quarterly_Report.pdf');
  assert.equal(serialized.storageProvider, 'supabase');
  assert.equal(serialized.isCloud, true);

  // Requirement 5: Recognized by isCloudAttachmentRecord
  assert.equal(isCloudAttachmentRecord(serialized), true);
});

// -----------------------------------------------------------------------------
// Test 2: Existing cloud attachment with isCloud === true defaults storageProvider to 'supabase'
// -----------------------------------------------------------------------------
await runTest('Cloud attachment with isCloud === true and no provider value defaults to supabase', () => {
  const input = {
    id: 'att-cloud-legacy-001',
    name: 'Diagram.png',
    originalName: 'Diagram.png',
    size: 10240,
    formattedSize: '10 KB',
    type: 'image/png',
    mimeType: 'image/png',
    extension: 'png',
    isImage: true,
    status: 'ready',
    isCloud: true
    // Note: storageProvider is intentionally omitted
  };

  const serialized = serializeAttachmentForStorage(input);

  assert.equal(serialized.id, 'att-cloud-legacy-001');
  assert.equal(serialized.storageProvider, 'supabase');
  assert.equal(serialized.isCloud, true);

  // Requirement 5: Recognized by isCloudAttachmentRecord
  assert.equal(isCloudAttachmentRecord(serialized), true);
});

// -----------------------------------------------------------------------------
// Test 3: Local attachment serialization persists storageProvider: 'local' and isCloud: false
// -----------------------------------------------------------------------------
await runTest('Local attachment serialization persists storageProvider: "local" and isCloud: false', () => {
  const input = {
    id: 'att-loc-001',
    name: 'scratchpad.txt',
    originalName: 'scratchpad.txt',
    size: 512,
    formattedSize: '512 B',
    type: 'text/plain',
    mimeType: 'text/plain',
    extension: 'txt',
    isImage: false,
    status: 'uploaded',
    storageProvider: 'local'
  };

  const serialized = serializeAttachmentForStorage(input);

  assert.equal(serialized.id, 'att-loc-001');
  assert.equal(serialized.storageProvider, 'local');
  assert.equal(serialized.isCloud, false);

  // Must NOT be misidentified as a cloud resource
  assert.equal(isCloudAttachmentRecord(serialized), false);
});

// -----------------------------------------------------------------------------
// Test 4: Legacy record without provider metadata preserves existing behavior
// -----------------------------------------------------------------------------
await runTest('Legacy record without provider metadata preserves backward compatibility', () => {
  const input = {
    id: 'att-legacy-raw-001',
    name: 'legacy_document.docx',
    originalName: 'legacy_document.docx',
    size: 4096,
    formattedSize: '4 KB',
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extension: 'docx',
    isImage: false,
    status: 'uploaded'
    // Neither storageProvider nor isCloud is present
  };

  const serialized = serializeAttachmentForStorage(input);

  assert.equal(serialized.id, 'att-legacy-raw-001');
  assert.equal(serialized.name, 'legacy_document.docx');
  assert.equal(serialized.size, 4096);
  assert.equal(serialized.storageProvider, undefined);
  assert.equal(serialized.isCloud, undefined);

  // Legacy records without provider or cloud flags are safely treated as local
  assert.equal(isCloudAttachmentRecord(serialized), false);
});

// -----------------------------------------------------------------------------
// Test 5: Security boundary: Never persist signed URLs, secrets, or internal paths
// -----------------------------------------------------------------------------
await runTest('Security boundary: Does not persist signed URLs, secrets, temporary URLs, or storage paths', () => {
  const sensitiveInput = {
    id: 'att-sensitive-001',
    name: 'Confidential.pdf',
    size: 1024,
    type: 'application/pdf',
    storageProvider: 'supabase',
    isCloud: true,
    // Sensitive / temporary attributes that MUST NEVER be serialized into Firestore or cache:
    signedUrl: 'https://supabase.co/storage/v1/object/sign/orvix-attachments/file.pdf?token=secret123',
    url: 'https://supabase.co/storage/v1/object/sign/orvix-attachments/file.pdf?token=secret123',
    previewUrl: 'blob:http://localhost:3000/12345-67890',
    dataUrl: 'data:application/pdf;base64,JVBERi0xLjQK...',
    tempUrl: 'http://localhost:3000/temp/file.pdf',
    temporaryUrl: 'http://localhost:3000/temp/file.pdf',
    downloadUrl: 'https://supabase.co/storage/v1/object/authenticated/file.pdf',
    storagePath: 'user_xyz/chat_123/att-sensitive-001.pdf',
    path: '/var/data/uploads/file.pdf',
    token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
    secret: 'super-secret-key-do-not-leak',
    file: { name: 'Confidential.pdf', size: 1024 },
    blob: { size: 1024, type: 'application/pdf' },
    extraction: {
      text: 'Extracted text content',
      previewUrl: 'blob:http://localhost:3000/preview-123',
      base64: 'JVBERi0xLjQK...',
      dataUrl: 'data:image/png;base64,iVBORw0...',
      file: {},
      blob: {}
    }
  };

  const serialized = serializeAttachmentForStorage(sensitiveInput);

  // Allowed metadata
  assert.equal(serialized.id, 'att-sensitive-001');
  assert.equal(serialized.name, 'Confidential.pdf');
  assert.equal(serialized.storageProvider, 'supabase');
  assert.equal(serialized.isCloud, true);
  assert.equal(serialized.extraction?.text, 'Extracted text content');

  // Strictly prohibited keys
  assert.equal('signedUrl' in serialized, false);
  assert.equal('url' in serialized, false);
  assert.equal('previewUrl' in serialized, false);
  assert.equal('dataUrl' in serialized, false);
  assert.equal('tempUrl' in serialized, false);
  assert.equal('temporaryUrl' in serialized, false);
  assert.equal('downloadUrl' in serialized, false);
  assert.equal('storagePath' in serialized, false);
  assert.equal('path' in serialized, false);
  assert.equal('token' in serialized, false);
  assert.equal('secret' in serialized, false);
  assert.equal('file' in serialized, false);
  assert.equal('blob' in serialized, false);

  // Extraction payload also stripped of binary data & URLs
  assert.equal('previewUrl' in serialized.extraction, false);
  assert.equal('base64' in serialized.extraction, false);
  assert.equal('dataUrl' in serialized.extraction, false);
  assert.equal('file' in serialized.extraction, false);
  assert.equal('blob' in serialized.extraction, false);
});

// -----------------------------------------------------------------------------
// Test 6: restoreAttachmentFromStorage normalizes legacy and cloud attachments
// -----------------------------------------------------------------------------
await runTest('restoreAttachmentFromStorage restores provider metadata and defaults correctly', () => {
  // Case A: Supabase attachment with storageProvider but missing isCloud
  const restoredA = restoreAttachmentFromStorage({
    id: 'att-restored-a',
    name: 'Invoice.pdf',
    storageProvider: 'supabase'
  });
  assert.equal(restoredA.storageProvider, 'supabase');
  assert.equal(restoredA.isCloud, true);
  assert.equal(isCloudAttachmentRecord(restoredA), true);

  // Case B: Legacy Firestore document with isCloud: true but no storageProvider
  const restoredB = restoreAttachmentFromStorage({
    id: 'att-restored-b',
    name: 'Photo.jpg',
    isCloud: true
  });
  assert.equal(restoredB.storageProvider, 'supabase');
  assert.equal(restoredB.isCloud, true);
  assert.equal(isCloudAttachmentRecord(restoredB), true);

  // Case C: Local attachment
  const restoredC = restoreAttachmentFromStorage({
    id: 'att-restored-c',
    name: 'Notes.txt',
    storageProvider: 'local',
    isCloud: false
  });
  assert.equal(restoredC.storageProvider, 'local');
  assert.equal(restoredC.isCloud, false);
  assert.equal(isCloudAttachmentRecord(restoredC), false);

  // Case D: Legacy attachment without provider metadata
  const restoredD = restoreAttachmentFromStorage({
    id: 'att-restored-d',
    name: 'OldNotes.txt'
  });
  assert.equal(restoredD.storageProvider, undefined);
  assert.equal(restoredD.isCloud, undefined);
  assert.equal(isCloudAttachmentRecord(restoredD), false);
});

// -----------------------------------------------------------------------------
// Test 7: sanitizeMessageForStorage preserves attachments & referencedAttachments metadata
// -----------------------------------------------------------------------------
await runTest('sanitizeMessageForStorage preserves provider metadata across message attachments and alternatives', () => {
  const msg = {
    id: 'msg-001',
    sender: 'user',
    content: 'Please analyze this invoice.',
    attachments: [
      { id: 'att-1', name: 'Invoice.pdf', storageProvider: 'supabase' },
      { id: 'att-2', name: 'Offline_Memo.txt', storageProvider: 'local' }
    ],
    referencedAttachments: [
      { id: 'att-1', name: 'Invoice.pdf', storageProvider: 'supabase' }
    ],
    alternatives: [
      {
        id: 'alt-001',
        sender: 'assistant',
        content: 'Analysis of Invoice.pdf',
        referencedAttachments: [
          { id: 'att-1', name: 'Invoice.pdf', storageProvider: 'supabase' }
        ]
      }
    ]
  };

  const sanitized = sanitizeMessageForStorage(msg);

  assert.equal(sanitized.attachments[0].storageProvider, 'supabase');
  assert.equal(sanitized.attachments[0].isCloud, true);
  assert.equal(isCloudAttachmentRecord(sanitized.attachments[0]), true);

  assert.equal(sanitized.attachments[1].storageProvider, 'local');
  assert.equal(sanitized.attachments[1].isCloud, false);
  assert.equal(isCloudAttachmentRecord(sanitized.attachments[1]), false);

  assert.equal(sanitized.referencedAttachments[0].storageProvider, 'supabase');
  assert.equal(sanitized.referencedAttachments[0].isCloud, true);

  assert.equal(sanitized.alternatives[0].referencedAttachments[0].storageProvider, 'supabase');
  assert.equal(sanitized.alternatives[0].referencedAttachments[0].isCloud, true);
});

// -----------------------------------------------------------------------------
// Test 8: buildFirestoreMessagePayload builds valid payload with provider metadata
// -----------------------------------------------------------------------------
await runTest('buildFirestoreMessagePayload formats attachments with storageProvider and isCloud', () => {
  const targetMessage = {
    id: 'msg-firestore-001',
    sender: 'user',
    content: 'Test prompt with attachments',
    timestamp: '10:00 AM',
    attachments: [
      { id: 'att-sb-fs', name: 'CloudFile.pdf', storageProvider: 'supabase' },
      { id: 'att-lc-fs', name: 'LocalFile.txt', storageProvider: 'local' }
    ],
    referencedAttachments: []
  };

  const payload = buildFirestoreMessagePayload(targetMessage);

  assert.equal(payload.id, 'msg-firestore-001');
  assert.equal(payload.attachments[0].id, 'att-sb-fs');
  assert.equal(payload.attachments[0].storageProvider, 'supabase');
  assert.equal(payload.attachments[0].isCloud, true);
  assert.equal(isCloudAttachmentRecord(payload.attachments[0]), true);

  assert.equal(payload.attachments[1].id, 'att-lc-fs');
  assert.equal(payload.attachments[1].storageProvider, 'local');
  assert.equal(payload.attachments[1].isCloud, false);
  assert.equal(isCloudAttachmentRecord(payload.attachments[1]), false);
});

// -----------------------------------------------------------------------------
// Test 9: Cached message storage and retrieval round-trip maintains isCloudAttachmentRecord
// -----------------------------------------------------------------------------
await runTest('saveCachedChatMessages and getCachedChatMessages round-trip preserves provider metadata', () => {
  const userId = 'user_test_99';
  const chatId = 'chat_test_99';

  const messagesToSave = [
    {
      id: 'msg-rt-01',
      sender: 'user',
      content: 'Here are both files.',
      attachments: [
        { id: 'att-sb-rt', name: 'TaxForm.pdf', storageProvider: 'supabase' },
        { id: 'att-lc-rt', name: 'LocalNotes.txt', storageProvider: 'local' },
        { id: 'att-legacy-rt', name: 'Legacy.txt' }
      ]
    }
  ];

  saveCachedChatMessages(userId, chatId, messagesToSave);
  const retrieved = getCachedChatMessages(userId, chatId);

  assert.equal(retrieved.length, 1);
  const restoredAtts = retrieved[0].attachments;

  // Supabase cloud attachment
  assert.equal(restoredAtts[0].id, 'att-sb-rt');
  assert.equal(restoredAtts[0].storageProvider, 'supabase');
  assert.equal(restoredAtts[0].isCloud, true);
  assert.equal(isCloudAttachmentRecord(restoredAtts[0]), true);

  // Local attachment
  assert.equal(restoredAtts[1].id, 'att-lc-rt');
  assert.equal(restoredAtts[1].storageProvider, 'local');
  assert.equal(restoredAtts[1].isCloud, false);
  assert.equal(isCloudAttachmentRecord(restoredAtts[1]), false);

  // Legacy attachment
  assert.equal(restoredAtts[2].id, 'att-legacy-rt');
  assert.equal(restoredAtts[2].storageProvider, undefined);
  assert.equal(restoredAtts[2].isCloud, undefined);
  assert.equal(isCloudAttachmentRecord(restoredAtts[2]), false);
});

console.log('\n================================================================');
console.log(`SUMMARY: ${passedCount}/${totalTests} Tests Passed`);
console.log('================================================================');
