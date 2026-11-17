import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer as createViteServer } from 'vite';

import {
  splitMarkdownIntoStreamingBlocks,
  usesReferenceOrFootnoteDefs
} from '../src/components/chat/markdownStreamingUtils.js';

test('ORVIX-OPT-03 splitMarkdownIntoStreamingBlocks: preserves fenced code blocks, display math, lists, blockquotes, and trailing blanks', () => {
  // 1. Fenced code block containing internal blank lines must stay unified
  const withCode = [
    '# Overview',
    '',
    '```typescript',
    'function greet(name: string) {',
    '',
    '  return `Hello ${name}`;',
    '}',
    '```',
    '',
    'Done.'
  ].join('\n');

  const codeBlocks = splitMarkdownIntoStreamingBlocks(withCode);
  assert.equal(codeBlocks.length, 3);
  assert.equal(codeBlocks[0], '# Overview');
  assert.ok(codeBlocks[1].includes('function greet') && codeBlocks[1].includes('\n\n  return'));
  assert.equal(codeBlocks[2], 'Done.');

  // 2. Display math $$...$$ containing blank lines must not split mid-formula
  const withMath = [
    'Equation:',
    '',
    '$$',
    'a = b + c',
    '',
    'x = y + z',
    '$$',
    '',
    'End.'
  ].join('\n');

  const mathBlocks = splitMarkdownIntoStreamingBlocks(withMath);
  assert.equal(mathBlocks.length, 3);
  assert.ok(mathBlocks[1].startsWith('$$') && mathBlocks[1].endsWith('$$'));

  // 3. Loose ordered lists & nested continuations must stay together so <ol> numbering stays continuous
  const withLooseList = [
    '1. First item',
    '',
    '   Continued paragraph in first item',
    '',
    '2. Second item',
    '',
    '3. Third item',
    '',
    'Trailing paragraph.'
  ].join('\n');

  const listBlocks = splitMarkdownIntoStreamingBlocks(withLooseList);
  assert.equal(listBlocks.length, 2);
  assert.ok(listBlocks[0].includes('1. First item') && listBlocks[0].includes('3. Third item'));
  assert.equal(listBlocks[1], 'Trailing paragraph.');

  // 4. Multi-paragraph blockquotes must stay together
  const withQuote = [
    '> [!NOTE] Study Tip',
    '> First sentence.',
    '>',
    '> Second paragraph inside same callout.',
    '',
    'Next section.'
  ].join('\n');
  const quoteBlocks = splitMarkdownIntoStreamingBlocks(withQuote);
  assert.equal(quoteBlocks.length, 2);
  assert.ok(quoteBlocks[0].includes('> Second paragraph inside same callout.'));

  // 5. Trailing blank lines at EOF while streaming must stay attached until next non-blank line arrives
  const partialList = '1. First step\n\n';
  const partialBlocks = splitMarkdownIntoStreamingBlocks(partialList);
  assert.equal(partialBlocks.length, 1);
  assert.equal(partialBlocks[0], partialList);
});

test('ORVIX-OPT-03 monotonic prefix stability during token-by-token streaming', () => {
  const fullResponse = [
    '## Architecture Guide',
    '',
    'Paragraph one introduces the system cleanly.',
    '',
    '| Component | Role | Status |',
    '|---|---|---|',
    '| Router | Stream AI tokens | Active |',
    '| Cache | Deduplicate blocks | Active |',
    '',
    '```js',
    'export const ok = true;',
    '```',
    '',
    'Final summary paragraph.'
  ].join('\n');

  const firstSplitChunks = [];
  let prevPrefixBlocks: string[] = [];

  for (let i = 10; i <= fullResponse.length; i += 9) {
    const partial = fullResponse.slice(0, i);
    const currentBlocks = splitMarkdownIntoStreamingBlocks(partial);
    const completedPrefix = currentBlocks.slice(0, -1);

    // Every already-completed block at index < completedPrefix.length - 1 must remain byte-for-byte stable
    for (let j = 0; j < prevPrefixBlocks.length; j++) {
      assert.equal(
        completedPrefix[j],
        prevPrefixBlocks[j],
        `Completed block #${j} mutated unexpectedly at slice ${i}`
      );
    }

    prevPrefixBlocks = completedPrefix;
    firstSplitChunks.push(currentBlocks.length);
  }

  const finalBlocks = splitMarkdownIntoStreamingBlocks(fullResponse);
  assert.equal(finalBlocks.length, 5);
  assert.ok(Math.max(...firstSplitChunks) === 5);
});

test('ORVIX-OPT-03 reference links and footnotes detection switches safely to unified final parse', () => {
  assert.equal(usesReferenceOrFootnoteDefs('Plain **markdown** without refs.'), false);
  assert.equal(usesReferenceOrFootnoteDefs('Read [the docs][docs-ref].\n\n[docs-ref]: https://example.com'), true);
  assert.equal(usesReferenceOrFootnoteDefs('Claim with footnote[^1].\n\n[^1]: Source note.'), true);
});

test('ORVIX-OPT-03 MarkdownContent SSR equivalence & incremental streaming performance benchmark', async () => {
  const vite = await createViteServer({
    server: { middlewareMode: true, hmr: false },
    appType: 'custom',
    logLevel: 'silent'
  });

  try {
    const mdModule = await vite.ssrLoadModule('/src/components/chat/MarkdownContent.jsx');
    const MarkdownContent = mdModule.default;
    const {
      preprocessMathMarkdown,
      createMarkdownComponents
    } = mdModule;
    const { default: ReactMarkdown } = await import('react-markdown');
    const { default: remarkGfm } = await import('remark-gfm');

    const richMarkdown = [
      '# Comprehensive Engineering Review',
      '',
      'Here is a **bold** summary with [an external link](https://example.com) and inline `code()`.',
      '',
      '| Metric | Value | Notes |',
      '|---|---|---|',
      '| Latency | 18 ms | P95 |',
      '| Cost | $50/mo | Fixed |',
      '',
      '```javascript',
      'function fibonacci(n) {',
      '  if (n <= 1) return n;',
      '  return fibonacci(n - 1) + fibonacci(n - 2);',
      '}',
      '```',
      '',
      '1. Step one description',
      '',
      '2. Step two description',
      '',
      '> [!TIP] Remember to profile before optimizing.',
      '',
      'Done!'
    ].join('\n');

    // Verify rendered HTML parity across modes between split MarkdownContent and monolithic ReactMarkdown
    for (const mode of ['general', 'coding', 'learning', 'writing'] as const) {
      const splitHtml = renderToStaticMarkup(
        React.createElement(MarkdownContent, {
          content: richMarkdown,
          isStreaming: false,
          effectiveMode: mode
        })
      );
      const monolithicHtml = renderToStaticMarkup(
        React.createElement(
          ReactMarkdown,
          {
            remarkPlugins: [remarkGfm],
            components: createMarkdownComponents(false, mode)
          },
          preprocessMathMarkdown(richMarkdown, { isStreaming: false })
        )
      );
      assert.equal(
        splitHtml.replace(/>\n</g, '><'),
        monolithicHtml.replace(/>\n</g, '><'),
        `Rendered HTML output in ${mode} mode must match monolithic ReactMarkdown output`
      );
    }

    // Verify reference-link document resolves links cleanly via unified completed pass
    const refLinkDoc = 'See [Orvix Architecture][arch] for details.\n\n[arch]: https://orvix.example/arch';
    const refHtml = renderToStaticMarkup(
      React.createElement(MarkdownContent, {
        content: refLinkDoc,
        isStreaming: false,
        effectiveMode: 'general'
      })
    );
    assert.ok(refHtml.includes('href="https://orvix.example/arch"'), 'Reference links must resolve accurately');

    // Long response streaming benchmark: simulate 80 streaming updates on a ~22KB response
    const repeatedSection = (idx: number) =>
      [
        `### Section ${idx}`,
        '',
        `Detailed technical explanation paragraph ${idx} discussing algorithms, caches, and rendering pipelines.`,
        '',
        '| Field | Value |',
        '|---|---|',
        `| Step | ${idx} |`,
        '',
        '```js',
        `export const step${idx} = (x) => x + ${idx};`,
        '```'
      ].join('\n');

    const longSections = Array.from({ length: 80 }, (_, i) => repeatedSection(i + 1));
    const longDoc = longSections.join('\n\n');
    assert.ok(longDoc.length > 15_000);

    // Measure monolithic full-document re-preprocess + re-render over 40 incremental chunks
    const monoStart = performance.now();
    for (let k = 1; k <= longSections.length; k++) {
      const partial = longSections.slice(0, k).join('\n\n');
      renderToStaticMarkup(
        React.createElement(
          ReactMarkdown,
          {
            remarkPlugins: [remarkGfm],
            components: createMarkdownComponents(true, 'coding')
          },
          preprocessMathMarkdown(partial, { isStreaming: true })
        )
      );
    }
    const monoDurationMs = performance.now() - monoStart;

    // Measure block-cached incremental rendering (simulating React.memo skipping unchanged prefix blocks)
    const blockCache = new Map<string, string>();
    const optStart = performance.now();
    for (let k = 1; k <= longSections.length; k++) {
      const partial = longSections.slice(0, k).join('\n\n');
      const blocks = splitMarkdownIntoStreamingBlocks(partial);
      const lastIdx = blocks.length - 1;
      for (let b = 0; b < blocks.length; b++) {
        const isBlockStreaming = b === lastIdx;
        const cacheKey = `${isBlockStreaming ? 'S' : 'F'}:${blocks[b]}`;
        if (!blockCache.has(cacheKey)) {
          const rendered = renderToStaticMarkup(
            React.createElement(
              ReactMarkdown,
              {
                remarkPlugins: [remarkGfm],
                components: createMarkdownComponents(isBlockStreaming, 'coding')
              },
              preprocessMathMarkdown(blocks[b], { isStreaming: isBlockStreaming })
            )
          );
          if (!isBlockStreaming) {
            blockCache.set(cacheKey, rendered);
          }
        }
      }
    }
    const optDurationMs = performance.now() - optStart;

    assert.ok(
      optDurationMs < monoDurationMs * 0.5,
      `Expected block-memoized streaming (${optDurationMs.toFixed(1)}ms) to be >2x faster than monolithic re-parse (${monoDurationMs.toFixed(1)}ms)`
    );
  } finally {
    await vite.close();
  }
});
