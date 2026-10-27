/**
 * Orvix Browser-Based Local AI Engine Service (WebLLM)
 * Runs Qwen 2.5 Instruct models directly on the visitor's GPU via WebGPU inside a dedicated Web Worker.
 *
 * Key architectural guarantees (verified against @mlc-ai/web-llm@0.2.86):
 * 1. Strictly local browser inference — never routes requests to /api/chat, Ollama, Firebase, or cloud APIs.
 * 2. Strictly lazy runtime loading — @mlc-ai/web-llm and the dedicated worker are dynamically loaded ONLY
 *    when Browser AI cache inspection or initialization is explicitly invoked.
 * 3. Non-blocking UI — tokenization, WASM execution, model weight loading, and WebGPU prefill/decode
 *    run inside src/workers/webllmWorker.js via CreateWebWorkerMLCEngine.
 * 4. Verified cache & offline protection — uses WebLLM's hasModelInCache() plus config/WASM cache checks
 *    to fail fast with a clear, actionable message if an uncached model is requested while offline.
 */

import { getChatMode } from '../config/chatModes.js';
import {
  prepareDocumentContext,
  adaptDocumentContextForProvider,
  formatOpenAIMessages
} from './documentContextService.js';

function isClientOnline() {
  if (typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean') {
    return navigator.onLine;
  }
  return true;
}

export const WEBLLM_PROVIDER_ID = 'webllm';

export const DEFAULT_WEBLLM_MODEL_ID = 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC';
export const FALLBACK_F32_WEBLLM_MODEL_ID = 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC';
export const LIGHTWEIGHT_WEBLLM_MODEL_ID = 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC';
export const LIGHTWEIGHT_F32_WEBLLM_MODEL_ID = 'Qwen2.5-0.5B-Instruct-q4f32_1-MLC';

/**
 * Verified Qwen 2.5 Instruct models present in @mlc-ai/web-llm@0.2.86 prebuiltAppConfig.model_list.
 * Structured extensibly so Phase 2B+ can expose a lightweight 0.5B fallback option without modifying the engine.
 */
export const WEBLLM_MODEL_CATALOG = Object.freeze({
  [DEFAULT_WEBLLM_MODEL_ID]: Object.freeze({
    id: DEFAULT_WEBLLM_MODEL_ID,
    label: 'Qwen 2.5 1.5B Instruct',
    shortLabel: 'Qwen 2.5 1.5B',
    tier: 'standard',
    quantization: 'q4f16_1',
    prefersShaderF16: true,
    f32FallbackModelId: FALLBACK_F32_WEBLLM_MODEL_ID,
    vramRequiredMB: 1629.75,
    estimatedDownloadMB: 960,
    minStorageBytes: 1_150 * 1024 * 1024, // ~1.15 GB safety buffer for shards + WASM + tokenizer
    contextWindowSize: 4096,
    maxDocChars: 10_000,
    maxHistoryMessages: 8,
    defaultMaxTokens: 1024,
    isDefault: true
  }),
  [FALLBACK_F32_WEBLLM_MODEL_ID]: Object.freeze({
    id: FALLBACK_F32_WEBLLM_MODEL_ID,
    label: 'Qwen 2.5 1.5B Instruct (FP32 Compat)',
    shortLabel: 'Qwen 2.5 1.5B (FP32)',
    tier: 'standard-f32',
    quantization: 'q4f32_1',
    prefersShaderF16: false,
    f32FallbackModelId: null,
    vramRequiredMB: 1888.97,
    estimatedDownloadMB: 1120,
    minStorageBytes: 1_300 * 1024 * 1024,
    contextWindowSize: 4096,
    maxDocChars: 10_000,
    maxHistoryMessages: 8,
    defaultMaxTokens: 1024,
    isDefault: false
  }),
  [LIGHTWEIGHT_WEBLLM_MODEL_ID]: Object.freeze({
    id: LIGHTWEIGHT_WEBLLM_MODEL_ID,
    label: 'Qwen 2.5 0.5B Instruct (Lightweight)',
    shortLabel: 'Qwen 2.5 0.5B',
    tier: 'lightweight',
    quantization: 'q4f16_1',
    prefersShaderF16: true,
    f32FallbackModelId: LIGHTWEIGHT_F32_WEBLLM_MODEL_ID,
    vramRequiredMB: 944.62,
    estimatedDownloadMB: 420,
    minStorageBytes: 550 * 1024 * 1024,
    contextWindowSize: 4096,
    maxDocChars: 8_000,
    maxHistoryMessages: 6,
    defaultMaxTokens: 896,
    isDefault: false
  }),
  [LIGHTWEIGHT_F32_WEBLLM_MODEL_ID]: Object.freeze({
    id: LIGHTWEIGHT_F32_WEBLLM_MODEL_ID,
    label: 'Qwen 2.5 0.5B Instruct (Lightweight FP32)',
    shortLabel: 'Qwen 2.5 0.5B (FP32)',
    tier: 'lightweight-f32',
    quantization: 'q4f32_1',
    prefersShaderF16: false,
    f32FallbackModelId: null,
    vramRequiredMB: 1060.2,
    estimatedDownloadMB: 490,
    minStorageBytes: 650 * 1024 * 1024,
    contextWindowSize: 4096,
    maxDocChars: 8_000,
    maxHistoryMessages: 6,
    defaultMaxTokens: 896,
    isDefault: false
  })
});

export const WEBLLM_ERROR_CODES = Object.freeze({
  INSECURE_CONTEXT: 'WEBLLM_INSECURE_CONTEXT',
  WEBGPU_UNSUPPORTED: 'WEBGPU_UNSUPPORTED',
  WEBGPU_ADAPTER_UNAVAILABLE: 'WEBGPU_ADAPTER_UNAVAILABLE',
  SHADER_F16_UNSUPPORTED: 'WEBLLM_SHADER_F16_UNSUPPORTED',
  UNSUPPORTED_MODEL: 'WEBLLM_UNSUPPORTED_MODEL',
  OFFLINE_UNCACHED: 'WEBLLM_OFFLINE_UNCACHED',
  INSUFFICIENT_STORAGE: 'WEBLLM_INSUFFICIENT_STORAGE',
  STORAGE_UNAVAILABLE: 'WEBLLM_STORAGE_UNAVAILABLE',
  DOWNLOAD_FAILED: 'WEBLLM_DOWNLOAD_FAILED',
  DEVICE_LOST: 'WEBLLM_DEVICE_LOST',
  WORKER_CRASHED: 'WEBLLM_WORKER_CRASHED',
  INIT_FAILED: 'WEBLLM_INIT_FAILED',
  GENERATION_FAILED: 'WEBLLM_GENERATION_FAILED'
});

/**
 * Structured error class for Browser AI operations with non-fallback local flags.
 */
export class WebLLMError extends Error {
  /**
   * @param {string} message
   * @param {Object} [options]
   * @param {string} [options.code]
   * @param {number} [options.httpCode]
   * @param {boolean} [options.retryable]
   * @param {unknown} [options.cause]
   */
  constructor(message, options = {}) {
    super(message);
    this.name = 'WebLLMError';
    this.status = options.code || WEBLLM_ERROR_CODES.GENERATION_FAILED;
    this.errorCode = this.status;
    this.code = options.httpCode || 503;
    this.provider = WEBLLM_PROVIDER_ID;
    this.retryable = Boolean(options.retryable);
    this.canFallback = false;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

// ============================================================================
// Lazy Module & Singleton Engine State
// ============================================================================

let webllmModulePromise = null;
let engineInstance = null;
let workerInstance = null;
let loadedModelId = null;
let activeInitPromise = null;
let activeInitModelId = null;
let activeInitAbortReject = null;
let generationQueuePromise = Promise.resolve();
let isGeneratingNow = false;
let manualStopRequested = false;

const stateListeners = new Set();

let engineState = {
  status: 'idle', // 'idle' | 'checking' | 'downloading' | 'loading' | 'ready' | 'generating' | 'error'
  modelId: DEFAULT_WEBLLM_MODEL_ID,
  progress: 0,
  progressPercent: null,
  progressText: '',
  timeElapsed: 0,
  isCached: false,
  hasShaderF16: null,
  error: null
};

function updateEngineState(patch) {
  engineState = {
    ...engineState,
    ...patch
  };
  const snapshot = getWebLLMState();
  for (const listener of stateListeners) {
    try {
      listener(snapshot);
    } catch (err) {
      console.warn('[Orvix WebLLM] State listener error:', err);
    }
  }
  return snapshot;
}

/**
 * Returns a shallow snapshot of the current Browser AI engine state.
 */
export function getWebLLMState() {
  return { ...engineState };
}

/**
 * Subscribes to Browser AI engine status and initialization/download progress updates.
 * @param {(state: typeof engineState) => void} listener
 * @returns {() => void} Unsubscribe callback
 */
export function subscribeWebLLMState(listener) {
  if (typeof listener !== 'function') {
    return () => {};
  }
  stateListeners.add(listener);
  try {
    listener(getWebLLMState());
  } catch (_) {
    // Ignore listener initial invoke error
  }
  return () => {
    stateListeners.delete(listener);
  };
}

/**
 * Returns the catalog of verified Browser AI models.
 * @param {{ includeF32Variants?: boolean }} [options]
 */
export function getSupportedWebLLMModels(options = {}) {
  const { includeF32Variants = false } = options;
  const all = Object.values(WEBLLM_MODEL_CATALOG);
  if (includeF32Variants) {
    return all;
  }
  return all.filter((entry) => !entry.tier.endsWith('-f32'));
}

/**
 * Lazily imports @mlc-ai/web-llm only when Browser AI is actually invoked.
 * Resets the cached import promise if chunk fetching fails (e.g. temporary offline state)
 * so subsequent attempts can recover cleanly.
 */
async function loadWebLLMModule() {
  if (!webllmModulePromise) {
    webllmModulePromise = import('@mlc-ai/web-llm').catch((err) => {
      webllmModulePromise = null;
      const offline = !isClientOnline();
      throw new WebLLMError(
        offline
          ? 'Browser AI runtime files are not cached on this device yet. Connect to the internet once to load Browser AI.'
          : 'Failed to load the Browser AI runtime module. Please refresh the page and check your connection.',
        {
          code: offline ? WEBLLM_ERROR_CODES.OFFLINE_UNCACHED : WEBLLM_ERROR_CODES.DOWNLOAD_FAILED,
          httpCode: 503,
          retryable: true,
          cause: err
        }
      );
    });
  }
  return webllmModulePromise;
}

/**
 * Normalizes a Hugging Face model base URL the exact same way @mlc-ai/web-llm's cleanModelUrl() does.
 * @param {string} rawModelUrl
 * @returns {string}
 */
function normalizeModelBaseUrl(rawModelUrl) {
  let url = String(rawModelUrl || '');
  if (!url.endsWith('/')) {
    url += '/';
  }
  if (!/.+\/resolve\/.+\//.test(url)) {
    url += 'resolve/main/';
  }
  return new URL(url).href;
}

/**
 * Looks up a ModelRecord in WebLLM's prebuiltAppConfig.model_list.
 */
function findPrebuiltModelRecord(webllm, modelId) {
  const list = webllm?.prebuiltAppConfig?.model_list;
  if (!Array.isArray(list)) return null;
  return list.find((item) => item?.model_id === modelId) || null;
}

function createAbortError(message = 'Generation stopped by user') {
  if (typeof DOMException !== 'undefined') {
    return new DOMException(message, 'AbortError');
  }
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

function isAbortError(err) {
  if (!err) return false;
  if (err.name === 'AbortError') return true;
  const msg = String(err.message || err).toLowerCase();
  return msg.includes('aborterror') || msg.includes('aborted');
}

// ============================================================================
// WebGPU Compatibility & Storage Checks
// ============================================================================

/**
 * Checks whether the current browser, context, and GPU hardware support WebGPU for WebLLM.
 * Does not load @mlc-ai/web-llm or download any model files.
 *
 * @returns {Promise<{
 *   supported: boolean,
 *   reasonCode: string | null,
 *   message: string | null,
 *   hasShaderF16: boolean,
 *   maxStorageBufferBindingSize: number | null,
 *   maxBufferSize: number | null,
 *   adapterInfo: { vendor?: string, architecture?: string, description?: string } | null
 * }>}
 */
export async function checkWebGPUSupport() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return {
      supported: false,
      reasonCode: WEBLLM_ERROR_CODES.WEBGPU_UNSUPPORTED,
      message: 'Browser AI requires a web browser environment with WebGPU support.',
      hasShaderF16: false,
      maxStorageBufferBindingSize: null,
      maxBufferSize: null,
      adapterInfo: null
    };
  }

  if (window.isSecureContext === false) {
    return {
      supported: false,
      reasonCode: WEBLLM_ERROR_CODES.INSECURE_CONTEXT,
      message:
        'Browser AI requires a secure context (HTTPS or localhost) to access WebGPU and browser model caching.',
      hasShaderF16: false,
      maxStorageBufferBindingSize: null,
      maxBufferSize: null,
      adapterInfo: null
    };
  }

  if (!('gpu' in navigator) || !navigator.gpu || typeof navigator.gpu.requestAdapter !== 'function') {
    return {
      supported: false,
      reasonCode: WEBLLM_ERROR_CODES.WEBGPU_UNSUPPORTED,
      message:
        'WebGPU is not available in this browser. Please use a recent version of Chrome (113+), Edge (113+), or Safari (18+) on a compatible device.',
      hasShaderF16: false,
      maxStorageBufferBindingSize: null,
      maxBufferSize: null,
      adapterInfo: null
    };
  }

  try {
    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: 'high-performance'
    });

    if (!adapter) {
      return {
        supported: false,
        reasonCode: WEBLLM_ERROR_CODES.WEBGPU_ADAPTER_UNAVAILABLE,
        message:
          'No compatible WebGPU graphics adapter was found. Please ensure hardware acceleration is enabled in your browser settings and your GPU drivers are up to date.',
        hasShaderF16: false,
        maxStorageBufferBindingSize: null,
        maxBufferSize: null,
        adapterInfo: null
      };
    }

    const hasShaderF16 = Boolean(adapter.features && adapter.features.has('shader-f16'));
    const maxStorageBufferBindingSize =
      typeof adapter.limits?.maxStorageBufferBindingSize === 'number'
        ? adapter.limits.maxStorageBufferBindingSize
        : null;
    const maxBufferSize =
      typeof adapter.limits?.maxBufferSize === 'number' ? adapter.limits.maxBufferSize : null;

    let adapterInfo = null;
    if (adapter.info) {
      adapterInfo = {
        vendor: adapter.info.vendor || '',
        architecture: adapter.info.architecture || '',
        description: adapter.info.description || ''
      };
    }

    return {
      supported: true,
      reasonCode: null,
      message: null,
      hasShaderF16,
      maxStorageBufferBindingSize,
      maxBufferSize,
      adapterInfo
    };
  } catch (err) {
    return {
      supported: false,
      reasonCode: WEBLLM_ERROR_CODES.WEBGPU_ADAPTER_UNAVAILABLE,
      message:
        'Failed to access the WebGPU graphics adapter. Please check that hardware acceleration is enabled in your browser.',
      hasShaderF16: false,
      maxStorageBufferBindingSize: null,
      maxBufferSize: null,
      adapterInfo: null
    };
  }
}

/**
 * Resolves the optimal verified model ID for the visitor's WebGPU capabilities.
 * Defaults to Qwen2.5-1.5B-Instruct-q4f16_1-MLC and automatically falls back to
 * Qwen2.5-1.5B-Instruct-q4f32_1-MLC when the GPU adapter lacks `shader-f16`.
 *
 * @param {string|null|undefined} requestedModelId
 * @param {{ hasShaderF16?: boolean, allowF32Fallback?: boolean }} [options]
 * @returns {string}
 */
export function resolveWebLLMModelId(requestedModelId, options = {}) {
  const baseId =
    requestedModelId && typeof requestedModelId === 'string' && requestedModelId.trim()
      ? requestedModelId.trim()
      : DEFAULT_WEBLLM_MODEL_ID;

  const { hasShaderF16 = true, allowF32Fallback = true } = options;
  const catalogEntry = WEBLLM_MODEL_CATALOG[baseId];

  if (catalogEntry && catalogEntry.prefersShaderF16 && !hasShaderF16 && allowF32Fallback && catalogEntry.f32FallbackModelId) {
    return catalogEntry.f32FallbackModelId;
  }

  return baseId;
}

/**
 * Checks browser Cache API availability and remaining storage quota before downloading model weights.
 * @param {string} modelId
 */
async function verifyBrowserStorageForDownload(modelId) {
  if (typeof caches === 'undefined') {
    throw new WebLLMError(
      'Browser Cache Storage is unavailable in this browsing context (often disabled in restricted or private windows). Please open Orvix in a standard HTTPS browser window to download Browser AI.',
      {
        code: WEBLLM_ERROR_CODES.STORAGE_UNAVAILABLE,
        httpCode: 507,
        retryable: false
      }
    );
  }

  const catalogEntry = WEBLLM_MODEL_CATALOG[modelId];
  const minBytes = catalogEntry?.minStorageBytes || 1_000 * 1024 * 1024;

  if (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.estimate === 'function') {
    try {
      const estimate = await navigator.storage.estimate();
      if (
        estimate &&
        typeof estimate.quota === 'number' &&
        estimate.quota > 0 &&
        typeof estimate.usage === 'number'
      ) {
        const availableBytes = Math.max(0, estimate.quota - estimate.usage);
        if (availableBytes < minBytes) {
          const availableMB = Math.round(availableBytes / (1024 * 1024));
          const requiredMB = Math.round(minBytes / (1024 * 1024));
          throw new WebLLMError(
            `Not enough browser storage is available to cache ${catalogEntry?.label || modelId} (~${requiredMB} MB needed, ~${availableMB} MB free). Please free up disk/browser space or exit Private/Incognito mode and try again.`,
            {
              code: WEBLLM_ERROR_CODES.INSUFFICIENT_STORAGE,
              httpCode: 507,
              retryable: false
            }
          );
        }
      }
    } catch (err) {
      if (err instanceof WebLLMError) {
        throw err;
      }
      // Non-fatal if storage.estimate() itself fails on a particular browser
    }
  }

  // Request persistent storage best-effort so browser is less likely to evict ~1 GB cached weights
  if (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.persist === 'function') {
    try {
      void navigator.storage.persist();
    } catch (_) {
      // Ignore permission rejection
    }
  }
}

// ============================================================================
// Verified Model Cache Inspection & Cleanup
// ============================================================================

/**
 * Checks whether the specified WebLLM model is completely cached on this device.
 * Uses @mlc-ai/web-llm's verified `hasModelInCache(modelId, prebuiltAppConfig)` API
 * (which validates tensor-cache.json and every weight shard) AND verifies that the
 * companion chat config (`webllm/config`) and WASM library (`webllm/wasm`) entries
 * are also present in Cache Storage so offline reloads succeed reliably.
 *
 * @param {string} [modelId=DEFAULT_WEBLLM_MODEL_ID]
 * @returns {Promise<boolean>}
 */
export async function isWebLLMModelCached(modelId = DEFAULT_WEBLLM_MODEL_ID) {
  if (typeof window === 'undefined' || typeof caches === 'undefined') {
    return false;
  }

  try {
    const webllm = await loadWebLLMModule();
    const targetId = (modelId && String(modelId).trim()) || DEFAULT_WEBLLM_MODEL_ID;
    const record = findPrebuiltModelRecord(webllm, targetId);
    if (!record) {
      return false;
    }

    const tensorsCached = await webllm.hasModelInCache(targetId, webllm.prebuiltAppConfig);
    if (!tensorsCached) {
      return false;
    }

    // Also verify config & WASM caches used by MLCEngine.reloadInternal() during offline startup
    const modelBaseUrl = normalizeModelBaseUrl(record.model);
    const chatConfigUrl = new URL('mlc-chat-config.json', modelBaseUrl).href;

    const configCache = await caches.open('webllm/config');
    const cachedConfig = await configCache.match(new Request(chatConfigUrl));
    if (!cachedConfig) {
      return false;
    }

    if (record.model_lib && record.model_lib.startsWith('http') && !record.model_lib.includes('localhost')) {
      const wasmCache = await caches.open('webllm/wasm');
      const cachedWasm = await wasmCache.match(new Request(record.model_lib));
      if (!cachedWasm) {
        return false;
      }
    }

    return true;
  } catch (err) {
    console.warn('[Orvix WebLLM] Cache inspection failed:', err?.message || err);
    return false;
  }
}

/**
 * Checks cache status and resolves the best cached or hardware-compatible model ID.
 * Useful when offline: if the user's GPU lacks shader-f16 and the FP32 fallback was previously
 * cached, this finds the exact cached variant automatically.
 *
 * @param {string} [preferredModelId=DEFAULT_WEBLLM_MODEL_ID]
 * @returns {Promise<{ modelId: string, isCached: boolean, gpuSupport: Awaited<ReturnType<typeof checkWebGPUSupport>> }>}
 */
export async function inspectWebLLMReadiness(preferredModelId = DEFAULT_WEBLLM_MODEL_ID) {
  const gpuSupport = await checkWebGPUSupport();
  const resolvedId = resolveWebLLMModelId(preferredModelId, {
    hasShaderF16: gpuSupport.hasShaderF16,
    allowF32Fallback: true
  });

  if (!gpuSupport.supported) {
    updateEngineState({
      isCached: false,
      modelId: resolvedId,
      hasShaderF16: false
    });
    return {
      modelId: resolvedId,
      isCached: false,
      gpuSupport
    };
  }

  const isCached = await isWebLLMModelCached(resolvedId);
  updateEngineState({
    isCached,
    modelId: resolvedId,
    hasShaderF16: gpuSupport.hasShaderF16
  });

  return {
    modelId: resolvedId,
    isCached,
    gpuSupport
  };
}

/**
 * Deletes cached weights, WASM library, and chat config for a WebLLM model using WebLLM's verified API.
 * If that model is currently loaded in memory, unloads the active engine first.
 *
 * @param {string} [modelId]
 */
export async function clearWebLLMModelCache(modelId = loadedModelId || DEFAULT_WEBLLM_MODEL_ID) {
  if (loadedModelId === modelId) {
    await destroyWebLLMEngine();
  }
  const webllm = await loadWebLLMModule();
  await webllm.deleteModelAllInfoInCache(modelId, webllm.prebuiltAppConfig);
  if (engineState.modelId === modelId) {
    updateEngineState({ isCached: false });
  }
}

// ============================================================================
// Error Classification & Recovery Helpers
// ============================================================================

function isFatalEngineError(rawErr) {
  const text = `${rawErr?.name || ''} ${rawErr?.message || rawErr || ''}`.toLowerCase();
  return (
    text.includes('devicelosterror') ||
    text.includes('device was lost') ||
    text.includes('device lost') ||
    text.includes('out of memory') ||
    text.includes('oom') ||
    text.includes('instance reference no longer exists') ||
    text.includes('disposed') ||
    text.includes('unreachable') ||
    text.includes('memory access out of bounds') ||
    text.includes('worker crashed') ||
    text.includes('chunk generator in worker')
  );
}

function normalizeWebLLMError(rawErr, { modelId = DEFAULT_WEBLLM_MODEL_ID, phase = 'generate', wasCached = false } = {}) {
  if (rawErr instanceof WebLLMError) {
    return rawErr;
  }

  if (isAbortError(rawErr)) {
    return rawErr;
  }

  const rawText = String(rawErr?.message || rawErr || '').trim();
  const lower = rawText.toLowerCase();
  const label = WEBLLM_MODEL_CATALOG[modelId]?.label || modelId;

  if (lower.includes('shaderf16supporterror') || lower.includes('shader-f16')) {
    return new WebLLMError(
      `Your GPU browser driver does not support the WebGPU 16-bit shader extension (shader-f16) required by ${label}.`,
      {
        code: WEBLLM_ERROR_CODES.SHADER_F16_UNSUPPORTED,
        httpCode: 400,
        retryable: false,
        cause: rawErr
      }
    );
  }

  if (lower.includes('webgpunotavailableerror') || lower.includes('cannot find webgpu') || lower.includes('webgpu is not available')) {
    return new WebLLMError(
      'WebGPU is not available on this browser or device. Please use Chrome 113+, Edge 113+, or Safari 18+ with hardware acceleration enabled.',
      {
        code: WEBLLM_ERROR_CODES.WEBGPU_UNSUPPORTED,
        httpCode: 400,
        retryable: false,
        cause: rawErr
      }
    );
  }

  if (
    lower.includes('devicelosterror') ||
    lower.includes('device was lost') ||
    lower.includes('out of memory') ||
    lower.includes('allocation failed') ||
    lower.includes('oom')
  ) {
    return new WebLLMError(
      `Your device ran out of GPU memory while running ${label}. Try closing other GPU-heavy browser tabs or applications and retry.`,
      {
        code: WEBLLM_ERROR_CODES.DEVICE_LOST,
        httpCode: 507,
        retryable: true,
        cause: rawErr
      }
    );
  }

  if (lower.includes('quotaexceedederror') || lower.includes('quota') || lower.includes('storage')) {
    return new WebLLMError(
      `Browser storage quota was exceeded while caching ${label}. Please free up disk/browser space or exit Private/Incognito mode and try again.`,
      {
        code: WEBLLM_ERROR_CODES.INSUFFICIENT_STORAGE,
        httpCode: 507,
        retryable: false,
        cause: rawErr
      }
    );
  }

  if (
    phase === 'init' &&
    (!isClientOnline() ||
      lower.includes('failed to fetch') ||
      lower.includes('networkerror') ||
      lower.includes('cannot fetch') ||
      lower.includes('load failed'))
  ) {
    if (!isClientOnline() && !wasCached) {
      return new WebLLMError(
        `${label} has not been downloaded to this browser yet. Connect to the internet once to download and cache the model for local use.`,
        {
          code: WEBLLM_ERROR_CODES.OFFLINE_UNCACHED,
          httpCode: 503,
          retryable: true,
          cause: rawErr
        }
      );
    }

    return new WebLLMError(
      !isClientOnline()
        ? `Offline initialization of ${label} failed because one or more required model or WASM cache entries were missing. Reconnect to the internet once to repair the local model cache.`
        : `Network connection was interrupted while downloading ${label}. Please check your internet connection and try again — already cached shards will resume automatically.`,
      {
        code: !isClientOnline() ? WEBLLM_ERROR_CODES.OFFLINE_UNCACHED : WEBLLM_ERROR_CODES.DOWNLOAD_FAILED,
        httpCode: 503,
        retryable: true,
        cause: rawErr
      }
    );
  }

  if (lower.includes('modelnotfounderror') || lower.includes('cannot find model record')) {
    return new WebLLMError(
      `Unsupported Browser AI model "${modelId}". Please select a supported Qwen model.`,
      {
        code: WEBLLM_ERROR_CODES.UNSUPPORTED_MODEL,
        httpCode: 400,
        retryable: false,
        cause: rawErr
      }
    );
  }

  return new WebLLMError(
    phase === 'init'
      ? `Failed to initialize Browser AI (${label}): ${rawText || 'Unexpected WebGPU initialization error.'}`
      : `Browser AI encountered a local generation error: ${rawText || 'Unexpected runtime failure.'}`,
    {
      code: phase === 'init' ? WEBLLM_ERROR_CODES.INIT_FAILED : WEBLLM_ERROR_CODES.GENERATION_FAILED,
      httpCode: 500,
      retryable: true,
      cause: rawErr
    }
  );
}

// ============================================================================
// Worker Lifecycle, Lazy Initialization & Cleanup
// ============================================================================

function terminateWorkerImmediate() {
  if (workerInstance) {
    try {
      workerInstance.onmessage = null;
      workerInstance.onerror = null;
      workerInstance.onmessageerror = null;
      workerInstance.terminate();
    } catch (_) {
      // Ignore worker termination errors
    }
    workerInstance = null;
  }
  engineInstance = null;
  loadedModelId = null;
}

/**
 * Unloads any loaded model from WebGPU memory and terminates the dedicated Web Worker.
 * Safe to call multiple times or during error recovery.
 */
export async function destroyWebLLMEngine() {
  const currentEngine = engineInstance;
  engineInstance = null;
  loadedModelId = null;
  isGeneratingNow = false;
  manualStopRequested = false;

  if (activeInitAbortReject) {
    const rejectInit = activeInitAbortReject;
    activeInitAbortReject = null;
    rejectInit(createAbortError('Browser AI engine was reset.'));
  }

  if (currentEngine) {
    try {
      currentEngine.interruptGenerate();
    } catch (_) {
      // Ignore
    }
    try {
      await Promise.race([
        currentEngine.unload(),
        new Promise((resolve) => setTimeout(resolve, 1500))
      ]);
    } catch (_) {
      // Ignore unload failure on lost GPU device
    }
  }

  terminateWorkerImmediate();

  updateEngineState({
    status: 'idle',
    progress: 0,
    progressPercent: null,
    progressText: '',
    error: null
  });
}

/**
 * Alias for destroyWebLLMEngine for explicit resource cleanup callers.
 */
export const unloadWebLLMEngine = destroyWebLLMEngine;

/**
 * Lazily initializes the dedicated WebLLM worker and loads the requested Qwen model onto WebGPU.
 * Reuses the active engine immediately if the resolved model is already loaded.
 *
 * @param {Object} [options]
 * @param {string|null} [options.modelId] - Optional model ID (defaults to Qwen 2.5 1.5B Instruct)
 * @param {boolean} [options.allowF32Fallback=true] - Automatically select q4f32_1 variant if adapter lacks shader-f16
 * @param {(report: { status: string, modelId: string, progress: number, progressPercent: number, progressText: string, timeElapsed: number, isCached: boolean }) => void} [options.onProgress]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ engine: any, modelId: string, isCached: boolean }>}
 */
export async function ensureWebLLMEngine(options = {}) {
  const {
    modelId: requestedModelId = DEFAULT_WEBLLM_MODEL_ID,
    allowF32Fallback = true,
    onProgress,
    signal
  } = options;

  if (signal?.aborted) {
    throw createAbortError();
  }

  // 1. Check WebGPU compatibility before loading the heavy @mlc-ai/web-llm chunk
  updateEngineState({
    status: engineInstance ? engineState.status : 'checking',
    error: null
  });

  const gpuSupport = await checkWebGPUSupport();
  if (!gpuSupport.supported) {
    const gpuError = new WebLLMError(
      gpuSupport.message || 'WebGPU is unavailable on this browser or device.',
      {
        code: gpuSupport.reasonCode || WEBLLM_ERROR_CODES.WEBGPU_UNSUPPORTED,
        httpCode: 400,
        retryable: false
      }
    );
    updateEngineState({
      status: 'error',
      hasShaderF16: false,
      error: gpuError.message
    });
    throw gpuError;
  }

  const resolvedModelId = resolveWebLLMModelId(requestedModelId, {
    hasShaderF16: gpuSupport.hasShaderF16,
    allowF32Fallback
  });

  const catalogEntry = WEBLLM_MODEL_CATALOG[resolvedModelId];
  if (catalogEntry?.prefersShaderF16 && !gpuSupport.hasShaderF16) {
    const f16Err = new WebLLMError(
      `Your GPU adapter does not support WebGPU shader-f16 required by ${catalogEntry.label}.`,
      {
        code: WEBLLM_ERROR_CODES.SHADER_F16_UNSUPPORTED,
        httpCode: 400,
        retryable: false
      }
    );
    updateEngineState({
      status: 'error',
      modelId: resolvedModelId,
      hasShaderF16: false,
      error: f16Err.message
    });
    throw f16Err;
  }

  // Fast path: already loaded and healthy
  if (engineInstance && workerInstance && loadedModelId === resolvedModelId) {
    const readyPayload = {
      status: 'ready',
      modelId: resolvedModelId,
      progress: 1,
      progressPercent: 100,
      progressText: 'Model ready on device',
      timeElapsed: 0,
      isCached: true
    };
    updateEngineState({
      ...readyPayload,
      hasShaderF16: gpuSupport.hasShaderF16,
      error: null
    });
    if (typeof onProgress === 'function') {
      onProgress(readyPayload);
    }
    return {
      engine: engineInstance,
      modelId: resolvedModelId,
      isCached: true
    };
  }

  // Deduplicate concurrent initialization requests for the same model
  if (activeInitPromise && activeInitModelId === resolvedModelId) {
    let unsub = null;
    if (typeof onProgress === 'function') {
      unsub = subscribeWebLLMState((st) => {
        if (st.status === 'downloading' || st.status === 'loading' || st.status === 'ready') {
          onProgress({
            status: st.status,
            modelId: st.modelId,
            progress: st.progress,
            progressPercent: st.progressPercent,
            progressText: st.progressText,
            timeElapsed: st.timeElapsed,
            isCached: st.isCached
          });
        }
      });
    }
    try {
      return await activeInitPromise;
    } finally {
      if (unsub) unsub();
    }
  }

  // If another model was previously loaded or initializing, clean it up before loading the new model
  if (activeInitPromise) {
    try {
      await activeInitPromise;
    } catch (_) {
      // Ignore prior init error before re-initializing
    }
  }
  if (engineInstance && loadedModelId && loadedModelId !== resolvedModelId) {
    await destroyWebLLMEngine();
  }

  activeInitModelId = resolvedModelId;
  activeInitPromise = (async () => {
    let wasCachedBeforeInit = false;
    let removeAbortListener = null;

    try {
      if (signal?.aborted) {
        throw createAbortError();
      }

      // 2. Lazily import @mlc-ai/web-llm runtime
      const webllm = await loadWebLLMModule();

      // Verify model ID exists in installed prebuiltAppConfig.model_list
      const modelRecord = findPrebuiltModelRecord(webllm, resolvedModelId);
      if (!modelRecord) {
        throw new WebLLMError(
          `Model "${resolvedModelId}" is not available in the installed WebLLM runtime.`,
          {
            code: WEBLLM_ERROR_CODES.UNSUPPORTED_MODEL,
            httpCode: 400,
            retryable: false
          }
        );
      }

      // 3. Verified cache check before touching network
      wasCachedBeforeInit = await isWebLLMModelCached(resolvedModelId);

      if (!wasCachedBeforeInit && !isClientOnline()) {
        const label = catalogEntry?.label || resolvedModelId;
        throw new WebLLMError(
          `${label} has not been downloaded to this browser yet. Please connect to the internet once to download and cache the model (~${catalogEntry?.estimatedDownloadMB || 960} MB), after which it can run locally on your device.`,
          {
            code: WEBLLM_ERROR_CODES.OFFLINE_UNCACHED,
            httpCode: 503,
            retryable: true
          }
        );
      }

      if (!wasCachedBeforeInit) {
        await verifyBrowserStorageForDownload(resolvedModelId);
      }

      const initialStatus = wasCachedBeforeInit ? 'loading' : 'downloading';
      const initialText = wasCachedBeforeInit
        ? `Loading cached ${catalogEntry?.shortLabel || resolvedModelId} into GPU memory...`
        : `Downloading ${catalogEntry?.shortLabel || resolvedModelId} to browser cache...`;

      updateEngineState({
        status: initialStatus,
        modelId: resolvedModelId,
        progress: 0,
        progressPercent: null,
        progressText: initialText,
        timeElapsed: 0,
        isCached: wasCachedBeforeInit,
        hasShaderF16: gpuSupport.hasShaderF16,
        error: null
      });

      if (typeof onProgress === 'function') {
        onProgress({
          status: initialStatus,
          modelId: resolvedModelId,
          progress: 0,
          progressPercent: null,
          progressText: initialText,
          timeElapsed: 0,
          isCached: wasCachedBeforeInit
        });
      }

      // 4. Spawn dedicated ES module Web Worker
      terminateWorkerImmediate();
      const worker = new Worker(new URL('../workers/webllmWorker.js', import.meta.url), {
        type: 'module',
        name: 'orvix-webllm-worker'
      });
      workerInstance = worker;

      const workerCrashPromise = new Promise((_, reject) => {
        activeInitAbortReject = reject;

        worker.onerror = (event) => {
          const detail = event?.message || 'Dedicated WebLLM worker encountered an unexpected fatal error.';
          terminateWorkerImmediate();
          reject(
            new WebLLMError(detail, {
              code: WEBLLM_ERROR_CODES.WORKER_CRASHED,
              httpCode: 500,
              retryable: true,
              cause: event?.error || event
            })
          );
        };

        worker.onmessageerror = () => {
          terminateWorkerImmediate();
          reject(
            new WebLLMError('Communication with the Browser AI worker failed.', {
              code: WEBLLM_ERROR_CODES.WORKER_CRASHED,
              httpCode: 500,
              retryable: true
            })
          );
        };

        if (signal) {
          const onAbort = () => {
            terminateWorkerImmediate();
            reject(createAbortError('Model initialization cancelled by user.'));
          };
          if (signal.aborted) {
            onAbort();
            return;
          }
          signal.addEventListener('abort', onAbort, { once: true });
          removeAbortListener = () => signal.removeEventListener('abort', onAbort);
        }
      });

      const handleInitProgress = (report) => {
        const hasNumericProgress =
          typeof report?.progress === 'number' && Number.isFinite(report.progress);
        const rawProgress = hasNumericProgress
          ? Math.min(1, Math.max(0, report.progress))
          : null;
        const progressPercent = rawProgress !== null ? Math.round(rawProgress * 100) : null;
        const text = String(report?.text || '').trim();
        const timeElapsed = typeof report?.timeElapsed === 'number' ? report.timeElapsed : 0;

        const lowerText = text.toLowerCase();
        const isFetchStep =
          !wasCachedBeforeInit &&
          (lowerText.includes('fetching') || lowerText.includes('downloading')) &&
          (rawProgress === null || rawProgress < 1);
        const isGpuLoadStep =
          lowerText.includes('loading model from cache') ||
          lowerText.includes('loading gpu') ||
          lowerText.includes('compiling') ||
          lowerText.includes('finish loading');

        const stepStatus =
          (rawProgress !== null && rawProgress >= 1) || isGpuLoadStep
            ? 'loading'
            : isFetchStep
              ? 'downloading'
              : wasCachedBeforeInit
                ? 'loading'
                : 'downloading';

        updateEngineState({
          status: stepStatus,
          modelId: resolvedModelId,
          progress: rawProgress ?? 0,
          progressPercent,
          progressText: text || initialText,
          timeElapsed,
          isCached: wasCachedBeforeInit
        });

        if (typeof onProgress === 'function') {
          try {
            onProgress({
              status: stepStatus,
              modelId: resolvedModelId,
              progress: rawProgress ?? 0,
              progressPercent,
              progressText: text || initialText,
              timeElapsed,
              isCached: wasCachedBeforeInit
            });
          } catch (_) {
            // Never allow progress listener error to break initialization
          }
        }
      };

      const chatOpts = {
        context_window_size: catalogEntry?.contextWindowSize || 4096
      };

      const createdEngine = await Promise.race([
        webllm.CreateWebWorkerMLCEngine(
          worker,
          resolvedModelId,
          {
            initProgressCallback: handleInitProgress,
            logLevel: 'WARN'
          },
          chatOpts
        ),
        workerCrashPromise
      ]);

      activeInitAbortReject = null;

      // Keep runtime worker error listener active after init so runtime crashes recover cleanly
      worker.onerror = (event) => {
        console.error('[Orvix WebLLM] Runtime worker error:', event?.message || event);
        terminateWorkerImmediate();
        updateEngineState({
          status: 'error',
          error: 'Browser AI worker stopped unexpectedly (possible GPU memory limit). Next message will reload the engine.'
        });
      };

      engineInstance = createdEngine;
      loadedModelId = resolvedModelId;

      const readyReport = {
        status: 'ready',
        modelId: resolvedModelId,
        progress: 1,
        progressPercent: 100,
        progressText: 'Model ready on device',
        timeElapsed: engineState.timeElapsed || 0,
        isCached: true
      };

      updateEngineState({
        ...readyReport,
        hasShaderF16: gpuSupport.hasShaderF16,
        error: null
      });

      if (typeof onProgress === 'function') {
        try {
          onProgress(readyReport);
        } catch (_) {
          // Ignore callback error
        }
      }

      return {
        engine: createdEngine,
        modelId: resolvedModelId,
        isCached: true
      };
    } catch (rawErr) {
      activeInitAbortReject = null;
      terminateWorkerImmediate();

      if (isAbortError(rawErr)) {
        updateEngineState({
          status: 'idle',
          progress: 0,
          progressPercent: null,
          progressText: '',
          error: null
        });
        throw rawErr;
      }

      const normalizedError = normalizeWebLLMError(rawErr, {
        modelId: resolvedModelId,
        phase: 'init',
        wasCached: wasCachedBeforeInit
      });

      updateEngineState({
        status: 'error',
        modelId: resolvedModelId,
        progress: 0,
        progressPercent: null,
        progressText: '',
        error: normalizedError.message
      });

      throw normalizedError;
    } finally {
      if (removeAbortListener) {
        removeAbortListener();
      }
      activeInitPromise = null;
      activeInitModelId = null;
    }
  })();

  return activeInitPromise;
}

// ============================================================================
// Prompt Construction & Bounded Context Formatting
// ============================================================================

/**
 * Builds Orvix's companion system instruction locally in the browser, honoring
 * username, responseLength, beginnerFriendly, and active chat mode.
 */
function buildLocalSystemInstruction(username = null, preferences = null, mode = 'general') {
  const instructions = [
    'You are Orvix, an intelligent, helpful, and concise AI conversation companion. Provide clear explanations, code blocks with languages where appropriate, and formatted answers.'
  ];

  if (username && String(username).trim()) {
    const cleanName = String(username)
      .trim()
      .slice(0, 50)
      .replace(/[\r\n\t]/g, ' ');
    instructions.push(
      `The user's preferred name is ${cleanName}. You may address the user by this name naturally when appropriate. Do not overuse the name, do not invent additional personal information, and do not claim to remember information that has not been provided.`
    );
  }

  if (preferences?.responseLength === 'concise') {
    instructions.push(
      'Preferred response length: Concise. Keep explanations brief, compact, focused, and directly to the point without filler or redundant commentary.'
    );
  } else if (preferences?.responseLength === 'detailed') {
    instructions.push(
      'Preferred response length: Detailed. Provide thorough, in-depth explanations with helpful background context, step-by-step reasoning, and practical code or concepts where appropriate.'
    );
  } else if (preferences?.responseLength === 'balanced') {
    instructions.push(
      'Preferred response length: Balanced. Provide an optimal balance between conciseness and thoroughness.'
    );
  }

  if (preferences?.beginnerFriendly) {
    instructions.push(
      'Explanation style: Clear and beginner-friendly. Explain technical and complex topics using plain language, accessible analogies, and approachable steps, avoiding unnecessary jargon without talking down to the user.'
    );
  }

  const chatMode = getChatMode(mode);
  if (chatMode?.instruction) {
    instructions.push(chatMode.instruction);
  }

  return instructions.join(' ');
}

/**
 * Bounds multi-turn history so total message characters fit comfortably inside Qwen 2.5's
 * 4,096-token WebGPU KV cache (~12,500 chars total input budget, leaving room for output tokens).
 */
function trimMessagesToContextBudget(messages, maxInputChars = 12_500) {
  if (!Array.isArray(messages) || messages.length <= 2) {
    return messages;
  }

  const totalLength = messages.reduce((sum, m) => sum + (m?.content?.length || 0), 0);
  if (totalLength <= maxInputChars) {
    return messages;
  }

  const hasSystem = messages[0]?.role === 'system';
  const systemMsg = hasSystem ? messages[0] : null;
  const latestUserMsg = messages[messages.length - 1];
  const middleHistory = messages.slice(hasSystem ? 1 : 0, messages.length - 1);

  let usedChars = (systemMsg?.content?.length || 0) + (latestUserMsg?.content?.length || 0);
  const keptHistory = [];

  for (let i = middleHistory.length - 1; i >= 0; i--) {
    const candidate = middleHistory[i];
    const len = candidate?.content?.length || 0;
    if (usedChars + len > maxInputChars) {
      break;
    }
    keptHistory.unshift(candidate);
    usedChars += len;
  }

  return [
    ...(systemMsg ? [systemMsg] : []),
    ...keptHistory,
    latestUserMsg
  ];
}

// ============================================================================
// Streaming, Non-Streaming & Cancellation APIs
// ============================================================================

/**
 * Interrupts an in-progress Browser AI generation immediately without destroying the cached model.
 * If initialization is currently running, aborts initialization cleanly.
 */
export function stopWebLLMGeneration() {
  manualStopRequested = true;

  if (activeInitAbortReject && !engineInstance) {
    const rejectInit = activeInitAbortReject;
    activeInitAbortReject = null;
    terminateWorkerImmediate();
    rejectInit(createAbortError('Model initialization stopped by user.'));
    return;
  }

  if (engineInstance) {
    try {
      engineInstance.interruptGenerate();
    } catch (err) {
      console.warn('[Orvix WebLLM] interruptGenerate warning:', err?.message || err);
    }
  }
}

/**
 * Streams a chat completion from the local WebLLM Qwen engine running inside the browser worker.
 *
 * @param {Object} params
 * @param {string} params.prompt - User prompt text
 * @param {Array<{ sender: string, content: string }>} [params.history=[]] - Prior conversation messages
 * @param {string|null} [params.username=null]
 * @param {Object|null} [params.preferences=null]
 * @param {string} [params.mode='general']
 * @param {string|null} [params.model=null] - Optional WebLLM model ID override
 * @param {Array<Object>} [params.attachments=[]] - Optional extracted document/OCR attachments
 * @param {({ modelUsed: string, provider: string }) => void} [params.onStart]
 * @param {(chunkText: string, accumulatedText: string) => void} [params.onChunk]
 * @param {(report: Object) => void} [params.onProgress]
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<{ text: string, modelUsed: string, provider: string, usage?: Object }>}
 */
export async function streamWebLLMMessage({
  prompt,
  history = [],
  username = null,
  preferences = null,
  mode = 'general',
  model = null,
  attachments = [],
  onStart,
  onChunk,
  onProgress,
  signal
} = {}) {
  const cleanPrompt = typeof prompt === 'string' ? prompt.trim() : '';
  if (!cleanPrompt) {
    throw new WebLLMError('Prompt cannot be empty.', {
      code: 'INVALID_ARGUMENT',
      httpCode: 400,
      retryable: false
    });
  }

  if (signal?.aborted) {
    throw createAbortError();
  }

  // Serialize concurrent requests on the single WebGPU worker pipeline
  const previousTurn = generationQueuePromise.catch(() => {});
  let releaseQueue;
  generationQueuePromise = new Promise((resolve) => {
    releaseQueue = resolve;
  });

  await previousTurn;

  try {
    if (signal?.aborted) {
      throw createAbortError();
    }

    const { engine, modelId } = await ensureWebLLMEngine({
      modelId: model || DEFAULT_WEBLLM_MODEL_ID,
      onProgress,
      signal
    });

    if (signal?.aborted) {
      throw createAbortError();
    }

    const catalogEntry = WEBLLM_MODEL_CATALOG[modelId];
    const baseSystemInstruction = buildLocalSystemInstruction(username, preferences, mode);

    // Handle local pre-extracted attachments (PDF, DOCX, TXT, offline Tesseract OCR) without server round-trips
    const rawAttachments = Array.isArray(attachments) ? attachments.filter(Boolean) : [];
    let effectiveSystemInstruction = baseSystemInstruction;
    let effectivePrompt = cleanPrompt;

    if (rawAttachments.length > 0) {
      const normalizedDocs = [];
      for (const att of rawAttachments) {
        const hasExtractionPayload = Boolean(
          att.extraction ||
            typeof att.extractedText === 'string' ||
            typeof att.text === 'string' ||
            att.status === 'NO_TEXT_DETECTED' ||
            att.status === 'error' ||
            att.status === 'unsupported_format'
        );

        if (!hasExtractionPayload) {
          const attName = att.originalName || att.name || att.filename || 'attachment';
          throw new WebLLMError(
            `Attachment "${attName}" has no extracted text available for Browser AI. Connect to the internet to extract file text or remove the attachment to chat locally.`,
            {
              code: WEBLLM_ERROR_CODES.GENERATION_FAILED,
              httpCode: 400,
              retryable: false
            }
          );
        }

        const ext = att.extraction || att;
        const textBody =
          typeof ext.text === 'string'
            ? ext.text
            : typeof ext.extractedText === 'string'
              ? ext.extractedText
              : '';
        const wordMatches = textBody.trim() ? textBody.trim().match(/\S+/g) : null;

        normalizedDocs.push({
          ...ext,
          id: ext.id || att.id || att.fileId,
          originalName: ext.originalName || att.originalName || att.name || att.filename || 'attachment',
          filename: ext.filename || att.filename || att.name || 'attachment',
          format: ext.format || att.extension || 'TXT',
          text: textBody,
          totalCharacters:
            typeof ext.totalCharacters === 'number' ? ext.totalCharacters : textBody.length,
          totalWords:
            typeof ext.totalWords === 'number' ? ext.totalWords : wordMatches ? wordMatches.length : 0,
          isImage: Boolean(ext.isImage ?? att.isImage ?? false)
        });
      }

      const preparedContext = prepareDocumentContext(cleanPrompt, normalizedDocs, {
        provider: WEBLLM_PROVIDER_ID
      });

      // Direct deterministic response when attached image/document has NO_TEXT_DETECTED or unreadable notice
      if (preparedContext.directAnswer && !preparedContext.formattedContext) {
        if (signal?.aborted) {
          throw createAbortError();
        }
        if (typeof onStart === 'function') {
          onStart({ modelUsed: modelId, provider: WEBLLM_PROVIDER_ID });
        }
        if (typeof onChunk === 'function') {
          onChunk(preparedContext.directAnswer, preparedContext.directAnswer);
        }
        return {
          text: preparedContext.directAnswer,
          modelUsed: modelId,
          provider: WEBLLM_PROVIDER_ID
        };
      }

      // Format attachment context directly in the user message (proven Qwen 2.5 grounding format)
      const adapted = adaptDocumentContextForProvider({
        provider: WEBLLM_PROVIDER_ID,
        prompt: cleanPrompt,
        baseSystemInstruction,
        preparedContext,
        maxCharsOverride: catalogEntry?.maxDocChars || 10_000
      });

      effectiveSystemInstruction = adapted.effectiveSystemInstruction;
      effectivePrompt = adapted.effectivePrompt;
    }

    const rawMessages = formatOpenAIMessages({
      systemInstruction: effectiveSystemInstruction,
      history,
      prompt: effectivePrompt,
      maxContextMessages: catalogEntry?.maxHistoryMessages || 8
    });

    const boundedMessages = trimMessagesToContextBudget(rawMessages, 12_500);

    const maxTokens =
      preferences?.responseLength === 'concise'
        ? 512
        : preferences?.responseLength === 'detailed'
          ? 1536
          : catalogEntry?.defaultMaxTokens || 1024;

    if (signal?.aborted) {
      throw createAbortError();
    }

    manualStopRequested = false;
    isGeneratingNow = true;

    let removeAbortHandler = null;
    if (signal) {
      const handleAbort = () => {
        stopWebLLMGeneration();
      };
      if (signal.aborted) {
        handleAbort();
        throw createAbortError();
      }
      signal.addEventListener('abort', handleAbort, { once: true });
      removeAbortHandler = () => signal.removeEventListener('abort', handleAbort);
    }

    updateEngineState({
      status: 'generating',
      modelId,
      error: null
    });

    if (typeof onStart === 'function' && !signal?.aborted && !manualStopRequested) {
      onStart({
        modelUsed: modelId,
        provider: WEBLLM_PROVIDER_ID
      });
    }

    let accumulatedText = '';
    let finalUsage = undefined;

    try {
      const asyncChunkGenerator = await engine.chat.completions.create({
        messages: boundedMessages,
        temperature: mode === 'coding' ? 0.3 : 0.7,
        top_p: 0.9,
        max_tokens: maxTokens,
        stream: true,
        stream_options: { include_usage: true }
      });

      for await (const chunk of asyncChunkGenerator) {
        if (signal?.aborted || manualStopRequested) {
          try {
            engine.interruptGenerate();
          } catch (_) {
            // Ignore
          }
          break;
        }

        const delta = chunk?.choices?.[0]?.delta?.content;
        if (delta && !signal?.aborted && !manualStopRequested) {
          accumulatedText += delta;
          if (typeof onChunk === 'function') {
            onChunk(delta, accumulatedText);
          }
        }

        if (chunk?.usage) {
          finalUsage = chunk.usage;
        }
      }

      if (signal?.aborted || manualStopRequested) {
        throw createAbortError();
      }

      const finalText = accumulatedText.trim();
      if (!finalText) {
        throw new WebLLMError('Browser AI returned an empty response. Please try phrasing your prompt again.', {
          code: WEBLLM_ERROR_CODES.GENERATION_FAILED,
          httpCode: 500,
          retryable: true
        });
      }

      updateEngineState({
        status: 'ready',
        modelId,
        error: null
      });

      return {
        text: accumulatedText,
        modelUsed: modelId,
        provider: WEBLLM_PROVIDER_ID,
        usage: finalUsage
      };
    } catch (genErr) {
      if (isAbortError(genErr) || signal?.aborted || manualStopRequested) {
        if (engineInstance) {
          updateEngineState({
            status: 'ready',
            modelId,
            error: null
          });
        }
        throw createAbortError();
      }

      // Recover cleanly from GPU device lost / OOM / worker crash so next turn reloads cleanly
      if (isFatalEngineError(genErr) || !workerInstance) {
        await destroyWebLLMEngine();
      } else {
        updateEngineState({
          status: 'ready',
          modelId,
          error: null
        });
      }

      const normalized = normalizeWebLLMError(genErr, {
        modelId,
        phase: 'generate',
        wasCached: true
      });

      updateEngineState({
        status: engineInstance ? 'ready' : 'error',
        modelId,
        error: normalized.message
      });

      throw normalized;
    } finally {
      isGeneratingNow = false;
      manualStopRequested = false;
      if (removeAbortHandler) {
        removeAbortHandler();
      }
    }
  } finally {
    if (releaseQueue) {
      releaseQueue();
    }
  }
}

/**
 * Non-streaming convenience wrapper around streamWebLLMMessage for symmetry with other Orvix provider services.
 */
export async function sendWebLLMMessage(params = {}) {
  return streamWebLLMMessage({
    ...params,
    onChunk: undefined
  });
}

/**
 * Returns whether Browser AI is currently generating tokens.
 */
export function isWebLLMGenerating() {
  return isGeneratingNow;
}
