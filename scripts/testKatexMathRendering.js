/**
 * scripts/testKatexMathRendering.js
 * Comprehensive verification suite for KaTeX mathematical expression rendering in Orvix.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import MarkdownContent, { preprocessMathMarkdown } from '../src/components/chat/MarkdownContent.jsx';

console.log('\n===============================================================');
console.log('ORVIX KaTeX MATHEMATICAL RENDERING VERIFICATION SUITE');
console.log('===============================================================\n');

let passedTests = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  ✗ FAIL: ${name}`);
    console.error(err);
    process.exit(1);
  }
}

function renderMd(content, { isStreaming = false, effectiveMode = 'general' } = {}) {
  return renderToStaticMarkup(
    React.createElement(MarkdownContent, { content, isStreaming, effectiveMode })
  );
}

// ----------------------------------------------------------------------------
// 1. Inline and Block Math Expressions
// ----------------------------------------------------------------------------
test('renders inline $...$ and \\(...\\) expressions with KaTeX', () => {
  const html1 = renderMd('The famous equation is $E = mc^2$ in physics.');
  assert.match(html1, /class="katex"/);
  assert.doesNotMatch(html1, /class="katex-display"/);
  assert.match(html1, /<math/);

  const html2 = renderMd('Also written as \\(a^2 + b^2 = c^2\\) inline.');
  assert.match(html2, /class="katex"/);
  assert.doesNotMatch(html2, /class="katex-display"/);
  assert.match(html2, /<math/);
});

test('renders block $$...$$ (single-line and multiline) and \\[...\\] as display math', () => {
  const multiline = renderMd('$$\n\\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}\n$$');
  assert.match(multiline, /class="katex-display"/);
  assert.match(multiline, /class="katex"/);

  const singleLine = renderMd('$$x = \\frac{-b}{2a}$$');
  assert.match(singleLine, /class="katex-display"/);

  const bracketBlock = renderMd('Result:\n\\[\n\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}\n\\]\nDone.');
  assert.match(bracketBlock, /class="katex-display"/);
  assert.match(bracketBlock, /Done\./);
});

test('renders fractions, powers, subscripts, square roots, matrices, summations, and integrals', () => {
  const expressions = [
    '$\\frac{3}{4} + x^{n+1} - a_{i,j}$',
    '$\\sqrt{b^2 - 4ac}$',
    '$$\nA = \\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}\n$$',
    '$$\n\\sum_{k=1}^{\\infty} \\frac{1}{k^2} = \\frac{\\pi^2}{6}\n$$',
    '$$\n\\int_{0}^{\\infty} e^{-x^2} \\, dx = \\frac{\\sqrt{\\pi}}{2}\n$$'
  ];

  for (const expr of expressions) {
    const html = renderMd(expr);
    assert.match(html, /class="katex"/, `Expected KaTeX markup for ${expr}`);
    assert.doesNotMatch(html, /class="katex-error"/, `Did not expect KaTeX error for ${expr}`);
  }
});

// ----------------------------------------------------------------------------
// 2. Code Blocks & Inline Code Preservation
// ----------------------------------------------------------------------------
test('preserves fenced code blocks and inline code without rendering them as KaTeX', () => {
  const md = [
    'Use inline `$x^2$` or `\\(a + b\\)` in source.',
    '',
    '```javascript',
    'const price = "$5 + $10";',
    'const tex = "$$x^2 + y^2$$";',
    '```',
    '',
    '```latex',
    '\\frac{1}{2}',
    '```',
    '',
    '```python',
    'y = "\\\\(a_1 + a_2\\\\)"',
    '```'
  ].join('\n');

  const preprocessed = preprocessMathMarkdown(md);
  assert.match(preprocessed, /`\$x\^2\$`/);
  assert.match(preprocessed, /const tex = "\$\$x\^2 \+ y\^2\$\$";/);

  const html = renderMd(md);
  assert.doesNotMatch(html, /class="katex"/, 'Code samples must not become KaTeX nodes');
  assert.match(html, /code-block-container/);
  assert.match(html, /class="inline-code[^"]*"/);
});

// ----------------------------------------------------------------------------
// 3. Currency Preservation vs Numeric Math
// ----------------------------------------------------------------------------
test('preserves ordinary currency values ($5, $10, ranges, commas, suffixes) as literal text', () => {
  const currencyCases = [
    'The plan costs $5 per month or $10 per year.',
    'Prices range from $5.00 to $10.50.',
    'Budget is $1,200 or up to $5M.',
    'Total: $5.00 + $10.00 = $15.00.',
    'Item A is $5, and Item B is $10.',
    'We spent $5 yesterday.'
  ];

  for (const sample of currencyCases) {
    const html = renderMd(sample);
    assert.doesNotMatch(html, /class="katex"/, `Currency should not trigger KaTeX: "${sample}"`);
    assert.doesNotMatch(html, /\\\$/, `Backslash escape must not leak into rendered text: "${sample}"`);
  }
});

test('allows real math alongside currency and numeric math expressions', () => {
  const mixed = renderMd('The ticket costs $5, while the formula is $x = 2$ and $10^{-5}$ and $2x$ and $5 + 3 = 8$.');
  const katexMatches = mixed.match(/class="katex"/g) || [];
  assert.equal(katexMatches.length, 4, `Expected 4 inline math nodes, got ${katexMatches.length}`);
  assert.match(mixed, /costs \$5, while/);
});

// ----------------------------------------------------------------------------
// 4. Streaming & Invalid LaTeX Resilience
// ----------------------------------------------------------------------------
test('handles incomplete math delimiters during streaming cleanly and renders once completed', () => {
  const partials = [
    'Computing:\n\n$$\n\\frac{a}{',
    'Let $x_1 + ',
    'Consider \\(\\sqrt{x',
    'Display:\n\\[\n\\int_0^1'
  ];

  for (const partial of partials) {
    const html = renderMd(partial, { isStreaming: true });
    assert.ok(html.length > 0, `Partial streaming chunk must render without throwing: ${partial}`);
    assert.doesNotMatch(html, /class="katex-error"/, `Incomplete chunk should not emit katex-error: ${partial}`);
  }

  const completed = renderMd('Computing:\n\n$$\n\\frac{a}{b}\n$$', { isStreaming: false });
  assert.match(completed, /class="katex-display"/);
  assert.doesNotMatch(completed, /class="katex-error"/);
});

test('handles invalid LaTeX gracefully with throwOnError: false without crashing', () => {
  const html = renderMd('Invalid cmd: $\\definitelyNotAKatexCommand{x}$ and valid $x^2$.');
  assert.match(html, /class="katex"/);
  assert.match(html, /\\definitelyNotAKatexCommand/);
});

// ----------------------------------------------------------------------------
// 5. Existing Markdown & 4 Chat Modes Compatibility
// ----------------------------------------------------------------------------
test('renders tables, lists, blockquotes, and all 4 chat modes properly alongside math', () => {
  const md = [
    'Note: Always verify $x > 0$ before taking $\\ln(x)$.',
    '',
    '> Important: Use $\\Delta = b^2 - 4ac$.',
    '',
    '| Variable | Formula |',
    '| --- | --- |',
    '| Area | $A = \\pi r^2$ |',
    '',
    '- [x] Checked $E = mc^2$',
    '- [ ] Pending $F = ma$'
  ].join('\n');

  for (const mode of ['general', 'learning', 'writing', 'coding']) {
    const html = renderMd(md, { effectiveMode: mode });
    assert.match(html, /class="katex"/, `Mode ${mode} must render KaTeX`);
    assert.match(html, /markdown-table/, `Mode ${mode} must render GFM table`);
    assert.match(html, /contains-task-list/, `Mode ${mode} must render GFM task list`);
    assert.match(html, /type="checkbox"/, `Mode ${mode} must render task checkbox`);
    if (mode === 'learning') {
      assert.match(html, /educational-callout/, 'Learning mode must preserve callouts');
    }
    if (mode === 'writing') {
      assert.match(html, /writing-blockquote/, 'Writing mode must preserve writing classes');
    }
    if (mode === 'coding') {
      assert.match(html, /coding-table/, 'Coding mode must preserve coding classes');
    }
  }
});

// ----------------------------------------------------------------------------
// 6. CSS, Layout Swipe Exclusion, PWA & Bundle Checks
// ----------------------------------------------------------------------------
test('CSS rules, streaming cursor exclusions, mobile swipe exclusion, and PWA font precaching are configured', () => {
  const stylesCss = fs.readFileSync('src/styles/index.css', 'utf8');
  assert.match(stylesCss, /\.ai-markdown-container \.katex\s*\{/);
  assert.match(stylesCss, /\.ai-markdown-container \.katex-display\s*\{[^}]*overflow-x:\s*auto/);
  assert.match(stylesCss, /\[data-theme="light"\] \.ai-markdown-container \.katex-error/);
  assert.match(stylesCss, /@media \(max-width:\s*640px\)[\s\S]*\.ai-markdown-container \.katex-display/);

  const cursorNotKatexCount = (stylesCss.match(/:not\(\.katex-display\)/g) || []).length;
  assert.equal(cursorNotKatexCount, 5, 'All 5 streaming cursor selectors must exclude .katex-display');

  const layoutJsx = fs.readFileSync('src/components/layout/Layout.jsx', 'utf8');
  assert.match(layoutJsx, /\.katex-display/, 'Layout.jsx must exclude .katex-display from swipe navigation');

  const swJs = fs.readFileSync('dist/sw.js', 'utf8');
  const fontMatches = swJs.match(/assets\/KaTeX_[^"]+\.(woff2|woff|ttf)/g) || [];
  assert.ok(fontMatches.length >= 20, `Expected KaTeX font assets precached in dist/sw.js, found ${fontMatches.length}`);
});

console.log('\n===============================================================');
console.log(`ALL ${passedTests} KaTeX VERIFICATION TESTS PASSED!`);
console.log('===============================================================\n');
