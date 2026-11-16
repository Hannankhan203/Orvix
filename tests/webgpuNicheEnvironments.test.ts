import test from 'node:test';
import assert from 'node:assert/strict';

import {
  checkWebGPUSupport,
  evaluateWebGPUWarmupSuitability,
  DEFAULT_WEBLLM_MODEL_ID,
  ensureWebLLMEngine,
  destroyWebLLMEngine,
  streamWebLLMMessage,
  isWebLLMGenerating,
  setWebLLMWorkerFactoryForTesting,
  setWebLLMEngineFactoryForTesting,
  setWebLLMDownloadConfigForTesting,
  resetWebLLMRuntimeForTesting
} from '../src/services/webllmService.js';

function setGlobalProp(name: string, value: any) {
  const hadOwn = Object.prototype.hasOwnProperty.call(globalThis, name);
  const prevDesc = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
    enumerable: true
  });
  return () => {
    if (hadOwn && prevDesc) {
      Object.defineProperty(globalThis, name, prevDesc);
    } else {
      delete (globalThis as any)[name];
    }
  };
}

test('WebGPU compatibility: graceful handling of missing navigator.gpu and insecure context', async () => {
  resetWebLLMRuntimeForTesting();
  const restoreNav = setGlobalProp('navigator', { deviceMemory: 8 });
  const restoreWindow = setGlobalProp('window', { isSecureContext: false });

  try {
    const support = await checkWebGPUSupport();
    assert.equal(support.supported, false);
    assert.equal(support.reasonCode, 'WEBLLM_INSECURE_CONTEXT');
  } finally {
    restoreNav();
    restoreWindow();
    resetWebLLMRuntimeForTesting();
  }
});

test('WebGPU compatibility: handles adapter request throwing and requestAdapter returning null', async () => {
  resetWebLLMRuntimeForTesting();
  const restoreNav = setGlobalProp('navigator', {
    gpu: {
      requestAdapter: async () => null
    },
    deviceMemory: 8
  });
  const restoreWindow = setGlobalProp('window', { isSecureContext: true });

  try {
    const support = await checkWebGPUSupport();
    assert.equal(support.supported, false);
    assert.equal(support.reasonCode, 'WEBGPU_ADAPTER_UNAVAILABLE');
  } finally {
    restoreNav();
    restoreWindow();
    resetWebLLMRuntimeForTesting();
  }
});

test('WebGPU warmup suitability: evaluates software renderer, low memory, and constrained buffer limits', () => {
  const s1 = evaluateWebGPUWarmupSuitability({
    supported: true,
    reasonCode: null,
    message: null,
    hasShaderF16: true,
    adapterInfo: { architecture: 'swiftshader', vendor: 'google', description: '', isFallbackAdapter: false },
    maxBufferSize: 256 * 1024 * 1024,
    maxStorageBufferBindingSize: 128 * 1024 * 1024,
    isFallbackAdapter: false,
    isSwiftShader: true
  } as any, DEFAULT_WEBLLM_MODEL_ID);
  assert.equal(s1.shouldWarmup, false);
  assert.equal(s1.reason, 'software_adapter');

  const s2 = evaluateWebGPUWarmupSuitability({
    supported: true,
    reasonCode: null,
    message: null,
    hasShaderF16: true,
    adapterInfo: { architecture: 'amd', vendor: 'ati', description: '', isFallbackAdapter: false },
    maxBufferSize: 10 * 1024 * 1024,
    maxStorageBufferBindingSize: 10 * 1024 * 1024,
    isFallbackAdapter: false,
    isSwiftShader: false
  } as any, DEFAULT_WEBLLM_MODEL_ID);
  assert.equal(s2.shouldWarmup, false);
  assert.equal(s2.reason, 'constrained_gpu_buffer_limits');
});

test('WebLLM runtime lifecycle: mock engine creation and streaming recovery', async () => {
  resetWebLLMRuntimeForTesting();

  const mockEngine = {
    unload: async () => {},
    chat: {
      completions: {
        create: async () => {
          async function* generator() {
            yield { choices: [{ delta: { content: 'Hello ' } }] };
            yield { choices: [{ delta: { content: 'from WebGPU!' } }] };
          }
          return generator();
        }
      }
    }
  };

  setWebLLMEngineFactoryForTesting(async () => mockEngine);
  setWebLLMWorkerFactoryForTesting(() => {
    return {
      postMessage: () => {},
      terminate: () => {},
      addEventListener: () => {},
      removeEventListener: () => {}
    } as unknown as Worker;
  });

  const restoreNav = setGlobalProp('navigator', {
    gpu: {
      requestAdapter: async () => ({
        features: { has: (f: string) => f === 'shader-f16' },
        limits: { maxBufferSize: 1024 * 1024 * 1024, maxStorageBufferBindingSize: 512 * 1024 * 1024 },
        requestAdapterInfo: async () => ({ architecture: 'apple m3', vendor: 'apple' })
      })
    },
    storage: {
      estimate: async () => ({ quota: 10 * 1024 * 1024 * 1024, usage: 100 * 1024 * 1024 })
    },
    deviceMemory: 16
  });
  const restoreWindow = setGlobalProp('window', { isSecureContext: true });
  const restoreCaches = setGlobalProp('caches', {
    open: async () => ({
      match: async () => ({
        ok: true,
        json: async () => ({})
      }),
      put: async () => {},
      delete: async () => {}
    })
  });

  try {
    const result = await streamWebLLMMessage({
      prompt: 'Hi',
      model: DEFAULT_WEBLLM_MODEL_ID
    });

    assert.ok(result);
    assert.equal(isWebLLMGenerating(), false);
  } finally {
    restoreNav();
    restoreWindow();
    restoreCaches();
    resetWebLLMRuntimeForTesting();
  }
});
