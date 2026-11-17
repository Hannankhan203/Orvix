import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GEMINI_PRIMARY_MODEL,
  GEMINI_FALLBACK_MODEL,
  GEMINI_FALLBACK_CANDIDATES,
  GEMINI_MODELS_CONFIG
} from '../src/config/appConfig.js';
import {
  sanitizeModelForProvider,
  validateServerModelForProvider,
  resolveModelForProviderSwitch
} from '../src/services/providerModelSanitizer.js';

test('ORVIX-CRIT-05 & ORVIX-MED-03: Canonical Gemini model constants are correctly configured to supported Gemini 2.5 models', () => {
  assert.equal(GEMINI_PRIMARY_MODEL, 'gemini-2.5-flash');
  assert.equal(GEMINI_FALLBACK_MODEL, 'gemini-2.5-flash-lite');
  assert.deepEqual(GEMINI_FALLBACK_CANDIDATES, ['gemini-2.5-flash', 'gemini-2.5-flash-lite']);
  assert.equal(GEMINI_MODELS_CONFIG.primary, 'gemini-2.5-flash');
  assert.equal(GEMINI_MODELS_CONFIG.secondary, 'gemini-2.5-flash-lite');
});

test('ORVIX-CRIT-05 & ORVIX-MED-03: sanitizeModelForProvider and validateServerModelForProvider enforce valid Gemini model IDs and reject invalid/retired models', () => {
  // Valid active models
  assert.equal(sanitizeModelForProvider('gemini', 'gemini-2.5-flash'), 'gemini-2.5-flash');
  assert.equal(sanitizeModelForProvider('gemini', 'gemini-2.5-flash-lite'), 'gemini-2.5-flash-lite');
  assert.equal(sanitizeModelForProvider('gemini', 'gemini-2.5-pro'), 'gemini-2.5-pro');
  assert.equal(sanitizeModelForProvider('gemini', 'models/gemini-2.5-flash'), 'models/gemini-2.5-flash');

  // Invalid / fictional / retired Gemini model identifiers are rejected and sanitized to null
  assert.equal(sanitizeModelForProvider('gemini', 'gemini-4-hydrogen'), null);
  assert.equal(sanitizeModelForProvider('gemini', 'gemini-3.5-flash-lite'), null);
  assert.equal(sanitizeModelForProvider('gemini', 'gemini-3.5-transcribe'), null);
  assert.equal(sanitizeModelForProvider('gemini', 'gemini-3.8-flash'), null);
  assert.equal(sanitizeModelForProvider('gemini', 'gemini-3.1-flash-lite'), null);
  assert.equal(sanitizeModelForProvider('gemini', 'gemini-1.5-flash'), null);

  // Cross-provider models, malformed identifiers, and display labels are cleared/sanitized to null (defaulting to primary)
  assert.equal(sanitizeModelForProvider('gemini', '@cf/meta/llama-3-8b-instruct'), null);
  assert.equal(sanitizeModelForProvider('gemini', 'unknown-model-xyz'), null);
  assert.equal(sanitizeModelForProvider('cloudflare', 'gemini-2.5-flash'), null);

  // Server validation tests
  const v1 = validateServerModelForProvider('gemini', 'gemini-2.5-flash');
  assert.equal(v1.valid, true);
  assert.equal(v1.model, 'gemini-2.5-flash');

  const v2 = validateServerModelForProvider('gemini', 'gemini-2.5-flash-lite');
  assert.equal(v2.valid, true);
  assert.equal(v2.model, 'gemini-2.5-flash-lite');

  const v3 = validateServerModelForProvider('gemini', 'invalid-gemini-id');
  assert.equal(v3.valid, false);
  assert.equal(v3.code, 400);

  for (const invalidId of [
    'gemini-4-hydrogen',
    'gemini-3.5-flash-lite',
    'gemini-3.5-transcribe',
    'gemini-3.8-flash',
    'gemini-3.1-flash-lite'
  ]) {
    const res = validateServerModelForProvider('gemini', invalidId);
    assert.equal(res.valid, false, `Expected ${invalidId} to be rejected by server validation`);
    assert.equal(res.code, 400);
  }
});

test('ORVIX-CRIT-05 & ORVIX-MED-03: resolveModelForProviderSwitch defaults correctly for Gemini', () => {
  assert.equal(resolveModelForProviderSwitch('gemini', null), 'gemini-2.5-flash');
  assert.equal(resolveModelForProviderSwitch('gemini', 'gemini-2.5-flash-lite'), 'gemini-2.5-flash-lite');
  assert.equal(resolveModelForProviderSwitch('gemini', 'gemini-4-hydrogen'), 'gemini-2.5-flash');
  assert.equal(resolveModelForProviderSwitch('gemini', 'unsupported-legacy-model'), 'gemini-2.5-flash');
});

