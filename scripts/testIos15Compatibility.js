/**
 * scripts/testIos15Compatibility.js
 * Deterministic Regression Test Suite for iPhone 7 / iOS 15.8.8 Compatibility
 *
 * Verifies:
 * 1. Speech text cleaning (palindrome phonetic correction vs Math.random preservation)
 * 2. Sentence boundary punctuation formatting without lookbehind
 * 3. Abbreviation and numeric decimal preservation (i.e., e.g., 123.45)
 * 4. Voice dictation hook transcript formatting
 * 5. GFM autolink email parsing in mdast-util-gfm-autolink-literal
 * 6. Production bundle zero-lookbehind audit
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { polishSpokenTranscript, cleanTextForSpeech } from '../src/utils/speechTextCleaner.js';
import { formatSpeechTranscript } from '../src/hooks/useVoiceDictation.js';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

console.log('\n===============================================================');
console.log('ORVIX iOS 15.8.8 / iPHONE 7 REGRESSION TEST SUITE');
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

// ----------------------------------------------------------------------------
// 1. Speech Text Cleaning: Palindrome vs Math.random Disambiguation
// ----------------------------------------------------------------------------
test('polishSpokenTranscript disambiguates "pedrandom" to "palindrome" in programming context', () => {
  const result = polishSpokenTranscript('write a function for pedrandom in python', {
    isProgrammingContext: true
  });
  assert.match(result, /palindrome/i, 'pedrandom must be corrected to palindrome');
  assert.doesNotMatch(result, /pedrandom/i, 'pedrandom must not remain');
});

test('polishSpokenTranscript disambiguates "ped random" and "pelindrome" to "palindrome"', () => {
  const r1 = polishSpokenTranscript('check if string is pelindrome', { isProgrammingContext: true });
  assert.match(r1, /palindrome/i);

  const r2 = polishSpokenTranscript('check if string is ped random', { isProgrammingContext: true });
  assert.match(r2, /palindrome/i);
});

test('polishSpokenTranscript strictly protects Math.random from palindrome substitution', () => {
  const result = polishSpokenTranscript('generate a number using math random in javascript', {
    isProgrammingContext: true
  });
  assert.match(result, /Math\.random/, 'Math.random must be preserved');
  assert.doesNotMatch(result, /palindrome/, 'Math.random must never become palindrome');
});

// ----------------------------------------------------------------------------
// 2. Sentence Boundary Punctuation Formatting
// ----------------------------------------------------------------------------
test('polishSpokenTranscript properly spaces sentence boundaries after dots', () => {
  const result = polishSpokenTranscript('This is the first sentence.next sentence starts here.');
  assert.equal(result, 'This is the first sentence. Next sentence starts here.');
});

test('polishSpokenTranscript preserves abbreviations and numeric decimals', () => {
  const r1 = polishSpokenTranscript('The value is 123.45 in total.');
  assert.match(r1, /123\.45/, 'Numeric decimals must remain intact');

  const r2 = polishSpokenTranscript('Use i.e.example or e.g.test.');
  assert.match(r2, /[iI]\.e\.example/, 'Abbreviation with single letter before dot must not be spaced out');
  assert.match(r2, /e\.g\.test/, 'Abbreviation with single letter before dot must not be spaced out');
});

// ----------------------------------------------------------------------------
// 3. Voice Dictation Hook Transcript Formatting
// ----------------------------------------------------------------------------
test('formatSpeechTranscript properly formats dictation text and protects Math.random', () => {
  const r1 = formatSpeechTranscript('hello orvix write math.random code', false);
  assert.match(r1, /Math\.random/);

  const r2 = formatSpeechTranscript('first sentence.second sentence', false);
  assert.match(r2, /First sentence\. Second sentence/);
});

// ----------------------------------------------------------------------------
// 4. GFM Email and URL Autolinking in ReactMarkdown
// ----------------------------------------------------------------------------
test('ReactMarkdown + remarkGfm autolinks emails and URLs without lookbehind syntax', () => {
  const markdown = 'Contact me at test.user@example.com or visit https://example.com today.';
  const html = renderToStaticMarkup(
    React.createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, markdown)
  );

  assert.ok(
    html.includes('<a href="mailto:test.user@example.com">test.user@example.com</a>'),
    'Email must be autolinked to mailto:'
  );
  assert.ok(
    html.includes('<a href="https://example.com">https://example.com</a>'),
    'URL must be autolinked'
  );
});

test('ReactMarkdown + remarkGfm handles parenthesized and punctuation-surrounded emails', () => {
  const markdown = 'Email us (support@orvix.ai) or contact:team@orvix.ai for details.';
  const html = renderToStaticMarkup(
    React.createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, markdown)
  );

  assert.ok(
    html.includes('<a href="mailto:support@orvix.ai">support@orvix.ai</a>'),
    'Parenthesized email must be autolinked'
  );
  assert.ok(
    html.includes('<a href="mailto:team@orvix.ai">team@orvix.ai</a>'),
    'Colon-prefixed email must be autolinked'
  );
});

// ----------------------------------------------------------------------------
// 5. Production Bundle Zero-Lookbehind Audit
// ----------------------------------------------------------------------------
test('Production dist/assets JS files contain ZERO lookbehind assertions', () => {
  const distFiles = fs.readdirSync('dist/assets').filter((f) => f.endsWith('.js'));
  assert.ok(distFiles.length >= 10, 'Expected at least 10 JS bundles in dist/assets');

  for (const file of distFiles) {
    const code = fs.readFileSync(`dist/assets/${file}`, 'utf8');
    const positive = code.match(/\(\?<=/g);
    const negative = code.match(/\(\?<!/g);
    assert.equal(
      positive,
      null,
      `Bundle ${file} must not contain positive lookbehind (?<=)`
    );
    assert.equal(
      negative,
      null,
      `Bundle ${file} must not contain negative lookbehind (?<!`
    );
  }
});

console.log(`\n===============================================================`);
console.log(`ALL ${passedTests} iOS 15.8.8 COMPATIBILITY TESTS PASSED!`);
console.log(`===============================================================\n`);
