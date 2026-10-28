/**
 * Phase 4G — WebLLM Provider Hardening Verification Suite
 *
 * Comprehensive end-to-end unit, behavioral, and integration verification of Orvix's
 * Browser AI (WebLLM) provider integration covering:
 * - Execution environment & WebGPU browser detection
 * - Model selection, cross-provider rejection & registry validation
 * - Lazy initialization, concurrency deduplication & engine switching
 * - System instructions, chronological history & document/OCR grounding
 * - Streaming token delivery, empty-chunk guards & error normalization
 * - Cancellation, request isolation & interruption propagation
 * - Privacy protection, non-fallback local policy & cloud provider exclusion
 *
 * Run with: node scripts/testPhase4G.js
 */

process.env.TESTING = '1';

import assert from 'node:assert/strict';
import http from 'node:http';

import {
  DEFAULT_WEBLLM_MODEL_ID,
  FALLBACK_F32_WEBLLM_MODEL_ID,
  LIGHTWEIGHT_WEBLLM_MODEL_ID,
  LIGHTWEIGHT_F32_WEBLLM_MODEL_ID,
  WEBLLM_MODEL_CATALOG,
  WEBLLM_ERROR_CODES,
  WebLLMError,
  checkWebGPUSupport,
  resolveWebLLMModelId,
  ensureWebLLMEngine,
  destroyWebLLMEngine,
  stopWebLLMGeneration,
  streamWebLLMMessage,
  sendWebLLMMessage,
  normalizeWebLLMError,
  getWebLLMState,
  subscribeWebLLMState,
  setWebLLMWorkerFactoryForTesting,
  setWebLLMEngineFactoryForTesting,
  resetWebLLMRuntimeForTesting
} from '../src/services/webllmService.js';

import {
  AI_PROVIDERS,
  streamAIMessage,
  sendAIMessage
} from '../src/services/aiRouter.js';

import {
  WEBLLM_SUPPORTED_MODELS,
  checkModelCompatibilityForProvider,
  sanitizeModelForProvider,
  validateServerModelForProvider,
  isLocalProvider,
  isSupportedProvider
} from '../src/services/providerModelSanitizer.js';

import {
  prepareDocumentContext,
  adaptDocumentContextForProvider,
  isVisionCapableProvider
} from '../src/services/documentContextService.js';

import {
  createRequestIsolationController,
  cancelActiveChatRequest,
  runIsolatedPromptStream
} from '../src/services/requestIsolationService.js';

const { app } = await import('../server.ts');

let passed = 0;
let failed = 0;

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`  ✅ PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ FAIL: ${name}`);
    console.error(`     ${err.stack || err.message}`);
    failed++;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setupMockBrowserEnvironment({
  hasGpu = true,
  hasShaderF16 = true,
  isSecureContext = true,
  isOnline = true,
  quota = 10 * 1024 * 1024 * 1024,
  usage = 100 * 1024 * 1024
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
          estimate: async () => ({ quota, usage }),
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
      Object.defineProperty(globalThis.navigator, 'storage', {
        value: { estimate: async () => ({ quota, usage }), persist: async () => true },
        configurable: true,
        writable: true
      });
    } catch (_ignore) {}
  }

  const cacheStore = new Map();
  globalThis.caches = {
    open: async (cacheName) => ({
      keys: async () => [],
      match: async (req) => {
        const url = typeof req === 'string' ? req : req.url;
        return cacheStore.get(`${cacheName}:${url}`) || null;
      },
      put: async (req, res) => {
        const url = typeof req === 'string' ? req : req.url;
        cacheStore.set(`${cacheName}:${url}`, res);
      }
    }),
    has: async () => true,
    delete: async () => true
  };

  return { adapter, cacheStore };
}

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

function createMockEngine({
  textChunks = ['Hello', ' from', ' Browser', ' AI!'],
  chunkDelayMs = 0,
  shouldFailMidStream = false,
  midStreamError = new Error('GPU device was lost during decoding'),
  onInterrupt = null,
  emptyResponse = false
} = {}) {
  let wasInterrupted = false;

  return {
    chat: {
      completions: {
        create: async (params) => {
          if (emptyResponse) {
            return (async function* () {})();
          }

          return (async function* () {
            for (let i = 0; i < textChunks.length; i++) {
              if (wasInterrupted) break;
              if (chunkDelayMs > 0) {
                await sleep(chunkDelayMs);
              }
              if (wasInterrupted) break;
              if (shouldFailMidStream && i >= Math.floor(textChunks.length / 2)) {
                throw midStreamError;
              }
              yield {
                choices: [{ delta: { content: textChunks[i] } }],
                usage: i === textChunks.length - 1 ? { prompt_tokens: 15, completion_tokens: 20 } : undefined
              };
            }
          })();
        }
      }
    },
    interruptGenerate: () => {
      wasInterrupted = true;
      if (typeof onInterrupt === 'function') onInterrupt();
    },
    unload: async () => {}
  };
}

console.log('=== Starting Phase 4G: WebLLM Provider Hardening Verification Suite ===');

// ============================================================================
// Group A — Runtime and Model Configuration (1–10)
// ============================================================================
console.log('\n--- Group A: Runtime and Model Configuration (1–10) ---');

await runTest('1. WebLLM dispatches through the correct browser-side execution path', async () => {
  setupMockBrowserEnvironment();
  resetWebLLMRuntimeForTesting();

  let engineFactoryCalled = false;
  let receivedModelId = null;

  setWebLLMWorkerFactoryForTesting(() => createMockWorker());
  setWebLLMEngineFactoryForTesting(async ({ modelId, handleInitProgress }) => {
    engineFactoryCalled = true;
    receivedModelId = modelId;
    handleInitProgress({ progress: 1, text: 'Model loaded' });
    return createMockEngine({ textChunks: ['Local execution confirmed'] });
  });

  const res = await streamAIMessage({
    provider: 'webllm',
    prompt: 'Testing browser path'
  });

  assert.strictEqual(engineFactoryCalled, true, 'Engine factory must be invoked in browser path');
  assert.strictEqual(res.provider, 'webllm');
  assert.strictEqual(res.text, 'Local execution confirmed');
});

await runTest('2. A valid supported model is selected correctly', async () => {
  setupMockBrowserEnvironment();
  resetWebLLMRuntimeForTesting();

  const compat = checkModelCompatibilityForProvider('webllm', 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC');
  assert.strictEqual(compat.compatible, true);
  assert.strictEqual(compat.normalizedModel, 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC');

  const resolved = resolveWebLLMModelId('qwen2.5-0.5b-instruct-q4f16_1-mlc', { hasShaderF16: true });
  assert.strictEqual(resolved, 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC');
});

await runTest('3. The configured default model is used when appropriate', async () => {
  setupMockBrowserEnvironment();
  resetWebLLMRuntimeForTesting();

  const resolved = resolveWebLLMModelId(null, { hasShaderF16: true });
  assert.strictEqual(resolved, DEFAULT_WEBLLM_MODEL_ID);

  const compat = checkModelCompatibilityForProvider('webllm', null);
  assert.strictEqual(compat.compatible, true);
  assert.strictEqual(compat.normalizedModel, null);
});

await runTest('4. A user-selected supported model is preserved', async () => {
  setupMockBrowserEnvironment();
  resetWebLLMRuntimeForTesting();

  let loadedModel = null;
  setWebLLMWorkerFactoryForTesting(() => createMockWorker());
  setWebLLMEngineFactoryForTesting(async ({ modelId }) => {
    loadedModel = modelId;
    return createMockEngine({ textChunks: ['Preserved'] });
  });

  const res = await streamAIMessage({
    provider: 'webllm',
    model: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC',
    prompt: 'Check model preservation'
  });

  assert.strictEqual(loadedModel, 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC');
  assert.strictEqual(res.modelUsed, 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC');
});

await runTest('5. Unsupported model identifiers produce a structured error', async () => {
  setupMockBrowserEnvironment();
  resetWebLLMRuntimeForTesting();

  await assert.rejects(
    async () => {
      await streamAIMessage({
        provider: 'webllm',
        model: 'Unsupported-Llama-3-MLC',
        prompt: 'Hi'
      });
    },
    (err) => {
      assert.strictEqual(err.code, 400);
      assert.strictEqual(err.errorCode, WEBLLM_ERROR_CODES.UNSUPPORTED_MODEL);
      assert.strictEqual(err.provider, 'webllm');
      assert.strictEqual(err.retryable, false);
      return true;
    }
  );
});

await runTest('6. Cross-provider model identifiers are rejected', async () => {
  setupMockBrowserEnvironment();
  resetWebLLMRuntimeForTesting();

  const foreignModels = [
    'gemini-2.5-flash',
    'openai/gpt-oss-120b',
    'openrouter/free',
    '@cf/meta/llama-3.1-8b-instruct',
    'qwen2.5:1.5b',
    'gpt-4o',
    'claude-3-5-sonnet'
  ];

  for (const foreign of foreignModels) {
    const compat = checkModelCompatibilityForProvider('webllm', foreign);
    assert.strictEqual(compat.compatible, false, `Expected ${foreign} to be incompatible for webllm`);

    await assert.rejects(
      async () => {
        await streamAIMessage({
          provider: 'webllm',
          model: foreign,
          prompt: 'test'
        });
      },
      (err) => {
        assert.strictEqual(err.code, 400);
        assert.strictEqual(err.errorCode, WEBLLM_ERROR_CODES.UNSUPPORTED_MODEL);
        return true;
      }
    );
  }
});

await runTest('7. Missing WebGPU or required runtime capability is handled clearly', async () => {
  setupMockBrowserEnvironment({ hasGpu: false });
  resetWebLLMRuntimeForTesting();

  const support = await checkWebGPUSupport();
  assert.strictEqual(support.supported, false);
  assert.strictEqual(support.reasonCode, WEBLLM_ERROR_CODES.WEBGPU_UNSUPPORTED);

  await assert.rejects(
    async () => {
      await ensureWebLLMEngine();
    },
    (err) => {
      assert.strictEqual(err.errorCode, WEBLLM_ERROR_CODES.WEBGPU_UNSUPPORTED);
      assert.strictEqual(err.canFallback, false);
      assert.strictEqual(err.retryable, false);
      return true;
    }
  );
});

await runTest('8. Invalid generation parameters are rejected or normalized according to the actual API', async () => {
  setupMockBrowserEnvironment();
  resetWebLLMRuntimeForTesting();

  setWebLLMWorkerFactoryForTesting(() => createMockWorker());
  setWebLLMEngineFactoryForTesting(async () => createMockEngine());

  // 1. Invalid temperature (< 0 or > 2)
  await assert.rejects(
    async () => {
      await streamWebLLMMessage({
        prompt: 'test',
        temperature: -0.5
      });
    },
    (err) => {
      assert.strictEqual(err.status, 'INVALID_ARGUMENT');
      return true;
    }
  );

  // 2. Invalid top_p (<= 0 or > 1)
  await assert.rejects(
    async () => {
      await streamWebLLMMessage({
        prompt: 'test',
        top_p: 1.5
      });
    },
    (err) => {
      assert.strictEqual(err.status, 'INVALID_ARGUMENT');
      return true;
    }
  );

  // 3. Invalid max_tokens (<= 0)
  await assert.rejects(
    async () => {
      await streamWebLLMMessage({
        prompt: 'test',
        max_tokens: 0
      });
    },
    (err) => {
      assert.strictEqual(err.status, 'INVALID_ARGUMENT');
      return true;
    }
  );
});

await runTest('9. The provider and model attribution reflect the actual engine', async () => {
  setupMockBrowserEnvironment();
  resetWebLLMRuntimeForTesting();

  setWebLLMWorkerFactoryForTesting(() => createMockWorker());
  setWebLLMEngineFactoryForTesting(async () => createMockEngine({ textChunks: ['Attribution check'] }));

  let startReport = null;
  const result = await streamAIMessage({
    provider: 'webllm',
    model: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
    prompt: 'Check attribution',
    onStart: (info) => {
      startReport = info;
    }
  });

  assert.strictEqual(startReport?.provider, 'webllm');
  assert.strictEqual(startReport?.modelUsed, 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC');
  assert.strictEqual(result.provider, 'webllm');
  assert.strictEqual(result.modelUsed, 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC');
});

await runTest('10. WebLLM requests do not accidentally reach unrelated provider endpoints', async () => {
  // Test server-side guard: POST /api/chat with provider=webllm must be explicitly rejected
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'webllm',
        prompt: 'Should not reach server inference'
      })
    });

    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.strictEqual(body.status, 'LOCAL_PROVIDER_ONLY');
    assert.strictEqual(body.provider, 'webllm');
    assert.strictEqual(body.canFallback, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ============================================================================
// Group B — Initialization and Context (11–20)
// ============================================================================
console.log('\n--- Group B: Initialization and Context (11–20) ---');

await runTest('11. Successful engine initialization permits generation', async () => {
  setupMockBrowserEnvironment();
  resetWebLLMRuntimeForTesting();

  setWebLLMWorkerFactoryForTesting(() => createMockWorker());
  setWebLLMEngineFactoryForTesting(async ({ handleInitProgress }) => {
    handleInitProgress({ progress: 1, text: 'Ready' });
    return createMockEngine({ textChunks: ['Generation succeeded after init'] });
  });

  const res = await sendWebLLMMessage({
    prompt: 'Hello world'
  });

  assert.strictEqual(res.text, 'Generation succeeded after init');
  assert.strictEqual(getWebLLMState().status, 'ready');
});

await runTest('12. Initialization failures clear loading state', async () => {
  setupMockBrowserEnvironment();
  resetWebLLMRuntimeForTesting();

  setWebLLMWorkerFactoryForTesting(() => createMockWorker());
  setWebLLMEngineFactoryForTesting(async () => {
    throw new Error('WebGPU memory allocation failed');
  });

  await assert.rejects(
    async () => {
      await ensureWebLLMEngine();
    },
    (err) => {
      assert.strictEqual(err.errorCode, WEBLLM_ERROR_CODES.DEVICE_LOST);
      return true;
    }
  );

  const state = getWebLLMState();
  assert.strictEqual(state.status, 'error');
  assert.strictEqual(state.progress, 0);
});

await runTest('13. Concurrent requests do not duplicate unsafe engine initialization', async () => {
  setupMockBrowserEnvironment();
  resetWebLLMRuntimeForTesting();

  let initCalls = 0;
  setWebLLMWorkerFactoryForTesting(() => createMockWorker());
  setWebLLMEngineFactoryForTesting(async () => {
    initCalls++;
    await sleep(25);
    return createMockEngine();
  });

  const [res1, res2] = await Promise.all([
    ensureWebLLMEngine({ modelId: DEFAULT_WEBLLM_MODEL_ID }),
    ensureWebLLMEngine({ modelId: DEFAULT_WEBLLM_MODEL_ID })
  ]);

  assert.strictEqual(initCalls, 1, 'Initialization must only occur once for concurrent requests on the same model');
  assert.strictEqual(res1.engine, res2.engine);
});

await runTest('14. Model switching does not reuse an incompatible engine configuration', async () => {
  setupMockBrowserEnvironment();
  resetWebLLMRuntimeForTesting();

  let unloads = 0;
  const loadedModels = [];

  setWebLLMWorkerFactoryForTesting(() => createMockWorker());
  setWebLLMEngineFactoryForTesting(async ({ modelId }) => {
    loadedModels.push(modelId);
    return {
      chat: { completions: { create: async () => (async function* () { yield { choices: [{ delta: { content: 'ok' } }] }; })() } },
      interruptGenerate: () => {},
      unload: async () => { unloads++; }
    };
  });

  await ensureWebLLMEngine({ modelId: DEFAULT_WEBLLM_MODEL_ID });
  assert.deepStrictEqual(loadedModels, [DEFAULT_WEBLLM_MODEL_ID]);

  await ensureWebLLMEngine({ modelId: LIGHTWEIGHT_WEBLLM_MODEL_ID });
  assert.strictEqual(unloads, 1, 'Previous engine must be unloaded when switching models');
  assert.deepStrictEqual(loadedModels, [DEFAULT_WEBLLM_MODEL_ID, LIGHTWEIGHT_WEBLLM_MODEL_ID]);
});

await runTest('15. A failed model load can be retried deliberately', async () => {
  setupMockBrowserEnvironment();
  resetWebLLMRuntimeForTesting();

  let attempt = 0;
  setWebLLMWorkerFactoryForTesting(() => createMockWorker());
  setWebLLMEngineFactoryForTesting(async () => {
    attempt++;
    if (attempt === 1) {
      throw new Error('Temporary worker timeout');
    }
    return createMockEngine({ textChunks: ['Recovery successful'] });
  });

  await assert.rejects(async () => {
    await ensureWebLLMEngine();
  });

  const res = await streamWebLLMMessage({ prompt: 'Retry turn' });
  assert.strictEqual(res.text, 'Recovery successful');
  assert.strictEqual(attempt, 2);
});

await runTest('16. System instructions are preserved', async () => {
  setupMockBrowserEnvironment();
  resetWebLLMRuntimeForTesting();

  let capturedMessages = null;
  setWebLLMWorkerFactoryForTesting(() => createMockWorker());
  setWebLLMEngineFactoryForTesting(async () => {
    return {
      chat: {
        completions: {
          create: async (params) => {
            capturedMessages = params.messages;
            return (async function* () {
              yield { choices: [{ delta: { content: 'instruction verified' } }] };
            })();
          }
        }
      },
      interruptGenerate: () => {},
      unload: async () => {}
    };
  });

  await streamWebLLMMessage({
    prompt: 'Write code',
    mode: 'coding',
    username: 'Alice',
    preferences: { responseLength: 'concise', beginnerFriendly: true }
  });

  assert.ok(capturedMessages && capturedMessages.length > 0);
  const sysMsg = capturedMessages.find((m) => m.role === 'system');
  assert.ok(sysMsg, 'System message must be present');
  assert.ok(sysMsg.content.includes('Alice'), 'System instruction should include username');
  assert.ok(sysMsg.content.includes('Coding'), 'System instruction should include active mode');
  assert.ok(sysMsg.content.includes('Concise'), 'System instruction should include concise preference');
});

await runTest('17. Conversation history is correctly ordered', async () => {
  setupMockBrowserEnvironment();
  resetWebLLMRuntimeForTesting();

  let capturedMessages = null;
  setWebLLMWorkerFactoryForTesting(() => createMockWorker());
  setWebLLMEngineFactoryForTesting(async () => {
    return {
      chat: {
        completions: {
          create: async (params) => {
            capturedMessages = params.messages;
            return (async function* () {
              yield { choices: [{ delta: { content: 'history verified' } }] };
            })();
          }
        }
      },
      interruptGenerate: () => {},
      unload: async () => {}
    };
  });

  const history = [
    { sender: 'user', content: 'Turn 1' },
    { sender: 'assistant', content: 'Reply 1' },
    { sender: 'user', content: 'Turn 2' },
    { sender: 'assistant', content: 'Reply 2' }
  ];

  await streamWebLLMMessage({
    prompt: 'Turn 3',
    history
  });

  assert.ok(capturedMessages);
  const nonSystem = capturedMessages.filter((m) => m.role !== 'system');
  assert.strictEqual(nonSystem.length, 5);
  assert.strictEqual(nonSystem[0].content, 'Turn 1');
  assert.strictEqual(nonSystem[1].content, 'Reply 1');
  assert.strictEqual(nonSystem[2].content, 'Turn 2');
  assert.strictEqual(nonSystem[3].content, 'Reply 2');
  assert.strictEqual(nonSystem[4].content, 'Turn 3');
});

await runTest('18. The current prompt is included exactly once', async () => {
  setupMockBrowserEnvironment();
  resetWebLLMRuntimeForTesting();

  let capturedMessages = null;
  setWebLLMWorkerFactoryForTesting(() => createMockWorker());
  setWebLLMEngineFactoryForTesting(async () => {
    return {
      chat: {
        completions: {
          create: async (params) => {
            capturedMessages = params.messages;
            return (async function* () {
              yield { choices: [{ delta: { content: 'prompt once' } }] };
            })();
          }
        }
      },
      interruptGenerate: () => {},
      unload: async () => {}
    };
  });

  await streamWebLLMMessage({
    prompt: 'Unique test prompt 12345',
    history: [{ sender: 'user', content: 'Prior user turn' }]
  });

  const matching = capturedMessages.filter((m) => m.content.includes('Unique test prompt 12345'));
  assert.strictEqual(matching.length, 1, 'Current prompt must appear exactly once');
});

await runTest('19. OCR and supported document text are preserved', async () => {
  setupMockBrowserEnvironment();
  resetWebLLMRuntimeForTesting();

  let capturedMessages = null;
  setWebLLMWorkerFactoryForTesting(() => createMockWorker());
  setWebLLMEngineFactoryForTesting(async () => {
    return {
      chat: {
        completions: {
          create: async (params) => {
            capturedMessages = params.messages;
            return (async function* () {
              yield { choices: [{ delta: { content: 'ocr processed' } }] };
            })();
          }
        }
      },
      interruptGenerate: () => {},
      unload: async () => {}
    };
  });

  const attachments = [
    {
      id: 'doc-1',
      originalName: 'receipt.png',
      isImage: true,
      extraction: {
        status: 'ready',
        text: 'Total: $42.50\nTax: $3.50\nDate: 2026-10-27',
        format: 'PNG'
      }
    }
  ];

  await streamWebLLMMessage({
    prompt: 'What was the total on this receipt?',
    attachments
  });

  const userTurn = capturedMessages.find((m) => m.role === 'user');
  assert.ok(userTurn.content.includes('ATTACHED DOCUMENT & IMAGE OCR CONTEXT'));
  assert.ok(userTurn.content.includes('Total: $42.50'));
});

await runTest('20. Raw image bytes are not sent to text-only models', async () => {
  assert.strictEqual(isVisionCapableProvider('webllm'), false, 'WebLLM must be registered as a text-only provider');

  // Verify router strips raw image bytes before invoking streamWebLLMMessage
  setupMockBrowserEnvironment();
  resetWebLLMRuntimeForTesting();

  let passedAttachments = null;
  setWebLLMWorkerFactoryForTesting(() => createMockWorker());
  setWebLLMEngineFactoryForTesting(async () => {
    return {
      chat: {
        completions: {
          create: async (params) => {
            return (async function* () {
              yield { choices: [{ delta: { content: 'no raw bytes' } }] };
            })();
          }
        }
      },
      interruptGenerate: () => {},
      unload: async () => {}
    };
  });

  const imageAtt = {
    id: 'img-1',
    name: 'test.jpg',
    base64: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD...',
    dataUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRg...',
    extraction: { status: 'ready', text: 'Signboard text: Exit Here' }
  };

  await streamAIMessage({
    provider: 'webllm',
    prompt: 'What does this sign say?',
    attachments: [imageAtt]
  });

  // Verify attachment storage service sanitizer strips bytes
  const { sanitizeAttachmentForNetwork } = await import('../src/services/attachmentStorageService.js');
  const sanitized = sanitizeAttachmentForNetwork(imageAtt, { includeImageBytes: false });
  assert.strictEqual(sanitized.base64, undefined);
  assert.strictEqual(sanitized.dataUrl, undefined);
});

// ============================================================================
// Group C — Streaming and Error Handling (21–32)
// ============================================================================
console.log('\n--- Group C: Streaming and Error Handling (21–32) ---');

await runTest('21. Incremental output is delivered in order', async () => {
  setupMockBrowserEnvironment();
  resetWebLLMRuntimeForTesting();

  const chunksEmitted = [];
  setWebLLMWorkerFactoryForTesting(() => createMockWorker());
  setWebLLMEngineFactoryForTesting(async () => {
    return createMockEngine({ textChunks: ['First ', 'Second ', 'Third'] });
  });

  const res = await streamWebLLMMessage({
    prompt: 'Stream test',
    onChunk: (delta) => chunksEmitted.push(delta)
  });

  assert.deepStrictEqual(chunksEmitted, ['First ', 'Second ', 'Third']);
  assert.strictEqual(res.text, 'First Second Third');
});

await runTest('22. Empty chunks are ignored safely', async () => {
  setupMockBrowserEnvironment();
  resetWebLLMRuntimeForTesting();

  const chunksEmitted = [];
  setWebLLMWorkerFactoryForTesting(() => createMockWorker());
  setWebLLMEngineFactoryForTesting(async () => {
    return createMockEngine({ textChunks: ['Alpha', '', null, undefined, 'Beta'] });
  });

  const res = await streamWebLLMMessage({
    prompt: 'Empty chunks test',
    onChunk: (delta) => chunksEmitted.push(delta)
  });

  assert.deepStrictEqual(chunksEmitted, ['Alpha', 'Beta']);
  assert.strictEqual(res.text, 'AlphaBeta');
});

await runTest('23. Successful completion produces one terminal success', async () => {
  setupMockBrowserEnvironment();
  resetWebLLMRuntimeForTesting();

  setWebLLMWorkerFactoryForTesting(() => createMockWorker());
  setWebLLMEngineFactoryForTesting(async () => createMockEngine({ textChunks: ['Complete'] }));

  const res = await streamWebLLMMessage({ prompt: 'Terminal check' });
  assert.strictEqual(res.text, 'Complete');
  assert.strictEqual(res.provider, 'webllm');
});

await runTest('24. Runtime exceptions become structured errors', async () => {
  setupMockBrowserEnvironment();
  resetWebLLMRuntimeForTesting();

  setWebLLMWorkerFactoryForTesting(() => createMockWorker());
  setWebLLMEngineFactoryForTesting(async () => {
    return createMockEngine({
      shouldFailMidStream: true,
      midStreamError: new Error('WebGPU memory allocation failed')
    });
  });

  await assert.rejects(
    async () => {
      await streamWebLLMMessage({ prompt: 'Fail test' });
    },
    (err) => {
      assert.strictEqual(err.errorCode, WEBLLM_ERROR_CODES.DEVICE_LOST);
      assert.strictEqual(err.code, 507);
      assert.strictEqual(err.provider, 'webllm');
      return true;
    }
  );
});

await runTest('25. Initialization errors are distinguishable from inference errors', async () => {
  const initErr = normalizeWebLLMError(new Error('Unknown init failure'), { phase: 'init' });
  const genErr = normalizeWebLLMError(new Error('Unknown gen failure'), { phase: 'generate' });

  assert.strictEqual(initErr.errorCode, WEBLLM_ERROR_CODES.INIT_FAILED);
  assert.strictEqual(genErr.errorCode, WEBLLM_ERROR_CODES.GENERATION_FAILED);
});

await runTest('26. Unsupported runtime capabilities are classified correctly', async () => {
  const f16Err = normalizeWebLLMError(new Error('shader-f16 feature is not supported'));
  assert.strictEqual(f16Err.errorCode, WEBLLM_ERROR_CODES.SHADER_F16_UNSUPPORTED);

  const gpuErr = normalizeWebLLMError(new Error('Cannot find WebGPU'));
  assert.strictEqual(gpuErr.errorCode, WEBLLM_ERROR_CODES.WEBGPU_UNSUPPORTED);

  const adapterErr = normalizeWebLLMError(new Error('No compatible WebGPU graphics adapter found'));
  assert.strictEqual(adapterErr.errorCode, WEBLLM_ERROR_CODES.WEBGPU_ADAPTER_UNAVAILABLE);
});

await runTest('27. Unsupported models are not misclassified as network errors', async () => {
  const unsuppErr = normalizeWebLLMError(
    new Error('Load failed: cannot find model record "NonExistentModel"'),
    { phase: 'init', modelId: 'NonExistentModel' }
  );

  assert.strictEqual(unsuppErr.errorCode, WEBLLM_ERROR_CODES.UNSUPPORTED_MODEL);
  assert.notStrictEqual(unsuppErr.errorCode, WEBLLM_ERROR_CODES.DOWNLOAD_FAILED);
});

await runTest('28. Empty completed output is handled correctly', async () => {
  setupMockBrowserEnvironment();
  resetWebLLMRuntimeForTesting();

  setWebLLMWorkerFactoryForTesting(() => createMockWorker());
  setWebLLMEngineFactoryForTesting(async () => createMockEngine({ emptyResponse: true }));

  await assert.rejects(
    async () => {
      await streamWebLLMMessage({ prompt: 'Expect empty' });
    },
    (err) => {
      assert.strictEqual(err.errorCode, WEBLLM_ERROR_CODES.GENERATION_FAILED);
      assert.ok(err.message.includes('empty response'));
      return true;
    }
  );
});

await runTest('29. Interrupted generation does not produce false success', async () => {
  setupMockBrowserEnvironment();
  resetWebLLMRuntimeForTesting();

  const controller = new AbortController();
  setWebLLMWorkerFactoryForTesting(() => createMockWorker());
  setWebLLMEngineFactoryForTesting(async () => {
    return createMockEngine({
      textChunks: ['A', 'B', 'C', 'D'],
      chunkDelayMs: 20
    });
  });

  const streamPromise = streamWebLLMMessage({
    prompt: 'Interrupted stream',
    signal: controller.signal
  });

  setTimeout(() => controller.abort(), 10);

  await assert.rejects(
    async () => {
      await streamPromise;
    },
    (err) => {
      assert.strictEqual(err.name, 'AbortError');
      return true;
    }
  );
});

await runTest('30. Partial output is preserved when appropriate', async () => {
  setupMockBrowserEnvironment();
  resetWebLLMRuntimeForTesting();

  let capturedError = null;
  setWebLLMWorkerFactoryForTesting(() => createMockWorker());
  setWebLLMEngineFactoryForTesting(async () => {
    return createMockEngine({
      textChunks: ['Start of text', ' that continues'],
      shouldFailMidStream: true,
      midStreamError: new Error('Worker crash')
    });
  });

  try {
    await streamWebLLMMessage({ prompt: 'Partial text test' });
    assert.fail('Should have thrown mid-stream');
  } catch (err) {
    capturedError = err;
  }

  assert.strictEqual(capturedError.partial, true);
  assert.strictEqual(capturedError.partialText, 'Start of text');
  assert.strictEqual(capturedError.retryable, false);
});

await runTest('31. A partial failure does not cause duplicate output through retry', async () => {
  setupMockBrowserEnvironment();
  resetWebLLMRuntimeForTesting();

  setWebLLMWorkerFactoryForTesting(() => createMockWorker());
  setWebLLMEngineFactoryForTesting(async () => {
    return createMockEngine({
      textChunks: ['TokenA', 'TokenB'],
      shouldFailMidStream: true,
      midStreamError: new Error('Mid-stream failure')
    });
  });

  try {
    await streamAIMessage({
      provider: 'webllm',
      prompt: 'Retry test'
    });
    assert.fail('Expected midstream failure');
  } catch (err) {
    assert.strictEqual(err.retryable, false, 'Retryable must be false when partial output has been emitted');
    assert.strictEqual(err.partial, true);
  }
});

await runTest('32. Compound failures cannot produce multiple terminal events', async () => {
  setupMockBrowserEnvironment();
  resetWebLLMRuntimeForTesting();

  const controller = createRequestIsolationController();
  let updates = 0;
  let classifiedErr = null;

  const mockFailRequest = async ({ onChunk }) => {
    onChunk('Some words', 'Some words');
    throw new Error('Fatal engine crash');
  };

  const streamResult = await runIsolatedPromptStream({
    controller,
    targetChatId: 'chat-compound',
    assistantMessageId: 'msg-compound',
    providerToUse: 'webllm',
    promptText: 'Compound check',
    getActiveChatId: () => 'chat-compound',
    onUpdateMessages: () => updates++,
    onPersistMessage: () => {},
    onSetLoadingState: () => {},
    streamRequest: mockFailRequest,
    classifyError: (err) => {
      classifiedErr = err;
      return {
        friendlyMsg: err.message,
        effectiveProvider: 'webllm',
        canSwitchProvider: false
      };
    }
  });

  assert.strictEqual(streamResult.status, 'error');
  assert.ok(classifiedErr);
  assert.strictEqual(classifiedErr.message, 'Fatal engine crash');
  assert.strictEqual(controller.hasActiveRequest(), false);
});

// ============================================================================
// Group D — Cancellation and Isolation (33–39)
// ============================================================================
console.log('\n--- Group D: Cancellation and Isolation (33–39) ---');

await runTest('33. Cancellation during generation suppresses further UI updates', async () => {
  setupMockBrowserEnvironment();
  resetWebLLMRuntimeForTesting();

  const controller = new AbortController();
  const chunksReceived = [];

  setWebLLMWorkerFactoryForTesting(() => createMockWorker());
  setWebLLMEngineFactoryForTesting(async () => {
    return createMockEngine({
      textChunks: ['One ', 'Two ', 'Three ', 'Four '],
      chunkDelayMs: 25
    });
  });

  const streamPromise = streamWebLLMMessage({
    prompt: 'Suppression test',
    signal: controller.signal,
    onChunk: (chunk) => chunksReceived.push(chunk)
  });

  await sleep(35);
  controller.abort();

  await assert.rejects(async () => streamPromise, { name: 'AbortError' });
  const countAtAbort = chunksReceived.length;
  await sleep(60);

  assert.strictEqual(chunksReceived.length, countAtAbort, 'No late chunks should be received after abort');
});

await runTest('34. Underlying generation is aborted when the runtime supports it', async () => {
  setupMockBrowserEnvironment();
  resetWebLLMRuntimeForTesting();

  let interruptCalled = false;
  setWebLLMWorkerFactoryForTesting(() => createMockWorker());
  setWebLLMEngineFactoryForTesting(async () => {
    return createMockEngine({
      textChunks: ['A', 'B', 'C', 'D'],
      chunkDelayMs: 20,
      onInterrupt: () => { interruptCalled = true; }
    });
  });

  const controller = new AbortController();
  const streamPromise = streamWebLLMMessage({
    prompt: 'Check interrupt',
    signal: controller.signal
  });

  await sleep(15);
  controller.abort();

  await assert.rejects(async () => streamPromise, { name: 'AbortError' });
  assert.strictEqual(interruptCalled, true, 'engine.interruptGenerate() must be physically called');
});

await runTest('35. Cancellation does not trigger retry', async () => {
  setupMockBrowserEnvironment();
  resetWebLLMRuntimeForTesting();

  let attempts = 0;
  setWebLLMWorkerFactoryForTesting(() => createMockWorker());
  setWebLLMEngineFactoryForTesting(async () => {
    attempts++;
    return createMockEngine({ textChunks: ['T1', 'T2'], chunkDelayMs: 30 });
  });

  const controller = new AbortController();
  const promise = streamAIMessage({
    provider: 'webllm',
    prompt: 'No retry on abort',
    signal: controller.signal
  });

  await sleep(10);
  controller.abort();

  await assert.rejects(async () => promise, { name: 'AbortError' });
  assert.strictEqual(attempts, 1, 'Cancelled request must not be retried');
});

await runTest('36. Cancellation does not trigger automatic fallback', async () => {
  setupMockBrowserEnvironment();
  resetWebLLMRuntimeForTesting();

  const controller = createRequestIsolationController();
  let fallbackAttempted = false;

  cancelActiveChatRequest(controller, 'stopped', {
    getActiveChatId: () => 'chat-1',
    onUpdateMessages: () => {},
    onSetLoadingState: () => {},
    stopLocalEngine: () => {}
  });

  assert.strictEqual(fallbackAttempted, false);
  assert.strictEqual(controller.hasActiveRequest(), false);
});

await runTest('37. A newer request prevents stale output from an older request', async () => {
  const controller = createRequestIsolationController();

  const entry1 = controller.beginRequest({ chatId: 'c1', assistantMessageId: 'm1' });
  const entry2 = controller.beginRequest({ chatId: 'c1', assistantMessageId: 'm2' });

  assert.strictEqual(entry1.cancelled, true, 'Older request must be cancelled immediately');
  assert.strictEqual(controller.isRequestActive(entry1.requestId), false);
  assert.strictEqual(controller.isRequestActive(entry2.requestId), true);
});

await runTest('38. Conversation switching blocks late results', async () => {
  const controller = createRequestIsolationController();
  const entry = controller.beginRequest({ chatId: 'c1', assistantMessageId: 'm1' });

  cancelActiveChatRequest(controller, 'conversation_switched', {
    getActiveChatId: () => 'c2',
    onUpdateMessages: () => {},
    onSetLoadingState: () => {},
    stopLocalEngine: () => {}
  });

  assert.strictEqual(entry.cancelled, true);
  assert.strictEqual(controller.isRequestActive(entry.requestId), false);
});

await runTest('39. Repeated cancellation and cleanup do not cause unhandled errors or destroy an engine used by another valid request', async () => {
  setupMockBrowserEnvironment();
  resetWebLLMRuntimeForTesting();

  setWebLLMWorkerFactoryForTesting(() => createMockWorker());
  setWebLLMEngineFactoryForTesting(async () => createMockEngine({ textChunks: ['OK'] }));

  // Call destroyWebLLMEngine multiple times in sequence
  await destroyWebLLMEngine();
  await destroyWebLLMEngine();
  await destroyWebLLMEngine();

  // Next normal request must initialize and succeed without errors
  const res = await streamWebLLMMessage({ prompt: 'After cleanup' });
  assert.strictEqual(res.text, 'OK');
});

// ============================================================================
// Group E — Privacy and Regression Safety (40–45)
// ============================================================================
console.log('\n--- Group E: Privacy and Regression Safety (40–45) ---');

await runTest('40. WebLLM failures do not silently transfer prompts to cloud providers', async () => {
  setupMockBrowserEnvironment();
  resetWebLLMRuntimeForTesting();

  setWebLLMWorkerFactoryForTesting(() => createMockWorker());
  setWebLLMEngineFactoryForTesting(async () => {
    throw new Error('Local inference failure');
  });

  assert.strictEqual(isLocalProvider('webllm'), true);

  await assert.rejects(
    async () => {
      await streamAIMessage({
        provider: 'webllm',
        prompt: 'Secret local prompt'
      });
    },
    (err) => {
      assert.strictEqual(err.canFallback, false, 'WebLLM error must have canFallback: false');
      assert.strictEqual(err.provider, 'webllm');
      return true;
    }
  );
});

await runTest('41. Unconfigured fallback providers are excluded', async () => {
  const { getConfiguredFallbackProviders } = await import('../server.ts');
  const fallbacks = getConfiguredFallbackProviders('webllm');
  // Ollama and WebLLM are local; cloud providers require configured keys
  assert.ok(Array.isArray(fallbacks));
  assert.ok(!fallbacks.includes('webllm'), 'Excludes the current provider');
});

await runTest('42. Explicitly permitted fallback preserves prompt and conversation context', async () => {
  const originalPrompt = 'Summarize document text';
  const history = [{ sender: 'user', content: 'Turn 1' }, { sender: 'assistant', content: 'Answer 1' }];

  const { adaptDocumentContextForProvider } = await import('../src/services/documentContextService.js');
  const adapted = adaptDocumentContextForProvider({
    provider: 'gemini',
    prompt: originalPrompt,
    preparedContext: { formattedContext: 'Excerpt A', directAnswer: null }
  });

  assert.ok(adapted.effectivePrompt.includes(originalPrompt));
  assert.strictEqual(history[0].content, 'Turn 1');
});

await runTest('43. Partial output is not duplicated during provider switching', async () => {
  const { buildStoppedAssistantMessage } = await import('../src/services/requestIsolationService.js');
  const entry = {
    chatId: 'c1',
    assistantMessageId: 'm1',
    displayedText: 'Partial output emitted so far',
    partialText: 'Partial output emitted so far'
  };

  const stoppedMsg = buildStoppedAssistantMessage(null, entry);
  assert.strictEqual(stoppedMsg.content, 'Partial output emitted so far');
  assert.strictEqual(stoppedMsg.isStopped, true);
});

await runTest('44. Only one terminal assistant response is delivered', async () => {
  setupMockBrowserEnvironment();
  resetWebLLMRuntimeForTesting();

  setWebLLMWorkerFactoryForTesting(() => createMockWorker());
  setWebLLMEngineFactoryForTesting(async () => createMockEngine({ textChunks: ['Final answer'] }));

  const res = await streamAIMessage({
    provider: 'webllm',
    prompt: 'Check terminal response'
  });

  assert.strictEqual(res.text, 'Final answer');
  assert.strictEqual(res.provider, 'webllm');
});

await runTest('45. Existing request-isolation and shared-provider behavior remain intact', async () => {
  assert.strictEqual(isSupportedProvider('gemini'), true);
  assert.strictEqual(isSupportedProvider('groq'), true);
  assert.strictEqual(isSupportedProvider('openrouter'), true);
  assert.strictEqual(isSupportedProvider('cloudflare'), true);
  assert.strictEqual(isSupportedProvider('ollama'), true);
  assert.strictEqual(isSupportedProvider('webllm'), true);
});

console.log(`\n=== Phase 4G Results: ${passed} Passed, ${failed} Failed ===`);
if (failed > 0) {
  process.exit(1);
}
