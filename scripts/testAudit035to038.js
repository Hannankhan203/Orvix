/**
 * Focused Regression Test Suite for:
 * - ORVIX-AUD-035: ImageAttachmentCard Authentication & Effect Dependencies
 * - ORVIX-AUD-036: React Rules of Hooks in AttachmentCard & ImageAttachmentCard
 * - ORVIX-AUD-037: Clipboard HTML Link Security in clipboardFormatter.js
 * - ORVIX-AUD-038: Semantic Document Indexing in semanticRetrievalService.js
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import esbuild from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  inlineMarkdownToHtml,
  formatMessageForClipboard,
  sanitizeClipboardUrl
} from '../src/utils/clipboardFormatter.js';
import {
  indexDocument,
  searchSemanticChunks
} from '../src/services/semanticRetrievalService.js';
import {
  clearAllChunks,
  getChunksForDocuments,
  getChunksForConversation,
  resetVectorDBForTesting
} from '../src/services/semanticVectorStorage.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`  PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL: ${name}`);
    console.error(`    ${err.stack || err.message}`);
    failed++;
  }
}

console.log('======================================================================');
console.log('Orvix Regression Suite: ORVIX-AUD-035 through ORVIX-AUD-038');
console.log('======================================================================\n');

// ---------------------------------------------------------------------------
// Helper: Load JSX component with mocked attachmentStorageService & hook spy
// ---------------------------------------------------------------------------
async function loadComponentWithMockStorage(entryRelPath, storageMockSource) {
  const result = await esbuild.build({
    entryPoints: [path.resolve(ROOT_DIR, entryRelPath)],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'lucide-react'],
    plugins: [
      {
        name: 'mock-storage-and-modal',
        setup(build) {
          build.onResolve({ filter: /attachmentStorageService\.js$/ }, () => ({
            path: 'mock-storage',
            namespace: 'mock-storage'
          }));
          build.onLoad({ filter: /.*/, namespace: 'mock-storage' }, () => ({
            contents: storageMockSource,
            loader: 'js'
          }));
          build.onResolve({ filter: /DocumentPreviewModal\.jsx$/ }, () => ({
            path: 'mock-modal',
            namespace: 'mock-modal'
          }));
          build.onLoad({ filter: /.*/, namespace: 'mock-modal' }, () => ({
            contents: 'export default function DocumentPreviewModal() { return null; }',
            loader: 'js'
          }));
        }
      }
    ]
  });

  const code = result.outputFiles[0].text;
  const tmpFile = path.join(
    __dirname,
    `.tmp-audit-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`
  );
  fs.writeFileSync(tmpFile, code, 'utf8');
  try {
    return await import(pathToFileURL(tmpFile).href);
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch (_) {}
  }
}

/**
 * Minimal React hook-dispatcher harness to execute function components across
 * multiple renders, inspect hook order/count consistency, and run useEffect callbacks.
 */
function createHookHarness(Component) {
  const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const states = [];
  const effects = [];
  const hookLog = [];
  let hookSequences = [];

  function depsChanged(prevDeps, nextDeps) {
    if (!prevDeps || !nextDeps) return true;
    if (prevDeps.length !== nextDeps.length) return true;
    for (let i = 0; i < prevDeps.length; i++) {
      if (!Object.is(prevDeps[i], nextDeps[i])) return true;
    }
    return false;
  }

  function render(props) {
    let cursor = 0;
    const currentSequence = [];
    const pendingEffects = [];
    const prevDispatcher = internals.H;

    internals.H = {
      useState(initial) {
        const idx = cursor++;
        currentSequence.push('useState');
        if (!(idx in states)) {
          states[idx] = typeof initial === 'function' ? initial() : initial;
        }
        const setter = (next) => {
          states[idx] = typeof next === 'function' ? next(states[idx]) : next;
        };
        return [states[idx], setter];
      },
      useEffect(create, deps) {
        const idx = cursor++;
        currentSequence.push('useEffect');
        const prev = effects[idx];
        const shouldRun = !prev || depsChanged(prev.deps, deps);
        effects[idx] = { create, deps, cleanup: prev?.cleanup, shouldRun };
        if (shouldRun) {
          pendingEffects.push(idx);
        }
      },
      useRef(initial) {
        const idx = cursor++;
        currentSequence.push('useRef');
        if (!(idx in states)) states[idx] = { current: initial };
        return states[idx];
      },
      useMemo(fn) {
        cursor++;
        currentSequence.push('useMemo');
        return fn();
      },
      useCallback(fn) {
        cursor++;
        currentSequence.push('useCallback');
        return fn;
      }
    };

    let output;
    try {
      output = Component(props);
    } finally {
      internals.H = prevDispatcher;
    }

    hookSequences.push(currentSequence);
    hookLog.push(pendingEffects.slice());

    for (const idx of pendingEffects) {
      if (typeof effects[idx].cleanup === 'function') {
        effects[idx].cleanup();
      }
      const cleanup = effects[idx].create();
      effects[idx].cleanup = typeof cleanup === 'function' ? cleanup : null;
    }

    return { output, ranEffects: pendingEffects, sequence: currentSequence };
  }

  function getStates() {
    return states;
  }

  function getHookSequences() {
    return hookSequences;
  }

  function unmount() {
    for (const eff of effects) {
      if (eff && typeof eff.cleanup === 'function') {
        eff.cleanup();
      }
    }
  }

  return { render, getStates, getHookSequences, unmount };
}

// ===========================================================================
// 1. ORVIX-AUD-035: ImageAttachmentCard Authentication & Effect Dependencies
// ===========================================================================
console.log('--- 1. ORVIX-AUD-035: ImageAttachmentCard Authentication ---');

await runTest('1.1 Source removes unauthenticated /api/upload/:id/file fallback', () => {
  const src = fs.readFileSync(path.resolve(ROOT_DIR, 'src/components/chat/ImageAttachmentCard.jsx'), 'utf-8');
  assert.equal(src.includes('setImageSrc(`/api/upload/'), false, 'Must not set unauthenticated /api/upload image src');
  assert.ok(src.includes('fetchAttachmentBlob(attachment, effectiveChatId)'), 'Must retrieve via authenticated fetchAttachmentBlob');
});

await runTest('1.2 Transient 500/503/network/thrown errors do NOT fall back to unauthenticated /api/upload URL', async () => {
  const originalFetch = globalThis.fetch;
  const originalCreateObjectURL = globalThis.URL.createObjectURL;
  const originalRevokeObjectURL = globalThis.URL.revokeObjectURL;

  const fetchCalls = [];
  globalThis.fetch = async (url) => {
    fetchCalls.push(url);
    throw new Error('Unexpected direct fetch');
  };
  globalThis.URL.createObjectURL = () => 'blob:mock-object-url';
  globalThis.URL.revokeObjectURL = () => {};

  const mockStorageSource = `
    export let mockFetchResult = { success: false, status: 503, error: 'Service unavailable' };
    export let mockThrow = false;
    export let fetchCallCount = 0;
    export function setMockMode(res, shouldThrow = false) {
      mockFetchResult = res;
      mockThrow = shouldThrow;
    }
    export function resetFetchCallCount() { fetchCallCount = 0; }
    export async function getAttachmentRecord() { return null; }
    export function isAttachmentOwnedByCurrentUser() { return true; }
    export async function fetchAttachmentBlob() {
      fetchCallCount++;
      if (mockThrow) throw new Error('Network crashed');
      return mockFetchResult;
    }
    export async function downloadAttachmentFile() { return { success: true }; }
  `;

  try {
    const mod = await loadComponentWithMockStorage('src/components/chat/ImageAttachmentCard.jsx', mockStorageSource);
    const ImageAttachmentCard = mod.default;

    // 503 transient failure
    const harness = createHookHarness(ImageAttachmentCard);
    harness.render({
      attachment: { id: 'img-503', name: 'photo.png', type: 'image/png', chatId: 'chat-1' }
    });
    await new Promise((r) => setTimeout(r, 15));

    const states503 = harness.getStates();
    assert.equal(states503[0], null, 'imageSrc must remain null (never /api/upload/:id/file) on 503');
    assert.equal(states503[1], false, 'loading must transition to false');
    assert.equal(states503[2], true, 'hasError must be true on 503 failure');
    assert.equal(fetchCalls.length, 0, 'Must not make unauthenticated direct fetch');
    harness.unmount();

    // Thrown exception
    const mockStorage = await esbuild.build({
      stdin: { contents: 'export {};', loader: 'js' },
      write: false
    });
    void mockStorage;
    // Test 500 + thrown exception using a fresh component load
    const modThrow = await loadComponentWithMockStorage(
      'src/components/chat/ImageAttachmentCard.jsx',
      mockStorageSource.replace(
        "export let mockThrow = false;",
        "export let mockThrow = true;"
      )
    );
    const harnessThrow = createHookHarness(modThrow.default);
    harnessThrow.render({
      attachment: { id: 'img-throw', name: 'photo.png', type: 'image/png', chatId: 'chat-1' }
    });
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(harnessThrow.getStates()[0], null, 'imageSrc must be null on thrown error');
    assert.equal(harnessThrow.getStates()[1], false, 'loading must be false on thrown error');
    assert.equal(harnessThrow.getStates()[2], true, 'hasError must be true on thrown error');
    harnessThrow.unmount();

    // Success flow creates blob: URL
    const modOk = await loadComponentWithMockStorage(
      'src/components/chat/ImageAttachmentCard.jsx',
      mockStorageSource.replace(
        "export let mockFetchResult = { success: false, status: 503, error: 'Service unavailable' };",
        "export let mockFetchResult = { success: true, blob: new Blob(['ok'], { type: 'image/png' }), source: 'server' };"
      )
    );
    const harnessOk = createHookHarness(modOk.default);
    harnessOk.render({
      attachment: { id: 'img-ok', name: 'photo.png', type: 'image/png', chatId: 'chat-1' }
    });
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(harnessOk.getStates()[0], 'blob:mock-object-url', 'Successful authenticated fetch must set blob URL');
    assert.equal(harnessOk.getStates()[1], false, 'loading must be false on success');
    assert.equal(harnessOk.getStates()[2], false, 'hasError must be false on success');

    // Re-rendering with a new wrapper object (like ChatMessage does) with identical values must NOT re-run effect
    const r2 = harnessOk.render({
      attachment: { id: 'img-ok', name: 'photo.png', type: 'image/png', chatId: 'chat-1' }
    });
    assert.equal(r2.ranEffects.length, 0, 'Wrapper object re-render with same values must NOT trigger extra requests');

    // Changing chatId MUST re-run the resolve effect
    const r3 = harnessOk.render({
      attachment: { id: 'img-ok', name: 'photo.png', type: 'image/png', chatId: 'chat-2' }
    });
    assert.equal(r3.ranEffects.length, 1, 'Changing chatId must re-run resolve effect');
    await new Promise((r) => setTimeout(r, 15));
    harnessOk.unmount();
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.URL.createObjectURL = originalCreateObjectURL;
    globalThis.URL.revokeObjectURL = originalRevokeObjectURL;
  }
});

// ===========================================================================
// 2. ORVIX-AUD-036: React Rules of Hooks Consistency
// ===========================================================================
console.log('\n--- 2. ORVIX-AUD-036: React Rules of Hooks ---');

await runTest('2.1 ImageAttachmentCard executes identical hook order across null -> valid -> error -> null transitions', async () => {
  const mockStorageSource = `
    export async function getAttachmentRecord() { return null; }
    export function isAttachmentOwnedByCurrentUser() { return true; }
    export async function fetchAttachmentBlob() { return { success: false, status: 404 }; }
    export async function downloadAttachmentFile() { return { success: true }; }
  `;
  const mod = await loadComponentWithMockStorage('src/components/chat/ImageAttachmentCard.jsx', mockStorageSource);
  const ImageAttachmentCard = mod.default;

  const harness = createHookHarness(ImageAttachmentCard);
  const resNull1 = harness.render({ attachment: null });
  assert.equal(resNull1.output, null, 'Null attachment must render null');

  const resValid = harness.render({
    attachment: { id: 'img-1', name: 'pic.png', type: 'image/png', previewUrl: 'data:image/png;base64,AA==' }
  });
  assert.ok(resValid.output !== null, 'Valid attachment must render JSX');

  const resError = harness.render({
    attachment: { name: 'missing-id.png', type: 'image/png' }
  });
  assert.ok(resError.output !== null, 'Attachment without id must render fallback JSX');

  const resNull2 = harness.render({ attachment: undefined });
  assert.equal(resNull2.output, null, 'Undefined attachment must render null');

  const seqs = harness.getHookSequences();
  for (let i = 1; i < seqs.length; i++) {
    assert.deepEqual(seqs[i], seqs[0], `Hook sequence on render ${i} must exactly match render 0`);
  }
  harness.unmount();

  // Also verify SSR renderToStaticMarkup works cleanly for both null and valid attachment
  assert.equal(renderToStaticMarkup(React.createElement(ImageAttachmentCard, { attachment: null })), '');
  const html = renderToStaticMarkup(
    React.createElement(ImageAttachmentCard, {
      attachment: { id: 'ssr-img', name: 'chart.png', type: 'image/png', size: 1024 }
    })
  );
  assert.ok(html.includes('chart.png'));
});

await runTest('2.2 AttachmentCard executes identical hook order across null -> valid -> unavailable -> null transitions', async () => {
  const mockStorageSource = `
    export function isFormatPreviewable() { return true; }
    export async function openOrPreviewAttachment() { return { success: true }; }
    export async function downloadAttachmentFile() { return { success: true }; }
    export async function checkAttachmentStatus(att) {
      return att?.id === 'doc-missing' ? { available: false } : { available: true, source: 'memory' };
    }
  `;
  const mod = await loadComponentWithMockStorage('src/components/chat/AttachmentCard.jsx', mockStorageSource);
  const AttachmentCard = mod.default;

  const harness = createHookHarness(AttachmentCard);
  const r1 = harness.render({ attachment: null });
  assert.equal(r1.output, null);

  const r2 = harness.render({
    attachment: { id: 'doc-1', name: 'report.pdf', size: 2048 }
  });
  assert.ok(r2.output !== null);

  const r3 = harness.render({
    attachment: { id: 'doc-missing', name: 'expired.pdf', size: 2048 }
  });
  assert.ok(r3.output !== null);
  await new Promise((r) => setTimeout(r, 15));

  const r4 = harness.render({ attachment: null });
  assert.equal(r4.output, null);

  const seqs = harness.getHookSequences();
  for (let i = 1; i < seqs.length; i++) {
    assert.deepEqual(seqs[i], seqs[0], `AttachmentCard hook sequence on render ${i} must match render 0`);
  }
  harness.unmount();

  assert.equal(renderToStaticMarkup(React.createElement(AttachmentCard, { attachment: null })), '');
  const html = renderToStaticMarkup(
    React.createElement(AttachmentCard, {
      attachment: { id: 'ssr-doc', name: 'notes.pdf', size: 512 }
    })
  );
  assert.ok(html.includes('notes.pdf'));
});

// ===========================================================================
// 3. ORVIX-AUD-037: Clipboard HTML Link Security
// ===========================================================================
console.log('\n--- 3. ORVIX-AUD-037: Clipboard HTML Link Security ---');

await runTest('3.1 Rejects dangerous and obfuscated URI schemes in sanitizeClipboardUrl & HTML output', () => {
  const dangerousLinks = [
    '[xss](javascript:alert(1))',
    '[xss](JAVASCRIPT:alert(document.cookie))',
    '[xss](   javascript:alert(1)   )',
    '[xss](java\tscript:alert(1))',
    '[xss](java\nscript:alert(1))',
    '[xss](\x00javascript:alert(1))',
    '[xss](&#106;avascript:alert(1))',
    '[xss](&#x6a;avascript:alert(1))',
    '[xss](javascript&colon;alert(1))',
    '[xss](data:text/html,<script>alert(1)</script>)',
    '[xss](DATA:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
    '[xss](vbscript:msgbox(1))',
    '[xss](file:///etc/passwd)',
    '[xss](blob:https://example.com/1234)',
    '[xss](http:alert(1))',
    '[xss](//evil.example/phish)',
    '[xss](/\\evil.example/phish)'
  ];

  for (const md of dangerousLinks) {
    const html = inlineMarkdownToHtml(md);
    assert.equal(html.includes('<a '), false, `Dangerous link must NOT produce <a> tag: ${md} -> ${html}`);
    assert.equal(html.includes('href='), false, `Dangerous link must NOT produce href=: ${md} -> ${html}`);
    assert.ok(html.includes('xss'), `Link label text must still be preserved safely: ${md}`);

    const formatted = formatMessageForClipboard(md);
    assert.equal(formatted.htmlText.includes('<a '), false, `formatMessageForClipboard must reject: ${md}`);
    assert.equal(/href\s*=\s*["']\s*(javascript|data|vbscript|file|blob):/i.test(formatted.htmlText), false);
  }
});

await runTest('3.2 Preserves safe HTTP, HTTPS, and appropriate relative links', () => {
  const safeCases = [
    { md: '[Docs](https://example.com/docs?a=1&b=2#sec)', expectedHref: 'https://example.com/docs?a=1&amp;b=2#sec' },
    { md: '[Local](http://localhost:3000/api/health)', expectedHref: 'http://localhost:3000/api/health' },
    { md: '[Underscore](https://example.com/my_file_name.pdf)', expectedHref: 'https://example.com/my_file_name.pdf' },
    { md: '[RootRel](/guide/getting-started#step1)', expectedHref: '/guide/getting-started#step1' },
    { md: '[DotRel](./chapter-1.md)', expectedHref: './chapter-1.md' },
    { md: '[ParentRel](../README.md)', expectedHref: '../README.md' },
    { md: '[Anchor](#summary)', expectedHref: '#summary' },
    { md: '[Query](?tab=overview)', expectedHref: '?tab=overview' },
    { md: '[Bare](docs/guide.md)', expectedHref: 'docs/guide.md' }
  ];

  for (const { md, expectedHref } of safeCases) {
    const html = inlineMarkdownToHtml(md);
    assert.ok(
      html.includes(`<a href="${expectedHref}"`),
      `Expected safe link ${md} to preserve href="${expectedHref}", got: ${html}`
    );
  }

  // Inline code containing a markdown link must not be expanded into an <a> tag
  const codeHtml = inlineMarkdownToHtml('`[safe](javascript:alert(1))`');
  assert.equal(codeHtml.includes('<a '), false);
  assert.ok(codeHtml.includes('<code '));

  // Table cells containing dangerous links must also strip dangerous hrefs while keeping safe ones
  const tableMd = [
    '| Name | Link |',
    '| --- | --- |',
    '| Bad | [Click](javascript:alert(1)) |',
    '| Good | [Open](https://example.com/report) |'
  ].join('\n');
  const tableClipboard = formatMessageForClipboard(tableMd);
  assert.equal(tableClipboard.containsTable, true);
  assert.equal(tableClipboard.htmlText.includes('javascript:'), false);
  assert.ok(tableClipboard.htmlText.includes('href="https://example.com/report"'));
  assert.equal(sanitizeClipboardUrl('javascript:alert(1)'), null);
  assert.equal(sanitizeClipboardUrl('https://example.com'), 'https://example.com');
});

// ===========================================================================
// 4. ORVIX-AUD-038: Semantic Document Indexing
// ===========================================================================
console.log('\n--- 4. ORVIX-AUD-038: Semantic Document Indexing ---');

await runTest('4.1 searchSemanticChunks indexes new inMemoryDocs when candidateChunks already exist without duplication', async () => {
  resetVectorDBForTesting();
  await clearAllChunks();

  const existingDoc = {
    id: 'aud038-doc-1',
    originalName: 'billing.txt',
    format: 'TXT',
    text: 'Enterprise billing cycles run monthly with net-30 invoice payment terms.'
  };
  const newDoc = {
    id: 'aud038-doc-2',
    originalName: 'deployment.txt',
    format: 'TXT',
    text: 'Blue-green deployment swaps production traffic between identical staging clusters.'
  };

  await indexDocument(existingDoc, 'conv-038');

  const results = await searchSemanticChunks({
    query: 'How does blue-green deployment swap traffic between clusters?',
    docIds: ['aud038-doc-1', 'aud038-doc-2'],
    conversationId: 'conv-038',
    inMemoryDocs: [existingDoc, newDoc, newDoc],
    topK: 3
  });

  assert.ok(results.length >= 1, 'Must return chunks from newly indexed inMemoryDoc');
  assert.strictEqual(results[0].docId, 'aud038-doc-2');
  assert.ok(results[0].text.includes('Blue-green deployment'));

  const chunks1 = await getChunksForDocuments(['aud038-doc-1']);
  const chunks2 = await getChunksForDocuments(['aud038-doc-2']);
  const convChunks = await getChunksForConversation('conv-038');
  assert.strictEqual(chunks1.length, 1);
  assert.strictEqual(chunks2.length, 1);
  assert.strictEqual(convChunks.length, 2, 'Must not duplicate chunks in store');
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log('\n======================================================================');
console.log(`Audit 035-038 Regression Summary: ${passed} passed, ${failed} failed.`);
console.log('======================================================================');

if (failed > 0) {
  process.exit(1);
}
