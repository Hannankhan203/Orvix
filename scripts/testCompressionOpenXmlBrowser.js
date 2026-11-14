/**
 * scripts/testCompressionOpenXmlBrowser.js
 *
 * Real Headless Chromium Test Suite for Lossless OpenXML Compression (DOCX, PPTX, XLSX — Prompt 9).
 * Exercises the full browser compression stack (JSZip DEFLATE level 9 + @jsquash/oxipng + Canvas JPEG/WebP)
 * in real Chromium and verifies:
 * 1. DOCX compression >= 10% preserving XML, relationships, styles, headers, macros (vbaProject.bin),
 *    embedded GIF & vector SVG/EMF/WMF assets untouched, while safely optimizing embedded PNG/JPEG media.
 * 2. PPTX compression >= 10% preserving presentation XML, relationships, slides, speaker notes,
 *    embedded GIF & EMF untouched, while safely optimizing embedded PNG/JPEG/WebP media.
 * 3. XLSX compression >= 10% preserving workbook XML, relationships, sharedStrings, styles, worksheets
 *    and formulas (<f>SUM(...)</f>, <f>IF(...)</f>), SVG untouched, while safely optimizing embedded media.
 * 4. Coordinator (`prepareAttachmentsForUpload`) with `application/octet-stream` MIME resolution.
 * 5. Encrypted / signed / protected OpenXML package skipping (OLE2 EncryptedPackage, ZIP bit-0 encryption,
 *    _xmlsignatures, <w:documentProtection>, <p:modifyVerifier>, <workbookProtection>).
 * 6. Insufficient savings (< 10%), corrupted ZIP, out-of-scope DOC/PPT/XLS/TXT/MD, and AbortSignal cancellation.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function loadPlaywrightChromium() {
  const candidates = [
    'playwright-core',
    'playwright',
    '/usr/local/share/bun-global/node_modules/playwright-core'
  ];
  for (const modPath of candidates) {
    try {
      const mod = require(modPath);
      if (mod?.chromium) return mod.chromium;
    } catch (_) {}
  }
  throw new Error('Could not locate playwright-core or playwright for real browser tests.');
}

function findChromiumExecutable() {
  const candidates = [
    process.env.CHROMIUM_EXECUTABLE_PATH,
    '/ms-playwright/chromium_headless_shell-1247/chrome-headless-shell-linux64/chrome-headless-shell',
    '/ms-playwright/chrome-headless-shell-linux64/chrome-headless-shell',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome'
  ].filter(Boolean);

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

async function startViteTestServer() {
  try {
    const res = await fetch('http://127.0.0.1:3000/src/services/smartCompressionService.js');
    if (res.ok) {
      return { baseUrl: 'http://127.0.0.1:3000', cleanup: async () => {} };
    }
  } catch (_) {}

  const express = (await import('express')).default;
  const { createServer: createViteServer } = await import('vite');
  const app = express();
  const vite = await createViteServer({
    server: { middlewareMode: true, hmr: false },
    appType: 'spa'
  });
  app.use(vite.middlewares);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    cleanup: async () => {
      await vite.close();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

function buildMinimalAnimatedGifBytes() {
  return Array.from([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, // GIF89a
    0x04, 0x00, 0x04, 0x00, 0x80, 0x00, 0x00, // 4x4, 2-color GCT
    0x00, 0x00, 0x00, 0xff, 0xff, 0xff,
    0x21, 0xff, 0x0b, 0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e, 0x30,
    0x03, 0x01, 0x00, 0x00, 0x00,
    0x21, 0xf9, 0x04, 0x01, 0x0a, 0x00, 0x00, 0x00,
    0x2c, 0x00, 0x00, 0x00, 0x00, 0x04, 0x00, 0x04, 0x00, 0x00,
    0x02, 0x02, 0x44, 0x01, 0x00,
    0x21, 0xf9, 0x04, 0x01, 0x14, 0x00, 0x00, 0x00,
    0x2c, 0x00, 0x00, 0x00, 0x00, 0x04, 0x00, 0x04, 0x00, 0x00,
    0x02, 0x02, 0x44, 0x01, 0x00,
    0x3b
  ]);
}

async function runBrowserOpenXmlTests() {
  const chromium = loadPlaywrightChromium();
  const executablePath = findChromiumExecutable();
  const { baseUrl, cleanup } = await startViteTestServer();

  const browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const consoleErrors = [];
  const pageErrors = [];

  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => {
      pageErrors.push(String(err?.message || err));
    });

    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.addScriptTag({ url: `${baseUrl}/node_modules/jszip/dist/jszip.min.js` });

    const gifBytes = buildMinimalAnimatedGifBytes();

    const results = await page.evaluate(
      async ({ gifBytesArr }) => {
        const JSZip = window.JSZip;
        const compressionMod = await import('/src/services/smartCompressionService.js');
        const coordinatorMod = await import('/src/services/attachmentCompressionCoordinator.js');

        const {
          compressFile,
          detectFormatFromSignature,
          measureDecodedImageQuality,
          parseImageHeaderInfo,
          COMPRESSION_REASONS,
          COMPRESSION_STAGES
        } = compressionMod;
        const {
          prepareAttachmentsForUpload,
          clearFileCompressionCacheEntryForTesting
        } = coordinatorMod;

        const DOCX_MIME =
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        const PPTX_MIME =
          'application/vnd.openxmlformats-officedocument.presentationml.presentation';
        const XLSX_MIME =
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

        // Helper: create a real transparent PNG with bloated tEXt chunks so oxipng + DEFLATE yield realistic reduction
        async function createTransparentCanvasPng(width, height, { bloatBytes = 0 } = {}) {
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.clearRect(0, 0, width, height);
          ctx.fillStyle = '#1e293b';
          ctx.fillRect(20, 20, width - 40, height - 40);
          ctx.fillStyle = '#38bdf8';
          for (let i = 0; i < 12; i++) {
            ctx.fillRect(40 + i * 36, 50, 24, height - 100);
          }
          ctx.fillStyle = '#f8fafc';
          ctx.font = 'bold 28px sans-serif';
          ctx.fillText('Orvix Embedded Diagram', 48, 92);
          const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
          const base = new Uint8Array(await blob.arrayBuffer());
          if (!bloatBytes) return base;

          // Inject valid tEXt chunk right before IEND with CRC32
          const crcTable = new Int32Array(256);
          for (let i = 0; i < 256; i++) {
            let c = i;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            crcTable[i] = c;
          }
          const payload = new Uint8Array(9 + bloatBytes);
          const label = 'Software\0';
          for (let i = 0; i < label.length; i++) payload[i] = label.charCodeAt(i);
          for (let i = 9; i < payload.length; i++) payload[i] = 0x4d;

          const chunk = new Uint8Array(12 + payload.length);
          const dv = new DataView(chunk.buffer);
          dv.setUint32(0, payload.length, false);
          chunk[4] = 0x74;
          chunk[5] = 0x45;
          chunk[6] = 0x58;
          chunk[7] = 0x74;
          chunk.set(payload, 8);

          let crc = -1;
          for (let i = 4; i < 8 + payload.length; i++) {
            crc = crcTable[(crc ^ chunk[i]) & 0xff] ^ (crc >>> 8);
          }
          dv.setInt32(8 + payload.length, (crc ^ -1) | 0, false);

          const iendPos = base.length - 12;
          const out = new Uint8Array(base.length + chunk.length);
          out.set(base.subarray(0, iendPos), 0);
          out.set(chunk, iendPos);
          out.set(base.subarray(iendPos), iendPos + chunk.length);
          return out;
        }

        // Helper: create a smooth continuous-tone photographic image (rolling gradient + subtle grain)
        async function createNaturalPhotoImage(width, height, mimeType, quality = 0.99) {
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          const imgData = ctx.createImageData(width, height);
          const d = imgData.data;
          for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
              const idx = (y * width + x) * 4;
              const u = x / width;
              const v = y / height;
              const wave = Math.sin(u * 14 + Math.cos(v * 9) * 1.5) * 35 + Math.cos(v * 11 - u * 5) * 28;
              const grain = Math.sin(x * 0.7 + y * 1.1) * 4;
              d[idx] = Math.max(0, Math.min(255, Math.round(120 + u * 85 + wave + grain)));
              d[idx + 1] = Math.max(0, Math.min(255, Math.round(110 + v * 90 + wave * 0.6 - grain)));
              d[idx + 2] = Math.max(0, Math.min(255, Math.round(160 - u * 55 + Math.sin((u + v) * 12) * 40 + grain)));
              d[idx + 3] = 255;
            }
          }
          ctx.putImageData(imgData, 0, 0);
          const blob = await new Promise((resolve) => canvas.toBlob(resolve, mimeType, quality));
          return new Uint8Array(await blob.arrayBuffer());
        }

        // Helper: crisp overlapping vector circles (where 4:2:0 JPEG subsampling degrades edge sharpness < 95%)
        async function createVectorCirclesJpeg(width, height) {
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          const grad = ctx.createLinearGradient(0, 0, width, height);
          grad.addColorStop(0, '#0f172a');
          grad.addColorStop(0.5, '#0284c7');
          grad.addColorStop(1, '#e11d48');
          ctx.fillStyle = grad;
          ctx.fillRect(0, 0, width, height);
          for (let i = 0; i < 60; i++) {
            ctx.fillStyle = `hsla(${(i * 23) % 360}, 75%, 55%, 0.45)`;
            ctx.beginPath();
            ctx.arc((i * 79) % width, (i * 53) % height, 22 + (i % 35), 0, Math.PI * 2);
            ctx.fill();
          }
          const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.99));
          return new Uint8Array(await blob.arrayBuffer());
        }

        // Helper: crisp chromatic 1px fine text slide (JPEG)
        async function createChromaticFineTextJpeg(width, height) {
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#0f172a';
          ctx.fillRect(0, 0, width, height);
          ctx.font = '11px monospace';
          const colors = ['#ef4444', '#22c55e', '#3b82f6', '#facc15'];
          for (let r = 0; r < 22; r++) {
            ctx.fillStyle = colors[r % colors.length];
            ctx.fillText(`Row ${r}: 1px fine colored metrics RGB=(${r * 11},255,90) SLA=99.98%`, 20, 24 + r * 21);
          }
          const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.96));
          return new Uint8Array(await blob.arrayBuffer());
        }

        // Helper: transparent UI overlay WebP
        async function createTransparentUiWebp(width, height, quality = 0.98) {
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.clearRect(0, 0, width, height);
          ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
          ctx.fillRect(24, 24, width - 48, height - 48);
          ctx.strokeStyle = '#38bdf8';
          ctx.lineWidth = 2;
          ctx.strokeRect(32, 32, width - 64, height - 64);
          ctx.fillStyle = '#f8fafc';
          ctx.font = 'bold 18px sans-serif';
          ctx.fillText('Transparent UI Overlay Card', 56, 86);
          const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', quality));
          return new Uint8Array(await blob.arrayBuffer());
        }

        // Helper: inject lossless-strippable COM segment into JPEG
        function injectJpegComPadding(baseJpg, padBytes = 24_000) {
          const com = new Uint8Array(4 + padBytes).fill(0x43);
          com[0] = 0xff;
          com[1] = 0xfe;
          const segLen = padBytes + 2;
          com[2] = (segLen >> 8) & 0xff;
          com[3] = segLen & 0xff;
          const out = new Uint8Array(baseJpg.length + com.length);
          out.set(baseJpg.subarray(0, 2), 0);
          out.set(com, 2);
          out.set(baseJpg.subarray(2), 2 + com.length);
          return out;
        }

        // Helper: inject lossless-strippable EXIF chunk into WebP & set VP8X EXIF bit
        function injectWebpExifChunk(baseWebp, exifBytes = 24_000) {
          // Ensure baseWebp has VP8X or wrap raw VP8/VP8L in VP8X
          const fourcc = String.fromCharCode(...baseWebp.subarray(12, 16));
          const paddedExifLen = exifBytes + (exifBytes % 2);
          const exifChunk = new Uint8Array(8 + paddedExifLen).fill(0x45);
          exifChunk.set([0x45, 0x58, 0x49, 0x46], 0); // EXIF
          const dvExif = new DataView(exifChunk.buffer);
          dvExif.setUint32(4, exifBytes, true);

          if (fourcc === 'VP8X') {
            const out = new Uint8Array(baseWebp.length + exifChunk.length);
            out.set(baseWebp, 0);
            out.set(exifChunk, baseWebp.length);
            out[20] |= 0x08; // EXIF flag
            const dv = new DataView(out.buffer);
            dv.setUint32(4, out.length - 8, true);
            return out;
          }

          // Parse header dimensions via parseImageHeaderInfo to build valid VP8X wrapper
          const info = parseImageHeaderInfo(baseWebp, 'image/webp');
          const vp8x = new Uint8Array(18);
          vp8x.set([0x56, 0x50, 0x38, 0x58], 0);
          new DataView(vp8x.buffer).setUint32(4, 10, true);
          vp8x[8] = 0x08 | (info.hasAlphaMetadata ? 0x10 : 0);
          const w1 = info.width - 1;
          const h1 = info.height - 1;
          vp8x[12] = w1 & 0xff;
          vp8x[13] = (w1 >> 8) & 0xff;
          vp8x[14] = (w1 >> 16) & 0xff;
          vp8x[15] = h1 & 0xff;
          vp8x[16] = (h1 >> 8) & 0xff;
          vp8x[17] = (h1 >> 16) & 0xff;

          const rest = baseWebp.subarray(12);
          const bodyLen = 4 + vp8x.length + rest.length + exifChunk.length;
          const out = new Uint8Array(8 + bodyLen);
          out.set([0x52, 0x49, 0x46, 0x46], 0);
          new DataView(out.buffer).setUint32(4, bodyLen, true);
          out.set([0x57, 0x45, 0x42, 0x50], 8);
          out.set(vp8x, 12);
          out.set(rest, 12 + vp8x.length);
          out.set(exifChunk, 12 + vp8x.length + rest.length);
          return out;
        }

        const embeddedPngBytes = await createTransparentCanvasPng(560, 340, { bloatBytes: 24_000 });
        const naturalPhotoJpeg = await createNaturalPhotoImage(800, 500, 'image/jpeg', 0.99);
        const naturalPhotoWebp = await createNaturalPhotoImage(800, 500, 'image/webp', 0.99);
        const fineTextJpeg = await createChromaticFineTextJpeg(800, 500);
        const vectorCirclesJpeg = await createVectorCirclesJpeg(640, 400);
        const bloatedMetaJpeg = injectJpegComPadding(fineTextJpeg, 26_000);
        const transparentUiWebp = await createTransparentUiWebp(640, 400, 0.98);
        const losslessUiWebp = await createTransparentUiWebp(640, 400, 1.0);
        const bloatedMetaWebp = injectWebpExifChunk(naturalPhotoWebp, 26_000);

        const embeddedGifBytes = new Uint8Array(gifBytesArr);
        const svgBytes = new TextEncoder().encode(
          '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><circle cx="45" cy="45" r="35" fill="#10b981"/><text x="90" y="50" font-size="14">SVG</text></svg>'
        );
        const emfBytes = new Uint8Array(256).fill(0x2e);
        emfBytes.set([0x01, 0x00, 0x00, 0x00], 0);
        const wmfBytes = new Uint8Array(256).fill(0x4c);
        wmfBytes.set([0xd7, 0xcd, 0xc6, 0x9a], 0);
        const macroBytes = new Uint8Array(1024).fill(0x5a);
        macroBytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);

        async function buildPackage(kind, { compression = 'STORE', extraProtectionXml = '', extraFiles = {} } = {}) {
          const z = new JSZip();
          const lorem = Array.from(
            { length: 420 },
            (_, i) =>
              `<w:p><w:r><w:t>Paragraph ${i + 1}: Production verification text ensuring realistic OpenXML XML compression ratio and structure integrity.</w:t></w:r></w:p>`
          ).join('\n');

          if (kind === 'docx') {
            z.file(
              '[Content_Types].xml',
              `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpg" ContentType="image/jpeg"/><Default Extension="gif" ContentType="image/gif"/><Default Extension="svg" ContentType="image/svg+xml"/><Default Extension="emf" ContentType="image/x-emf"/><Default Extension="wmf" ContentType="image/x-wmf"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`
            );
            z.file(
              '_rels/.rels',
              `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`
            );
            z.file(
              'word/document.xml',
              `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${lorem}</w:body></w:document>`
            );
            z.file(
              'word/_rels/document.xml.rels',
              `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rPng" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/diagram.png"/><Relationship Id="rJpg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/natural-photo.jpg"/><Relationship Id="rGif" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/anim.gif"/><Relationship Id="rSvg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/logo.svg"/></Relationships>`
            );
            z.file('word/styles.xml', `<?xml version="1.0" encoding="UTF-8"?><w:styles>${'<w:style w:type="paragraph"/>'.repeat(60)}</w:styles>`);
            z.file('word/header1.xml', `<?xml version="1.0" encoding="UTF-8"?><w:hdr><w:p><w:r><w:t>Header Intact</w:t></w:r></w:p></w:hdr>`);
            z.file('word/vbaProject.bin', macroBytes);
            z.file('word/media/diagram.png', embeddedPngBytes);
            z.file('word/media/natural-photo.jpg', naturalPhotoJpeg);
            z.file('word/media/bloated-meta.jpg', bloatedMetaJpeg);
            z.file('word/media/fine-text.jpg', fineTextJpeg);
            z.file('word/media/vector-circles.jpg', vectorCirclesJpeg);
            z.file('word/media/anim.gif', embeddedGifBytes);
            z.file('word/media/logo.svg', svgBytes);
            z.file('word/media/vector.emf', emfBytes);
            z.file('word/media/legacy.wmf', wmfBytes);
            if (extraProtectionXml) {
              z.file('word/settings.xml', extraProtectionXml);
            }
          } else if (kind === 'pptx') {
            const slideShapes = Array.from(
              { length: 420 },
              (_, i) =>
                `<p:sp><p:txBody><a:p><a:r><a:t>Slide Shape ${i + 1}: High-clarity technical deck item.</a:t></a:r></a:p></p:txBody></p:sp>`
            ).join('\n');
            z.file(
              '[Content_Types].xml',
              `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>`
            );
            z.file(
              '_rels/.rels',
              `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`
            );
            z.file(
              'ppt/presentation.xml',
              `<?xml version="1.0" encoding="UTF-8"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>${extraProtectionXml}</p:presentation>`
            );
            z.file(
              'ppt/_rels/presentation.xml.rels',
              `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>`
            );
            z.file(
              'ppt/slides/slide1.xml',
              `<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>${slideShapes}</p:spTree></p:cSld></p:sld>`
            );
            z.file(
              'ppt/slides/_rels/slide1.xml.rels',
              `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rNotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>`
            );
            z.file(
              'ppt/notesSlides/notesSlide1.xml',
              `<?xml version="1.0" encoding="UTF-8"?><p:notes><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Speaker Notes Exact Parity</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`
            );
            z.file('ppt/media/diagram.png', embeddedPngBytes);
            z.file('ppt/media/natural-photo.webp', naturalPhotoWebp);
            z.file('ppt/media/bloated-meta.webp', bloatedMetaWebp);
            z.file('ppt/media/transparent-ui.webp', transparentUiWebp);
            z.file('ppt/media/lossless-ui.webp', losslessUiWebp);
            z.file('ppt/media/anim.gif', embeddedGifBytes);
            z.file('ppt/media/chart.emf', emfBytes);
          } else if (kind === 'xlsx') {
            const rows = Array.from(
              { length: 500 },
              (_, i) =>
                `<row r="${i + 1}"><c r="A${i + 1}" t="n"><v>${(i + 1) * 15}</v></c><c r="B${i + 1}"><f>SUM(A1:A${i + 1})</f><v>0</v></c></row>`
            ).join('\n');
            z.file(
              '[Content_Types].xml',
              `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`
            );
            z.file(
              '_rels/.rels',
              `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`
            );
            z.file(
              'xl/workbook.xml',
              `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="Forecast" sheetId="1" r:id="rId1"/></sheets>${extraProtectionXml}</workbook>`
            );
            z.file(
              'xl/_rels/workbook.xml.rels',
              `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`
            );
            z.file(
              'xl/sharedStrings.xml',
              `<?xml version="1.0" encoding="UTF-8"?><sst count="2" uniqueCount="2"><si><t>ARR</t></si><si><t>Growth</t></si></sst>`
            );
            z.file('xl/styles.xml', `<?xml version="1.0" encoding="UTF-8"?><styleSheet><fonts count="1"/></styleSheet>`);
            z.file(
              'xl/worksheets/sheet1.xml',
              `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}<row r="501"><c r="C501"><f>IF(B500&gt;0,B500*1.25,0)</f><v>0</v></c></row></sheetData></worksheet>`
            );
            z.file('xl/media/chart.png', embeddedPngBytes);
            z.file('xl/media/logo.svg', svgBytes);
          }

          for (const [k, v] of Object.entries(extraFiles)) {
            z.file(k, v);
          }

          return await z.generateAsync({
            type: 'uint8array',
            compression,
            compressionOptions: compression === 'DEFLATE' ? { level: 9 } : undefined
          });
        }

        function bytesEqual(a, b) {
          if (a.length !== b.length) return false;
          for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
          return true;
        }

        async function decodeToRgba(bytes, mimeType) {
          const bmp = await createImageBitmap(new Blob([bytes], { type: mimeType }));
          const canvas = document.createElement('canvas');
          canvas.width = bmp.width;
          canvas.height = bmp.height;
          const ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: true });
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(bmp, 0, 0);
          bmp.close();
          return { width: canvas.width, height: canvas.height, rgba: ctx.getImageData(0, 0, canvas.width, canvas.height).data };
        }

        async function verifyReopenedOpenXml(origBytes, compBytes, untouchedPaths, optimizedMediaChecks) {
          const origZip = await JSZip.loadAsync(origBytes);
          const compZip = await JSZip.loadAsync(compBytes);
          const origKeys = Object.keys(origZip.files).filter((k) => !origZip.files[k].dir).sort();
          const compKeys = Object.keys(compZip.files).filter((k) => !compZip.files[k].dir).sort();
          const sameEntrySet =
            origKeys.length === compKeys.length && origKeys.every((k, i) => k === compKeys[i]);

          let allUntouchedMatch = true;
          const mismatchedUntouched = [];
          for (const p of untouchedPaths) {
            const a = await origZip.file(p).async('uint8array');
            const b = await compZip.file(p).async('uint8array');
            if (!bytesEqual(a, b)) {
              allUntouchedMatch = false;
              mismatchedUntouched.push(p);
            }
          }

          const mediaResults = [];
          for (const { path, expectedMime, requireExactZeroDiff = false } of optimizedMediaChecks) {
            const origMedia = await origZip.file(path).async('uint8array');
            const compMedia = await compZip.file(path).async('uint8array');
            const sig = detectFormatFromSignature(compMedia);
            const origHeader = parseImageHeaderInfo(origMedia, expectedMime);
            const compHeader = parseImageHeaderInfo(compMedia, expectedMime);
            const origDec = await decodeToRgba(origMedia, expectedMime);
            const compDec = await decodeToRgba(compMedia, expectedMime);
            const q = measureDecodedImageQuality(origDec.rgba, compDec.rgba, origDec.width, origDec.height);
            mediaResults.push({
              path,
              expectedMime,
              sig,
              requireExactZeroDiff,
              origBytes: origMedia.byteLength,
              compBytes: compMedia.byteLength,
              dimsMatch:
                origHeader.width === compHeader.width &&
                origHeader.height === compHeader.height &&
                compHeader.valid,
              quality: {
                psnrDb: q.psnrDb === Infinity ? 'Inf' : Number(q.psnrDb.toFixed(2)),
                ssim: Number(q.ssim.toFixed(4)),
                meanAbsDiff: Number(q.meanAbsDiff.toFixed(3)),
                maxChannelDiff: q.maxChannelDiff,
                alphaMaxDiff: q.alphaMaxDiff,
                pctPixelsDiffGt10: Number(q.pctPixelsDiffGt10.toFixed(3)),
                edgeSharpnessRetentionPct: Number(q.edgeSharpnessRetentionPct.toFixed(2))
              }
            });
          }

          return {
            entryCount: compKeys.length,
            sameEntrySet,
            allUntouchedMatch,
            mismatchedUntouched,
            mediaResults
          };
        }

        // 1. DOCX in browser
        const docxOrig = await buildPackage('docx');
        const docxFile = new File([docxOrig], 'architecture-spec.docx', {
          type: DOCX_MIME,
          lastModified: 1717000011000
        });
        const docxStages = [];
        const docxRes = await compressFile(docxFile, { onStage: (s) => docxStages.push(s.stage) });
        const docxVerify = await verifyReopenedOpenXml(
          docxOrig,
          new Uint8Array(await docxRes.file.arrayBuffer()),
          [
            '[Content_Types].xml',
            '_rels/.rels',
            'word/document.xml',
            'word/_rels/document.xml.rels',
            'word/styles.xml',
            'word/header1.xml',
            'word/vbaProject.bin',
            'word/media/fine-text.jpg',
            'word/media/vector-circles.jpg',
            'word/media/anim.gif',
            'word/media/logo.svg',
            'word/media/vector.emf',
            'word/media/legacy.wmf'
          ],
          [
            { path: 'word/media/diagram.png', expectedMime: 'image/png', requireExactZeroDiff: true },
            { path: 'word/media/bloated-meta.jpg', expectedMime: 'image/jpeg', requireExactZeroDiff: true },
            { path: 'word/media/natural-photo.jpg', expectedMime: 'image/jpeg', requireExactZeroDiff: false }
          ]
        );

        // 2. PPTX in browser
        const pptxOrig = await buildPackage('pptx');
        const pptxFile = new File([pptxOrig], 'product-deck.pptx', {
          type: PPTX_MIME,
          lastModified: 1717000012000
        });
        const pptxStages = [];
        const pptxRes = await compressFile(pptxFile, { onStage: (s) => pptxStages.push(s.stage) });
        const pptxVerify = await verifyReopenedOpenXml(
          pptxOrig,
          new Uint8Array(await pptxRes.file.arrayBuffer()),
          [
            '[Content_Types].xml',
            '_rels/.rels',
            'ppt/presentation.xml',
            'ppt/_rels/presentation.xml.rels',
            'ppt/slides/slide1.xml',
            'ppt/slides/_rels/slide1.xml.rels',
            'ppt/notesSlides/notesSlide1.xml',
            'ppt/media/transparent-ui.webp',
            'ppt/media/lossless-ui.webp',
            'ppt/media/anim.gif',
            'ppt/media/chart.emf'
          ],
          [
            { path: 'ppt/media/diagram.png', expectedMime: 'image/png', requireExactZeroDiff: true },
            { path: 'ppt/media/bloated-meta.webp', expectedMime: 'image/webp', requireExactZeroDiff: true },
            { path: 'ppt/media/natural-photo.webp', expectedMime: 'image/webp', requireExactZeroDiff: false }
          ]
        );

        // 3. XLSX in browser
        const xlsxOrig = await buildPackage('xlsx');
        const xlsxFile = new File([xlsxOrig], 'revenue-model.xlsx', {
          type: XLSX_MIME,
          lastModified: 1717000013000
        });
        const xlsxStages = [];
        const xlsxRes = await compressFile(xlsxFile, { onStage: (s) => xlsxStages.push(s.stage) });
        const xlsxCompBytes = new Uint8Array(await xlsxRes.file.arrayBuffer());
        const xlsxVerify = await verifyReopenedOpenXml(
          xlsxOrig,
          xlsxCompBytes,
          [
            '[Content_Types].xml',
            '_rels/.rels',
            'xl/workbook.xml',
            'xl/_rels/workbook.xml.rels',
            'xl/sharedStrings.xml',
            'xl/styles.xml',
            'xl/worksheets/sheet1.xml',
            'xl/media/logo.svg'
          ],
          [{ path: 'xl/media/chart.png', expectedMime: 'image/png', requireExactZeroDiff: true }]
        );
        const xlsxZipCheck = await JSZip.loadAsync(xlsxCompBytes);
        const sheetXml = await xlsxZipCheck.file('xl/worksheets/sheet1.xml').async('string');
        const hasSumFormula = sheetXml.includes('<f>SUM(A1:A500)</f>');
        const hasIfFormula = sheetXml.includes('<f>IF(B500&gt;0,B500*1.25,0)</f>');

        // 4. Coordinator + application/octet-stream MIME resolution for DOCX, PPTX, XLSX
        const octetDocx = new File([docxOrig], 'upload.docx', { type: 'application/octet-stream' });
        const octetPptx = new File([pptxOrig], 'deck.pptx', { type: 'application/octet-stream' });
        const octetXlsx = new File([xlsxOrig], 'sheet.xlsx', { type: 'application/octet-stream' });
        const prepared = await prepareAttachmentsForUpload([
          { id: 'o1', name: 'upload.docx', type: 'application/octet-stream', size: octetDocx.size, extension: 'DOCX', file: octetDocx },
          { id: 'o2', name: 'deck.pptx', type: 'application/octet-stream', size: octetPptx.size, extension: 'PPTX', file: octetPptx },
          { id: 'o3', name: 'sheet.xlsx', type: 'application/octet-stream', size: octetXlsx.size, extension: 'XLSX', file: octetXlsx }
        ]);
        clearFileCompressionCacheEntryForTesting(octetDocx);
        clearFileCompressionCacheEntryForTesting(octetPptx);
        clearFileCompressionCacheEntryForTesting(octetXlsx);

        // 5. Protected / encrypted / digitally signed packages skipped untouched
        const signedDocxFile = new File(
          [await buildPackage('docx', { extraFiles: { '_xmlsignatures/sig1.xml': '<Signature/>' } })],
          'signed.docx',
          { type: DOCX_MIME }
        );
        const signedDocxRes = await compressFile(signedDocxFile);

        const protectedPptxFile = new File(
          [await buildPackage('pptx', { extraProtectionXml: '<p:modifyVerifier hashData="abcd"/>' })],
          'locked.pptx',
          { type: PPTX_MIME }
        );
        const protectedPptxRes = await compressFile(protectedPptxFile);

        const protectedXlsxFile = new File(
          [await buildPackage('xlsx', { extraProtectionXml: '<workbookProtection workbookPassword="abcd"/>' })],
          'locked.xlsx',
          { type: XLSX_MIME }
        );
        const protectedXlsxRes = await compressFile(protectedXlsxFile);

        const ole2EncBytes = new Uint8Array(66_000);
        ole2EncBytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
        const marker = 'EncryptedPackage';
        for (let i = 0; i < marker.length; i++) ole2EncBytes[512 + i * 2] = marker.charCodeAt(i);
        const ole2EncFile = new File([ole2EncBytes], 'encrypted.xlsx', { type: XLSX_MIME });
        const ole2EncRes = await compressFile(ole2EncFile);

        // 6. < 10% savings fallback, corrupted ZIP fallback, out-of-scope doc/ppt/xls, AbortSignal
        const alreadyTightRes = await compressFile(xlsxRes.file, { minOpenXmlBytes: 100 });

        const corruptBytes = new Uint8Array(70_000).fill(0x41);
        corruptBytes.set([0x50, 0x4b, 0x03, 0x04], 0);
        const corruptFile = new File([corruptBytes], 'corrupt.docx', { type: DOCX_MIME });
        const corruptRes = await compressFile(corruptFile);

        const legacyDoc = new File([new Uint8Array(80_000).fill(0x41)], 'legacy.doc', {
          type: 'application/msword'
        });
        const legacyDocRes = await compressFile(legacyDoc);

        const preCtrl = new AbortController();
        preCtrl.abort();
        const preAbortRes = await compressFile(docxFile, { signal: preCtrl.signal });

        const midCtrl = new AbortController();
        const midPromise = compressFile(pptxFile, { signal: midCtrl.signal });
        midCtrl.abort();
        const midAbortRes = await midPromise;

        return {
          COMPRESSION_REASONS,
          COMPRESSION_STAGES,
          docx: {
            compressed: docxRes.compressed,
            reason: docxRes.reason,
            name: docxRes.file.name,
            type: docxRes.file.type,
            originalSize: docxRes.originalSize,
            finalSize: docxRes.finalSize,
            savingsPct: Number((((docxRes.originalSize - docxRes.finalSize) / docxRes.originalSize) * 100).toFixed(2)),
            stages: docxStages,
            verify: docxVerify
          },
          pptx: {
            compressed: pptxRes.compressed,
            reason: pptxRes.reason,
            name: pptxRes.file.name,
            type: pptxRes.file.type,
            originalSize: pptxRes.originalSize,
            finalSize: pptxRes.finalSize,
            savingsPct: Number((((pptxRes.originalSize - pptxRes.finalSize) / pptxRes.originalSize) * 100).toFixed(2)),
            stages: pptxStages,
            verify: pptxVerify
          },
          xlsx: {
            compressed: xlsxRes.compressed,
            reason: xlsxRes.reason,
            name: xlsxRes.file.name,
            type: xlsxRes.file.type,
            originalSize: xlsxRes.originalSize,
            finalSize: xlsxRes.finalSize,
            savingsPct: Number((((xlsxRes.originalSize - xlsxRes.finalSize) / xlsxRes.originalSize) * 100).toFixed(2)),
            stages: xlsxStages,
            verify: xlsxVerify,
            hasSumFormula,
            hasIfFormula
          },
          coordinator: prepared.map((a) => ({
            name: a.name,
            attType: a.type,
            fileType: a.file.type,
            compressed: a.compression.compressed,
            origSize: a.compression.originalSize,
            finalSize: a.size
          })),
          protections: {
            signedDocx: { reason: signedDocxRes.reason, sameRef: signedDocxRes.file === signedDocxFile },
            protectedPptx: { reason: protectedPptxRes.reason, sameRef: protectedPptxRes.file === protectedPptxFile },
            protectedXlsx: { reason: protectedXlsxRes.reason, sameRef: protectedXlsxRes.file === protectedXlsxFile },
            ole2Enc: { reason: ole2EncRes.reason, sameRef: ole2EncRes.file === ole2EncFile }
          },
          fallbacks: {
            alreadyTight: { reason: alreadyTightRes.reason, sameRef: alreadyTightRes.file === xlsxRes.file },
            corrupt: { reason: corruptRes.reason, sameRef: corruptRes.file === corruptFile },
            legacyDoc: { reason: legacyDocRes.reason, sameRef: legacyDocRes.file === legacyDoc },
            preAbort: { reason: preAbortRes.reason, sameRef: preAbortRes.file === docxFile },
            midAbort: { reason: midAbortRes.reason, sameRef: midAbortRes.file === pptxFile }
          }
        };
      },
      { gifBytesArr: gifBytes }
    );

    assert.deepStrictEqual(pageErrors, [], `Browser page errors: ${pageErrors.join('; ')}`);
    assert.deepStrictEqual(consoleErrors, [], `Browser console errors: ${consoleErrors.join('; ')}`);

    const R = results.COMPRESSION_REASONS;
    const S = results.COMPRESSION_STAGES;

    for (const [label, item] of [
      ['DOCX', results.docx],
      ['PPTX', results.pptx],
      ['XLSX', results.xlsx]
    ]) {
      assert.strictEqual(item.compressed, true, `${label} failed: ${item.reason}`);
      assert.strictEqual(item.reason, R.COMPRESSED);
      assert.ok(item.savingsPct >= 10, `${label} savings ${item.savingsPct}% < 10%`);
      assert.deepStrictEqual(item.stages, [S.ANALYZING, S.OPTIMIZING, S.VALIDATING, S.COMPLETE]);
      assert.strictEqual(item.verify.sameEntrySet, true, `${label} entry set changed`);
      assert.strictEqual(
        item.verify.allUntouchedMatch,
        true,
        `${label} untouched entries mismatched: ${item.verify.mismatchedUntouched.join(', ')}`
      );
      for (const m of item.verify.mediaResults) {
        assert.strictEqual(m.sig, m.expectedMime, `${label} media ${m.path} signature mismatch`);
        assert.strictEqual(m.dimsMatch, true, `${label} media ${m.path} dimensions invalid`);
        assert.ok(m.compBytes < m.origBytes, `${label} media ${m.path} was not optimized smaller`);
        assert.strictEqual(m.quality.alphaMaxDiff, 0, `${label} media ${m.path} alpha changed`);
        if (m.requireExactZeroDiff) {
          assert.strictEqual(m.quality.maxChannelDiff, 0, `${label} lossless media ${m.path} must have 0 diff`);
          assert.strictEqual(m.quality.psnrDb, 'Inf', `${label} lossless media ${m.path} must have Inf PSNR`);
          assert.strictEqual(m.quality.ssim, 1, `${label} lossless media ${m.path} must have SSIM = 1`);
          assert.strictEqual(m.quality.edgeSharpnessRetentionPct, 100);
        } else {
          assert.ok(m.quality.psnrDb >= 41.0, `${label} media ${m.path} PSNR ${m.quality.psnrDb} < 41`);
          assert.ok(m.quality.ssim >= 0.985, `${label} media ${m.path} SSIM ${m.quality.ssim} < 0.985`);
          assert.ok(m.quality.edgeSharpnessRetentionPct >= 95.0, `${label} media ${m.path} sharpness ${m.quality.edgeSharpnessRetentionPct}% < 95%`);
          assert.ok(m.quality.pctPixelsDiffGt10 <= 0.8, `${label} media ${m.path} pctGt10 ${m.quality.pctPixelsDiffGt10}% > 0.8%`);
        }
      }
    }

    assert.strictEqual(results.xlsx.hasSumFormula, true);
    assert.strictEqual(results.xlsx.hasIfFormula, true);

    assert.strictEqual(results.coordinator.length, 3);
    for (const c of results.coordinator) {
      assert.strictEqual(c.compressed, true, `Coordinator octet-stream ${c.name} failed`);
      assert.strictEqual(c.attType, c.fileType);
      assert.ok(c.finalSize < c.origSize);
    }

    assert.strictEqual(results.protections.signedDocx.reason, R.PROTECTED_PACKAGE);
    assert.strictEqual(results.protections.signedDocx.sameRef, true);
    assert.strictEqual(results.protections.protectedPptx.reason, R.PROTECTED_PACKAGE);
    assert.strictEqual(results.protections.protectedPptx.sameRef, true);
    assert.strictEqual(results.protections.protectedXlsx.reason, R.PROTECTED_PACKAGE);
    assert.strictEqual(results.protections.protectedXlsx.sameRef, true);
    assert.strictEqual(results.protections.ole2Enc.reason, R.PROTECTED_PACKAGE);
    assert.strictEqual(results.protections.ole2Enc.sameRef, true);

    assert.strictEqual(results.fallbacks.alreadyTight.reason, R.INSUFFICIENT_SAVINGS);
    assert.strictEqual(results.fallbacks.alreadyTight.sameRef, true);
    assert.strictEqual(results.fallbacks.corrupt.reason, R.CORRUPTED_OR_UNREADABLE);
    assert.strictEqual(results.fallbacks.corrupt.sameRef, true);
    assert.strictEqual(results.fallbacks.legacyDoc.reason, R.UNSUPPORTED_FORMAT);
    assert.strictEqual(results.fallbacks.legacyDoc.sameRef, true);
    assert.strictEqual(results.fallbacks.preAbort.reason, R.ABORTED);
    assert.strictEqual(results.fallbacks.preAbort.sameRef, true);
    assert.strictEqual(results.fallbacks.midAbort.reason, R.ABORTED);
    assert.strictEqual(results.fallbacks.midAbort.sameRef, true);

    console.log('Browser OpenXML Compression & Image Quality Measurements (Chromium Live):');
    for (const [label, item] of [
      ['DOCX', results.docx],
      ['PPTX', results.pptx],
      ['XLSX', results.xlsx]
    ]) {
      console.log(
        `  • ${label} (${item.name}): ${item.originalSize} bytes -> ${item.finalSize} bytes (${item.savingsPct}% saved), ${item.verify.entryCount} parts verified intact`
      );
      for (const m of item.verify.mediaResults) {
        console.log(
          `    - Embedded ${m.path} (${m.expectedMime}): ${m.origBytes} -> ${m.compBytes} bytes | PSNR=${m.quality.psnrDb} dB, SSIM=${m.quality.ssim}, maxDiff=${m.quality.maxChannelDiff}, alphaDiff=${m.quality.alphaMaxDiff}, edgeSharpness=${m.quality.edgeSharpnessRetentionPct}%`
        );
      }
    }
    console.log('ALL REAL BROWSER OPENXML (DOCX/PPTX/XLSX) COMPRESSION & QUALITY TESTS PASSED!');
  } finally {
    await browser.close();
    await cleanup();
  }
}

runBrowserOpenXmlTests().catch((err) => {
  console.error('REAL BROWSER OPENXML COMPRESSION TEST FAILED:', err);
  process.exit(1);
});
