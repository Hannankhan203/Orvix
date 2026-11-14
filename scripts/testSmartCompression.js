/**
 * scripts/testSmartCompression.js
 *
 * Focused unit and integration test suite for src/services/smartCompressionService.js.
 * Verifies:
 * - Result shape consistency
 * - Lightweight file, unsupported format, animated image (APNG/WebP/GIF), and protected PDF skipping
 * - Lossless structural PDF optimization with pdf-lib (page count, dimensions, and selectable text preservation)
 * - >= 10% storage savings gate
 * - Image quality heuristics (text/diagram detection, transparency preservation, no aggressive downscaling)
 * - Output binary signature, dimension, MIME, and extension validation
 * - AbortSignal, timeout, stage callbacks, and untouched original File fallback on error
 */

import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { extractText, getDocumentProxy } from 'unpdf';

import {
  compressFile,
  COMPRESSION_REASONS,
  COMPRESSION_STAGES,
  analyzeImagePixels,
  computeSafeTargetDimensions,
  detectAnimatedImage,
  detectFormatFromSignature,
  parseImageHeaderInfo,
  setImageCompressionAdapterForTesting
} from '../src/services/smartCompressionService.js';

// ---------------------------------------------------------------------------
// Deterministic Binary Helpers (PNG, JPEG, WebP, GIF)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ -1) | 0;
}

function pngChunk(type, data) {
  const len = data.length;
  const out = Buffer.alloc(12 + len);
  out.writeUInt32BE(len, 0);
  out.write(type, 4, 4, 'ascii');
  data.copy(out, 8);
  const crcInput = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  out.writeInt32BE(crc32(crcInput), 8 + len);
  return out;
}

function makePngBuffer(width, height, { colorType = 6, animated = false, extraPaddingBytes = 0 } = {}) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType; // 6 = RGBA, 2 = RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const chunks = [sig, pngChunk('IHDR', ihdr)];

  if (animated) {
    const actl = Buffer.alloc(8);
    actl.writeUInt32BE(2, 0); // num_frames
    actl.writeUInt32BE(0, 4); // num_plays
    chunks.push(pngChunk('acTL', actl));
  }

  if (extraPaddingBytes > 0) {
    const textPayload = Buffer.concat([
      Buffer.from('Comment\0', 'ascii'),
      Buffer.alloc(extraPaddingBytes, 0x41)
    ]);
    chunks.push(pngChunk('tEXt', textPayload));
  }

  const rawScanline = Buffer.alloc(1 + width * (colorType === 6 ? 4 : 3), 0);
  const rawImage = Buffer.concat(Array.from({ length: Math.min(height, 4) }, () => rawScanline));
  chunks.push(pngChunk('IDAT', zlib.deflateSync(rawImage)));
  chunks.push(pngChunk('IEND', Buffer.alloc(0)));

  return Buffer.concat(chunks);
}

function makeMinimalJpegBuffer(width, height, paddingBytes = 0) {
  // Valid SOI + APP0 padding + SOF0 (width, height) + SOS + EOI
  const chunks = [Buffer.from([0xff, 0xd8])];

  if (paddingBytes > 0) {
    let remaining = paddingBytes;
    while (remaining > 0) {
      const segDataLen = Math.min(remaining, 60000);
      const app = Buffer.alloc(4 + segDataLen);
      app[0] = 0xff;
      app[1] = 0xe1; // APP1
      app.writeUInt16BE(segDataLen + 2, 2);
      app.fill(0x42, 4);
      chunks.push(app);
      remaining -= segDataLen;
    }
  }

  const sof0 = Buffer.alloc(19);
  sof0[0] = 0xff;
  sof0[1] = 0xc0; // SOF0
  sof0.writeUInt16BE(17, 2);
  sof0[4] = 8; // precision
  sof0.writeUInt16BE(height, 5);
  sof0.writeUInt16BE(width, 7);
  sof0[9] = 3; // components
  sof0[10] = 1;
  sof0[11] = 0x11;
  sof0[12] = 0;
  sof0[13] = 2;
  sof0[14] = 0x11;
  sof0[15] = 1;
  sof0[16] = 3;
  sof0[17] = 0x11;
  sof0[18] = 1;

  const eoi = Buffer.from([0xff, 0xd9]);
  chunks.push(sof0, eoi);
  return Buffer.concat(chunks);
}

function makeMinimalWebpBuffer(width, height, { animated = false, hasAlpha = false, paddingBytes = 0 } = {}) {
  const vp8xPayload = Buffer.alloc(10, 0);
  let flags = 0;
  if (animated) flags |= 0x02;
  if (hasAlpha) flags |= 0x10;
  vp8xPayload[0] = flags;
  const wMinus1 = width - 1;
  const hMinus1 = height - 1;
  vp8xPayload[4] = wMinus1 & 0xff;
  vp8xPayload[5] = (wMinus1 >> 8) & 0xff;
  vp8xPayload[6] = (wMinus1 >> 16) & 0xff;
  vp8xPayload[7] = hMinus1 & 0xff;
  vp8xPayload[8] = (hMinus1 >> 8) & 0xff;
  vp8xPayload[9] = (hMinus1 >> 16) & 0xff;

  const vp8xChunk = Buffer.alloc(18);
  vp8xChunk.write('VP8X', 0, 4, 'ascii');
  vp8xChunk.writeUInt32LE(10, 4);
  vp8xPayload.copy(vp8xChunk, 8);

  const subChunks = [vp8xChunk];
  if (animated) {
    const animChunk = Buffer.alloc(14, 0);
    animChunk.write('ANIM', 0, 4, 'ascii');
    animChunk.writeUInt32LE(6, 4);
    subChunks.push(animChunk);
  }

  if (paddingBytes > 0) {
    const evenPad = paddingBytes % 2 === 0 ? paddingBytes : paddingBytes + 1;
    const padChunk = Buffer.alloc(8 + evenPad, 0x55);
    padChunk.write('ICCP', 0, 4, 'ascii');
    padChunk.writeUInt32LE(evenPad, 4);
    subChunks.push(padChunk);
  }

  const body = Buffer.concat([Buffer.from('WEBP', 'ascii'), ...subChunks]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 4, 'ascii');
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

function makeAnimatedGifBuffer() {
  // Minimal GIF89a with two Image Descriptors (0x2C)
  return Buffer.from([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, // GIF89a
    0x02, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, // LSD (no GCT)
    0x2c, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x02, 0x00, 0x00, // Frame 1
    0x02, 0x02, 0x44, 0x01, 0x00, // Image data + block terminator
    0x2c, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x02, 0x00, 0x00, // Frame 2
    0x02, 0x02, 0x44, 0x01, 0x00, // Image data + block terminator
    0x3b // Trailer
  ]);
}

async function makeOptimizablePdfBuffer(pageTexts) {
  // Build a valid PDF with selectable text and save WITHOUT object streams,
  // plus harmless incremental comments/whitespace representing unoptimized PDF output,
  // so pdf-lib lossless object-stream compaction yields >= 10% savings.
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);

  for (let i = 0; i < pageTexts.length; i++) {
    const page = doc.addPage([612, 792]);
    page.drawText(pageTexts[i], {
      x: 50,
      y: 720,
      size: 16,
      font,
      color: rgb(0.1, 0.1, 0.1)
    });
    // Add many small vector line operations to create lots of indirect / structural objects or verbose content
    for (let j = 0; j < 25; j++) {
      page.drawText(`Line ${j + 1}: Selectable technical report paragraph content for page ${i + 1}.`, {
        x: 50,
        y: 680 - j * 20,
        size: 10,
        font
      });
    }
  }

  // Save uncompressed (useObjectStreams: false) to simulate bloated multi-object PDF
  const baseBytes = await doc.save({ useObjectStreams: false });
  // Also create an incremental-style duplicate object / verbose xref bloat by reloading & adding unused metadata comments before %%EOF
  const baseStr = Buffer.from(baseBytes).toString('latin1');
  const eofIdx = baseStr.lastIndexOf('%%EOF');
  const bloatComment = '\n% Unreferenced incremental padding ' + '0123456789ABCDEF'.repeat(4000) + '\n';
  const bloatedStr = baseStr.slice(0, eofIdx) + bloatComment + baseStr.slice(eofIdx);
  return Buffer.from(bloatedStr, 'latin1');
}

function assertResultShape(result) {
  assert.ok(result && typeof result === 'object', 'Result must be an object');
  assert.ok('file' in result, 'Result must contain file');
  assert.strictEqual(typeof result.compressed, 'boolean', 'Result.compressed must be boolean');
  assert.strictEqual(typeof result.originalSize, 'number', 'Result.originalSize must be number');
  assert.strictEqual(typeof result.finalSize, 'number', 'Result.finalSize must be number');
  assert.strictEqual(typeof result.reason, 'string', 'Result.reason must be string');
  assert.ok(result.reason.length > 0, 'Result.reason must be non-empty');
}

// ---------------------------------------------------------------------------
// Test Runner
// ---------------------------------------------------------------------------

async function runTests() {
  let passed = 0;

  // 1. Invalid inputs
  {
    const resNull = await compressFile(null);
    assertResultShape(resNull);
    assert.strictEqual(resNull.file, null);
    assert.strictEqual(resNull.compressed, false);
    assert.strictEqual(resNull.reason, COMPRESSION_REASONS.INVALID_INPUT);
    passed++;
  }

  // 2. Lightweight files skipped
  {
    const tinyPng = new File([makePngBuffer(32, 32)], 'tiny.png', { type: 'image/png' });
    const res = await compressFile(tinyPng);
    assertResultShape(res);
    assert.strictEqual(res.file, tinyPng, 'Must return exact original File reference');
    assert.strictEqual(res.compressed, false);
    assert.strictEqual(res.originalSize, tinyPng.size);
    assert.strictEqual(res.finalSize, tinyPng.size);
    assert.strictEqual(res.reason, COMPRESSION_REASONS.LIGHTWEIGHT_FILE);
    passed++;
  }

  // 3. Unsupported formats skipped
  {
    const txtBytes = Buffer.alloc(100 * 1024, 0x61);
    const txtFile = new File([txtBytes], 'notes.txt', { type: 'text/plain' });
    const res = await compressFile(txtFile);
    assertResultShape(res);
    assert.strictEqual(res.file, txtFile);
    assert.strictEqual(res.compressed, false);
    assert.strictEqual(res.reason, COMPRESSION_REASONS.UNSUPPORTED_FORMAT);
    passed++;
  }

  // 4. Animated images skipped (APNG, Animated WebP, Animated GIF)
  {
    const apngBytes = makePngBuffer(600, 400, { animated: true, extraPaddingBytes: 95_000 });
    const apngFile = new File([apngBytes], 'anim.png', { type: 'image/png' });
    const resApng = await compressFile(apngFile);
    assert.strictEqual(resApng.file, apngFile);
    assert.strictEqual(resApng.compressed, false);
    assert.strictEqual(resApng.reason, COMPRESSION_REASONS.ANIMATED_IMAGE);

    const awebpBytes = makeMinimalWebpBuffer(600, 400, { animated: true, paddingBytes: 95_000 });
    const awebpFile = new File([awebpBytes], 'anim.webp', { type: 'image/webp' });
    const resAwebp = await compressFile(awebpFile);
    assert.strictEqual(resAwebp.file, awebpFile);
    assert.strictEqual(resAwebp.compressed, false);
    assert.strictEqual(resAwebp.reason, COMPRESSION_REASONS.ANIMATED_IMAGE);

    const gifBytes = Buffer.concat([makeAnimatedGifBuffer(), Buffer.alloc(90_000, 0)]);
    assert.strictEqual(detectAnimatedImage(gifBytes, 'image/gif'), true);
    const gifFile = new File([gifBytes], 'anim.gif', { type: 'image/gif' });
    const resGif = await compressFile(gifFile);
    assert.strictEqual(resGif.file, gifFile);
    assert.strictEqual(resGif.compressed, false);
    assert.strictEqual(resGif.reason, COMPRESSION_REASONS.ANIMATED_IMAGE);
    passed++;
  }

  // 5. Binary signature & header parsers
  {
    const pngBuf = makePngBuffer(1280, 720, { colorType: 6 });
    assert.strictEqual(detectFormatFromSignature(pngBuf), 'image/png');
    const pngInfo = parseImageHeaderInfo(pngBuf, 'image/png');
    assert.deepStrictEqual(pngInfo, {
      valid: true,
      width: 1280,
      height: 720,
      hasAlphaMetadata: true
    });

    const jpgBuf = makeMinimalJpegBuffer(1920, 1080);
    assert.strictEqual(detectFormatFromSignature(jpgBuf), 'image/jpeg');
    const jpgInfo = parseImageHeaderInfo(jpgBuf, 'image/jpeg');
    assert.deepStrictEqual(jpgInfo, {
      valid: true,
      width: 1920,
      height: 1080,
      hasAlphaMetadata: false
    });

    const webpBuf = makeMinimalWebpBuffer(800, 600, { hasAlpha: true });
    assert.strictEqual(detectFormatFromSignature(webpBuf), 'image/webp');
    const webpInfo = parseImageHeaderInfo(webpBuf, 'image/webp');
    assert.deepStrictEqual(webpInfo, {
      valid: true,
      width: 800,
      height: 600,
      hasAlphaMetadata: true
    });
    passed++;
  }

  // 6. PDF lossless structural optimization (text, page count, dimensions preserved + >=10% savings)
  {
    const pageTexts = [
      'Quarterly Architecture Review — Page One Unique Marker Alpha',
      'OCR and Vector Preservation Check — Page Two Unique Marker Beta'
    ];
    const bloatedPdf = await makeOptimizablePdfBuffer(pageTexts);
    const pdfFile = new File([bloatedPdf], 'architecture-report.pdf', {
      type: 'application/pdf',
      lastModified: 1700000000000
    });

    const stages = [];
    const res = await compressFile(pdfFile, {
      onStage: (info) => stages.push(info.stage)
    });

    assertResultShape(res);
    assert.strictEqual(res.compressed, true, `Expected PDF compression to succeed, got ${res.reason}`);
    assert.notStrictEqual(res.file, pdfFile);
    assert.strictEqual(res.file.name, 'architecture-report.pdf');
    assert.strictEqual(res.file.type, 'application/pdf');
    assert.strictEqual(res.originalSize, pdfFile.size);
    assert.strictEqual(res.finalSize, res.file.size);
    assert.ok(
      (res.originalSize - res.finalSize) / res.originalSize >= 0.1,
      'Must achieve >= 10% savings'
    );
    assert.strictEqual(res.reason, COMPRESSION_REASONS.COMPRESSED);
    assert.deepStrictEqual(stages, [
      COMPRESSION_STAGES.ANALYZING,
      COMPRESSION_STAGES.OPTIMIZING,
      COMPRESSION_STAGES.VALIDATING,
      COMPRESSION_STAGES.COMPLETE
    ]);

    // Verify selectable text and page count are 100% preserved via unpdf
    const origProxy = await getDocumentProxy(new Uint8Array(await pdfFile.arrayBuffer()));
    const origExtracted = await extractText(origProxy, { mergePages: false });
    const compProxy = await getDocumentProxy(new Uint8Array(await res.file.arrayBuffer()));
    const compExtracted = await extractText(compProxy, { mergePages: false });

    assert.strictEqual(compExtracted.totalPages, origExtracted.totalPages);
    assert.strictEqual(compExtracted.totalPages, 2);
    assert.deepStrictEqual(compExtracted.text, origExtracted.text);
    passed++;
  }

  // 7. Protected / encrypted PDF skipped without alteration
  {
    const doc = await PDFDocument.create();
    doc.addPage([500, 500]);
    const cleanPdf = Buffer.from(await doc.save());
    // Inject /Encrypt dictionary reference into trailer region + pad over 64KB
    const str = cleanPdf.toString('latin1');
    const trailerIdx = str.lastIndexOf('trailer');
    const encryptedSim = Buffer.from(
      str.slice(0, trailerIdx) +
        '0'.repeat(70_000) +
        '\ntrailer\n<< /Size 5 /Root 1 0 R /Encrypt 99 0 R >>\nstartxref\n0\n%%EOF',
      'latin1'
    );
    const encFile = new File([encryptedSim], 'confidential.pdf', { type: 'application/pdf' });
    const res = await compressFile(encFile);
    assert.strictEqual(res.file, encFile);
    assert.strictEqual(res.compressed, false);
    assert.strictEqual(res.reason, COMPRESSION_REASONS.PROTECTED_PDF);
    passed++;
  }

  // 8. PDF insufficient savings (<10%) returns untouched original
  {
    // Already compact multi-page PDF with 0 bloat (padded in-stream via Flate image/text or low threshold)
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let p = 0; p < 5; p++) {
      const page = doc.addPage([600, 800]);
      page.drawText(`Compact PDF Page ${p + 1}`, { x: 40, y: 740, size: 12, font });
    }
    const compactBytes = await doc.save({ useObjectStreams: true });
    const compactFile = new File([compactBytes], 'already-compact.pdf', {
      type: 'application/pdf'
    });
    const res = await compressFile(compactFile, { minPdfBytes: 100 });
    assert.strictEqual(res.file, compactFile);
    assert.strictEqual(res.compressed, false);
    assert.strictEqual(res.reason, COMPRESSION_REASONS.INSUFFICIENT_SAVINGS);
    passed++;
  }

  // 9. Image quality heuristics: text/diagram detection & no aggressive downscaling
  {
    // Simulate a high-contrast screenshot (mostly pure white background with dark sharp glyph transitions)
    const w = 200;
    const h = 100;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = (y * w + x) * 4;
        const isTextStripe = y >= 20 && y <= 60 && x % 8 < 2;
        const v = isTextStripe ? 10 : 255;
        rgba[idx] = v;
        rgba[idx + 1] = v;
        rgba[idx + 2] = v;
        rgba[idx + 3] = y < 5 ? 0 : 255; // includes transparent top edge
      }
    }
    const stats = analyzeImagePixels(rgba, w, h);
    assert.strictEqual(stats.hasTransparentPixels, true, 'Must detect transparency');
    assert.strictEqual(stats.isTextOrDiagramLikely, true, 'Must detect text/diagram/screenshot');

    // Text/diagram images must NEVER be downscaled even if huge
    const dimsText = computeSafeTargetDimensions(3800, 2400, {
      isTextOrDiagramLikely: true,
      mimeType: 'image/jpeg'
    });
    assert.deepStrictEqual(dimsText, { targetWidth: 3800, targetHeight: 2400, scaled: false });

    // Stitched tall screenshots (aspect > 2.5) must NEVER be downscaled
    const dimsTall = computeSafeTargetDimensions(1200, 5000, {
      isTextOrDiagramLikely: false,
      mimeType: 'image/jpeg'
    });
    assert.deepStrictEqual(dimsTall, { targetWidth: 1200, targetHeight: 5000, scaled: false });

    // Normal photos <= 3072px stay 1:1
    const dimsStandard = computeSafeTargetDimensions(2560, 1440, {
      isTextOrDiagramLikely: false,
      mimeType: 'image/jpeg'
    });
    assert.deepStrictEqual(dimsStandard, { targetWidth: 2560, targetHeight: 1440, scaled: false });
    passed++;
  }

  // 10. Browser-native image compression pipeline (transparency, MIME, extension, >=10% gate, validation)
  {
    // A. Successful transparent PNG optimization (e.g. stripping bloated tEXt metadata chunks)
    let seenEncodeOpts = null;
    setImageCompressionAdapterForTesting({
      async decodeAndAnalyze() {
        return {
          width: 1200,
          height: 800,
          hasTransparentPixels: true,
          isTextOrDiagramLikely: true,
          release() {}
        };
      },
      async encode(_decoded, opts) {
        seenEncodeOpts = opts;
        const outBuf = makePngBuffer(opts.targetWidth, opts.targetHeight, { colorType: 6 });
        return new Blob([outBuf], { type: 'image/png' });
      }
    });

    const bloatedPng = new File(
      [makePngBuffer(1200, 800, { colorType: 6, extraPaddingBytes: 120_000 })],
      'diagram.png',
      { type: 'image/png', lastModified: 1700000000123 }
    );
    const pngRes = await compressFile(bloatedPng);
    assert.strictEqual(pngRes.compressed, true);
    assert.notStrictEqual(pngRes.file, bloatedPng);
    assert.strictEqual(pngRes.file.name, 'diagram.png');
    assert.strictEqual(pngRes.file.type, 'image/png');
    assert.strictEqual(seenEncodeOpts.preserveTransparency, true);
    assert.strictEqual(seenEncodeOpts.targetWidth, 1200);
    assert.strictEqual(seenEncodeOpts.targetHeight, 800);

    // B. JPEG text/screenshot preserves .jpg extension and uses high quality (>= 0.90)
    const bloatedJpg = new File([makeMinimalJpegBuffer(1600, 900, 140_000)], 'slide.jpg', {
      type: 'image/jpeg'
    });
    setImageCompressionAdapterForTesting({
      async decodeAndAnalyze() {
        return {
          width: 1600,
          height: 900,
          hasTransparentPixels: false,
          isTextOrDiagramLikely: true,
          release() {}
        };
      },
      async encode(_decoded, opts) {
        seenEncodeOpts = opts;
        return new Blob([makeMinimalJpegBuffer(opts.targetWidth, opts.targetHeight, 20_000)], {
          type: 'image/jpeg'
        });
      }
    });
    const jpgRes = await compressFile(bloatedJpg);
    assert.strictEqual(jpgRes.compressed, true);
    assert.strictEqual(jpgRes.file.name, 'slide.jpg');
    assert.strictEqual(jpgRes.file.type, 'image/jpeg');
    assert.ok(seenEncodeOpts.quality >= 0.9, 'Text/diagram JPEG must keep quality >= 0.90');

    // C. Insufficient image savings (<10%) returns untouched original File
    const smallReductionJpg = new File([makeMinimalJpegBuffer(1600, 900, 100_000)], 'tight.jpeg', {
      type: 'image/jpeg'
    });
    setImageCompressionAdapterForTesting({
      async decodeAndAnalyze() {
        return {
          width: 1600,
          height: 900,
          hasTransparentPixels: false,
          isTextOrDiagramLikely: false,
          release() {}
        };
      },
      async encode(_decoded, opts) {
        // Only ~4% smaller -> must be rejected by 10% gate
        return new Blob([makeMinimalJpegBuffer(opts.targetWidth, opts.targetHeight, 96_000)], {
          type: 'image/jpeg'
        });
      }
    });
    const insRes = await compressFile(smallReductionJpg);
    assert.strictEqual(insRes.file, smallReductionJpg);
    assert.strictEqual(insRes.compressed, false);
    assert.strictEqual(insRes.reason, COMPRESSION_REASONS.INSUFFICIENT_SAVINGS);

    // D. Validation failure (mismatched output dimensions) returns untouched original File
    setImageCompressionAdapterForTesting({
      async decodeAndAnalyze() {
        return {
          width: 1600,
          height: 900,
          hasTransparentPixels: false,
          isTextOrDiagramLikely: true,
          release() {}
        };
      },
      async encode() {
        // Wrong dimensions (400x200 instead of 1600x900)
        return new Blob([makeMinimalJpegBuffer(400, 200, 10_000)], { type: 'image/jpeg' });
      }
    });
    const badDimsRes = await compressFile(smallReductionJpg);
    assert.strictEqual(badDimsRes.file, smallReductionJpg);
    assert.strictEqual(badDimsRes.compressed, false);
    assert.strictEqual(badDimsRes.reason, COMPRESSION_REASONS.VALIDATION_FAILED);

    // E. WebP optimization preserves MIME, extension, and alpha capability
    const bloatedWebp = new File(
      [makeMinimalWebpBuffer(1000, 750, { hasAlpha: true, paddingBytes: 120_000 })],
      'graphic.webp',
      { type: 'image/webp' }
    );
    setImageCompressionAdapterForTesting({
      async decodeAndAnalyze() {
        return {
          width: 1000,
          height: 750,
          hasTransparentPixels: true,
          isTextOrDiagramLikely: true,
          release() {}
        };
      },
      async encode(_decoded, opts) {
        seenEncodeOpts = opts;
        return new Blob([makeMinimalWebpBuffer(opts.targetWidth, opts.targetHeight, { hasAlpha: true })], {
          type: 'image/webp'
        });
      }
    });
    const webpRes = await compressFile(bloatedWebp, {
      onStage: () => {
        throw new Error('Callback error must be isolated');
      }
    });
    assert.strictEqual(webpRes.compressed, true);
    assert.strictEqual(webpRes.file.name, 'graphic.webp');
    assert.strictEqual(webpRes.file.type, 'image/webp');
    assert.strictEqual(seenEncodeOpts.preserveTransparency, true);
    assert.ok(seenEncodeOpts.quality >= 0.9, 'Text/diagram WebP must keep quality >= 0.90');

    // F. Validation failure (wrong output MIME) returns untouched original File
    setImageCompressionAdapterForTesting({
      async decodeAndAnalyze() {
        return {
          width: 1600,
          height: 900,
          hasTransparentPixels: false,
          isTextOrDiagramLikely: false,
          release() {}
        };
      },
      async encode() {
        return new Blob([makeMinimalWebpBuffer(1600, 900, { paddingBytes: 10_000 })], {
          type: 'image/webp'
        });
      }
    });
    const badMimeRes = await compressFile(smallReductionJpg);
    assert.strictEqual(badMimeRes.file, smallReductionJpg);
    assert.strictEqual(badMimeRes.compressed, false);
    assert.strictEqual(badMimeRes.reason, COMPRESSION_REASONS.VALIDATION_FAILED);

    setImageCompressionAdapterForTesting(null);
    passed++;
  }

  // 11. AbortSignal, timeout, and unexpected error fallback
  {
    const sampleJpg = new File([makeMinimalJpegBuffer(1200, 800, 120_000)], 'photo.jpg', {
      type: 'image/jpeg'
    });

    // Pre-aborted
    const preController = new AbortController();
    preController.abort();
    const preAbortRes = await compressFile(sampleJpg, { signal: preController.signal });
    assert.strictEqual(preAbortRes.file, sampleJpg);
    assert.strictEqual(preAbortRes.compressed, false);
    assert.strictEqual(preAbortRes.reason, COMPRESSION_REASONS.ABORTED);

    // Mid-flight abort
    const midController = new AbortController();
    setImageCompressionAdapterForTesting({
      async decodeAndAnalyze() {
        return await new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                width: 1200,
                height: 800,
                hasTransparentPixels: false,
                isTextOrDiagramLikely: false,
                release() {}
              }),
            200
          )
        );
      },
      async encode() {
        return null;
      }
    });
    setTimeout(() => midController.abort(), 15);
    const midAbortRes = await compressFile(sampleJpg, { signal: midController.signal });
    assert.strictEqual(midAbortRes.file, sampleJpg);
    assert.strictEqual(midAbortRes.compressed, false);
    assert.strictEqual(midAbortRes.reason, COMPRESSION_REASONS.ABORTED);

    // Timeout
    const timeoutRes = await compressFile(sampleJpg, { timeoutMs: 20 });
    assert.strictEqual(timeoutRes.file, sampleJpg);
    assert.strictEqual(timeoutRes.compressed, false);
    assert.strictEqual(timeoutRes.reason, COMPRESSION_REASONS.TIMEOUT);

    // Unexpected thrown error
    setImageCompressionAdapterForTesting({
      async decodeAndAnalyze() {
        throw new Error('Simulated codec crash');
      },
      async encode() {
        return null;
      }
    });
    const errRes = await compressFile(sampleJpg);
    assert.strictEqual(errRes.file, sampleJpg);
    assert.strictEqual(errRes.compressed, false);
    assert.strictEqual(errRes.reason, COMPRESSION_REASONS.ERROR);

    setImageCompressionAdapterForTesting(null);
    passed++;
  }

  console.log(`ALL ${passed} SMART COMPRESSION TEST GROUPS PASSED!`);
}

runTests().catch((err) => {
  console.error('SMART COMPRESSION TEST FAILED:', err);
  process.exit(1);
});
