import zlib from 'node:zlib';

function createPngChunk(type, data) {
  const len = data.length;
  const chunk = Buffer.alloc(12 + len);
  chunk.writeUInt32BE(len, 0);
  chunk.write(type, 4);
  data.copy(chunk, 8);
  const typeAndData = Buffer.concat([Buffer.from(type), data]);
  const CRC_TABLE = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    CRC_TABLE[i] = c;
  }
  let c = -1;
  for (let i = 0; i < typeAndData.length; i++) {
    c = CRC_TABLE[(c ^ typeAndData[i]) & 0xff] ^ (c >>> 8);
  }
  chunk.writeInt32BE((c ^ -1) | 0, 8 + len);
  return chunk;
}

function createDeterministicPng(width, height) {
  const scanlineLength = 1 + width * 3;
  const rawData = Buffer.alloc(scanlineLength * height);
  for (let y = 0; y < height; y++) {
    rawData[y * scanlineLength] = 0;
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

async function testUpload() {
  const png = createDeterministicPng(100, 50);
  const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
  const crlf = '\r\n';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}${crlf}Content-Disposition: form-data; name="files"; filename="test.png"${crlf}Content-Type: image/png${crlf}${crlf}`),
    png,
    Buffer.from(`${crlf}--${boundary}--${crlf}`)
  ]);

  const res = await fetch('http://127.0.0.1:3000/api/upload', {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body
  });
  const data = await res.json();
  console.log('Upload response extraction:', data.attachments?.[0]?.extraction);

  if (data.attachments?.[0]?.id) {
    const id = data.attachments[0].id;
    const extRes = await fetch('http://127.0.0.1:3000/api/upload/' + id + '/extraction');
    const extData = await extRes.json();
    console.log('Endpoint /api/upload/:id/extraction response:', extData);
  }
}

testUpload();
