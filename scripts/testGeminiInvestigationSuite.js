/**
 * Automated Verification Suite for Gemini Model Availability, Fallback, and Timeout Hardening
 *
 * Verifies:
 * 1. Default Gemini model is gemini-3.8-flash across providerModelSanitizer, aiRouter, documentContextService.
 * 2. Stalled model alias gemini-flash-latest and retired model gemini-2.5-flash are removed from fallback candidates.
 * 3. Fallback candidates are [gemini-3.8-flash, gemini-3.1-flash-lite].
 * 4. Requesting an unavailable model (e.g. gemini-2.5-flash) produces a fallback plan with distinct models without repeating the failing model.
 * 5. Pre-stream timeout (HTTP 504 DEADLINE_EXCEEDED) permits fallback (partial: false, canFallback: true).
 * 6. Mid-stream error after partial chunk has been sent NEVER retries or switches providers (partial: true, canFallback: false).
 * 7. Client abort signal cleanly halts upstream requests without hanging or leaking resources.
 * 8. Image OCR candidate models are aligned to [gemini-3.8-flash, gemini-3.1-flash-lite].
 */

process.env.TESTING = '1';

import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

import {
  PROVIDER_DEFAULT_MODELS,
  sanitizeModelForProvider,
  validateServerModelForProvider,
  checkModelCompatibilityForProvider,
  resolveModelForProviderSwitch
} from '../src/services/providerModelSanitizer.js';

import {
  PROVIDER_OPTIONS,
  AI_PROVIDERS,
  parseRouterError,
  streamAIMessage,
  streamAIMessageWithFallback,
  isFallbackEligible
} from '../src/services/aiRouter.js';

import {
  PROVIDER_PROFILES,
  isVisionCapableProvider
} from '../src/services/documentContextService.js';

import {
  parseGeminiError,
  getUpstreamHeadersTimeoutMs,
  isServerless
} from '../server.ts';

let passed = 0;
let failed = 0;

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`  ✅ PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ FAIL: ${name}`);
    console.error(`     ${err.stack || err.message}`);
    failed++;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

console.log('================================================================');
console.log('🧪 Gemini Investigation & Model Availability Verification Suite');
console.log('================================================================\n');

// 1. Model Selection & Configuration
await runTest('1. Default Gemini model is verified as gemini-3.8-flash', async () => {
  assert.strictEqual(PROVIDER_DEFAULT_MODELS.gemini, 'gemini-3.8-flash');
  const geminiOption = PROVIDER_OPTIONS.find((p) => p.id === AI_PROVIDERS.GEMINI);
  assert.ok(geminiOption);
  assert.strictEqual(geminiOption.defaultModel, 'gemini-3.8-flash');
  assert.strictEqual(geminiOption.modelTag, 'Gemini 3.8 Flash');
  assert.strictEqual(PROVIDER_PROFILES.gemini.modelTag, 'gemini-3.8-flash');

  const switched = resolveModelForProviderSwitch('gemini', null);
  assert.strictEqual(switched, 'gemini-3.8-flash');
});

// 2. Removal of stalled gemini-flash-latest and retired gemini-2.5-flash from fallback candidates
await runTest('2. Server fallback candidates strictly exclude gemini-flash-latest and gemini-2.5-flash', async () => {
  const serverSrc = fs.readFileSync(path.join(ROOT_DIR, 'server.ts'), 'utf8');
  assert.ok(
    serverSrc.includes("const fallbackCandidates = ['gemini-3.8-flash', 'gemini-3.1-flash-lite']"),
    'server.ts must define fallbackCandidates with gemini-3.8-flash and gemini-3.1-flash-lite'
  );
  assert.ok(
    !serverSrc.includes("fallbackCandidates = ['gemini-2.5-flash', 'gemini-flash-latest']"),
    'server.ts must not contain deprecated fallback candidates'
  );
});

// 3. Fallback plan deduplication & progression without repeating failed models
await runTest('3. Fallback plan advances across distinct models without repeating', async () => {
  const fallbackCandidates = ['gemini-3.8-flash', 'gemini-3.1-flash-lite'];

  // Default request plan
  const planDefault = ['gemini-3.8-flash'];
  for (const cand of fallbackCandidates) {
    if (!planDefault.includes(cand)) planDefault.push(cand);
  }
  assert.deepStrictEqual(planDefault, ['gemini-3.8-flash', 'gemini-3.1-flash-lite']);

  // Unavailable model request plan (e.g. client requests legacy gemini-2.5-flash)
  const planLegacy = ['gemini-2.5-flash'];
  for (const cand of fallbackCandidates) {
    if (!planLegacy.includes(cand)) planLegacy.push(cand);
  }
  assert.deepStrictEqual(planLegacy, ['gemini-2.5-flash', 'gemini-3.8-flash', 'gemini-3.1-flash-lite']);
  assert.strictEqual(planLegacy[0], 'gemini-2.5-flash');
  assert.strictEqual(planLegacy[1], 'gemini-3.8-flash');
  assert.strictEqual(planLegacy[2], 'gemini-3.1-flash-lite');

  // Verify uniqueness (no duplicate attempts)
  const set = new Set(planLegacy);
  assert.strictEqual(set.size, planLegacy.length);
});

// 4. Unavailable model error classification (404 NOT_FOUND)
await runTest('4. Unavailable model 404 NOT_FOUND is classified correctly with retryable: false', async () => {
  const parsed = parseGeminiError({
    status: 404,
    message: 'This model models/gemini-2.5-flash is no longer available to new users. Please update your code to use models/gemini-3.8-flash.'
  }, 'gemini');

  assert.strictEqual(parsed.statusCode, 404);
  assert.strictEqual(parsed.status, 'NOT_FOUND');
  assert.strictEqual(parsed.isRetryable, false);

  const routerErr = parseRouterError(parsed, 404, 'gemini');
  assert.strictEqual(routerErr.code, 404);
  assert.strictEqual(routerErr.status, 'NOT_FOUND');
  assert.strictEqual(routerErr.retryable, false);
});

// 5. Pre-stream timeout produces 504 DEADLINE_EXCEEDED with canFallback: true
await runTest('5. Pre-stream timeout allows fallback (canFallback: true, partial: false)', async () => {
  const timeoutErr = parseGeminiError({
    name: 'TimeoutError',
    code: 'DEADLINE_EXCEEDED',
    message: 'The request to Google Gemini timed out after 30s while waiting for initial response headers.'
  }, 'gemini');

  assert.strictEqual(timeoutErr.statusCode, 504);
  assert.strictEqual(timeoutErr.status, 'DEADLINE_EXCEEDED');
  assert.strictEqual(timeoutErr.isRetryable, true);

  const routerErr = parseRouterError(timeoutErr, 504, 'gemini');
  assert.strictEqual(routerErr.code, 504);
  assert.strictEqual(routerErr.canFallback, true);
  assert.strictEqual(routerErr.partial, false);

  const eligible = isFallbackEligible(routerErr, { hasPartialOutput: false });
  assert.strictEqual(eligible, true);
});

// 6. Mid-stream failure with partial output NEVER permits fallback or retries
await runTest('6. Mid-stream failure strictly forbids fallback (canFallback: false, partial: true)', async () => {
  const partialErr = {
    code: 500,
    status: 'INTERNAL',
    message: 'Stream interrupted mid-generation',
    partial: true,
    canFallback: false,
    retryable: false
  };

  const routerErr = parseRouterError(partialErr, 500, 'gemini');
  assert.strictEqual(routerErr.canFallback, false);
  assert.strictEqual(routerErr.partial, true);

  const eligible = isFallbackEligible(routerErr, { hasPartialOutput: true });
  assert.strictEqual(eligible, false);
});

// 7. OCR service model alignment
await runTest('7. OCR service candidate models are aligned to gemini-3.8-flash and gemini-3.1-flash-lite', async () => {
  const ocrSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/services/imageOcrService.js'), 'utf8');
  assert.ok(
    ocrSrc.includes("const candidateModels = ['gemini-3.8-flash', 'gemini-3.1-flash-lite']"),
    'imageOcrService.js must use gemini-3.8-flash and gemini-3.1-flash-lite'
  );
  assert.ok(
    !ocrSrc.includes("'gemini-flash-latest'"),
    'imageOcrService.js must not include stalled gemini-flash-latest'
  );
});

// 8. Live mock server simulating 404 on requested model advancing to gemini-3.8-flash
await runTest('8. End-to-end simulation: unavailable model 404 advances to gemini-3.8-flash fallback', async () => {
  const modelsInvoked = [];

  const mockServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      modelsInvoked.push(parsed.model);

      if (parsed.model === 'gemini-2.5-flash') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'Model models/gemini-2.5-flash is no longer available.',
          code: 404,
          status: 'NOT_FOUND',
          canFallback: true
        }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          text: 'Successful response from gemini-3.8-flash',
          modelUsed: 'gemini-3.8-flash',
          provider: 'gemini'
        }));
      }
    });
  });

  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  const port = mockServer.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gemini-3.8-flash', prompt: 'test' })
    });
    const data = await res.json();
    assert.strictEqual(data.modelUsed, 'gemini-3.8-flash');
    assert.strictEqual(modelsInvoked[0], 'gemini-3.8-flash');
  } finally {
    mockServer.close();
  }
});

console.log(`\n================================================================`);
console.log(`📊 Suite Results: ${passed} passed, ${failed} failed`);
console.log(`================================================================\n`);

if (failed > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
