import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inlineMarkdownToHtml,
  formatTableAsHtml,
  formatMessageForClipboard
} from '../src/utils/clipboardFormatter.js';

test('ORVIX-LOW-07: allows valid http, https, and mailto links with trimmed normalization and security attributes', () => {
  const httpsHtml = inlineMarkdownToHtml('Visit [Orvix Docs](  HTTPS://Example.COM/docs?a=1&b=2#top  ) now.');
  assert.match(httpsHtml, /<a href="https:\/\/example\.com\/docs\?a=1&amp;b=2#top"/);
  assert.match(httpsHtml, /target="_blank"/);
  assert.match(httpsHtml, /rel="noopener noreferrer"/);
  assert.match(httpsHtml, />Orvix Docs<\/a>/);

  const httpHtml = inlineMarkdownToHtml('Legacy [HTTP Link]( http://internal.example.org/status )');
  assert.match(httpHtml, /<a href="http:\/\/internal\.example\.org\/status"/);
  assert.match(httpHtml, />HTTP Link<\/a>/);

  const mailHtml = inlineMarkdownToHtml('Email [Support](  MAILTO:support@orvix.ai?subject=Help  )');
  assert.match(mailHtml, /<a href="mailto:support@orvix\.ai\?subject=Help"/);
  assert.match(mailHtml, /target="_blank"/);
  assert.match(mailHtml, /rel="noopener noreferrer"/);
  assert.match(mailHtml, />Support<\/a>/);
});

test('ORVIX-LOW-07: rejects javascript, data, vbscript, and unsafe schemes as escaped plain text without anchors', () => {
  const unsafeLinks = [
    '[Click me](javascript:alert(1))',
    '[Click mixed](JaVaScRiPt:alert(document.cookie))',
    '[Click data](data:text/html,<script>alert(1)</script>)',
    '[Click vb](vbscript:msgbox(1))',
    '[Click file](file:///etc/passwd)',
    '[Click blob](blob:https://evil.example/1234)',
    '[Click proto-rel](//evil.example/payload)'
  ];

  for (const input of unsafeLinks) {
    const html = inlineMarkdownToHtml(input);
    assert.equal(html.includes('<a '), false, `Unsafe link must not render <a> tag: ${input}`);
    assert.equal(html.includes('href='), false, `Unsafe link must not render href attribute: ${input}`);
  }

  assert.equal(inlineMarkdownToHtml('[Click me](javascript:alert(1))'), 'Click me');
  assert.equal(inlineMarkdownToHtml('[Click data](data:text/html,<script>alert(1)</script>)'), 'Click data');
  assert.equal(inlineMarkdownToHtml('[Click vb](vbscript:msgbox(1))'), 'Click vb');
});

test('ORVIX-LOW-07: handles whitespace, control characters, and encoded or obfuscated URL attempts safely', () => {
  const obfuscatedAttempts = [
    '[Tab attack](java\tscript:alert(1))',
    '[Newline attack](java\nscript:alert(1))',
    '[Null byte](javascript\u0000:alert(1))',
    '[Zero width](java\u200Bscript:alert(1))',
    '[Entity colon](javascript&#58;alert(1))',
    '[Entity scheme](&#106;avascript:alert(1))',
    '[Percent scheme](%6a%61%76%61%73%63%72%69%70%74:alert(1))',
    '[Bad host](https:///missing-host/path)',
    '[Mailto bypass](mailto://evil.example/path)',
    '[Backslash](https:\\\\evil.example)'
  ];

  for (const input of obfuscatedAttempts) {
    const html = inlineMarkdownToHtml(input);
    assert.equal(html.includes('<a '), false, `Obfuscated URL must not render anchor: ${input}`);
    assert.equal(html.includes('href='), false, `Obfuscated URL must not render href: ${input}`);
  }
});

test('ORVIX-LOW-07: prevents HTML injection in malformed Markdown links and escaped labels', () => {
  const injectedLabel = inlineMarkdownToHtml('[<img src=x onerror=alert(1)>](javascript:alert(1))');
  assert.equal(injectedLabel.includes('<img'), false);
  assert.equal(injectedLabel.includes('<a '), false);
  assert.match(injectedLabel, /&lt;img src=x onerror=alert\(1\)&gt;/);

  const attrBreakout = inlineMarkdownToHtml('[Bad](https://example.com" onclick="alert(1))');
  assert.equal(attrBreakout.includes('<a '), false);
  assert.equal(attrBreakout.includes('onclick='), false);
  assert.equal(attrBreakout, 'Bad');

  const malformed = inlineMarkdownToHtml('[Unclosed(https://example.com <script>alert(1)</script>');
  assert.equal(malformed.includes('<script>'), false);
  assert.match(malformed, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('ORVIX-LOW-07: preserves existing Markdown formatting, tables, and plain-text clipboard output', () => {
  const markdown = [
    '# Report **Summary**',
    '',
    'Use **Orvix** with `inlineCode` and [Docs](https://orvix.example/docs) or [Unsafe](javascript:alert(1)).',
    '',
    '| Item | Link |',
    '| :--- | :--- |',
    '| Safe | [Home](https://orvix.example) |',
    '| Unsafe | [Trap](data:text/plain,bad) |'
  ].join('\n');

  const { plainText, htmlText, containsTable } = formatMessageForClipboard(markdown);

  assert.equal(containsTable, true);
  assert.match(htmlText, /<strong>Summary<\/strong>/);
  assert.match(htmlText, /<strong>Orvix<\/strong>/);
  assert.match(htmlText, /<code [^>]*>inlineCode<\/code>/);
  assert.match(htmlText, /<a href="https:\/\/orvix\.example\/docs" [^>]*target="_blank" rel="noopener noreferrer">Docs<\/a>/);
  assert.match(htmlText, /<a href="https:\/\/orvix\.example\/" [^>]*target="_blank" rel="noopener noreferrer">Home<\/a>/);

  // Rejected links stay non-clickable escaped text in both body and table cells
  assert.equal(htmlText.includes('javascript:'), false);
  assert.equal(htmlText.includes('data:text/plain'), false);
  assert.ok(htmlText.includes('Unsafe.'));
  assert.ok(htmlText.includes('>Trap<'));

  // Plain text record formatting for messaging apps stays intact
  assert.match(plainText, /• Item: Safe/);
  assert.match(plainText, /Link: \[Home\]\(https:\/\/orvix\.example\)/);

  const tableHtml = formatTableAsHtml(['Col'], [['[OK](http://example.org) / [No](javascript:void(0))']]);
  assert.match(tableHtml, /<a href="http:\/\/example\.org\/"/);
  assert.equal(tableHtml.includes('javascript:'), false);
});
