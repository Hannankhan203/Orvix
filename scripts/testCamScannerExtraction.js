import assert from 'node:assert';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import zlib from 'node:zlib';
import { extractDocumentContent } from '../src/services/documentExtractor.js';
import { parseDocumentQueryIntent, prepareDocumentContext } from '../src/services/documentContextService.js';

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
  ihdr[9] = 2;
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
    'M': [0x7f, 0x02, 0x0c, 0x02, 0x7f],
    'N': [0x7f, 0x04, 0x08, 0x10, 0x7f],
    'O': [0x3e, 0x41, 0x41, 0x41, 0x3e],
    'P': [0x7f, 0x09, 0x09, 0x09, 0x06],
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
        if ((colBits >> row) & 1) {
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
    cursorX += 6 * scale;
  }
  return pixels;
}

async function testCurrentBehavior() {
  console.log('Testing PDF extraction for CamScanner with watermark footer:');
  const docB = await PDFDocument.create();
  const font = await docB.embedFont(StandardFonts.Helvetica);
  const pageB = docB.addPage([500, 300]);
  
  // Embed image containing HELLO WORLD
  const w = 480;
  const h = 90;
  const rgb = drawDeterministicTextBitmap(w, h, 'HELLO WORLD');
  const pngB = createDeterministicPng(w, h, rgb);
  const imgB = await docB.embedPng(pngB);
  pageB.drawImage(imgB, { x: 10, y: 150, width: 480, height: 90 });
  
  // CamScanner watermark footer text
  pageB.drawText('Scanned with CamScanner', {
    x: 150,
    y: 20,
    size: 12,
    font
  });
  const pdfBytesB = Buffer.from(await docB.save());

  const extracted = await extractDocumentContent(
    pdfBytesB,
    'CamScanner_01.pdf',
    '.pdf',
    'application/pdf',
    'test-cam-1'
  );

  console.log('Extracted status:', extracted.status);
  console.log('Extracted isScanned:', extracted.isScanned);
  console.log('Extracted text:', JSON.stringify(extracted.text));
  
  assert.strictEqual(extracted.isScanned, true, 'CamScanner PDF must be classified as scanned');
  assert.strictEqual(extracted.status, 'ready', 'Extracted status must be ready');
  assert.match(extracted.text, /HELLO WORLD/, 'Extracted text must contain OCR result from image');
  console.log('SUCCESS: CamScanner extraction test passed!');

  const { discardOcrWorker } = await import('../src/services/imageOcrService.js');
  await discardOcrWorker();
  process.exit(0);
}

testCurrentBehavior().catch((err) => {
  console.error(err);
  process.exit(1);
});
