import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  checkWebGPUSupport,
  evaluateWebGPUWarmupSuitability,
  DEFAULT_WEBLLM_MODEL_ID,
  FALLBACK_F32_WEBLLM_MODEL_ID,
  SMOLLM2_360M_WEBLLM_MODEL_ID,
  normalizeWebLLMError,
  inspectWebLLMReadiness,
  getWebLLMState,
  ensureWebLLMEngine,
  destroyWebLLMEngine,
  streamWebLLMMessage,
  isWebLLMGenerating,
  setWebLLMWorkerFactoryForTesting,
  setWebLLMEngineFactoryForTesting,
  setWebLLMDownloadConfigForTesting,
  resetWebLLMRuntimeForTesting
} from '../src/services/webllmService.js';
import BrowserAIStatusBar from '../src/components/chat/BrowserAIStatusBar.jsx';
import { streamAIMessage } from '../src/services/aiRouter.js';
import {
  getChunksForConversation,
  deleteChunksForConversation
} from '../src/services/semanticVectorStorage.js';

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

function setupMockWebLLMEnvironment(onCreateCompletion?: (payload: any) => void) {
  const capturedPayloads: any[] = [];
  const mockEngine = {
    unload: async () => {},
    chat: {
      completions: {
        create: async (payload: any) => {
          capturedPayloads.push(payload);
          onCreateCompletion?.(payload);
          async function* generator() {
            yield { choices: [{ delta: { content: 'Grounded answer ' } }] };
            yield { choices: [{ delta: { content: 'from attachment.' } }] };
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

  return {
    capturedPayloads,
    cleanup: () => {
      restoreNav();
      restoreWindow();
      restoreCaches();
      resetWebLLMRuntimeForTesting();
    }
  };
}

test('WebLLM attachment regression: streamAIMessage forwards conversationId for document attachments without ReferenceError', async () => {
  resetWebLLMRuntimeForTesting();
  const conversationId = 'conv-webllm-doc-regression';
  await deleteChunksForConversation(conversationId);
  const env = setupMockWebLLMEnvironment();

  try {
    const docAttachment = {
      id: 'att-doc-001',
      name: 'quarterly-report.pdf',
      originalName: 'quarterly-report.pdf',
      type: 'application/pdf',
      extension: 'PDF',
      isImage: false,
      status: 'ready',
      extraction: {
        id: 'att-doc-001',
        originalName: 'quarterly-report.pdf',
        format: 'PDF',
        status: 'ready',
        success: true,
        text: 'Quarterly revenue increased by 28% in Q4 driven by enterprise adoption.',
        totalCharacters: 71,
        totalWords: 11,
        isImage: false
      }
    };

    const result = await streamAIMessage({
      provider: 'webllm',
      model: DEFAULT_WEBLLM_MODEL_ID,
      prompt: 'What drove Q4 revenue growth in the quarterly report?',
      conversationId,
      attachments: [docAttachment]
    });

    assert.equal(result.provider, 'webllm');
    assert.ok(result.text.includes('Grounded answer'));
    assert.equal(env.capturedPayloads.length, 1);

    const userMsg = env.capturedPayloads[0].messages.find((m: any) => m.role === 'user');
    assert.ok(userMsg?.content.includes('Quarterly revenue increased by 28%'));

    const storedChunks = (await getChunksForConversation(conversationId)) as any[];
    assert.ok(storedChunks.length > 0, 'Expected semantic chunks to be indexed under forwarded conversationId');
    assert.equal(storedChunks[0].conversationId, conversationId);
  } finally {
    await deleteChunksForConversation(conversationId);
    env.cleanup();
  }
});

test('WebLLM attachment regression: streamWebLLMMessage preserves backward compatibility when conversationId is omitted', async () => {
  resetWebLLMRuntimeForTesting();
  const env = setupMockWebLLMEnvironment();

  try {
    const result = await streamWebLLMMessage({
      prompt: 'Summarize the attached notes.',
      model: DEFAULT_WEBLLM_MODEL_ID,
      attachments: [
        {
          id: 'att-doc-compat-001',
          name: 'notes.txt',
          extension: 'TXT',
          isImage: false,
          extraction: {
            id: 'att-doc-compat-001',
            originalName: 'notes.txt',
            format: 'TXT',
            status: 'ready',
            text: 'Project milestone review scheduled for Friday morning.',
            isImage: false
          }
        }
      ]
    });

    assert.equal(result.provider, 'webllm');
    assert.ok(result.text.includes('Grounded answer'));
    assert.equal(env.capturedPayloads.length, 1);
  } finally {
    env.cleanup();
  }
});

test('WebLLM attachment regression: image OCR and NO_TEXT_DETECTED attachments complete without ReferenceError', async () => {
  resetWebLLMRuntimeForTesting();
  const conversationId = 'conv-webllm-img-regression';
  await deleteChunksForConversation(conversationId);
  const env = setupMockWebLLMEnvironment();

  try {
    // 1. Image attachment with OCR extracted text
    const ocrResult = await streamAIMessage({
      provider: 'webllm',
      model: DEFAULT_WEBLLM_MODEL_ID,
      prompt: 'What does this image say?',
      conversationId,
      attachments: [
        {
          id: 'att-img-ocr-001',
          name: 'invoice.png',
          originalName: 'invoice.png',
          type: 'image/png',
          extension: 'PNG',
          isImage: true,
          base64: 'ZmFrZS1pbWFnZS1ieXRlcw==',
          status: 'ready',
          extraction: {
            id: 'att-img-ocr-001',
            originalName: 'invoice.png',
            format: 'PNG',
            status: 'ready',
            success: true,
            text: 'Invoice #9042 Total Amount Due: $125.00',
            isImage: true
          }
        }
      ]
    });

    assert.equal(ocrResult.provider, 'webllm');
    assert.equal(env.capturedPayloads.length, 1);
    const ocrUserMsg = env.capturedPayloads[0].messages.find((m: any) => m.role === 'user');
    assert.ok(ocrUserMsg?.content.includes('Invoice #9042 Total Amount Due: $125.00'));

    // 2. Image attachment with NO_TEXT_DETECTED returns deterministic notice directly
    const noTextResult = await streamAIMessage({
      provider: 'webllm',
      model: DEFAULT_WEBLLM_MODEL_ID,
      prompt: 'Read the text in this photo.',
      conversationId,
      attachments: [
        {
          id: 'att-img-notext-001',
          name: 'photo.jpg',
          originalName: 'photo.jpg',
          type: 'image/jpeg',
          extension: 'JPG',
          isImage: true,
          status: 'NO_TEXT_DETECTED',
          extraction: {
            id: 'att-img-notext-001',
            originalName: 'photo.jpg',
            format: 'JPG',
            status: 'NO_TEXT_DETECTED',
            text: '',
            isImage: true
          }
        }
      ]
    });

    assert.equal(noTextResult.provider, 'webllm');
    assert.ok(noTextResult.text.length > 0);
    assert.equal(env.capturedPayloads.length, 1);
  } finally {
    await deleteChunksForConversation(conversationId);
    env.cleanup();
  }
});

test('WebLLM attachment regression: carry-forward document context across multi-turn history succeeds cleanly', async () => {
  resetWebLLMRuntimeForTesting();
  const conversationId = 'conv-webllm-carryforward';
  await deleteChunksForConversation(conversationId);
  const env = setupMockWebLLMEnvironment();

  try {
    const carryForwardDoc = {
      id: 'att-carry-001',
      name: 'architecture-spec.md',
      originalName: 'architecture-spec.md',
      type: 'text/markdown',
      extension: 'MD',
      isImage: false,
      chatId: conversationId,
      conversationId,
      status: 'ready',
      extraction: {
        id: 'att-carry-001',
        originalName: 'architecture-spec.md',
        format: 'MD',
        status: 'ready',
        success: true,
        text: 'The rate limiter uses Redis Lua EVAL scripts with an in-memory fallback.',
        totalCharacters: 72,
        totalWords: 12,
        isImage: false
      }
    };

    const result = await streamAIMessage({
      provider: 'webllm',
      model: DEFAULT_WEBLLM_MODEL_ID,
      conversationId,
      history: [
        { sender: 'user', content: 'Summarize architecture-spec.md' },
        { sender: 'assistant', content: 'It outlines the system components including the rate limiter.' }
      ],
      prompt: 'How does the rate limiter work according to the spec?',
      attachments: [carryForwardDoc]
    });

    assert.equal(result.provider, 'webllm');
    assert.ok(result.text.includes('Grounded answer'));
    assert.equal(env.capturedPayloads.length, 1);

    const payloadMessages = env.capturedPayloads[0].messages;
    assert.ok(payloadMessages.some((m: any) => m.role === 'assistant' && m.content.includes('rate limiter')));
    const latestUserMsg = payloadMessages[payloadMessages.length - 1];
    assert.equal(latestUserMsg.role, 'user');
    assert.ok(latestUserMsg.content.includes('Redis Lua EVAL scripts'));

    const storedChunks = (await getChunksForConversation(conversationId)) as any[];
    assert.ok(storedChunks.length > 0);
    assert.equal(storedChunks[0].conversationId, conversationId);
  } finally {
    await deleteChunksForConversation(conversationId);
    env.cleanup();
  }
});

test('MED-01 WebLLM model download and loading reliability: OOM and VRAM constraint errors provide granular retry guidance and fallback model suggestions', () => {
  const oomErr = new Error('GPUOutOfMemoryError: WebGPU maxStorageBufferBindingSize exceeded');
  const normalized = normalizeWebLLMError(oomErr, { modelId: DEFAULT_WEBLLM_MODEL_ID, phase: 'init' });

  assert.equal(normalized.status, 'WEBLLM_DEVICE_LOST');
  assert.equal(normalized.retryable, true);
  assert.equal(normalized.canFallback, true);
  assert.equal(normalized.suggestedFallbackModelId, SMOLLM2_360M_WEBLLM_MODEL_ID);
  assert.equal(normalized.suggestedProvider, 'gemini');
  assert.match(normalized.message, /device ran out of GPU memory/i);
  assert.match(normalized.message, /SmolLM2 360M/i);
});

test('ORVIX-LOW-01 BrowserAIStatusBar: clearly indicates FP32 fallback across downloading, loading, ready, generating, and offline states', () => {
  const noop = () => {};

  const downloadingHtml = renderToStaticMarkup(
    React.createElement(BrowserAIStatusBar, {
      visible: true,
      isSelectedProvider: true,
      selectedModelId: DEFAULT_WEBLLM_MODEL_ID,
      gpuCheck: { checking: false, supported: true, message: null },
      webllmState: {
        status: 'downloading',
        modelId: DEFAULT_WEBLLM_MODEL_ID,
        loadedModelId: null,
        hasShaderF16: false,
        progressPercent: 42,
        progressText: 'Fetching param cache[2/4]',
        isCached: false
      },
      onSelectModel: noop,
      onLoadModel: noop,
      onCancelLoad: noop,
      onUnloadModel: noop,
      onSelectProvider: noop
    })
  );
  assert.match(downloadingHtml, /Downloading \(FP32 Fallback\)/);
  assert.match(downloadingHtml, /Qwen 2\.5 1\.5B \(FP32\)/);
  assert.match(downloadingHtml, /FP32 fallback from Qwen 2\.5 1\.5B/);

  const generatingHtml = renderToStaticMarkup(
    React.createElement(BrowserAIStatusBar, {
      visible: true,
      isSelectedProvider: true,
      selectedModelId: DEFAULT_WEBLLM_MODEL_ID,
      gpuCheck: { checking: false, supported: true, message: null },
      webllmState: {
        status: 'generating',
        modelId: FALLBACK_F32_WEBLLM_MODEL_ID,
        loadedModelId: FALLBACK_F32_WEBLLM_MODEL_ID,
        hasShaderF16: false,
        isCached: true
      },
      onSelectModel: noop,
      onLoadModel: noop,
      onCancelLoad: noop,
      onUnloadModel: noop,
      onSelectProvider: noop
    })
  );
  assert.match(generatingHtml, /Generating • FP32 Fallback/);
  assert.match(generatingHtml, /FP32 fallback \(Qwen 2\.5 1\.5B \(FP32\)\)/);

  const readyHtml = renderToStaticMarkup(
    React.createElement(BrowserAIStatusBar, {
      visible: true,
      isSelectedProvider: true,
      selectedModelId: DEFAULT_WEBLLM_MODEL_ID,
      gpuCheck: { checking: false, supported: true, message: null },
      webllmState: {
        status: 'ready',
        modelId: FALLBACK_F32_WEBLLM_MODEL_ID,
        loadedModelId: FALLBACK_F32_WEBLLM_MODEL_ID,
        hasShaderF16: false,
        isCached: true
      },
      onSelectModel: noop,
      onLoadModel: noop,
      onCancelLoad: noop,
      onUnloadModel: noop,
      onSelectProvider: noop
    })
  );
  assert.match(readyHtml, /Ready • FP32 Fallback/);
  assert.match(readyHtml, /Switched from Qwen 2\.5 1\.5B to FP32 fallback/);

  const offlineCachedHtml = renderToStaticMarkup(
    React.createElement(BrowserAIStatusBar, {
      visible: true,
      isSelectedProvider: true,
      selectedModelId: DEFAULT_WEBLLM_MODEL_ID,
      isOffline: true,
      gpuCheck: { checking: false, supported: true, message: null },
      webllmState: {
        status: 'idle',
        modelId: FALLBACK_F32_WEBLLM_MODEL_ID,
        loadedModelId: null,
        hasShaderF16: false,
        isCached: true
      },
      onSelectModel: noop,
      onLoadModel: noop,
      onCancelLoad: noop,
      onUnloadModel: noop,
      onSelectProvider: noop
    })
  );
  assert.match(offlineCachedHtml, /Offline Cached • FP32 Fallback/);
  assert.match(offlineCachedHtml, /Using FP32 compatibility fallback/);
});

test('ORVIX-LOW-01 BrowserAIStatusBar: preserves one-click fallback model and cloud provider controls on error and unsupported WebGPU', async () => {
  const noop = () => {};

  const gpuUnsupportedHtml = renderToStaticMarkup(
    React.createElement(BrowserAIStatusBar, {
      visible: true,
      isSelectedProvider: true,
      selectedModelId: DEFAULT_WEBLLM_MODEL_ID,
      gpuCheck: { checking: false, supported: false, message: 'WebGPU adapter unavailable.' },
      webllmState: {
        status: 'idle',
        modelId: DEFAULT_WEBLLM_MODEL_ID,
        loadedModelId: null,
        suggestedProvider: null
      },
      onSelectModel: noop,
      onLoadModel: noop,
      onSelectProvider: noop
    })
  );
  assert.match(gpuUnsupportedHtml, /Unavailable • Cloud Fallback/);
  assert.match(gpuUnsupportedHtml, /Switch to Cloud AI/);

  const errorHtml = renderToStaticMarkup(
    React.createElement(BrowserAIStatusBar, {
      visible: true,
      isSelectedProvider: true,
      selectedModelId: DEFAULT_WEBLLM_MODEL_ID,
      gpuCheck: { checking: false, supported: true, message: null },
      webllmState: {
        status: 'error',
        modelId: DEFAULT_WEBLLM_MODEL_ID,
        loadedModelId: null,
        error: 'GPU out of memory',
        suggestedFallbackModelId: SMOLLM2_360M_WEBLLM_MODEL_ID,
        suggestedProvider: 'gemini'
      },
      onSelectModel: noop,
      onLoadModel: noop,
      onSelectProvider: noop
    })
  );
  assert.match(errorHtml, /Try SmolLM2 360M/);
  assert.match(errorHtml, /Switch to Cloud AI/);
  assert.match(errorHtml, /Retry/);

  // Verify inspectWebLLMReadiness exposes suggestedProvider on unsupported WebGPU
  resetWebLLMRuntimeForTesting();
  const restoreNav = setGlobalProp('navigator', { deviceMemory: 8 });
  const restoreWindow = setGlobalProp('window', { isSecureContext: true });
  try {
    await inspectWebLLMReadiness(DEFAULT_WEBLLM_MODEL_ID);
    const st = getWebLLMState();
    assert.equal(st.suggestedProvider, 'gemini');
  } finally {
    restoreNav();
    restoreWindow();
    resetWebLLMRuntimeForTesting();
  }
});


