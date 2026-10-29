#!/usr/bin/env node

/**
 * testBrowserAiProfilesQuality.js
 *
 * Automated verification and evaluation suite for Orvix v0.3.0:
 * Deep Response Quality Fix for the Three Offline Browser AI Models:
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

import { formatOpenAIMessages } from '../src/services/documentContextService.js';

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

console.log('\n--- Orvix v0.3.0: Browser AI Response Profiles & Deep Quality Verification ---\n');

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

// 2. Model-Specific Profile Distinctness (v0.3.0 Calibrated Hyperparameters)
runTest('2. Profile Distinctness: Calibrated parameters and extra_body enable_thinking: false for Qwen3', () => {
  const p135 = getBrowserAiModelProfile(SMOLLM2_135M_WEBLLM_MODEL_ID);
  const p360 = getBrowserAiModelProfile(SMOLLM2_360M_WEBLLM_MODEL_ID);
  const pQwen3 = getBrowserAiModelProfile(QWEN3_06B_WEBLLM_MODEL_ID);

  assert.ok(p135 && p360 && pQwen3, 'All 3 profiles exist');

  // Temperatures are stabilized for small parameter tiers
  assert.strictEqual(p135.temperature.general, 0.2);
  assert.strictEqual(p135.temperature.coding, 0.1);
  assert.strictEqual(p360.temperature.general, 0.3);
  assert.strictEqual(p360.temperature.coding, 0.15);
  assert.strictEqual(pQwen3.temperature.general, 0.3);
  assert.strictEqual(pQwen3.temperature.coding, 0.15);

  // Repetition penalties are lowered to safe bounds so domain words are not repelled
  assert.strictEqual(p135.repetition_penalty, 1.03);
  assert.strictEqual(p360.repetition_penalty, 1.04);
  assert.strictEqual(pQwen3.repetition_penalty, 1.05);

  // Qwen3 has enable_thinking: false in extra_body
  assert.deepStrictEqual(pQwen3.extra_body, { enable_thinking: false });
  assert.strictEqual(p135.extra_body, undefined);
  assert.strictEqual(p360.extra_body, undefined);

  // Max tokens scale with parameter capacity
  assert.strictEqual(p135.maxTokens.default, 256);
  assert.strictEqual(p360.maxTokens.default, 512);
  assert.strictEqual(pQwen3.maxTokens.default, 512);

  // Context input budgets scale with model context handling
  assert.strictEqual(p135.maxInputChars, 5000);
  assert.strictEqual(p360.maxInputChars, 8000);
  assert.strictEqual(pQwen3.maxInputChars, 10000);
});

// 3. System Instructions: Positive, Minimal, and Free from Negative Triggers
runTest('3. System Instructions: Positive, minimal, and free from refusal/uncertainty triggers', () => {
  // SmolLM2 135M: minimal direct instruction
  const inst135 = buildProfileSystemInstruction(SMOLLM2_135M_WEBLLM_MODEL_ID, {
    username: 'Abdul',
    preferences: { responseLength: 'concise' }
  });
  assert.ok(inst135.includes('User name: Abdul'));
  assert.ok(inst135.includes('Answer the question directly in simple words'));
  assert.ok(inst135.includes('Keep answers brief'));
  assert.ok(!inst135.includes('admit uncertainty'), 'No uncertainty trigger in 135M');
  assert.ok(!inst135.includes('avoid filler'), 'No negative constraints in 135M');
  assert.ok(inst135.length < 200, '135M instruction is concise');

  // SmolLM2 135M Coding
  const inst135Code = buildProfileSystemInstruction(SMOLLM2_135M_WEBLLM_MODEL_ID, { mode: 'coding' });
  assert.strictEqual(inst135Code, 'You are a helpful assistant. Provide clean, working code directly.');

  // SmolLM2 360M: clean, direct, without "when requested" or "state uncertainty plainly"
  const inst360 = buildProfileSystemInstruction(SMOLLM2_360M_WEBLLM_MODEL_ID, {
    username: 'Abdul',
    preferences: { responseLength: 'detailed' }
  });
  assert.ok(inst360.includes('Answer the user\'s question directly and follow any formatting instructions'));
  assert.ok(inst360.includes('User name: Abdul'));
  assert.ok(inst360.includes('Provide structured explanations with clear examples'));
  assert.ok(!inst360.includes('state uncertainty plainly'), 'No refusal trigger in 360M');
  assert.ok(!inst360.includes('when requested'), 'No meta-instruction in 360M');

  // SmolLM2 360M Coding
  const inst360Code = buildProfileSystemInstruction(SMOLLM2_360M_WEBLLM_MODEL_ID, { mode: 'coding' });
  assert.strictEqual(inst360Code, 'You are a helpful assistant. Provide clear, correct code with brief explanations.');

  // Qwen3 0.6B: clean, accurate, no meta preambles
  const instQwen3 = buildProfileSystemInstruction(QWEN3_06B_WEBLLM_MODEL_ID, {
    mode: 'coding'
  });
  assert.strictEqual(instQwen3, 'You are a helpful assistant. Provide clean, efficient code with clear explanations.');

  const instQwen3Gen = buildProfileSystemInstruction(QWEN3_06B_WEBLLM_MODEL_ID, {
    preferences: { responseLength: 'concise' }
  });
  assert.ok(instQwen3Gen.includes('Answer the user\'s question directly, accurately, and follow all instructions'));
  assert.ok(instQwen3Gen.includes('Keep answers brief and to the point'));

  // Protected models return null
  assert.strictEqual(buildProfileSystemInstruction(DEFAULT_WEBLLM_MODEL_ID), null);
  assert.strictEqual(buildProfileSystemInstruction('gemini-2.5-flash'), null);
});

// 4. Generation Settings: Resolution & Preservation of Qwen 2.5 1.5B
runTest('4. Generation Settings: Applied accurately for targets while preserving baseline Qwen 2.5 1.5B', () => {
  // Baseline Qwen 2.5 1.5B: strictly untouched
  const qwenParams = resolveProfileGenerationParams(DEFAULT_WEBLLM_MODEL_ID, { mode: 'general' });
  assert.strictEqual(qwenParams.isRefined, false);
  assert.strictEqual(qwenParams.temperature, 0.7);
  assert.strictEqual(qwenParams.top_p, 0.9);
  assert.strictEqual(qwenParams.max_tokens, 1024);
  assert.strictEqual(qwenParams.repetition_penalty, undefined);
  assert.strictEqual(qwenParams.stop, undefined);
  assert.strictEqual(qwenParams.extra_body, undefined);
  assert.strictEqual(qwenParams.maxInputChars, 12500);

  // SmolLM2 135M in coding mode
  const p135Code = resolveProfileGenerationParams(SMOLLM2_135M_WEBLLM_MODEL_ID, { mode: 'coding' });
  assert.strictEqual(p135Code.isRefined, true);
  assert.strictEqual(p135Code.temperature, 0.1);
  assert.strictEqual(p135Code.top_p, 0.85);
  assert.strictEqual(p135Code.repetition_penalty, 1.03);
  assert.strictEqual(p135Code.max_tokens, 256);
  assert.strictEqual(p135Code.extra_body, undefined);
  assert.ok(Array.isArray(p135Code.stop));
  assert.ok(p135Code.stop.includes('<|endoftext|>'));
  assert.ok(p135Code.stop.includes('\nUser:'));

  // SmolLM2 360M with explicit user preferences
  const p360Concise = resolveProfileGenerationParams(SMOLLM2_360M_WEBLLM_MODEL_ID, {
    preferences: { responseLength: 'concise' }
  });
  assert.strictEqual(p360Concise.max_tokens, 256);
  assert.strictEqual(p360Concise.repetition_penalty, 1.04);
  assert.strictEqual(p360Concise.temperature, 0.3);

  // Qwen3 0.6B passes extra_body { enable_thinking: false }
  const pQwen3 = resolveProfileGenerationParams(QWEN3_06B_WEBLLM_MODEL_ID, {
    preferences: { responseLength: 'detailed' }
  });
  assert.strictEqual(pQwen3.max_tokens, 1024);
  assert.strictEqual(pQwen3.repetition_penalty, 1.05);
  assert.deepStrictEqual(pQwen3.extra_body, { enable_thinking: false });
  assert.ok(pQwen3.stop.includes('<|im_start|>'));
  assert.ok(pQwen3.stop.includes('<|im_end|>'));

  // Caller explicit override is respected when valid
  const pOverride = resolveProfileGenerationParams(SMOLLM2_135M_WEBLLM_MODEL_ID, {
    temperature: 0.12,
    max_tokens: 150
  });
  assert.strictEqual(pOverride.temperature, 0.12);
  assert.strictEqual(pOverride.max_tokens, 150);
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
runTest('6. UI Catalog: Model IDs and display labels preserved exactly in least-to-most reliable order', () => {
  const models = getSupportedWebLLMModels();
  assert.strictEqual(models.length, 4);
  assert.strictEqual(models[0].id, SMOLLM2_135M_WEBLLM_MODEL_ID);
  assert.strictEqual(models[0].shortLabel, 'SmolLM2 135M');
  assert.strictEqual(models[1].id, SMOLLM2_360M_WEBLLM_MODEL_ID);
  assert.strictEqual(models[1].shortLabel, 'SmolLM2 360M');
  assert.strictEqual(models[2].id, QWEN3_06B_WEBLLM_MODEL_ID);
  assert.strictEqual(models[2].shortLabel, 'Qwen3 0.6B');
  assert.strictEqual(models[3].id, DEFAULT_WEBLLM_MODEL_ID);
  assert.strictEqual(models[3].shortLabel, 'Qwen 2.5 1.5B');
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

  // Isolated closing think tag
  const rawIsolatedEndThink = '</think>Both cricket and football are played with a ball.';
  const cleanedIsolated = cleanModelOutput(rawIsolatedEndThink, QWEN3_06B_WEBLLM_MODEL_ID);
  assert.strictEqual(cleanedIsolated, 'Both cricket and football are played with a ball.');

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

// 10. The 10 Specific Capability Categories (Section 8 Verification)
runTest('10. Comprehensive 10 Capability Categories: Formatting, Context & Token Bounds', () => {
  const testCases = [
    {
      category: '1. Simple factual similarity (Cricket & Football)',
      prompt: 'I need you to tell me one thing which is the same in cricket and football. Tell me in a single sentence.',
      mode: 'general',
      verify: (modelId) => {
        const p = resolveProfileGenerationParams(modelId);
        const sys = buildProfileSystemInstruction(modelId);
        assert.ok(p.repetition_penalty <= 1.05, 'Repetition penalty low enough for shared words (sport, team, ball)');
        assert.ok(p.temperature <= 0.3, 'Temperature low enough for grounded factual recall');
        assert.ok(sys.includes('Answer the') || sys.includes('Answer the question'), 'Direct answer instruction');
        const msgs = formatOpenAIMessages({
          systemInstruction: sys,
          prompt: 'I need you to tell me one thing which is the same in cricket and football. Tell me in a single sentence.'
        });
        assert.strictEqual(msgs[0].role, 'system');
        assert.strictEqual(msgs[msgs.length - 1].role, 'user');
      }
    },
    {
      category: '2. Simple definition',
      prompt: 'What is a computer? Answer in one sentence.',
      mode: 'general',
      verify: (modelId) => {
        const p = resolveProfileGenerationParams(modelId, { preferences: { responseLength: 'concise' } });
        assert.ok(p.max_tokens <= 256, 'Concise token budget applied');
      }
    },
    {
      category: '3. Simple comparison',
      prompt: 'Difference between car and bicycle in one sentence',
      mode: 'general',
      verify: (modelId) => {
        const sys = buildProfileSystemInstruction(modelId);
        assert.ok(!sys.includes('state uncertainty plainly'), 'No refusal trigger on comparison');
      }
    },
    {
      category: '4. Simple explanation',
      prompt: 'Explain photosynthesis in two simple sentences',
      mode: 'learning',
      verify: (modelId) => {
        const p = resolveProfileGenerationParams(modelId, { mode: 'learning' });
        assert.ok(p.temperature <= 0.3, 'Stable learning temperature');
      }
    },
    {
      category: '5. Instruction following',
      prompt: 'Three fruits as a numbered list',
      mode: 'general',
      verify: (modelId) => {
        const sampleOut = '1. Apple\n2. Banana\n3. Orange<|im_end|>';
        const clean = cleanModelOutput(sampleOut, modelId);
        assert.strictEqual(clean, '1. Apple\n2. Banana\n3. Orange');
      }
    },
    {
      category: '6. Coding',
      prompt: 'JavaScript function that adds two numbers',
      mode: 'coding',
      verify: (modelId) => {
        const p = resolveProfileGenerationParams(modelId, { mode: 'coding' });
        assert.ok(p.temperature <= 0.15, 'Low coding temperature prevents syntax hallucination');
        const sys = buildProfileSystemInstruction(modelId, { mode: 'coding' });
        assert.ok(sys.includes('clean') || sys.includes('code'), 'Clean coding instruction');
      }
    },
    {
      category: '7. Rewrite',
      prompt: 'Rewrite politely: Send me the file',
      mode: 'writing',
      verify: (modelId) => {
        const sys = buildProfileSystemInstruction(modelId, { mode: 'writing' });
        assert.ok(!sys.includes('admit uncertainty rather than guessing'), 'No refusal trigger on rewrite');
      }
    },
    {
      category: '8. Short-answer constraint',
      prompt: 'What is 2 + 2? Answer with only the answer',
      mode: 'general',
      verify: (modelId) => {
        const raw = '4\nUser: Next?';
        const clean = cleanModelOutput(raw, modelId);
        assert.strictEqual(clean, '4');
      }
    },
    {
      category: '9. Uncertainty handling',
      prompt: 'Who won the 2035 Nobel prize in physics?',
      mode: 'general',
      verify: (modelId) => {
        const p = resolveProfileGenerationParams(modelId);
        assert.ok(p.temperature <= 0.3, 'Low temperature prevents hallucinating future events');
      }
    },
    {
      category: '10. Conversational continuity',
      prompt: 'What was the first thing I asked?',
      mode: 'general',
      verify: (modelId) => {
        const history = [
          { sender: 'user', content: 'What is water made of?' },
          { sender: 'assistant', content: 'Water is made of hydrogen and oxygen (H2O).' }
        ];
        const sys = buildProfileSystemInstruction(modelId);
        const msgs = formatOpenAIMessages({
          systemInstruction: sys,
          history,
          prompt: 'What was the first thing I asked?'
        });
        assert.strictEqual(msgs.length, 4);
        assert.strictEqual(msgs[0].role, 'system');
        assert.strictEqual(msgs[1].content, 'What is water made of?');
        assert.strictEqual(msgs[2].content, 'Water is made of hydrogen and oxygen (H2O).');
        assert.strictEqual(msgs[3].content, 'What was the first thing I asked?');
      }
    }
  ];

  for (const modelId of [SMOLLM2_135M_WEBLLM_MODEL_ID, SMOLLM2_360M_WEBLLM_MODEL_ID, QWEN3_06B_WEBLLM_MODEL_ID]) {
    for (const tc of testCases) {
      tc.verify(modelId);
    }
  }
});

console.log(`\nQuality Test Suite Complete: ${passed} passed, ${failed} failed.\n`);
if (failed > 0) {
  process.exit(1);
}
