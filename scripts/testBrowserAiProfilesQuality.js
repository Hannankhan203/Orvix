#!/usr/bin/env node

/**
 * testBrowserAiProfilesQuality.js
 *
 * Automated verification and evaluation suite for Orvix v0.2.9:
 * Isolated Response Profiles, System Instructions, Generation Settings,
 * and Output Sanitization for the Three Offline Browser AI Models:
 *   1. SmolLM2 135M
 *   2. SmolLM2 360M Instruct
 *   3. Qwen3 0.6B
 *
 * Invariant Verification:
 * - Default Qwen 2.5 1.5B Instruct is completely unchanged.
 * - All four cloud providers (Gemini, Groq, OpenRouter, Cloudflare) are completely unchanged.
 */

import assert from 'node:assert';

import {
  REFINED_MODEL_KEYS,
  TARGET_REFINED_MODEL_IDS,
  isRefinedTargetModel,
  getModelProfileKey,
  getBrowserAiModelProfile,
  buildProfileSystemInstruction,
  resolveProfileGenerationParams,
  cleanModelOutput,
  createStreamingResponseSanitizer
} from '../src/services/browserAiProfiles.js';

import {
  DEFAULT_WEBLLM_MODEL_ID,
  FALLBACK_F32_WEBLLM_MODEL_ID,
  SMOLLM2_135M_WEBLLM_MODEL_ID,
  SMOLLM2_135M_F32_WEBLLM_MODEL_ID,
  SMOLLM2_360M_WEBLLM_MODEL_ID,
  SMOLLM2_360M_F32_WEBLLM_MODEL_ID,
  QWEN3_06B_WEBLLM_MODEL_ID,
  QWEN3_06B_F32_WEBLLM_MODEL_ID,
  WEBLLM_MODEL_CATALOG,
  getSupportedWebLLMModels
} from '../src/services/webllmService.js';

import {
  SUPPORTED_PROVIDER_IDS,
  PROVIDER_DEFAULT_MODELS,
  checkModelCompatibilityForProvider,
  sanitizeModelForProvider
} from '../src/services/providerModelSanitizer.js';

let passed = 0;
let failed = 0;

function runTest(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}:`, err.message);
    failed++;
  }
}

console.log('\n--- Orvix v0.2.9: Browser AI Response Profiles & Quality Verification ---\n');

// 1. Model Classification & Isolation
runTest('1. Target Model Isolation: Strictly identifies the 3 target models and rejects protected models', () => {
  // Target models (f16 and f32 variants)
  assert.strictEqual(isRefinedTargetModel('SmolLM2-135M-Instruct-q0f16-MLC'), true);
  assert.strictEqual(isRefinedTargetModel('SmolLM2-135M-Instruct-q0f32-MLC'), true);
  assert.strictEqual(isRefinedTargetModel('SmolLM2-360M-Instruct-q4f16_1-MLC'), true);
  assert.strictEqual(isRefinedTargetModel('SmolLM2-360M-Instruct-q4f32_1-MLC'), true);
  assert.strictEqual(isRefinedTargetModel('Qwen3-0.6B-q4f16_1-MLC'), true);
  assert.strictEqual(isRefinedTargetModel('Qwen3-0.6B-q4f32_1-MLC'), true);

  // Mapping to intended profile keys
  assert.strictEqual(getModelProfileKey('SmolLM2-135M-Instruct-q0f16-MLC'), REFINED_MODEL_KEYS.SMOLLM2_135M);
  assert.strictEqual(getModelProfileKey('SmolLM2-360M-Instruct-q4f16_1-MLC'), REFINED_MODEL_KEYS.SMOLLM2_360M);
  assert.strictEqual(getModelProfileKey('Qwen3-0.6B-q4f16_1-MLC'), REFINED_MODEL_KEYS.QWEN3_06B);

  // Protected models MUST return false / null
  assert.strictEqual(isRefinedTargetModel(DEFAULT_WEBLLM_MODEL_ID), false);
  assert.strictEqual(isRefinedTargetModel(FALLBACK_F32_WEBLLM_MODEL_ID), false);
  assert.strictEqual(isRefinedTargetModel('Qwen2.5-0.5B-Instruct-q4f16_1-MLC'), false);
  assert.strictEqual(isRefinedTargetModel('gemini-2.5-flash'), false);
  assert.strictEqual(isRefinedTargetModel('llama-3.3-70b-versatile'), false);
  assert.strictEqual(isRefinedTargetModel(null), false);
  assert.strictEqual(isRefinedTargetModel(''), false);

  assert.strictEqual(getModelProfileKey(DEFAULT_WEBLLM_MODEL_ID), null);
  assert.strictEqual(getBrowserAiModelProfile(DEFAULT_WEBLLM_MODEL_ID), null);
});

// 2. Model-Specific Profile Distinctness
runTest('2. Profile Distinctness: Each model has independent, non-identical hyperparameters', () => {
  const p135 = getBrowserAiModelProfile(SMOLLM2_135M_WEBLLM_MODEL_ID);
  const p360 = getBrowserAiModelProfile(SMOLLM2_360M_WEBLLM_MODEL_ID);
  const pQwen3 = getBrowserAiModelProfile(QWEN3_06B_WEBLLM_MODEL_ID);

  assert.ok(p135 && p360 && pQwen3, 'All 3 profiles exist');

  // Temperatures are differentiated based on parameter tier
  assert.strictEqual(p135.temperature.general, 0.3);
  assert.strictEqual(p135.temperature.coding, 0.15);
  assert.strictEqual(p360.temperature.general, 0.45);
  assert.strictEqual(p360.temperature.coding, 0.2);
  assert.strictEqual(pQwen3.temperature.general, 0.5);
  assert.strictEqual(pQwen3.temperature.coding, 0.25);

  // Repetition penalties are calibrated (135M highest to prevent runaway loops)
  assert.strictEqual(p135.repetition_penalty, 1.15);
  assert.strictEqual(p360.repetition_penalty, 1.10);
  assert.strictEqual(pQwen3.repetition_penalty, 1.08);

  // Max tokens scale with parameter capacity
  assert.strictEqual(p135.maxTokens.default, 448);
  assert.strictEqual(p360.maxTokens.default, 768);
  assert.strictEqual(pQwen3.maxTokens.default, 896);

  // Context input budgets scale with model context handling
  assert.strictEqual(p135.maxInputChars, 5000);
  assert.strictEqual(p360.maxInputChars, 8000);
  assert.strictEqual(pQwen3.maxInputChars, 10000);
});

// 3. System Instructions: Model-Calibrated & Free from Preamble/Canned Responses
runTest('3. System Instructions: Compact, model-appropriate, and applied only to intended models', () => {
  // SmolLM2 135M: compact, plain words, uncertainty admission
  const inst135 = buildProfileSystemInstruction(SMOLLM2_135M_WEBLLM_MODEL_ID, {
    username: 'Abdul',
    preferences: { responseLength: 'concise' }
  });
  assert.ok(inst135.includes('User name: Abdul'));
  assert.ok(inst135.includes('simple words'));
  assert.ok(inst135.includes('admit uncertainty'));
  assert.ok(inst135.includes('Keep answers very brief'));
  assert.ok(inst135.length < 350, '135M instruction is compact to preserve context');

  // SmolLM2 360M: structured, lists/code, uncertainty admission
  const inst360 = buildProfileSystemInstruction(SMOLLM2_360M_WEBLLM_MODEL_ID, {
    mode: 'coding',
    preferences: { responseLength: 'detailed' }
  });
  assert.ok(inst360.includes('concise paragraphs, clean lists, or code'));
  assert.ok(inst360.includes('Provide clean, well-formatted code blocks'));
  assert.ok(inst360.includes('state uncertainty plainly'));

  // Qwen3 0.6B: clean markdown, avoid internal thoughts, admit uncertainty
  const instQwen3 = buildProfileSystemInstruction(QWEN3_06B_WEBLLM_MODEL_ID, {
    mode: 'learning',
    preferences: { beginnerFriendly: true }
  });
  assert.ok(instQwen3.includes('Return a clean final answer with coherent logical structure'));
  assert.ok(instQwen3.includes('Avoid internal thoughts'));
  assert.ok(instQwen3.includes('Clear and approachable'));
  assert.ok(instQwen3.includes('Admit uncertainty honestly'));

  // Protected models return null
  assert.strictEqual(buildProfileSystemInstruction(DEFAULT_WEBLLM_MODEL_ID), null);
  assert.strictEqual(buildProfileSystemInstruction('gemini-2.5-flash'), null);
});

// 4. Generation Settings: Resolution & Preservation of Qwen 2.5 1.5B
runTest('4. Generation Settings: Applied accurately for targets while preserving baseline Qwen 2.5 1.5B', () => {
  // Baseline Qwen 2.5 1.5B
  const qwenParams = resolveProfileGenerationParams(DEFAULT_WEBLLM_MODEL_ID, { mode: 'general' });
  assert.strictEqual(qwenParams.isRefined, false);
  assert.strictEqual(qwenParams.temperature, 0.7);
  assert.strictEqual(qwenParams.top_p, 0.9);
  assert.strictEqual(qwenParams.max_tokens, 1024);
  assert.strictEqual(qwenParams.stop, undefined);
  assert.strictEqual(qwenParams.maxInputChars, 12500);

  // SmolLM2 135M in coding mode
  const p135Code = resolveProfileGenerationParams(SMOLLM2_135M_WEBLLM_MODEL_ID, { mode: 'coding' });
  assert.strictEqual(p135Code.isRefined, true);
  assert.strictEqual(p135Code.temperature, 0.15);
  assert.strictEqual(p135Code.top_p, 0.85);
  assert.strictEqual(p135Code.repetition_penalty, 1.15);
  assert.strictEqual(p135Code.max_tokens, 448);
  assert.ok(Array.isArray(p135Code.stop));
  assert.ok(p135Code.stop.includes('<|endoftext|>'));
  assert.ok(p135Code.stop.includes('\nUser:'));

  // SmolLM2 360M with explicit user preferences
  const p360Concise = resolveProfileGenerationParams(SMOLLM2_360M_WEBLLM_MODEL_ID, {
    preferences: { responseLength: 'concise' }
  });
  assert.strictEqual(p360Concise.max_tokens, 384);
  assert.strictEqual(p360Concise.repetition_penalty, 1.10);

  // Qwen3 0.6B with detailed preference
  const pQwen3Detailed = resolveProfileGenerationParams(QWEN3_06B_WEBLLM_MODEL_ID, {
    preferences: { responseLength: 'detailed' }
  });
  assert.strictEqual(pQwen3Detailed.max_tokens, 1280);
  assert.strictEqual(pQwen3Detailed.repetition_penalty, 1.08);
  assert.ok(pQwen3Detailed.stop.includes('<|im_start|>'));
  assert.ok(pQwen3Detailed.stop.includes('<|system|>'));

  // Caller explicit override is respected when valid
  const pOverride = resolveProfileGenerationParams(SMOLLM2_135M_WEBLLM_MODEL_ID, {
    temperature: 0.1,
    max_tokens: 120
  });
  assert.strictEqual(pOverride.temperature, 0.1);
  assert.strictEqual(pOverride.max_tokens, 120);
});

// 5. Protected Providers Invariant
runTest('5. Protected Providers: Gemini, Groq, OpenRouter, Cloudflare are untouched', () => {
  assert.strictEqual(SUPPORTED_PROVIDER_IDS.length, 5);
  assert.strictEqual(PROVIDER_DEFAULT_MODELS.gemini, 'gemini-3.8-flash');
  assert.strictEqual(PROVIDER_DEFAULT_MODELS.webllm, DEFAULT_WEBLLM_MODEL_ID);

  for (const cloud of ['gemini', 'groq', 'openrouter', 'cloudflare']) {
    const check135 = checkModelCompatibilityForProvider(cloud, SMOLLM2_135M_WEBLLM_MODEL_ID);
    const check360 = checkModelCompatibilityForProvider(cloud, SMOLLM2_360M_WEBLLM_MODEL_ID);
    const checkQ3 = checkModelCompatibilityForProvider(cloud, QWEN3_06B_WEBLLM_MODEL_ID);
    assert.strictEqual(check135.compatible, false, `${cloud} must reject SmolLM2 135M`);
    assert.strictEqual(check360.compatible, false, `${cloud} must reject SmolLM2 360M`);
    assert.strictEqual(checkQ3.compatible, false, `${cloud} must reject Qwen3 0.6B`);
  }
});

// 6. UI Catalog & Selector Labels Preservation
runTest('6. UI Catalog: Model IDs and display labels preserved exactly', () => {
  const models = getSupportedWebLLMModels();
  assert.strictEqual(models.length, 4);
  assert.strictEqual(models[0].id, DEFAULT_WEBLLM_MODEL_ID);
  assert.strictEqual(models[0].shortLabel, 'Qwen 2.5 1.5B');
  assert.strictEqual(models[1].id, SMOLLM2_360M_WEBLLM_MODEL_ID);
  assert.strictEqual(models[1].shortLabel, 'SmolLM2 360M');
  assert.strictEqual(models[2].id, SMOLLM2_135M_WEBLLM_MODEL_ID);
  assert.strictEqual(models[2].shortLabel, 'SmolLM2 135M');
  assert.strictEqual(models[3].id, QWEN3_06B_WEBLLM_MODEL_ID);
  assert.strictEqual(models[3].shortLabel, 'Qwen3 0.6B');
});

// 7. Output Cleanup: Removal of Leaked Tokens, Thinking Blocks, and Preamble Echoes
runTest('7. Output Sanitization: Strips control tokens, <think> blocks, and simulated turns', () => {
  // Leaked ChatML and EOS tokens
  const rawWithDelimiters = 'Here is the answer.<|im_end|><|im_start|>user\nWhat next?';
  const cleaned = cleanModelOutput(rawWithDelimiters, QWEN3_06B_WEBLLM_MODEL_ID);
  assert.strictEqual(cleaned, 'Here is the answer.');

  // Simulated multi-turn runaway loop
  const rawWithUserTurn = 'Water boils at 100°C.\nUser: What about altitude?\nAssistant: At high altitude...';
  const cleanedTurn = cleanModelOutput(rawWithUserTurn, SMOLLM2_135M_WEBLLM_MODEL_ID);
  assert.strictEqual(cleanedTurn, 'Water boils at 100°C.');

  // Leaked thinking tags from reasoning generation
  const rawWithThink = '<think>I need to explain photosynthesis simply.</think>Photosynthesis is how plants make food using sunlight.';
  const cleanedThink = cleanModelOutput(rawWithThink, QWEN3_06B_WEBLLM_MODEL_ID);
  assert.strictEqual(cleanedThink, 'Photosynthesis is how plants make food using sunlight.');

  // Entire response inside think tags
  const rawInsideThink = '<think>Paris is the capital of France.</think>';
  const cleanedInsideThink = cleanModelOutput(rawInsideThink, QWEN3_06B_WEBLLM_MODEL_ID);
  assert.strictEqual(cleanedInsideThink, 'Paris is the capital of France.');

  // Leading assistant echo
  const rawWithEcho = 'Assistant: The function returns 42.';
  const cleanedEcho = cleanModelOutput(rawWithEcho, SMOLLM2_360M_WEBLLM_MODEL_ID);
  assert.strictEqual(cleanedEcho, 'The function returns 42.');

  // Unrefined Qwen 2.5 1.5B is untouched
  const untouchedQwen = cleanModelOutput('Assistant: Output', DEFAULT_WEBLLM_MODEL_ID);
  assert.strictEqual(untouchedQwen, 'Assistant: Output');
});

// 8. Output Preservation: Legitimate Content Integrity
runTest('8. Content Integrity: Preserves legitimate markdown, code, lists, and punctuation', () => {
  const codeBlock = '```javascript\nfunction add(a, b) {\n  return a + b;\n}\n```\n• Result is numeric.';
  const cleanedCode = cleanModelOutput(codeBlock, QWEN3_06B_WEBLLM_MODEL_ID);
  assert.strictEqual(cleanedCode, codeBlock);

  const listContent = '1. First step\n2. Second step\n- Sub-item with punctuation: (e.g. 3.14).';
  const cleanedList = cleanModelOutput(listContent, SMOLLM2_360M_WEBLLM_MODEL_ID);
  assert.strictEqual(cleanedList, listContent);
});

// 9. Streaming Sanitizer: Turn Stops and Token Shielding
runTest('9. Streaming Sanitizer: Shields prefixes, stops on delimiters, and prevents token flash', () => {
  let streamed = '';
  let stopTriggered = false;

  const sanitizer = createStreamingResponseSanitizer(QWEN3_06B_WEBLLM_MODEL_ID, {
    onChunk: (chunk) => {
      streamed += chunk;
    },
    onStopDetected: () => {
      stopTriggered = true;
    }
  });

  // Feed chunks
  sanitizer.feed('Assistant: ');
  sanitizer.feed('The capital of Japan is Tokyo.');
  sanitizer.feed(' It is known for its modern culture.');
  sanitizer.feed('<|im_end|>');
  sanitizer.feed('User: What about Kyoto?'); // Should be stopped and not emitted
  sanitizer.flush();

  assert.strictEqual(stopTriggered, true, 'Stop detected on <|im_end|>');
  assert.strictEqual(streamed, 'The capital of Japan is Tokyo. It is known for its modern culture.');
  assert.ok(!streamed.includes('Assistant:'), 'Leading echo stripped');
  assert.ok(!streamed.includes('User:'), 'Simulated turn prevented');
});

// 10. Streaming Sanitizer: Reasoning <think> Tag Shielding
runTest('10. Streaming Sanitizer: Shields internal <think> blocks during streaming', () => {
  let streamed = '';

  const sanitizer = createStreamingResponseSanitizer(QWEN3_06B_WEBLLM_MODEL_ID, {
    onChunk: (chunk) => {
      streamed += chunk;
    }
  });

  sanitizer.feed('<think>');
  sanitizer.feed('Let me calculate 12 * 12. 12 times 10 is 120, plus 24 is 144.');
  sanitizer.feed('</think>');
  sanitizer.feed('12 * 12 = 144.');
  sanitizer.flush();

  assert.strictEqual(streamed, '12 * 12 = 144.');
  assert.ok(!streamed.includes('calculate'), 'Inner think content hidden from stream');
});

// 11. Representative Evaluation Test Scenarios (Manual Evaluation Suite Grounding)
runTest('11. Evaluation Suite: Representative prompts produce model-appropriate configs', () => {
  const scenarios = [
    {
      name: 'Simple Factual (135M)',
      modelId: SMOLLM2_135M_WEBLLM_MODEL_ID,
      prompt: 'What is the speed of light?',
      expectedMode: 'general',
      verify: (params, inst) => {
        assert.strictEqual(params.temperature, 0.3);
        assert.ok(inst.includes('simple words'));
      }
    },
    {
      name: 'Educational Explanation (360M)',
      modelId: SMOLLM2_360M_WEBLLM_MODEL_ID,
      prompt: 'Explain how solar panels generate electricity.',
      expectedMode: 'learning',
      verify: (params, inst) => {
        assert.strictEqual(params.temperature, 0.45);
        assert.ok(inst.includes('Break concepts into logical'));
      }
    },
    {
      name: 'Coding Question (Qwen3)',
      modelId: QWEN3_06B_WEBLLM_MODEL_ID,
      prompt: 'Write a Python function to check for palindromes.',
      expectedMode: 'coding',
      verify: (params, inst) => {
        assert.strictEqual(params.temperature, 0.25);
        assert.ok(inst.includes('syntax highlighting tags'));
      }
    },
    {
      name: 'Uncertainty Handling (All)',
      modelId: SMOLLM2_135M_WEBLLM_MODEL_ID,
      prompt: 'Who won the 2035 Nobel prize in physics?',
      expectedMode: 'general',
      verify: (params, inst) => {
        assert.ok(inst.includes('admit uncertainty'));
      }
    }
  ];

  for (const s of scenarios) {
    const params = resolveProfileGenerationParams(s.modelId, { mode: s.expectedMode });
    const inst = buildProfileSystemInstruction(s.modelId, { mode: s.expectedMode });
    s.verify(params, inst);
  }
});

console.log(`\nQuality Test Suite Complete: ${passed} passed, ${failed} failed.\n`);
if (failed > 0) {
  process.exit(1);
}
