import assert from 'node:assert';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import zlib from 'node:zlib';

const BASE_URL = 'http://127.0.0.1:3000';

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
    'I': [0x00, 0x41, 0x7f, 0x41, 0x00],
    'L': [0x7f, 0x40, 0x40, 0x40, 0x40],
    'M': [0x7f, 0x02, 0x0c, 0x02, 0x7f],
    'N': [0x7f, 0x04, 0x08, 0x10, 0x7f],
    'O': [0x3e, 0x41, 0x41, 0x41, 0x3e],
    'P': [0x7f, 0x09, 0x09, 0x09, 0x06],
    'R': [0x7f, 0x09, 0x19, 0x29, 0x46],
    'S': [0x46, 0x49, 0x49, 0x49, 0x31],
    'T': [0x01, 0x01, 0x7f, 0x01, 0x01],
    'V': [0x0f, 0x30, 0x40, 0x30, 0x0f],
    'W': [0x3f, 0x40, 0x38, 0x40, 0x3f],
    '0': [0x3e, 0x51, 0x49, 0x45, 0x3e],
    '1': [0x00, 0x42, 0x7f, 0x40, 0x00],
    '2': [0x42, 0x61, 0x51, 0x49, 0x46],
    '3': [0x21, 0x41, 0x45, 0x4b, 0x31],
    '4': [0x18, 0x14, 0x12, 0x7f, 0x10],
    '5': [0x27, 0x45, 0x45, 0x45, 0x39]
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

async function uploadFile(name, mime, buffer, conversationId = 'test-conv-1') {
  const boundary = '----WebKitFormBoundaryRepro' + Math.random().toString(36).substring(2);
  const crlf = '\r\n';

  let bodyParts = [
    Buffer.from(`--${boundary}${crlf}Content-Disposition: form-data; name="conversationId"${crlf}${crlf}${conversationId}${crlf}`),
    Buffer.from(`--${boundary}${crlf}Content-Disposition: form-data; name="provider"${crlf}${crlf}gemini${crlf}`),
    Buffer.from(
      `--${boundary}${crlf}` +
      `Content-Disposition: form-data; name="files"; filename="${name}"${crlf}` +
      `Content-Type: ${mime}${crlf}${crlf}`
    ),
    buffer,
    Buffer.from(`${crlf}--${boundary}--${crlf}`)
  ];

  const body = Buffer.concat(bodyParts);
  const res = await fetch(`${BASE_URL}/api/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(body.length)
    },
    body
  });

  const json = await res.json();
  return { status: res.status, data: json };
}

async function main() {
  const convId = 'conv-repro-' + Date.now();

  // 1. Create PDF A: A text-based PDF (contains pure text, NO images)
  const docA = await PDFDocument.create();
  const font = await docA.embedFont(StandardFonts.Helvetica);
  const pageA = docA.addPage([600, 400]);
  pageA.drawText('This is Document A: Financial Annual Report. Total revenue was five million dollars.', {
    x: 50,
    y: 350,
    size: 14,
    font
  });
  const pdfBytesA = Buffer.from(await docA.save());

  console.log('1. Uploading PDF A (text-based report)...');
  const uploadA = await uploadFile('Report_A.pdf', 'application/pdf', pdfBytesA, convId);
  console.log('Upload A status:', uploadA.status, uploadA.data.attachments?.[0]?.name);
  const attA = uploadA.data.attachments[0];

  // Send first chat turn about PDF A
  console.log('Sending chat turn 1 about PDF A...');
  const chat1 = await fetch(`${BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      conversationId: convId,
      prompt: 'What is this document about?',
      provider: 'gemini',
      stream: false,
      attachments: [attA],
      history: []
    })
  });
  const chat1Data = await chat1.json();
  console.log('Turn 1 response:', chat1Data.text.slice(0, 150));
  assert.match(
    chat1Data.text,
    /Financial Annual Report|revenue|five million|Report_A/i,
    'Turn 1 should describe Document A'
  );

  // 2. Create PDF B: CamScanner image-based PDF
  // Draw an image with text "HELLO WORLD"
  const w = 480;
  const h = 90;
  const rgb = drawDeterministicTextBitmap(w, h, 'HELLO WORLD');
  const pngB = createDeterministicPng(w, h, rgb);

  const docB = await PDFDocument.create();
  const pageB = docB.addPage([500, 300]);
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

  console.log('2. Uploading PDF B (CamScanner scanned image PDF)...');
  const uploadB = await uploadFile('CamScanner_05-12.pdf', 'application/pdf', pdfBytesB, convId);
  console.log('Upload B status:', uploadB.status, uploadB.data.attachments?.[0]?.name);
  const attB = uploadB.data.attachments[0];
  console.log('Upload B extraction details:', {
    isScanned: attB.extraction?.isScanned,
    extractedChars: attB.extraction?.totalCharacters,
    textSnippet: attB.extraction?.text?.slice(0, 80)
  });
  assert.strictEqual(attB.extraction?.isScanned, true, 'CamScanner PDF should be marked as scanned');

  // 3. Send turn 2: User asks "extract the text from the images in the new PDF"
  console.log('\nSending chat turn 2 with PDF B attached, asking "extract the text from the images in the new PDF"...');
  const chat2 = await fetch(`${BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      conversationId: convId,
      prompt: 'extract the text from the images in the new PDF',
      provider: 'gemini',
      stream: false,
      attachments: [attB],
      history: [
        { sender: 'user', content: 'What is this document about?', attachments: [attA] },
        { sender: 'assistant', content: chat1Data.text }
      ]
    })
  });
  const chat2Data = await chat2.json();
  console.log('Turn 2 response:', chat2Data.text);

  // Assertions for Turn 2:
  // Must NOT refer to Document A or claim no images
  assert.doesNotMatch(
    chat2Data.text,
    /contains no images|does not contain any images/i,
    'Turn 2 must NOT claim the PDF contains no images'
  );
  assert.doesNotMatch(
    chat2Data.text,
    /Total revenue was five million dollars/i,
    'Turn 2 must NOT answer using Document A'
  );
  // Must refer to CamScanner or the OCR content
  assert.match(
    chat2Data.text,
    /HELLO WORLD|CamScanner/i,
    'Turn 2 must process CamScanner_05-12.pdf and its OCR text'
  );
  console.log('Turn 2 PASSED!');

  // 4. Send turn 3 (without re-attaching): "What is in the new CamScanner PDF?"
  console.log('\nSending chat turn 3 (without re-attaching): "What was the extracted text from the new PDF?"...');
  const chat3 = await fetch(`${BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      conversationId: convId,
      prompt: 'What was the extracted text from the new PDF?',
      provider: 'gemini',
      stream: false,
      attachments: [],
      history: [
        { sender: 'user', content: 'What is this document about?', attachments: [attA] },
        { sender: 'assistant', content: chat1Data.text },
        { sender: 'user', content: 'extract the text from the images in the new PDF', attachments: [attB] },
        { sender: 'assistant', content: chat2Data.text }
      ]
    })
  });
  const chat3Data = await chat3.json();
  console.log('Turn 3 response:', chat3Data.text);

  assert.doesNotMatch(
    chat3Data.text,
    /contains no images/i,
    'Turn 3 must NOT claim the new PDF has no images'
  );
  assert.match(
    chat3Data.text,
    /HELLO WORLD|CamScanner/i,
    'Turn 3 must preserve context of the latest CamScanner PDF'
  );
  console.log('Turn 3 PASSED!');

  console.log('\nAll regression test assertions passed successfully!');
  process.exit(0);
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
