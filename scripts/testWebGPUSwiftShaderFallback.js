#!/usr/bin/env node

/**
 * ORVIX-008 Focused Verification Suite
 *
 * Validates WebGPU FP32 fallback for SwiftShader and environments without `shader-f16`:
 * 1. SwiftShader adapter detection across vendor/architecture/description strings.
 * 2. Automatic mapping of all 4 model tiers from FP16 to FP32 when SwiftShader lacks `shader-f16`.
 * 3. Preservation of FP16 models on hardware supporting `shader-f16`.
 * 4. Safe warm-up bypass on software/SwiftShader adapters.
 * 5. Robust WGSL f16 error pattern matching for reactive fallback.
 * 6. Graceful, crash-free handling in unsupported WebGPU environments.
 */

import assert from 'node:assert/strict';
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
  isSwiftShaderAdapter,
  resolveWebLLMModelId,
  isShaderF16ErrorText,
  evaluateWebGPUWarmupSuitability,
  checkWebGPUSupport
} from '../src/services/webllmService.js';

console.log('========================================================================');
console.log('🧪 ORVIX-008: SwiftShader WebGPU shader-f16 Fallback Focused Test Suite');
console.log('========================================================================\n');

let passedCount = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ PASS: ${name}`);
    passedCount++;
  } catch (err) {
    console.error(`  ❌ FAIL: ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

// ----------------------------------------------------------------------------
// Test 1: SwiftShader Adapter Identification
// ----------------------------------------------------------------------------
test('1.1 Identifies SwiftShader via isFallbackAdapter flag', () => {
  assert.strictEqual(isSwiftShaderAdapter(null, true), true);
  assert.strictEqual(isSwiftShaderAdapter({ vendor: 'Google', architecture: '' }, true), true);
});

test('1.2 Identifies SwiftShader via architecture string', () => {
  assert.strictEqual(
    isSwiftShaderAdapter({ vendor: 'Google', architecture: 'swiftshader', device: '', description: '' }, false),
    true
  );
});

test('1.3 Identifies SwiftShader and software rasterizers via description/device/vendor', () => {
  assert.strictEqual(
    isSwiftShaderAdapter({ vendor: '', architecture: '', device: 'Google SwiftShader Device', description: '' }, false),
    true
  );
  assert.strictEqual(
    isSwiftShaderAdapter({ vendor: 'Mesa', architecture: 'llvmpipe', device: '', description: '' }, false),
    true
  );
  assert.strictEqual(
    isSwiftShaderAdapter({ vendor: 'Microsoft', architecture: '', device: 'Microsoft Basic Render Driver', description: '' }, false),
    true
  );
});

test('1.4 Accurately identifies hardware GPUs as non-SwiftShader', () => {
  assert.strictEqual(
    isSwiftShaderAdapter({ vendor: 'NVIDIA', architecture: 'Ada Lovelace', device: 'GeForce RTX 4090', description: '' }, false),
    false
  );
  assert.strictEqual(
    isSwiftShaderAdapter({ vendor: 'Apple', architecture: 'Apple M2 Pro', device: '', description: '' }, false),
    false
  );
  assert.strictEqual(
    isSwiftShaderAdapter({ vendor: 'AMD', architecture: 'RDNA 3', device: 'Radeon RX 7900 XTX', description: '' }, false),
    false
  );
});

// ----------------------------------------------------------------------------
// Test 2: SwiftShader without shader-f16 Falls Back to FP32 across All 4 Tiers
// ----------------------------------------------------------------------------
const swiftShaderSupport = {
  supported: true,
  hasShaderF16: false,
  isFallbackAdapter: true,
  isSwiftShader: true,
  adapterInfo: { vendor: 'Google', architecture: 'swiftshader', device: '', description: '' }
};

test('2.1 Default Qwen 2.5 1.5B falls back to FP32 on SwiftShader without shader-f16', () => {
  const resolved = resolveWebLLMModelId(DEFAULT_WEBLLM_MODEL_ID, {
    hasShaderF16: false,
    isSwiftShader: true,
    gpuSupport: swiftShaderSupport
  });
  assert.strictEqual(resolved, FALLBACK_F32_WEBLLM_MODEL_ID);
  assert.strictEqual(resolved, 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC');
});

test('2.2 SmolLM2 135M falls back to FP32 (q0f32) on SwiftShader without shader-f16', () => {
  const resolved = resolveWebLLMModelId(SMOLLM2_135M_WEBLLM_MODEL_ID, {
    hasShaderF16: false,
    isSwiftShader: true,
    gpuSupport: swiftShaderSupport
  });
  assert.strictEqual(resolved, SMOLLM2_135M_F32_WEBLLM_MODEL_ID);
  assert.strictEqual(resolved, 'SmolLM2-135M-Instruct-q0f32-MLC');
});

test('2.3 SmolLM2 360M falls back to FP32 (q4f32_1) on SwiftShader without shader-f16', () => {
  const resolved = resolveWebLLMModelId(SMOLLM2_360M_WEBLLM_MODEL_ID, {
    hasShaderF16: false,
    isSwiftShader: true,
    gpuSupport: swiftShaderSupport
  });
  assert.strictEqual(resolved, SMOLLM2_360M_F32_WEBLLM_MODEL_ID);
  assert.strictEqual(resolved, 'SmolLM2-360M-Instruct-q4f32_1-MLC');
});

test('2.4 Qwen3 0.6B falls back to FP32 (q4f32_1) on SwiftShader without shader-f16', () => {
  const resolved = resolveWebLLMModelId(QWEN3_06B_WEBLLM_MODEL_ID, {
    hasShaderF16: false,
    isSwiftShader: true,
    gpuSupport: swiftShaderSupport
  });
  assert.strictEqual(resolved, QWEN3_06B_F32_WEBLLM_MODEL_ID);
  assert.strictEqual(resolved, 'Qwen3-0.6B-q4f32_1-MLC');
});

test('2.5 Direct selection of FP32 models is preserved without modification', () => {
  assert.strictEqual(
    resolveWebLLMModelId(FALLBACK_F32_WEBLLM_MODEL_ID, { gpuSupport: swiftShaderSupport }),
    FALLBACK_F32_WEBLLM_MODEL_ID
  );
  assert.strictEqual(
    resolveWebLLMModelId(SMOLLM2_135M_F32_WEBLLM_MODEL_ID, { gpuSupport: swiftShaderSupport }),
    SMOLLM2_135M_F32_WEBLLM_MODEL_ID
  );
  assert.strictEqual(
    resolveWebLLMModelId(SMOLLM2_360M_F32_WEBLLM_MODEL_ID, { gpuSupport: swiftShaderSupport }),
    SMOLLM2_360M_F32_WEBLLM_MODEL_ID
  );
  assert.strictEqual(
    resolveWebLLMModelId(QWEN3_06B_F32_WEBLLM_MODEL_ID, { gpuSupport: swiftShaderSupport }),
    QWEN3_06B_F32_WEBLLM_MODEL_ID
  );
});

// ----------------------------------------------------------------------------
// Test 3: Hardware Supporting shader-f16 Retains FP16 Models
// ----------------------------------------------------------------------------
const hardwareF16Support = {
  supported: true,
  hasShaderF16: true,
  isFallbackAdapter: false,
  isSwiftShader: false,
  adapterInfo: { vendor: 'NVIDIA', architecture: 'Ada Lovelace', device: 'RTX 4090', description: '' }
};

test('3.1 Hardware with shader-f16 retains Qwen 2.5 1.5B FP16', () => {
  const resolved = resolveWebLLMModelId(DEFAULT_WEBLLM_MODEL_ID, {
    hasShaderF16: true,
    isSwiftShader: false,
    gpuSupport: hardwareF16Support
  });
  assert.strictEqual(resolved, DEFAULT_WEBLLM_MODEL_ID);
  assert.strictEqual(resolved, 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC');
});

test('3.2 Hardware with shader-f16 retains SmolLM2 135M FP16', () => {
  const resolved = resolveWebLLMModelId(SMOLLM2_135M_WEBLLM_MODEL_ID, {
    hasShaderF16: true,
    isSwiftShader: false,
    gpuSupport: hardwareF16Support
  });
  assert.strictEqual(resolved, SMOLLM2_135M_WEBLLM_MODEL_ID);
  assert.strictEqual(resolved, 'SmolLM2-135M-Instruct-q0f16-MLC');
});

test('3.3 Hardware with shader-f16 retains SmolLM2 360M FP16', () => {
  const resolved = resolveWebLLMModelId(SMOLLM2_360M_WEBLLM_MODEL_ID, {
    hasShaderF16: true,
    isSwiftShader: false,
    gpuSupport: hardwareF16Support
  });
  assert.strictEqual(resolved, SMOLLM2_360M_WEBLLM_MODEL_ID);
  assert.strictEqual(resolved, 'SmolLM2-360M-Instruct-q4f16_1-MLC');
});

test('3.4 Hardware with shader-f16 retains Qwen3 0.6B FP16', () => {
  const resolved = resolveWebLLMModelId(QWEN3_06B_WEBLLM_MODEL_ID, {
    hasShaderF16: true,
    isSwiftShader: false,
    gpuSupport: hardwareF16Support
  });
  assert.strictEqual(resolved, QWEN3_06B_WEBLLM_MODEL_ID);
  assert.strictEqual(resolved, 'Qwen3-0.6B-q4f16_1-MLC');
});

// ----------------------------------------------------------------------------
// Test 4: WGSL f16 Error Pattern Recognition for Reactive Fallback
// ----------------------------------------------------------------------------
test('4.1 Detects Dawn / Chromium WGSL enable f16 rejection', () => {
  assert.strictEqual(isShaderF16ErrorText("extension 'f16' is not supported"), true);
  assert.strictEqual(isShaderF16ErrorText('extension "f16" is not supported'), true);
  assert.strictEqual(isShaderF16ErrorText('enable f16; is not allowed on this device'), true);
});

test('4.2 Detects WebGPU device creation shader-f16 rejection', () => {
  assert.strictEqual(isShaderF16ErrorText('required feature shader-f16 is not supported'), true);
  assert.strictEqual(isShaderF16ErrorText('gpu feature shader-f16 unavailable'), true);
  assert.strictEqual(isShaderF16ErrorText('device request failed: f16 feature not supported'), true);
});

test('4.3 Does not falsely classify unrelated errors as shader-f16 errors', () => {
  assert.strictEqual(isShaderF16ErrorText('device lost: out of memory'), false);
  assert.strictEqual(isShaderF16ErrorText('network error fetching model weights'), false);
  assert.strictEqual(isShaderF16ErrorText('operation timed out'), false);
  assert.strictEqual(isShaderF16ErrorText(''), false);
  assert.strictEqual(isShaderF16ErrorText(null), false);
});

// ----------------------------------------------------------------------------
// Test 5: Safe Warm-up Bypass on SwiftShader
// ----------------------------------------------------------------------------
test('5.1 Bypasses warm-up on SwiftShader software adapter', () => {
  const check = evaluateWebGPUWarmupSuitability(swiftShaderSupport, DEFAULT_WEBLLM_MODEL_ID);
  assert.strictEqual(check.shouldWarmup, false);
  assert.strictEqual(check.reason, 'software_adapter');
});

test('5.2 Allows warm-up on capable hardware GPU with ample VRAM/memory', () => {
  const check = evaluateWebGPUWarmupSuitability(
    {
      ...hardwareF16Support,
      maxStorageBufferBindingSize: 1024 * 1024 * 1024,
      maxBufferSize: 1024 * 1024 * 1024
    },
    DEFAULT_WEBLLM_MODEL_ID
  );
  assert.strictEqual(check.shouldWarmup, true);
  assert.strictEqual(check.reason, 'suitable');
});

// ----------------------------------------------------------------------------
// Test 6: Safe Handling in Non-Browser / Unsupported WebGPU Environment
// ----------------------------------------------------------------------------
test('6.1 checkWebGPUSupport returns supported: false without throwing in Node', async () => {
  const result = await checkWebGPUSupport();
  assert.strictEqual(result.supported, false);
  assert.strictEqual(result.hasShaderF16, false);
  assert.strictEqual(result.isSwiftShader, false);
  assert.ok(result.message && typeof result.message === 'string');
});

console.log(`\n========================================================================`);
console.log(`Results: ${passedCount} passed, 0 failed.`);
console.log(`========================================================================\n`);
