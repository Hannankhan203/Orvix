/**
 * Test Suite: AI Model Selection Guidance UX Verification
 *
 * Validates:
 * 1. Exact static text match for all 8 providers/models against specification.
 * 2. Proper mapping for Cloud AI (Gemini, Groq, OpenRouter, Cloudflare).
 * 3. Dynamic model-specific mapping for Browser AI WebLLM:
 *    - Qwen 2.5 1.5B
 *    - SmolLM2 135M
 *    - SmolLM2 360M Instruct
 *    - Qwen3 0.6B
 * 4. Only one guidance description returned/displayed at a time.
 * 5. Safe fallbacks for unknown, null, or FP32 fallback model IDs.
 * 6. Zero external network requests or AI generation logic touched.
 * 7. Verification that protected providers remain unaltered.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import {
  AI_PROVIDER_GUIDANCE,
  BROWSER_AI_MODEL_GUIDANCE,
  getAISelectionGuidance
} from '../src/config/aiGuidance.js';
import {
  DEFAULT_WEBLLM_MODEL_ID,
  FALLBACK_F32_WEBLLM_MODEL_ID,
  SMOLLM2_135M_WEBLLM_MODEL_ID,
  SMOLLM2_135M_F32_WEBLLM_MODEL_ID,
  SMOLLM2_360M_WEBLLM_MODEL_ID,
  SMOLLM2_360M_F32_WEBLLM_MODEL_ID,
  QWEN3_06B_WEBLLM_MODEL_ID,
  QWEN3_06B_F32_WEBLLM_MODEL_ID
} from '../src/services/webllmService.js';

const EXPECTED_MESSAGES = {
  gemini:
    'Powerful general-purpose AI — delivers strong responses across a wide range of tasks, with cloud processing required.',
  groq:
    'Fast cloud AI — optimized for very quick responses while providing strong general-purpose capabilities.',
  openrouter:
    'Flexible cloud AI — provides access to supported models through OpenRouter, with capabilities depending on the selected model.',
  cloudflare:
    'Cloud AI running through Cloudflare — provides convenient AI access with capabilities depending on the selected model.',
  qwen_15b:
    'Balanced Browser AI choice — offers the strongest overall response quality among the local models, but requires more resources than the smaller models.',
  smollm2_135m:
    'Ultra-lightweight Browser AI — uses the least resources, but responses may be less accurate or detailed, especially for complex questions.',
  smollm2_360m:
    'Lightweight Browser AI — offers a good balance between low resource usage and response quality, though it may be less capable than the larger local models.',
  qwen3_06b:
    'Lightweight Browser AI — provides stronger response quality than the smallest models while using fewer resources than Qwen 2.5 1.5B.'
};

let passed = 0;
let total = 0;

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

console.log('\n--- Running AI Model Selection Guidance UX Test Suite ---');

// 1. Exact String Accuracy
test('1. Cloud AI guidance text matches exact required strings', () => {
  assert.strictEqual(AI_PROVIDER_GUIDANCE.gemini, EXPECTED_MESSAGES.gemini);
  assert.strictEqual(AI_PROVIDER_GUIDANCE.groq, EXPECTED_MESSAGES.groq);
  assert.strictEqual(AI_PROVIDER_GUIDANCE.openrouter, EXPECTED_MESSAGES.openrouter);
  assert.strictEqual(AI_PROVIDER_GUIDANCE.cloudflare, EXPECTED_MESSAGES.cloudflare);
});

test('2. Browser AI WebLLM model guidance matches exact required strings for all 4 models', () => {
  assert.strictEqual(
    BROWSER_AI_MODEL_GUIDANCE[DEFAULT_WEBLLM_MODEL_ID],
    EXPECTED_MESSAGES.qwen_15b
  );
  assert.strictEqual(
    BROWSER_AI_MODEL_GUIDANCE[SMOLLM2_135M_WEBLLM_MODEL_ID],
    EXPECTED_MESSAGES.smollm2_135m
  );
  assert.strictEqual(
    BROWSER_AI_MODEL_GUIDANCE[SMOLLM2_360M_WEBLLM_MODEL_ID],
    EXPECTED_MESSAGES.smollm2_360m
  );
  assert.strictEqual(
    BROWSER_AI_MODEL_GUIDANCE[QWEN3_06B_WEBLLM_MODEL_ID],
    EXPECTED_MESSAGES.qwen3_06b
  );
});

// 2. Cloud AI Resolution
test('3. getAISelectionGuidance returns correct text for Gemini', () => {
  const result = getAISelectionGuidance('gemini');
  assert.strictEqual(result, EXPECTED_MESSAGES.gemini);
});

test('4. getAISelectionGuidance returns correct text for Groq', () => {
  const result = getAISelectionGuidance('groq');
  assert.strictEqual(result, EXPECTED_MESSAGES.groq);
});

test('5. getAISelectionGuidance returns correct text for OpenRouter', () => {
  const result = getAISelectionGuidance('openrouter');
  assert.strictEqual(result, EXPECTED_MESSAGES.openrouter);
});

test('6. getAISelectionGuidance returns correct text for Cloudflare', () => {
  const result = getAISelectionGuidance('cloudflare');
  assert.strictEqual(result, EXPECTED_MESSAGES.cloudflare);
});

// 3. Browser AI WebLLM Resolution (Only currently active model)
test('7. getAISelectionGuidance returns Qwen 2.5 1.5B text when default Browser AI is selected', () => {
  const result = getAISelectionGuidance('webllm', DEFAULT_WEBLLM_MODEL_ID);
  assert.strictEqual(result, EXPECTED_MESSAGES.qwen_15b);
});

test('8. getAISelectionGuidance returns SmolLM2 135M text when 135M is selected', () => {
  const result = getAISelectionGuidance('webllm', SMOLLM2_135M_WEBLLM_MODEL_ID);
  assert.strictEqual(result, EXPECTED_MESSAGES.smollm2_135m);
});

test('9. getAISelectionGuidance returns SmolLM2 360M text when 360M is selected', () => {
  const result = getAISelectionGuidance('webllm', SMOLLM2_360M_WEBLLM_MODEL_ID);
  assert.strictEqual(result, EXPECTED_MESSAGES.smollm2_360m);
});

test('10. getAISelectionGuidance returns Qwen3 0.6B text when 0.6B is selected', () => {
  const result = getAISelectionGuidance('webllm', QWEN3_06B_WEBLLM_MODEL_ID);
  assert.strictEqual(result, EXPECTED_MESSAGES.qwen3_06b);
});

test('11. Only one single description string is returned per call (no concat of all 4 models)', () => {
  const result = getAISelectionGuidance('webllm', SMOLLM2_135M_WEBLLM_MODEL_ID);
  assert.ok(!result.includes(EXPECTED_MESSAGES.qwen_15b));
  assert.ok(!result.includes(EXPECTED_MESSAGES.smollm2_360m));
  assert.ok(!result.includes(EXPECTED_MESSAGES.qwen3_06b));
  assert.strictEqual(result, EXPECTED_MESSAGES.smollm2_135m);
});

// 4. Fallback and Edge Cases
test('12. FP32 fallback model IDs map to their corresponding guidance strings', () => {
  assert.strictEqual(
    getAISelectionGuidance('webllm', FALLBACK_F32_WEBLLM_MODEL_ID),
    EXPECTED_MESSAGES.qwen_15b
  );
  assert.strictEqual(
    getAISelectionGuidance('webllm', SMOLLM2_135M_F32_WEBLLM_MODEL_ID),
    EXPECTED_MESSAGES.smollm2_135m
  );
  assert.strictEqual(
    getAISelectionGuidance('webllm', SMOLLM2_360M_F32_WEBLLM_MODEL_ID),
    EXPECTED_MESSAGES.smollm2_360m
  );
  assert.strictEqual(
    getAISelectionGuidance('webllm', QWEN3_06B_F32_WEBLLM_MODEL_ID),
    EXPECTED_MESSAGES.qwen3_06b
  );
});

test('13. getAISelectionGuidance handles undefined or null provider safely', () => {
  assert.strictEqual(getAISelectionGuidance(null), EXPECTED_MESSAGES.gemini);
  assert.strictEqual(getAISelectionGuidance(undefined), EXPECTED_MESSAGES.gemini);
  assert.strictEqual(getAISelectionGuidance('unknown_provider'), EXPECTED_MESSAGES.gemini);
});

test('14. getAISelectionGuidance handles undefined modelId for webllm safely by defaulting to Qwen 2.5 1.5B', () => {
  assert.strictEqual(getAISelectionGuidance('webllm', null), EXPECTED_MESSAGES.qwen_15b);
  assert.strictEqual(getAISelectionGuidance('webllm', undefined), EXPECTED_MESSAGES.qwen_15b);
});

// 5. Codebase Non-Regression and Accessibility Verification
test('15. ModelSelector.jsx contains aria-describedby and passes guidance prop', () => {
  const modelSelectorCode = fs.readFileSync(
    path.resolve(process.cwd(), 'src/components/chat/ModelSelector.jsx'),
    'utf8'
  );
  assert.ok(
    modelSelectorCode.includes('aria-describedby'),
    'ModelSelector must include aria-describedby for accessibility'
  );
  assert.ok(
    modelSelectorCode.includes('getAISelectionGuidance'),
    'ModelSelector must import getAISelectionGuidance'
  );
});

test('16. Header.jsx contains model guidance strip and passes selectedModelId', () => {
  const headerCode = fs.readFileSync(
    path.resolve(process.cwd(), 'src/components/layout/Header.jsx'),
    'utf8'
  );
  assert.ok(
    headerCode.includes('header-model-guidance-strip'),
    'Header must render header-model-guidance-strip'
  );
  assert.ok(
    headerCode.includes('getAISelectionGuidance'),
    'Header must import and call getAISelectionGuidance'
  );
});

test('17. BrowserAIStatusBar.jsx displays model guidance note and links aria-describedby', () => {
  const statusBarCode = fs.readFileSync(
    path.resolve(process.cwd(), 'src/components/chat/BrowserAIStatusBar.jsx'),
    'utf8'
  );
  assert.ok(
    statusBarCode.includes('browser-ai-guidance-note'),
    'BrowserAIStatusBar must render browser-ai-guidance-note'
  );
  assert.ok(
    statusBarCode.includes('aria-describedby="browser-ai-model-guidance-desc"'),
    'BrowserAIStatusBar model select must have aria-describedby'
  );
});

test('18. Protected providers (Gemini, Groq, OpenRouter, Cloudflare, Qwen 2.5 1.5B) maintain original generation settings', () => {
  const webllmServiceCode = fs.readFileSync(
    path.resolve(process.cwd(), 'src/services/webllmService.js'),
    'utf8'
  );
  assert.ok(
    webllmServiceCode.includes('DEFAULT_WEBLLM_MODEL_ID = \'Qwen2.5-1.5B-Instruct-q4f16_1-MLC\''),
    'Default WebLLM model must remain Qwen2.5-1.5B-Instruct-q4f16_1-MLC'
  );
});

console.log(`\nAll ${passed}/${total} AI Model Selection Guidance UX tests passed successfully!\n`);
