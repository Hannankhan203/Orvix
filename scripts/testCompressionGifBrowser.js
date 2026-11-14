/**
 * scripts/testCompressionGifBrowser.js
 *
 * Real Headless Chromium Test Suite for Lossless GIF Compression (Prompt 8).
 * Exercises the real @fe-daily/gifsicle-wasm-browser WASM Web Worker in Chromium and verifies:
 * 1. Static GIF compression (transparency, dimensions, >= 10% actual byte savings, 0 RGBA diff).
 * 2. Animated GIF compression (frame count & order, frame timing/delays, NETSCAPE loop count,
 *    disposal=2 restore & transparency, >= 10% actual byte savings, 0 RGBA diff on ALL frames via ImageDecoder).
 * 3. Coordinator (`prepareAttachmentsForUpload`) + `application/octet-stream` GIF MIME resolution.
 * 4. < 10% savings rejection on already-optimized GIF without replacing original File.
 * 5. Validation failure / optimizer error / timeout fallback returning untouched original File.
 * 6. Pre-aborted and mid-flight AbortSignal cancellation terminating cleanly.
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

/**
 * Valid GIF89a LZW encoder that emits uncompressed-density literal codes (resets clear code
 * every 180 pixels so code table never overflows 9-bit width). Real gifsicle -O2 recompresses
 * these frames losslessly with massive, realistic LZW + sub-rectangle + palette compaction.
 */
function encodeValidGifLzw(indices, minCodeSize = 8) {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  const codeBits = minCodeSize + 1;
  const bytes = [];
  let bitBuf = 0;
  let bitCount = 0;

  const writeBits = (val, n) => {
    bitBuf |= val << bitCount;
    bitCount += n;
    while (bitCount >= 8) {
      bytes.push(bitBuf & 0xff);
      bitBuf >>>= 8;
      bitCount -= 8;
    }
  };

  writeBits(clearCode, codeBits);
  for (let i = 0; i < indices.length; i++) {
    writeBits(indices[i], codeBits);
    if ((i + 1) % 180 === 0 && i + 1 < indices.length) {
      writeBits(clearCode, codeBits);
    }
  }
  writeBits(eoiCode, codeBits);
  if (bitCount > 0) {
    bytes.push(bitBuf & 0xff);
  }

  const subBlocks = [minCodeSize];
  for (let i = 0; i < bytes.length; i += 255) {
    const chunk = bytes.slice(i, i + 255);
    subBlocks.push(chunk.length, ...chunk);
  }
  subBlocks.push(0);
  return Buffer.from(subBlocks);
}

function buildStaticTransparentGif({ width = 320, height = 240 } = {}) {
  const parts = [Buffer.from('GIF89a', 'ascii')];
  const lsd = Buffer.alloc(7);
  lsd.writeUInt16LE(width, 0);
  lsd.writeUInt16LE(height, 2);
  lsd[4] = 0xf7; // GCT flag=1, 256 colors
  parts.push(lsd);

  const gct = Buffer.alloc(256 * 3);
  for (let i = 0; i < 256; i++) {
    gct[i * 3] = (i * 37) & 255;
    gct[i * 3 + 1] = (i * 73) & 255;
    gct[i * 3 + 2] = (255 - i * 19) & 255;
  }
  parts.push(gct);

  // Graphic Control Extension: disposal=1, transparent color index=0
  parts.push(Buffer.from([0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00]));

  const desc = Buffer.alloc(10);
  desc[0] = 0x2c;
  desc.writeUInt16LE(width, 5);
  desc.writeUInt16LE(height, 7);
  parts.push(desc);

  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Transparent 16px outer margin + color-coded checkerboard & stripes inside
      if (x < 16 || y < 16 || x >= width - 16 || y >= height - 16) {
        pixels[y * width + x] = 0;
      } else {
        pixels[y * width + x] = 1 + ((((x >> 3) + (y >> 3)) * 5) % 60);
      }
    }
  }
  parts.push(encodeValidGifLzw(pixels, 8));
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

function buildAnimatedTransparentGif({
  width = 240,
  height = 180,
  delays = [15, 30, 45, 60],
  loopCount = 3
} = {}) {
  const parts = [Buffer.from('GIF89a', 'ascii')];
  const lsd = Buffer.alloc(7);
  lsd.writeUInt16LE(width, 0);
  lsd.writeUInt16LE(height, 2);
  lsd[4] = 0xf7; // GCT flag=1, 256 colors
  parts.push(lsd);

  const gct = Buffer.alloc(256 * 3);
  for (let i = 0; i < 256; i++) {
    gct[i * 3] = (i * 29) & 255;
    gct[i * 3 + 1] = (i * 53) & 255;
    gct[i * 3 + 2] = (i * 97) & 255;
  }
  parts.push(gct);

  // NETSCAPE2.0 Application Extension specifying loop count
  parts.push(
    Buffer.from([
      0x21, 0xff, 0x0b,
      ...Buffer.from('NETSCAPE2.0', 'ascii'),
      0x03, 0x01, loopCount & 0xff, (loopCount >> 8) & 0xff,
      0x00
    ])
  );

  for (let f = 0; f < delays.length; f++) {
    // Alternate disposal=2 (RestoreToBackground) and disposal=1 (DoNotDispose), transparent idx=0
    const disposal = f % 2 === 0 ? 2 : 1;
    const gcePacked = ((disposal & 0x07) << 2) | 0x01;
    const d = delays[f];
    parts.push(Buffer.from([0x21, 0xf9, 0x04, gcePacked, d & 0xff, (d >> 8) & 0xff, 0x00, 0x00]));

    const desc = Buffer.alloc(10);
    desc[0] = 0x2c;
    desc.writeUInt16LE(width, 5);
    desc.writeUInt16LE(height, 7);
    parts.push(desc);

    const pixels = new Uint8Array(width * height);
    // Keep border transparent (index 0); draw moving animated shape that shrinks/moves so disposal=2 matters
    const boxLeft = 20 + f * 35;
    const boxRight = boxLeft + 55;
    for (let y = 12; y < height - 12; y++) {
      for (let x = 12; x < width - 12; x++) {
        if (x >= boxLeft && x < boxRight && y >= 24 && y < height - 24) {
          pixels[y * width + x] = 10 + f * 12;
        } else if (y < 24 || y >= height - 24) {
          // Top & bottom transparent bands inside canvas
          pixels[y * width + x] = 0;
        } else {
          // Static textured background
          pixels[y * width + x] = 1 + (((x >> 4) + (y >> 4)) % 8);
        }
      }
    }
    parts.push(encodeValidGifLzw(pixels, 8));
  }

  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

async function runBrowserGifTests() {
  const chromium = loadPlaywrightChromium();
  const executablePath = findChromiumExecutable();
  const { baseUrl, cleanup } = await startViteTestServer();

  const staticGifBuf = buildStaticTransparentGif({ width: 320, height: 240 });
  const animGifBuf = buildAnimatedTransparentGif({
    width: 240,
    height: 180,
    delays: [15, 30, 45, 60],
    loopCount: 3
  });

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

    const results = await page.evaluate(
      async ({ staticBytes, animBytes }) => {
        const compressionMod = await import('/src/services/smartCompressionService.js');
        const coordinatorMod = await import('/src/services/attachmentCompressionCoordinator.js');

        const {
          compressFile,
          parseGifMetadata,
          setGifOptimizerForTesting,
          COMPRESSION_REASONS,
          COMPRESSION_STAGES
        } = compressionMod;
        const {
          prepareAttachmentsForUpload,
          clearFileCompressionCacheEntryForTesting
        } = coordinatorMod;

        async function decodeAllFramesRgba(bytes, expectedFrameCount) {
          const decoder = new ImageDecoder({ data: bytes, type: 'image/gif' });
          await decoder.tracks.ready;
          const track = decoder.tracks.selectedTrack;
          const frames = [];
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: true });

          for (let i = 0; i < expectedFrameCount; i++) {
            const res = await decoder.decode({ frameIndex: i });
            const vf = res.image;
            const width = vf.displayWidth || vf.codedWidth;
            const height = vf.displayHeight || vf.codedHeight;
            canvas.width = width;
            canvas.height = height;
            ctx.clearRect(0, 0, width, height);
            ctx.drawImage(vf, 0, 0);
            const imgData = ctx.getImageData(0, 0, width, height);
            let transparentPixels = 0;
            for (let p = 3; p < imgData.data.length; p += 4) {
              if (imgData.data[p] === 0) transparentPixels++;
            }
            frames.push({
              width,
              height,
              durationUs: vf.duration ?? null,
              transparentPixels,
              rgba: imgData.data
            });
            vf.close();
          }
          const trackInfo = {
            frameCount: track?.frameCount ?? frames.length,
            repetitionCount: track?.repetitionCount ?? null
          };
          decoder.close();
          return { trackInfo, frames };
        }

        function diffDecodedFrames(orig, comp) {
          let maxChannelDiff = 0;
          const frameDiffs = [];
          for (let f = 0; f < orig.frames.length; f++) {
            const a = orig.frames[f];
            const b = comp.frames[f];
            let fMaxDiff = 0;
            for (let i = 0; i < a.rgba.length; i++) {
              const d = Math.abs(a.rgba[i] - b.rgba[i]);
              if (d > fMaxDiff) fMaxDiff = d;
              if (d > maxChannelDiff) maxChannelDiff = d;
            }
            frameDiffs.push({
              widthOrig: a.width,
              heightOrig: a.height,
              widthComp: b.width,
              heightComp: b.height,
              durationOrigUs: a.durationUs,
              durationCompUs: b.durationUs,
              transparentOrig: a.transparentPixels,
              transparentComp: b.transparentPixels,
              maxDiff: fMaxDiff
            });
          }
          return { maxChannelDiff, frameDiffs };
        }

        // ------------------------------------------------------------------
        // 1. Real browser lossless static GIF compression via gifsicle WASM
        // ------------------------------------------------------------------
        const staticFile = new File([new Uint8Array(staticBytes)], 'static-diagram.gif', {
          type: 'image/gif',
          lastModified: 1716000001000
        });
        const staticStages = [];
        const staticRes = await compressFile(staticFile, {
          onStage: (s) => staticStages.push(s.stage)
        });
        const staticOrigDecoded = await decodeAllFramesRgba(new Uint8Array(staticBytes), 1);
        const staticCompBytes = new Uint8Array(await staticRes.file.arrayBuffer());
        const staticCompDecoded = await decodeAllFramesRgba(staticCompBytes, 1);
        const staticDiff = diffDecodedFrames(staticOrigDecoded, staticCompDecoded);
        const staticCompMeta = parseGifMetadata(staticCompBytes);

        // ------------------------------------------------------------------
        // 2. Real browser lossless animated GIF compression via gifsicle WASM
        // ------------------------------------------------------------------
        const animFile = new File([new Uint8Array(animBytes)], 'loader-loop.gif', {
          type: 'image/gif',
          lastModified: 1716000002000
        });
        const animStages = [];
        const animRes = await compressFile(animFile, {
          onStage: (s) => animStages.push(s.stage)
        });
        const animOrigMeta = parseGifMetadata(new Uint8Array(animBytes));
        const animCompBytes = new Uint8Array(await animRes.file.arrayBuffer());
        const animCompMeta = parseGifMetadata(animCompBytes);
        const animOrigDecoded = await decodeAllFramesRgba(new Uint8Array(animBytes), animOrigMeta.frameCount);
        const animCompDecoded = await decodeAllFramesRgba(animCompBytes, animCompMeta.frameCount);
        const animDiff = diffDecodedFrames(animOrigDecoded, animCompDecoded);

        // ------------------------------------------------------------------
        // 3. Coordinator + application/octet-stream GIF resolution
        // ------------------------------------------------------------------
        const octetAnimFile = new File([new Uint8Array(animBytes)], 'pasted-clip.gif', {
          type: 'application/octet-stream',
          lastModified: 1716000003000
        });
        const preparedOctet = await prepareAttachmentsForUpload([
          {
            id: 'att-gif-octet',
            name: 'pasted-clip.gif',
            originalName: 'pasted-clip.gif',
            type: 'application/octet-stream',
            size: octetAnimFile.size,
            extension: 'GIF',
            isImage: true,
            file: octetAnimFile
          }
        ]);
        clearFileCompressionCacheEntryForTesting(octetAnimFile);

        // ------------------------------------------------------------------
        // 4. Already-optimized GIF (< 10% savings) returns original untouched
        // ------------------------------------------------------------------
        const alreadyOptRes = await compressFile(animRes.file, { minImageBytes: 100 });

        // ------------------------------------------------------------------
        // 5. Fallback tests (validation failure, error, timeout)
        // ------------------------------------------------------------------
        // A. Validation failure (simulated dropped frame)
        setGifOptimizerForTesting(async () => new Uint8Array(staticBytes)); // 1 frame instead of 4
        const badValRes = await compressFile(animFile);

        // B. Optimizer throw
        setGifOptimizerForTesting(async () => {
          throw new Error('Simulated browser worker error');
        });
        const errRes = await compressFile(animFile);

        // C. Timeout
        setGifOptimizerForTesting(async () => {
          await new Promise((r) => setTimeout(r, 150));
          return animCompBytes;
        });
        const timeoutRes = await compressFile(animFile, { timeoutMs: 25 });
        setGifOptimizerForTesting(null);

        // ------------------------------------------------------------------
        // 6. AbortSignal cancellation (pre-aborted + mid-flight worker abort)
        // ------------------------------------------------------------------
        const preCtrl = new AbortController();
        preCtrl.abort();
        const preAbortRes = await compressFile(animFile, { signal: preCtrl.signal });

        const midCtrl = new AbortController();
        const midPromise = compressFile(animFile, { signal: midCtrl.signal });
        setTimeout(() => midCtrl.abort(), 5);
        const midAbortRes = await midPromise;

        return {
          COMPRESSION_REASONS,
          COMPRESSION_STAGES,
          staticTest: {
            compressed: staticRes.compressed,
            reason: staticRes.reason,
            fileName: staticRes.file.name,
            fileType: staticRes.file.type,
            originalSize: staticRes.originalSize,
            finalSize: staticRes.finalSize,
            savingsPct: Number(
              (((staticRes.originalSize - staticRes.finalSize) / staticRes.originalSize) * 100).toFixed(2)
            ),
            stages: staticStages,
            width: staticCompMeta.width,
            height: staticCompMeta.height,
            frameCount: staticCompMeta.frameCount,
            maxChannelDiff: staticDiff.maxChannelDiff,
            frameDiff: staticDiff.frameDiffs[0]
          },
          animTest: {
            compressed: animRes.compressed,
            reason: animRes.reason,
            fileName: animRes.file.name,
            fileType: animRes.file.type,
            originalSize: animRes.originalSize,
            finalSize: animRes.finalSize,
            savingsPct: Number(
              (((animRes.originalSize - animRes.finalSize) / animRes.originalSize) * 100).toFixed(2)
            ),
            stages: animStages,
            origMeta: {
              width: animOrigMeta.width,
              height: animOrigMeta.height,
              frameCount: animOrigMeta.frameCount,
              loopCount: animOrigMeta.loopCount,
              delays: animOrigMeta.frames.map((f) => f.delayCs)
            },
            compMeta: {
              width: animCompMeta.width,
              height: animCompMeta.height,
              frameCount: animCompMeta.frameCount,
              loopCount: animCompMeta.loopCount,
              delays: animCompMeta.frames.map((f) => f.delayCs),
              disposals: animCompMeta.frames.map((f) => f.disposalMethod),
              hasAlpha: animCompMeta.hasAlphaMetadata
            },
            origTrack: animOrigDecoded.trackInfo,
            compTrack: animCompDecoded.trackInfo,
            maxChannelDiff: animDiff.maxChannelDiff,
            frameDiffs: animDiff.frameDiffs
          },
          octetCoordinatorTest: {
            compressed: preparedOctet[0].compression.compressed,
            attType: preparedOctet[0].type,
            fileType: preparedOctet[0].file.type,
            originalSize: preparedOctet[0].compression.originalSize,
            finalSize: preparedOctet[0].size
          },
          alreadyOptTest: {
            compressed: alreadyOptRes.compressed,
            reason: alreadyOptRes.reason,
            sameRef: alreadyOptRes.file === animRes.file
          },
          fallbackTests: {
            badValReason: badValRes.reason,
            badValSameRef: badValRes.file === animFile,
            errReason: errRes.reason,
            errSameRef: errRes.file === animFile,
            timeoutReason: timeoutRes.reason,
            timeoutSameRef: timeoutRes.file === animFile
          },
          abortTests: {
            preReason: preAbortRes.reason,
            preSameRef: preAbortRes.file === animFile,
            midReason: midAbortRes.reason,
            midSameRef: midAbortRes.file === animFile
          }
        };
      },
      {
        staticBytes: Array.from(staticGifBuf),
        animBytes: Array.from(animGifBuf)
      }
    );

    assert.deepStrictEqual(pageErrors, [], `Browser page errors: ${pageErrors.join('; ')}`);
    assert.deepStrictEqual(consoleErrors, [], `Browser console errors: ${consoleErrors.join('; ')}`);

    const R = results.COMPRESSION_REASONS;
    const S = results.COMPRESSION_STAGES;

    // 1. Static GIF assertions
    assert.ok(results.staticTest.originalSize >= 80 * 1024, 'Static GIF must exceed 80 KB default gate');
    assert.strictEqual(results.staticTest.compressed, true, `Static GIF failed: ${results.staticTest.reason}`);
    assert.strictEqual(results.staticTest.reason, R.COMPRESSED);
    assert.strictEqual(results.staticTest.fileName, 'static-diagram.gif');
    assert.strictEqual(results.staticTest.fileType, 'image/gif');
    assert.ok(results.staticTest.savingsPct >= 10, `Expected >= 10% static savings, got ${results.staticTest.savingsPct}%`);
    assert.deepStrictEqual(results.staticTest.stages, [S.ANALYZING, S.OPTIMIZING, S.VALIDATING, S.COMPLETE]);
    assert.strictEqual(results.staticTest.width, 320);
    assert.strictEqual(results.staticTest.height, 240);
    assert.strictEqual(results.staticTest.frameCount, 1);
    assert.strictEqual(results.staticTest.maxChannelDiff, 0, 'Static GIF must have 0 RGBA pixel diff');
    assert.ok(results.staticTest.frameDiff.transparentOrig > 0);
    assert.strictEqual(
      results.staticTest.frameDiff.transparentComp,
      results.staticTest.frameDiff.transparentOrig,
      'Static GIF transparent pixel count must be 100% preserved'
    );

    // 2. Animated GIF assertions
    assert.ok(results.animTest.originalSize >= 80 * 1024, 'Animated GIF must exceed 80 KB default gate');
    assert.strictEqual(results.animTest.compressed, true, `Animated GIF failed: ${results.animTest.reason}`);
    assert.strictEqual(results.animTest.reason, R.COMPRESSED);
    assert.strictEqual(results.animTest.fileName, 'loader-loop.gif');
    assert.strictEqual(results.animTest.fileType, 'image/gif');
    assert.ok(results.animTest.savingsPct >= 10, `Expected >= 10% anim savings, got ${results.animTest.savingsPct}%`);
    assert.deepStrictEqual(results.animTest.stages, [S.ANALYZING, S.OPTIMIZING, S.VALIDATING, S.COMPLETE]);
    assert.strictEqual(results.animTest.compMeta.width, 240);
    assert.strictEqual(results.animTest.compMeta.height, 180);
    assert.strictEqual(results.animTest.compMeta.frameCount, 4);
    assert.strictEqual(results.animTest.compMeta.loopCount, 3);
    assert.deepStrictEqual(results.animTest.compMeta.delays, [15, 30, 45, 60]);
    assert.strictEqual(results.animTest.compMeta.hasAlpha, true);
    assert.strictEqual(results.animTest.compTrack.frameCount, 4);
    assert.strictEqual(results.animTest.compTrack.repetitionCount, 3);
    assert.strictEqual(results.animTest.maxChannelDiff, 0, 'Animated GIF must have 0 RGBA diff across ALL frames');
    for (let f = 0; f < results.animTest.frameDiffs.length; f++) {
      const fd = results.animTest.frameDiffs[f];
      assert.strictEqual(fd.maxDiff, 0, `Frame ${f} pixel diff must be 0`);
      assert.strictEqual(fd.transparentComp, fd.transparentOrig, `Frame ${f} transparent pixels mismatch`);
      assert.strictEqual(fd.durationCompUs, fd.durationOrigUs, `Frame ${f} duration mismatch`);
    }

    // 3. Coordinator octet-stream assertions
    assert.strictEqual(results.octetCoordinatorTest.compressed, true);
    assert.strictEqual(results.octetCoordinatorTest.attType, 'image/gif');
    assert.strictEqual(results.octetCoordinatorTest.fileType, 'image/gif');
    assert.ok(results.octetCoordinatorTest.finalSize < results.octetCoordinatorTest.originalSize);

    // 4. < 10% savings assertions
    assert.strictEqual(results.alreadyOptTest.compressed, false);
    assert.strictEqual(results.alreadyOptTest.reason, R.INSUFFICIENT_SAVINGS);
    assert.strictEqual(results.alreadyOptTest.sameRef, true);

    // 5. Fallback assertions
    assert.strictEqual(results.fallbackTests.badValReason, R.VALIDATION_FAILED);
    assert.strictEqual(results.fallbackTests.badValSameRef, true);
    assert.strictEqual(results.fallbackTests.errReason, R.ERROR);
    assert.strictEqual(results.fallbackTests.errSameRef, true);
    assert.strictEqual(results.fallbackTests.timeoutReason, R.TIMEOUT);
    assert.strictEqual(results.fallbackTests.timeoutSameRef, true);

    // 6. AbortSignal assertions
    assert.strictEqual(results.abortTests.preReason, R.ABORTED);
    assert.strictEqual(results.abortTests.preSameRef, true);
    assert.strictEqual(results.abortTests.midReason, R.ABORTED);
    assert.strictEqual(results.abortTests.midSameRef, true);

    console.log('Browser Lossless GIF Compression Results (@fe-daily/gifsicle-wasm-browser WASM Worker):');
    console.log(
      `  • Static GIF (${results.staticTest.width}x${results.staticTest.height}, 1 frame): ${results.staticTest.originalSize} bytes -> ${results.staticTest.finalSize} bytes (${results.staticTest.savingsPct}% saved)`
    );
    console.log(
      `    Max RGBA pixel diff: ${results.staticTest.maxChannelDiff}, Transparent pixels preserved: ${results.staticTest.frameDiff.transparentComp}/${results.staticTest.frameDiff.transparentOrig}`
    );
    console.log(
      `  • Animated GIF (${results.animTest.compMeta.width}x${results.animTest.compMeta.height}, ${results.animTest.compMeta.frameCount} frames, loop=${results.animTest.compMeta.loopCount}, delays=[${results.animTest.compMeta.delays.join(',')}]cs): ${results.animTest.originalSize} bytes -> ${results.animTest.finalSize} bytes (${results.animTest.savingsPct}% saved)`
    );
    console.log(
      `    Max RGBA pixel diff across ALL 4 frames: ${results.animTest.maxChannelDiff}, ImageDecoder track=${results.animTest.compTrack.frameCount} frames / loop=${results.animTest.compTrack.repetitionCount}`
    );
    console.log(
      `  • Octet-stream coordinator GIF: resolved type=${results.octetCoordinatorTest.fileType} (${results.octetCoordinatorTest.originalSize} -> ${results.octetCoordinatorTest.finalSize} bytes)`
    );
    console.log('ALL 6 REAL BROWSER GIF COMPRESSION TEST GROUPS PASSED!');
  } finally {
    await browser.close();
    await cleanup();
  }
}

runBrowserGifTests().catch((err) => {
  console.error('REAL BROWSER GIF COMPRESSION TEST FAILED:', err);
  process.exit(1);
});
