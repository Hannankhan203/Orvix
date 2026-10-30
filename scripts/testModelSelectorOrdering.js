/**
 * Test Suite: AI Provider and Model Selector Ordering Verification (v0.2.9)
 *
 * Validates:
 * 1. Exact sequence of Cloud AI Providers:
 *    1. Gemini
 *    2. Groq
 *    3. OpenRouter
 *    4. Cloudflare Workers AI
 * 2. Exact sequence of Browser AI Models:
 *    1. SmolLM2 135M
 *    2. SmolLM2 360M
 *    3. Qwen3 0.6B
 *    4. Qwen 2.5 1.5B
 * 3. Default Browser AI model MUST remain Qwen 2.5 1.5B (Qwen2.5-1.5B-Instruct-q4f16_1-MLC).
 * 4. Distinct sections separating Cloud AI Providers and Browser AI models in selectors.
 * 5. Reorder-only invariant: no provider or model added, removed, renamed, or replaced.
 * 6. Model guidance messages, routing logic, and configurations preserved without change.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import {
  PROVIDER_OPTIONS,
  AI_PROVIDERS,
  DEFAULT_PROVIDER
} from '../src/services/aiRouter.js';
import {
  CLOUD_PROVIDER_IDS,
  SUPPORTED_PROVIDER_IDS,
  PROVIDER_DEFAULT_MODELS
} from '../src/services/providerModelSanitizer.js';
import {
  DEFAULT_WEBLLM_MODEL_ID,
  SMOLLM2_135M_WEBLLM_MODEL_ID,
  SMOLLM2_360M_WEBLLM_MODEL_ID,
  QWEN3_06B_WEBLLM_MODEL_ID,
  WEBLLM_MODEL_CATALOG,
  getSupportedWebLLMModels
} from '../src/services/webllmService.js';
import {
  AI_PROVIDER_GUIDANCE,
  BROWSER_AI_MODEL_GUIDANCE,
  getAISelectionGuidance
} from '../src/config/aiGuidance.js';

let total = 0;
let passed = 0;

function test(description, fn) {
  total++;
  try {
    fn();
    passed++;
    console.log(`  ✓ ${description}`);
  } catch (err) {
    console.error(`  ✗ ${description}`);
    console.error(`    ${err.message}`);
    throw err;
  }
}

console.log('\n--- Running AI Provider and Model Selector Ordering Test Suite (v0.2.9) ---');

// 1. Cloud AI Providers Exact Sequence
test('1. Cloud AI providers appear in exact sequence: Gemini -> Groq -> OpenRouter -> Cloudflare', () => {
  const cloudProviders = PROVIDER_OPTIONS.filter((p) => p.id !== 'webllm');
  assert.strictEqual(cloudProviders.length, 4, 'Must have exactly 4 cloud providers');
  assert.strictEqual(cloudProviders[0].id, AI_PROVIDERS.GEMINI);
  assert.strictEqual(cloudProviders[0].name, 'Gemini');
  assert.strictEqual(cloudProviders[1].id, AI_PROVIDERS.GROQ);
  assert.strictEqual(cloudProviders[1].name, 'Groq');
  assert.strictEqual(cloudProviders[2].id, AI_PROVIDERS.OPENROUTER);
  assert.strictEqual(cloudProviders[2].name, 'OpenRouter');
  assert.strictEqual(cloudProviders[3].id, AI_PROVIDERS.CLOUDFLARE);
  assert.strictEqual(cloudProviders[3].name, 'Cloudflare Workers AI');

  // Verify CLOUD_PROVIDER_IDS constant matches exact sequence
  assert.deepStrictEqual([...CLOUD_PROVIDER_IDS], [
    'gemini',
    'groq',
    'openrouter',
    'cloudflare'
  ]);
});

// 2. Browser AI Models Exact Sequence
test('2. Browser AI models appear in exact sequence: SmolLM2 135M -> SmolLM2 360M -> Qwen3 0.6B -> Qwen 2.5 1.5B', () => {
  const models = getSupportedWebLLMModels();
  assert.strictEqual(models.length, 4, 'Must have exactly 4 user-selectable Browser AI models');
  assert.strictEqual(models[0].id, SMOLLM2_135M_WEBLLM_MODEL_ID);
  assert.strictEqual(models[0].shortLabel, 'SmolLM2 135M');
  assert.strictEqual(models[1].id, SMOLLM2_360M_WEBLLM_MODEL_ID);
  assert.strictEqual(models[1].shortLabel, 'SmolLM2 360M');
  assert.strictEqual(models[2].id, QWEN3_06B_WEBLLM_MODEL_ID);
  assert.strictEqual(models[2].shortLabel, 'Qwen3 0.6B');
  assert.strictEqual(models[3].id, DEFAULT_WEBLLM_MODEL_ID);
  assert.strictEqual(models[3].shortLabel, 'Qwen 2.5 1.5B');
});

// 3. Default Browser AI Model Invariant
test('3. Default Browser AI model remains strictly Qwen 2.5 1.5B', () => {
  assert.strictEqual(DEFAULT_WEBLLM_MODEL_ID, 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC');
  assert.strictEqual(PROVIDER_DEFAULT_MODELS.webllm, DEFAULT_WEBLLM_MODEL_ID);
  assert.strictEqual(WEBLLM_MODEL_CATALOG[DEFAULT_WEBLLM_MODEL_ID].isDefault, true);
  assert.strictEqual(WEBLLM_MODEL_CATALOG[SMOLLM2_135M_WEBLLM_MODEL_ID].isDefault, false);
  assert.strictEqual(WEBLLM_MODEL_CATALOG[SMOLLM2_360M_WEBLLM_MODEL_ID].isDefault, false);
  assert.strictEqual(WEBLLM_MODEL_CATALOG[QWEN3_06B_WEBLLM_MODEL_ID].isDefault, false);
});

// 4. Default Provider Invariant
test('4. Default overall provider remains strictly Gemini', () => {
  assert.strictEqual(DEFAULT_PROVIDER, AI_PROVIDERS.GEMINI);
  assert.strictEqual(PROVIDER_OPTIONS[0].id, AI_PROVIDERS.GEMINI);
});

// 5. Section Separation in ModelSelector.jsx
test('5. ModelSelector.jsx defines distinct optgroup sections for Cloud AI and Browser AI', () => {
  const code = fs.readFileSync(
    path.resolve(process.cwd(), 'src/components/chat/ModelSelector.jsx'),
    'utf8'
  );
  assert.ok(
    code.includes('<optgroup label="Cloud AI Providers">'),
    'ModelSelector must define Cloud AI Providers optgroup'
  );
  assert.ok(
    code.includes('<optgroup label="Browser AI (Offline)">'),
    'ModelSelector must define Browser AI optgroup'
  );
  assert.ok(
    code.includes('cloudProviders.map'),
    'ModelSelector must map cloud providers within their optgroup'
  );
  assert.ok(
    code.includes('browserProviders.map'),
    'ModelSelector must map browser providers within their optgroup'
  );
});

// 6. Section Separation in BrowserAIStatusBar.jsx
test('6. BrowserAIStatusBar.jsx defines optgroup for Browser AI Models', () => {
  const code = fs.readFileSync(
    path.resolve(process.cwd(), 'src/components/chat/BrowserAIStatusBar.jsx'),
    'utf8'
  );
  assert.ok(
    code.includes('<optgroup label="Browser AI Models">'),
    'BrowserAIStatusBar must define Browser AI Models optgroup'
  );
  assert.ok(
    code.includes('modelOptions.map'),
    'BrowserAIStatusBar must render modelOptions in selector'
  );
});

// 7. Styling for optgroups in index.css
test('7. index.css styles optgroup elements for both model selectors', () => {
  const css = fs.readFileSync(
    path.resolve(process.cwd(), 'src/styles/index.css'),
    'utf8'
  );
  assert.ok(
    css.includes('.model-selector-select optgroup') && css.includes('.browser-ai-model-select optgroup'),
    'index.css must provide explicit styling for model-selector optgroups'
  );
});

// 8. Reorder-Only Invariant: No Providers Added, Removed, or Renamed
test('8. Reorder-only invariant: exact 5 providers preserved with original names and model tags', () => {
  assert.strictEqual(PROVIDER_OPTIONS.length, 5);
  const ids = PROVIDER_OPTIONS.map((p) => p.id);
  assert.deepStrictEqual(ids, ['gemini', 'groq', 'openrouter', 'cloudflare', 'webllm']);

  assert.strictEqual(PROVIDER_OPTIONS[0].name, 'Gemini');
  assert.strictEqual(PROVIDER_OPTIONS[0].modelTag, 'Gemini 3.8 Flash');

  assert.strictEqual(PROVIDER_OPTIONS[1].name, 'Groq');
  assert.strictEqual(PROVIDER_OPTIONS[1].modelTag, 'GPT OSS 120B');

  assert.strictEqual(PROVIDER_OPTIONS[2].name, 'OpenRouter');
  assert.strictEqual(PROVIDER_OPTIONS[2].modelTag, 'Free Models Router');

  assert.strictEqual(PROVIDER_OPTIONS[3].name, 'Cloudflare Workers AI');
  assert.strictEqual(PROVIDER_OPTIONS[3].modelTag, 'Llama 3.1 8B');

  assert.strictEqual(PROVIDER_OPTIONS[4].name, 'Browser AI (WebLLM)');
  assert.strictEqual(PROVIDER_OPTIONS[4].modelTag, 'Qwen 2.5 1.5B');
});

// 9. Reorder-Only Invariant: Exact 4 Browser AI models preserved with original labels
test('9. Reorder-only invariant: exact 4 Browser AI models preserved with original labels', () => {
  const models = getSupportedWebLLMModels();
  assert.strictEqual(models.length, 4);

  assert.strictEqual(models[0].shortLabel, 'SmolLM2 135M');
  assert.strictEqual(models[0].tier, 'ultra-lightweight');

  assert.strictEqual(models[1].shortLabel, 'SmolLM2 360M');
  assert.strictEqual(models[1].tier, 'compact');

  assert.strictEqual(models[2].shortLabel, 'Qwen3 0.6B');
  assert.strictEqual(models[2].tier, 'lightweight');

  assert.strictEqual(models[3].shortLabel, 'Qwen 2.5 1.5B');
  assert.strictEqual(models[3].tier, 'standard');
});

// 10. Guidance UX Integrity Preserved
test('10. Static guidance UX messages resolve correctly for all reordered options', () => {
  // Cloud providers in new sequence
  assert.ok(getAISelectionGuidance('gemini').includes('Powerful general-purpose AI'));
  assert.ok(getAISelectionGuidance('groq').includes('Fast cloud AI'));
  assert.ok(getAISelectionGuidance('openrouter').includes('Flexible cloud AI'));
  assert.ok(getAISelectionGuidance('cloudflare').includes('Cloud AI running through Cloudflare'));

  // Browser AI models in new sequence
  assert.ok(getAISelectionGuidance('webllm', SMOLLM2_135M_WEBLLM_MODEL_ID).includes('Ultra-lightweight Browser AI'));
  assert.ok(getAISelectionGuidance('webllm', SMOLLM2_360M_WEBLLM_MODEL_ID).includes('Lightweight Browser AI — offers a good balance'));
  assert.ok(getAISelectionGuidance('webllm', QWEN3_06B_WEBLLM_MODEL_ID).includes('Lightweight Browser AI — provides stronger response quality'));
  assert.ok(getAISelectionGuidance('webllm', DEFAULT_WEBLLM_MODEL_ID).includes('Balanced Browser AI choice'));
});

console.log(`\nAll ${passed}/${total} AI Provider and Model Selector Ordering tests passed successfully!\n`);
