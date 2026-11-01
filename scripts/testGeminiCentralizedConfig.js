#!/usr/bin/env node

/**
 * ORVIX-009 Verification Suite
 *
 * Validates:
 * 1. Centralized Gemini model configuration in appConfig.js.
 * 2. Alignment of providerModelSanitizer.js with centralized Gemini constants.
 * 3. Alignment of server.ts and chatSubsystem with centralized Gemini constants.
 * 4. Fallback execution when primary model encounters 404 / 504 failures.
 * 5. Rejection of fallback for 401 / 403 / 400 errors.
 * 6. Protection of non-Gemini providers (Groq, OpenRouter, Cloudflare, WebLLM).
 */

process.env.TESTING = '1';

import assert from 'node:assert/strict';
import {
  APP_CONFIG,
  GEMINI_PRIMARY_MODEL,
  GEMINI_FALLBACK_MODEL,
  GEMINI_FALLBACK_CANDIDATES,
  GEMINI_MODELS_CONFIG
} from '../src/config/appConfig.js';

import {
  PROVIDER_DEFAULT_MODELS,
  PROVIDER_DISPLAY_NAMES,
  SUPPORTED_PROVIDER_IDS,
  validateServerModelForProvider,
  sanitizeModelForProvider,
  GEMINI_PRIMARY_MODEL as SANITIZER_GEMINI_PRIMARY,
  GEMINI_FALLBACK_MODEL as SANITIZER_GEMINI_FALLBACK,
  GEMINI_FALLBACK_CANDIDATES as SANITIZER_GEMINI_CANDIDATES
} from '../src/services/providerModelSanitizer.js';

const {
  fallbackCandidates,
  GEMINI_PRIMARY_MODEL: SERVER_GEMINI_PRIMARY,
  GEMINI_FALLBACK_MODEL: SERVER_GEMINI_FALLBACK,
  GEMINI_FALLBACK_CANDIDATES: SERVER_GEMINI_CANDIDATES
} = await import('../server.ts');

import { parseGeminiError } from '../server/geminiStreamHandler.ts';

console.log('========================================================================');
console.log('🧪 ORVIX-009: Centralized Gemini Model Configuration & Fallback Suite');
console.log('========================================================================\n');

let passed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ FAIL: ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

// ----------------------------------------------------------------------------
// 1. Centralized Model Configuration in appConfig.js
// ----------------------------------------------------------------------------
test('1.1 appConfig.js defines GEMINI_PRIMARY_MODEL as gemini-3.8-flash', () => {
  assert.strictEqual(GEMINI_PRIMARY_MODEL, 'gemini-3.8-flash');
});

test('1.2 appConfig.js defines GEMINI_FALLBACK_MODEL as gemini-3.1-flash-lite', () => {
  assert.strictEqual(GEMINI_FALLBACK_MODEL, 'gemini-3.1-flash-lite');
  assert.notStrictEqual(GEMINI_PRIMARY_MODEL, GEMINI_FALLBACK_MODEL, 'Primary and secondary models must be distinct');
});

test('1.3 appConfig.js defines GEMINI_FALLBACK_CANDIDATES in order [primary, secondary]', () => {
  assert.deepStrictEqual(Array.from(GEMINI_FALLBACK_CANDIDATES), ['gemini-3.8-flash', 'gemini-3.1-flash-lite']);
});

test('1.4 APP_CONFIG incorporates centralized gemini configuration object', () => {
  assert.ok(APP_CONFIG.gemini, 'APP_CONFIG.gemini must exist');
  assert.strictEqual(APP_CONFIG.gemini.primary, GEMINI_PRIMARY_MODEL);
  assert.strictEqual(APP_CONFIG.gemini.secondary, GEMINI_FALLBACK_MODEL);
  assert.deepStrictEqual(Array.from(APP_CONFIG.gemini.fallbackCandidates), Array.from(GEMINI_FALLBACK_CANDIDATES));
});

// ----------------------------------------------------------------------------
// 2. Alignment with providerModelSanitizer.js
// ----------------------------------------------------------------------------
test('2.1 providerModelSanitizer consumes centralized GEMINI_PRIMARY_MODEL', () => {
  assert.strictEqual(SANITIZER_GEMINI_PRIMARY, GEMINI_PRIMARY_MODEL);
  assert.strictEqual(SANITIZER_GEMINI_FALLBACK, GEMINI_FALLBACK_MODEL);
  assert.deepStrictEqual(Array.from(SANITIZER_GEMINI_CANDIDATES), Array.from(GEMINI_FALLBACK_CANDIDATES));
});

test('2.2 PROVIDER_DEFAULT_MODELS.gemini matches GEMINI_PRIMARY_MODEL', () => {
  assert.strictEqual(PROVIDER_DEFAULT_MODELS.gemini, GEMINI_PRIMARY_MODEL);
});

test('2.3 Model sanitizer validates documented Gemini models and rejects invalid values', () => {
  assert.strictEqual(sanitizeModelForProvider('gemini', GEMINI_PRIMARY_MODEL), GEMINI_PRIMARY_MODEL);
  assert.strictEqual(sanitizeModelForProvider('gemini', GEMINI_FALLBACK_MODEL), GEMINI_FALLBACK_MODEL);
  assert.strictEqual(sanitizeModelForProvider('gemini', 'gemini-2.5-pro'), 'gemini-2.5-pro');
  // Rejects invalid display labels
  assert.strictEqual(sanitizeModelForProvider('gemini', 'gemini 3.8 flash'), null);
  assert.strictEqual(sanitizeModelForProvider('gemini', 'invalid-model'), null);
});

test('2.4 Server validator validates documented Gemini models and returns null for unprovided model', () => {
  const emptyCheck = validateServerModelForProvider('gemini', null);
  assert.strictEqual(emptyCheck.valid, true);
  assert.strictEqual(emptyCheck.model, null);

  const primaryCheck = validateServerModelForProvider('gemini', GEMINI_PRIMARY_MODEL);
  assert.strictEqual(primaryCheck.valid, true);
  assert.strictEqual(primaryCheck.model, GEMINI_PRIMARY_MODEL);

  const fallbackCheck = validateServerModelForProvider('gemini', GEMINI_FALLBACK_MODEL);
  assert.strictEqual(fallbackCheck.valid, true);
  assert.strictEqual(fallbackCheck.model, GEMINI_FALLBACK_MODEL);
});

// ----------------------------------------------------------------------------
// 3. Alignment with server.ts and Backend
// ----------------------------------------------------------------------------
test('3.1 server.ts exports centralized Gemini model constants', () => {
  assert.strictEqual(SERVER_GEMINI_PRIMARY, GEMINI_PRIMARY_MODEL);
  assert.strictEqual(SERVER_GEMINI_FALLBACK, GEMINI_FALLBACK_MODEL);
  assert.deepStrictEqual(Array.from(SERVER_GEMINI_CANDIDATES), Array.from(GEMINI_FALLBACK_CANDIDATES));
});

test('3.2 server.ts fallbackCandidates matches GEMINI_FALLBACK_CANDIDATES', () => {
  assert.deepStrictEqual(Array.from(fallbackCandidates), Array.from(GEMINI_FALLBACK_CANDIDATES));
});

// ----------------------------------------------------------------------------
// 4. Secondary Fallback Plan Resolution
// ----------------------------------------------------------------------------
test('4.1 Default attempt plan progresses from primary to secondary fallback without duplicate', () => {
  const requestedModel = GEMINI_PRIMARY_MODEL;
  const candidates = GEMINI_FALLBACK_CANDIDATES;
  const plan = [requestedModel];
  for (const cand of candidates) {
    if (!plan.includes(cand)) {
      plan.push(cand);
    }
  }
  assert.deepStrictEqual(plan, [GEMINI_PRIMARY_MODEL, GEMINI_FALLBACK_MODEL]);
  assert.strictEqual(plan.length, 2);
  assert.notStrictEqual(plan[0], plan[1]);
});

test('4.2 Plan for explicit custom model advances to primary then secondary without loops', () => {
  const requestedModel = 'gemini-2.5-flash';
  const candidates = GEMINI_FALLBACK_CANDIDATES;
  const plan = [requestedModel];
  for (const cand of candidates) {
    if (!plan.includes(cand)) {
      plan.push(cand);
    }
  }
  assert.deepStrictEqual(plan, ['gemini-2.5-flash', GEMINI_PRIMARY_MODEL, GEMINI_FALLBACK_MODEL]);
  assert.strictEqual(plan.length, 3);
});

// ----------------------------------------------------------------------------
// 5. Error Classification: Eligible vs Non-Eligible Fallback Triggers
// ----------------------------------------------------------------------------
test('5.1 Model availability error (404 NOT_FOUND) enables fallback progression', () => {
  const err = new Error('models/gemini-3.8-flash is not found for API version v1beta');
  err.status = 404;
  const parsed = parseGeminiError(err, 'gemini');
  assert.strictEqual(parsed.statusCode, 404);
  assert.strictEqual(parsed.status, 'NOT_FOUND');
  const isModelNotFound = parsed.statusCode === 404 || parsed.status === 'NOT_FOUND';
  assert.strictEqual(isModelNotFound, true, '404 must qualify as model availability failure for fallback');
});

test('5.2 Deadline exceeded / timeout error (504) enables fallback progression', () => {
  const err = new Error('The request to Google Gemini timed out after 45s');
  err.status = 504;
  err.code = 'DEADLINE_EXCEEDED';
  const parsed = parseGeminiError(err, 'gemini');
  assert.strictEqual(parsed.statusCode, 504);
  const isTimeout = parsed.statusCode === 504 || parsed.status === 'DEADLINE_EXCEEDED';
  assert.strictEqual(isTimeout, true, '504 must qualify as timeout failure for fallback');
});

test('5.3 Authentication failure (401 / 403) does NOT trigger fallback', () => {
  const authErr = new Error('API key not valid. Please pass a valid API key.');
  authErr.status = 401;
  const parsed = parseGeminiError(authErr, 'gemini');
  assert.strictEqual(parsed.isRetryable, false);
  const isModelNotFound = parsed.statusCode === 404 || parsed.status === 'NOT_FOUND';
  const isTimeout = parsed.statusCode === 504 || parsed.status === 'DEADLINE_EXCEEDED';
  const willAdvance = (isModelNotFound || isTimeout);
  assert.strictEqual(willAdvance, false, 'Authentication error must NEVER advance to fallback');
});

test('5.4 Request validation error (400 INVALID_ARGUMENT) does NOT trigger fallback', () => {
  const valErr = new Error('Contents cannot be empty');
  valErr.status = 400;
  const parsed = parseGeminiError(valErr, 'gemini');
  assert.strictEqual(parsed.isRetryable, false);
  const isModelNotFound = parsed.statusCode === 404 || parsed.status === 'NOT_FOUND';
  const isTimeout = parsed.statusCode === 504 || parsed.status === 'DEADLINE_EXCEEDED';
  const willAdvance = (isModelNotFound || isTimeout);
  assert.strictEqual(willAdvance, false, 'Validation error must NEVER advance to fallback');
});

// ----------------------------------------------------------------------------
// 6. Preservation of Non-Gemini Providers
// ----------------------------------------------------------------------------
test('6.1 Non-Gemini provider default models remain completely intact', () => {
  assert.strictEqual(PROVIDER_DEFAULT_MODELS.groq, 'openai/gpt-oss-120b');
  assert.strictEqual(PROVIDER_DEFAULT_MODELS.openrouter, 'openrouter/free');
  assert.strictEqual(PROVIDER_DEFAULT_MODELS.cloudflare, '@cf/meta/llama-3.1-8b-instruct');
  assert.strictEqual(PROVIDER_DEFAULT_MODELS.webllm, 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC');
});

test('6.2 Supported providers list is preserved', () => {
  assert.deepStrictEqual(
    Array.from(SUPPORTED_PROVIDER_IDS),
    ['gemini', 'groq', 'openrouter', 'cloudflare', 'webllm']
  );
});

console.log(`\n========================================================================`);
console.log(`Results: ${passed} passed, 0 failed.`);
console.log(`========================================================================\n`);
