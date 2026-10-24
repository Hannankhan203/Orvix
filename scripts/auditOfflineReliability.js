/**
 * Orvix Offline Reliability & Production Hardening Automated Audit
 * Validates offline readiness logic, document parsers, model resolution,
 * service worker configuration, and build artifact integrity.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import {
  isBrowserExtractable,
  countWords,
  truncateSafely,
  extractSectionsFromMarkdown,
  parseDelimitedText
} from '../src/services/browserDocumentExtractor.js';

import {
  DEFAULT_WEBLLM_MODEL_ID,
  FALLBACK_F32_WEBLLM_MODEL_ID,
  LIGHTWEIGHT_WEBLLM_MODEL_ID,
  LIGHTWEIGHT_F32_WEBLLM_MODEL_ID,
  WEBLLM_MODEL_CATALOG,
  WEBLLM_ERROR_CODES,
  WebLLMError,
  resolveWebLLMModelId
} from '../src/services/webllmService.js';

console.log('--- Starting Orvix Offline Reliability Audit ---');

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
// 1. Document Format Support Decisions
// ----------------------------------------------------------------------------
test('isBrowserExtractable accurately identifies supported browser document formats', () => {
  const supported = ['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'xml', 'docx', 'pdf', 'pptx'];
  for (const ext of supported) {
    assert.strictEqual(isBrowserExtractable(ext), true, `Extension .${ext} should be extractable in browser`);
    assert.strictEqual(isBrowserExtractable(`.${ext}`), true, `Extension with dot .${ext} should be extractable`);
  }

  // Common MIME types
  assert.strictEqual(isBrowserExtractable('', 'application/pdf'), true);
  assert.strictEqual(isBrowserExtractable('', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), true);
  assert.strictEqual(isBrowserExtractable('', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'), true);
  assert.strictEqual(isBrowserExtractable('', 'text/markdown'), true);
  assert.strictEqual(isBrowserExtractable('', 'text/csv'), true);
  assert.strictEqual(isBrowserExtractable('', 'application/json'), true);
});

test('isBrowserExtractable rejects unsupported, binary, or image formats requiring server OCR', () => {
  const unsupported = ['doc', 'ppt', 'xls', 'xlsx', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'zip', 'exe', 'mp4'];
  for (const ext of unsupported) {
    assert.strictEqual(isBrowserExtractable(ext), false, `Extension .${ext} must NOT be reported as extractable`);
  }
  assert.strictEqual(isBrowserExtractable('', 'image/png'), false);
  assert.strictEqual(isBrowserExtractable('', 'application/msword'), false);
  assert.strictEqual(isBrowserExtractable('', 'application/vnd.ms-powerpoint'), false);
});

// ----------------------------------------------------------------------------
// 2. Client-side Parsing Utilities
// ----------------------------------------------------------------------------
test('countWords handles empty strings and multi-line whitespace accurately', () => {
  assert.strictEqual(countWords(''), 0);
  assert.strictEqual(countWords('   \n\t  '), 0);
  assert.strictEqual(countWords('Hello world'), 2);
  assert.strictEqual(countWords('The quick brown\nfox jumps\tover the   lazy dog.'), 9);
});

test('truncateSafely respects character thresholds and appends warning when needed', () => {
  const shortText = 'This is a short text document.';
  const res1 = truncateSafely(shortText, 50);
  assert.strictEqual(res1.isTruncated, false);
  assert.strictEqual(res1.text, shortText);

  const longText = 'A'.repeat(100);
  const res2 = truncateSafely(longText, 40);
  assert.strictEqual(res2.isTruncated, true);
  assert.ok(res2.text.startsWith('A'.repeat(40)));
  assert.ok(res2.text.includes('[... Remaining content truncated for performance ...]'));
});

test('extractSectionsFromMarkdown splits headings properly', () => {
  const md = `# Title\n\nIntro text.\n\n## Section 1\n\nDetails about section 1.\n\n### Subsection\n\nDeep info.`;
  const sections = extractSectionsFromMarkdown(md);
  assert.strictEqual(sections.length, 3);
  assert.strictEqual(sections[0].heading, 'Title');
  assert.strictEqual(sections[0].level, 1);
  assert.strictEqual(sections[1].heading, 'Section 1');
  assert.strictEqual(sections[1].level, 2);
  assert.strictEqual(sections[2].heading, 'Subsection');
  assert.strictEqual(sections[2].level, 3);
});

test('parseDelimitedText accurately parses quoted CSV and formats Markdown tables', () => {
  const csv = `Name,Role,Notes\n"Smith, John",Engineer,"Expert in WebGPU, PWA"\n"Doe, Jane",Designer,"UX Lead"`;
  const table = parseDelimitedText(csv, ',');
  assert.strictEqual(table.rowCount, 2);
  assert.strictEqual(table.headers.length, 3);
  assert.strictEqual(table.headers[0], 'Name');
  assert.strictEqual(table.headers[1], 'Role');
  assert.strictEqual(table.previewRows[0][0], 'Smith, John');
  assert.strictEqual(table.previewRows[0][2], 'Expert in WebGPU, PWA');
  assert.ok(table.markdownTable.includes('| Name'));
  assert.ok(table.markdownTable.includes('| Smith, John'));
});

// ----------------------------------------------------------------------------
// 3. WebLLM Model Catalog & Resolution Logic
// ----------------------------------------------------------------------------
test('WEBLLM_MODEL_CATALOG contains verified 1.5B and 0.5B models with valid configurations', () => {
  assert.ok(WEBLLM_MODEL_CATALOG[DEFAULT_WEBLLM_MODEL_ID], 'Default 1.5B model must exist');
  assert.ok(WEBLLM_MODEL_CATALOG[FALLBACK_F32_WEBLLM_MODEL_ID], 'Fallback 1.5B FP32 model must exist');
  assert.ok(WEBLLM_MODEL_CATALOG[LIGHTWEIGHT_WEBLLM_MODEL_ID], 'Lightweight 0.5B model must exist');
  assert.ok(WEBLLM_MODEL_CATALOG[LIGHTWEIGHT_F32_WEBLLM_MODEL_ID], 'Lightweight 0.5B FP32 model must exist');

  const defaultModel = WEBLLM_MODEL_CATALOG[DEFAULT_WEBLLM_MODEL_ID];
  assert.strictEqual(defaultModel.prefersShaderF16, true);
  assert.strictEqual(defaultModel.f32FallbackModelId, FALLBACK_F32_WEBLLM_MODEL_ID);
  assert.ok(defaultModel.estimatedDownloadMB > 0);
  assert.ok(defaultModel.minStorageBytes > defaultModel.estimatedDownloadMB * 1024 * 1024);
});

test('resolveWebLLMModelId correctly resolves shader-f16 vs fp32 fallback', () => {
  // With shader-f16 available: keep default
  const withF16 = resolveWebLLMModelId(DEFAULT_WEBLLM_MODEL_ID, { hasShaderF16: true });
  assert.strictEqual(withF16, DEFAULT_WEBLLM_MODEL_ID);

  // Without shader-f16: fallback to FP32 variant
  const withoutF16 = resolveWebLLMModelId(DEFAULT_WEBLLM_MODEL_ID, { hasShaderF16: false, allowF32Fallback: true });
  assert.strictEqual(withoutF16, FALLBACK_F32_WEBLLM_MODEL_ID);

  // Lightweight model fallback
  const lightweightWithoutF16 = resolveWebLLMModelId(LIGHTWEIGHT_WEBLLM_MODEL_ID, { hasShaderF16: false, allowF32Fallback: true });
  assert.strictEqual(lightweightWithoutF16, LIGHTWEIGHT_F32_WEBLLM_MODEL_ID);
});

test('WebLLMError enforces local non-fallback invariants', () => {
  const err = new WebLLMError('Test error', { code: WEBLLM_ERROR_CODES.DEVICE_LOST });
  assert.strictEqual(err.canFallback, false, 'Local Browser AI errors must never trigger silent cloud fallback');
  assert.strictEqual(err.provider, 'webllm');
  assert.strictEqual(err.errorCode, WEBLLM_ERROR_CODES.DEVICE_LOST);
});

// ----------------------------------------------------------------------------
// 4. Production Service Worker & Precache Manifest Verification
// ----------------------------------------------------------------------------
test('Generated production service worker contains required precached chunks and routes', () => {
  const swPath = path.resolve('dist/sw.js');
  assert.ok(fs.existsSync(swPath), 'dist/sw.js must be generated after build');

  const swContent = fs.readFileSync(swPath, 'utf8');

  // Verify navigation route and denylist
  assert.ok(swContent.includes('NavigationRoute'), 'sw.js must register NavigationRoute');
  assert.ok(swContent.includes('/index.html'), 'NavigationRoute must fallback to /index.html');
  assert.ok(/\/api\//.test(swContent) || swContent.includes('\\/api\\/'), 'Navigation denylist must exclude /api/');
  assert.ok(/\/health/.test(swContent) || swContent.includes('\\/health'), 'Navigation denylist must exclude /health');
  assert.ok(/\/upload/.test(swContent) || swContent.includes('\\/upload'), 'Navigation denylist must exclude /upload');

  // Verify NetworkOnly routes for external weights & API
  assert.ok(swContent.includes('NetworkOnly'), 'sw.js must register NetworkOnly for API and weights');

  // Verify essential lazy chunks in precache
  assert.ok(swContent.includes('webllmWorker-'), 'WebLLM dedicated worker must be in precache manifest');
  assert.ok(swContent.includes('pdfjs-'), 'PDF parsing chunk (unpdf) must be in precache manifest');
  assert.ok(swContent.includes('jszip'), 'PPTX parsing chunk (jszip) must be in precache manifest');

  // Verify model weights are NOT in precache
  assert.ok(!swContent.includes('resolve/main/params_shard'), 'Model weights must NOT be precached via Workbox');
  assert.ok(!swContent.includes('huggingface.co/Qwen'), 'Model weights URLs must NOT be in Workbox precache');
});

console.log(`\nAll ${passedTests} offline reliability tests passed successfully!`);
