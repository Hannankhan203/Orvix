/**
 * scripts/testOfficeDocumentExtraction.js
 *
 * Comprehensive Verification Suite for Office Document Text Extraction:
 *   - .doc  (Legacy MS-DOC Word 97-2003 + Word 6/95 OLE2 binary)
 *   - .ppt  (Legacy MS-PPT PowerPoint 97-2003 OLE2 binary)
 *   - .xls  (Legacy BIFF8 Excel OLE2 binary)
 *   - .xlsx (Modern OpenXML Excel Spreadsheet)
 *
 * Exercises:
 *   1. Real representative binary/OpenXML fixture extraction (reading order, paragraphs,
 *      slide boundaries & notes, worksheet names, Markdown tables, Unicode/CP1252, field codes).
 *   2. Server vs. browser/offline extractor parity (`extractDocumentContent` & `extractBrowserDocument`).
 *   3. Integration with `documentContextService` & Semantic RAG (`semanticRetrievalService`).
 *   4. Malformed, encrypted/password-protected, empty, and oversized files (and zero scanned-PDF mislabeling).
 *   5. End-to-end upload (multipart + direct Supabase), Smart Compression envelope preservation,
 *      original file/MIME/filename preservation on download/preview, and cold-restart rehydration.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import zlib from 'node:zlib';
import CFB from 'cfb';
import JSZip from 'jszip';
import * as XLSX from '@e965/xlsx';

process.env.TESTING = '1';
process.env.FIREBASE_PROJECT_ID = 'orvix-office-extraction-test';

const TEST_PROJECT_ID = 'orvix-office-extraction-test';
const TEST_KID = 'office-extract-kid-1';

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

const { extractDocumentContent } = await import('../src/services/documentExtractor.js');
const {
  extractBrowserDocument,
  isBrowserExtractable
} = await import('../src/services/browserDocumentExtractor.js');
const {
  prepareDocumentContext,
  retrieveSemanticDocumentContext,
  generateSimulatedDocumentResponse,
  adaptDocumentContextForProvider,
  isImageAttachment,
  parseDocumentQueryIntent
} = await import('../src/services/documentContextService.js');
const {
  indexDocuments
} = await import('../src/services/semanticRetrievalService.js');
const {
  resetVectorDBForTesting,
  deleteChunksForConversation
} = await import('../src/services/semanticVectorStorage.js');
const {
  extractSpreadsheetDocument,
  extractLegacyDocDocument,
  extractLegacyPptDocument
} = await import('../src/services/officeDocumentExtractors.js');

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
  resolveRegisteredAttachmentForChat
} = await import('../server/uploadSubsystem.ts');
const { resetQuotaForTesting } = await import('../server/uploadQuotaService.ts');
const {
  prepareAttachmentsForUpload,
  clearFileCompressionCacheEntryForTesting
} = await import('../src/services/attachmentCompressionCoordinator.js');
const { isOrvixStorageEnvelope } = await import('../src/services/storageEnvelopeService.js');
const { app } = await import('../server.ts');

let passed = 0;
let failed = 0;

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`  ✓ PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ FAIL: ${name}`);
    console.error(err);
    failed++;
  }
}

function makeBrowserFile(name, mimeType, bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return {
    name,
    type: mimeType,
    size: buf.length,
    async arrayBuffer() {
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    },
    async text() {
      return buf.toString('utf8');
    }
  };
}

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
  const objects = new Map();
  const bucketMockRoutes = new Map();

  return {
    objects,
    client: {
      storage: {
        async listBuckets() {
          return { data: [{ id: 'orvix-attachments', name: 'orvix-attachments', public: false }], error: null };
        },
        async createBucket() {
          return { data: { name: 'orvix-attachments' }, error: null };
        },
        from(bucketName) {
          return {
            async upload(storagePath, body, opts = {}) {
              objects.set(storagePath, {
                buffer: Buffer.isBuffer(body) ? Buffer.from(body) : Buffer.from(body),
                contentType: opts.contentType || 'application/octet-stream'
              });
              return { data: { path: storagePath }, error: null };
            },
            async download(storagePath) {
              const obj = objects.get(storagePath);
              if (!obj) return { data: null, error: { message: 'Object not found', statusCode: 404 } };
              return { data: new Blob([obj.buffer]), error: null };
            },
            async createSignedUploadUrl(storagePath) {
              const token = crypto.randomBytes(8).toString('hex');
              const signedUrl = `http://mock-supabase.local/upload/${bucketName}/${storagePath}?token=${token}`;
              bucketMockRoutes.set(signedUrl, { bucket: bucketName, storagePath });
              return { data: { signedUrl, path: storagePath, token }, error: null };
            },
            async createSignedUrl(storagePath) {
              if (!objects.has(storagePath)) {
                return { data: null, error: { message: 'Not found', statusCode: 404 } };
              }
              return {
                data: {
                  signedUrl: `https://mock-supabase.local/download/${bucketName}/${encodeURIComponent(storagePath)}`
                },
                error: null
              };
            },
            async remove(paths) {
              const list = Array.isArray(paths) ? paths : [paths];
              for (const p of list) objects.delete(p);
              return { data: list, error: null };
            }
          };
        }
      }
    }
  };
}

// ============================================================================
// Binary Fixture Builders (.xlsx, .xls, .doc, .ppt)
// ============================================================================

async function buildRichXlsxFixture() {
  const wb = XLSX.utils.book_new();

  const sheet1 = XLSX.utils.aoa_to_sheet([
    ['Department', 'Q1 Revenue', 'Q2 Revenue', 'Notes | Status'],
    ['Engineering & AI', 125000, 148500, 'On Track <Phase 2>'],
    ['Cloud Ops', 82000, 91000, 'Approved & Funded']
  ]);
  // Add cached formula and uncached formula
  sheet1['E1'] = { t: 's', v: 'Total' };
  sheet1['E2'] = { t: 'n', f: 'B2+C2', v: 273500 };
  sheet1['!ref'] = 'A1:E3';
  XLSX.utils.book_append_sheet(wb, sheet1, 'Q4 Financials');

  const sheet2 = XLSX.utils.aoa_to_sheet([
    ['Region', 'Active', 'Launch Date'],
    ['APAC South', true, new Date('2026-04-15T00:00:00.000Z')],
    ['EMEA North', false, new Date('2026-07-01T00:00:00.000Z')]
  ]);
  XLSX.utils.book_append_sheet(wb, sheet2, 'Regional Summary');

  // Include a sparse offset sheet & an empty sheet
  const sparseSheet = {
    B2: { t: 's', v: 'Metric' },
    C2: { t: 's', v: 'FormulaFallback' },
    B3: { t: 's', v: 'Uptime SLA' },
    C3: { t: 'n', f: 'AVERAGE(99.9,100)' }, // intentionally no cached value v
    '!ref': 'B2:C3'
  };
  XLSX.utils.book_append_sheet(wb, sparseSheet, 'SLATargets');

  const blankSheet = XLSX.utils.aoa_to_sheet([]);
  XLSX.utils.book_append_sheet(wb, blankSheet, 'BlankSheet');

  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}

function buildRichXlsFixture() {
  const wb = XLSX.utils.book_new();
  const s1 = XLSX.utils.aoa_to_sheet([
    ['SKU', 'Category', 'Units Sold', 'Unit Price'],
    ['ORV-101', 'Hardware | Edge', 420, 199],
    ['ORV-202', 'Enterprise License', 85, 1499]
  ]);
  XLSX.utils.book_append_sheet(wb, s1, 'SalesLedger');

  const s2 = XLSX.utils.aoa_to_sheet([
    ['Target Metric', 'Verified'],
    ['Latency Budget < 50ms', true],
    ['Memory Cap 512MB', false]
  ]);
  XLSX.utils.book_append_sheet(wb, s2, 'Benchmarks');

  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xls' }));
}

function buildEmptyWorkbookBuffer(ext) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([]), 'EmptyTab');
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: ext.replace('.', '') }));
}

/**
 * Builds a genuine OLE2 MS-DOC (.doc) binary file with FIB + 1Table Clx/PlcPcd.
 */
function buildMsDoc97Fixture({
  encrypted = false,
  obfuscated = false,
  empty = false,
  unclosedField = false
} = {}) {
  const piece1Cp1252Str = unclosedField
    ? 'Quarterly Roadmap\rLeading Paragraph Before Field.\r\x13 HYPERLINK "https://internal.invalid"\rTrailing Paragraph After Unclosed Field\r'
    : (
        'Project Helios Architecture\r' +
        'The platform supports \x93low-latency\x94 offline extraction \x97 verified locally.\r' +
        'Documentation link: \x13 HYPERLINK "https://example.com/spec" \x14Orvix Spec Portal\x15.\r' +
        'Component\x07Owner\x07\x07' +
        'Extractor\x07Core Team\x07\x07' +
        'VectorDB\x07RAG Team\x07\x07'
      );

  const piece2UnicodeStr = unclosedField
    ? ''
    : 'Unicode Validation: Caf\u00e9 \u2014 \u65e5\u672c\u8a9e Revenue \u20ac500K.\r';

  const footnoteStr = unclosedField || empty ? '' : 'Footnote 1: Verified against MS-DOC spec.\r';
  const commentStr = unclosedField || empty ? '' : 'Reviewer Comment: Approved for Q4 release.\r';
  const endnoteStr = unclosedField || empty ? '' : 'Endnote A: Historical baseline comparison.\r';
  const textboxStr = unclosedField || empty ? '' : 'Textbox Callout: SLA target is 99.95%.\r';

  const textBaseOffset = 1024;
  // Convert CP1252 test string bytes manually for 0x93, 0x94, 0x97
  const piece1Bytes = empty
    ? Buffer.alloc(0)
    : Buffer.from(
        Array.from(piece1Cp1252Str).map((ch) => {
          const code = ch.charCodeAt(0);
          return code <= 0xff ? code : 0x3f;
        })
      );
  const piece2Bytes = empty ? Buffer.alloc(0) : Buffer.from(piece2UnicodeStr, 'utf16le');
  const ftnBytes = Buffer.from(footnoteStr, 'utf16le');
  const atnBytes = Buffer.from(commentStr, 'utf16le');
  const ednBytes = Buffer.from(endnoteStr, 'utf16le');
  const txbxBytes = Buffer.from(textboxStr, 'utf16le');

  const ccpText = empty ? 0 : piece1Cp1252Str.length + piece2UnicodeStr.length;
  const ccpFtn = footnoteStr.length;
  const ccpHdd = 0;
  const ccpMcr = 0;
  const ccpAtn = commentStr.length;
  const ccpEdn = endnoteStr.length;
  const ccpTxbx = textboxStr.length;

  const totalTextBytes =
    piece1Bytes.length +
    piece2Bytes.length +
    ftnBytes.length +
    atnBytes.length +
    ednBytes.length +
    txbxBytes.length;

  const wordDoc = Buffer.alloc(Math.max(4096, textBaseOffset + totalTextBytes + 64));

  // FIB header
  wordDoc.writeUInt16LE(0xa5ec, 0); // wIdent
  wordDoc.writeUInt16LE(0x00c1, 2); // nFib (Word 97-2003)
  let flags = 0x0200; // fWhichTblStm = 1 ('1Table')
  if (encrypted) flags |= 0x0100;
  if (obfuscated) flags |= 0x8000;
  wordDoc.writeUInt16LE(flags, 10);

  let pos = 32;
  const csw = 14;
  wordDoc.writeUInt16LE(csw, pos);
  pos += 2 + csw * 2;
  const cslw = 22;
  wordDoc.writeUInt16LE(cslw, pos);
  pos += 2;
  wordDoc.writeInt32LE(ccpText, pos + 12);
  wordDoc.writeInt32LE(ccpFtn, pos + 16);
  wordDoc.writeInt32LE(ccpHdd, pos + 20);
  wordDoc.writeInt32LE(ccpMcr, pos + 24);
  wordDoc.writeInt32LE(ccpAtn, pos + 28);
  wordDoc.writeInt32LE(ccpEdn, pos + 32);
  wordDoc.writeInt32LE(ccpTxbx, pos + 36);
  pos += cslw * 4;

  const cbRgFcLcb = 93;
  wordDoc.writeUInt16LE(cbRgFcLcb, pos);
  pos += 2;
  const clxEntryOffset = pos + 33 * 8;

  let tableStream;
  if (empty) {
    wordDoc.writeUInt32LE(0, clxEntryOffset);
    wordDoc.writeUInt32LE(0, clxEntryOffset + 4);
    tableStream = Buffer.alloc(512);
  } else {
    // Write text pieces into WordDocument stream
    const pieces = [];
    let cursor = textBaseOffset;
    let cpCursor = 0;

    // Piece 1: compressed ANSI (fcRaw = (byteOffset * 2) | 0x40000000)
    piece1Bytes.copy(wordDoc, cursor);
    pieces.push({ cpStart: cpCursor, cpEnd: cpCursor + piece1Cp1252Str.length, fcRaw: (cursor * 2) | 0x40000000 });
    cursor += piece1Bytes.length;
    cpCursor += piece1Cp1252Str.length;

    const addUtf16Piece = (str, buf) => {
      if (!str.length) return;
      buf.copy(wordDoc, cursor);
      pieces.push({ cpStart: cpCursor, cpEnd: cpCursor + str.length, fcRaw: cursor });
      cursor += buf.length;
      cpCursor += str.length;
    };

    addUtf16Piece(piece2UnicodeStr, piece2Bytes);
    addUtf16Piece(footnoteStr, ftnBytes);
    addUtf16Piece(commentStr, atnBytes);
    addUtf16Piece(endnoteStr, ednBytes);
    addUtf16Piece(textboxStr, txbxBytes);

    // Build Clx in 1Table: optional Prc (0x01) + Pcdt (0x02)
    const prcLen = 5; // 1 + 2(cb=2) + 2 bytes dummy grpprl
    const pcdtLcb = (pieces.length + 1) * 4 + pieces.length * 8;
    const clxLen = prcLen + 5 + pcdtLcb;
    const fcClx = 128;

    tableStream = Buffer.alloc(fcClx + clxLen + 64);
    let t = fcClx;
    tableStream[t] = 0x01; // Prc
    tableStream.writeUInt16LE(2, t + 1);
    t += prcLen;

    tableStream[t] = 0x02; // Pcdt
    tableStream.writeUInt32LE(pcdtLcb, t + 1);
    t += 5;

    for (let i = 0; i < pieces.length; i++) {
      tableStream.writeInt32LE(pieces[i].cpStart, t + i * 4);
    }
    tableStream.writeInt32LE(pieces[pieces.length - 1].cpEnd, t + pieces.length * 4);
    t += (pieces.length + 1) * 4;

    for (let i = 0; i < pieces.length; i++) {
      tableStream.writeUInt32LE(pieces[i].fcRaw >>> 0, t + i * 8 + 2);
    }

    wordDoc.writeUInt32LE(fcClx, clxEntryOffset);
    wordDoc.writeUInt32LE(clxLen, clxEntryOffset + 4);
  }

  const cfbDoc = CFB.utils.cfb_new();
  CFB.utils.cfb_add(cfbDoc, 'WordDocument', wordDoc);
  CFB.utils.cfb_add(cfbDoc, '1Table', tableStream);
  return Buffer.from(CFB.write(cfbDoc, { type: 'buffer' }));
}

function buildMsDoc95Fixture() {
  const text = 'Legacy Word 95 Section\rWritten in direct CP1252 stream range.\r';
  const textBuf = Buffer.from(text, 'latin1');
  const fcMin = 384;
  const fcMac = fcMin + textBuf.length;
  const wordDoc = Buffer.alloc(1024);
  wordDoc.writeUInt16LE(0xa5dc, 0);
  wordDoc.writeUInt16LE(0x0065, 2); // nFib < 0x00C0 -> Word 6.0/95
  wordDoc.writeUInt32LE(fcMin, 0x18);
  wordDoc.writeUInt32LE(fcMac, 0x1c);
  textBuf.copy(wordDoc, fcMin);

  const cfbDoc = CFB.utils.cfb_new();
  CFB.utils.cfb_add(cfbDoc, 'WordDocument', wordDoc);
  return Buffer.from(CFB.write(cfbDoc, { type: 'buffer' }));
}

// ============================================================================
// MS-PPT Binary Fixture Builder
// ============================================================================

function pptRecord(recVer, recInstance, recType, payload) {
  const hdr = Buffer.alloc(8);
  hdr.writeUInt16LE((recVer & 0x0f) | ((recInstance & 0x0fff) << 4), 0);
  hdr.writeUInt16LE(recType, 2);
  hdr.writeUInt32LE(payload.length, 4);
  return Buffer.concat([hdr, payload]);
}

function makeTextHeaderAtom(textType) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(textType, 0);
  return pptRecord(0x0, 0x0, 3999, buf);
}

function makeTextCharsAtom(str) {
  return pptRecord(0x0, 0x0, 4000, Buffer.from(str, 'utf16le'));
}

function makeTextBytesAtom(str) {
  return pptRecord(0x0, 0x0, 4008, Buffer.from(str, 'latin1'));
}

function makeSlidePersistAtom(persistIdRef, slideId) {
  const payload = Buffer.alloc(20);
  payload.writeUInt32LE(persistIdRef, 0);
  payload.writeUInt32LE(slideId, 12);
  return pptRecord(0x0, 0x0, 1011, payload);
}

function makeNotesAtom(slideIdRef) {
  const payload = Buffer.alloc(8);
  payload.writeUInt32LE(slideIdRef, 0);
  return pptRecord(0x1, 0x0, 1009, payload);
}

function buildMsPptFixture({
  encryptHeaderToken = false,
  encryptSessionRef = false,
  includeCryptContainer = false,
  emptySlides = false
} = {}) {
  // Construct SlideContainer 1 (extra shape text in container to verify PersistDirectory lookup)
  const slide1ExtraShape = makeTextCharsAtom('Shape Box: Key Latency Target < 40ms');
  const slide1Container = pptRecord(0x0f, 0x0, 1006, emptySlides ? Buffer.alloc(0) : slide1ExtraShape);

  // SlideContainer 2 (normal body inside container)
  const slide2ExtraShape = makeTextBytesAtom('Slide 2 Container Footnote');
  const slide2Container = pptRecord(0x0f, 0x0, 1006, emptySlides ? Buffer.alloc(0) : slide2ExtraShape);

  // NotesContainer linked to slideId = 256 (Slide 1)
  const notes1Container = pptRecord(
    0x0f,
    0x0,
    1008,
    Buffer.concat([
      makeNotesAtom(256),
      emptySlides ? Buffer.alloc(0) : makeTextCharsAtom('Speaker should highlight Q4 margin improvement.')
    ])
  );

  // SlideListWithText (recInstance = 0 -> normal slides)
  const slwtSlidesPayload = emptySlides
    ? Buffer.concat([makeSlidePersistAtom(2, 256), makeSlidePersistAtom(3, 257)])
    : Buffer.concat([
        makeSlidePersistAtom(2, 256),
        makeTextHeaderAtom(0), // TX_TYPE_TITLE
        makeTextCharsAtom('Q4 Executive Strategy'),
        makeTextHeaderAtom(1), // TX_TYPE_BODY
        makeTextBytesAtom('Adopted local OLE2 extraction\rZero external API dependency'),
        makeSlidePersistAtom(3, 257),
        makeTextHeaderAtom(6), // TX_TYPE_CENTERTITLE (true title!)
        makeTextCharsAtom('Architecture Deep Dive \u2014 2026'),
        makeTextHeaderAtom(5), // TX_TYPE_CENTERBODY (subtitle - must NOT steal title)
        makeTextCharsAtom('Subtitle: Offline Browser & Server Parity')
      ]);
  const slwtSlides = pptRecord(0x0f, 0x0, 4080, slwtSlidesPayload);

  // SlideListWithText (recInstance = 1 -> master slide placeholders: MUST BE IGNORED)
  const slwtMaster = pptRecord(
    0x0f,
    0x1,
    4080,
    Buffer.concat([
      makeSlidePersistAtom(99, 999),
      makeTextHeaderAtom(0),
      makeTextCharsAtom('Click to edit Master title style')
    ])
  );

  const docChildren = [slwtMaster, slwtSlides];
  if (includeCryptContainer) {
    docChildren.push(pptRecord(0x0f, 0x0, 12052, Buffer.alloc(8)));
  }
  const docContainer = pptRecord(0x0f, 0x0, 1000, Buffer.concat(docChildren));

  // Lay out records inside PowerPoint Document stream:
  // [0]: docContainer (persistId = 1)
  // [off1]: slide1Container (persistId = 2)
  // [off2]: slide2Container (persistId = 3)
  // [off3]: notes1Container (persistId = 4)
  // [pdOff]: PersistDirectoryAtom
  // [editOff]: UserEditAtom
  const chunks = [];
  let cursor = 0;

  const docOffset = cursor;
  chunks.push(docContainer);
  cursor += docContainer.length;

  const slide1Offset = cursor;
  chunks.push(slide1Container);
  cursor += slide1Container.length;

  const slide2Offset = cursor;
  chunks.push(slide2Container);
  cursor += slide2Container.length;

  const notes1Offset = cursor;
  chunks.push(notes1Container);
  cursor += notes1Container.length;

  // PersistDirectoryAtom mapping persistIdStart = 1, cPersist = 4
  const pdOffset = cursor;
  const pdPayload = Buffer.alloc(4 + 4 * 4);
  pdPayload.writeUInt32LE((1 & 0x000fffff) | ((4 & 0x0fff) << 20), 0);
  pdPayload.writeUInt32LE(docOffset, 4);
  pdPayload.writeUInt32LE(slide1Offset, 8);
  pdPayload.writeUInt32LE(slide2Offset, 12);
  pdPayload.writeUInt32LE(notes1Offset, 16);
  const pdAtom = pptRecord(0x0, 0x0, 6002, pdPayload);
  chunks.push(pdAtom);
  cursor += pdAtom.length;

  // UserEditAtom (28 bytes payload)
  const editOffset = cursor;
  const editPayload = Buffer.alloc(28);
  editPayload.writeUInt32LE(0, 8); // offsetLastEdit = 0
  editPayload.writeUInt32LE(pdOffset, 12); // offsetPersistDirectory
  editPayload.writeUInt32LE(1, 16); // docPersistIdRef
  editPayload.writeUInt32LE(encryptSessionRef ? 5 : 0, 24);
  const editAtom = pptRecord(0x0, 0x0, 4085, editPayload);
  chunks.push(editAtom);

  const pptStream = Buffer.concat(chunks);

  // CurrentUserAtom (4086)
  const cuPayload = Buffer.alloc(24);
  cuPayload.writeUInt32LE(0x14, 0); // size = 20
  cuPayload.writeUInt32LE(encryptHeaderToken ? 0xf3d1c4df : 0xe391c05f, 4);
  cuPayload.writeUInt32LE(editOffset, 8);
  const cuStream = pptRecord(0x0, 0x0, 4086, cuPayload);

  const cfbDoc = CFB.utils.cfb_new();
  CFB.utils.cfb_add(cfbDoc, 'PowerPoint Document', pptStream);
  CFB.utils.cfb_add(cfbDoc, 'Current User', cuStream);
  return Buffer.from(CFB.write(cfbDoc, { type: 'buffer' }));
}

function buildEncryptedOle2Stub() {
  const cfbDoc = CFB.utils.cfb_new();
  CFB.utils.cfb_add(cfbDoc, 'EncryptionInfo', Buffer.from([0x04, 0x00, 0x04, 0x00]));
  CFB.utils.cfb_add(cfbDoc, 'EncryptedPackage', Buffer.from('encrypted-payload'));
  return Buffer.from(CFB.write(cfbDoc, { type: 'buffer' }));
}

function buildEncryptedBiffXlsStub() {
  // Workbook stream starting with BOF (0x0809) then FILEPASS (0x002F) then EOF (0x000A)
  const wbStream = Buffer.concat([
    Buffer.from([0x09, 0x08, 0x04, 0x00, 0x00, 0x06, 0x05, 0x00]),
    Buffer.from([0x2f, 0x00, 0x04, 0x00, 0x01, 0x00, 0x01, 0x00]),
    Buffer.from([0x0a, 0x00, 0x00, 0x00])
  ]);
  const cfbDoc = CFB.utils.cfb_new();
  CFB.utils.cfb_add(cfbDoc, 'Workbook', wbStream);
  return Buffer.from(CFB.write(cfbDoc, { type: 'buffer' }));
}

// ============================================================================
// Execution
// ============================================================================

console.log('======================================================================');
console.log('Orvix Office Document Extraction Verification (.doc, .ppt, .xls, .xlsx)');
console.log('======================================================================\n');

const xlsxBuf = await buildRichXlsxFixture();
const xlsBuf = buildRichXlsFixture();
const doc97Buf = buildMsDoc97Fixture();
const doc95Buf = buildMsDoc95Fixture();
const pptBuf = buildMsPptFixture();

console.log('--- Group 1: Core Binary & OpenXML Extraction ---');

await runTest('1.1 .xlsx extraction preserves worksheet names, table structure, dates, booleans, escaping, and formula fallback', async () => {
  const res = await extractDocumentContent(
    xlsxBuf,
    'financials_2026.xlsx',
    '.xlsx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'doc-xlsx-1'
  );
  assert.equal(res.status, 'ready');
  assert.equal(res.success, true);
  assert.equal(res.format, 'XLSX');
  assert.equal(res.isImage, false);
  assert.equal(isImageAttachment(res), false);
  assert.equal(res.sheetCount, 4);
  assert.deepEqual(res.sheetNames, ['Q4 Financials', 'Regional Summary', 'SLATargets', 'BlankSheet']);
  assert.ok(res.text.includes('### Sheet 1: Q4 Financials'));
  assert.ok(res.text.includes('### Sheet 2: Regional Summary'));
  assert.ok(res.text.includes('### Sheet 3: SLATargets'));
  assert.ok(!res.text.includes('### Sheet 4: BlankSheet'), 'Empty worksheets should be omitted from Markdown tables');
  assert.ok(res.text.includes('Notes \\| Status'), 'Pipe characters inside cells must be escaped for Markdown tables');
  assert.ok(res.text.includes('273500'), 'Cached formula numeric result should be extracted');
  assert.ok(res.text.includes('=AVERAGE(99.9,100)'), 'Uncached formula should fall back to formula expression');
  assert.ok(res.text.includes('4/15/26') || res.text.includes('2026-04-15'));
  assert.ok(res.text.includes('TRUE'));
  assert.ok(res.sections.length === 3);
  assert.ok(res.table && res.table.headers.includes('Department'));
});

await runTest('1.2 .xls (BIFF8 OLE2) extraction preserves worksheets, values, booleans, and Markdown tables', async () => {
  const res = await extractDocumentContent(
    xlsBuf,
    'legacy_ledger.xls',
    '.xls',
    'application/vnd.ms-excel',
    'doc-xls-1'
  );
  assert.equal(res.status, 'ready');
  assert.equal(res.success, true);
  assert.equal(res.format, 'XLS');
  assert.equal(res.isImage, false);
  assert.equal(res.sheetCount, 2);
  assert.deepEqual(res.sheetNames, ['SalesLedger', 'Benchmarks']);
  assert.ok(res.text.includes('### Sheet 1: SalesLedger'));
  assert.ok(res.text.includes('### Sheet 2: Benchmarks'));
  assert.ok(res.text.includes('Hardware \\| Edge'));
  assert.ok(res.text.includes('1499'));
  assert.ok(res.text.includes('Latency Budget < 50ms'));
  assert.ok(res.sections.length === 2);
  assert.ok(res.table && res.table.headers[0] === 'SKU');
});

await runTest('1.3 .doc (MS-DOC 97-2003 OLE2) extracts paragraphs, CP1252, UTF-16LE Unicode, field results, tables, notes & sections', async () => {
  const res = await extractDocumentContent(
    doc97Buf,
    'helios_spec.doc',
    '.doc',
    'application/msword',
    'doc-doc-1'
  );
  assert.equal(res.status, 'ready');
  assert.equal(res.success, true);
  assert.equal(res.format, 'DOC');
  assert.equal(res.isImage, false);
  assert.ok(res.text.includes('Project Helios Architecture'));
  assert.ok(res.text.includes('\u201clow-latency\u201d offline extraction \u2014 verified locally.'), 'CP1252 high bytes should decode cleanly');
  assert.ok(res.text.includes('Orvix Spec Portal'), 'Visible field display result must be preserved');
  assert.ok(!res.text.includes('https://example.com/spec'), 'Internal field code instructions must be stripped');
  assert.ok(res.text.includes('| Component') && res.text.includes('| Extractor'), 'MS-DOC table cells must render as Markdown table');
  assert.ok(res.text.includes('Caf\u00e9 \u2014 \u65e5\u672c\u8a9e Revenue \u20ac500K'), 'UTF-16LE piece decoding must preserve Unicode');
  assert.ok(res.text.includes('### Footnotes') && res.text.includes('Verified against MS-DOC spec'));
  assert.ok(res.text.includes('### Endnotes') && res.text.includes('Historical baseline comparison'));
  assert.ok(res.text.includes('### Comments') && res.text.includes('Approved for Q4 release'));
  assert.ok(res.text.includes('### Text Boxes') && res.text.includes('SLA target is 99.95%'));
  assert.ok(res.sections.length >= 2);
});

await runTest('1.4 .doc edge cases: legacy Word 6/95 direct stream & unclosed field code preservation', async () => {
  const res95 = await extractLegacyDocDocument(doc95Buf);
  assert.equal(res95.status, 'ready');
  assert.ok(res95.text.includes('Legacy Word 95 Section'));
  assert.ok(res95.text.includes('Written in direct CP1252 stream range.'));

  const unclosedBuf = buildMsDoc97Fixture({ unclosedField: true });
  const resUnclosed = await extractLegacyDocDocument(unclosedBuf);
  assert.equal(resUnclosed.status, 'ready');
  assert.ok(resUnclosed.text.includes('Leading Paragraph Before Field.'));
  assert.ok(resUnclosed.text.includes('Trailing Paragraph After Unclosed Field'), 'Unclosed 0x13 must not silently drop trailing text');
});

await runTest('1.5 .ppt (MS-PPT OLE2) preserves slide boundaries, CenterTitle vs CenterBody, shapes, speaker notes, and excludes master boilerplate', async () => {
  const res = await extractDocumentContent(
    pptBuf,
    'executive_deck.ppt',
    '.ppt',
    'application/vnd.ms-powerpoint',
    'doc-ppt-1'
  );
  assert.equal(res.status, 'ready');
  assert.equal(res.success, true);
  assert.equal(res.format, 'PPT');
  assert.equal(res.isImage, false);
  assert.equal(res.slideCount, 2);
  assert.equal(res.slides.length, 2);

  assert.equal(res.slides[0].title, 'Q4 Executive Strategy');
  assert.ok(res.slides[0].text.includes('Adopted local OLE2 extraction'));
  assert.ok(res.slides[0].text.includes('Shape Box: Key Latency Target < 40ms'), 'SlideContainer shapes must be merged via PersistDirectory');
  assert.ok(res.slides[0].notes?.includes('Q4 margin improvement'), 'Speaker notes must attach via NotesAtom slideIdRef');

  assert.equal(res.slides[1].title, 'Architecture Deep Dive \u2014 2026', 'TextHeaderAtom type 6 (CenterTitle) must be recognized as title');
  assert.ok(res.slides[1].text.includes('Subtitle: Offline Browser & Server Parity'), 'TextHeaderAtom type 5 (CenterBody) must stay in body');
  assert.ok(res.slides[1].text.includes('Slide 2 Container Footnote'));

  assert.ok(res.text.includes('--- Slide 1: Q4 Executive Strategy ---'));
  assert.ok(res.text.includes('--- Slide 2: Architecture Deep Dive \u2014 2026 ---'));
  assert.ok(res.text.includes('[Speaker Notes]: Speaker should highlight Q4 margin improvement.'));
  assert.ok(!res.text.includes('Click to edit Master title style'), 'Master SlideListWithText (recInstance=1) must be excluded');
});

console.log('\n--- Group 2: Browser / Offline Extraction Parity ---');

await runTest('2.1 isBrowserExtractable returns true for all four formats by extension and MIME type', () => {
  const pairs = [
    ['doc', 'application/msword'],
    ['ppt', 'application/vnd.ms-powerpoint'],
    ['xls', 'application/vnd.ms-excel'],
    ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']
  ];
  for (const [ext, mime] of pairs) {
    assert.equal(isBrowserExtractable(ext), true);
    assert.equal(isBrowserExtractable(`.${ext}`), true);
    assert.equal(isBrowserExtractable('', mime), true);
  }
});

await runTest('2.2 extractBrowserDocument matches server extraction results offline for all 4 formats', async () => {
  const cases = [
    { name: 'financials_2026.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buf: xlsxBuf, fmt: 'XLSX', check: '### Sheet 1: Q4 Financials' },
    { name: 'legacy_ledger.xls', mime: 'application/vnd.ms-excel', buf: xlsBuf, fmt: 'XLS', check: '### Sheet 1: SalesLedger' },
    { name: 'helios_spec.doc', mime: 'application/msword', buf: doc97Buf, fmt: 'DOC', check: 'Project Helios Architecture' },
    { name: 'executive_deck.ppt', mime: 'application/vnd.ms-powerpoint', buf: pptBuf, fmt: 'PPT', check: '--- Slide 1: Q4 Executive Strategy ---' }
  ];

  for (const c of cases) {
    const fileObj = makeBrowserFile(c.name, c.mime, c.buf);
    const browserRes = await extractBrowserDocument(fileObj, `browser-${c.fmt}`);
    assert.equal(browserRes.status, 'ready', `${c.name} should extract in browser`);
    assert.equal(browserRes.success, true);
    assert.equal(browserRes.format, c.fmt);
    assert.ok(browserRes.text.includes(c.check));
    assert.equal(isImageAttachment(browserRes), false);
  }
});

console.log('\n--- Group 3: Document Context, WebLLM Adaptation & Semantic RAG Integration ---');

await runTest('3.1 prepareDocumentContext, parseDocumentQueryIntent, WebLLM adaptation & simulated response handle all 4 formats', async () => {
  const docs = [
    await extractDocumentContent(xlsxBuf, 'financials.xlsx', '.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'ctx-xlsx'),
    await extractDocumentContent(xlsBuf, 'ledger.xls', '.xls', 'application/vnd.ms-excel', 'ctx-xls'),
    await extractDocumentContent(doc97Buf, 'helios.doc', '.doc', 'application/msword', 'ctx-doc'),
    await extractDocumentContent(pptBuf, 'deck.ppt', '.ppt', 'application/vnd.ms-powerpoint', 'ctx-ppt')
  ];

  const intent = parseDocumentQueryIntent('Summarize this Excel workbook', [docs[0]]);
  assert.equal(intent.isDocumentQuery, true);
  assert.equal(intent.targetScope, 'whole_file');

  const xlsxPrep = prepareDocumentContext('Summarize financials.xlsx', [docs[0]], { provider: 'gemini' });
  assert.equal(xlsxPrep.directAnswer, undefined);
  assert.ok(xlsxPrep.formattedContext.includes('Q4 Financials'));
  assert.ok(xlsxPrep.formattedContext.includes('Regional Summary'));

  const simXlsx = generateSimulatedDocumentResponse('Summarize financials.xlsx', xlsxPrep);
  assert.ok(simXlsx.includes('4 Sheets'), `Expected sheet count in summary, got:\n${simXlsx}`);
  assert.ok(simXlsx.includes('Q4 Financials'));

  const multiPrep = prepareDocumentContext('Compare all attached documents in detail', docs, { provider: 'webllm' });
  assert.equal(multiPrep.directAnswer, undefined);
  assert.ok(multiPrep.formattedContext.includes('Engineering & AI'));
  assert.ok(multiPrep.formattedContext.includes('ORV-202'));
  assert.ok(multiPrep.formattedContext.includes('Orvix Spec Portal'));
  assert.ok(multiPrep.formattedContext.includes('Q4 Executive Strategy'));

  const webllmAdapted = adaptDocumentContextForProvider({
    provider: 'webllm',
    prompt: 'Compare all attached documents in detail',
    preparedContext: multiPrep
  });
  assert.ok(webllmAdapted.formattedDocContext.length > 0 || webllmAdapted.effectiveSystemInstruction.length > 0);
  const combinedWebllmText = `${webllmAdapted.effectiveSystemInstruction}\n${webllmAdapted.formattedDocContext}`;
  assert.ok(combinedWebllmText.includes('ORV-202') || combinedWebllmText.includes('Q4 Executive Strategy'));
});

await runTest('3.2 Semantic RAG indexes and retrieves chunks across .doc, .ppt, .xls, and .xlsx with citations', async () => {
  resetVectorDBForTesting();
  const convId = 'conv-office-rag-test';

  const docs = [
    await extractDocumentContent(xlsxBuf, 'financials.xlsx', '.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'rag-xlsx'),
    await extractDocumentContent(xlsBuf, 'ledger.xls', '.xls', 'application/vnd.ms-excel', 'rag-xls'),
    await extractDocumentContent(doc97Buf, 'helios.doc', '.doc', 'application/msword', 'rag-doc'),
    await extractDocumentContent(pptBuf, 'deck.ppt', '.ppt', 'application/vnd.ms-powerpoint', 'rag-ppt')
  ];

  const indexed = await indexDocuments(docs, convId);
  const totalChunks = indexed.reduce((sum, item) => sum + (item.chunkCount || 0), 0);
  assert.ok(totalChunks > 0, `Documents should yield semantic RAG chunks, got ${JSON.stringify(indexed)}`);
  assert.equal(indexed.filter((i) => i.success).length, 4, 'All 4 formats should index cleanly into semantic RAG');

  const ragRes = await retrieveSemanticDocumentContext(
    'What did the speaker notes say about Q4 margin improvement and what are EMEA North launch dates?',
    docs,
    { conversationId: convId, provider: 'gemini' }
  );
  assert.equal(ragRes?.retrievalMethod, 'semantic_rag', 'Semantic RAG must activate over indexed Office documents');
  assert.ok(Array.isArray(ragRes.semanticChunks) && ragRes.semanticChunks.length > 0);
  assert.ok(
    ragRes.formattedContext.includes('deck.ppt') && ragRes.formattedContext.includes('financials.xlsx'),
    `Expected citations from PPT and XLSX in RAG context, got:\n${ragRes.formattedContext}`
  );

  await deleteChunksForConversation(convId);
  resetVectorDBForTesting();
});

console.log('\n--- Group 4: Malformed, Encrypted, Empty, Oversized & Zero Mislabeling ---');

await runTest('4.1 Encrypted / password-protected detection for .xlsx, .xls, .doc, and .ppt', async () => {
  const encStub = buildEncryptedOle2Stub();

  const xlsxEnc = await extractSpreadsheetDocument(encStub, '.xlsx');
  assert.equal(xlsxEnc.status, 'encrypted');
  assert.equal(xlsxEnc.success, false);
  assert.ok(/encrypted|password/i.test(xlsxEnc.error));

  const xlsFilePass = buildEncryptedBiffXlsStub();
  const xlsEnc = await extractSpreadsheetDocument(xlsFilePass, '.xls');
  assert.equal(xlsEnc.status, 'encrypted');
  assert.ok(/encrypted|password/i.test(xlsEnc.error));

  const docEnc = await extractLegacyDocDocument(buildMsDoc97Fixture({ encrypted: true }));
  assert.equal(docEnc.status, 'encrypted');
  assert.ok(/encrypted|password/i.test(docEnc.error));

  const docObf = await extractLegacyDocDocument(buildMsDoc97Fixture({ obfuscated: true }));
  assert.equal(docObf.status, 'encrypted');

  const pptEncTok = await extractLegacyPptDocument(buildMsPptFixture({ encryptHeaderToken: true }));
  assert.equal(pptEncTok.status, 'encrypted');
  assert.ok(/encrypted|password/i.test(pptEncTok.error));

  const pptEncRef = await extractLegacyPptDocument(buildMsPptFixture({ encryptSessionRef: true }));
  assert.equal(pptEncRef.status, 'encrypted');

  const pptEncCtr = await extractLegacyPptDocument(buildMsPptFixture({ includeCryptContainer: true }));
  assert.equal(pptEncCtr.status, 'encrypted');
});

await runTest('4.2 Malformed/corrupted files return clear corrupted errors and are NEVER mislabeled as scanned/image-only', async () => {
  const zipMissingWorkbook = new JSZip();
  zipMissingWorkbook.file('docProps/app.xml', '<Properties/>');
  const badXlsxZip = await zipMissingWorkbook.generateAsync({ type: 'nodebuffer' });

  const cfbNoWorkbook = CFB.utils.cfb_new();
  CFB.utils.cfb_add(cfbNoWorkbook, 'SummaryInfo', Buffer.from([1, 2, 3, 4]));
  const emptyCfb = Buffer.from(CFB.write(cfbNoWorkbook, { type: 'buffer' }));

  const cases = [
    { name: 'bad_zip.doc', ext: '.doc', mime: 'application/msword', buf: xlsxBuf },
    { name: 'missing_stream.doc', ext: '.doc', mime: 'application/msword', buf: emptyCfb },
    { name: 'garbage.doc', ext: '.doc', mime: 'application/msword', buf: Buffer.from('not an ole file') },
    { name: 'bad_zip.ppt', ext: '.ppt', mime: 'application/vnd.ms-powerpoint', buf: xlsxBuf },
    { name: 'missing_stream.ppt', ext: '.ppt', mime: 'application/vnd.ms-powerpoint', buf: emptyCfb },
    { name: 'bad_zip.xls', ext: '.xls', mime: 'application/vnd.ms-excel', buf: xlsxBuf },
    { name: 'missing_workbook.xls', ext: '.xls', mime: 'application/vnd.ms-excel', buf: emptyCfb },
    { name: 'ole2_as.xlsx', ext: '.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buf: doc97Buf },
    { name: 'no_workbook_xml.xlsx', ext: '.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buf: badXlsxZip },
    { name: 'garbage.xlsx', ext: '.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buf: Buffer.from('random text') }
  ];

  for (const c of cases) {
    const res = await extractDocumentContent(c.buf, c.name, c.ext, c.mime, `bad-${c.name}`);
    assert.equal(res.status, 'corrupted', `${c.name} should return corrupted, got ${res.status}`);
    assert.equal(res.success, false);
    assert.ok(res.error && res.error.length > 10, `${c.name} must return descriptive error`);
    assert.equal(isImageAttachment(res), false);

    const prep = prepareDocumentContext(`Read ${c.name}`, [res], { provider: 'gemini' });
    assert.equal(prep.hasErrorsOrWarnings, true);
    assert.ok(prep.formattedContext.includes('STATUS: CORRUPTED'));
    assert.equal(prep.formattedContext.includes('SCANNED/IMAGE-ONLY'), false, `${c.name} must NEVER be mislabeled scanned/image-only`);
    assert.equal(prep.directAnswer?.toLowerCase().includes('scanned'), false);
  }
});

await runTest('4.3 Empty files (0-byte & structurally empty containers) return empty status clearly', async () => {
  const zeroCases = [
    ['zero.doc', '.doc', 'application/msword'],
    ['zero.ppt', '.ppt', 'application/vnd.ms-powerpoint'],
    ['zero.xls', '.xls', 'application/vnd.ms-excel'],
    ['zero.xlsx', '.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']
  ];
  for (const [name, ext, mime] of zeroCases) {
    const res = await extractDocumentContent(Buffer.alloc(0), name, ext, mime, `z-${ext}`);
    assert.equal(res.status, 'empty');
    assert.equal(res.success, false);
    assert.ok(res.warning && res.warning.toLowerCase().includes('empty'));
  }

  const emptyDocRes = await extractLegacyDocDocument(buildMsDoc97Fixture({ empty: true }));
  assert.equal(emptyDocRes.status, 'empty');

  const emptyPptRes = await extractLegacyPptDocument(buildMsPptFixture({ emptySlides: true }));
  assert.equal(emptyPptRes.status, 'empty');
  assert.equal(emptyPptRes.slideCount, 2);

  const emptyXlsxRes = await extractSpreadsheetDocument(buildEmptyWorkbookBuffer('.xlsx'), '.xlsx');
  assert.equal(emptyXlsxRes.status, 'empty');

  const emptyXlsRes = await extractSpreadsheetDocument(buildEmptyWorkbookBuffer('.xls'), '.xls');
  assert.equal(emptyXlsRes.status, 'empty');
});

await runTest('4.4 Oversized files (>25 MB) fail safely with explicit size-limit errors', async () => {
  const oversized = new Uint8Array(26 * 1024 * 1024);
  oversized[0] = 0xd0;

  const docBig = await extractLegacyDocDocument(oversized);
  assert.equal(docBig.status, 'error');
  assert.ok(/limit/i.test(docBig.error));

  const pptBig = await extractLegacyPptDocument(oversized);
  assert.equal(pptBig.status, 'error');
  assert.ok(/limit/i.test(pptBig.error));

  const xlsBig = await extractSpreadsheetDocument(oversized, '.xls');
  assert.equal(xlsBig.status, 'error');
  assert.ok(/limit/i.test(xlsBig.error));

  const xlsxBig = await extractSpreadsheetDocument(oversized, '.xlsx');
  assert.equal(xlsxBig.status, 'error');
  assert.ok(/limit/i.test(xlsxBig.error));
});

console.log('\n--- Group 5: End-to-End Upload, Compression Envelope, Download Preservation & Cold Restart ---');

await runTest('5.1 Multipart /api/upload, direct Supabase upload, envelope preservation, download & post-restart rehydration work for all 4 formats', async () => {
  resetFirebaseAuthForTesting();
  resetQuotaForTesting();
  resetDirectUploadTicketsForTesting();
  fileRegistry.clear();
  conversationDocuments.clear();

  setTestPublicKey(TEST_KID, publicKey);
  const { objects, client } = createMockSupabaseStorageClient();
  setSupabaseServerClientForTesting(client);

  let server;
  let baseUrl = '';

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const s = String(url);
    if (s.startsWith('http://mock-supabase.local/upload/')) {
      const u = new URL(s);
      const parts = u.pathname.split('/');
      const storagePath = decodeURIComponent(parts.slice(3).join('/'));
      const buf = Buffer.isBuffer(init.body) ? init.body : Buffer.from(await new Blob([init.body]).arrayBuffer());
      objects.set(storagePath, {
        buffer: buf,
        contentType: (init.headers && init.headers['Content-Type']) || 'application/octet-stream'
      });
      return new Response(JSON.stringify({ Key: storagePath }), { status: 200 });
    }
    return origFetch(url, init);
  };

  try {
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${addr.port}`;

    const token = createSignedFirebaseToken('user-office-test-1');
    const convId = 'conv-office-http-1';

    // 1. Multipart upload for .xlsx and .ppt (1 file per request per route policy)
    const multipartItems = [
      {
        name: 'Q4_Report.xlsx',
        mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        buf: xlsxBuf,
        expectedFormat: 'XLSX',
        expectedText: '### Sheet 1: Q4 Financials'
      },
      {
        name: 'Strategy.ppt',
        mime: 'application/vnd.ms-powerpoint',
        buf: pptBuf,
        expectedFormat: 'PPT',
        expectedText: '--- Slide 1: Q4 Executive Strategy ---'
      }
    ];

    for (const item of multipartItems) {
      const form = new FormData();
      form.append('conversationId', convId);
      form.append('files', new Blob([item.buf], { type: item.mime }), item.name);

      const upRes = await origFetch(`${baseUrl}/api/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form
      });
      const upJson = await upRes.json();
      assert.equal(upRes.status, 200, `Multipart upload failed for ${item.name}: ${JSON.stringify(upJson)}`);
      assert.equal(upJson.attachments.length, 1);

      const att = upJson.attachments[0];
      assert.equal(att.format, item.expectedFormat);
      assert.equal(att.name, item.name);
      assert.equal(att.mimeType, item.mime);
      assert.equal(att.size, item.buf.length);
      assert.ok(att.extraction.text.includes(item.expectedText));

      // Verify original bytes, filename & MIME preserved on /download, /preview, and /file
      const dlRes = await origFetch(`${baseUrl}/api/upload/${att.id}/download?chatId=${convId}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      assert.equal(dlRes.status, 200);
      const dlBuf = Buffer.from(await dlRes.arrayBuffer());
      assert.equal(Buffer.compare(dlBuf, item.buf), 0, `${att.name} downloaded bytes must match original byte-for-byte`);
      assert.ok((dlRes.headers.get('content-disposition') || '').includes(att.name));

      const prevRes = await origFetch(`${baseUrl}/api/upload/${att.id}/preview?chatId=${convId}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      assert.equal(prevRes.status, 200);
      const prevBuf = Buffer.from(await prevRes.arrayBuffer());
      assert.equal(Buffer.compare(prevBuf, item.buf), 0, `${att.name} /preview bytes must match original`);
    }

    // 2. Direct Supabase upload + Smart Storage Compression coordinator for .doc and .xls
    for (const item of [
      { id: 'dir-doc', ext: 'DOC', name: 'Architecture.doc', mime: 'application/msword', buf: doc97Buf, expectedText: 'Project Helios Architecture' },
      { id: 'dir-xls', ext: 'XLS', name: 'Ledger.xls', mime: 'application/vnd.ms-excel', buf: xlsBuf, expectedText: '### Sheet 1: SalesLedger' }
    ]) {
      const origFile = new File([item.buf], item.name, { type: item.mime });
      const [prepared] = await prepareAttachmentsForUpload([
        {
          id: item.id,
          name: item.name,
          originalName: item.name,
          size: origFile.size,
          type: item.mime,
          extension: item.ext,
          file: origFile
        }
      ]);

      const sc = prepared.storageCompression;
      const wireBuf = sc?.applied ? Buffer.from(await sc.encodedFile.arrayBuffer()) : item.buf;
      if (sc?.applied) {
        assert.ok(isOrvixStorageEnvelope(wireBuf), `${item.name}: compressed payload must be Orvix envelope`);
      }

      const ticketRes = await origFetch(`${baseUrl}/api/upload/direct/signed-url`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          chatId: convId,
          fileName: item.name,
          fileSize: wireBuf.length,
          originalSize: item.buf.length,
          mimeType: item.mime,
          ...(sc?.applied
            ? {
                storageEncoding: sc.encoding,
                storageChecksum: sc.sha256,
                originalMimeType: sc.originalMimeType
              }
            : {})
        })
      });
      const ticketJson = await ticketRes.json();
      assert.equal(ticketRes.status, 200, `Ticket creation failed for ${item.name}: ${JSON.stringify(ticketJson)}`);

      await client.storage.from(ticketJson.bucket).upload(ticketJson.storagePath, wireBuf, {
        contentType: sc?.applied ? 'application/octet-stream' : item.mime
      });

      const compRes = await origFetch(`${baseUrl}/api/upload/direct/complete`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          attachmentId: ticketJson.attachmentId,
          chatId: convId,
          storagePath: ticketJson.storagePath,
          ...(sc?.applied
            ? {
                storageEncoding: sc.encoding,
                originalSize: item.buf.length,
                originalMimeType: sc.originalMimeType,
                storageChecksum: sc.sha256
              }
            : {})
        })
      });
      const compJson = await compRes.json();
      assert.equal(compRes.status, 200, `Direct complete failed for ${item.name}: ${JSON.stringify(compJson)}`);
      const att = compJson.attachment;
      assert.equal(att.name, item.name);
      assert.equal(att.mimeType, item.mime);
      assert.equal(att.size, item.buf.length);
      assert.ok(att.extraction.text.includes(item.expectedText));

      // Verify /file and /signed-url return decoded original bytes & preserve MIME
      const fileRes = await origFetch(`${baseUrl}/api/upload/${att.id}/file?chatId=${convId}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      assert.equal(fileRes.status, 200);
      const fetchedBytes = Buffer.from(await fileRes.arrayBuffer());
      assert.equal(Buffer.compare(fetchedBytes, item.buf), 0, `${item.name} /file bytes must decode identically to original`);

      const signedRes = await origFetch(`${baseUrl}/api/upload/${att.id}/signed-url?chatId=${convId}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      assert.equal(signedRes.status, 200);
      const signedJson = await signedRes.json();
      assert.ok(signedJson.signedUrl);

      // Simulate cold server restart -> clear in-memory registries and verify rehydration!
      const savedStoragePath = att.storagePath;
      fileRegistry.clear();
      conversationDocuments.clear();

      const rehydratedRes = await resolveRegisteredAttachmentForChat(
        {
          id: att.id,
          name: att.name,
          originalName: att.name,
          mimeType: att.mimeType,
          size: att.size,
          conversationId: convId,
          storageProvider: 'supabase',
          storageBucket: 'orvix-attachments',
          storagePath: savedStoragePath,
          storageEncoding: att.storageEncoding || undefined
        },
        {
          authenticatedUserId: 'user-office-test-1',
          conversationId: convId
        }
      );
      assert.equal(rehydratedRes.status, 'ok');
      assert.ok(rehydratedRes.record?.extraction?.text?.includes(item.expectedText), `${item.name} must rehydrate extraction text after restart`);

      const dlAfterRestart = await origFetch(`${baseUrl}/api/upload/${att.id}/download?chatId=${convId}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      assert.equal(dlAfterRestart.status, 200);
      const restartedBytes = Buffer.from(await dlAfterRestart.arrayBuffer());
      assert.equal(Buffer.compare(restartedBytes, item.buf), 0);

      clearFileCompressionCacheEntryForTesting(origFile);
    }
  } finally {
    globalThis.fetch = origFetch;
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    fileRegistry.clear();
    conversationDocuments.clear();
    clearTestPublicKeys();
    resetSupabaseClientForTesting();
    resetDirectUploadTicketsForTesting();
    resetQuotaForTesting();
  }
});

console.log(`\n======================================================================`);
console.log(`Office Extraction Verification Summary: ${passed} Passed, ${failed} Failed`);
console.log('======================================================================');
process.exit(failed > 0 ? 1 : 0);
