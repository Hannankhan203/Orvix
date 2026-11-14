/**
 * scripts/testCompressionPhase1Browser.js
 *
 * Real Browser-Executable Test Suite for Compression Phase 1 (Headless Chromium via playwright-core).
 * Connects to the Vite + Express app in a real Chromium browser context and verifies:
 * 1. Real @jsquash/oxipng WASM lossless PNG compression on a pure browser Canvas PNG
 *    (dimensions, RGBA pixel-exact accuracy, transparency, >= 10% savings).
 * 2. application/octet-stream MIME resolution via extension + validated binary signature (and prepareAttachmentsForUpload).
 * 3. Spoofed extension vs real JPEG signature rejection (never trusts extension alone).
 * 4. Safe browser Canvas fallback when @jsquash/oxipng fails.
 * 5. >= 10% savings gate rejecting already-optimized PNGs without replacing original File.
 * 6. Real browser signed PDF protection (/Sig, /ByteRange, and compressed ObjStm) and unsigned PDF lossless optimization.
 * 7. AbortSignal cancellation in browser runtime.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';

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

async function ensureViteAppUrl() {
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
    server: { middlewareMode: true },
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

async function buildBrowserTestPdfPayloads() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 1; p <= 2; p++) {
    const page = doc.addPage([612, 792]);
    page.drawText(`Browser PDF Page ${p}`, { x: 50, y: 720, size: 14, font });
  }
  const rawPdfBytes = await doc.save({ useObjectStreams: false });
  const rawPdfStr = Buffer.from(rawPdfBytes).toString('latin1');
  const eofIdx = rawPdfStr.lastIndexOf('%%EOF');

  const unsignedBloated = Buffer.from(
    rawPdfStr.slice(0, eofIdx) +
      '\n% padding ' +
      '0123456789ABCDEF'.repeat(4500) +
      '\n' +
      rawPdfStr.slice(eofIdx),
    'latin1'
  );

  const signedRaw = Buffer.from(
    rawPdfStr.slice(0, eofIdx) +
      '\n99 0 obj\n<< /Type /Sig /Filter /Adobe.PPKLite /ByteRange [0 100 200 300] >>\nendobj\n' +
      '\n% padding ' +
      '0123456789ABCDEF'.repeat(4500) +
      '\n' +
      rawPdfStr.slice(eofIdx),
    'latin1'
  );

  const objStmDoc = await PDFDocument.create();
  const f2 = await objStmDoc.embedFont(StandardFonts.Helvetica);
  const p2 = objStmDoc.addPage([612, 792]);
  p2.drawText('ObjStm Signed Browser PDF', { x: 50, y: 720, size: 14, font: f2 });
  const sigDict = objStmDoc.context.obj({
    Type: 'Sig',
    Filter: 'Adobe.PPKLite',
    ByteRange: [0, 10, 20, 30]
  });
  const sigRef = objStmDoc.context.register(sigDict);
  objStmDoc.catalog.set(PDFName.of('AcroSigBrowser'), sigRef);
  const objStmBytes = Buffer.from(await objStmDoc.save({ useObjectStreams: true })).toString('latin1');
  const objStmEof = objStmBytes.lastIndexOf('%%EOF');
  const signedObjStm = Buffer.from(
    objStmBytes.slice(0, objStmEof) +
      '\n% padding ' +
      'ABCDEF0123456789'.repeat(4500) +
      '\n' +
      objStmBytes.slice(objStmEof),
    'latin1'
  );

  return {
    unsignedPdf: Array.from(unsignedBloated),
    signedRawPdf: Array.from(signedRaw),
    signedObjStmPdf: Array.from(signedObjStm)
  };
}

async function runBrowserTests() {
  const chromium = loadPlaywrightChromium();
  const executablePath = findChromiumExecutable();
  const { baseUrl, cleanup } = await ensureViteAppUrl();
  const pdfPayloads = await buildBrowserTestPdfPayloads();

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
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });
    page.on('pageerror', (err) => {
      pageErrors.push(String(err?.message || err));
    });

    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });

    const results = await page.evaluate(async (pdfs) => {
      const compressionMod = await import('/src/services/smartCompressionService.js');
      const coordinatorMod = await import('/src/services/attachmentCompressionCoordinator.js');

      const {
        compressFile,
        COMPRESSION_REASONS,
        COMPRESSION_STAGES,
        setPngOptimizerForTesting
      } = compressionMod;
      const {
        prepareAttachmentsForUpload,
        clearFileCompressionCacheEntryForTesting
      } = coordinatorMod;

      // Helper: draw rich transparent UI + semi-transparent gradient + crisp text PNG (1024x768)
      // Produces a pure browser Canvas PNG > 90 KB with zero synthetic chunk padding.
      async function createRichTransparentPngBlob(width = 1024, height = 768) {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d', { alpha: true });

        // Leave outer 24px border fully transparent (alpha = 0)
        ctx.clearRect(0, 0, width, height);

        // Semi-transparent UI backdrop
        const grad = ctx.createLinearGradient(24, 24, width - 24, height - 24);
        grad.addColorStop(0, 'rgba(37, 99, 235, 0.85)');
        grad.addColorStop(0.5, 'rgba(16, 185, 129, 0.72)');
        grad.addColorStop(1, 'rgba(15, 23, 42, 0.95)');
        ctx.fillStyle = grad;
        ctx.fillRect(24, 24, width - 48, height - 48);

        // Deterministic color-rich UI chart/pattern tiles with semi-transparent pixels
        for (let y = 40; y < height - 40; y += 3) {
          for (let x = 40; x < width - 40; x += 3) {
            const r = (x * 13 + y * 7) & 255;
            const g = (x * 5 + y * 19) & 255;
            const b = (x * 17 + y * 3) & 255;
            const a = ((x + y) % 9 === 0) ? 0.5 : 0.94;
            ctx.fillStyle = `rgba(${r},${g},${b},${a})`;
            ctx.fillRect(x, y, 2, 2);
          }
        }
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 32px sans-serif';
        ctx.fillText('Orvix Lossless PNG Test 1024x768', 60, 120);

        return await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      }

      // Helper: inject uncompressed PNG tEXt metadata chunk to simulate bloated PNG for Canvas fallback test
      function addPngTextChunk(pngBytes, paddingLen) {
        const crcTable = new Int32Array(256);
        for (let i = 0; i < 256; i++) {
          let c = i;
          for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
          crcTable[i] = c;
        }
        const crc32 = (arr) => {
          let c = -1;
          for (let i = 0; i < arr.length; i++) c = crcTable[(c ^ arr[i]) & 0xff] ^ (c >>> 8);
          return (c ^ -1) | 0;
        };

        const typeBytes = new TextEncoder().encode('tEXt');
        const prefix = new TextEncoder().encode('Comment\0');
        const data = new Uint8Array(prefix.length + paddingLen);
        data.set(prefix, 0);
        data.fill(0x41, prefix.length);

        const chunk = new Uint8Array(12 + data.length);
        const view = new DataView(chunk.buffer);
        view.setUint32(0, data.length, false);
        chunk.set(typeBytes, 4);
        chunk.set(data, 8);
        const crcBuf = new Uint8Array(4 + data.length);
        crcBuf.set(typeBytes, 0);
        crcBuf.set(data, 4);
        view.setInt32(8 + data.length, crc32(crcBuf), false);

        const iendOffset = pngBytes.length - 12;
        const out = new Uint8Array(pngBytes.length + chunk.length);
        out.set(pngBytes.subarray(0, iendOffset), 0);
        out.set(chunk, iendOffset);
        out.set(pngBytes.subarray(iendOffset), iendOffset + chunk.length);
        return out;
      }

      async function decodeRgbaPixels(blob) {
        const bitmap = await createImageBitmap(blob);
        try {
          const canvas = document.createElement('canvas');
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          const ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: true });
          ctx.clearRect(0, 0, bitmap.width, bitmap.height);
          ctx.drawImage(bitmap, 0, 0);
          const imgData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
          return {
            width: bitmap.width,
            height: bitmap.height,
            data: imgData.data
          };
        } finally {
          bitmap.close();
        }
      }

      // ------------------------------------------------------------------
      // Test 1: Real @jsquash/oxipng lossless PNG compression on pure Canvas PNG
      // ------------------------------------------------------------------
      const basePngBlob = await createRichTransparentPngBlob(1024, 768);
      const rawPngBytes = new Uint8Array(await basePngBlob.arrayBuffer());

      const pngFile = new File([rawPngBytes], 'ui-diagram.png', {
        type: 'image/png',
        lastModified: 1713333333000
      });

      const stages = [];
      const pngResult = await compressFile(pngFile, {
        onStage: (info) => stages.push(info.stage)
      });

      const origPixels = await decodeRgbaPixels(pngFile);
      const compPixels = await decodeRgbaPixels(pngResult.file);

      let maxChannelDiff = 0;
      let transparentPixelCountOrig = 0;
      let transparentPixelCountComp = 0;
      for (let i = 0; i < origPixels.data.length; i += 4) {
        if (origPixels.data[i + 3] < 255) transparentPixelCountOrig++;
        if (compPixels.data[i + 3] < 255) transparentPixelCountComp++;
        for (let c = 0; c < 4; c++) {
          const diff = Math.abs(origPixels.data[i + c] - compPixels.data[i + c]);
          if (diff > maxChannelDiff) maxChannelDiff = diff;
        }
      }

      // ------------------------------------------------------------------
      // Test 2: Already-optimized PNG (< 10% savings) returns untouched original
      // ------------------------------------------------------------------
      const alreadyOptResult = await compressFile(pngResult.file, {
        minImageBytes: Math.min(80 * 1024, Math.max(1024, pngResult.finalSize - 1024))
      });

      // ------------------------------------------------------------------
      // Test 3: application/octet-stream PNG in browser + coordinator
      // ------------------------------------------------------------------
      const octetPngFile = new File([rawPngBytes], 'browser-octet.png', {
        type: 'application/octet-stream',
        lastModified: 1714444444000
      });
      const preparedOctet = await prepareAttachmentsForUpload([
        {
          id: 'att-browser-octet',
          name: 'browser-octet.png',
          originalName: 'browser-octet.png',
          type: 'application/octet-stream',
          size: octetPngFile.size,
          extension: 'PNG',
          isImage: true,
          file: octetPngFile
        }
      ]);
      clearFileCompressionCacheEntryForTesting(octetPngFile);

      // ------------------------------------------------------------------
      // Test 4: Spoofed extension (.png) with real JPEG signature (> 80KB)
      // ------------------------------------------------------------------
      const jpgCanvas = document.createElement('canvas');
      jpgCanvas.width = 1000;
      jpgCanvas.height = 750;
      const jCtx = jpgCanvas.getContext('2d');
      for (let y = 0; y < 750; y += 5) {
        for (let x = 0; x < 1000; x += 5) {
          jCtx.fillStyle = `rgb(${(x * 7) & 255},${(y * 11) & 255},${((x + y) * 3) & 255})`;
          jCtx.fillRect(x, y, 5, 5);
        }
      }
      const jpegBlob = await new Promise((resolve) => jpgCanvas.toBlob(resolve, 'image/jpeg', 0.96));
      const jpegBytes = new Uint8Array(await jpegBlob.arrayBuffer());
      const spoofedPngFile = new File([jpegBytes], 'spoofed.png', {
        type: 'application/octet-stream'
      });
      const spoofedResult = await compressFile(spoofedPngFile);

      // ------------------------------------------------------------------
      // Test 5: Safe Canvas fallback when @jsquash/oxipng fails
      // ------------------------------------------------------------------
      const bloatedForFallback = new File(
        [addPngTextChunk(rawPngBytes, Math.max(120 * 1024, rawPngBytes.length))],
        'fallback-test.png',
        { type: 'image/png' }
      );
      setPngOptimizerForTesting(async () => {
        throw new Error('Simulated browser oxipng failure');
      });
      const fallbackResult = await compressFile(bloatedForFallback);
      setPngOptimizerForTesting(null);
      const fallbackPixels = await decodeRgbaPixels(fallbackResult.file);

      // ------------------------------------------------------------------
      // Test 6: Real browser signed PDF protection & unsigned PDF optimization
      // ------------------------------------------------------------------
      const unsignedPdfFile = new File(
        [new Uint8Array(pdfs.unsignedPdf)],
        'browser-unsigned.pdf',
        { type: 'application/octet-stream' }
      );
      const unsignedPdfRes = await compressFile(unsignedPdfFile);

      const signedRawPdfFile = new File(
        [new Uint8Array(pdfs.signedRawPdf)],
        'browser-signed-raw.pdf',
        { type: 'application/pdf' }
      );
      const signedRawPdfRes = await compressFile(signedRawPdfFile);

      const signedObjStmPdfFile = new File(
        [new Uint8Array(pdfs.signedObjStmPdf)],
        'browser-signed-objstm.pdf',
        { type: 'application/pdf' }
      );
      const signedObjStmPdfRes = await compressFile(signedObjStmPdfFile);

      // ------------------------------------------------------------------
      // Test 7: Browser AbortSignal cancellation
      // ------------------------------------------------------------------
      const abortCtrl = new AbortController();
      abortCtrl.abort();
      const abortRes = await compressFile(pngFile, { signal: abortCtrl.signal });

      return {
        pngTest: {
          compressed: pngResult.compressed,
          reason: pngResult.reason,
          originalSize: pngResult.originalSize,
          finalSize: pngResult.finalSize,
          savingsPct: Number(
            (((pngResult.originalSize - pngResult.finalSize) / pngResult.originalSize) * 100).toFixed(2)
          ),
          fileName: pngResult.file.name,
          fileType: pngResult.file.type,
          stages,
          origWidth: origPixels.width,
          origHeight: origPixels.height,
          compWidth: compPixels.width,
          compHeight: compPixels.height,
          maxChannelDiff,
          transparentPixelCountOrig,
          transparentPixelCountComp
        },
        alreadyOptTest: {
          compressed: alreadyOptResult.compressed,
          reason: alreadyOptResult.reason,
          sameRef: alreadyOptResult.file === pngResult.file
        },
        octetTest: {
          compressed: preparedOctet[0].compression.compressed,
          reason: preparedOctet[0].compression.reason,
          attType: preparedOctet[0].type,
          fileType: preparedOctet[0].file.type,
          originalSize: preparedOctet[0].compression.originalSize,
          finalSize: preparedOctet[0].size
        },
        spoofedTest: {
          jpegSize: jpegBytes.length,
          compressed: spoofedResult.compressed,
          reason: spoofedResult.reason,
          sameRef: spoofedResult.file === spoofedPngFile
        },
        fallbackTest: {
          compressed: fallbackResult.compressed,
          reason: fallbackResult.reason,
          originalSize: fallbackResult.originalSize,
          finalSize: fallbackResult.finalSize,
          width: fallbackPixels.width,
          height: fallbackPixels.height
        },
        pdfTest: {
          unsignedCompressed: unsignedPdfRes.compressed,
          unsignedReason: unsignedPdfRes.reason,
          unsignedFileType: unsignedPdfRes.file.type,
          unsignedOriginalSize: unsignedPdfRes.originalSize,
          unsignedFinalSize: unsignedPdfRes.finalSize,
          signedRawCompressed: signedRawPdfRes.compressed,
          signedRawReason: signedRawPdfRes.reason,
          signedRawSameRef: signedRawPdfRes.file === signedRawPdfFile,
          signedObjStmCompressed: signedObjStmPdfRes.compressed,
          signedObjStmReason: signedObjStmPdfRes.reason,
          signedObjStmSameRef: signedObjStmPdfRes.file === signedObjStmPdfFile
        },
        abortTest: {
          compressed: abortRes.compressed,
          reason: abortRes.reason,
          sameRef: abortRes.file === pngFile
        },
        COMPRESSION_REASONS,
        COMPRESSION_STAGES
      };
    }, pdfPayloads);

    assert.deepStrictEqual(pageErrors, [], `Browser uncaught page errors: ${pageErrors.join('; ')}`);
    assert.deepStrictEqual(consoleErrors, [], `Browser console errors: ${consoleErrors.join('; ')}`);

    // Verify Test 1: Real @jsquash/oxipng browser PNG compression on pure Canvas PNG
    assert.ok(results.pngTest.originalSize >= 80 * 1024, `Expected Canvas PNG >= 80KB, got ${results.pngTest.originalSize}`);
    assert.strictEqual(results.pngTest.compressed, true, `Browser PNG compression must succeed, got ${results.pngTest.reason}`);
    assert.strictEqual(results.pngTest.reason, results.COMPRESSION_REASONS.COMPRESSED);
    assert.ok(results.pngTest.savingsPct >= 10, `Expected >= 10% savings, got ${results.pngTest.savingsPct}%`);
    assert.strictEqual(results.pngTest.fileName, 'ui-diagram.png');
    assert.strictEqual(results.pngTest.fileType, 'image/png');
    assert.strictEqual(results.pngTest.compWidth, 1024);
    assert.strictEqual(results.pngTest.compHeight, 768);
    assert.strictEqual(results.pngTest.maxChannelDiff, 0, 'Lossless oxipng PNG must have 0 RGBA channel diff');
    assert.ok(results.pngTest.transparentPixelCountOrig > 0, 'Test PNG must include real transparent pixels');
    assert.strictEqual(
      results.pngTest.transparentPixelCountComp,
      results.pngTest.transparentPixelCountOrig,
      'Transparent pixel count must be 100% preserved'
    );

    // Verify Test 2: Already-optimized PNG < 10% savings
    assert.strictEqual(results.alreadyOptTest.compressed, false);
    assert.strictEqual(results.alreadyOptTest.reason, results.COMPRESSION_REASONS.INSUFFICIENT_SAVINGS);
    assert.strictEqual(results.alreadyOptTest.sameRef, true);

    // Verify Test 3: application/octet-stream PNG resolved and compressed via coordinator
    assert.strictEqual(results.octetTest.compressed, true);
    assert.strictEqual(results.octetTest.attType, 'image/png');
    assert.strictEqual(results.octetTest.fileType, 'image/png');
    assert.ok(results.octetTest.finalSize < results.octetTest.originalSize);

    // Verify Test 4: Spoofed .png with JPEG bytes rejected
    assert.ok(results.spoofedTest.jpegSize >= 80 * 1024, 'Spoofed JPEG test payload must exceed threshold');
    assert.strictEqual(results.spoofedTest.compressed, false);
    assert.strictEqual(results.spoofedTest.reason, results.COMPRESSION_REASONS.CORRUPTED_OR_UNREADABLE);
    assert.strictEqual(results.spoofedTest.sameRef, true);

    // Verify Test 5: Safe browser Canvas fallback when oxipng fails
    assert.strictEqual(results.fallbackTest.compressed, true);
    assert.strictEqual(results.fallbackTest.reason, results.COMPRESSION_REASONS.COMPRESSED);
    assert.strictEqual(results.fallbackTest.width, 1024);
    assert.strictEqual(results.fallbackTest.height, 768);

    // Verify Test 6: Real browser signed PDF protection & unsigned octet-stream PDF compression
    assert.strictEqual(results.pdfTest.unsignedCompressed, true);
    assert.strictEqual(results.pdfTest.unsignedFileType, 'application/pdf');
    assert.strictEqual(results.pdfTest.signedRawCompressed, false);
    assert.strictEqual(results.pdfTest.signedRawReason, results.COMPRESSION_REASONS.PROTECTED_PDF);
    assert.strictEqual(results.pdfTest.signedRawSameRef, true);
    assert.strictEqual(results.pdfTest.signedObjStmCompressed, false);
    assert.strictEqual(results.pdfTest.signedObjStmReason, results.COMPRESSION_REASONS.PROTECTED_PDF);
    assert.strictEqual(results.pdfTest.signedObjStmSameRef, true);

    // Verify Test 7: AbortSignal cancellation
    assert.strictEqual(results.abortTest.compressed, false);
    assert.strictEqual(results.abortTest.reason, results.COMPRESSION_REASONS.ABORTED);
    assert.strictEqual(results.abortTest.sameRef, true);

    console.log('Browser PNG Compression Results (@jsquash/oxipng WASM):');
    console.log(
      `  • Pure Canvas PNG (${results.pngTest.compWidth}x${results.pngTest.compHeight}): ${results.pngTest.originalSize} bytes -> ${results.pngTest.finalSize} bytes (${results.pngTest.savingsPct}% saved)`
    );
    console.log(
      `  • Max RGBA pixel diff: ${results.pngTest.maxChannelDiff}, Transparent pixels preserved: ${results.pngTest.transparentPixelCountComp}/${results.pngTest.transparentPixelCountOrig}`
    );
    console.log(
      `  • Octet-stream PNG resolved type: ${results.octetTest.fileType} (${results.octetTest.originalSize} -> ${results.octetTest.finalSize} bytes)`
    );
    console.log(
      `  • Canvas fallback on simulated oxipng error: ${results.fallbackTest.originalSize} -> ${results.fallbackTest.finalSize} bytes`
    );
    console.log(
      `  • Browser PDF tests: unsigned (${results.pdfTest.unsignedOriginalSize} -> ${results.pdfTest.unsignedFinalSize} bytes), raw signed skipped (${results.pdfTest.signedRawReason}), ObjStm signed skipped (${results.pdfTest.signedObjStmReason})`
    );
    console.log('ALL 7 REAL BROWSER COMPRESSION PHASE 1 TESTS PASSED!');
  } finally {
    await browser.close();
    await cleanup();
  }
}

runBrowserTests().catch((err) => {
  console.error('REAL BROWSER COMPRESSION PHASE 1 TEST FAILED:', err);
  process.exit(1);
});
