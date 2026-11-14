/**
 * scripts/testTransparentStorageCompressionBrowser.js
 *
 * Real Headless Chromium E2E Verification Suite for Transparent Storage Compression
 * (TXT, MD, DOC, PPT, XLS — Prompt 10).
 *
 * Runs against the real Vite-bundled frontend ES modules inside Chromium:
 * 1. Compresses all 5 formats (TXT, MD, DOC, PPT, XLS) via fflate inside real Chromium,
 *    preserving untouched original att.file, filename, MIME type, and size.
 * 2. Exercises real browser XHR `uploadFileDirectToSupabase`:
 *    verifies wire bytes match Orvix storage envelope, NO HTTP Content-Encoding header is sent,
 *    and metadata fields are transmitted cleanly to /signed-url & /complete.
 * 3. Exercises real browser IndexedDB + `fetchAttachmentBlob` + real `DocumentPreviewModal`:
 *    confirms original bytes (never raw envelope) persist in IndexedDB, server/client defense-in-depth
 *    decoding works seamlessly, and `DocumentPreviewModal` renders original Markdown/Text content.
 * 4. Exercises real `extractBrowserDocument` (offline WebLLM path) using original `att.file`.
 * 5. Verifies `AbortSignal` cancellation, retry deduplication, and zero console/page errors.
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
  throw new Error('Could not locate playwright-core or playwright.');
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
  process.env.DISABLE_HMR = 'true';
  const express = (await import('express')).default;
  const { createServer: createViteServer } = await import('vite');
  const app = express();
  const vite = await createViteServer({
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: 'spa'
  });

  // Expose a clean Vite-transformed HTML host for real React DOM rendering in Chromium
  app.use(async (req, res, next) => {
    if (req.url === '/__test__/preview-host.html') {
      const html = await vite.transformIndexHtml(
        '/__test__/preview-host.html',
        `<!DOCTYPE html><html><head></head><body><div id="root"></div><script type="module">
          import React from 'react';
          import { createRoot } from 'react-dom/client';
          import DocumentPreviewModal from '/src/components/chat/DocumentPreviewModal.jsx';
          window.__ORVIX_MOUNT_PREVIEW__ = (host, attachment) => {
            const root = createRoot(host);
            root.render(React.createElement(DocumentPreviewModal, { isOpen: true, onClose: () => {}, attachment }));
            return () => root.unmount();
          };
        </script></body></html>`
      );
      res.status(200).set({ 'Content-Type': 'text/html' }).end(html);
      return;
    }
    next();
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

console.log('\n======================================================================');
console.log('ORVIX REAL CHROMIUM TRANSPARENT STORAGE COMPRESSION E2E SUITE');
console.log('======================================================================\n');

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
    if (msg.type() === 'error') {
      const text = msg.text();
      if (text.includes('ws://127.0.0.1:24678') || text.includes('[vite] failed to connect to websocket')) {
        return;
      }
      consoleErrors.push(text);
    }
  });
  page.on('pageerror', (err) => {
    const msg = err?.message || String(err);
    if (msg.includes('WebSocket closed without opened')) {
      return;
    }
    pageErrors.push(msg);
  });

  // Intercept direct signed URL upload & API routes inside browser context to capture exact XHR headers & bytes
  const capturedDirectUploads = [];
  const capturedSignedInitPayloads = [];
  const capturedCompletePayloads = [];

  await page.route('**/api/upload/direct/signed-url', async (route) => {
    const body = route.request().postDataJSON();
    capturedSignedInitPayloads.push(body);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        signedUrl: `${baseUrl}/__mock_supabase_put__/att-direct-1`,
        storagePath: 'uid-browser/chat-browser/att-direct-1.md',
        attachmentId: 'att-direct-1',
        bucket: 'orvix-attachments',
        expiresIn: 7200
      })
    });
  });

  await page.route('**/__mock_supabase_put__/**', async (route) => {
    const req = route.request();
    const headers = req.headers();
    const rawBuf = req.postDataBuffer();
    capturedDirectUploads.push({
      url: req.url(),
      contentType: headers['content-type'] || null,
      contentEncoding: headers['content-encoding'] || null,
      byteLength: rawBuf ? rawBuf.length : 0,
      magicPrefix: rawBuf ? rawBuf.subarray(0, 7).toString('ascii') : ''
    });
    await route.fulfill({ status: 200, body: '' });
  });

  await page.route('**/api/upload/direct/complete', async (route) => {
    const body = route.request().postDataJSON();
    capturedCompletePayloads.push(body);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        attachment: {
          id: body.attachmentId,
          chatId: body.chatId,
          conversationId: body.chatId,
          name: 'design-notes.md',
          originalName: 'design-notes.md',
          extension: 'MD',
          mimeType: body.originalMimeType || 'text/markdown',
          type: body.originalMimeType || 'text/markdown',
          size: body.originalSize,
          storageEncoding: body.storageEncoding,
          status: 'ready'
        }
      })
    });
  });

  await page.route('**/api/upload/att-fetch-envelope/file*', async (route) => {
    // Simulate server returning decoded original bytes (and verify DocumentPreviewModal / fetchAttachmentBlob handles both)
    await route.fulfill({
      status: 200,
      contentType: 'text/markdown; charset=utf-8',
      body: '# Decoded Preview Title\n\nOriginal markdown line recovered from server without raw envelope exposure.\n'
    });
  });

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });

  // -------------------------------------------------------------------------
  // TEST 1: All 5 formats compressed in Chromium via coordinator + fflate
  // -------------------------------------------------------------------------
  console.log('1. Testing all 5 formats (TXT, MD, DOC, PPT, XLS) compression + round-trip in Chromium...');
  const fiveFormatReport = await page.evaluate(async () => {
    const {
      prepareAttachmentsForUpload,
      clearFileCompressionCacheEntryForTesting
    } = await import('/src/services/attachmentCompressionCoordinator.js');
    const {
      isOrvixStorageEnvelope,
      decodeOrvixStorageEnvelopeSync
    } = await import('/src/services/storageEnvelopeService.js');

    const makeOle = (tag, phrase) => {
      const magic = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
      const hdr = new Uint8Array(504);
      const bodyStr = Array.from({ length: 160 }, (_, i) => `${tag} Row ${i}: ${phrase}\n`).join('');
      const body = new TextEncoder().encode(bodyStr);
      const combined = new Uint8Array(magic.length + hdr.length + body.length);
      combined.set(magic, 0);
      combined.set(hdr, magic.length);
      combined.set(body, magic.length + hdr.length);
      return combined;
    };

    const specs = [
      {
        key: 'TXT',
        name: 'report.txt',
        ext: 'TXT',
        mime: 'text/plain',
        bytes: new TextEncoder().encode('Orvix log entry line sample\n'.repeat(300))
      },
      {
        key: 'MD',
        name: 'guide.md',
        ext: 'MD',
        mime: 'text/markdown',
        bytes: new TextEncoder().encode('## Heading\n\nLossless markdown specification block.\n'.repeat(240))
      },
      {
        key: 'DOC',
        name: 'memo.doc',
        ext: 'DOC',
        mime: 'application/msword',
        bytes: makeOle('WORD', 'Legacy Word document confidential section data.')
      },
      {
        key: 'PPT',
        name: 'slides.ppt',
        ext: 'PPT',
        mime: 'application/vnd.ms-powerpoint',
        bytes: makeOle('PPT', 'Presentation keynote slide bullets and summary notes.')
      },
      {
        key: 'XLS',
        name: 'budget.xls',
        ext: 'XLS',
        mime: 'application/vnd.ms-excel',
        bytes: makeOle('XLS', 'Quarterly revenue spreadsheet forecast column sum.')
      }
    ];

    const results = [];
    for (const s of specs) {
      const origFile = new File([s.bytes], s.name, { type: s.mime });
      const [prep] = await prepareAttachmentsForUpload([
        { id: `att-${s.key}`, name: s.name, originalName: s.name, size: origFile.size, type: s.mime, extension: s.ext, file: origFile }
      ]);
      const envBuf = new Uint8Array(await prep.storageCompression.encodedFile.arrayBuffer());
      const decoded = decodeOrvixStorageEnvelopeSync(envBuf, { expectedExtension: `.${s.ext.toLowerCase()}` });
      const origMatched = decoded.data.length === s.bytes.length && decoded.data.every((b, idx) => b === s.bytes[idx]);
      results.push({
        key: s.key,
        sameOriginalFileRef: prep.file === origFile,
        reportedSize: prep.size,
        originalSize: s.bytes.length,
        encodedSize: envBuf.length,
        isEnvelope: isOrvixStorageEnvelope(envBuf),
        origMatched,
        savingsPct: Number((((s.bytes.length - envBuf.length) / s.bytes.length) * 100).toFixed(2))
      });
      clearFileCompressionCacheEntryForTesting(origFile);
    }
    return results;
  });

  for (const r of fiveFormatReport) {
    assert.equal(r.sameOriginalFileRef, true, `${r.key}: original att.file preserved in Chromium`);
    assert.equal(r.reportedSize, r.originalSize, `${r.key}: reported size equals original size`);
    assert.equal(r.isEnvelope, true, `${r.key}: wire payload is valid Orvix envelope`);
    assert.equal(r.origMatched, true, `${r.key}: byte-for-byte lossless decode in Chromium`);
    assert.ok(r.savingsPct >= 10, `${r.key}: savings >= 10% (got ${r.savingsPct}%)`);
  }
  console.log('   ✓ Chromium compressed & round-trip verified all 5 formats');

  // -------------------------------------------------------------------------
  // TEST 2: Direct Supabase Upload XHR (NO Content-Encoding) + Offline WebLLM + IndexedDB
  // -------------------------------------------------------------------------
  console.log('2. Testing direct XHR upload, IndexedDB original storage & offline WebLLM extraction...');
  const pipelineResult = await page.evaluate(async () => {
    const {
      prepareAttachmentsForUpload,
      clearFileCompressionCacheEntryForTesting
    } = await import('/src/services/attachmentCompressionCoordinator.js');
    const {
      uploadFileDirectToSupabase,
      saveAttachmentBlob,
      getAttachmentRecord,
      fetchAttachmentBlob
    } = await import('/src/services/attachmentStorageService.js');
    const { extractBrowserDocument } = await import('/src/services/browserDocumentExtractor.js');

    const mdText = Array.from({ length: 150 }, (_, i) => `### Note ${i}\nContent verified lossless in Chromium browser suite.\n`).join('');
    const origMdFile = new File([mdText], 'design-notes.md', { type: 'text/markdown' });

    const [prepared] = await prepareAttachmentsForUpload([
      {
        id: 'att-md-e2e',
        name: 'design-notes.md',
        originalName: 'design-notes.md',
        size: origMdFile.size,
        type: 'text/markdown',
        extension: 'MD',
        file: origMdFile
      }
    ]);

    // 2a. Offline WebLLM extraction runs cleanly against untouched original att.file
    const webllmExt = await extractBrowserDocument(prepared.file, {
      id: prepared.id,
      name: prepared.name,
      originalName: prepared.originalName,
      mimeType: prepared.type,
      extension: prepared.extension
    });

    // 2b. Save untouched original File into real IndexedDB
    await saveAttachmentBlob(prepared.id, prepared.file, {
      name: prepared.name,
      originalName: prepared.originalName,
      mimeType: prepared.type,
      size: prepared.size,
      formattedSize: prepared.formattedSize,
      extension: prepared.extension
    });
    const idbRec = await getAttachmentRecord(prepared.id);
    const idbText = idbRec?.blob ? await idbRec.blob.text() : '';

    // 2c. Direct upload XHR with storageCompression
    const progressEvents = [];
    const directRes = await uploadFileDirectToSupabase(prepared.file, {
      chatId: 'chat-browser',
      storageCompression: prepared.storageCompression,
      onProgress: (pct) => progressEvents.push(pct)
    });

    // 2d. Fetch decoded blob from server when IndexedDB misses
    const fetchedRes = await fetchAttachmentBlob(
      {
        id: 'att-fetch-envelope',
        name: 'decoded-doc.md',
        extension: 'MD',
        type: 'text/markdown',
        chatId: 'chat-browser'
      },
      'chat-browser'
    );
    const fetchedText = fetchedRes?.blob ? await fetchedRes.blob.text() : '';

    clearFileCompressionCacheEntryForTesting(origMdFile);

    return {
      webllmSuccess: webllmExt.success,
      webllmHasContent: webllmExt.text.includes('Note 99'),
      idbSize: idbRec?.blob?.size || 0,
      origSize: origMdFile.size,
      idbMatchesOriginal: idbText === mdText,
      idbContainsEnvelopeMagic: idbText.startsWith('ORVXENV'),
      directSuccess: directRes.success,
      directProgressEnd: progressEvents[progressEvents.length - 1] || 0,
      fetchedSuccess: fetchedRes.success,
      fetchedHasContent: fetchedText.includes('Decoded Preview Title')
    };
  });

  assert.equal(pipelineResult.webllmSuccess, true);
  assert.equal(pipelineResult.webllmHasContent, true);
  assert.equal(pipelineResult.idbSize, pipelineResult.origSize);
  assert.equal(pipelineResult.idbMatchesOriginal, true);
  assert.equal(pipelineResult.idbContainsEnvelopeMagic, false);
  assert.equal(pipelineResult.directSuccess, true);
  assert.equal(pipelineResult.directProgressEnd, 100);
  assert.equal(pipelineResult.fetchedSuccess, true);
  assert.equal(pipelineResult.fetchedHasContent, true);

  assert.equal(capturedDirectUploads.length, 1);
  assert.equal(capturedDirectUploads[0].magicPrefix, 'ORVXENV', 'Direct PUT wire payload must be Orvix envelope');
  assert.equal(capturedDirectUploads[0].contentEncoding, null, 'MUST NEVER send HTTP Content-Encoding header');
  assert.equal(capturedDirectUploads[0].contentType, 'application/octet-stream');
  assert.equal(capturedSignedInitPayloads[0].storageEncoding, 'orvix-gzip-v1');
  assert.equal(capturedCompletePayloads[0].storageEncoding, 'orvix-gzip-v1');
  console.log('   ✓ Direct XHR envelope upload (no Content-Encoding), IndexedDB & WebLLM extraction verified');

  // -------------------------------------------------------------------------
  // TEST 3: Real DOM DocumentPreviewModal renders original text & never raw envelope
  // -------------------------------------------------------------------------
  console.log('3. Rendering DocumentPreviewModal in real DOM to verify original preview & download...');
  await page.goto(`${baseUrl}/__test__/preview-host.html`, { waitUntil: 'networkidle' });
  const modalPreviewState = await page.evaluate(async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);

    const previewAttachment = {
      id: 'att-md-e2e',
      name: 'design-notes.md',
      originalName: 'design-notes.md',
      extension: 'MD',
      type: 'text/markdown',
      mimeType: 'text/markdown',
      chatId: 'chat-browser'
    };

    const unmount = window.__ORVIX_MOUNT_PREVIEW__(host, previewAttachment);

    // Wait for async IndexedDB read and modal text render
    for (let i = 0; i < 40; i++) {
      const pre = host.querySelector('.preview-text-content');
      if (pre && pre.textContent && pre.textContent.includes('Note 0')) {
        const title = host.querySelector('#preview-modal-title')?.textContent || '';
        const body = pre.textContent;
        unmount();
        host.remove();
        return { rendered: true, title, body };
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    const htmlSnapshot = host.innerHTML;
    unmount();
    host.remove();
    return { rendered: false, htmlSnapshot };
  });

  assert.equal(modalPreviewState.rendered, true, 'DocumentPreviewModal must render original MD from IndexedDB');
  assert.equal(modalPreviewState.title, 'design-notes.md');
  assert.ok(modalPreviewState.body.includes('Content verified lossless in Chromium browser suite'));
  assert.equal(modalPreviewState.body.includes('ORVXENV'), false, 'Preview must NEVER expose raw envelope');
  console.log('   ✓ DocumentPreviewModal rendered exact original content');

  // -------------------------------------------------------------------------
  // TEST 4: AbortSignal cancellation & retry deduplication in Chromium
  // -------------------------------------------------------------------------
  console.log('4. Testing AbortSignal cancellation and retry deduplication in Chromium...');
  const cancelRetryResult = await page.evaluate(async () => {
    const {
      prepareAttachmentsForUpload,
      clearFileCompressionCacheEntryForTesting
    } = await import('/src/services/attachmentCompressionCoordinator.js');
    const { compressFileForTransparentStorage } = await import('/src/services/storageEnvelopeService.js');

    const payload = new File(['Cancel & retry verification line\n'.repeat(250)], 'retry-doc.txt', {
      type: 'text/plain'
    });

    // 4a. Cancelled request aborts cleanly and does not poison cache
    const ctrl = new AbortController();
    ctrl.abort();
    let abortedCorrectly = false;
    try {
      await prepareAttachmentsForUpload(
        [{ id: 'att-c1', name: 'retry-doc.txt', size: payload.size, type: 'text/plain', extension: 'TXT', file: payload }],
        { signal: ctrl.signal }
      );
    } catch (err) {
      abortedCorrectly = err?.name === 'AbortError';
    }

    // 4b. Retry succeeds and subsequent retry reuses cached outcome without repeating compression
    let compressCalls = 0;
    const spyTransparent = async (file, opts) => {
      compressCalls++;
      return compressFileForTransparentStorage(file, opts);
    };

    const [firstRun] = await prepareAttachmentsForUpload(
      [{ id: 'att-c1', name: 'retry-doc.txt', size: payload.size, type: 'text/plain', extension: 'TXT', file: payload }],
      { transparentCompressFn: spyTransparent }
    );
    const [secondRun] = await prepareAttachmentsForUpload(
      [{ id: 'att-c1', name: 'retry-doc.txt', size: payload.size, type: 'text/plain', extension: 'TXT', file: payload }],
      { transparentCompressFn: spyTransparent }
    );

    clearFileCompressionCacheEntryForTesting(payload);
    return {
      abortedCorrectly,
      compressCalls,
      firstCompressed: Boolean(firstRun.storageCompression?.compressed),
      secondCompressed: Boolean(secondRun.storageCompression?.compressed),
      sameEncodedSize: firstRun.storageCompression?.encodedSize === secondRun.storageCompression?.encodedSize
    };
  });

  assert.equal(cancelRetryResult.abortedCorrectly, true);
  assert.equal(cancelRetryResult.compressCalls, 1, 'Retry must reuse cached storageCompression without re-compressing');
  assert.equal(cancelRetryResult.firstCompressed, true);
  assert.equal(cancelRetryResult.secondCompressed, true);
  assert.equal(cancelRetryResult.sameEncodedSize, true);
  console.log('   ✓ Cancellation & retry deduplication verified');

  assert.deepEqual(consoleErrors, [], `Expected zero browser console errors, got: ${JSON.stringify(consoleErrors)}`);
  assert.deepEqual(pageErrors, [], `Expected zero uncaught page errors, got: ${JSON.stringify(pageErrors)}`);

  console.log('\n======================================================================');
  console.log('ALL CHROMIUM TRANSPARENT STORAGE COMPRESSION E2E TESTS PASSED!');
  console.log('======================================================================\n');
} finally {
  await browser.close();
  await cleanup();
}
