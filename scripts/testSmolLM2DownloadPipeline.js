#!/usr/bin/env node

/**
 * testSmolLM2DownloadPipeline.js
 *
 * Targeted regression suite for the SmolLM2 135M (`SmolLM2-135M-Instruct-q0f16-MLC`)
 * 0% download stall fix in Orvix Web (v0.2.6).
 *
 * Verifies:
 * 1. Exact SmolLM2 135M & Qwen 2.5 1.5B model IDs, quantizations, WASM URLs, and features
 *    against the installed `@mlc-ai/web-llm@0.2.86` `prebuiltAppConfig.model_list`.
 * 2. Production Workbox Service Worker (`dist/sw.js`) does NOT intercept cross-origin
 *    `huggingface.co` / `*.hf.co` model weight streams while preserving app-shell & API routes.
 * 3. Bounded live CDN reachability & byte-transfer diagnostic probe (`probeWebLLMModelCDN`)
 *    against Hugging Face's `SmolLM2-135M-Instruct-q0f16-MLC` `params_shard_0.bin` (HTTP 302 -> `*.hf.co`).
 * 4. Redirected CDN host failure (`huggingface.co` 302 -> `us.aws.cdn.hf.co` HTTP 403 / network error)
 *    surfaces `WEBLLM_CDN_UNREACHABLE` with the redirected host instead of hanging at 0%.
 * 5. Reproduced Chrome DevTools `HTTP 200 Pending` zero-byte / mid-stream stall aborts via the
 *    per-chunk stall watchdog (`WEBLLM_DOWNLOAD_STALLED`), transitions UI state to `error`
 *    (never stuck at 0%), and never writes truncated/corrupted shards to `webllm/model`.
 * 6. Streaming byte-progress updates (`0% -> progressive % -> 100%`), corruption self-healing,
 *    and safe Retry resuming from already-cached shards without duplicate workers or engines.
 * 7. Concurrent `ensureWebLLMEngine` calls deduplicate to a single initialization and worker.
 * 8. Worker GPU initialization stall watchdog aborts hung `CreateWebWorkerMLCEngine` cleanly.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import * as webllmPkg from '@mlc-ai/web-llm';

import {
  DEFAULT_WEBLLM_MODEL_ID,
  FALLBACK_F32_WEBLLM_MODEL_ID,
  SMOLLM2_135M_WEBLLM_MODEL_ID,
  SMOLLM2_135M_F32_WEBLLM_MODEL_ID,
  WEBLLM_MODEL_CATALOG,
  WEBLLM_ERROR_CODES,
  probeWebLLMModelCDN,
  downloadModelArtifactsToCache,
  isWebLLMModelCached,
  ensureWebLLMEngine,
  stopWebLLMGeneration,
  getWebLLMState,
  subscribeWebLLMState,
  sanitizeUrlForDiagnostics,
  logWebLLMStage,
  getWebLLMDiagnostics,
  resetWebLLMRuntimeForTesting,
  setWebLLMWorkerFactoryForTesting,
  setWebLLMEngineFactoryForTesting,
  setWebLLMFetchForTesting,
  setWebLLMDownloadConfigForTesting
} from '../src/services/webllmService.js';

import {
  SUPPORTED_PROVIDER_IDS,
  CLOUD_PROVIDER_IDS,
  normalizeProviderId
} from '../src/services/providerModelSanitizer.js';

let passed = 0;
let failed = 0;

async function runCase(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}:`, err?.stack || err?.message || err);
    failed++;
  }
}

/**
 * Creates a spec-faithful in-memory CacheStorage (`keys`, `match`, `put`, `delete`)
 * compatible with both Orvix's pre-downloader and `@mlc-ai/web-llm`'s `hasModelInCache()`.
 */
function createInMemoryCacheStorage() {
  const buckets = new Map();

  function getBucket(scope) {
    if (!buckets.has(scope)) {
      buckets.set(scope, new Map());
    }
    return buckets.get(scope);
  }

  return {
    buckets,
    api: {
      open: async (scope) => {
        const bucket = getBucket(scope);
        return {
          keys: async () => Array.from(bucket.keys()).map((url) => new Request(url)),
          match: async (req) => {
            const url = typeof req === 'string' ? req : req?.url;
            const stored = bucket.get(url);
            return stored ? stored.clone() : undefined;
          },
          put: async (req, res) => {
            const url = typeof req === 'string' ? req : req?.url;
            bucket.set(url, res.clone());
          },
          delete: async (req) => {
            const url = typeof req === 'string' ? req : req?.url;
            return bucket.delete(url);
          }
        };
      },
      has: async (scope) => buckets.has(scope),
      delete: async (scope) => buckets.delete(scope)
    }
  };
}

function installMockBrowserGlobals({ cacheStorage, isOnline = true, hasShaderF16 = true } = {}) {
  const adapter = {
    features: new Set(hasShaderF16 ? ['shader-f16'] : []),
    limits: {
      maxStorageBufferBindingSize: 1073741824,
      maxBufferSize: 1073741824
    },
    info: {
      vendor: 'mock-gpu',
      architecture: 'mock-arch',
      description: 'Mock WebGPU Adapter'
    }
  };

  globalThis.window = {
    isSecureContext: true,
    matchMedia: () => ({ matches: false })
  };

  Object.defineProperty(globalThis, 'navigator', {
    value: {
      onLine: isOnline,
      gpu: {
        requestAdapter: async () => adapter
      },
      storage: {
        estimate: async () => ({ quota: 8 * 1024 * 1024 * 1024, usage: 64 * 1024 * 1024 }),
        persist: async () => true
      }
    },
    configurable: true,
    writable: true
  });

  globalThis.caches = cacheStorage.api;
}

function createChunkedResponse(chunks, { status = 200, url = '', headers = {} } = {}) {
  let idx = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (idx < chunks.length) {
        controller.enqueue(chunks[idx++]);
      } else {
        controller.close();
      }
    }
  });
  const res = new Response(stream, { status, headers });
  if (url) {
    Object.defineProperty(res, 'url', { value: url, configurable: true });
  }
  return res;
}

function createHangingStreamResponse({
  initialChunks = [],
  status = 200,
  url = 'https://us.aws.cdn.hf.co/xet-bridge-us/smollm2/params_shard_0.bin',
  signal,
  headers = {}
} = {}) {
  let idx = 0;
  const stream = new ReadableStream({
    start(controller) {
      if (signal) {
        signal.addEventListener(
          'abort',
          () => {
            try {
              controller.error(new DOMException('The operation was aborted.', 'AbortError'));
            } catch (_) {}
          },
          { once: true }
        );
      }
    },
    pull(controller) {
      if (idx < initialChunks.length) {
        controller.enqueue(initialChunks[idx++]);
        return Promise.resolve();
      }
      // Simulate Chrome DevTools "HTTP 200 Pending" stream that never delivers further bytes
      return new Promise((_, reject) => {
        if (signal) {
          if (signal.aborted) {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
            return;
          }
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('The operation was aborted.', 'AbortError')),
            { once: true }
          );
        }
      });
    }
  });
  const res = new Response(stream, { status, headers });
  Object.defineProperty(res, 'url', { value: url, configurable: true });
  return res;
}

console.log('\n=== SmolLM2 135M Download Pipeline & Stall Protection Suite ===\n');

// 1. Verify exact model IDs & quantizations against installed @mlc-ai/web-llm@0.2.86
await runCase('Exact SmolLM2 135M & Qwen 2.5 1.5B IDs match installed @mlc-ai/web-llm@0.2.86 catalog', async () => {
  const modelList = webllmPkg.prebuiltAppConfig?.model_list;
  assert.ok(Array.isArray(modelList) && modelList.length > 0, 'prebuiltAppConfig.model_list must exist');

  const smolF16 = modelList.find((m) => m.model_id === SMOLLM2_135M_WEBLLM_MODEL_ID);
  const smolF32 = modelList.find((m) => m.model_id === SMOLLM2_135M_F32_WEBLLM_MODEL_ID);
  const qwenF16 = modelList.find((m) => m.model_id === DEFAULT_WEBLLM_MODEL_ID);
  const qwenF32 = modelList.find((m) => m.model_id === FALLBACK_F32_WEBLLM_MODEL_ID);

  assert.ok(smolF16, 'SmolLM2-135M-Instruct-q0f16-MLC must exist in @mlc-ai/web-llm@0.2.86');
  assert.strictEqual(
    smolF16.model,
    'https://huggingface.co/mlc-ai/SmolLM2-135M-Instruct-q0f16-MLC'
  );
  assert.ok(
    smolF16.model_lib.includes('/v0_2_86/') &&
      smolF16.model_lib.endsWith('SmolLM2-135M-Instruct-q0f16_cs1k-webgpu.wasm'),
    'SmolLM2 q0f16 WASM library URL must match v0_2_86'
  );
  assert.deepStrictEqual(smolF16.required_features, ['shader-f16']);

  assert.ok(smolF32, 'SmolLM2-135M-Instruct-q0f32-MLC must exist in @mlc-ai/web-llm@0.2.86');
  assert.ok(qwenF16, 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC must remain valid');
  assert.ok(qwenF32, 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC must remain valid');

  // Verify no SmolLM2 360M or Qwen3 models were added prematurely
  const catalogIds = Object.keys(WEBLLM_MODEL_CATALOG);
  assert.ok(!catalogIds.some((id) => id.includes('360M')), 'SmolLM2 360M must not be added');
  assert.ok(!catalogIds.some((id) => id.toLowerCase().includes('qwen3')), 'Qwen3 must not be added');

  // Verify 4 cloud providers + local webllm & provider normalization remain intact
  assert.deepStrictEqual([...CLOUD_PROVIDER_IDS], ['gemini', 'groq', 'openrouter', 'cloudflare']);
  assert.deepStrictEqual([...SUPPORTED_PROVIDER_IDS], [
    'gemini',
    'groq',
    'openrouter',
    'cloudflare',
    'webllm'
  ]);
  assert.strictEqual(normalizeProviderId('ollama'), 'gemini');
  assert.strictEqual(normalizeProviderId('webllm'), 'webllm');
});

// 2. Verify production Workbox Service Worker bypasses cross-origin model weight CDNs
await runCase('Production dist/sw.js does NOT intercept cross-origin huggingface.co model shard requests', async () => {
  const swPath = path.resolve('dist/sw.js');
  assert.ok(fs.existsSync(swPath), 'dist/sw.js must exist (run npm run build first)');
  const swContent = fs.readFileSync(swPath, 'utf8');

  assert.ok(
    !swContent.includes('huggingface\\.co') && !swContent.includes('huggingface.co'),
    'sw.js must not register any Workbox route intercepting huggingface.co'
  );
  assert.ok(
    !swContent.includes('us.aws.cdn.hf.co'),
    'sw.js must not intercept redirected us.aws.cdn.hf.co streams'
  );
  assert.ok(swContent.includes('NavigationRoute'), 'sw.js must still register SPA NavigationRoute');
  assert.ok(swContent.includes('NetworkOnly'), 'sw.js must still register NetworkOnly for API/Firestore');
  assert.ok(swContent.includes('webllmWorker-'), 'sw.js must still precache webllmWorker bundle');
});

// 3. Live bounded diagnostic probe against real Hugging Face CDN (302 -> *.hf.co)
await runCase('Live bounded CDN probe verifies SmolLM2 135M shard redirect and >0 byte delivery', async () => {
  const shard0Url =
    'https://huggingface.co/mlc-ai/SmolLM2-135M-Instruct-q0f16-MLC/resolve/main/params_shard_0.bin';
  const probe = await probeWebLLMModelCDN(shard0Url, {
    modelLabel: 'SmolLM2 135M Instruct',
    timeoutMs: 15_000
  });

  assert.strictEqual(probe.ok, true);
  assert.ok(probe.status === 206 || probe.status === 200, `Expected HTTP 206/200, got ${probe.status}`);
  assert.ok(probe.transferredBytes > 0 && probe.transferredBytes <= 65536, 'Probe must transfer bounded >0 bytes');
  assert.ok(probe.redirectedHost && probe.redirectedHost.length > 0, 'Redirected CDN hostname must be captured');
  console.log(
    `    [Live CDN Verified] ${probe.originHost} -> ${probe.redirectedHost} (HTTP ${probe.status}, ${probe.transferredBytes} bytes)`
  );
});

// 4. Redirected CDN host failure (huggingface.co 302 -> us.aws.cdn.hf.co HTTP 403) surfaces clear error
await runCase('Blocked redirected CDN host (us.aws.cdn.hf.co HTTP 403) fails fast with actionable error', async () => {
  const blockedFetch = async () => {
    const res = new Response('Forbidden by network filter', { status: 403 });
    Object.defineProperty(res, 'url', {
      value: 'https://us.aws.cdn.hf.co/xet-bridge-us/blocked-shard',
      configurable: true
    });
    return res;
  };

  await assert.rejects(
    () =>
      probeWebLLMModelCDN(
        'https://huggingface.co/mlc-ai/SmolLM2-135M-Instruct-q0f16-MLC/resolve/main/params_shard_0.bin',
        {
          modelLabel: 'SmolLM2 135M',
          timeoutMs: 500,
          fetchImpl: blockedFetch
        }
      ),
    (err) => {
      assert.strictEqual(err.errorCode, WEBLLM_ERROR_CODES.CDN_UNREACHABLE);
      assert.ok(err.message.includes('us.aws.cdn.hf.co'), 'Error must name the redirected CDN host');
      assert.ok(err.message.includes('403'), 'Error must include HTTP status 403');
      return true;
    }
  );
});

// 5. Reproduce Chrome DevTools "HTTP 200 Pending" stall -> aborts cleanly, never stuck at 0%, no cache corruption
await runCase('HTTP 200 Pending shard stream stall aborts via watchdog, updates UI to error, and leaves cache clean', async () => {
  resetWebLLMRuntimeForTesting();
  const cacheStorage = createInMemoryCacheStorage();
  installMockBrowserGlobals({ cacheStorage, isOnline: true, hasShaderF16: true });

  setWebLLMDownloadConfigForTesting({
    probeTimeoutMs: 500,
    stallTimeoutMs: 140,
    concurrency: 2,
    workerStallTimeoutMs: 1000
  });

  const modelBase = 'https://huggingface.co/mlc-ai/SmolLM2-135M-Instruct-q0f16-MLC/resolve/main/';
  const shard0Bytes = new Uint8Array(2048).fill(7);
  const shard1Partial = new Uint8Array(512).fill(9);

  setWebLLMFetchForTesting(async (url, init = {}) => {
    const href = String(url);
    const rangeHeader = init?.headers?.Range || init?.headers?.range;

    if (href.endsWith('mlc-chat-config.json')) {
      return new Response(JSON.stringify({ tokenizer_files: ['tokenizer.json'], context_window_size: 4096 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    if (href.endsWith('tensor-cache.json')) {
      return new Response(
        JSON.stringify({
          records: [
            { name: 'w0', dataPath: 'params_shard_0.bin', nbytes: shard0Bytes.byteLength },
            { name: 'w1', dataPath: 'params_shard_1.bin', nbytes: 4096 }
          ]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (href.endsWith('tokenizer.json')) {
      return new Response(JSON.stringify({ version: '1.0' }), { status: 200 });
    }
    if (href.endsWith('.wasm')) {
      return new Response(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]), { status: 200 });
    }
    if (href.endsWith('params_shard_0.bin')) {
      if (rangeHeader) {
        return createChunkedResponse([shard0Bytes.slice(0, 1024)], {
          status: 206,
          url: 'https://us.aws.cdn.hf.co/xet-bridge-us/params_shard_0.bin'
        });
      }
      return createChunkedResponse([shard0Bytes.slice(0, 1024), shard0Bytes.slice(1024)], {
        status: 200,
        url: 'https://us.aws.cdn.hf.co/xet-bridge-us/params_shard_0.bin',
        headers: { 'Content-Length': String(shard0Bytes.byteLength) }
      });
    }
    if (href.endsWith('params_shard_1.bin')) {
      // Simulate HTTP 200 Pending: delivers 512 bytes then hangs forever without closing
      return createHangingStreamResponse({
        initialChunks: [shard1Partial],
        status: 200,
        url: 'https://us.aws.cdn.hf.co/xet-bridge-us/params_shard_1.bin',
        signal: init?.signal,
        headers: { 'Content-Length': '4096' }
      });
    }
    throw new Error(`Unexpected fetch URL in stall test: ${href}`);
  });

  let workerSpawnCount = 0;
  setWebLLMWorkerFactoryForTesting(() => {
    workerSpawnCount++;
    return { terminate: () => {}, onerror: null, onmessageerror: null };
  });
  setWebLLMEngineFactoryForTesting(async () => ({
    unload: async () => {},
    interruptGenerate: () => {}
  }));

  const observedStates = [];
  const unsubscribe = subscribeWebLLMState((st) => observedStates.push({ ...st }));

  try {
    await assert.rejects(
      () => ensureWebLLMEngine({ modelId: SMOLLM2_135M_WEBLLM_MODEL_ID }),
      (err) => {
        assert.strictEqual(err.errorCode, WEBLLM_ERROR_CODES.DOWNLOAD_STALLED);
        assert.strictEqual(err.retryable, true);
        assert.ok(err.message.includes('params_shard_1.bin'), 'Error must identify the stalled shard');
        assert.ok(err.message.includes('us.aws.cdn.hf.co'), 'Error must identify the redirected CDN host');
        return true;
      }
    );

    const finalState = getWebLLMState();
    assert.strictEqual(finalState.status, 'error', 'Final UI state must be error, never stuck at downloading 0%');
    assert.ok(finalState.error && finalState.error.includes('stalled'), 'Final UI state must expose stall message');
    assert.strictEqual(workerSpawnCount, 0, 'Worker must not be spawned when shard pre-download stalls');

    // Verify progress advanced past 0% before stalling
    const downloadingPercents = observedStates
      .filter((s) => s.status === 'downloading' && typeof s.progressPercent === 'number')
      .map((s) => s.progressPercent);
    assert.ok(
      downloadingPercents.some((pct) => pct > 0),
      `Progress must advance past 0% during streaming (saw: ${JSON.stringify(downloadingPercents)})`
    );

    // Verify completed shard_0 IS cached, while stalled partial shard_1 was NEVER written to cache
    const modelBucket = cacheStorage.buckets.get('webllm/model');
    assert.ok(modelBucket.has(`${modelBase}params_shard_0.bin`), 'Completed shard_0 must be preserved in cache');
    assert.ok(
      !modelBucket.has(`${modelBase}params_shard_1.bin`),
      'Stalled partial shard_1 must NOT be written to cache'
    );
    assert.strictEqual(await isWebLLMModelCached(SMOLLM2_135M_WEBLLM_MODEL_ID), false);

    // 6. Now test SAFE RETRY: shard_1 recovers on retry -> shard_0 is NOT re-downloaded, model reaches ready (100%)
    let shard0FullDownloadsOnRetry = 0;
    let shard1FullDownloadsOnRetry = 0;
    const shard1FullBytes = new Uint8Array(4096).fill(11);

    setWebLLMFetchForTesting(async (url, init = {}) => {
      const href = String(url);
      const rangeHeader = init?.headers?.Range || init?.headers?.range;

      if (href.endsWith('params_shard_0.bin')) {
        if (!rangeHeader) shard0FullDownloadsOnRetry++;
        return createChunkedResponse([shard0Bytes], {
          status: rangeHeader ? 206 : 200,
          url: 'https://us.aws.cdn.hf.co/xet-bridge-us/params_shard_0.bin'
        });
      }
      if (href.endsWith('params_shard_1.bin')) {
        if (rangeHeader) {
          return createChunkedResponse([shard1FullBytes.slice(0, 1024)], {
            status: 206,
            url: 'https://us.aws.cdn.hf.co/xet-bridge-us/params_shard_1.bin'
          });
        }
        shard1FullDownloadsOnRetry++;
        return createChunkedResponse(
          [shard1FullBytes.slice(0, 2048), shard1FullBytes.slice(2048)],
          {
            status: 200,
            url: 'https://us.aws.cdn.hf.co/xet-bridge-us/params_shard_1.bin',
            headers: { 'Content-Length': String(shard1FullBytes.byteLength) }
          }
        );
      }
      throw new Error(`Unexpected fetch on retry (should already be cached): ${href}`);
    });

    let engineFactoryCount = 0;
    setWebLLMEngineFactoryForTesting(async ({ handleInitProgress }) => {
      engineFactoryCount++;
      handleInitProgress({ progress: 0.5, timeElapsed: 0.2, text: 'Loading model from cache[1/2]' });
      handleInitProgress({ progress: 1, timeElapsed: 0.4, text: 'Finish loading on WebGPU' });
      return {
        unload: async () => {},
        interruptGenerate: () => {}
      };
    });

    const retryResult = await ensureWebLLMEngine({ modelId: SMOLLM2_135M_WEBLLM_MODEL_ID });
    assert.strictEqual(retryResult.modelId, SMOLLM2_135M_WEBLLM_MODEL_ID);
    assert.strictEqual(shard0FullDownloadsOnRetry, 0, 'Retry must reuse already-cached shard_0 without re-downloading');
    assert.strictEqual(shard1FullDownloadsOnRetry, 1, 'Retry must download missing shard_1 exactly once');
    assert.strictEqual(workerSpawnCount, 1, 'Retry must spawn exactly 1 worker');
    assert.strictEqual(engineFactoryCount, 1, 'Retry must create exactly 1 engine');
    assert.strictEqual(getWebLLMState().status, 'ready');
    assert.strictEqual(getWebLLMState().progressPercent, 100);
    assert.strictEqual(await isWebLLMModelCached(SMOLLM2_135M_WEBLLM_MODEL_ID), true);
  } finally {
    unsubscribe();
    resetWebLLMRuntimeForTesting();
  }
});

// 7. Concurrent ensureWebLLMEngine calls deduplicate to a single initialization
await runCase('Concurrent ensureWebLLMEngine calls for SmolLM2 135M run only a single initialization', async () => {
  resetWebLLMRuntimeForTesting();
  const cacheStorage = createInMemoryCacheStorage();
  installMockBrowserGlobals({ cacheStorage, isOnline: true, hasShaderF16: true });

  let workerCount = 0;
  let engineCount = 0;
  setWebLLMWorkerFactoryForTesting(() => {
    workerCount++;
    return { terminate: () => {}, onerror: null, onmessageerror: null };
  });
  setWebLLMEngineFactoryForTesting(async ({ handleInitProgress }) => {
    engineCount++;
    await new Promise((r) => setTimeout(r, 40));
    handleInitProgress({ progress: 1, timeElapsed: 0.1, text: 'Finish loading on WebGPU' });
    return { unload: async () => {}, interruptGenerate: () => {} };
  });

  try {
    const [resA, resB, resC] = await Promise.all([
      ensureWebLLMEngine({ modelId: SMOLLM2_135M_WEBLLM_MODEL_ID }),
      ensureWebLLMEngine({ modelId: SMOLLM2_135M_WEBLLM_MODEL_ID }),
      ensureWebLLMEngine({ modelId: SMOLLM2_135M_WEBLLM_MODEL_ID })
    ]);
    assert.strictEqual(resA.engine, resB.engine);
    assert.strictEqual(resB.engine, resC.engine);
    assert.strictEqual(workerCount, 1, 'Must spawn only 1 worker for concurrent calls');
    assert.strictEqual(engineCount, 1, 'Must initialize only 1 engine for concurrent calls');
  } finally {
    resetWebLLMRuntimeForTesting();
  }
});

// 8. Worker GPU initialization stall watchdog aborts hung CreateWebWorkerMLCEngine cleanly
await runCase('Worker GPU initialization watchdog aborts hung engine reload instead of stalling forever', async () => {
  resetWebLLMRuntimeForTesting();
  const cacheStorage = createInMemoryCacheStorage();
  installMockBrowserGlobals({ cacheStorage, isOnline: true, hasShaderF16: true });

  setWebLLMDownloadConfigForTesting({
    workerStallTimeoutMs: 120
  });

  let workerTerminated = false;
  setWebLLMWorkerFactoryForTesting(() => ({
    terminate: () => {
      workerTerminated = true;
    },
    onerror: null,
    onmessageerror: null
  }));
  setWebLLMEngineFactoryForTesting(
    () =>
      new Promise(() => {
        // Simulate worker hanging indefinitely with zero progress callbacks
      })
  );

  try {
    await assert.rejects(
      () => ensureWebLLMEngine({ modelId: SMOLLM2_135M_WEBLLM_MODEL_ID }),
      (err) => {
        assert.strictEqual(err.timeout, true);
        assert.strictEqual(err.retryable, true);
        return true;
      }
    );
    assert.strictEqual(workerTerminated, true, 'Hung worker must be terminated immediately');
    assert.strictEqual(getWebLLMState().status, 'error');
  } finally {
    resetWebLLMRuntimeForTesting();
  }
});

// 9. Non-blocking reader.cancel() when proxy ignores Range and returns HTTP 200 stream whose cancel() hangs
await runCase('CDN probe does not hang at 0% if HTTP 200 stream reader.cancel() never resolves and strips signed URLs', async () => {
  const firstChunk = new Uint8Array(1024).fill(3);
  const signedRedirectUrl =
    'https://us.aws.cdn.hf.co/xet-bridge-us/67ab12cd/aa11bb22cc33dd44ee55ff6677889900aa11bb22cc33dd44?X-Amz-Signature=supersecret123&token=privatetoken456';

  const mockRangeIgnoredFetch = async () => {
    let delivered = false;
    const stream = new ReadableStream({
      pull(controller) {
        if (!delivered) {
          delivered = true;
          controller.enqueue(firstChunk);
          return Promise.resolve();
        }
        return new Promise(() => {
          // Remaining 56 MB hangs forever
        });
      },
      cancel() {
        // Simulate middlebox/browser bug where reader.cancel() never resolves
        return new Promise(() => {});
      }
    });
    const res = new Response(stream, { status: 200 });
    Object.defineProperty(res, 'url', { value: signedRedirectUrl, configurable: true });
    return res;
  };

  const t0 = Date.now();
  const probe = await probeWebLLMModelCDN(
    'https://huggingface.co/mlc-ai/SmolLM2-135M-Instruct-q0f16-MLC/resolve/main/params_shard_0.bin',
    {
      modelLabel: 'SmolLM2 135M',
      timeoutMs: 1000,
      fetchImpl: mockRangeIgnoredFetch
    }
  );
  const elapsed = Date.now() - t0;

  assert.strictEqual(probe.ok, true);
  assert.strictEqual(probe.transferredBytes, 1024);
  assert.strictEqual(probe.redirectedHost, 'us.aws.cdn.hf.co');
  assert.strictEqual('redirectedUrl' in probe, false, 'probeResult must not retain signed redirectedUrl');
  assert.ok(elapsed < 400, `Probe must resolve immediately without awaiting hung cancel() (took ${elapsed}ms)`);
});

// 10. Hard Promise.race deadline catches fetch/reader hangs that completely ignore AbortSignal
await runCase('Hard stage deadline surfaces error in UI even when hung fetch/stream ignores AbortSignal', async () => {
  resetWebLLMRuntimeForTesting();
  const cacheStorage = createInMemoryCacheStorage();
  installMockBrowserGlobals({ cacheStorage, isOnline: true, hasShaderF16: true });

  setWebLLMDownloadConfigForTesting({
    probeTimeoutMs: 110,
    stallTimeoutMs: 110,
    concurrency: 1,
    workerStallTimeoutMs: 500
  });

  // Fetch for metadata succeeds, but shard fetch ignores init.signal completely and never settles!
  setWebLLMFetchForTesting(async (url) => {
    const href = String(url);
    if (href.endsWith('mlc-chat-config.json')) {
      return new Response(JSON.stringify({ tokenizer_files: ['tokenizer.json'], context_window_size: 4096 }), {
        status: 200
      });
    }
    if (href.endsWith('tensor-cache.json')) {
      return new Response(
        JSON.stringify({
          records: [{ name: 'w0', dataPath: 'params_shard_0.bin', nbytes: 2048 }]
        }),
        { status: 200 }
      );
    }
    // Hang forever AND ignore AbortSignal!
    return new Promise(() => {});
  });

  setWebLLMWorkerFactoryForTesting(() => ({ terminate: () => {}, onerror: null, onmessageerror: null }));
  setWebLLMEngineFactoryForTesting(async () => ({ unload: async () => {}, interruptGenerate: () => {} }));

  try {
    await assert.rejects(
      () => ensureWebLLMEngine({ modelId: SMOLLM2_135M_WEBLLM_MODEL_ID }),
      (err) => {
        assert.strictEqual(err.timeout, true, 'Must reject with timeout=true via hard deadline');
        assert.strictEqual(err.retryable, true);
        return true;
      }
    );

    const stateAfterTimeout = getWebLLMState();
    assert.strictEqual(
      stateAfterTimeout.status,
      'error',
      'UI state must transition to error instead of remaining stuck at 0% forever'
    );
    assert.ok(stateAfterTimeout.error && stateAfterTimeout.error.length > 0);
  } finally {
    resetWebLLMRuntimeForTesting();
  }
});

// 11. Diagnostic URL sanitization never logs signed CDN tokens, query params, or credentials
await runCase('Diagnostic logs include stage + elapsed time and strip signed CDN query strings/tokens', async () => {
  resetWebLLMRuntimeForTesting();
  const rawSignedUrl =
    'https://user:pass@us.aws.cdn.hf.co/xet-bridge-us/62f4b8/9f8e7d6c5b4a392817263544556677889900aabbccddeeff?X-Amz-Signature=SECRET_SIG_999&Key-Pair-Id=APKAIEXAMPLE';

  const sanitized = sanitizeUrlForDiagnostics(rawSignedUrl);
  assert.strictEqual(sanitized, 'us.aws.cdn.hf.co');
  assert.ok(!sanitized.includes('SECRET_SIG_999'));
  assert.ok(!sanitized.includes('user:pass'));

  logWebLLMStage('test_sanitization', { url: rawSignedUrl }, { startMs: Date.now() - 25 });
  const events = getWebLLMDiagnostics();
  assert.strictEqual(events.length, 1);
  assert.ok(events[0].line.includes('[stage=test_sanitization]'));
  assert.ok(events[0].line.includes('(+'));
  assert.ok(!JSON.stringify(events[0]).includes('SECRET_SIG_999'), 'Diagnostics buffer must never retain secrets');
  resetWebLLMRuntimeForTesting();
});

// 12. Verify @mlc-ai/web-llm@0.2.86 recognizes custom downloader Cache Storage keys directly (cacheOnly=true)
await runCase('Installed @mlc-ai/web-llm@0.2.86 hasModelInCache recognizes custom downloader artifacts & avoids post-download 0% reset', async () => {
  resetWebLLMRuntimeForTesting();
  const cacheStorage = createInMemoryCacheStorage();
  installMockBrowserGlobals({ cacheStorage, isOnline: true, hasShaderF16: true });

  const modelRecord = webllmPkg.prebuiltAppConfig.model_list.find(
    (m) => m.model_id === SMOLLM2_135M_WEBLLM_MODEL_ID
  );
  assert.ok(modelRecord);

  const shardBytes = new Uint8Array(1024).fill(5);
  const customFetch = async (url, init = {}) => {
    const href = String(url);
    const isRange = Boolean(init?.headers?.Range || init?.headers?.range);
    if (href.endsWith('mlc-chat-config.json')) {
      return new Response(JSON.stringify({ tokenizer_files: ['tokenizer.json'], context_window_size: 4096 }), {
        status: 200
      });
    }
    if (href.endsWith('tensor-cache.json')) {
      return new Response(
        JSON.stringify({
          records: [
            { name: 'p0', dataPath: 'params_shard_0.bin', nbytes: shardBytes.byteLength },
            { name: 'p1', dataPath: 'params_shard_1.bin', nbytes: shardBytes.byteLength }
          ]
        }),
        { status: 200 }
      );
    }
    if (href.endsWith('tokenizer.json')) {
      return new Response(JSON.stringify({ version: '1.0' }), { status: 200 });
    }
    if (href.endsWith('.wasm')) {
      return new Response(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]), { status: 200 });
    }
    if (href.includes('params_shard_')) {
      return createChunkedResponse([shardBytes], {
        status: isRange ? 206 : 200,
        url: 'https://us.aws.cdn.hf.co/xet-bridge-us/shard.bin',
        headers: { 'Content-Length': String(shardBytes.byteLength) }
      });
    }
    throw new Error(`Unexpected URL: ${href}`);
  };

  await downloadModelArtifactsToCache(modelRecord, {
    modelId: SMOLLM2_135M_WEBLLM_MODEL_ID,
    catalogEntry: WEBLLM_MODEL_CATALOG[SMOLLM2_135M_WEBLLM_MODEL_ID],
    fetchImpl: customFetch
  });

  // Verify WebLLM 0.2.86's own hasModelInCache() inspects webllm/config, webllm/wasm, and webllm/model
  const webllmSeesCache = await webllmPkg.hasModelInCache(
    SMOLLM2_135M_WEBLLM_MODEL_ID,
    webllmPkg.prebuiltAppConfig
  );
  assert.strictEqual(
    webllmSeesCache,
    true,
    'WebLLM 0.2.86 hasModelInCache must return true for custom-downloaded Cache Storage entries'
  );

  // Also verify that during GPU loading after cache verification, WebLLM's initial progress=0 report
  // uses indeterminate progressPercent (null) instead of flashing 0% in the UI
  resetWebLLMRuntimeForTesting();
  installMockBrowserGlobals({ cacheStorage, isOnline: true, hasShaderF16: true });

  const loadingStates = [];
  const unsub = subscribeWebLLMState((s) => {
    if (s.status === 'loading') loadingStates.push({ ...s });
  });

  setWebLLMWorkerFactoryForTesting(() => ({
    terminate: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    onerror: null,
    onmessageerror: null
  }));
  setWebLLMEngineFactoryForTesting(async ({ handleInitProgress }) => {
    handleInitProgress({ progress: 0, timeElapsed: 0, text: 'Start to fetch params' });
    handleInitProgress({ progress: 0.5, timeElapsed: 0.2, text: 'Loading model from cache[1/2]' });
    handleInitProgress({ progress: 1, timeElapsed: 0.4, text: 'Finish loading on WebGPU' });
    return { unload: async () => {}, interruptGenerate: () => {} };
  });

  try {
    await ensureWebLLMEngine({ modelId: SMOLLM2_135M_WEBLLM_MODEL_ID });
    assert.ok(
      loadingStates.every((st) => st.progressPercent !== 0),
      `Cached/post-download GPU loading must use indeterminate bar (null) instead of flashing 0% (saw: ${JSON.stringify(
        loadingStates.map((s) => s.progressPercent)
      )})`
    );
  } finally {
    unsub();
    resetWebLLMRuntimeForTesting();
  }
});

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.exit(1);
}
