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

test('ORVIX-CRIT-05: Canonical Gemini model constants are correctly configured', () => {
  assert.equal(GEMINI_PRIMARY_MODEL, 'gemini-4-hydrogen');
  assert.equal(GEMINI_FALLBACK_MODEL, 'gemini-3.5-flash-lite');
  assert.deepEqual(GEMINI_FALLBACK_CANDIDATES, ['gemini-4-hydrogen', 'gemini-3.5-flash-lite']);
  assert.equal(GEMINI_MODELS_CONFIG.primary, 'gemini-4-hydrogen');
  assert.equal(GEMINI_MODELS_CONFIG.secondary, 'gemini-3.5-flash-lite');
});

test('ORVIX-CRIT-05: sanitizeModelForProvider and validateServerModelForProvider enforce valid Gemini model IDs', () => {
  // Valid active models
  assert.equal(sanitizeModelForProvider('gemini', 'gemini-4-hydrogen'), 'gemini-4-hydrogen');
  assert.equal(sanitizeModelForProvider('gemini', 'gemini-3.5-flash-lite'), 'gemini-3.5-flash-lite');
  assert.equal(sanitizeModelForProvider('gemini', 'gemini-3.5-transcribe'), 'gemini-3.5-transcribe');
  assert.equal(sanitizeModelForProvider('gemini', 'models/gemini-4-hydrogen'), 'models/gemini-4-hydrogen');

  // Deprecated/unsupported or malformed models are cleared/sanitized to null (defaulting to primary)
  assert.equal(sanitizeModelForProvider('gemini', 'gemini-2.5-flash'), null);
  assert.equal(sanitizeModelForProvider('gemini', 'unknown-model-xyz'), null);

  // Server validation tests
  const v1 = validateServerModelForProvider('gemini', 'gemini-4-hydrogen');
  assert.equal(v1.valid, true);
  assert.equal(v1.model, 'gemini-4-hydrogen');

  const v2 = validateServerModelForProvider('gemini', 'gemini-3.5-flash-lite');
  assert.equal(v2.valid, true);
  assert.equal(v2.model, 'gemini-3.5-flash-lite');

  const v3 = validateServerModelForProvider('gemini', 'invalid-gemini-id');
  assert.equal(v3.valid, false);
  assert.equal(v3.code, 400);
});

test('ORVIX-CRIT-05: resolveModelForProviderSwitch defaults correctly for Gemini', () => {
  assert.equal(resolveModelForProviderSwitch('gemini', null), 'gemini-4-hydrogen');
  assert.equal(resolveModelForProviderSwitch('gemini', 'gemini-3.5-flash-lite'), 'gemini-3.5-flash-lite');
  assert.equal(resolveModelForProviderSwitch('gemini', 'unsupported-legacy-model'), 'gemini-4-hydrogen');
});
