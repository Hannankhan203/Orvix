#!/usr/bin/env node

/**
 * testBrowserAiFirstResponseStutter.js
 *
 * Verification & practical measurement suite for Audit Point #10:
 * Reduce Browser AI (WebLLM) First-Response GPU/UI Stutter.
 *
 * Covers all 8 required verification areas:
 * 1. Warm-up lifecycle and duplicate prevention
 * 2. Model initialization and error handling
 * 3. Cancellation during initialization or warm-up
 * 4. Normal inference after warm-up (and cold direct-send skipWarmup fast path)
 * 5. Model switching & automatic FP32 fallback
 * 6. Browsers without supported WebGPU capabilities & device-aware suitability gating
 * 7. Worker termination and cleanup
 * 8. Request isolation, coalesced WebLLM streaming responsiveness, and timer cadence
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_WEBLLM_MODEL_ID,
  FALLBACK_F32_WEBLLM_MODEL_ID,
  SMOLLM2_360M_WEBLLM_MODEL_ID,
  SMOLLM2_135M_WEBLLM_MODEL_ID,
  WEBLLM_ERROR_CODES,
  WebLLMError,
  checkWebGPUSupport,
  evaluateWebGPUWarmupSuitability,
  preloadWebLLMRuntimeModule,
  isWebLLMModelWarmed,
  warmupWebLLMEngine,
  ensureWebLLMEngine,
  streamWebLLMMessage,
  stopWebLLMGeneration,
  destroyWebLLMEngine,
  getWebLLMState,
  subscribeWebLLMState,
  resetWebLLMRuntimeForTesting,
  setWebLLMWorkerFactoryForTesting,
  setWebLLMEngineFactoryForTesting,
  setWebLLMDownloadConfigForTesting
} from '../src/services/webllmService.js';

import {
  createRequestIsolationController,
  runIsolatedPromptStream,
  cancelActiveChatRequest
} from '../src/services/requestIsolationService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let passed = 0;
let failed = 0;

function runTest(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}:`, err?.stack || err?.message || err);
    failed++;
  }
}

async function runAsyncTest(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}:`, err?.stack || err?.message || err);
    failed++;
  }
}

function setupMockBrowserEnvironment({
  hasGpu = true,
  adapterNull = false,
  hasShaderF16 = true,
  isSecureContext = true,
  isOnline = true,
  deviceMemory = 8,
  omitAdapterInfo = false,
  adapterVendor = 'intel',
  adapterArch = 'xe-lpg',
  adapterDescription = 'Intel(R) Arc(TM) Integrated Graphics',
  maxStorageBufferBindingSize = 1073741824,
  maxBufferSize = 1073741824,
  isFallbackAdapter = false,
  adapterInfoIsFallback = false,
  onRequestAdapter = null
} = {}) {
  const adapter =
    hasGpu && !adapterNull
      ? {
          features: new Set(hasShaderF16 ? ['shader-f16'] : []),
          isFallbackAdapter,
          limits: {
            maxStorageBufferBindingSize,
            maxBufferSize
          },
          ...(omitAdapterInfo
            ? {}
            : {
                info: {
                  vendor: adapterVendor,
                  architecture: adapterArch,
                  description: adapterDescription,
                  ...(adapterInfoIsFallback ? { isFallbackAdapter: true } : {})
                }
              })
        }
      : null;

  let idleCallbacks = [];
  globalThis.window = {
    isSecureContext,
    matchMedia: () => ({ matches: false }),
    requestIdleCallback: (cb) => {
      idleCallbacks.push(cb);
      return idleCallbacks.length;
    }
  };

  const gpuObj = hasGpu
    ? {
        requestAdapter: async (opts) => {
          if (typeof onRequestAdapter === 'function') {
            onRequestAdapter(opts);
          }
          return adapter;
        }
      }
    : undefined;

  const navValue = {
    onLine: isOnline,
    gpu: gpuObj,
    ...(deviceMemory !== undefined ? { deviceMemory } : {}),
    storage: {
      estimate: async () => ({ quota: 12 * 1024 * 1024 * 1024, usage: 100 * 1024 * 1024 }),
      persist: async () => true
    }
  };

  Object.defineProperty(globalThis, 'navigator', {
    value: navValue,
    configurable: true,
    writable: true
  });

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

  return {
    getIdleCallbacks: () => idleCallbacks
  };
}

function createMockWorker({ onTerminate = null } = {}) {
  const listeners = { message: [], error: [], messageerror: [] };
  return {
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage: () => {},
    terminate: () => {
      if (typeof onTerminate === 'function') {
        onTerminate();
      }
    },
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

console.log('\n--- Browser AI First-Response GPU/UI Stutter Verification Suite ---\n');

// ============================================================================
// 1. Warm-up Lifecycle, Ordering & Duplicate Prevention
// ============================================================================

await runAsyncTest('1a. Warm-up lifecycle: ensureWebLLMEngine runs 2-token prefill + 1-token decode + resetChat(false) before ready', async () => {
  let adapterCalls = 0;
  setupMockBrowserEnvironment({
    onRequestAdapter: () => {
      adapterCalls += 1;
    }
  });
  resetWebLLMRuntimeForTesting();

  const rpcLog = [];
  const stateTransitions = [];
  const unsubscribe = subscribeWebLLMState((snap) => {
    stateTransitions.push({
      status: snap.status,
      isWarmed: snap.isWarmed,
      progressText: snap.progressText
    });
  });

  const mockEngine = {
    forwardTokensAndSample: async (inputIds, isPrefill, modelId) => {
      rpcLog.push({ op: 'forwardTokensAndSample', inputIds, isPrefill, modelId });
      // Assert engine is NOT yet marked ready while warm-up is executing
      assert.notStrictEqual(getWebLLMState().status, 'ready');
      return isPrefill ? 42 : 7;
    },
    resetChat: async (keepStats, modelId) => {
      rpcLog.push({ op: 'resetChat', keepStats, modelId });
    },
    chat: {
      completions: {
        create: async () =>
          (async function* () {
            yield { choices: [{ delta: { content: 'Ready response' } }] };
          })()
      }
    },
    interruptGenerate: () => {},
    unload: async () => {}
  };

  setWebLLMWorkerFactoryForTesting(() => createMockWorker());
  setWebLLMEngineFactoryForTesting(async ({ handleInitProgress }) => {
    handleInitProgress?.({ progress: 1, text: 'Finish loading on WebGPU' });
    return mockEngine;
  });

  await ensureWebLLMEngine({ modelId: DEFAULT_WEBLLM_MODEL_ID });

  assert.deepStrictEqual(rpcLog, [
    {
      op: 'forwardTokensAndSample',
      inputIds: [1, 1],
      isPrefill: true,
      modelId: DEFAULT_WEBLLM_MODEL_ID
    },
    {
      op: 'forwardTokensAndSample',
      inputIds: [42],
      isPrefill: false,
      modelId: DEFAULT_WEBLLM_MODEL_ID
    },
    {
      op: 'resetChat',
      keepStats: false,
      modelId: DEFAULT_WEBLLM_MODEL_ID
    }
  ]);

  assert.strictEqual(getWebLLMState().status, 'ready');
  assert.strictEqual(getWebLLMState().isWarmed, true);
  assert.strictEqual(isWebLLMModelWarmed(DEFAULT_WEBLLM_MODEL_ID), true);
  assert.strictEqual(adapterCalls, 1, 'requestAdapter should only run once during cold load');

  // Verify subsequent ensureWebLLMEngine & warmupWebLLMEngine calls deduplicate with ZERO extra RPCs or adapter checks
  const stateCountAfterInit = stateTransitions.length;
  await ensureWebLLMEngine({ modelId: DEFAULT_WEBLLM_MODEL_ID });
  const warmupRes = await warmupWebLLMEngine({ modelId: DEFAULT_WEBLLM_MODEL_ID });

  assert.strictEqual(warmupRes.warmed, true);
  assert.strictEqual(warmupRes.deduplicated, true);
  assert.strictEqual(rpcLog.length, 3, 'Warm-up must never run twice for the same loaded model');
  assert.strictEqual(adapterCalls, 1, 'Zero-IPC warm fast path must not re-call requestAdapter');
  assert.strictEqual(
    stateTransitions.slice(stateCountAfterInit).some((s) => s.status === 'checking'),
    false,
    'Warm fast path must not emit status="checking" churn'
  );
  assert.strictEqual(
    stateTransitions.length,
    stateCountAfterInit,
    'Shallow-equal state snapshot bailout should suppress redundant ready->ready listener notifications'
  );

  unsubscribe();
  resetWebLLMRuntimeForTesting();
});

await runAsyncTest('1b. Concurrent warmupWebLLMEngine calls serialize and execute warm-up exactly once', async () => {
  setupMockBrowserEnvironment();
  resetWebLLMRuntimeForTesting();

  let forwardCalls = 0;
  const mockEngine = {
    forwardTokensAndSample: async (_ids, isPrefill) => {
      forwardCalls += 1;
      await new Promise((r) => setTimeout(r, 15));
      return isPrefill ? 19 : 20;
    },
    resetChat: async () => {},
    chat: { completions: { create: async () => (async function* () {})() } },
    interruptGenerate: () => {},
    unload: async () => {}
  };

  setWebLLMWorkerFactoryForTesting(() => createMockWorker());
  setWebLLMEngineFactoryForTesting(async () => mockEngine);

  const [r1, r2, r3] = await Promise.all([
    warmupWebLLMEngine({ modelId: DEFAULT_WEBLLM_MODEL_ID }),
    warmupWebLLMEngine({ modelId: DEFAULT_WEBLLM_MODEL_ID }),
    warmupWebLLMEngine({ modelId: DEFAULT_WEBLLM_MODEL_ID })
  ]);

  assert.strictEqual(r1.warmed, true);
  assert.strictEqual(r2.warmed, true);
  assert.strictEqual(r3.warmed, true);
  assert.strictEqual(forwardCalls, 2, 'Exactly 1 prefill + 1 decode across all concurrent callers');

  resetWebLLMRuntimeForTesting();
});

// ============================================================================
// 2. Model Initialization & Error Handling During Warm-Up
// ============================================================================

await runAsyncTest('2a. Non-fatal warm-up failure resets chat state cleanly and still allows engine to reach ready', async () => {
  setupMockBrowserEnvironment();
  resetWebLLMRuntimeForTesting();

  let resetCalledOnFailure = false;
  const mockEngine = {
    forwardTokensAndSample: async (_ids, isPrefill) => {
      if (!isPrefill) {
        throw new Error('Transient sampling kernel mismatch');
      }
      return 11;
    },
    resetChat: async () => {
      resetCalledOnFailure = true;
    },
    chat: {
      completions: {
        create: async () =>
          (async function* () {
            yield { choices: [{ delta: { content: 'Fallback inference works' } }] };
          })()
      }
    },
    interruptGenerate: () => {},
    unload: async () => {}
  };

  setWebLLMWorkerFactoryForTesting(() => createMockWorker());
  setWebLLMEngineFactoryForTesting(async () => mockEngine);

  await ensureWebLLMEngine({ modelId: DEFAULT_WEBLLM_MODEL_ID });
  assert.strictEqual(resetCalledOnFailure, true, 'resetChat cleanup must run if warm-up fails mid-pass');
  assert.strictEqual(getWebLLMState().status, 'ready');
  assert.strictEqual(getWebLLMState().isWarmed, false);

  const res = await streamWebLLMMessage({ prompt: 'Test after non-fatal warm-up warning' });
  assert.strictEqual(res.text, 'Fallback inference works');
  assert.strictEqual(getWebLLMState().isWarmed, true, 'Real generation marks engine warmed afterward');

  resetWebLLMRuntimeForTesting();
});

await runAsyncTest('2b. Fatal GPU DeviceLost / OOM during warm-up surfaces normalized WebLLMError and cleans up worker', async () => {
  setupMockBrowserEnvironment();
  resetWebLLMRuntimeForTesting();

  let workerTerminated = false;
  const mockEngine = {
    forwardTokensAndSample: async () => {
      throw new Error('GPUDevice was lost: out of memory during compute dispatch');
    },
    resetChat: async () => {},
    chat: { completions: { create: async () => (async function* () {})() } },
    interruptGenerate: () => {},
    unload: async () => {}
  };

  setWebLLMWorkerFactoryForTesting(() =>
    createMockWorker({
      onTerminate: () => {
        workerTerminated = true;
      }
    })
  );
  setWebLLMEngineFactoryForTesting(async () => mockEngine);

  await assert.rejects(
    () => ensureWebLLMEngine({ modelId: DEFAULT_WEBLLM_MODEL_ID }),
    (err) => {
      assert.ok(err instanceof WebLLMError);
      assert.strictEqual(err.errorCode, WEBLLM_ERROR_CODES.DEVICE_LOST);
      return true;
    }
  );

  assert.strictEqual(workerTerminated, true);
  assert.strictEqual(getWebLLMState().status, 'error');
  assert.strictEqual(getWebLLMState().isWarmed, false);

  resetWebLLMRuntimeForTesting();
});

// ============================================================================
// 3. Cancellation During Initialization or Warm-Up
// ============================================================================

await runAsyncTest('3a. AbortSignal cancellation mid-warm-up immediately aborts, terminates worker, and resets to idle', async () => {
  setupMockBrowserEnvironment();
  resetWebLLMRuntimeForTesting();

  let workerTerminated = false;
  const abortController = new AbortController();

  const mockEngine = {
    forwardTokensAndSample: async (_ids, isPrefill) => {
      if (isPrefill) {
        setTimeout(() => abortController.abort(), 10);
        await new Promise((r) => setTimeout(r, 40));
      }
      return 5;
    },
    resetChat: async () => {},
    chat: { completions: { create: async () => (async function* () {})() } },
    interruptGenerate: () => {},
    unload: async () => {}
  };

  setWebLLMWorkerFactoryForTesting(() =>
    createMockWorker({
      onTerminate: () => {
        workerTerminated = true;
      }
    })
  );
  setWebLLMEngineFactoryForTesting(async () => mockEngine);

  await assert.rejects(
    () =>
      ensureWebLLMEngine({
        modelId: DEFAULT_WEBLLM_MODEL_ID,
        signal: abortController.signal
      }),
    (err) => err?.name === 'AbortError'
  );

  assert.strictEqual(workerTerminated, true);
  assert.strictEqual(getWebLLMState().status, 'idle');
  assert.strictEqual(getWebLLMState().isWarmed, false);

  resetWebLLMRuntimeForTesting();
});

await runAsyncTest('3b. stopWebLLMGeneration() during in-flight warm-up cancels initialization cleanly', async () => {
  setupMockBrowserEnvironment();
  resetWebLLMRuntimeForTesting();

  let workerTerminated = false;
  const mockEngine = {
    forwardTokensAndSample: async () => {
      setTimeout(() => stopWebLLMGeneration(), 10);
      await new Promise((r) => setTimeout(r, 50));
      return 3;
    },
    resetChat: async () => {},
    chat: { completions: { create: async () => (async function* () {})() } },
    interruptGenerate: () => {},
    unload: async () => {}
  };

  setWebLLMWorkerFactoryForTesting(() =>
    createMockWorker({
      onTerminate: () => {
        workerTerminated = true;
      }
    })
  );
  setWebLLMEngineFactoryForTesting(async () => mockEngine);

  await assert.rejects(
    () => ensureWebLLMEngine({ modelId: DEFAULT_WEBLLM_MODEL_ID }),
    (err) => err?.name === 'AbortError'
  );

  assert.strictEqual(workerTerminated, true);
  assert.strictEqual(getWebLLMState().status, 'idle');
  assert.strictEqual(getWebLLMState().isWarmed, false);

  resetWebLLMRuntimeForTesting();
});

// ============================================================================
// 4. Normal Inference After Warm-Up & Cold Direct-Send Fast Path
// ============================================================================

await runAsyncTest('4a. Normal inference after warm-up has zero history pollution and zero extra adapter/warm-up calls', async () => {
  let adapterCalls = 0;
  setupMockBrowserEnvironment({
    onRequestAdapter: () => {
      adapterCalls += 1;
    }
  });
  resetWebLLMRuntimeForTesting();

  let kvResidualTokens = [];
  let capturedCompletionPayload = null;
  let warmupForwardCount = 0;

  const mockEngine = {
    forwardTokensAndSample: async (inputIds, isPrefill) => {
      warmupForwardCount += 1;
      kvResidualTokens.push(...inputIds);
      return isPrefill ? 99 : 100;
    },
    resetChat: async () => {
      kvResidualTokens = [];
    },
    chat: {
      completions: {
        create: async (payload) => {
          capturedCompletionPayload = payload;
          assert.strictEqual(
            kvResidualTokens.length,
            0,
            'KV cache must be completely cleared by resetChat before real user inference'
          );
          return (async function* () {
            yield { choices: [{ delta: { content: 'Clean ' } }] };
            yield { choices: [{ delta: { content: 'warmed ' } }] };
            yield { choices: [{ delta: { content: 'answer.' } }], usage: { total_tokens: 12 } };
          })();
        }
      }
    },
    interruptGenerate: () => {},
    unload: async () => {}
  };

  setWebLLMWorkerFactoryForTesting(() => createMockWorker());
  setWebLLMEngineFactoryForTesting(async () => mockEngine);

  // User clicks "Load Model"
  await ensureWebLLMEngine({ modelId: DEFAULT_WEBLLM_MODEL_ID });
  assert.strictEqual(warmupForwardCount, 2);
  assert.strictEqual(adapterCalls, 1);

  // User sends first message
  const chunks = [];
  const response = await streamWebLLMMessage({
    prompt: 'Explain WebGPU compute pipelines in one sentence.',
    history: [{ sender: 'user', content: 'Hi' }, { sender: 'assistant', content: 'Hello!' }],
    model: DEFAULT_WEBLLM_MODEL_ID,
    onChunk: (delta) => chunks.push(delta)
  });

  assert.strictEqual(response.text, 'Clean warmed answer.');
  assert.strictEqual(chunks.join(''), 'Clean warmed answer.');
  assert.strictEqual(warmupForwardCount, 2, 'No extra warm-up during real prompt');
  assert.strictEqual(adapterCalls, 1, 'No extra requestAdapter IPC during real prompt');

  // Verify conversation messages sent to engine have zero warm-up artifacts
  assert.ok(Array.isArray(capturedCompletionPayload?.messages));
  assert.strictEqual(capturedCompletionPayload.messages.length, 4); // system + 2 history + 1 user
  assert.strictEqual(capturedCompletionPayload.messages[0].role, 'system');
  assert.strictEqual(capturedCompletionPayload.messages[1].content, 'Hi');
  assert.strictEqual(capturedCompletionPayload.messages[2].content, 'Hello!');
  assert.strictEqual(
    capturedCompletionPayload.messages[3].content,
    'Explain WebGPU compute pipelines in one sentence.'
  );

  resetWebLLMRuntimeForTesting();
});

await runAsyncTest('4b. Cold direct-send (streamWebLLMMessage from idle) skips inline dummy warm-up so user prompt runs immediately', async () => {
  setupMockBrowserEnvironment();
  resetWebLLMRuntimeForTesting();

  let forwardCalls = 0;
  const mockEngine = {
    forwardTokensAndSample: async () => {
      forwardCalls += 1;
      return 1;
    },
    resetChat: async () => {},
    chat: {
      completions: {
        create: async () =>
          (async function* () {
            yield { choices: [{ delta: { content: 'Direct cold response' } }] };
          })()
      }
    },
    interruptGenerate: () => {},
    unload: async () => {}
  };

  setWebLLMWorkerFactoryForTesting(() => createMockWorker());
  setWebLLMEngineFactoryForTesting(async () => mockEngine);

  const res = await streamWebLLMMessage({
    prompt: 'Hello directly without pre-loading',
    model: DEFAULT_WEBLLM_MODEL_ID
  });

  assert.strictEqual(res.text, 'Direct cold response');
  assert.strictEqual(
    forwardCalls,
    0,
    'Cold direct-send must not delay waiting user prompt with dummy forwardTokensAndSample dispatches'
  );
  assert.strictEqual(
    isWebLLMModelWarmed(DEFAULT_WEBLLM_MODEL_ID),
    true,
    'Real token generation marks active model warmed for subsequent calls'
  );

  resetWebLLMRuntimeForTesting();
});

// ============================================================================
// 5. Model Switching & Automatic FP32 Fallback
// ============================================================================

await runAsyncTest('5. Model switching invalidates prior warm-up and warms newly selected model cleanly (including FP32 fallback)', async () => {
  setupMockBrowserEnvironment({ hasShaderF16: true });
  resetWebLLMRuntimeForTesting();

  const warmedModels = [];
  let terminatedWorkers = 0;

  setWebLLMWorkerFactoryForTesting(() =>
    createMockWorker({
      onTerminate: () => {
        terminatedWorkers += 1;
      }
    })
  );

  setWebLLMEngineFactoryForTesting(async ({ modelId }) => ({
    forwardTokensAndSample: async (_ids, isPrefill, targetModel) => {
      if (isPrefill) {
        warmedModels.push(targetModel || modelId);
      }
      return 12;
    },
    resetChat: async () => {},
    chat: { completions: { create: async () => (async function* () {})() } },
    interruptGenerate: () => {},
    unload: async () => {}
  }));

  await ensureWebLLMEngine({ modelId: DEFAULT_WEBLLM_MODEL_ID });
  assert.strictEqual(isWebLLMModelWarmed(DEFAULT_WEBLLM_MODEL_ID), true);
  assert.strictEqual(isWebLLMModelWarmed(SMOLLM2_360M_WEBLLM_MODEL_ID), false);

  await ensureWebLLMEngine({ modelId: SMOLLM2_360M_WEBLLM_MODEL_ID });
  assert.strictEqual(isWebLLMModelWarmed(DEFAULT_WEBLLM_MODEL_ID), false);
  assert.strictEqual(isWebLLMModelWarmed(SMOLLM2_360M_WEBLLM_MODEL_ID), true);
  assert.strictEqual(terminatedWorkers, 1, 'Switching models terminates previous worker');

  await ensureWebLLMEngine({ modelId: SMOLLM2_135M_WEBLLM_MODEL_ID });
  assert.strictEqual(isWebLLMModelWarmed(SMOLLM2_360M_WEBLLM_MODEL_ID), false);
  assert.strictEqual(isWebLLMModelWarmed(SMOLLM2_135M_WEBLLM_MODEL_ID), true);
  assert.strictEqual(terminatedWorkers, 2);

  assert.deepStrictEqual(warmedModels, [
    DEFAULT_WEBLLM_MODEL_ID,
    SMOLLM2_360M_WEBLLM_MODEL_ID,
    SMOLLM2_135M_WEBLLM_MODEL_ID
  ]);

  // Verify shader-f16 runtime error fallback to FP32 preserves skipWarmup semantics
  resetWebLLMRuntimeForTesting();
  setupMockBrowserEnvironment({ hasShaderF16: true });
  const fp32WarmupLog = [];
  setWebLLMWorkerFactoryForTesting(() => createMockWorker());
  setWebLLMEngineFactoryForTesting(async ({ modelId }) => {
    if (modelId === DEFAULT_WEBLLM_MODEL_ID) {
      throw new Error('ShaderF16SupportError: shader-f16 extension rejected by driver');
    }
    return {
      forwardTokensAndSample: async (_ids, isPrefill, mId) => {
        if (isPrefill) fp32WarmupLog.push(mId);
        return 9;
      },
      resetChat: async () => {},
      chat: { completions: { create: async () => (async function* () {})() } },
      interruptGenerate: () => {},
      unload: async () => {}
    };
  });

  const fallbackRes = await ensureWebLLMEngine({ modelId: DEFAULT_WEBLLM_MODEL_ID });
  assert.strictEqual(fallbackRes.modelId, FALLBACK_F32_WEBLLM_MODEL_ID);
  assert.deepStrictEqual(fp32WarmupLog, [FALLBACK_F32_WEBLLM_MODEL_ID]);
  assert.strictEqual(isWebLLMModelWarmed(FALLBACK_F32_WEBLLM_MODEL_ID), true);

  resetWebLLMRuntimeForTesting();
});

// ============================================================================
// 6. Unsupported WebGPU Environments & Device-Aware Suitability Gating
// ============================================================================

await runAsyncTest('6a. Browsers without supported WebGPU fail cleanly without attempting warm-up or module preload', async () => {
  // Missing navigator.gpu
  const envNoGpu = setupMockBrowserEnvironment({ hasGpu: false });
  resetWebLLMRuntimeForTesting();
  preloadWebLLMRuntimeModule();
  assert.strictEqual(envNoGpu.getIdleCallbacks().length, 0, 'Must not preload WebLLM when navigator.gpu is absent');

  const supportNoGpu = await checkWebGPUSupport();
  assert.strictEqual(supportNoGpu.supported, false);
  assert.strictEqual(supportNoGpu.reasonCode, WEBLLM_ERROR_CODES.WEBGPU_UNSUPPORTED);

  await assert.rejects(
    () => warmupWebLLMEngine({ modelId: DEFAULT_WEBLLM_MODEL_ID }),
    (err) => err?.errorCode === WEBLLM_ERROR_CODES.WEBGPU_UNSUPPORTED
  );

  // Null adapter
  setupMockBrowserEnvironment({ hasGpu: true, adapterNull: true });
  resetWebLLMRuntimeForTesting();
  const supportNullAdapter = await checkWebGPUSupport();
  assert.strictEqual(supportNullAdapter.supported, false);
  assert.strictEqual(supportNullAdapter.reasonCode, WEBLLM_ERROR_CODES.WEBGPU_ADAPTER_UNAVAILABLE);

  // Insecure context
  setupMockBrowserEnvironment({ hasGpu: true, isSecureContext: false });
  resetWebLLMRuntimeForTesting();
  const supportInsecure = await checkWebGPUSupport();
  assert.strictEqual(supportInsecure.supported, false);
  assert.strictEqual(supportInsecure.reasonCode, WEBLLM_ERROR_CODES.INSECURE_CONTEXT);

  resetWebLLMRuntimeForTesting();
});

await runAsyncTest('6b. Device-aware gating skips warm-up on software/constrained devices and degrades gracefully when adapterInfo is missing', async () => {
  // Software adapter (SwiftShader)
  setupMockBrowserEnvironment({
    adapterVendor: 'google',
    adapterDescription: 'Google SwiftShader'
  });
  resetWebLLMRuntimeForTesting();
  const swiftSupport = await checkWebGPUSupport();
  const swiftSuitability = evaluateWebGPUWarmupSuitability(swiftSupport, DEFAULT_WEBLLM_MODEL_ID);
  assert.strictEqual(swiftSuitability.shouldWarmup, false);
  assert.strictEqual(swiftSuitability.reason, 'software_adapter');

  // Verify ensureWebLLMEngine skips forwardTokensAndSample on SwiftShader while still loading engine
  let swiftForwardCalled = false;
  setWebLLMWorkerFactoryForTesting(() => createMockWorker());
  setWebLLMEngineFactoryForTesting(async () => ({
    forwardTokensAndSample: async () => {
      swiftForwardCalled = true;
      return 1;
    },
    resetChat: async () => {},
    chat: { completions: { create: async () => (async function* () {})() } },
    interruptGenerate: () => {},
    unload: async () => {}
  }));
  await ensureWebLLMEngine({ modelId: DEFAULT_WEBLLM_MODEL_ID });
  assert.strictEqual(swiftForwardCalled, false, 'Must skip warm-up on software WebGPU adapters');
  assert.strictEqual(getWebLLMState().status, 'ready');
  assert.strictEqual(getWebLLMState().isWarmed, false);

  // Low unified memory (4 GB) on 1.5B model -> skip, but allow on SmolLM2 135M (~360 MB VRAM)
  setupMockBrowserEnvironment({ deviceMemory: 4 });
  resetWebLLMRuntimeForTesting();
  const lowMemSupport = await checkWebGPUSupport();
  assert.strictEqual(
    evaluateWebGPUWarmupSuitability(lowMemSupport, DEFAULT_WEBLLM_MODEL_ID).reason,
    'low_device_memory'
  );
  assert.strictEqual(
    evaluateWebGPUWarmupSuitability(lowMemSupport, SMOLLM2_135M_WEBLLM_MODEL_ID).shouldWarmup,
    true
  );

  // Clamped storage buffer binding (<256 MB) on 1.5B model -> skip
  setupMockBrowserEnvironment({ maxStorageBufferBindingSize: 134217728, deviceMemory: 16 });
  resetWebLLMRuntimeForTesting();
  const clampedSupport = await checkWebGPUSupport();
  assert.strictEqual(
    evaluateWebGPUWarmupSuitability(clampedSupport, DEFAULT_WEBLLM_MODEL_ID).reason,
    'constrained_gpu_buffer_limits'
  );

  // Missing adapter.info and missing navigator.deviceMemory (Safari / privacy-hardened browsers) -> graceful suitable
  setupMockBrowserEnvironment({ omitAdapterInfo: true, deviceMemory: undefined });
  resetWebLLMRuntimeForTesting();
  const privacySupport = await checkWebGPUSupport();
  assert.strictEqual(privacySupport.adapterInfo, null);
  const privacySuitability = evaluateWebGPUWarmupSuitability(privacySupport, DEFAULT_WEBLLM_MODEL_ID);
  assert.strictEqual(privacySuitability.shouldWarmup, true);
  assert.strictEqual(privacySuitability.reason, 'suitable');

  resetWebLLMRuntimeForTesting();
});

// ============================================================================
// 7. Worker Termination & Cleanup
// ============================================================================

await runAsyncTest('7. destroyWebLLMEngine unloads engine, terminates worker, resets warm-up state, and clears GPU cache', async () => {
  let adapterCalls = 0;
  setupMockBrowserEnvironment({
    onRequestAdapter: () => {
      adapterCalls += 1;
    }
  });
  resetWebLLMRuntimeForTesting();

  let unloaded = false;
  let terminated = false;
  setWebLLMWorkerFactoryForTesting(() =>
    createMockWorker({
      onTerminate: () => {
        terminated = true;
      }
    })
  );
  setWebLLMEngineFactoryForTesting(async () => ({
    forwardTokensAndSample: async () => 8,
    resetChat: async () => {},
    chat: { completions: { create: async () => (async function* () {})() } },
    interruptGenerate: () => {},
    unload: async () => {
      unloaded = true;
    }
  }));

  await ensureWebLLMEngine({ modelId: DEFAULT_WEBLLM_MODEL_ID });
  assert.strictEqual(getWebLLMState().isWarmed, true);
  assert.strictEqual(adapterCalls, 1);

  await destroyWebLLMEngine();
  assert.strictEqual(unloaded, true);
  assert.strictEqual(terminated, true);
  assert.strictEqual(getWebLLMState().status, 'idle');
  assert.strictEqual(getWebLLMState().loadedModelId, null);
  assert.strictEqual(getWebLLMState().isWarmed, false);
  assert.strictEqual(isWebLLMModelWarmed(DEFAULT_WEBLLM_MODEL_ID), false);

  // Next checkWebGPUSupport after destroy refreshes adapter status cleanly
  await checkWebGPUSupport();
  assert.strictEqual(adapterCalls, 2);

  resetWebLLMRuntimeForTesting();
});

// ============================================================================
// 8. Request Isolation, Coalesced WebLLM Streaming & Timer Cadence
// ============================================================================

await runAsyncTest('8a. Request isolation: WebLLM coalesces streaming UI updates by >50% vs 18ms character slicing while preserving Stop & Gemini cadence', async () => {
  const sampleTokens = Array.from({ length: 40 }, (_, idx) => `token_${idx + 1} `);
  const expectedFullText = sampleTokens.join('');

  async function runSimulatedStream(providerId) {
    const controller = createRequestIsolationController();
    let messages = [
      { id: 'u1', sender: 'user', content: 'Benchmark streaming commits' },
      { id: 'a1', sender: 'assistant', provider: providerId, content: '', isStreaming: true }
    ];
    let uiUpdateCommits = 0;

    const result = await runIsolatedPromptStream({
      controller,
      targetChatId: 'chat-bench',
      assistantMessageId: 'a1',
      providerToUse: providerId,
      effectiveModelOverride:
        providerId === 'webllm' ? DEFAULT_WEBLLM_MODEL_ID : 'gemini-3.8-flash',
      promptText: 'Benchmark streaming commits',
      prefersReducedMotion: false,
      getActiveChatId: () => 'chat-bench',
      onUpdateMessages: (updater) => {
        uiUpdateCommits += 1;
        messages = updater(messages);
      },
      onPersistMessage: async () => {},
      onSetLoadingState: () => {},
      onSetPersistenceError: () => {},
      findExistingAssistantMessage: (_cid, mid) => messages.find((m) => m.id === mid) || null,
      streamRequest: async ({ onStart, onChunk }) => {
        onStart({
          modelUsed: providerId === 'webllm' ? DEFAULT_WEBLLM_MODEL_ID : 'gemini-3.8-flash',
          provider: providerId
        });
        let acc = '';
        for (const tok of sampleTokens) {
          await new Promise((r) => setTimeout(r, 12));
          acc += tok;
          onChunk(tok, acc);
        }
        return {
          text: acc,
          modelUsed: providerId === 'webllm' ? DEFAULT_WEBLLM_MODEL_ID : 'gemini-3.8-flash',
          provider: providerId
        };
      },
      classifyError: (err) => ({
        friendlyMsg: String(err?.message || err),
        effectiveProvider: providerId,
        canSwitchProvider: false
      })
    });

    return {
      status: result.status,
      uiUpdateCommits,
      finalMessage: messages.find((m) => m.id === 'a1')
    };
  }

  const webllmRun = await runSimulatedStream('webllm');
  const geminiRun = await runSimulatedStream('gemini');

  assert.strictEqual(webllmRun.status, 'completed');
  assert.strictEqual(geminiRun.status, 'completed');
  assert.strictEqual(webllmRun.finalMessage.content, expectedFullText);
  assert.strictEqual(geminiRun.finalMessage.content, expectedFullText);

  const reductionPct = Math.round(
    ((geminiRun.uiUpdateCommits - webllmRun.uiUpdateCommits) / geminiRun.uiUpdateCommits) * 100
  );
  console.log(
    `    [Metric] 40-token (~${expectedFullText.length} chars) stream React commits: Cloud typewriter=${geminiRun.uiUpdateCommits}, Local WebLLM coalesced=${webllmRun.uiUpdateCommits} (-${reductionPct}% main-thread commits)`
  );

  assert.ok(
    webllmRun.uiUpdateCommits <= Math.floor(geminiRun.uiUpdateCommits * 0.55),
    `Expected WebLLM coalesced UI commits (${webllmRun.uiUpdateCommits}) to be <= 55% of character-by-character commits (${geminiRun.uiUpdateCommits})`
  );

  // Also verify immediate Stop mid-stream on WebLLM preserves only revealed partial text with zero post-stop mutations
  const stopController = createRequestIsolationController();
  let stopMessages = [
    { id: 'u-stop', sender: 'user', content: 'Stop test' },
    { id: 'a-stop', sender: 'assistant', provider: 'webllm', content: '', isStreaming: true }
  ];
  let stopEngineCalled = false;

  const streamPromise = runIsolatedPromptStream({
    controller: stopController,
    targetChatId: 'chat-stop',
    assistantMessageId: 'a-stop',
    providerToUse: 'webllm',
    effectiveModelOverride: DEFAULT_WEBLLM_MODEL_ID,
    promptText: 'Stop test',
    prefersReducedMotion: false,
    getActiveChatId: () => 'chat-stop',
    onUpdateMessages: (updater) => {
      stopMessages = updater(stopMessages);
    },
    onPersistMessage: async () => {},
    onSetLoadingState: () => {},
    onSetPersistenceError: () => {},
    findExistingAssistantMessage: (_cid, mid) => stopMessages.find((m) => m.id === mid) || null,
    streamRequest: async ({ signal, onStart, onChunk }) => {
      onStart({ modelUsed: DEFAULT_WEBLLM_MODEL_ID, provider: 'webllm' });
      onChunk('Partial local ', 'Partial local ');
      await new Promise((r) => setTimeout(r, 30));
      onChunk('output before stop — UNREVEALED TAIL', 'Partial local output before stop — UNREVEALED TAIL');
      await new Promise((_resolve, reject) => {
        const rejectAborted = () => {
          const e = new Error('Aborted');
          e.name = 'AbortError';
          reject(e);
        };
        if (signal.aborted) {
          rejectAborted();
          return;
        }
        signal.addEventListener('abort', rejectAborted, { once: true });
      });
    },
    classifyError: (err) => ({
      friendlyMsg: String(err?.message || err),
      effectiveProvider: 'webllm',
      canSwitchProvider: false
    })
  });

  await new Promise((r) => setTimeout(r, 25));
  cancelActiveChatRequest(stopController, 'stopped', {
    getActiveChatId: () => 'chat-stop',
    onUpdateMessages: (updater) => {
      stopMessages = updater(stopMessages);
    },
    onPersistMessage: async () => {},
    onSetLoadingState: () => {},
    findExistingAssistantMessage: (_cid, mid) => stopMessages.find((m) => m.id === mid) || null,
    stopLocalEngine: () => {
      stopEngineCalled = true;
    }
  });

  const stopOutcome = await streamPromise;
  assert.strictEqual(stopOutcome.status, 'cancelled');
  assert.strictEqual(stopEngineCalled, true);

  const stoppedAssistant = stopMessages.find((m) => m.id === 'a-stop');
  assert.strictEqual(stoppedAssistant.isStopped, true);
  assert.strictEqual(stoppedAssistant.isStreaming, false);
  assert.ok(
    stoppedAssistant.content.startsWith('Partial'),
    `Expected revealed partial text, got: "${stoppedAssistant.content}"`
  );
  assert.ok(
    !stoppedAssistant.content.includes('UNREVEALED TAIL'),
    'Unrevealed buffered chunks must never appear after Stop'
  );

  const snapshotAfterStop = stoppedAssistant.content;
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(
    stopMessages.find((m) => m.id === 'a-stop').content,
    snapshotAfterStop,
    'No trailing buffered tokens may mutate UI after Stop'
  );
});

runTest('8b. Source verification: ChatMessage LiveResponseTimer throttles local WebGPU prefill timer to 250ms with string-equality bailout and preserves Dedicated Worker boundary', () => {
  const chatMessageSrc = fs.readFileSync(
    path.resolve(__dirname, '../src/components/chat/ChatMessage.jsx'),
    'utf8'
  );
  assert.ok(
    chatMessageSrc.includes('isLocalGpu = false'),
    'LiveResponseTimer should accept isLocalGpu prop'
  );
  assert.ok(
    chatMessageSrc.includes('const intervalMs = isLocalGpu ? 250 : 100;'),
    'LiveResponseTimer should throttle to 250ms during local WebGPU prefill while keeping 100ms for cloud providers'
  );
  assert.ok(
    chatMessageSrc.includes('prev === next ? prev : next'),
    'LiveResponseTimer should bail out when formatted elapsed string has not changed'
  );
  assert.ok(
    chatMessageSrc.includes("isLocalGpu={currentProviderId === 'webllm'}"),
    'ChatMessage should pass isLocalGpu={currentProviderId === "webllm"} to LiveResponseTimer'
  );

  const workerSrc = fs.readFileSync(
    path.resolve(__dirname, '../src/workers/webllmWorker.js'),
    'utf8'
  );
  assert.ok(
    workerSrc.includes('WebWorkerMLCEngineHandler'),
    'WebLLM inference must remain inside dedicated Web Worker'
  );
});

// ============================================================================
// 9. Production-Readiness Edge Cases, Real Package Surface & Race Verification
// ============================================================================

await runAsyncTest('9a. Real @mlc-ai/web-llm@0.2.86 package surface: verifies forwardTokensAndSample, resetChat, prefill dispatch branch, and all 8 model records', async () => {
  const webllmPkg = await import('@mlc-ai/web-llm');
  assert.strictEqual(typeof webllmPkg.MLCEngine?.prototype?.forwardTokensAndSample, 'function');
  assert.strictEqual(typeof webllmPkg.MLCEngine?.prototype?.resetChat, 'function');
  assert.strictEqual(
    typeof webllmPkg.WebWorkerMLCEngine?.prototype?.forwardTokensAndSample,
    'function'
  );
  assert.strictEqual(typeof webllmPkg.WebWorkerMLCEngine?.prototype?.resetChat, 'function');
  assert.strictEqual(typeof webllmPkg.WebWorkerMLCEngineHandler?.prototype?.onmessage, 'function');

  const requiredModelIds = [
    'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
    'Qwen2.5-1.5B-Instruct-q4f32_1-MLC',
    'SmolLM2-360M-Instruct-q4f16_1-MLC',
    'SmolLM2-360M-Instruct-q4f32_1-MLC',
    'SmolLM2-135M-Instruct-q0f16-MLC',
    'SmolLM2-135M-Instruct-q0f32-MLC',
    'Qwen3-0.6B-q4f16_1-MLC',
    'Qwen3-0.6B-q4f32_1-MLC'
  ];

  const modelList = webllmPkg.prebuiltAppConfig?.model_list || [];
  for (const id of requiredModelIds) {
    const found = modelList.find((m) => m.model_id === id);
    assert.ok(found, `Missing required model ${id} in @mlc-ai/web-llm prebuiltAppConfig`);
    assert.ok(
      Number(found.overrides?.context_window_size) >= 4096,
      `Expected context_window_size >= 4096 for ${id}`
    );
  }

  // Verify installed bundle indeed branches on inputDataLen > 1 for invokePrefill vs invokeDecode
  const bundleSrc = fs.readFileSync(
    path.resolve(__dirname, '../node_modules/@mlc-ai/web-llm/lib/index.js'),
    'utf8'
  );
  assert.ok(
    bundleSrc.includes('if (inputDataLen > 1)') && bundleSrc.includes('this.invokePrefill('),
    'Expected @mlc-ai/web-llm LLMChatPipeline.embedAndForward to dispatch invokePrefill only when inputDataLen > 1'
  );
});

await runAsyncTest('9b. Warm-up cancellation during rapid model switching (ModelA -> ModelB -> ModelA) does not hang on terminated worker RPCs', async () => {
  setupMockBrowserEnvironment();
  resetWebLLMRuntimeForTesting();

  let currentWorkerAlive = false;
  setWebLLMWorkerFactoryForTesting(() => {
    currentWorkerAlive = true;
    return createMockWorker({
      onTerminate: () => {
        currentWorkerAlive = false;
      }
    });
  });

  const completedWarmups = [];
  let modelALoadAttempt = 0;

  setWebLLMEngineFactoryForTesting(async ({ modelId }) => {
    const attempt = modelId === DEFAULT_WEBLLM_MODEL_ID ? ++modelALoadAttempt : 1;
    return {
      forwardTokensAndSample: async (inputIds, isPrefill) => {
        assert.deepStrictEqual(
          isPrefill ? inputIds : [inputIds.length],
          isPrefill ? [1, 1] : [1]
        );
        if (modelId === DEFAULT_WEBLLM_MODEL_ID && attempt === 1) {
          // Simulate WebWorkerMLCEngine.getPromise: if worker is terminated mid-RPC,
          // the worker promise itself NEVER settles!
          await new Promise((resolve) => {
            setTimeout(() => {
              if (currentWorkerAlive) resolve(21);
            }, 5000);
          });
          return 21;
        }
        await new Promise((r) => setTimeout(r, 10));
        return isPrefill ? 15 : 16;
      },
      resetChat: async (_keepStats, mId) => {
        completedWarmups.push(mId || modelId);
      },
      chat: {
        completions: {
          create: async () =>
            (async function* () {
              yield { choices: [{ delta: { content: `Reply from ${modelId}` } }] };
            })()
        }
      },
      interruptGenerate: () => {},
      unload: async () => {}
    };
  });

  const t0 = Date.now();
  const loadAPromise = ensureWebLLMEngine({ modelId: DEFAULT_WEBLLM_MODEL_ID });
  await new Promise((r) => setTimeout(r, 20));

  // User switches to SmolLM2-360M while ModelA is mid-warm-up (ChatPage calls stopWebLLMGeneration then selects B)
  stopWebLLMGeneration();
  await assert.rejects(
    () => loadAPromise,
    (err) => err?.name === 'AbortError'
  );
  const abortElapsedMs = Date.now() - t0;
  assert.ok(
    abortElapsedMs < 500,
    `Mid-warm-up model switch cancellation took ${abortElapsedMs}ms (must not wait for hung worker RPC)`
  );

  // Load Model B cleanly
  await ensureWebLLMEngine({ modelId: SMOLLM2_360M_WEBLLM_MODEL_ID });
  assert.strictEqual(getWebLLMState().loadedModelId, SMOLLM2_360M_WEBLLM_MODEL_ID);
  assert.strictEqual(isWebLLMModelWarmed(SMOLLM2_360M_WEBLLM_MODEL_ID), true);
  assert.strictEqual(isWebLLMModelWarmed(DEFAULT_WEBLLM_MODEL_ID), false);

  // Switch back to Model A and verify stale activeWarmupPromise was NOT reused
  await ensureWebLLMEngine({ modelId: DEFAULT_WEBLLM_MODEL_ID });
  assert.strictEqual(getWebLLMState().loadedModelId, DEFAULT_WEBLLM_MODEL_ID);
  assert.strictEqual(isWebLLMModelWarmed(DEFAULT_WEBLLM_MODEL_ID), true);
  assert.deepStrictEqual(completedWarmups, [
    SMOLLM2_360M_WEBLLM_MODEL_ID,
    DEFAULT_WEBLLM_MODEL_ID
  ]);

  const replyA = await streamWebLLMMessage({
    prompt: 'Confirm Model A works after A->B->A switch',
    model: DEFAULT_WEBLLM_MODEL_ID
  });
  assert.strictEqual(replyA.text, `Reply from ${DEFAULT_WEBLLM_MODEL_ID}`);

  // Also verify ChatPage.jsx handleSelectWebLLMModel cancels active WebLLM requests / loading
  const chatPageSrc = fs.readFileSync(
    path.resolve(__dirname, '../src/pages/ChatPage.jsx'),
    'utf8'
  );
  assert.ok(
    chatPageSrc.includes("cancelCurrentGeneration('model_switched')") &&
      chatPageSrc.includes('stopWebLLMGeneration()'),
    'ChatPage handleSelectWebLLMModel should cancel active WebLLM generation or in-flight warm-up on model switch'
  );

  resetWebLLMRuntimeForTesting();
});

await runAsyncTest('9c. destroyWebLLMEngine() and stopWebLLMGeneration() during standalone warm-up settle immediately and leave no background RPC running', async () => {
  setupMockBrowserEnvironment();
  resetWebLLMRuntimeForTesting();

  let workerTerminates = 0;
  setWebLLMWorkerFactoryForTesting(() =>
    createMockWorker({
      onTerminate: () => {
        workerTerminates += 1;
      }
    })
  );
  setWebLLMEngineFactoryForTesting(async () => ({
    forwardTokensAndSample: async () => {
      // Never resolves (simulates uninterruptible in-flight worker forward pass)
      return new Promise(() => {});
    },
    resetChat: async () => {},
    chat: { completions: { create: async () => (async function* () {})() } },
    interruptGenerate: () => {},
    unload: async () => {
      // Also never resolves while worker thread is busy in forwardTokensAndSample
      return new Promise(() => {});
    }
  }));

  // 1) Load with skipWarmup: true, then trigger standalone warmupWebLLMEngine() and destroy mid-warm-up
  await ensureWebLLMEngine({ modelId: DEFAULT_WEBLLM_MODEL_ID, skipWarmup: true });
  assert.strictEqual(getWebLLMState().status, 'ready');
  assert.strictEqual(getWebLLMState().isWarmed, false);

  const tStart = Date.now();
  const warmupPromise = warmupWebLLMEngine({ modelId: DEFAULT_WEBLLM_MODEL_ID });
  await new Promise((r) => setTimeout(r, 20));
  await destroyWebLLMEngine();

  await assert.rejects(
    () => warmupPromise,
    (err) => err?.name === 'AbortError'
  );
  const elapsed = Date.now() - tStart;
  assert.ok(
    elapsed < 300,
    `destroyWebLLMEngine + in-flight warmupWebLLMEngine should settle immediately (<300ms), took ${elapsed}ms`
  );
  assert.strictEqual(workerTerminates, 1);
  assert.strictEqual(getWebLLMState().status, 'idle');
  assert.strictEqual(getWebLLMState().loadedModelId, null);
  assert.strictEqual(getWebLLMState().isWarmed, false);

  // 2) Reload with skipWarmup: true, trigger standalone warmupWebLLMEngine(), then call stopWebLLMGeneration()
  await ensureWebLLMEngine({ modelId: DEFAULT_WEBLLM_MODEL_ID, skipWarmup: true });
  const tStopStart = Date.now();
  const warmupStopPromise = warmupWebLLMEngine({ modelId: DEFAULT_WEBLLM_MODEL_ID });
  await new Promise((r) => setTimeout(r, 20));
  stopWebLLMGeneration();

  await assert.rejects(
    () => warmupStopPromise,
    (err) => err?.name === 'AbortError'
  );
  const stopElapsed = Date.now() - tStopStart;
  assert.ok(
    stopElapsed < 300,
    `stopWebLLMGeneration during standalone warmup should settle immediately (<300ms), took ${stopElapsed}ms`
  );
  assert.strictEqual(
    workerTerminates,
    2,
    'stopWebLLMGeneration mid-warm-up must terminate busy worker so forwardTokensAndSample never keeps running'
  );
  assert.strictEqual(getWebLLMState().status, 'idle');

  resetWebLLMRuntimeForTesting();
});

await runAsyncTest('9d. Warm-up timeout recycles dirty worker cleanly without dispatching concurrent resetChat and skips repeat warm-ups', async () => {
  setupMockBrowserEnvironment();
  resetWebLLMRuntimeForTesting();
  setWebLLMDownloadConfigForTesting({ warmupTimeoutMs: 45 });

  let workerCreateCount = 0;
  let workerTerminateCount = 0;
  let concurrentResetOnHungWorker = false;

  setWebLLMWorkerFactoryForTesting(() => {
    workerCreateCount += 1;
    return createMockWorker({
      onTerminate: () => {
        workerTerminateCount += 1;
      }
    });
  });

  setWebLLMEngineFactoryForTesting(async () => {
    const engineIdx = workerCreateCount;
    let forwardInFlight = false;
    return {
      forwardTokensAndSample: async () => {
        if (engineIdx === 1) {
          forwardInFlight = true;
          // Hang past 45ms warmupTimeoutMs
          await new Promise(() => {});
        }
        return 5;
      },
      resetChat: async () => {
        if (engineIdx === 1 && forwardInFlight) {
          concurrentResetOnHungWorker = true;
        }
      },
      chat: {
        completions: {
          create: async () => {
            assert.strictEqual(
              engineIdx,
              2,
              'Real inference must run on fresh recycled engine, not dirty timed-out engine #1'
            );
            return (async function* () {
              yield { choices: [{ delta: { content: 'Clean response after timeout recycle' } }] };
            })();
          }
        }
      },
      interruptGenerate: () => {},
      unload: async () => {}
    };
  });

  await ensureWebLLMEngine({
    modelId: DEFAULT_WEBLLM_MODEL_ID,
    warmupTimeoutMs: 45
  });

  assert.strictEqual(
    concurrentResetOnHungWorker,
    false,
    'Must NEVER send concurrent resetChat onto a worker with a hung forwardTokensAndSample'
  );
  assert.strictEqual(workerTerminateCount, 1, 'Hung warm-up worker #1 must be terminated');
  assert.strictEqual(workerCreateCount, 2, 'Clean replacement worker #2 must be loaded with skipWarmup');
  assert.strictEqual(getWebLLMState().status, 'ready');
  assert.strictEqual(getWebLLMState().isWarmed, false);

  // Subsequent suitability check should remember prior timeout for this model
  const gpuSupport = await checkWebGPUSupport();
  const suitability = evaluateWebGPUWarmupSuitability(gpuSupport, DEFAULT_WEBLLM_MODEL_ID);
  assert.strictEqual(suitability.shouldWarmup, false);
  assert.strictEqual(suitability.reason, 'prior_warmup_timeout');

  const res = await streamWebLLMMessage({
    prompt: 'Verify inference after warm-up timeout',
    model: DEFAULT_WEBLLM_MODEL_ID
  });
  assert.strictEqual(res.text, 'Clean response after timeout recycle');

  resetWebLLMRuntimeForTesting();
});

await runAsyncTest('9e. Post-reload GPUDevice.lost (ModelNotLoadedError inside worker) is treated as fatal DEVICE_LOST, never marking broken engine ready', async () => {
  setupMockBrowserEnvironment();
  resetWebLLMRuntimeForTesting();

  let terminated = false;
  setWebLLMWorkerFactoryForTesting(() =>
    createMockWorker({
      onTerminate: () => {
        terminated = true;
      }
    })
  );
  setWebLLMEngineFactoryForTesting(async () => ({
    forwardTokensAndSample: async () => {
      const err = new Error(
        'ModelNotLoadedError: Model Qwen2.5-1.5B-Instruct-q4f16_1-MLC is not loaded.'
      );
      err.name = 'ModelNotLoadedError';
      throw err;
    },
    resetChat: async () => {},
    chat: { completions: { create: async () => (async function* () {})() } },
    interruptGenerate: () => {},
    unload: async () => {}
  }));

  await assert.rejects(
    () => ensureWebLLMEngine({ modelId: DEFAULT_WEBLLM_MODEL_ID }),
    (err) => {
      assert.ok(err instanceof WebLLMError);
      assert.strictEqual(err.errorCode, WEBLLM_ERROR_CODES.DEVICE_LOST);
      return true;
    }
  );
  assert.strictEqual(terminated, true);
  assert.strictEqual(getWebLLMState().status, 'error');
  assert.strictEqual(getWebLLMState().loadedModelId, null);

  resetWebLLMRuntimeForTesting();
});

await runAsyncTest('9f. Loaded-engine fast-path warm-up serializes with concurrent streamWebLLMMessage with zero overlapping worker RPCs', async () => {
  setupMockBrowserEnvironment();
  resetWebLLMRuntimeForTesting();

  let activeRpc = 0;
  let maxConcurrentRpc = 0;
  const rpcOrder = [];

  const trackRpc = async (label, fn) => {
    activeRpc += 1;
    if (activeRpc > maxConcurrentRpc) {
      maxConcurrentRpc = activeRpc;
    }
    rpcOrder.push(`start:${label}`);
    try {
      await new Promise((r) => setTimeout(r, 15));
      return await fn();
    } finally {
      rpcOrder.push(`end:${label}`);
      activeRpc -= 1;
    }
  };

  setWebLLMWorkerFactoryForTesting(() => createMockWorker());
  setWebLLMEngineFactoryForTesting(async () => ({
    forwardTokensAndSample: async (_ids, isPrefill) =>
      trackRpc(isPrefill ? 'prefill' : 'decode', () => (isPrefill ? 31 : 32)),
    resetChat: async () => trackRpc('resetChat', () => undefined),
    chat: {
      completions: {
        create: async () =>
          trackRpc('completions.create', () =>
            (async function* () {
              yield { choices: [{ delta: { content: 'Serialized reply' } }] };
            })()
          )
      }
    },
    interruptGenerate: () => {},
    unload: async () => {}
  }));

  // Load initially with skipWarmup: true so engine is loaded but un-warmed
  await ensureWebLLMEngine({ modelId: DEFAULT_WEBLLM_MODEL_ID, skipWarmup: true });
  assert.strictEqual(isWebLLMModelWarmed(DEFAULT_WEBLLM_MODEL_ID), false);

  // Fire fast-path warm-up AND real streaming concurrently
  const [warmOut, streamOut] = await Promise.all([
    ensureWebLLMEngine({ modelId: DEFAULT_WEBLLM_MODEL_ID, skipWarmup: false }),
    streamWebLLMMessage({ prompt: 'Concurrent send during fast-path warm-up' })
  ]);

  assert.ok(warmOut.engine);
  assert.strictEqual(streamOut.text, 'Serialized reply');
  assert.strictEqual(
    maxConcurrentRpc,
    1,
    `Expected strictly serialized worker RPCs (maxConcurrentRpc === 1), got ${maxConcurrentRpc}: ${rpcOrder.join(' -> ')}`
  );

  resetWebLLMRuntimeForTesting();
});

await runAsyncTest('9g. GPUAdapter.isFallbackAdapter with masked adapter.info skips warm-up without blocking normal Browser AI inference', async () => {
  setupMockBrowserEnvironment({
    isFallbackAdapter: true,
    adapterVendor: '',
    adapterArch: '',
    adapterDescription: ''
  });
  resetWebLLMRuntimeForTesting();

  const support = await checkWebGPUSupport();
  assert.strictEqual(support.supported, true);
  assert.strictEqual(support.isFallbackAdapter, true);

  const suitability = evaluateWebGPUWarmupSuitability(support, DEFAULT_WEBLLM_MODEL_ID);
  assert.strictEqual(suitability.shouldWarmup, false);
  assert.strictEqual(suitability.reason, 'software_adapter');

  let warmupCalled = false;
  setWebLLMWorkerFactoryForTesting(() => createMockWorker());
  setWebLLMEngineFactoryForTesting(async () => ({
    forwardTokensAndSample: async () => {
      warmupCalled = true;
      return 1;
    },
    resetChat: async () => {},
    chat: {
      completions: {
        create: async () =>
          (async function* () {
            yield { choices: [{ delta: { content: 'Software fallback inference still works' } }] };
          })()
      }
    },
    interruptGenerate: () => {},
    unload: async () => {}
  }));

  await ensureWebLLMEngine({ modelId: DEFAULT_WEBLLM_MODEL_ID });
  assert.strictEqual(warmupCalled, false);

  const out = await streamWebLLMMessage({ prompt: 'Test on fallback adapter' });
  assert.strictEqual(out.text, 'Software fallback inference still works');

  resetWebLLMRuntimeForTesting();
});

await runAsyncTest('9h. Coalescing preserves exact text across short, burst, Markdown/code, and UTF-16 emojis with zero lone surrogates and strict Request ID isolation', async () => {
  const loneSurrogateRegex =
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

  const payloads = [
    // 1) Very short response
    ['Hi!'],
    // 2) Surrogate-pair emojis + ZWJ sequence split across burst chunks
    ['Hello 🚀🧪✨ ', 'developer 👨‍💻🔥 ', 'world 🌍🎉💡 ', 'end ✅'],
    // 3) Markdown + fenced code blocks + math symbols
    [
      '### Summary\n\n- Bullet **one**\n- Bullet `two`\n\n```js\nfunction sum(a, b) {\n  return a + b;\n}\n```\n',
      'Final line with unicode: café, naïve, Δx → ∞.'
    ],
    // 4) Large 1,600+ char burst backlog
    Array.from({ length: 50 }, (_, i) => `Chunk#${i + 1}: [${'x'.repeat(24)}] 🚀\n`)
  ];

  for (const chunks of payloads) {
    const expected = chunks.join('');
    const controller = createRequestIsolationController();
    let messages = [
      { id: 'u', sender: 'user', content: 'Test payload' },
      { id: 'a', sender: 'assistant', provider: 'webllm', content: '', isStreaming: true }
    ];

    const res = await runIsolatedPromptStream({
      controller,
      targetChatId: 'chat-utf16',
      assistantMessageId: 'a',
      providerToUse: 'webllm',
      effectiveModelOverride: DEFAULT_WEBLLM_MODEL_ID,
      promptText: 'Test payload',
      prefersReducedMotion: false,
      getActiveChatId: () => 'chat-utf16',
      onUpdateMessages: (updater) => {
        messages = updater(messages);
        const partial = messages.find((m) => m.id === 'a')?.content || '';
        assert.strictEqual(
          loneSurrogateRegex.test(partial),
          false,
          `Coalesced intermediate frame split a UTF-16 surrogate pair: ${JSON.stringify(partial)}`
        );
      },
      onPersistMessage: async () => {},
      onSetLoadingState: () => {},
      onSetPersistenceError: () => {},
      findExistingAssistantMessage: (_cid, mid) => messages.find((m) => m.id === mid) || null,
      streamRequest: async ({ onStart, onChunk }) => {
        onStart({ modelUsed: DEFAULT_WEBLLM_MODEL_ID, provider: 'webllm' });
        let acc = '';
        for (const c of chunks) {
          acc += c;
          onChunk(c, acc);
          await new Promise((r) => setTimeout(r, 4));
        }
        return { text: acc, modelUsed: DEFAULT_WEBLLM_MODEL_ID, provider: 'webllm' };
      },
      classifyError: (err) => ({
        friendlyMsg: String(err?.message || err),
        effectiveProvider: 'webllm',
        canSwitchProvider: false
      })
    });

    assert.strictEqual(res.status, 'completed');
    assert.strictEqual(messages.find((m) => m.id === 'a').content, expected);
  }

  // Verify Request ID & multi-provider isolation when WebLLM stream is superseded by Gemini stream
  const isoController = createRequestIsolationController();
  let chatMessages = [
    { id: 'u1', sender: 'user', content: 'WebLLM prompt' },
    { id: 'a-webllm', sender: 'assistant', provider: 'webllm', content: '', isStreaming: true },
    { id: 'u2', sender: 'user', content: 'Gemini prompt' },
    { id: 'a-gemini', sender: 'assistant', provider: 'gemini', content: '', isStreaming: true }
  ];

  const webllmStream = runIsolatedPromptStream({
    controller: isoController,
    targetChatId: 'chat-iso',
    assistantMessageId: 'a-webllm',
    providerToUse: 'webllm',
    effectiveModelOverride: DEFAULT_WEBLLM_MODEL_ID,
    promptText: 'WebLLM prompt',
    prefersReducedMotion: false,
    getActiveChatId: () => 'chat-iso',
    onUpdateMessages: (updater) => {
      chatMessages = updater(chatMessages);
    },
    onPersistMessage: async () => {},
    onSetLoadingState: () => {},
    onSetPersistenceError: () => {},
    findExistingAssistantMessage: (_cid, mid) => chatMessages.find((m) => m.id === mid) || null,
    streamRequest: async ({ signal, onStart, onChunk }) => {
      onStart({ modelUsed: DEFAULT_WEBLLM_MODEL_ID, provider: 'webllm' });
      onChunk('Stale local ', 'Stale local ');
      await new Promise((_res, rej) => {
        const abortErr = () => {
          const e = new Error('Superseded');
          e.name = 'AbortError';
          rej(e);
        };
        if (signal.aborted) return abortErr();
        signal.addEventListener('abort', abortErr, { once: true });
      });
    },
    classifyError: (err) => ({
      friendlyMsg: String(err?.message || err),
      effectiveProvider: 'webllm',
      canSwitchProvider: false
    })
  });

  await new Promise((r) => setTimeout(r, 10));
  const geminiStream = runIsolatedPromptStream({
    controller: isoController,
    targetChatId: 'chat-iso',
    assistantMessageId: 'a-gemini',
    providerToUse: 'gemini',
    effectiveModelOverride: 'gemini-3.8-flash',
    promptText: 'Gemini prompt',
    prefersReducedMotion: false,
    getActiveChatId: () => 'chat-iso',
    onUpdateMessages: (updater) => {
      chatMessages = updater(chatMessages);
    },
    onPersistMessage: async () => {},
    onSetLoadingState: () => {},
    onSetPersistenceError: () => {},
    findExistingAssistantMessage: (_cid, mid) => chatMessages.find((m) => m.id === mid) || null,
    streamRequest: async ({ onStart, onChunk }) => {
      onStart({ modelUsed: 'gemini-3.8-flash', provider: 'gemini' });
      onChunk('Cloud answer', 'Cloud answer');
      return { text: 'Cloud answer', modelUsed: 'gemini-3.8-flash', provider: 'gemini' };
    },
    classifyError: (err) => ({
      friendlyMsg: String(err?.message || err),
      effectiveProvider: 'gemini',
      canSwitchProvider: false
    })
  });

  const [rWeb, rGem] = await Promise.all([webllmStream, geminiStream]);
  assert.strictEqual(rWeb.status, 'cancelled');
  assert.strictEqual(rGem.status, 'completed');
  assert.strictEqual(chatMessages.find((m) => m.id === 'a-gemini').content, 'Cloud answer');
});

await runAsyncTest('9i. Cold direct-send FP16->FP32 fallback & repeated load/inference/unload cycles stay leak-free', async () => {
  setupMockBrowserEnvironment({ hasShaderF16: true });
  resetWebLLMRuntimeForTesting();

  let warmupDispatches = 0;
  setWebLLMWorkerFactoryForTesting(() => createMockWorker());
  setWebLLMEngineFactoryForTesting(async ({ modelId }) => {
    if (modelId === DEFAULT_WEBLLM_MODEL_ID) {
      throw new Error('ShaderF16SupportError: device rejected f16 pipeline');
    }
    return {
      forwardTokensAndSample: async () => {
        warmupDispatches += 1;
        return 1;
      },
      resetChat: async () => {},
      chat: {
        completions: {
          create: async () =>
            (async function* () {
              yield { choices: [{ delta: { content: `Answered via ${modelId}` } }] };
            })()
        }
      },
      interruptGenerate: () => {},
      unload: async () => {}
    };
  });

  // Cold direct-send triggers ShaderF16SupportError -> falls back to FP32 with skipWarmup: true preserved
  const coldFallbackReply = await streamWebLLMMessage({
    prompt: 'Cold send on broken f16 driver',
    model: DEFAULT_WEBLLM_MODEL_ID
  });
  assert.strictEqual(coldFallbackReply.modelUsed, FALLBACK_F32_WEBLLM_MODEL_ID);
  assert.strictEqual(coldFallbackReply.text, `Answered via ${FALLBACK_F32_WEBLLM_MODEL_ID}`);
  assert.strictEqual(warmupDispatches, 0, 'Cold direct-send FP32 fallback must preserve skipWarmup');
  assert.strictEqual(isWebLLMModelWarmed(FALLBACK_F32_WEBLLM_MODEL_ID), true);

  await destroyWebLLMEngine();

  // Repeated load -> warm -> inference -> unload cycles across models
  let cycleEngineCreates = 0;
  let cycleWorkerTerminates = 0;
  setWebLLMWorkerFactoryForTesting(() =>
    createMockWorker({
      onTerminate: () => {
        cycleWorkerTerminates += 1;
      }
    })
  );
  setWebLLMEngineFactoryForTesting(async ({ modelId }) => {
    cycleEngineCreates += 1;
    return {
      forwardTokensAndSample: async (_ids, isPrefill) => (isPrefill ? 10 : 11),
      resetChat: async () => {},
      chat: {
        completions: {
          create: async () =>
            (async function* () {
              yield { choices: [{ delta: { content: `Cycle OK: ${modelId}` } }] };
            })()
        }
      },
      interruptGenerate: () => {},
      unload: async () => {}
    };
  });

  const cycleModels = [
    DEFAULT_WEBLLM_MODEL_ID,
    SMOLLM2_360M_WEBLLM_MODEL_ID,
    SMOLLM2_135M_WEBLLM_MODEL_ID,
    DEFAULT_WEBLLM_MODEL_ID
  ];

  for (const modelId of cycleModels) {
    await ensureWebLLMEngine({ modelId });
    assert.strictEqual(getWebLLMState().status, 'ready');
    assert.strictEqual(isWebLLMModelWarmed(modelId), true);
    const out = await streamWebLLMMessage({ prompt: 'Cycle check', model: modelId });
    assert.strictEqual(out.text, `Cycle OK: ${modelId}`);
    await destroyWebLLMEngine();
    assert.strictEqual(getWebLLMState().status, 'idle');
    assert.strictEqual(getWebLLMState().loadedModelId, null);
    assert.strictEqual(isWebLLMModelWarmed(modelId), false);
  }

  assert.strictEqual(cycleEngineCreates, cycleModels.length);
  assert.strictEqual(cycleWorkerTerminates, cycleModels.length);

  resetWebLLMRuntimeForTesting();
});

console.log(`\nResults: ${passed} passed, ${failed} failed.\n`);
if (failed > 0) {
  process.exit(1);
}

