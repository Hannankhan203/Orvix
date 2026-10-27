/**
 * Phase 2E: End-to-End Integration and Regression Verification Script
 * Exercises the complete attachment pipeline across real files, HTTP endpoints,
 * browser extraction, context adaptation, and provider dispatch.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
import JSZip from 'jszip';

import { extractDocumentContent } from '../src/services/documentExtractor.js';
import {
  extractBrowserDocument,
  isBrowserExtractable,
  countWords,
  truncateSafely,
  extractSectionsFromMarkdown,
  parseDelimitedText
} from '../src/services/browserDocumentExtractor.js';
import {
  prepareDocumentContext,
  generateSimulatedDocumentResponse,
  adaptDocumentContextForProvider,
  formatOpenAIMessages,
  isVisionCapableProvider,
  isImageAttachment,
  PROVIDER_PROFILES
} from '../src/services/documentContextService.js';
import {
  validateImageBuffer,
  normalizeOcrText,
  detectReadableText,
  extractImageText,
  rawImageDataToBmp,
  discardOcrWorker
} from '../src/services/imageOcrService.js';

console.log('=== Starting Phase 2E End-to-End Integration Tests ===\n');

const BASE_URL = 'http://127.0.0.1:3000';
let passedCount = 0;
let failedCount = 0;

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passedCount++;
  } catch (err) {
    console.error(`  ✗ FAIL: ${name}`);
    console.error(err);
    failedCount++;
  }
}

// ----------------------------------------------------------------------------
// Helper Functions for Generating Real File Fixtures
// ----------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }
  return table;
})();

function computeCrc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ -1) | 0;
}

function createPngChunk(type, data) {
  const len = data.length;
  const chunk = Buffer.alloc(12 + len);
  chunk.writeUInt32BE(len, 0);
  chunk.write(type, 4);
  data.copy(chunk, 8);
  const typeAndData = Buffer.concat([Buffer.from(type), data]);
  chunk.writeInt32BE(computeCrc32(typeAndData), 8 + len);
  return chunk;
}

function createDeterministicPng(width, height, rgbData) {
  const scanlineLength = 1 + width * 3;
  const rawData = Buffer.alloc(scanlineLength * height);
  for (let y = 0; y < height; y++) {
    const rawOffset = y * scanlineLength;
    rawData[rawOffset] = 0;
    const srcOffset = y * width * 3;
    rgbData.copy(rawData, rawOffset + 1, srcOffset, srcOffset + width * 3);
  }
  const compressed = zlib.deflateSync(rawData);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    sig,
    createPngChunk('IHDR', ihdr),
    createPngChunk('IDAT', compressed),
    createPngChunk('IEND', Buffer.alloc(0))
  ]);
}

function drawDeterministicTextBitmap(width, height, text) {
  const font5x7 = {
    ' ': [0, 0, 0, 0, 0],
    'A': [0x7c, 0x12, 0x11, 0x12, 0x7c],
    'B': [0x7f, 0x49, 0x49, 0x49, 0x36],
    'C': [0x3e, 0x41, 0x41, 0x41, 0x22],
    'D': [0x7f, 0x41, 0x41, 0x22, 0x1c],
    'E': [0x7f, 0x49, 0x49, 0x49, 0x41],
    'H': [0x7f, 0x08, 0x08, 0x08, 0x7f],
    'L': [0x7f, 0x40, 0x40, 0x40, 0x40],
    'O': [0x3e, 0x41, 0x41, 0x41, 0x3e],
    'R': [0x7f, 0x09, 0x19, 0x29, 0x46],
    'S': [0x46, 0x49, 0x49, 0x49, 0x31],
    'T': [0x01, 0x01, 0x7f, 0x01, 0x01],
    'W': [0x3f, 0x40, 0x38, 0x40, 0x3f],
    '0': [0x3e, 0x51, 0x49, 0x45, 0x3e],
    '1': [0x00, 0x42, 0x7f, 0x40, 0x00],
    '2': [0x42, 0x61, 0x51, 0x49, 0x46]
  };

  const scale = 5;
  const pixels = Buffer.alloc(width * height * 3, 255);
  let cursorX = 30;
  const cursorY = 25;

  for (const char of text.toUpperCase()) {
    const glyph = font5x7[char] || font5x7[' '];
    for (let col = 0; col < 5; col++) {
      const colBits = glyph[col];
      for (let row = 0; row < 7; row++) {
        if ((colBits & (1 << row)) !== 0) {
          for (let dy = 0; dy < scale; dy++) {
            for (let dx = 0; dx < scale; dx++) {
              const px = cursorX + col * scale + dx;
              const py = cursorY + row * scale + dy;
              if (px < width && py < height) {
                const idx = (py * width + px) * 3;
                pixels[idx] = 0;
                pixels[idx + 1] = 0;
                pixels[idx + 2] = 0;
              }
            }
          }
        }
      }
    }
    cursorX += (5 + 2) * scale;
  }
  return pixels;
}

async function buildTestDocxZip() {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`
  );
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
  );
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
            xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"
            mc:Ignorable="wps">
  <w:body>
    <w:p>
      <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
      <w:r><w:t>Project Architecture &amp; Specifications</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>This is a standard paragraph with Unicode symbols: Cafe, resume, and em-dash - confirmed.</w:t></w:r>
    </w:p>
    <w:tbl>
      <w:tr>
        <w:tc><w:p><w:r><w:t>Service</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>Protocol | Port</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>Status</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:p><w:r><w:t>WebLLM</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>WebGPU | Local</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>Active</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
    <mc:AlternateContent>
      <mc:Choice Requires="wps">
        <wps:txbx>
          <w:txbxContent>
            <w:p><w:r><w:t>DrawingML Architecture Sidebar Note</w:t></w:r></w:p>
          </w:txbxContent>
        </wps:txbx>
      </mc:Choice>
    </mc:AlternateContent>
  </w:body>
</w:document>`;
  zip.file('word/document.xml', documentXml);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function buildTestPptxZip() {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
  <Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
</Types>`
  );
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`
  );
  zip.file(
    'ppt/presentation.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
                xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldIdLst>
    <p:sldId id="256" r:id="rId1"/>
    <p:sldId id="257" r:id="rId2"/>
  </p:sldIdLst>
</p:presentation>`
  );
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>
</Relationships>`
  );
  const slide1Xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="1" name="Title 1"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
        <p:txBody><a:p><a:r><a:t>Quarterly Technical Review</a:t></a:r></a:p></p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Body 2"/><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr>
        <p:txBody><a:p><a:r><a:t>System Availability: 99.98%</a:t></a:r></a:p></p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:sld>`;
  const slide2Xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="3" name="Title 2"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
        <p:txBody><a:p><a:r><a:t>Roadmap &amp; Milestones 2026</a:t></a:r></a:p></p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:sld>`;
  zip.file('ppt/slides/slide1.xml', slide1Xml);
  zip.file('ppt/slides/slide2.xml', slide2Xml);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// Helper to upload a buffer to live /api/upload
async function uploadFileViaHttp(filename, mimeType, buffer) {
  const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
  const head = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="files"; filename="${filename}"\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([head, buffer, tail]);

  const res = await fetch(`${BASE_URL}/api/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(body.length)
    },
    body
  });

  const json = await res.json().catch(() => null);
  return { status: res.status, ok: res.ok, data: json };
}

// ----------------------------------------------------------------------------
// Test Group 1: Live HTTP File Upload & Extraction Verification
// ----------------------------------------------------------------------------

await runTest('Live POST /api/upload: Native Text PDF extracts text and returns structured metadata', async () => {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([400, 300]);
  page.drawText('Orvix Native PDF Extraction Architecture Test Document.', { x: 20, y: 250, size: 14 });
  const pdfBytes = Buffer.from(await pdfDoc.save());

  const upload = await uploadFileViaHttp('native_test.pdf', 'application/pdf', pdfBytes);
  assert.strictEqual(upload.status, 200);
  assert.strictEqual(upload.data.success, true);
  assert.strictEqual(upload.data.count, 1);
  const att = upload.data.attachments[0];
  assert.ok(att.id, 'Attachment must have UUID');
  assert.strictEqual(att.format, 'PDF');
  assert.ok(att.extraction.text.includes('Orvix Native PDF Extraction'));
  assert.strictEqual(att.extraction.isScanned, false);
});

await runTest('Live POST /api/upload: Scanned PDF with embedded image triggers OCR path', async () => {
  const w = 480;
  const h = 90;
  const rgb = drawDeterministicTextBitmap(w, h, 'HELLO WORLD');
  const png = createDeterministicPng(w, h, rgb);

  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([500, 200]);
  const img = await pdfDoc.embedPng(png);
  page.drawImage(img, { x: 10, y: 50, width: 480, height: 90 });
  const pdfBytes = Buffer.from(await pdfDoc.save());

  const upload = await uploadFileViaHttp('scanned_test.pdf', 'application/pdf', pdfBytes);
  assert.strictEqual(upload.status, 200);
  assert.strictEqual(upload.data.success, true);
  const att = upload.data.attachments[0];
  assert.strictEqual(att.format, 'PDF');
  assert.strictEqual(att.extraction.isScanned, true);
  assert.strictEqual(att.extraction.hasText, true);
  assert.ok(att.extraction.text.includes('HELLO') || att.extraction.text.includes('WORLD'));
});

await runTest('Live POST /api/upload: Image with text triggers OCR and preserves text', async () => {
  const w = 480;
  const h = 90;
  const rgb = drawDeterministicTextBitmap(w, h, 'HELLO WORLD');
  const png = createDeterministicPng(w, h, rgb);

  const upload = await uploadFileViaHttp('sign.png', 'image/png', png);
  assert.strictEqual(upload.status, 200);
  const att = upload.data.attachments[0];
  assert.strictEqual(att.isImage, true);
  assert.strictEqual(att.extraction.hasText, true);
  assert.ok(att.extraction.text.includes('HELLO') || att.extraction.text.includes('WORLD'));
});

await runTest('Live POST /api/upload: Photo with no text returns status ready and NO_TEXT_DETECTED', async () => {
  const w = 80;
  const h = 80;
  const rgb = Buffer.alloc(w * h * 3, 200); // plain grey photo
  const png = createDeterministicPng(w, h, rgb);

  const upload = await uploadFileViaHttp('photo.png', 'image/png', png);
  assert.strictEqual(upload.status, 200);
  const att = upload.data.attachments[0];
  assert.strictEqual(att.isImage, true);
  assert.strictEqual(att.extraction.hasText, false);
  assert.strictEqual(att.extraction.status, 'NO_TEXT_DETECTED');
});

await runTest('Live POST /api/upload: DOCX with tables and textboxes extracts complete content', async () => {
  const docxBytes = await buildTestDocxZip();
  const upload = await uploadFileViaHttp('architecture.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', docxBytes);
  assert.strictEqual(upload.status, 200);
  const att = upload.data.attachments[0];
  assert.strictEqual(att.format, 'DOCX');
  assert.ok(att.extraction.text.includes('Project Architecture & Specifications'));
  assert.ok(att.extraction.text.includes('DrawingML Architecture Sidebar Note'));
  assert.ok(att.extraction.text.includes('WebGPU | Local') || att.extraction.text.includes('WebGPU'));
});

await runTest('Live POST /api/upload: PPTX with multiple slides preserves slide structure and reading order', async () => {
  const pptxBytes = await buildTestPptxZip();
  const upload = await uploadFileViaHttp('presentation.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', pptxBytes);
  assert.strictEqual(upload.status, 200);
  const att = upload.data.attachments[0];
  assert.strictEqual(att.format, 'PPTX');
  assert.strictEqual(att.extraction.slideCount, 2);
  assert.ok(att.extraction.text.includes('--- Slide 1: Quarterly Technical Review ---'));
  assert.ok(att.extraction.text.includes('System Availability: 99.98%'));
  assert.ok(att.extraction.text.includes('--- Slide 2: Roadmap & Milestones 2026 ---'));
});

await runTest('Live POST /api/upload: CSV, JSON, and XML retain structured tables and entities', async () => {
  // CSV
  const csvBuf = Buffer.from('User,Role,Active\nAlice,Admin,true\nBob,"Software Engineer, Senior",true\n', 'utf8');
  const csvUp = await uploadFileViaHttp('users.csv', 'text/csv', csvBuf);
  assert.strictEqual(csvUp.status, 200);
  assert.ok(csvUp.data.attachments[0].extraction.text.includes('| User  | Role'));
  assert.ok(csvUp.data.attachments[0].extraction.text.includes('Software Engineer, Senior'));

  // JSON
  const jsonBuf = Buffer.from(JSON.stringify({ service: 'Orvix', port: 3000, active: true }, null, 2), 'utf8');
  const jsonUp = await uploadFileViaHttp('config.json', 'application/json', jsonBuf);
  assert.strictEqual(jsonUp.status, 200);
  assert.ok(jsonUp.data.attachments[0].extraction.text.includes('"service": "Orvix"'));

  // XML
  const xmlBuf = Buffer.from('<root><item><title>test &amp; run</title><description><![CDATA[raw <data> here]]></description></item></root>', 'utf8');
  const xmlUp = await uploadFileViaHttp('data.xml', 'application/xml', xmlBuf);
  assert.strictEqual(xmlUp.status, 200);
  assert.ok(xmlUp.data.attachments[0].extraction.text.includes('test & run'));
  assert.ok(xmlUp.data.attachments[0].extraction.text.includes('raw <data> here'));
});

await runTest('Live POST /api/upload: Empty (0 bytes) and corrupted files are explicitly rejected', async () => {
  // 0-byte file
  const emptyUp = await uploadFileViaHttp('empty.txt', 'text/plain', Buffer.alloc(0));
  assert.strictEqual(emptyUp.status, 400);
  assert.ok(emptyUp.data.error.includes('empty (0 bytes)'));

  // Corrupted ELF binary disguised as PDF
  const corruptPdf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x01, 0x02, 0x03]);
  const corruptUp = await uploadFileViaHttp('fake.pdf', 'application/pdf', corruptPdf);
  assert.strictEqual(corruptUp.status, 400);
  assert.ok(corruptUp.data.error.includes('Binary executable format') || corruptUp.data.error.includes('Invalid PDF format'));
});

// ----------------------------------------------------------------------------
// Test Group 2: End-to-End Live Context Preparation & Provider Dispatch
// ----------------------------------------------------------------------------

await runTest('Live POST /api/chat with Photo (No Text): Gemini multimodal path receives raw image without rejection', async () => {
  // Upload a plain photo
  const w = 60;
  const h = 60;
  const rgb = Buffer.alloc(w * h * 3, 128); // solid gray
  const png = createDeterministicPng(w, h, rgb);

  const upload = await uploadFileViaHttp('scenery.png', 'image/png', png);
  assert.strictEqual(upload.status, 200);
  const att = upload.data.attachments[0];

  // Send request to /api/chat with Gemini provider
  const res = await fetch(`${BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: 'Describe the visual color of this image in one word.',
      provider: 'gemini',
      stream: false,
      attachments: [att]
    })
  });

  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.ok(body.text, 'Must receive a generated response');
  assert.ok(
    !body.text.includes('No readable text detected in this image.'),
    'Gemini vision must NOT reject a photo with no text'
  );
  assert.strictEqual(body.provider, 'gemini');
});

await runTest('Live POST /api/chat with Photo (No Text): Text-only provider (Groq) receives directAnswer explaining no text', async () => {
  const w = 60;
  const h = 60;
  const rgb = Buffer.alloc(w * h * 3, 128);
  const png = createDeterministicPng(w, h, rgb);

  const upload = await uploadFileViaHttp('photo_textonly.png', 'image/png', png);
  assert.strictEqual(upload.status, 200);
  const att = upload.data.attachments[0];

  const res = await fetch(`${BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: 'What does this image say?',
      provider: 'groq',
      stream: false,
      attachments: [att]
    })
  });

  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(
    body.text,
    'No readable text detected in this image.',
    'Text-only provider must deliver exact directAnswer rejection'
  );
  assert.strictEqual(body.modelUsed, 'Document Analyzer');
});

await runTest('Live POST /api/chat with Image Text: OCR text is grounded and delivered to model', async () => {
  const w = 480;
  const h = 90;
  const rgb = drawDeterministicTextBitmap(w, h, 'HELLO WORLD');
  const png = createDeterministicPng(w, h, rgb);

  const upload = await uploadFileViaHttp('greeting.png', 'image/png', png);
  assert.strictEqual(upload.status, 200);
  const att = upload.data.attachments[0];

  const res = await fetch(`${BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: 'What text was recognized in greeting.png? Reply with just the words.',
      provider: 'gemini',
      stream: false,
      attachments: [att]
    })
  });

  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.ok(body.text.toUpperCase().includes('HELLO') || body.text.toUpperCase().includes('WORLD'));
});

await runTest('Live POST /api/chat with Scanned PDF: OCR text is delivered in context without empty document rejection', async () => {
  const w = 480;
  const h = 90;
  const rgb = drawDeterministicTextBitmap(w, h, 'HELLO WORLD');
  const png = createDeterministicPng(w, h, rgb);

  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([500, 200]);
  const img = await pdfDoc.embedPng(png);
  page.drawImage(img, { x: 10, y: 50, width: 480, height: 90 });
  const pdfBytes = Buffer.from(await pdfDoc.save());

  const upload = await uploadFileViaHttp('scanned_doc.pdf', 'application/pdf', pdfBytes);
  assert.strictEqual(upload.status, 200);
  const att = upload.data.attachments[0];

  const res = await fetch(`${BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: 'What text is in scanned_doc.pdf?',
      provider: 'gemini',
      stream: false,
      attachments: [att]
    })
  });

  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.ok(!body.text.includes('is empty (contains 0 bytes'));
  assert.ok(body.text.length > 0);
});

await runTest('Live POST /api/chat with DOCX: Headings, tables, and notes reach model context', async () => {
  const docxBytes = await buildTestDocxZip();
  const upload = await uploadFileViaHttp('spec_live.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', docxBytes);
  assert.strictEqual(upload.status, 200);
  const att = upload.data.attachments[0];

  const res = await fetch(`${BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: 'What services are listed in the table in spec_live.docx?',
      provider: 'gemini',
      stream: false,
      attachments: [att]
    })
  });

  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.ok(body.text.toLowerCase().includes('webllm') || body.text.toLowerCase().includes('specifications'));
});

// ----------------------------------------------------------------------------
// Test Group 3: Browser/Offline Path Verification
// ----------------------------------------------------------------------------

await runTest('Browser extraction: extractBrowserDocument extracts plain text and markdown without server', async () => {
  const textContent = 'First Line of Text\nSecond Line with details: 100% offline.';
  const mockFile = new Blob([textContent], { type: 'text/plain' });
  mockFile.name = 'client_notes.txt';

  const result = await extractBrowserDocument(mockFile, {
    name: 'client_notes.txt',
    extension: '.txt',
    mimeType: 'text/plain'
  });

  assert.strictEqual(result.status, 'ready');
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.format, 'TXT');
  assert.ok(result.text.includes('First Line of Text'));
  assert.ok(result.text.includes('100% offline'));
});

await runTest('Browser extraction: extractBrowserDocument extracts DOCX and PPTX locally', async () => {
  const docxBytes = await buildTestDocxZip();
  const docxBlob = new Blob([docxBytes], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  });
  docxBlob.name = 'offline_spec.docx';

  const docxResult = await extractBrowserDocument(docxBlob, {
    name: 'offline_spec.docx',
    extension: '.docx'
  });
  assert.strictEqual(docxResult.status, 'ready');
  assert.ok(docxResult.text.includes('Project Architecture & Specifications'));

  const pptxBytes = await buildTestPptxZip();
  const pptxBlob = new Blob([pptxBytes], {
    type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  });
  pptxBlob.name = 'offline_slides.pptx';

  const pptxResult = await extractBrowserDocument(pptxBlob, {
    name: 'offline_slides.pptx',
    extension: '.pptx'
  });
  assert.strictEqual(pptxResult.status, 'ready');
  assert.strictEqual(pptxResult.slideCount, 2);
  assert.ok(pptxResult.text.includes('Quarterly Technical Review'));
});

await runTest('Browser extraction: isBrowserExtractable rejects formats requiring server OCR when offline', async () => {
  assert.strictEqual(isBrowserExtractable('png'), false);
  assert.strictEqual(isBrowserExtractable('jpg'), false);
  assert.strictEqual(isBrowserExtractable('jpeg'), false);
  assert.strictEqual(isBrowserExtractable('webp'), false);
  assert.strictEqual(isBrowserExtractable('bmp'), false);

  assert.strictEqual(isBrowserExtractable('txt'), true);
  assert.strictEqual(isBrowserExtractable('md'), true);
  assert.strictEqual(isBrowserExtractable('docx'), true);
  assert.strictEqual(isBrowserExtractable('pdf'), true);
  assert.strictEqual(isBrowserExtractable('pptx'), true);
  assert.strictEqual(isBrowserExtractable('csv'), true);
  assert.strictEqual(isBrowserExtractable('json'), true);
  assert.strictEqual(isBrowserExtractable('xml'), true);
});

// ----------------------------------------------------------------------------
// Test Group 4: Context Sizing, Boundaries & Warning Preservations
// ----------------------------------------------------------------------------

await runTest('Context Delivery: Specific page request bounds context to requested page', async () => {
  const multiPageDoc = {
    fileId: 'multi-pdf',
    originalName: 'handbook.pdf',
    filename: 'handbook.pdf',
    format: 'PDF',
    status: 'ready',
    success: true,
    pageCount: 5,
    pages: [
      { pageNumber: 1, text: 'Chapter 1: Getting Started with Orvix.', charCount: 36 },
      { pageNumber: 2, text: 'Chapter 2: Configuration & Credentials.', charCount: 38 },
      { pageNumber: 3, text: 'Chapter 3: Offline Readiness & Service Workers.', charCount: 46 },
      { pageNumber: 4, text: 'Chapter 4: Advanced Multimodal Processing.', charCount: 41 },
      { pageNumber: 5, text: 'Chapter 5: Security & Guardrails.', charCount: 33 }
    ],
    text: 'Chapter 1\nChapter 2\nChapter 3\nChapter 4\nChapter 5',
    totalCharacters: 194,
    totalWords: 28
  };

  const prepPage3 = prepareDocumentContext('What is discussed on page 3 of handbook.pdf?', [multiPageDoc], {
    provider: 'gemini'
  });
  assert.strictEqual(prepPage3.directAnswer, undefined);
  assert.ok(prepPage3.formattedContext.includes('--- Page 3 of 5 ---'));
  assert.ok(prepPage3.formattedContext.includes('Chapter 3: Offline Readiness & Service Workers.'));
  assert.ok(!prepPage3.formattedContext.includes('--- Page 1 of 5 ---'));
  assert.ok(!prepPage3.formattedContext.includes('--- Page 5 of 5 ---'));
});

await runTest('Context Delivery: Out-of-bounds slide request returns explicit boundary explanation', async () => {
  const pptxDoc = {
    fileId: 'pptx-bounds',
    originalName: 'deck.pptx',
    filename: 'deck.pptx',
    format: 'PPTX',
    status: 'ready',
    success: true,
    slideCount: 3,
    slides: [
      { slideNumber: 1, text: 'Slide 1 content' },
      { slideNumber: 2, text: 'Slide 2 content' },
      { slideNumber: 3, text: 'Slide 3 content' }
    ],
    text: 'Slide 1\nSlide 2\nSlide 3',
    totalCharacters: 45,
    totalWords: 9
  };

  const prepSlide99 = prepareDocumentContext('Explain slide 99 of deck.pptx', [pptxDoc], {
    provider: 'groq'
  });
  assert.ok(prepSlide99.directAnswer, 'Must produce directAnswer on invalid slide');
  assert.ok(prepSlide99.directAnswer.includes('contains 3 slides'));
  assert.ok(prepSlide99.directAnswer.includes('Requested slide 99 does not exist'));
});

await runTest('Context Delivery: Bounded chunking activates when document exceeds MAX_PROMPT_CHARS_PER_DOC', async () => {
  const hugeText = 'Paragraph of valuable content. '.repeat(4000); // ~128,000 characters
  const hugeDoc = {
    fileId: 'huge-doc',
    originalName: 'massive_report.txt',
    filename: 'massive_report.txt',
    format: 'TXT',
    status: 'ready',
    success: true,
    totalCharacters: hugeText.length,
    totalWords: 8000,
    text: hugeText
  };

  const prep = prepareDocumentContext('Summarize the massive report', [hugeDoc], {
    provider: 'gemini'
  });
  assert.strictEqual(prep.isBoundedOrChunked, true);
  assert.ok(prep.truncationNote.includes('is an extensive document'));
  assert.ok(prep.formattedContext.includes('Remaining content bounded for context limits'));
});

await runTest('Context Delivery: OCR warnings and engine failures are preserved without misleading success messages', async () => {
  const failedOcrDoc = {
    fileId: 'failed-ocr-doc',
    originalName: 'corrupted_scan.pdf',
    filename: 'corrupted_scan.pdf',
    format: 'PDF',
    status: 'ocr_failed',
    success: false,
    hasText: false,
    text: '',
    error: 'OCR processing failed on scanned pages: Worker execution timed out.',
    totalCharacters: 0,
    totalWords: 0
  };

  const prep = prepareDocumentContext('What is in corrupted_scan.pdf?', [failedOcrDoc], {
    provider: 'groq'
  });
  assert.ok(
    prep.directAnswer.includes('OCR processing failed') ||
    prep.directAnswer.includes('Optical Character Recognition (OCR) failed')
  );
  assert.ok(prep.formattedContext.includes('STATUS: OCR FAILED'));
  assert.ok(!prep.formattedContext.includes('Scan completed successfully'));
});

console.log(`\n=== Phase 2E Verification Complete: ${passedCount} Passed, ${failedCount} Failed ===`);
try {
  await discardOcrWorker();
} catch (_) {}

if (failedCount > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
