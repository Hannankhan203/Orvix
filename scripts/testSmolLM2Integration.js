#!/usr/bin/env node

/**
 * testSmolLM2Integration.js
 *
 * Comprehensive integration test suite for SmolLM2 360M & SmolLM2 135M in Browser AI (WebLLM).
 * Verifies:
 * 1. Model registration & WebLLM compatibility (SmolLM2 360M & SmolLM2 135M)
 * 2. Invariant: Exactly 5 providers (SmolLM2 models live inside WebLLM, NOT a new provider)
 * 3. Default model preservation: Qwen 2.5 1.5B remains default
 * 4. Cross-provider isolation & server endpoint safety
 * 5. WebGPU shader-f16 hardware detection and automatic FP32 fallback
 * 6. Model selection catalog & UI metadata
 * 7. Mocked on-device execution & 3-way model switching
 */

import assert from 'node:assert';
import {
  SUPPORTED_PROVIDER_IDS,
  CLOUD_PROVIDER_IDS,
  LOCAL_PROVIDER_IDS,
  WEBLLM_SUPPORTED_MODELS,
  PROVIDER_DEFAULT_MODELS,
  checkModelCompatibilityForProvider,
  sanitizeModelForProvider,
  validateServerModelForProvider,
  isSupportedProvider,
  normalizeProviderId
} from '../src/services/providerModelSanitizer.js';

import {
  DEFAULT_WEBLLM_MODEL_ID,
  FALLBACK_F32_WEBLLM_MODEL_ID,
  SMOLLM2_360M_WEBLLM_MODEL_ID,
  SMOLLM2_360M_F32_WEBLLM_MODEL_ID,
  SMOLLM2_135M_WEBLLM_MODEL_ID,
  SMOLLM2_135M_F32_WEBLLM_MODEL_ID,
  QWEN3_06B_WEBLLM_MODEL_ID,
  QWEN3_06B_F32_WEBLLM_MODEL_ID,
  WEBLLM_MODEL_CATALOG,
  getSupportedWebLLMModels,
  resolveWebLLMModelId,
  ensureWebLLMEngine,
  streamWebLLMMessage,
  resetWebLLMRuntimeForTesting,
  setWebLLMWorkerFactoryForTesting,
  setWebLLMEngineFactoryForTesting,
  getWebLLMState
} from '../src/services/webllmService.js';

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

async function runAsyncTest(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}:`, err.message);
    failed++;
  }
}

function setupMockBrowserEnvironment({
  hasGpu = true,
  hasShaderF16 = true,
  isSecureContext = true,
  isOnline = true
} = {}) {
  const adapter = hasGpu
    ? {
        features: new Set(hasShaderF16 ? ['shader-f16'] : []),
        limits: {
          maxStorageBufferBindingSize: 1073741824,
          maxBufferSize: 1073741824
        },
        info: {
          vendor: 'mock-vendor',
          architecture: 'mock-arch',
          description: 'Mock WebGPU Adapter'
        }
      }
    : null;

  globalThis.window = {
    isSecureContext,
    matchMedia: () => ({ matches: false })
  };

  try {
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        onLine: isOnline,
        gpu: hasGpu ? { requestAdapter: async () => adapter } : undefined,
        storage: {
          estimate: async () => ({ quota: 10 * 1024 * 1024 * 1024, usage: 100 * 1024 * 1024 }),
          persist: async () => true
        }
      },
      configurable: true,
      writable: true
    });
  } catch (_) {
    try {
      Object.defineProperty(globalThis.navigator, 'onLine', { value: isOnline, configurable: true, writable: true });
      Object.defineProperty(globalThis.navigator, 'gpu', {
        value: hasGpu ? { requestAdapter: async () => adapter } : undefined,
        configurable: true,
        writable: true
      });
    } catch (__) {}
  }

  const cacheStore = new Map();
  globalThis.caches = {
    open: async (cacheName) => ({
      keys: async () => [],
      match: async (req) => {
        const url = typeof req === 'string' ? req : req?.url;
        return cacheStore.get(`${cacheName}:${url}`) || null;
      },
      put: async (req, res) => {
        const url = typeof req === 'string' ? req : req?.url;
        cacheStore.set(`${cacheName}:${url}`, res);
      }
    }),
    has: async () => true,
    delete: async () => true
  };
}

console.log('\n--- SmolLM2 360M & 135M Integration Verification Suite ---\n');

// 1. Architecture & Provider Invariants
runTest('Invariant: Exactly 5 AI providers exist (SmolLM2 is NOT a 6th provider)', () => {
  assert.strictEqual(SUPPORTED_PROVIDER_IDS.length, 5);
  assert.deepStrictEqual([...SUPPORTED_PROVIDER_IDS], [
    'gemini',
    'groq',
    'openrouter',
    'cloudflare',
    'webllm'
  ]);
  assert.strictEqual(LOCAL_PROVIDER_IDS.length, 1);
  assert.strictEqual(LOCAL_PROVIDER_IDS[0], 'webllm');
  assert.strictEqual(isSupportedProvider('smollm'), false);
  assert.strictEqual(isSupportedProvider('smollm2'), false);
});

// 2. Qwen 2.5 1.5B Default Preservation
runTest('Preservation: Qwen 2.5 1.5B remains default Browser AI model (360M, 135M, and Qwen3 are NOT auto-default)', () => {
  assert.strictEqual(DEFAULT_WEBLLM_MODEL_ID, 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC');
  assert.strictEqual(PROVIDER_DEFAULT_MODELS.webllm, 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC');
  assert.ok(WEBLLM_MODEL_CATALOG[DEFAULT_WEBLLM_MODEL_ID]);
  assert.strictEqual(WEBLLM_MODEL_CATALOG[DEFAULT_WEBLLM_MODEL_ID].isDefault, true);
  assert.strictEqual(WEBLLM_MODEL_CATALOG[DEFAULT_WEBLLM_MODEL_ID].shortLabel, 'Qwen 2.5 1.5B');
  assert.strictEqual(WEBLLM_MODEL_CATALOG[SMOLLM2_360M_WEBLLM_MODEL_ID].isDefault, false);
  assert.strictEqual(WEBLLM_MODEL_CATALOG[SMOLLM2_135M_WEBLLM_MODEL_ID].isDefault, false);
  assert.strictEqual(WEBLLM_MODEL_CATALOG[QWEN3_06B_WEBLLM_MODEL_ID].isDefault, false);
});

// 3. SmolLM2 360M, 135M & Qwen3 0.6B Model Registration
runTest('Registration: SmolLM2 360M, 135M, and Qwen3 0.6B are present in WEBLLM_SUPPORTED_MODELS', () => {
  assert.strictEqual(SMOLLM2_360M_WEBLLM_MODEL_ID, 'SmolLM2-360M-Instruct-q4f16_1-MLC');
  assert.strictEqual(SMOLLM2_360M_F32_WEBLLM_MODEL_ID, 'SmolLM2-360M-Instruct-q4f32_1-MLC');
  assert.ok(WEBLLM_SUPPORTED_MODELS.includes(SMOLLM2_360M_WEBLLM_MODEL_ID));
  assert.ok(WEBLLM_SUPPORTED_MODELS.includes(SMOLLM2_360M_F32_WEBLLM_MODEL_ID));

  assert.strictEqual(SMOLLM2_135M_WEBLLM_MODEL_ID, 'SmolLM2-135M-Instruct-q0f16-MLC');
  assert.strictEqual(SMOLLM2_135M_F32_WEBLLM_MODEL_ID, 'SmolLM2-135M-Instruct-q0f32-MLC');
  assert.ok(WEBLLM_SUPPORTED_MODELS.includes(SMOLLM2_135M_WEBLLM_MODEL_ID));
  assert.ok(WEBLLM_SUPPORTED_MODELS.includes(SMOLLM2_135M_F32_WEBLLM_MODEL_ID));

  assert.strictEqual(QWEN3_06B_WEBLLM_MODEL_ID, 'Qwen3-0.6B-q4f16_1-MLC');
  assert.strictEqual(QWEN3_06B_F32_WEBLLM_MODEL_ID, 'Qwen3-0.6B-q4f32_1-MLC');
  assert.ok(WEBLLM_SUPPORTED_MODELS.includes(QWEN3_06B_WEBLLM_MODEL_ID));
  assert.ok(WEBLLM_SUPPORTED_MODELS.includes(QWEN3_06B_F32_WEBLLM_MODEL_ID));
});

// 4. Model Catalog Metadata
runTest('Catalog: SmolLM2 360M, 135M & Qwen3 0.6B have complete, verified metadata', () => {
  const smol360F16 = WEBLLM_MODEL_CATALOG[SMOLLM2_360M_WEBLLM_MODEL_ID];
  assert.ok(smol360F16, 'SmolLM2 360M f16 catalog entry exists');
  assert.strictEqual(smol360F16.shortLabel, 'SmolLM2 360M');
  assert.strictEqual(smol360F16.tier, 'compact');
  assert.strictEqual(smol360F16.tierLabel, 'Compact');
  assert.strictEqual(smol360F16.quantization, 'q4f16_1');
  assert.strictEqual(smol360F16.estimatedDownloadMB, 210);
  assert.strictEqual(smol360F16.vramRequiredMB, 376.06);
  assert.strictEqual(smol360F16.contextWindowSize, 4096);
  assert.strictEqual(smol360F16.f32FallbackModelId, SMOLLM2_360M_F32_WEBLLM_MODEL_ID);
  assert.strictEqual(smol360F16.isDefault, false);

  const smol360F32 = WEBLLM_MODEL_CATALOG[SMOLLM2_360M_F32_WEBLLM_MODEL_ID];
  assert.ok(smol360F32, 'SmolLM2 360M f32 catalog entry exists');
  assert.strictEqual(smol360F32.shortLabel, 'SmolLM2 360M (FP32)');
  assert.strictEqual(smol360F32.tier, 'compact-f32');
  assert.strictEqual(smol360F32.quantization, 'q4f32_1');
  assert.strictEqual(smol360F32.estimatedDownloadMB, 210);
  assert.strictEqual(smol360F32.vramRequiredMB, 579.61);
  assert.strictEqual(smol360F32.f32FallbackModelId, null);
  assert.strictEqual(smol360F32.isDefault, false);

  const f16 = WEBLLM_MODEL_CATALOG[SMOLLM2_135M_WEBLLM_MODEL_ID];
  assert.ok(f16, 'SmolLM2 135M f16 catalog entry exists');
  assert.strictEqual(f16.shortLabel, 'SmolLM2 135M');
  assert.strictEqual(f16.tier, 'ultra-lightweight');
  assert.strictEqual(f16.quantization, 'q0f16');
  assert.strictEqual(f16.estimatedDownloadMB, 270);
  assert.strictEqual(f16.vramRequiredMB, 359.69);
  assert.strictEqual(f16.contextWindowSize, 4096);
  assert.strictEqual(f16.f32FallbackModelId, SMOLLM2_135M_F32_WEBLLM_MODEL_ID);
  assert.strictEqual(f16.isDefault, false);

  const f32 = WEBLLM_MODEL_CATALOG[SMOLLM2_135M_F32_WEBLLM_MODEL_ID];
  assert.ok(f32, 'SmolLM2 135M f32 catalog entry exists');
  assert.strictEqual(f32.shortLabel, 'SmolLM2 135M (FP32)');
  assert.strictEqual(f32.tier, 'ultra-lightweight-f32');
  assert.strictEqual(f32.quantization, 'q0f32');
  assert.strictEqual(f32.f32FallbackModelId, null);

  const q3f16 = WEBLLM_MODEL_CATALOG[QWEN3_06B_WEBLLM_MODEL_ID];
  assert.ok(q3f16, 'Qwen3 0.6B f16 catalog entry exists');
  assert.strictEqual(q3f16.shortLabel, 'Qwen3 0.6B');
  assert.strictEqual(q3f16.tier, 'lightweight');
  assert.strictEqual(q3f16.quantization, 'q4f16_1');
  assert.strictEqual(q3f16.estimatedDownloadMB, 335);
  assert.strictEqual(q3f16.vramRequiredMB, 1403.34);
  assert.strictEqual(q3f16.contextWindowSize, 4096);
  assert.strictEqual(q3f16.f32FallbackModelId, QWEN3_06B_F32_WEBLLM_MODEL_ID);
  assert.strictEqual(q3f16.isDefault, false);

  const q3f32 = WEBLLM_MODEL_CATALOG[QWEN3_06B_F32_WEBLLM_MODEL_ID];
  assert.ok(q3f32, 'Qwen3 0.6B f32 catalog entry exists');
  assert.strictEqual(q3f32.shortLabel, 'Qwen3 0.6B (FP32)');
  assert.strictEqual(q3f32.tier, 'lightweight-f32');
  assert.strictEqual(q3f32.quantization, 'q4f32_1');
  assert.strictEqual(q3f32.estimatedDownloadMB, 335);
  assert.strictEqual(q3f32.vramRequiredMB, 1924.98);
  assert.strictEqual(q3f32.f32FallbackModelId, null);
  assert.strictEqual(q3f32.isDefault, false);
});

// 5. Compatibility Verification for webllm provider
runTest('Compatibility: checkModelCompatibilityForProvider accepts SmolLM2 360M & 135M', () => {
  const check360F16 = checkModelCompatibilityForProvider('webllm', 'SmolLM2-360M-Instruct-q4f16_1-MLC');
  assert.strictEqual(check360F16.compatible, true);
  assert.strictEqual(check360F16.normalizedModel, 'SmolLM2-360M-Instruct-q4f16_1-MLC');

  const check360Lower = checkModelCompatibilityForProvider('webllm', 'smollm2-360m-instruct-q4f16_1-mlc');
  assert.strictEqual(check360Lower.compatible, true);
  assert.strictEqual(check360Lower.normalizedModel, 'SmolLM2-360M-Instruct-q4f16_1-MLC');

  const check360F32 = checkModelCompatibilityForProvider('webllm', 'SmolLM2-360M-Instruct-q4f32_1-MLC');
  assert.strictEqual(check360F32.compatible, true);
  assert.strictEqual(check360F32.normalizedModel, 'SmolLM2-360M-Instruct-q4f32_1-MLC');

  // UI display label rejection safety for 360M
  const uiLabel360 = checkModelCompatibilityForProvider('webllm', 'Browser AI (WebLLM) — SmolLM2 360M');
  assert.strictEqual(uiLabel360.compatible, false);

  const checkF16 = checkModelCompatibilityForProvider('webllm', 'SmolLM2-135M-Instruct-q0f16-MLC');
  assert.strictEqual(checkF16.compatible, true);
  assert.strictEqual(checkF16.normalizedModel, 'SmolLM2-135M-Instruct-q0f16-MLC');

  // Case-insensitive normalization
  const checkLower = checkModelCompatibilityForProvider('webllm', 'smollm2-135m-instruct-q0f16-mlc');
  assert.strictEqual(checkLower.compatible, true);
  assert.strictEqual(checkLower.normalizedModel, 'SmolLM2-135M-Instruct-q0f16-MLC');

  const checkF32 = checkModelCompatibilityForProvider('webllm', 'SmolLM2-135M-Instruct-q0f32-MLC');
  assert.strictEqual(checkF32.compatible, true);
  assert.strictEqual(checkF32.normalizedModel, 'SmolLM2-135M-Instruct-q0f32-MLC');
});

// 6. Cross-Provider Rejection
runTest('Cross-Provider: SmolLM2 360M & 135M are rejected for cloud providers', () => {
  for (const provider of ['gemini', 'groq', 'openrouter', 'cloudflare']) {
    for (const localModel of [
      'SmolLM2-360M-Instruct-q4f16_1-MLC',
      'SmolLM2-360M-Instruct-q4f32_1-MLC',
      'SmolLM2-135M-Instruct-q0f16-MLC'
    ]) {
      const check = checkModelCompatibilityForProvider(provider, localModel);
      assert.strictEqual(check.compatible, false, `${provider} must reject ${localModel}`);
      assert.strictEqual(sanitizeModelForProvider(provider, localModel), null);
    }
  }
});

// 7. Server Validation
runTest('Server Safety: validateServerModelForProvider rejects SmolLM2 360M & 135M on cloud providers', () => {
  for (const provider of ['gemini', 'groq', 'openrouter', 'cloudflare']) {
    for (const localModel of ['SmolLM2-360M-Instruct-q4f16_1-MLC', 'SmolLM2-135M-Instruct-q0f16-MLC']) {
      const res = validateServerModelForProvider(provider, localModel);
      assert.strictEqual(res.valid, false, `${provider} server validator must reject ${localModel}`);
      assert.strictEqual(res.code, 400);
    }
  }
});

// 8. Hardware Fallback & Resolution
runTest('Hardware Resolution: shader-f16 fallback for SmolLM2 360M & 135M', () => {
  // SmolLM2 360M WITH shader-f16 -> q4f16_1
  assert.strictEqual(
    resolveWebLLMModelId('SmolLM2-360M-Instruct-q4f16_1-MLC', { hasShaderF16: true }),
    'SmolLM2-360M-Instruct-q4f16_1-MLC'
  );
  // SmolLM2 360M WITHOUT shader-f16 -> q4f32_1
  assert.strictEqual(
    resolveWebLLMModelId('SmolLM2-360M-Instruct-q4f16_1-MLC', {
      hasShaderF16: false,
      allowF32Fallback: true
    }),
    'SmolLM2-360M-Instruct-q4f32_1-MLC'
  );

  // Device WITH shader-f16 gets q0f16 for 135M
  const f16Resolved = resolveWebLLMModelId('SmolLM2-135M-Instruct-q0f16-MLC', {
    hasShaderF16: true
  });
  assert.strictEqual(f16Resolved, 'SmolLM2-135M-Instruct-q0f16-MLC');

  // Device WITHOUT shader-f16 gets q0f32 for 135M
  const f32Resolved = resolveWebLLMModelId('SmolLM2-135M-Instruct-q0f16-MLC', {
    hasShaderF16: false,
    allowF32Fallback: true
  });
  assert.strictEqual(f32Resolved, 'SmolLM2-135M-Instruct-q0f32-MLC');

  // Empty model resolves to default Qwen
  const defaultResolved = resolveWebLLMModelId(null, { hasShaderF16: true });
  assert.strictEqual(defaultResolved, DEFAULT_WEBLLM_MODEL_ID);
});

// 9. UI Dropdown List
runTest('UI Options: getSupportedWebLLMModels returns Qwen 1.5B, SmolLM2 360M, SmolLM2 135M, and Qwen3 0.6B', () => {
  const models = getSupportedWebLLMModels();
  assert.strictEqual(models.length, 4);
  const ids = models.map((m) => m.id);
  assert.deepStrictEqual(ids, [
    DEFAULT_WEBLLM_MODEL_ID,
    SMOLLM2_360M_WEBLLM_MODEL_ID,
    SMOLLM2_135M_WEBLLM_MODEL_ID,
    QWEN3_06B_WEBLLM_MODEL_ID
  ]);
});

function createMockWorker() {
  const listeners = { message: [], error: [], messageerror: [] };
  return {
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage: () => {},
    terminate: () => {},
    addEventListener: (type, cb) => {
      listeners[type]?.push(cb);
    },
    removeEventListener: (type, cb) => {
      const arr = listeners[type];
      if (arr) {
        const idx = arr.indexOf(cb);
        if (idx !== -1) arr.splice(idx, 1);
      }
    }
  };
}

// 10. Execution Simulation
await runAsyncTest('Execution: Mocked engine initializes with SmolLM2 135M', async () => {
  setupMockBrowserEnvironment();
  resetWebLLMRuntimeForTesting();

  let initializedModel = null;
  const mockEngine = {
    chat: {
      completions: {
        create: async (params) => {
          return (async function* () {
            yield { choices: [{ delta: { content: 'SmolLM2 offline response' } }] };
          })();
        }
      }
    },
    interruptGenerate: () => {},
    unload: async () => {}
  };

  setWebLLMWorkerFactoryForTesting(() => createMockWorker());
  setWebLLMEngineFactoryForTesting(async ({ modelId, handleInitProgress }) => {
    initializedModel = modelId;
    if (typeof handleInitProgress === 'function') {
      handleInitProgress({ progress: 1, text: 'Model loaded' });
    }
    return mockEngine;
  });

  // Initialize specifically with SmolLM2
  await ensureWebLLMEngine({
    modelId: SMOLLM2_135M_WEBLLM_MODEL_ID,
    allowF32Fallback: false
  });

  assert.strictEqual(initializedModel, SMOLLM2_135M_WEBLLM_MODEL_ID);
  const state = getWebLLMState();
  assert.strictEqual(state.status, 'ready');
  assert.strictEqual(state.modelId, SMOLLM2_135M_WEBLLM_MODEL_ID);

  // Test streaming chat
  let streamed = '';
  const res = await streamWebLLMMessage({
    prompt: 'Hello',
    modelId: SMOLLM2_135M_WEBLLM_MODEL_ID,
    onChunk: (chunk) => {
      streamed += chunk;
    }
  });

  assert.strictEqual(streamed, 'SmolLM2 offline response');
  assert.strictEqual(res.text, 'SmolLM2 offline response');
  assert.strictEqual(res.modelUsed, SMOLLM2_135M_WEBLLM_MODEL_ID);

  resetWebLLMRuntimeForTesting();
});

// 11. Execution Simulation for SmolLM2 360M (including FP32 fallback when shader-f16 is absent)
await runAsyncTest('Execution: Mocked engine initializes & streams with SmolLM2 360M (f16 & f32 fallback)', async () => {
  setupMockBrowserEnvironment({ hasShaderF16: true });
  resetWebLLMRuntimeForTesting();

  let initializedModel = null;
  const mockEngine = {
    chat: {
      completions: {
        create: async () =>
          (async function* () {
            yield { choices: [{ delta: { content: 'SmolLM2 360M compact offline response' } }] };
          })()
      }
    },
    interruptGenerate: () => {},
    unload: async () => {}
  };

  setWebLLMWorkerFactoryForTesting(() => createMockWorker());
  setWebLLMEngineFactoryForTesting(async ({ modelId, handleInitProgress }) => {
    initializedModel = modelId;
    if (typeof handleInitProgress === 'function') {
      handleInitProgress({ progress: 1, text: 'Model loaded' });
    }
    return mockEngine;
  });

  await ensureWebLLMEngine({
    modelId: SMOLLM2_360M_WEBLLM_MODEL_ID,
    allowF32Fallback: false
  });

  assert.strictEqual(initializedModel, SMOLLM2_360M_WEBLLM_MODEL_ID);
  assert.strictEqual(getWebLLMState().status, 'ready');
  assert.strictEqual(getWebLLMState().modelId, SMOLLM2_360M_WEBLLM_MODEL_ID);

  let streamed = '';
  const res = await streamWebLLMMessage({
    prompt: 'Summarize offline mode',
    model: SMOLLM2_360M_WEBLLM_MODEL_ID,
    onChunk: (chunk) => {
      streamed += chunk;
    }
  });
  assert.strictEqual(streamed, 'SmolLM2 360M compact offline response');
  assert.strictEqual(res.modelUsed, SMOLLM2_360M_WEBLLM_MODEL_ID);

  // Verify automatic q4f32_1 fallback when GPU lacks shader-f16
  resetWebLLMRuntimeForTesting();
  setupMockBrowserEnvironment({ hasShaderF16: false });
  setWebLLMWorkerFactoryForTesting(() => createMockWorker());
  setWebLLMEngineFactoryForTesting(async ({ modelId, handleInitProgress }) => {
    initializedModel = modelId;
    handleInitProgress?.({ progress: 1, text: 'Model loaded' });
    return mockEngine;
  });

  await ensureWebLLMEngine({ modelId: SMOLLM2_360M_WEBLLM_MODEL_ID });
  assert.strictEqual(initializedModel, SMOLLM2_360M_F32_WEBLLM_MODEL_ID);
  assert.strictEqual(getWebLLMState().hasShaderF16, false);
  assert.strictEqual(getWebLLMState().modelId, SMOLLM2_360M_F32_WEBLLM_MODEL_ID);

  resetWebLLMRuntimeForTesting();
});

// 12. 3-Way Model Switching Between Qwen 2.5 1.5B, SmolLM2 360M, and SmolLM2 135M
await runAsyncTest('Switching: Seamless transition across Qwen 1.5B, SmolLM2 360M, and SmolLM2 135M', async () => {
  setupMockBrowserEnvironment();
  resetWebLLMRuntimeForTesting();

  const loadedModels = [];
  const mockEngine = {
    chat: {
      completions: {
        create: async () => {
          const current = loadedModels[loadedModels.length - 1];
          return (async function* () {
            yield { choices: [{ delta: { content: `Response from ${current}` } }] };
          })();
        }
      }
    },
    interruptGenerate: () => {},
    unload: async () => {}
  };

  setWebLLMWorkerFactoryForTesting(() => createMockWorker());
  setWebLLMEngineFactoryForTesting(async ({ modelId, handleInitProgress }) => {
    loadedModels.push(modelId);
    if (typeof handleInitProgress === 'function') {
      handleInitProgress({ progress: 1, text: 'Model loaded' });
    }
    return mockEngine;
  });

  // 1. Start with default Qwen 2.5 1.5B
  await ensureWebLLMEngine({ modelId: DEFAULT_WEBLLM_MODEL_ID });
  assert.strictEqual(getWebLLMState().modelId, DEFAULT_WEBLLM_MODEL_ID);

  // 2. Switch to SmolLM2 360M
  await ensureWebLLMEngine({ modelId: SMOLLM2_360M_WEBLLM_MODEL_ID });
  assert.strictEqual(getWebLLMState().modelId, SMOLLM2_360M_WEBLLM_MODEL_ID);

  // 3. Switch to SmolLM2 135M
  await ensureWebLLMEngine({ modelId: SMOLLM2_135M_WEBLLM_MODEL_ID });
  assert.strictEqual(getWebLLMState().modelId, SMOLLM2_135M_WEBLLM_MODEL_ID);

  // 4. Switch to Qwen3 0.6B
  await ensureWebLLMEngine({ modelId: QWEN3_06B_WEBLLM_MODEL_ID });
  assert.strictEqual(getWebLLMState().modelId, QWEN3_06B_WEBLLM_MODEL_ID);

  // 5. Switch back to Qwen 2.5 1.5B
  await ensureWebLLMEngine({ modelId: DEFAULT_WEBLLM_MODEL_ID });
  assert.strictEqual(getWebLLMState().modelId, DEFAULT_WEBLLM_MODEL_ID);

  assert.deepStrictEqual(loadedModels, [
    DEFAULT_WEBLLM_MODEL_ID,
    SMOLLM2_360M_WEBLLM_MODEL_ID,
    SMOLLM2_135M_WEBLLM_MODEL_ID,
    QWEN3_06B_WEBLLM_MODEL_ID,
    DEFAULT_WEBLLM_MODEL_ID
  ]);

  resetWebLLMRuntimeForTesting();
});

console.log(`\nResults: ${passed} passed, ${failed} failed.\n`);
if (failed > 0) {
  process.exit(1);
}
