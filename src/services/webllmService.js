/**
 * Orvix Browser-Based Local AI Engine Service (WebLLM)
 * Runs Qwen 2.5 Instruct models directly on the visitor's GPU via WebGPU inside a dedicated Web Worker.
 *
 * Key architectural guarantees (verified against @mlc-ai/web-llm@0.2.86):
 * 1. Strictly local browser inference — never routes requests to /api/chat, Firebase, or cloud APIs.
 * 2. Strictly lazy runtime loading — @mlc-ai/web-llm and the dedicated worker are dynamically loaded ONLY
 *    when Browser AI cache inspection or initialization is explicitly invoked.
 * 3. Non-blocking UI — tokenization, WASM execution, model weight loading, and WebGPU prefill/decode
 *    run inside src/workers/webllmWorker.js via CreateWebWorkerMLCEngine.
 * 4. Verified cache & offline protection — uses WebLLM's hasModelInCache() plus config/WASM cache checks
 *    to fail fast with a clear, actionable message if an uncached model is requested while offline.
 */

import { APP_CONFIG } from '../config/appConfig.js';
import { getChatMode } from '../config/chatModes.js';
import {
  prepareDocumentContext,
  adaptDocumentContextForProvider,
  formatOpenAIMessages
} from './documentContextService.js';
import { checkModelCompatibilityForProvider } from './providerModelSanitizer.js';
import {
  isRefinedTargetModel,
  getBrowserAiModelProfile,
  resolveProfileGenerationParams,
  buildProfileSystemInstruction,
  cleanModelOutput,
  createStreamingResponseSanitizer
} from './browserAiProfiles.js';

function isClientOnline() {
  if (typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean') {
    return navigator.onLine;
  }
  return true;
}

export const WEBLLM_PROVIDER_ID = 'webllm';

export const DEFAULT_WEBLLM_MODEL_ID = 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC';
export const FALLBACK_F32_WEBLLM_MODEL_ID = 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC';
export const SMOLLM2_360M_WEBLLM_MODEL_ID = 'SmolLM2-360M-Instruct-q4f16_1-MLC';
export const SMOLLM2_360M_F32_WEBLLM_MODEL_ID = 'SmolLM2-360M-Instruct-q4f32_1-MLC';
export const SMOLLM2_135M_WEBLLM_MODEL_ID = 'SmolLM2-135M-Instruct-q0f16-MLC';
export const SMOLLM2_135M_F32_WEBLLM_MODEL_ID = 'SmolLM2-135M-Instruct-q0f32-MLC';
export const QWEN3_06B_WEBLLM_MODEL_ID = 'Qwen3-0.6B-q4f16_1-MLC';
export const QWEN3_06B_F32_WEBLLM_MODEL_ID = 'Qwen3-0.6B-q4f32_1-MLC';

/**
 * Verified Browser AI models present in @mlc-ai/web-llm@0.2.86 prebuiltAppConfig.model_list.
 * Ordered from least reliable to most reliable:
 * 1. SmolLM2 135M (Ultra Lightweight)
 * 2. SmolLM2 360M (Compact)
 * 3. Qwen3 0.6B (Lightweight)
 * 4. Qwen 2.5 1.5B (Standard — default)
 */
export const WEBLLM_MODEL_CATALOG = Object.freeze({
  [SMOLLM2_135M_WEBLLM_MODEL_ID]: Object.freeze({
    id: SMOLLM2_135M_WEBLLM_MODEL_ID,
    label: 'SmolLM2 135M Instruct (Ultra Lightweight)',
    shortLabel: 'SmolLM2 135M',
    tier: 'ultra-lightweight',
    tierLabel: 'Ultra Lightweight',
    parameters: '~135M parameters',
    description: 'Ultra Lightweight (~135M parameters, Offline / Browser AI)',
    quantization: 'q0f16',
    prefersShaderF16: true,
    f32FallbackModelId: SMOLLM2_135M_F32_WEBLLM_MODEL_ID,
    vramRequiredMB: 359.69,
    estimatedDownloadMB: 270,
    minStorageBytes: 350 * 1024 * 1024,
    contextWindowSize: 4096,
    maxDocChars: 6_000,
    maxHistoryMessages: 6,
    defaultMaxTokens: 768,
    isDefault: false
  }),
  [SMOLLM2_135M_F32_WEBLLM_MODEL_ID]: Object.freeze({
    id: SMOLLM2_135M_F32_WEBLLM_MODEL_ID,
    label: 'SmolLM2 135M Instruct (Ultra Lightweight FP32)',
    shortLabel: 'SmolLM2 135M (FP32)',
    tier: 'ultra-lightweight-f32',
    tierLabel: 'Ultra Lightweight (FP32)',
    parameters: '~135M parameters',
    description: 'Ultra Lightweight (~135M parameters, Offline / Browser AI, FP32)',
    quantization: 'q0f32',
    prefersShaderF16: false,
    f32FallbackModelId: null,
    vramRequiredMB: 719.38,
    estimatedDownloadMB: 270,
    minStorageBytes: 400 * 1024 * 1024,
    contextWindowSize: 4096,
    maxDocChars: 6_000,
    maxHistoryMessages: 6,
    defaultMaxTokens: 768,
    isDefault: false
  }),
  [SMOLLM2_360M_WEBLLM_MODEL_ID]: Object.freeze({
    id: SMOLLM2_360M_WEBLLM_MODEL_ID,
    label: 'SmolLM2 360M Instruct (Compact)',
    shortLabel: 'SmolLM2 360M',
    tier: 'compact',
    tierLabel: 'Compact',
    parameters: '~360M parameters',
    description: 'Compact (~360M parameters, Offline / Browser AI)',
    quantization: 'q4f16_1',
    prefersShaderF16: true,
    f32FallbackModelId: SMOLLM2_360M_F32_WEBLLM_MODEL_ID,
    vramRequiredMB: 376.06,
    estimatedDownloadMB: 210,
    minStorageBytes: 300 * 1024 * 1024,
    contextWindowSize: 4096,
    maxDocChars: 7_000,
    maxHistoryMessages: 6,
    defaultMaxTokens: 896,
    isDefault: false
  }),
  [SMOLLM2_360M_F32_WEBLLM_MODEL_ID]: Object.freeze({
    id: SMOLLM2_360M_F32_WEBLLM_MODEL_ID,
    label: 'SmolLM2 360M Instruct (Compact FP32)',
    shortLabel: 'SmolLM2 360M (FP32)',
    tier: 'compact-f32',
    tierLabel: 'Compact (FP32)',
    parameters: '~360M parameters',
    description: 'Compact (~360M parameters, Offline / Browser AI, FP32)',
    quantization: 'q4f32_1',
    prefersShaderF16: false,
    f32FallbackModelId: null,
    vramRequiredMB: 579.61,
    estimatedDownloadMB: 210,
    minStorageBytes: 320 * 1024 * 1024,
    contextWindowSize: 4096,
    maxDocChars: 7_000,
    maxHistoryMessages: 6,
    defaultMaxTokens: 896,
    isDefault: false
  }),
  [QWEN3_06B_WEBLLM_MODEL_ID]: Object.freeze({
    id: QWEN3_06B_WEBLLM_MODEL_ID,
    label: 'Qwen3 0.6B',
    shortLabel: 'Qwen3 0.6B',
    tier: 'lightweight',
    tierLabel: 'Lightweight',
    parameters: '~0.6B parameters',
    description: 'Lightweight (~0.6B parameters, Offline / Browser AI)',
    quantization: 'q4f16_1',
    prefersShaderF16: true,
    f32FallbackModelId: QWEN3_06B_F32_WEBLLM_MODEL_ID,
    vramRequiredMB: 1403.34,
    estimatedDownloadMB: 335,
    minStorageBytes: 450 * 1024 * 1024,
    contextWindowSize: 4096,
    maxDocChars: 8_000,
    maxHistoryMessages: 6,
    defaultMaxTokens: 896,
    isDefault: false
  }),
  [QWEN3_06B_F32_WEBLLM_MODEL_ID]: Object.freeze({
    id: QWEN3_06B_F32_WEBLLM_MODEL_ID,
    label: 'Qwen3 0.6B (FP32)',
    shortLabel: 'Qwen3 0.6B (FP32)',
    tier: 'lightweight-f32',
    tierLabel: 'Lightweight (FP32)',
    parameters: '~0.6B parameters',
    description: 'Lightweight (~0.6B parameters, Offline / Browser AI, FP32)',
    quantization: 'q4f32_1',
    prefersShaderF16: false,
    f32FallbackModelId: null,
    vramRequiredMB: 1924.98,
    estimatedDownloadMB: 335,
    minStorageBytes: 450 * 1024 * 1024,
    contextWindowSize: 4096,
    maxDocChars: 8_000,
    maxHistoryMessages: 6,
    defaultMaxTokens: 896,
    isDefault: false
  }),
  [DEFAULT_WEBLLM_MODEL_ID]: Object.freeze({
    id: DEFAULT_WEBLLM_MODEL_ID,
    label: 'Qwen 2.5 1.5B Instruct',
    shortLabel: 'Qwen 2.5 1.5B',
    tier: 'standard',
    tierLabel: 'Standard',
    parameters: '~1.5B parameters',
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
    tierLabel: 'Standard (FP32)',
    parameters: '~1.5B parameters',
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
  CDN_UNREACHABLE: 'WEBLLM_CDN_UNREACHABLE',
  DOWNLOAD_STALLED: 'WEBLLM_DOWNLOAD_STALLED',
  DOWNLOAD_FAILED: 'WEBLLM_DOWNLOAD_FAILED',
  DEVICE_LOST: 'WEBLLM_DEVICE_LOST',
  WORKER_CRASHED: 'WEBLLM_WORKER_CRASHED',
  INIT_FAILED: 'WEBLLM_INIT_FAILED',
  GENERATION_FAILED: 'WEBLLM_GENERATION_FAILED'
});

export const DEFAULT_GPU_CHECK_TIMEOUT_MS = 10_000;
export const DEFAULT_MODULE_LOAD_TIMEOUT_MS = 25_000;
export const DEFAULT_CACHE_CHECK_TIMEOUT_MS = 15_000;
export const DEFAULT_CACHE_OP_TIMEOUT_MS = 10_000;
export const DEFAULT_CDN_PROBE_TIMEOUT_MS = 15_000;
export const DEFAULT_SHARD_STALL_TIMEOUT_MS = 30_000;
export const DEFAULT_SHARD_CONCURRENCY = 2;
export const DEFAULT_WORKER_INIT_STALL_TIMEOUT_MS = 90_000;

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
    this.httpStatus = this.code;
    this.provider = WEBLLM_PROVIDER_ID;
    this.retryable = Boolean(options.retryable);
    this.canFallback = false;
    this.timeout = Boolean(options.timeout || options.code === 'WEBLLM_TIMEOUT');
    this.cancelled = false;
    this.partial = Boolean(options.partial);
    this.partialText = typeof options.partialText === 'string' ? options.partialText : '';
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
let activeInitAbortController = null;
let generationQueuePromise = Promise.resolve();
let isGeneratingNow = false;
let manualStopRequested = false;
let customWorkerFactory = null;
let customEngineFactory = null;
let customFetchFactory = null;
let customDownloadConfig = null;

const MAX_DIAGNOSTIC_EVENTS = 80;
const recentDiagnosticEvents = [];

/**
 * Sanitizes a URL for diagnostic logging so signed CDN query tokens, credentials,
 * or presigned bridge paths are NEVER written to console or diagnostic buffers.
 */
export function sanitizeUrlForDiagnostics(rawUrl) {
  if (!rawUrl) return 'unknown';
  try {
    const parsed = new URL(String(rawUrl));
    const segments = parsed.pathname.split('/').filter(Boolean);
    const tail = segments.length > 0 ? segments[segments.length - 1] : '';
    // Avoid logging opaque hash-like presigned path tokens (>40 hex chars)
    const safeTail = tail && !/^[a-f0-9]{40,}$/i.test(tail) ? `/${tail}` : '';
    return `${parsed.hostname}${safeTail}`;
  } catch (_) {
    return 'invalid-url';
  }
}

/**
 * Records and logs a development-safe diagnostic event with stage name, app version,
 * and elapsed time without exposing signed URLs or secrets.
 */
export function logWebLLMStage(stage, details = {}, options = {}) {
  const { startMs = null, level = 'log' } = options;
  const now = Date.now();
  const elapsedMs = typeof startMs === 'number' && Number.isFinite(startMs) ? Math.max(0, now - startMs) : null;
  const elapsedTag = elapsedMs !== null ? ` (+${elapsedMs}ms)` : '';
  const detailParts = [];

  const sanitizedDetails = {};
  if (details && typeof details === 'object') {
    for (const [key, val] of Object.entries(details)) {
      if (val === undefined) continue;
      if (typeof val === 'string' && /^https?:\/\//i.test(val)) {
        const cleanUrl = sanitizeUrlForDiagnostics(val);
        sanitizedDetails[key] = cleanUrl;
        detailParts.push(`${key}=${cleanUrl}`);
      } else if (typeof val === 'object' && val !== null) {
        sanitizedDetails[key] = val;
        try {
          detailParts.push(`${key}=${JSON.stringify(val)}`);
        } catch (_) {
          detailParts.push(`${key}=[object]`);
        }
      } else {
        sanitizedDetails[key] = val;
        detailParts.push(`${key}=${String(val)}`);
      }
    }
  }

  const summary = detailParts.length > 0 ? ` ${detailParts.join(' ')}` : '';
  const line = `[Orvix WebLLM v${APP_CONFIG.version}][stage=${stage}]${elapsedTag}${summary}`;

  recentDiagnosticEvents.push({
    timestamp: now,
    stage,
    elapsedMs,
    details: sanitizedDetails,
    line
  });
  if (recentDiagnosticEvents.length > MAX_DIAGNOSTIC_EVENTS) {
    recentDiagnosticEvents.shift();
  }

  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export function getWebLLMDiagnostics() {
  return [...recentDiagnosticEvents];
}

/**
 * Races an async operation against a hard JS timer rejection so hung browser/OS
 * promises (e.g. fetch/reader/cache/GPU calls that ignore AbortSignal) cannot leave
 * the UI stuck at 0% indefinitely.
 */
async function raceWithStageDeadline(promiseFactory, timeoutMs, createTimeoutError) {
  const boundedMs = Math.max(40, Number(timeoutMs) || 10_000);
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try {
        reject(createTimeoutError(boundedMs));
      } catch (err) {
        reject(err);
      }
    }, boundedMs);
  });

  try {
    const targetPromise = typeof promiseFactory === 'function' ? promiseFactory() : promiseFactory;
    return await Promise.race([targetPromise, timeoutPromise]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * Resettable inactivity watchdog that BOTH invokes `onTimeoutAbort()` AND rejects
 * any raced promise via `watchdog.race(promise)` when no progress occurs within `timeoutMs`.
 */
function createResettableStallWatchdog(timeoutMs, createStallError, onTimeoutAbort) {
  const boundedMs = Math.max(40, Number(timeoutMs) || 30_000);
  let timer = null;
  let stalledError = null;
  const pendingRejectors = new Set();

  const arm = () => {
    if (stalledError) return;
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      stalledError = createStallError(boundedMs);
      if (typeof onTimeoutAbort === 'function') {
        try {
          onTimeoutAbort();
        } catch (_) {
          // Ignore abort callback failure
        }
      }
      for (const rejectFn of pendingRejectors) {
        try {
          rejectFn(stalledError);
        } catch (_) {
          // Ignore
        }
      }
      pendingRejectors.clear();
    }, boundedMs);
  };

  arm();

  return {
    touch() {
      if (!stalledError) {
        arm();
      }
    },
    hasStalled() {
      return Boolean(stalledError);
    },
    getError() {
      return stalledError;
    },
    async race(promise) {
      if (stalledError) {
        throw stalledError;
      }
      let registeredReject = null;
      const stallPromise = new Promise((_, reject) => {
        registeredReject = reject;
        pendingRejectors.add(reject);
      });
      try {
        return await Promise.race([promise, stallPromise]);
      } finally {
        if (registeredReject) {
          pendingRejectors.delete(registeredReject);
        }
      }
    },
    dispose() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      pendingRejectors.clear();
    }
  };
}

export function setWebLLMWorkerFactoryForTesting(factory) {
  customWorkerFactory = factory;
}

export function setWebLLMEngineFactoryForTesting(factory) {
  customEngineFactory = factory;
}

export function setWebLLMFetchForTesting(fetchFn) {
  customFetchFactory = fetchFn;
}

export function setWebLLMDownloadConfigForTesting(configOverrides) {
  customDownloadConfig = configOverrides || null;
}

export function resetWebLLMRuntimeForTesting() {
  customWorkerFactory = null;
  customEngineFactory = null;
  customFetchFactory = null;
  customDownloadConfig = null;
  recentDiagnosticEvents.length = 0;
  webllmModulePromise = null;
  if (activeInitAbortController) {
    try {
      activeInitAbortController.abort();
    } catch (_) {
      // Ignore abort errors during reset
    }
    activeInitAbortController = null;
  }
  terminateWorkerImmediate();
  generationQueuePromise = Promise.resolve();
  isGeneratingNow = false;
  manualStopRequested = false;
  activeInitPromise = null;
  activeInitModelId = null;
  activeInitAbortReject = null;
  loadedModelId = null;
  updateEngineState({
    status: 'idle',
    modelId: DEFAULT_WEBLLM_MODEL_ID,
    loadedModelId: null,
    progress: 0,
    progressPercent: null,
    progressText: '',
    timeElapsed: 0,
    isCached: false,
    hasShaderF16: null,
    error: null
  });
}

const stateListeners = new Set();

let engineState = {
  status: 'idle', // 'idle' | 'checking' | 'downloading' | 'loading' | 'ready' | 'generating' | 'error'
  modelId: DEFAULT_WEBLLM_MODEL_ID,
  loadedModelId: null,
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
  return {
    ...engineState,
    loadedModelId
  };
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
 * By default returns the primary user-selectable models in sequence from least to most reliable:
 * 1. SmolLM2 135M (Ultra-lightweight offline model)
 * 2. SmolLM2 360M (Compact offline model)
 * 3. Qwen3 0.6B (Lightweight offline model)
 * 4. Qwen 2.5 1.5B (Standard offline model — default)
 *
 * @param {{ includeF32Variants?: boolean, includeAllTiers?: boolean }} [options]
 */
export function getSupportedWebLLMModels(options = {}) {
  const { includeF32Variants = false, includeAllTiers = false } = options;
  if (includeAllTiers) {
    const all = Object.values(WEBLLM_MODEL_CATALOG);
    return includeF32Variants ? all : all.filter((entry) => !entry.tier.endsWith('-f32'));
  }

  const primaryModels = [
    WEBLLM_MODEL_CATALOG[SMOLLM2_135M_WEBLLM_MODEL_ID],
    WEBLLM_MODEL_CATALOG[SMOLLM2_360M_WEBLLM_MODEL_ID],
    WEBLLM_MODEL_CATALOG[QWEN3_06B_WEBLLM_MODEL_ID],
    WEBLLM_MODEL_CATALOG[DEFAULT_WEBLLM_MODEL_ID]
  ].filter(Boolean);

  if (includeF32Variants) {
    const f32s = primaryModels
      .map((m) => m.f32FallbackModelId && WEBLLM_MODEL_CATALOG[m.f32FallbackModelId])
      .filter(Boolean);
    return [...primaryModels, ...f32s];
  }

  return primaryModels;
}

/**
 * Lazily imports @mlc-ai/web-llm only when Browser AI is actually invoked.
 * Resets the cached import promise if chunk fetching fails (e.g. temporary offline state)
 * so subsequent attempts can recover cleanly.
 */
async function loadWebLLMModule(stageStartMs = null) {
  const timeoutMs = customDownloadConfig?.moduleLoadTimeoutMs ?? DEFAULT_MODULE_LOAD_TIMEOUT_MS;
  if (!webllmModulePromise) {
    logWebLLMStage('module_import_start', { pkg: '@mlc-ai/web-llm', timeoutMs }, { startMs: stageStartMs });
    webllmModulePromise = raceWithStageDeadline(
      () => import('@mlc-ai/web-llm'),
      timeoutMs,
      (ms) => {
        logWebLLMStage(
          'init_timeout',
          { subStage: 'module_import', timeoutMs: ms },
          { startMs: stageStartMs, level: 'warn' }
        );
        return new WebLLMError(
          `Timed out after ${formatDurationSeconds(ms)} loading the Browser AI runtime bundle. Please refresh the page and click Retry.`,
          {
            code: WEBLLM_ERROR_CODES.DOWNLOAD_STALLED,
            httpCode: 504,
            timeout: true,
            retryable: true
          }
        );
      }
    ).catch((err) => {
      webllmModulePromise = null;
      if (err instanceof WebLLMError) {
        throw err;
      }
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
  const mod = await webllmModulePromise;
  if (stageStartMs !== null) {
    logWebLLMStage('module_import_done', { ok: true }, { startMs: stageStartMs });
  }
  return mod;
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

  const gpuTimeoutMs = customDownloadConfig?.gpuCheckTimeoutMs ?? DEFAULT_GPU_CHECK_TIMEOUT_MS;
  try {
    const adapter = await raceWithStageDeadline(
      () =>
        navigator.gpu.requestAdapter({
          powerPreference: 'high-performance'
        }),
      gpuTimeoutMs,
      (ms) => {
        const timeoutErr = new Error(`WebGPU requestAdapter timed out after ${formatDurationSeconds(ms)}`);
        timeoutErr.code = 'WEBGPU_ADAPTER_TIMEOUT';
        return timeoutErr;
      }
    );

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
    const isTimeout = err?.code === 'WEBGPU_ADAPTER_TIMEOUT';
    if (isTimeout) {
      logWebLLMStage('init_timeout', { subStage: 'gpu_request_adapter', timeoutMs: gpuTimeoutMs }, { level: 'warn' });
    }
    return {
      supported: false,
      reasonCode: WEBLLM_ERROR_CODES.WEBGPU_ADAPTER_UNAVAILABLE,
      message: isTimeout
        ? `WebGPU graphics adapter detection timed out after ${formatDurationSeconds(gpuTimeoutMs)}. Restart Chrome or update your Windows GPU driver, then retry.`
        : 'Failed to access the WebGPU graphics adapter. Please check that hardware acceleration is enabled in your browser.',
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
  const rawId =
    requestedModelId && typeof requestedModelId === 'string' && requestedModelId.trim()
      ? requestedModelId.trim()
      : DEFAULT_WEBLLM_MODEL_ID;

  // Safe migration for obsolete 0.5B model:
  // If an old session, profile, or localStorage passed the obsolete 0.5B model,
  // migrate it to the current lightweight model (Qwen3 0.6B) instead of attempting
  // to download or initialize obsolete weights.
  const isObsolete05B =
    rawId.toLowerCase().includes('0.5b') ||
    rawId.toLowerCase().includes('qwen2.5-0.5b');

  const normalizedRequestedId = isObsolete05B
    ? QWEN3_06B_WEBLLM_MODEL_ID
    : rawId;

  // Case-insensitive lookup against verified catalog keys
  const catalogKey = Object.keys(WEBLLM_MODEL_CATALOG).find(
    (k) => k.toLowerCase() === normalizedRequestedId.toLowerCase()
  );
  const baseId = catalogKey || (isObsolete05B ? QWEN3_06B_WEBLLM_MODEL_ID : DEFAULT_WEBLLM_MODEL_ID);

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
    const storageTimeoutMs = customDownloadConfig?.cacheOpTimeoutMs ?? DEFAULT_CACHE_OP_TIMEOUT_MS;
    try {
      const estimate = await raceWithStageDeadline(
        () => navigator.storage.estimate(),
        storageTimeoutMs,
        (ms) => new Error(`navigator.storage.estimate timed out after ${ms}ms`)
      );
      if (
        estimate &&
        typeof estimate.quota === 'number' &&
        estimate.quota > 0 &&
        typeof estimate.usage === 'number'
      ) {
        const availableBytes = Math.max(0, estimate.quota - estimate.usage);
        logWebLLMStage('storage_quota_checked', {
          modelId,
          availableMB: Math.round(availableBytes / (1024 * 1024)),
          requiredMB: Math.round(minBytes / (1024 * 1024))
        });
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
      logWebLLMStage('storage_quota_warning', { message: err?.message || String(err) }, { level: 'warn' });
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

  const cacheCheckTimeoutMs = customDownloadConfig?.cacheCheckTimeoutMs ?? DEFAULT_CACHE_CHECK_TIMEOUT_MS;
  try {
    return await raceWithStageDeadline(
      async () => {
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

        // Also verify required tokenizer file when config JSON is readable
        if (typeof cachedConfig.clone === 'function') {
          try {
            const configObj = await cachedConfig.clone().json();
            if (configObj && Array.isArray(configObj.tokenizer_files)) {
              const requiredTokenizerFile = configObj.tokenizer_files.includes('tokenizer.json')
                ? 'tokenizer.json'
                : configObj.tokenizer_files.includes('tokenizer.model')
                  ? 'tokenizer.model'
                  : null;
              if (requiredTokenizerFile) {
                const modelCache = await caches.open('webllm/model');
                const tokenizerUrl = new URL(requiredTokenizerFile, modelBaseUrl).href;
                const cachedTokenizer = await modelCache.match(new Request(tokenizerUrl));
                if (!cachedTokenizer) {
                  return false;
                }
              }
            }
          } catch (_) {
            // Ignore non-JSON synthetic mock responses in unit tests
          }
        }

        return true;
      },
      cacheCheckTimeoutMs,
      (ms) => new Error(`Cache inspection timed out after ${formatDurationSeconds(ms)}`)
    );
  } catch (err) {
    logWebLLMStage(
      'cache_check_warning',
      { modelId, error: err?.message || String(err) },
      { level: 'warn' }
    );
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
  const readinessStartMs = Date.now();
  const gpuSupport = await checkWebGPUSupport();
  const resolvedId = resolveWebLLMModelId(preferredModelId, {
    hasShaderF16: gpuSupport.hasShaderF16,
    allowF32Fallback: true
  });

  if (!gpuSupport.supported) {
    if (!activeInitPromise) {
      updateEngineState({
        isCached: false,
        modelId: resolvedId,
        loadedModelId,
        hasShaderF16: false
      });
    }
    logWebLLMStage(
      'readiness_inspected',
      { modelId: resolvedId, gpuSupported: false, reasonCode: gpuSupport.reasonCode },
      { startMs: readinessStartMs, level: 'warn' }
    );
    return {
      modelId: resolvedId,
      isCached: false,
      gpuSupport
    };
  }

  const isCached = await isWebLLMModelCached(resolvedId);

  // Never clobber an active initialization's status/progress from a background readiness check
  if (
    activeInitPromise ||
    engineState.status === 'checking' ||
    engineState.status === 'downloading' ||
    engineState.status === 'loading'
  ) {
    logWebLLMStage(
      'readiness_inspected',
      { modelId: resolvedId, isCached, skippedStatePatchDuringActiveInit: true },
      { startMs: readinessStartMs }
    );
    return {
      modelId: resolvedId,
      isCached,
      gpuSupport
    };
  }

  // If status is 'ready' or 'generating', ensure it matches actual loaded engine in GPU memory
  let nextStatus = engineState.status;
  if (engineState.status === 'ready' || engineState.status === 'generating') {
    if (!loadedModelId || !engineInstance) {
      nextStatus = 'idle';
    }
  }

  updateEngineState({
    status: nextStatus,
    isCached,
    modelId: resolvedId,
    loadedModelId,
    hasShaderF16: gpuSupport.hasShaderF16
  });

  logWebLLMStage(
    'readiness_inspected',
    { modelId: resolvedId, isCached, hasShaderF16: gpuSupport.hasShaderF16, status: nextStatus },
    { startMs: readinessStartMs }
  );

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
// Bounded CDN Diagnostic Probe & Streaming Byte-Verified Artifact Downloader
// ============================================================================

function getEffectiveFetch(overrideFetch) {
  if (typeof overrideFetch === 'function') return overrideFetch;
  if (typeof customFetchFactory === 'function') return customFetchFactory;
  if (typeof globalThis.fetch === 'function') return globalThis.fetch.bind(globalThis);
  throw new WebLLMError('Browser Fetch API is unavailable in this environment.', {
    code: WEBLLM_ERROR_CODES.DOWNLOAD_FAILED,
    httpCode: 503,
    retryable: false
  });
}

function safeExtractHostname(rawUrl) {
  try {
    return new URL(String(rawUrl || '')).hostname || '';
  } catch (_) {
    return '';
  }
}

function formatMegabytes(bytes) {
  return (Math.max(0, Number(bytes) || 0) / (1024 * 1024)).toFixed(1);
}

function formatDurationSeconds(ms) {
  const numericMs = Math.max(1, Number(ms) || 0);
  if (numericMs < 1000) {
    return `${(numericMs / 1000).toFixed(1)}s`;
  }
  return `${Math.round(numericMs / 1000)}s`;
}

/**
 * Performs a small, bounded diagnostic request (`Range: bytes=0-1023`) against a model shard URL
 * BEFORE attempting a full multi-hundred-MB download.
 *
 * Explicitly verifies BOTH:
 * 1. Redirect resolution across Hugging Face hosts (e.g. `huggingface.co` HTTP 302 -> `us.aws.cdn.hf.co`
 *    or other regional storage bridges) without assuming origin reachability proves CDN reachability.
 * 2. Actual response body byte delivery (`transferredBytes > 0`) within `timeoutMs`, catching the
 *    `HTTP 200 Pending` zero-byte stream stall before starting full shard downloads.
 *
 * @param {string} targetUrl
 * @param {{
 *   modelLabel?: string,
 *   signal?: AbortSignal,
 *   timeoutMs?: number,
 *   fetchImpl?: typeof fetch
 * }} [options]
 */
export async function probeWebLLMModelCDN(targetUrl, options = {}) {
  const {
    modelLabel = 'Browser AI model',
    signal,
    timeoutMs = customDownloadConfig?.probeTimeoutMs ?? DEFAULT_CDN_PROBE_TIMEOUT_MS,
    fetchImpl
  } = options;

  if (signal?.aborted) {
    throw createAbortError();
  }

  const probeStartMs = Date.now();
  const boundedTimeoutMs = Math.max(50, Number(timeoutMs) || DEFAULT_CDN_PROBE_TIMEOUT_MS);
  const effectiveFetch = getEffectiveFetch(fetchImpl);
  const originHost = safeExtractHostname(targetUrl) || 'huggingface.co';
  const probeController = new AbortController();
  let timedOut = false;
  let onCallerAbort = null;

  logWebLLMStage(
    'cdn_probe_start',
    {
      originHost,
      target: sanitizeUrlForDiagnostics(targetUrl),
      timeoutMs: boundedTimeoutMs
    },
    { startMs: probeStartMs }
  );

  if (signal) {
    onCallerAbort = () => probeController.abort();
    if (signal.aborted) {
      throw createAbortError();
    }
    signal.addEventListener('abort', onCallerAbort, { once: true });
  }

  let response = null;
  let reader = null;
  try {
    const probeResult = await raceWithStageDeadline(
      async () => {
        response = await effectiveFetch(targetUrl, {
          method: 'GET',
          headers: {
            Range: 'bytes=0-1023'
          },
          redirect: 'follow',
          cache: 'no-store',
          credentials: 'omit',
          mode: 'cors',
          signal: probeController.signal
        });

        const redirectedHost = safeExtractHostname(response?.url) || originHost;
        const status = typeof response?.status === 'number' ? response.status : 0;

        if (status < 200 || status >= 300) {
          throw new WebLLMError(
            `Model storage CDN (${redirectedHost}) returned HTTP ${status} while preparing ${modelLabel}. Check firewall, VPN, or proxy access to ${originHost} and ${redirectedHost}, then click Retry.`,
            {
              code: WEBLLM_ERROR_CODES.CDN_UNREACHABLE,
              httpCode: status >= 400 ? status : 503,
              retryable: status === 408 || status === 429 || status >= 500 || status === 403
            }
          );
        }

        let transferredBytes = 0;
        if (response?.body && typeof response.body.getReader === 'function') {
          reader = response.body.getReader();
          while (transferredBytes === 0) {
            const { done, value } = await reader.read();
            if (value && value.byteLength > 0) {
              transferredBytes += value.byteLength;
              break;
            }
            if (done) {
              break;
            }
          }
          // Non-blocking cancel: if a proxy ignored Range and returned a 56MB HTTP 200 stream,
          // awaiting reader.cancel() on a stalled connection would hang the UI at 0% forever.
          const finishedReader = reader;
          reader = null;
          try {
            const cancelResult = finishedReader.cancel();
            if (cancelResult && typeof cancelResult.catch === 'function') {
              cancelResult.catch(() => {});
            }
          } catch (_) {
            // Ignore stream cancel errors
          }
          try {
            probeController.abort();
          } catch (_) {
            // Ignore
          }
        } else if (typeof response?.arrayBuffer === 'function') {
          const buf = await response.arrayBuffer();
          transferredBytes = buf ? buf.byteLength : 0;
        }

        if (transferredBytes <= 0) {
          throw new WebLLMError(
            `Connected to model CDN (${redirectedHost}, HTTP ${status}), but 0 bytes were received for ${modelLabel}. A firewall, proxy, or antivirus HTTPS scanner may be blocking binary weight streams from ${redirectedHost}. Disable stream filtering or switch networks, then click Retry.`,
            {
              code: WEBLLM_ERROR_CODES.DOWNLOAD_STALLED,
              httpCode: 504,
              timeout: true,
              retryable: true
            }
          );
        }

        return {
          ok: true,
          status,
          originHost,
          redirectedHost,
          acceptRanges: response?.headers?.get?.('accept-ranges') || null,
          transferredBytes
        };
      },
      boundedTimeoutMs,
      () => {
        timedOut = true;
        try {
          probeController.abort();
        } catch (_) {
          // Ignore
        }
        return new Error('CDN probe deadline exceeded');
      }
    );

    logWebLLMStage(
      'cdn_probe_ok',
      {
        originHost: probeResult.originHost,
        redirectedHost: probeResult.redirectedHost,
        status: probeResult.status,
        acceptRanges: probeResult.acceptRanges || 'none',
        transferredBytes: probeResult.transferredBytes
      },
      { startMs: probeStartMs }
    );

    return probeResult;
  } catch (err) {
    if (signal?.aborted) {
      throw createAbortError();
    }
    if (err instanceof WebLLMError) {
      logWebLLMStage(
        'cdn_probe_failed',
        {
          originHost,
          redirectedHost: safeExtractHostname(response?.url) || originHost,
          code: err.errorCode,
          httpCode: err.httpCode,
          message: err.message
        },
        { startMs: probeStartMs, level: 'warn' }
      );
      throw err;
    }

    const redirectedHost = safeExtractHostname(response?.url) || '';
    const hostSummary =
      redirectedHost && redirectedHost !== originHost
        ? `${originHost} → ${redirectedHost}`
        : `${originHost} / *.hf.co`;

    if (timedOut) {
      const elapsedLabel = formatDurationSeconds(boundedTimeoutMs);
      const stallMsg = response
        ? `Connected to model CDN (${redirectedHost || originHost}, HTTP ${response.status}), but the download stalled at 0 bytes for ${elapsedLabel} while preparing ${modelLabel}. Check whether your network, VPN, or antivirus HTTPS scanner blocks large binary streams from ${redirectedHost || '*.hf.co'}, then click Retry.`
        : `Timed out after ${elapsedLabel} trying to reach the model storage CDN (${hostSummary}) for ${modelLabel}. Check your internet connection or VPN/firewall rules for huggingface.co and *.hf.co, then click Retry.`;
      const stallErr = new WebLLMError(stallMsg, {
        code: response ? WEBLLM_ERROR_CODES.DOWNLOAD_STALLED : WEBLLM_ERROR_CODES.CDN_UNREACHABLE,
        httpCode: 504,
        timeout: true,
        retryable: true,
        cause: err
      });
      logWebLLMStage(
        'cdn_probe_timeout',
        {
          originHost,
          redirectedHost: redirectedHost || 'unresolved',
          status: response?.status ?? 'none',
          timeoutMs: boundedTimeoutMs,
          code: stallErr.errorCode
        },
        { startMs: probeStartMs, level: 'warn' }
      );
      throw stallErr;
    }

    const unreachableErr = new WebLLMError(
      !isClientOnline()
        ? `${modelLabel} requires an active internet connection for initial download. Reconnect to the internet and click Retry.`
        : `Unable to reach the model storage CDN (${hostSummary}) for ${modelLabel}. Verify your internet connection and ensure firewall, VPN, DNS, or browser privacy/ad-blocker extensions allow requests to huggingface.co, *.hf.co, and raw.githubusercontent.com, then click Retry.`,
      {
        code: !isClientOnline() ? WEBLLM_ERROR_CODES.OFFLINE_UNCACHED : WEBLLM_ERROR_CODES.CDN_UNREACHABLE,
        httpCode: 503,
        retryable: true,
        cause: err
      }
    );
    logWebLLMStage(
      'cdn_probe_failed',
      {
        originHost,
        redirectedHost: redirectedHost || 'unresolved',
        code: unreachableErr.errorCode,
        reason: String(err?.message || err || 'network_error').slice(0, 140)
      },
      { startMs: probeStartMs, level: 'warn' }
    );
    throw unreachableErr;
  } finally {
    if (signal && onCallerAbort) {
      signal.removeEventListener('abort', onCallerAbort);
    }
    if (reader) {
      try {
        const cancelResult = reader.cancel();
        if (cancelResult && typeof cancelResult.catch === 'function') {
          cancelResult.catch(() => {});
        }
      } catch (_) {
        // Ignore
      }
    }
    try {
      probeController.abort();
    } catch (_) {
      // Ignore
    }
  }
}

/**
 * Inspects a single Cache Storage entry and verifies its byte length when `expectedBytes` is known.
 * Automatically deletes any truncated or corrupted partial entry so retries self-heal cleanly.
 */
async function readVerifiedCachedEntry(cache, url, expectedBytes = null) {
  const cacheOpTimeoutMs = customDownloadConfig?.cacheOpTimeoutMs ?? DEFAULT_CACHE_OP_TIMEOUT_MS;
  const req = new Request(url);
  const match = await raceWithStageDeadline(
    () => cache.match(req),
    cacheOpTimeoutMs,
    (ms) =>
      new WebLLMError(
        `Browser Cache Storage stopped responding for ${formatDurationSeconds(ms)} while checking ${sanitizeUrlForDiagnostics(url)}. Close excess tabs or restart the browser, then click Retry.`,
        {
          code: WEBLLM_ERROR_CODES.DOWNLOAD_STALLED,
          httpCode: 504,
          timeout: true,
          retryable: true
        }
      )
  );
  if (!match) {
    return null;
  }

  let actualBytes = null;
  const headerLen = match.headers?.get?.('content-length');
  if (headerLen !== null && headerLen !== undefined && headerLen !== '') {
    const parsed = Number(headerLen);
    if (Number.isFinite(parsed) && parsed >= 0) {
      actualBytes = parsed;
    }
  }

  if (actualBytes === null && typeof match.clone === 'function') {
    try {
      const cloned = match.clone();
      if (typeof cloned.blob === 'function') {
        const b = await raceWithStageDeadline(
          () => cloned.blob(),
          cacheOpTimeoutMs,
          () => new Error('Cache blob read timed out')
        );
        actualBytes = b.size;
      } else if (typeof cloned.arrayBuffer === 'function') {
        const ab = await raceWithStageDeadline(
          () => cloned.arrayBuffer(),
          cacheOpTimeoutMs,
          () => new Error('Cache arrayBuffer read timed out')
        );
        actualBytes = ab.byteLength;
      }
    } catch (_) {
      actualBytes = null;
    }
  }

  if (expectedBytes !== null && expectedBytes > 0 && actualBytes !== null && actualBytes !== expectedBytes) {
    logWebLLMStage(
      'cache_entry_corrupt_removed',
      {
        artifact: sanitizeUrlForDiagnostics(url),
        actualBytes,
        expectedBytes
      },
      { level: 'warn' }
    );
    if (typeof cache.delete === 'function') {
      try {
        await raceWithStageDeadline(
          () => cache.delete(req),
          cacheOpTimeoutMs,
          () => new Error('Cache delete timed out')
        );
      } catch (_) {
        // Ignore cache delete failure
      }
    }
    return null;
  }

  return {
    response: match,
    byteLength: actualBytes ?? expectedBytes ?? 0
  };
}

/**
 * Streams a single model artifact with a resettable per-chunk inactivity watchdog (`stallTimeoutMs`),
 * verifies exact byte length when `expectedBytes` is known, and atomically writes the complete
 * response into Cache Storage ONLY after full verification.
 */
async function streamArtifactToCache({
  cache,
  url,
  artifactName,
  modelLabel,
  contentType = 'application/octet-stream',
  expectedBytes = null,
  stallTimeoutMs,
  signal,
  fetchImpl,
  onBytesProgress,
  returnArrayBuffer = false
}) {
  if (signal?.aborted) {
    throw createAbortError();
  }

  const artifactStartMs = Date.now();
  const effectiveFetch = getEffectiveFetch(fetchImpl);
  const originHost = safeExtractHostname(url) || 'huggingface.co';
  const streamController = new AbortController();
  let onCallerAbort = null;

  if (signal) {
    onCallerAbort = () => streamController.abort();
    if (signal.aborted) {
      throw createAbortError();
    }
    signal.addEventListener('abort', onCallerAbort, { once: true });
  }

  let response = null;
  let reader = null;
  let receivedBytes = 0;

  const watchdog = createResettableStallWatchdog(
    stallTimeoutMs,
    (ms) => new Error(`Artifact stream stalled after ${ms}ms`),
    () => {
      try {
        streamController.abort();
      } catch (_) {
        // Ignore
      }
    }
  );

  logWebLLMStage(
    'artifact_fetch_start',
    {
      artifact: artifactName,
      originHost,
      expectedBytes: expectedBytes ?? 'unknown',
      stallTimeoutMs
    },
    { startMs: artifactStartMs }
  );

  try {
    response = await watchdog.race(
      effectiveFetch(url, {
        method: 'GET',
        redirect: 'follow',
        cache: 'no-store',
        credentials: 'omit',
        mode: 'cors',
        signal: streamController.signal
      })
    );

    watchdog.touch();

    const redirectedHost = safeExtractHostname(response?.url) || originHost;
    const status = typeof response?.status === 'number' ? response.status : 0;

    if (status < 200 || status >= 300) {
      throw new WebLLMError(
        `Failed to download ${artifactName} for ${modelLabel}: ${redirectedHost} returned HTTP ${status}. Already downloaded shards remain cached — click Retry to resume.`,
        {
          code: status === 403 || status === 404 ? WEBLLM_ERROR_CODES.CDN_UNREACHABLE : WEBLLM_ERROR_CODES.DOWNLOAD_FAILED,
          httpCode: status >= 400 ? status : 503,
          retryable: status !== 404
        }
      );
    }

    const contentLengthHeader = response?.headers?.get?.('content-length');
    const declaredLength =
      contentLengthHeader !== null && contentLengthHeader !== undefined && contentLengthHeader !== ''
        ? Number(contentLengthHeader)
        : null;
    const totalExpected =
      expectedBytes !== null && expectedBytes > 0
        ? expectedBytes
        : Number.isFinite(declaredLength) && declaredLength > 0
          ? declaredLength
          : null;

    logWebLLMStage(
      'artifact_response_headers',
      {
        artifact: artifactName,
        status,
        redirectedHost,
        declaredBytes: totalExpected ?? 'unknown'
      },
      { startMs: artifactStartMs }
    );

    const chunks = [];
    let loggedFirstBytes = false;
    let nextMilestonePct = 25;

    if (response?.body && typeof response.body.getReader === 'function') {
      reader = response.body.getReader();
      while (true) {
        const { done, value } = await watchdog.race(reader.read());
        if (done) {
          break;
        }
        watchdog.touch();
        if (value && value.byteLength > 0) {
          const byteChunk =
            value instanceof Uint8Array
              ? value
              : new Uint8Array(value.buffer || value, value.byteOffset || 0, value.byteLength);
          chunks.push(byteChunk);
          receivedBytes += byteChunk.byteLength;

          if (!loggedFirstBytes) {
            loggedFirstBytes = true;
            logWebLLMStage(
              'artifact_first_bytes',
              {
                artifact: artifactName,
                redirectedHost,
                firstChunkBytes: byteChunk.byteLength,
                totalExpected: totalExpected ?? 'unknown'
              },
              { startMs: artifactStartMs }
            );
          } else if (totalExpected && totalExpected >= 1_048_576) {
            const pct = Math.floor((receivedBytes / totalExpected) * 100);
            if (pct >= nextMilestonePct && nextMilestonePct < 100) {
              logWebLLMStage(
                'artifact_bytes_milestone',
                {
                  artifact: artifactName,
                  pct,
                  receivedMB: formatMegabytes(receivedBytes),
                  expectedMB: formatMegabytes(totalExpected)
                },
                { startMs: artifactStartMs }
              );
              while (pct >= nextMilestonePct) {
                nextMilestonePct += 25;
              }
            }
          }

          if (typeof onBytesProgress === 'function') {
            onBytesProgress(receivedBytes, totalExpected);
          }
        }
      }
      reader = null;
    } else if (typeof response?.arrayBuffer === 'function') {
      const ab = await watchdog.race(response.arrayBuffer());
      watchdog.touch();
      const view = new Uint8Array(ab);
      if (view.byteLength > 0) {
        chunks.push(view);
        receivedBytes = view.byteLength;
        if (typeof onBytesProgress === 'function') {
          onBytesProgress(receivedBytes, totalExpected);
        }
      }
    }

    if (expectedBytes !== null && expectedBytes > 0 && receivedBytes !== expectedBytes) {
      throw new WebLLMError(
        `Incomplete download for ${artifactName} from ${redirectedHost} (received ${formatMegabytes(receivedBytes)} MB of expected ${formatMegabytes(expectedBytes)} MB). Partial data was discarded; click Retry to resume.`,
        {
          code: WEBLLM_ERROR_CODES.DOWNLOAD_FAILED,
          httpCode: 502,
          retryable: true
        }
      );
    }

    if (receivedBytes === 0 && (expectedBytes === null || expectedBytes > 0)) {
      throw new WebLLMError(
        `Empty response received for ${artifactName} from ${redirectedHost}. Click Retry to attempt the download again.`,
        {
          code: WEBLLM_ERROR_CODES.DOWNLOAD_FAILED,
          httpCode: 502,
          retryable: true
        }
      );
    }

    const bodyBlob = new Blob(chunks, { type: contentType });
    const cacheResponse = new Response(bodyBlob, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(receivedBytes)
      }
    });

    watchdog.touch();
    await watchdog.race(cache.put(new Request(url), cacheResponse));

    let arrayBufferResult = null;
    if (returnArrayBuffer) {
      arrayBufferResult = await bodyBlob.arrayBuffer();
    }
    chunks.length = 0;

    logWebLLMStage(
      'artifact_cached',
      {
        artifact: artifactName,
        redirectedHost,
        verifiedBytes: receivedBytes,
        verifiedMB: formatMegabytes(receivedBytes)
      },
      { startMs: artifactStartMs }
    );

    return {
      byteLength: receivedBytes,
      redirectedHost,
      arrayBuffer: arrayBufferResult
    };
  } catch (err) {
    if (signal?.aborted) {
      throw createAbortError();
    }
    if (err instanceof WebLLMError) {
      logWebLLMStage(
        'artifact_error',
        {
          artifact: artifactName,
          code: err.errorCode,
          receivedBytes,
          message: err.message
        },
        { startMs: artifactStartMs, level: 'warn' }
      );
      throw err;
    }

    const redirectedHost = safeExtractHostname(response?.url) || originHost;
    if (watchdog.hasStalled()) {
      const stallError = new WebLLMError(
        `Download of ${artifactName} for ${modelLabel} stalled on ${redirectedHost} (${formatMegabytes(receivedBytes)}${expectedBytes ? ` / ${formatMegabytes(expectedBytes)}` : ''} MB transferred; no bytes received for ${formatDurationSeconds(stallTimeoutMs)}). Completed shards were saved in browser cache — click Retry to resume.`,
        {
          code: WEBLLM_ERROR_CODES.DOWNLOAD_STALLED,
          httpCode: 504,
          timeout: true,
          retryable: true,
          cause: err
        }
      );
      logWebLLMStage(
        'artifact_stalled',
        {
          artifact: artifactName,
          redirectedHost,
          receivedBytes,
          expectedBytes: expectedBytes ?? 'unknown',
          stallTimeoutMs
        },
        { startMs: artifactStartMs, level: 'warn' }
      );
      throw stallError;
    }

    const dlError = new WebLLMError(
      !isClientOnline()
        ? `Internet connection was lost while downloading ${artifactName} for ${modelLabel}. Reconnect and click Retry — completed shards will resume automatically.`
        : `Network error while downloading ${artifactName} from ${redirectedHost} for ${modelLabel}. Check your connection or firewall/VPN settings for ${redirectedHost} and click Retry — completed shards will resume automatically.`,
      {
        code: !isClientOnline() ? WEBLLM_ERROR_CODES.OFFLINE_UNCACHED : WEBLLM_ERROR_CODES.DOWNLOAD_FAILED,
        httpCode: 503,
        retryable: true,
        cause: err
      }
    );
    logWebLLMStage(
      'artifact_error',
      {
        artifact: artifactName,
        redirectedHost,
        code: dlError.errorCode,
        receivedBytes,
        reason: String(err?.message || err || 'network_error').slice(0, 140)
      },
      { startMs: artifactStartMs, level: 'warn' }
    );
    throw dlError;
  } finally {
    watchdog.dispose();
    if (signal && onCallerAbort) {
      signal.removeEventListener('abort', onCallerAbort);
    }
    if (reader) {
      try {
        const cancelResult = reader.cancel();
        if (cancelResult && typeof cancelResult.catch === 'function') {
          cancelResult.catch(() => {});
        }
      } catch (_) {
        // Ignore
      }
    }
    try {
      streamController.abort();
    } catch (_) {
      // Ignore
    }
  }
}

/**
 * Downloads and verifies all WebLLM model artifacts (`webllm/config`, `webllm/wasm`, `webllm/model`)
 * into browser Cache Storage with:
 * - Bounded CDN reachability & byte-transfer diagnostic probe on the first uncached weight shard
 * - Real-time streaming byte progress callbacks (`1%` -> `99%`) so UI never freezes at `0%`
 * - Controlled 2-stream shard concurrency to prevent 4-way 155MB TCP congestion
 * - Per-chunk stall watchdog so `HTTP 200 Pending` hangs abort cleanly with actionable error messages
 * - Byte-verified atomic `cache.put()` so partial shards never corrupt Cache Storage and Retry resumes
 *   from already-cached shards
 */
export async function downloadModelArtifactsToCache(modelRecord, options = {}) {
  const {
    modelId = modelRecord?.model_id || DEFAULT_WEBLLM_MODEL_ID,
    catalogEntry = WEBLLM_MODEL_CATALOG[modelId] || null,
    signal,
    onProgress,
    fetchImpl,
    probeTimeoutMs = customDownloadConfig?.probeTimeoutMs ?? DEFAULT_CDN_PROBE_TIMEOUT_MS,
    stallTimeoutMs = customDownloadConfig?.stallTimeoutMs ?? DEFAULT_SHARD_STALL_TIMEOUT_MS,
    concurrency = customDownloadConfig?.concurrency ?? DEFAULT_SHARD_CONCURRENCY
  } = options;

  if (signal?.aborted) {
    throw createAbortError();
  }

  const shortLabel = catalogEntry?.shortLabel || modelId;
  const fullLabel = catalogEntry?.label || shortLabel;
  const startMs = Date.now();
  const modelBaseUrl = normalizeModelBaseUrl(modelRecord.model);
  const cacheOpTimeoutMs = customDownloadConfig?.cacheOpTimeoutMs ?? DEFAULT_CACHE_OP_TIMEOUT_MS;

  const openScopedCache = (scopeName) =>
    raceWithStageDeadline(
      () => caches.open(scopeName),
      cacheOpTimeoutMs,
      (ms) =>
        new WebLLMError(
          `Browser Cache Storage (${scopeName}) did not respond within ${formatDurationSeconds(ms)}. Ensure site data/cookies are enabled and not blocked in private browsing, then click Retry.`,
          {
            code: WEBLLM_ERROR_CODES.DOWNLOAD_STALLED,
            httpCode: 504,
            timeout: true,
            retryable: true
          }
        )
    );

  const [configCache, wasmCache, modelCache] = await Promise.all([
    openScopedCache('webllm/config'),
    openScopedCache('webllm/wasm'),
    openScopedCache('webllm/model')
  ]);

  logWebLLMStage('caches_opened', { modelId, scopes: 3 }, { startMs });

  let lastEmitMs = 0;
  let lastLoggedPctBucket = -1;
  const emitDownloadProgress = ({ progress, progressPercent, progressText, force = false }) => {
    const now = Date.now();
    if (!force && now - lastEmitMs < 90) {
      return;
    }
    lastEmitMs = now;
    if (typeof progressPercent === 'number') {
      const bucket = Math.floor(progressPercent / 10) * 10;
      if (bucket > lastLoggedPctBucket) {
        lastLoggedPctBucket = bucket;
        logWebLLMStage(
          'download_progress_ui',
          {
            modelId,
            progressPercent,
            progressText
          },
          { startMs }
        );
      }
    }
    if (typeof onProgress === 'function') {
      try {
        onProgress({
          status: 'downloading',
          modelId,
          progress,
          progressPercent,
          progressText,
          timeElapsed: Math.max(0, (now - startMs) / 1000),
          isCached: false
        });
      } catch (_) {
        // Never allow listener exceptions to interrupt downloads
      }
    }
  };

  emitDownloadProgress({
    progress: 0,
    progressPercent: 0,
    progressText: `Checking model metadata for ${shortLabel}...`,
    force: true
  });

  // 1. Ensure mlc-chat-config.json in webllm/config
  const chatConfigUrl = new URL('mlc-chat-config.json', modelBaseUrl).href;
  let chatConfigObj = null;
  let configSource = 'cache';
  const existingConfig = await readVerifiedCachedEntry(configCache, chatConfigUrl, null);
  if (existingConfig?.response && typeof existingConfig.response.clone === 'function') {
    try {
      chatConfigObj = await existingConfig.response.clone().json();
    } catch (_) {
      chatConfigObj = null;
    }
  }
  if (!chatConfigObj) {
    configSource = 'network';
    const dlConfig = await streamArtifactToCache({
      cache: configCache,
      url: chatConfigUrl,
      artifactName: 'mlc-chat-config.json',
      modelLabel: fullLabel,
      contentType: 'application/json',
      expectedBytes: null,
      stallTimeoutMs,
      signal,
      fetchImpl,
      returnArrayBuffer: true
    });
    chatConfigObj = JSON.parse(new TextDecoder().decode(dlConfig.arrayBuffer));
  }
  logWebLLMStage('metadata_config_ready', { modelId, source: configSource }, { startMs });

  // 2. Ensure tensor-cache.json in webllm/model
  const tensorCacheUrl = new URL('tensor-cache.json', modelBaseUrl).href;
  let tensorManifest = null;
  let manifestSource = 'cache';
  const existingManifest = await readVerifiedCachedEntry(modelCache, tensorCacheUrl, null);
  if (existingManifest?.response && typeof existingManifest.response.clone === 'function') {
    try {
      tensorManifest = await existingManifest.response.clone().json();
    } catch (_) {
      tensorManifest = null;
    }
  }
  if (!tensorManifest) {
    manifestSource = 'network';
    emitDownloadProgress({
      progress: 0,
      progressPercent: 0,
      progressText: `Fetching shard manifest for ${shortLabel}...`,
      force: true
    });
    const dlManifest = await streamArtifactToCache({
      cache: modelCache,
      url: tensorCacheUrl,
      artifactName: 'tensor-cache.json',
      modelLabel: fullLabel,
      contentType: 'application/json',
      expectedBytes: null,
      stallTimeoutMs,
      signal,
      fetchImpl,
      returnArrayBuffer: true
    });
    tensorManifest = JSON.parse(new TextDecoder().decode(dlManifest.arrayBuffer));
  }

  const shardRecords = Array.isArray(tensorManifest?.records) ? tensorManifest.records : [];
  const shardItems = [];
  const seenShardUrls = new Set();

  for (let i = 0; i < shardRecords.length; i++) {
    const rec = shardRecords[i];
    if (!rec || !rec.dataPath) continue;
    const shardUrl = new URL(rec.dataPath, modelBaseUrl).href;
    if (seenShardUrls.has(shardUrl)) continue;
    seenShardUrls.add(shardUrl);
    const expectedBytes =
      typeof rec.nbytes === 'number' && Number.isFinite(rec.nbytes) && rec.nbytes > 0
        ? rec.nbytes
        : null;
    shardItems.push({
      index: shardItems.length + 1,
      name: String(rec.dataPath),
      url: shardUrl,
      expectedBytes
    });
  }

  // 3. Inspect which shards are already complete & byte-verified in Cache Storage
  let completedBytes = 0;
  let totalExpectedBytes = 0;
  const missingShards = [];

  for (const shard of shardItems) {
    const shardExpected = shard.expectedBytes || 0;
    totalExpectedBytes += shardExpected;
    const cachedShard = await readVerifiedCachedEntry(modelCache, shard.url, shard.expectedBytes);
    if (cachedShard) {
      completedBytes += cachedShard.byteLength || shardExpected;
    } else {
      missingShards.push(shard);
    }
  }

  logWebLLMStage(
    'metadata_manifest_ready',
    {
      modelId,
      source: manifestSource,
      shardCount: shardItems.length,
      totalMB: formatMegabytes(totalExpectedBytes)
    },
    { startMs }
  );

  // Check tokenizer & WASM status as well
  const tokenizerFiles = Array.isArray(chatConfigObj?.tokenizer_files) ? chatConfigObj.tokenizer_files : [];
  const requiredTokenizerName = tokenizerFiles.includes('tokenizer.json')
    ? 'tokenizer.json'
    : tokenizerFiles.includes('tokenizer.model')
      ? 'tokenizer.model'
      : null;
  const tokenizerUrl = requiredTokenizerName ? new URL(requiredTokenizerName, modelBaseUrl).href : null;
  const cachedTokenizer = tokenizerUrl ? await readVerifiedCachedEntry(modelCache, tokenizerUrl, null) : null;

  const wasmUrl =
    modelRecord.model_lib &&
    modelRecord.model_lib.startsWith('http') &&
    !modelRecord.model_lib.includes('localhost')
      ? modelRecord.model_lib
      : null;
  const cachedWasm = wasmUrl ? await readVerifiedCachedEntry(wasmCache, wasmUrl, null) : null;

  logWebLLMStage(
    'cache_inventory',
    {
      modelId,
      cachedShards: shardItems.length - missingShards.length,
      missingShards: missingShards.length,
      cachedTokenizer: Boolean(cachedTokenizer),
      cachedWasm: Boolean(cachedWasm)
    },
    { startMs }
  );

  const estimatedFallbackTotal = (catalogEntry?.estimatedDownloadMB || 270) * 1024 * 1024;
  const progressDenominator = Math.max(totalExpectedBytes || estimatedFallbackTotal, 1);

  // 4. Bounded CDN reachability & byte-transfer diagnostic probe BEFORE downloading large weight shards
  let verifiedCdnHost = null;
  if (missingShards.length > 0) {
    emitDownloadProgress({
      progress: 0,
      progressPercent: 0,
      progressText: `Verifying model CDN reachability for ${shortLabel}...`,
      force: true
    });

    const probe = await probeWebLLMModelCDN(missingShards[0].url, {
      modelLabel: fullLabel,
      signal,
      timeoutMs: probeTimeoutMs,
      fetchImpl
    });
    verifiedCdnHost = probe.redirectedHost;

    const initialRatio = Math.min(0.99, Math.max(0.01, completedBytes / progressDenominator));
    const initialPct = Math.min(99, Math.max(1, Math.round(initialRatio * 100)));
    emitDownloadProgress({
      progress: initialRatio,
      progressPercent: initialPct,
      progressText:
        completedBytes > 0
          ? `Resuming ${shortLabel} from ${verifiedCdnHost}: ${formatMegabytes(completedBytes)} / ${formatMegabytes(progressDenominator)} MB cached (${missingShards.length}/${shardItems.length} shards remaining)...`
          : `Connected to ${verifiedCdnHost} — downloading ${shortLabel} (0.0 / ${formatMegabytes(progressDenominator)} MB)...`,
      force: true
    });
  }

  // 5. Ensure tokenizer & WASM runtime library are cached before GPU reload
  if (tokenizerUrl && !cachedTokenizer) {
    const baseRatio = Math.min(0.99, Math.max(0.01, completedBytes / progressDenominator));
    const basePct = Math.min(99, Math.max(1, Math.round(baseRatio * 100)));
    emitDownloadProgress({
      progress: baseRatio,
      progressPercent: basePct,
      progressText: `Downloading ${requiredTokenizerName} for ${shortLabel}...`,
      force: true
    });
    await streamArtifactToCache({
      cache: modelCache,
      url: tokenizerUrl,
      artifactName: requiredTokenizerName,
      modelLabel: fullLabel,
      contentType: requiredTokenizerName.endsWith('.json') ? 'application/json' : 'application/octet-stream',
      expectedBytes: null,
      stallTimeoutMs,
      signal,
      fetchImpl,
      onBytesProgress: (bytesSoFar, totalTok) => {
        emitDownloadProgress({
          progress: baseRatio,
          progressPercent: basePct,
          progressText: `Downloading ${requiredTokenizerName} for ${shortLabel} (${formatMegabytes(bytesSoFar)}${totalTok ? ` / ${formatMegabytes(totalTok)}` : ''} MB)...`,
          force: false
        });
      }
    });
  }

  if (wasmUrl && !cachedWasm) {
    const baseRatio = Math.min(0.99, Math.max(0.01, completedBytes / progressDenominator));
    const basePct = Math.min(99, Math.max(1, Math.round(baseRatio * 100)));
    emitDownloadProgress({
      progress: baseRatio,
      progressPercent: basePct,
      progressText: `Downloading WebGPU runtime library for ${shortLabel}...`,
      force: true
    });
    await streamArtifactToCache({
      cache: wasmCache,
      url: wasmUrl,
      artifactName: 'WebGPU model WASM library',
      modelLabel: fullLabel,
      contentType: 'application/wasm',
      expectedBytes: null,
      stallTimeoutMs,
      signal,
      fetchImpl,
      onBytesProgress: (bytesSoFar, totalWasm) => {
        emitDownloadProgress({
          progress: baseRatio,
          progressPercent: basePct,
          progressText: `Downloading WebGPU runtime library for ${shortLabel} (${formatMegabytes(bytesSoFar)}${totalWasm ? ` / ${formatMegabytes(totalWasm)}` : ''} MB)...`,
          force: false
        });
      }
    });
  }

  // 6. Stream missing weight shards with controlled concurrency and per-chunk stall watchdog
  if (missingShards.length > 0) {
    const batchController = new AbortController();
    const onParentAbort = () => batchController.abort();
    if (signal) {
      if (signal.aborted) {
        throw createAbortError();
      }
      signal.addEventListener('abort', onParentAbort, { once: true });
    }

    const inFlightBytes = new Map();
    let completedShardCount = shardItems.length - missingShards.length;
    let queueCursor = 0;

    const reportAggregatedShardProgress = (activeShard, force = false) => {
      let currentInFlight = 0;
      for (const b of inFlightBytes.values()) {
        currentInFlight += b;
      }
      const currentTotal = Math.min(progressDenominator, completedBytes + currentInFlight);
      const ratio = Math.min(0.99, Math.max(0.01, currentTotal / progressDenominator));
      const pct = Math.min(99, Math.max(1, Math.round(ratio * 100)));
      const shardCounter = Math.min(shardItems.length, completedShardCount + 1);
      emitDownloadProgress({
        progress: ratio,
        progressPercent: pct,
        progressText: `Downloading ${shortLabel}: ${formatMegabytes(currentTotal)} / ${formatMegabytes(progressDenominator)} MB (${pct}%) — shard ${shardCounter}/${shardItems.length}`,
        force
      });
    };

    const workerCount = Math.max(1, Math.min(concurrency, missingShards.length));
    try {
      const workers = Array.from({ length: workerCount }, async () => {
        while (queueCursor < missingShards.length) {
          if (batchController.signal.aborted) {
            break;
          }
          const shard = missingShards[queueCursor++];
          inFlightBytes.set(shard.url, 0);

          try {
            const result = await streamArtifactToCache({
              cache: modelCache,
              url: shard.url,
              artifactName: shard.name,
              modelLabel: fullLabel,
              contentType: 'application/octet-stream',
              expectedBytes: shard.expectedBytes,
              stallTimeoutMs,
              signal: batchController.signal,
              fetchImpl,
              onBytesProgress: (bytesSoFar) => {
                inFlightBytes.set(shard.url, bytesSoFar);
                reportAggregatedShardProgress(shard, false);
              }
            });

            inFlightBytes.delete(shard.url);
            completedBytes += result.byteLength;
            completedShardCount += 1;
            reportAggregatedShardProgress(shard, true);
          } catch (shardErr) {
            inFlightBytes.delete(shard.url);
            // Abort sibling shard streams immediately on first failure so no zombie requests linger
            batchController.abort();
            throw shardErr;
          }
        }
      });

      await Promise.all(workers);
    } finally {
      if (signal) {
        signal.removeEventListener('abort', onParentAbort);
      }
    }
  }

  logWebLLMStage(
    'artifacts_all_verified',
    {
      modelId,
      shardCount: shardItems.length,
      downloadedShards: missingShards.length,
      totalMB: formatMegabytes(totalExpectedBytes),
      cdnHost: verifiedCdnHost || 'local-cache'
    },
    { startMs }
  );

  return {
    modelId,
    shardCount: shardItems.length,
    downloadedShards: missingShards.length,
    totalBytes: totalExpectedBytes,
    cdnHost: verifiedCdnHost
  };
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

export function normalizeWebLLMError(rawErr, { modelId = DEFAULT_WEBLLM_MODEL_ID, phase = 'generate', wasCached = false } = {}) {
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
    lower.includes('adapter') ||
    lower.includes('requestdevice') ||
    lower.includes('failed to request device') ||
    lower.includes('device acquisition') ||
    lower.includes('no compatible webgpu graphics adapter')
  ) {
    return new WebLLMError(
      'No compatible WebGPU graphics adapter was found or device acquisition failed. Please ensure hardware acceleration is enabled in your browser settings and GPU drivers are up to date.',
      {
        code: WEBLLM_ERROR_CODES.WEBGPU_ADAPTER_UNAVAILABLE,
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
    lower.includes('modelnotfounderror') ||
    lower.includes('cannot find model record') ||
    lower.includes('unsupported model') ||
    lower.includes('not supported') ||
    lower.includes('unsupported browser ai model') ||
    lower.includes('not in the supported browser ai')
  ) {
    return new WebLLMError(
      `Unsupported Browser AI model "${modelId}". Please select a supported Browser AI model.`,
      {
        code: WEBLLM_ERROR_CODES.UNSUPPORTED_MODEL,
        httpCode: 400,
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

  if (
    lower.includes('worker crashed') ||
    lower.includes('worker error') ||
    lower.includes('webllm_worker_crashed') ||
    lower.includes('communication with the browser ai worker failed')
  ) {
    return new WebLLMError(
      'The dedicated Browser AI worker encountered an unexpected error. Please retry to restart the engine.',
      {
        code: WEBLLM_ERROR_CODES.WORKER_CRASHED,
        httpCode: 500,
        retryable: true,
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

  if (activeInitAbortController) {
    try {
      activeInitAbortController.abort();
    } catch (_) {
      // Ignore
    }
    activeInitAbortController = null;
  }

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
    loadedModelId: null,
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

  const entryStartMs = Date.now();

  if (signal?.aborted) {
    throw createAbortError();
  }

  const hasSwController = Boolean(
    typeof navigator !== 'undefined' && navigator?.serviceWorker?.controller
  );

  logWebLLMStage(
    'init_entry',
    {
      requestedModelId: requestedModelId || DEFAULT_WEBLLM_MODEL_ID,
      online: isClientOnline(),
      swControlled: hasSwController
    },
    { startMs: entryStartMs }
  );

  // Validate model identifier compatibility against supported registry
  if (requestedModelId && typeof requestedModelId === 'string' && requestedModelId.trim()) {
    const trimmedCandidate = requestedModelId.trim();
    const compat = checkModelCompatibilityForProvider('webllm', trimmedCandidate);
    if (!compat.compatible) {
      const unsuppErr = new WebLLMError(
        compat.reason || `Unsupported Browser AI model "${trimmedCandidate}". Please select a supported Browser AI model.`,
        {
          code: WEBLLM_ERROR_CODES.UNSUPPORTED_MODEL,
          httpCode: 400,
          retryable: false
        }
      );
      updateEngineState({
        status: 'error',
        modelId: trimmedCandidate,
        error: unsuppErr.message
      });
      logWebLLMStage(
        'init_error',
        { modelId: trimmedCandidate, code: unsuppErr.errorCode, message: unsuppErr.message },
        { startMs: entryStartMs, level: 'warn' }
      );
      throw unsuppErr;
    }
  }

  // 1. Check WebGPU compatibility before loading the heavy @mlc-ai/web-llm chunk
  updateEngineState({
    status: 'checking',
    error: null
  });

  logWebLLMStage('gpu_check_start', { requestedModelId }, { startMs: entryStartMs });
  const gpuSupport = await checkWebGPUSupport();
  logWebLLMStage(
    'gpu_check_done',
    {
      supported: gpuSupport.supported,
      hasShaderF16: gpuSupport.hasShaderF16,
      reasonCode: gpuSupport.reasonCode || 'ok'
    },
    { startMs: entryStartMs }
  );

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
    logWebLLMStage(
      'init_error',
      { code: gpuError.errorCode, message: gpuError.message },
      { startMs: entryStartMs, level: 'warn' }
    );
    throw gpuError;
  }

  const resolvedModelId = resolveWebLLMModelId(requestedModelId, {
    hasShaderF16: gpuSupport.hasShaderF16,
    allowF32Fallback
  });

  const catalogEntry = WEBLLM_MODEL_CATALOG[resolvedModelId];
  if (!catalogEntry) {
    const unsuppErr = new WebLLMError(
      `Unsupported Browser AI model "${requestedModelId || resolvedModelId}". Please select a supported Browser AI model.`,
      {
        code: WEBLLM_ERROR_CODES.UNSUPPORTED_MODEL,
        httpCode: 400,
        retryable: false
      }
    );
    updateEngineState({
      status: 'error',
      modelId: resolvedModelId,
      error: unsuppErr.message
    });
    logWebLLMStage(
      'init_error',
      { modelId: resolvedModelId, code: unsuppErr.errorCode, message: unsuppErr.message },
      { startMs: entryStartMs, level: 'warn' }
    );
    throw unsuppErr;
  }

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
    logWebLLMStage(
      'init_error',
      { modelId: resolvedModelId, code: f16Err.errorCode, message: f16Err.message },
      { startMs: entryStartMs, level: 'warn' }
    );
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
    logWebLLMStage('init_fast_path_ready', { modelId: resolvedModelId }, { startMs: entryStartMs });
    return {
      engine: engineInstance,
      modelId: resolvedModelId,
      isCached: true
    };
  }

  // Deduplicate concurrent initialization requests for the same model
  if (activeInitPromise && activeInitModelId === resolvedModelId) {
    logWebLLMStage('init_deduped', { modelId: resolvedModelId }, { startMs: entryStartMs });
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
      if (!signal) {
        return await activeInitPromise;
      }
      return await Promise.race([
        activeInitPromise,
        new Promise((_, reject) => {
          if (signal.aborted) {
            reject(createAbortError());
            return;
          }
          signal.addEventListener('abort', () => reject(createAbortError()), { once: true });
        })
      ]);
    } finally {
      if (unsub) unsub();
    }
  }

  // If another model was previously initializing, abort it immediately before loading the new model
  if (activeInitPromise && activeInitModelId !== resolvedModelId) {
    if (activeInitAbortController) {
      try {
        activeInitAbortController.abort();
      } catch (_) {
        // Ignore
      }
      activeInitAbortController = null;
    }
    if (activeInitAbortReject) {
      const rejectPrior = activeInitAbortReject;
      activeInitAbortReject = null;
      terminateWorkerImmediate();
      rejectPrior(createAbortError('Model initialization cancelled (switched model).'));
    }
    try {
      await activeInitPromise;
    } catch (_) {
      // Ignore prior init error
    }
  }
  if (engineInstance && loadedModelId && loadedModelId !== resolvedModelId) {
    await destroyWebLLMEngine();
  }

  // Re-verify single-initialization invariant after any async teardown above
  if (activeInitPromise && activeInitModelId === resolvedModelId) {
    return await activeInitPromise;
  }

  const initController = new AbortController();
  activeInitAbortController = initController;
  activeInitModelId = resolvedModelId;
  activeInitPromise = (async () => {
    const initStartMs = entryStartMs;
    let wasCachedBeforeInit = false;
    let hasVerifiedLocalCache = false;
    let removeAbortListener = null;
    let clearWorkerWatchdog = null;
    let detachWorkerDiagListener = null;

    try {
      if (signal?.aborted || initController.signal.aborted) {
        throw createAbortError();
      }

      if (signal) {
        const forwardCallerAbort = () => {
          initController.abort();
          if (activeInitAbortReject) {
            const rejectFn = activeInitAbortReject;
            activeInitAbortReject = null;
            terminateWorkerImmediate();
            rejectFn(createAbortError('Model initialization cancelled by user.'));
          }
        };
        if (signal.aborted) {
          forwardCallerAbort();
          throw createAbortError();
        }
        signal.addEventListener('abort', forwardCallerAbort, { once: true });
        removeAbortListener = () => signal.removeEventListener('abort', forwardCallerAbort);
      }

      logWebLLMStage('init_pipeline_start', { modelId: resolvedModelId }, { startMs: initStartMs });

      // 2. Lazily import @mlc-ai/web-llm runtime
      const webllm = await loadWebLLMModule(initStartMs);

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
      logWebLLMStage('cache_check_start', { modelId: resolvedModelId }, { startMs: initStartMs });
      wasCachedBeforeInit = await isWebLLMModelCached(resolvedModelId);
      hasVerifiedLocalCache = wasCachedBeforeInit;
      logWebLLMStage(
        'cache_check_done',
        { modelId: resolvedModelId, wasCachedBeforeInit },
        { startMs: initStartMs }
      );

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
        : `Preparing ${catalogEntry?.shortLabel || resolvedModelId} download...`;

      updateEngineState({
        status: initialStatus,
        modelId: resolvedModelId,
        loadedModelId: null,
        progress: 0,
        progressPercent: wasCachedBeforeInit ? null : 0,
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
          progressPercent: wasCachedBeforeInit ? null : 0,
          progressText: initialText,
          timeElapsed: 0,
          isCached: wasCachedBeforeInit
        });
      }

      // 4. Pre-download & byte-verify uncached model artifacts with bounded CDN probe,
      //    streaming byte progress, and per-chunk stall protection (runs in real browsers and
      //    when customFetchFactory is injected for download pipeline tests).
      const shouldRunStreamingPreDownload =
        !wasCachedBeforeInit &&
        typeof caches !== 'undefined' &&
        (typeof customEngineFactory !== 'function' || typeof customFetchFactory === 'function');

      if (shouldRunStreamingPreDownload) {
        await downloadModelArtifactsToCache(modelRecord, {
          modelId: resolvedModelId,
          catalogEntry,
          signal: initController.signal,
          onProgress: (dlReport) => {
            updateEngineState({
              status: 'downloading',
              modelId: resolvedModelId,
              loadedModelId: null,
              progress: dlReport.progress,
              progressPercent: dlReport.progressPercent,
              progressText: dlReport.progressText,
              timeElapsed: dlReport.timeElapsed,
              isCached: false
            });
            if (typeof onProgress === 'function') {
              try {
                onProgress(dlReport);
              } catch (_) {
                // Ignore callback error
              }
            }
          }
        });

        hasVerifiedLocalCache = true;
        const gpuStageText = `Download complete — loading ${catalogEntry?.shortLabel || resolvedModelId} into GPU memory...`;
        // Use indeterminate progressPercent (null) rather than resetting back to 0% while
        // the dedicated worker boots, compiles WASM, and loads cached shards into GPU VRAM.
        updateEngineState({
          status: 'loading',
          modelId: resolvedModelId,
          loadedModelId: null,
          progress: 0,
          progressPercent: null,
          progressText: gpuStageText,
          isCached: true
        });
        if (typeof onProgress === 'function') {
          try {
            onProgress({
              status: 'loading',
              modelId: resolvedModelId,
              progress: 0,
              progressPercent: null,
              progressText: gpuStageText,
              timeElapsed: engineState.timeElapsed || 0,
              isCached: true
            });
          } catch (_) {
            // Ignore callback error
          }
        }
      }

      if (signal?.aborted || initController.signal.aborted) {
        throw createAbortError();
      }

      // 5. Spawn dedicated ES module Web Worker
      terminateWorkerImmediate();
      logWebLLMStage(
        'worker_spawn',
        { modelId: resolvedModelId, hasVerifiedLocalCache },
        { startMs: initStartMs }
      );
      const worker = typeof customWorkerFactory === 'function'
        ? customWorkerFactory()
        : new Worker(new URL('../workers/webllmWorker.js', import.meta.url), {
            type: 'module',
            name: 'orvix-webllm-worker'
          });
      workerInstance = worker;

      const workerStallTimeoutMs =
        customDownloadConfig?.workerStallTimeoutMs ?? DEFAULT_WORKER_INIT_STALL_TIMEOUT_MS;
      let resetWorkerWatchdog = () => {};

      const workerCrashPromise = new Promise((_, reject) => {
        activeInitAbortReject = reject;

        let watchdogTimer = null;
        resetWorkerWatchdog = () => {
          if (watchdogTimer) {
            clearTimeout(watchdogTimer);
          }
          watchdogTimer = setTimeout(() => {
            logWebLLMStage(
              'init_timeout',
              {
                subStage: 'worker_gpu_init',
                modelId: resolvedModelId,
                timeoutMs: workerStallTimeoutMs,
                hasVerifiedLocalCache
              },
              { startMs: initStartMs, level: 'warn' }
            );
            terminateWorkerImmediate();
            reject(
              new WebLLMError(
                `Timed out waiting for Browser AI (${catalogEntry?.label || resolvedModelId}) to initialize in WebGPU after ${formatDurationSeconds(workerStallTimeoutMs)} of inactivity. Close other GPU-heavy tabs or click Retry.`,
                {
                  code: hasVerifiedLocalCache
                    ? WEBLLM_ERROR_CODES.INIT_FAILED
                    : WEBLLM_ERROR_CODES.DOWNLOAD_STALLED,
                  httpCode: 504,
                  timeout: true,
                  retryable: true
                }
              )
            );
          }, Math.max(50, workerStallTimeoutMs));
        };
        clearWorkerWatchdog = () => {
          if (watchdogTimer) {
            clearTimeout(watchdogTimer);
            watchdogTimer = null;
          }
        };
        resetWorkerWatchdog();

        worker.onerror = (event) => {
          clearWorkerWatchdog?.();
          const detail = event?.message || 'Dedicated WebLLM worker encountered an unexpected fatal error.';
          logWebLLMStage(
            'worker_error',
            { modelId: resolvedModelId, detail },
            { startMs: initStartMs, level: 'error' }
          );
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
          clearWorkerWatchdog?.();
          logWebLLMStage(
            'worker_message_error',
            { modelId: resolvedModelId },
            { startMs: initStartMs, level: 'error' }
          );
          terminateWorkerImmediate();
          reject(
            new WebLLMError('Communication with the Browser AI worker failed.', {
              code: WEBLLM_ERROR_CODES.WORKER_CRASHED,
              httpCode: 500,
              retryable: true
            })
          );
        };

        const onInitAbort = () => {
          clearWorkerWatchdog?.();
          terminateWorkerImmediate();
          reject(createAbortError('Model initialization cancelled by user.'));
        };
        if (initController.signal.aborted) {
          onInitAbort();
          return;
        }
        initController.signal.addEventListener('abort', onInitAbort, { once: true });
      });

      // Attach non-intrusive addEventListener('message') during initialization so WebLLM's own
      // `worker.onmessage = ...` assignment in WebWorkerMLCEngine remains untouched while we record
      // safe RPC lifecycle events (never logging user prompt/chat content).
      if (typeof worker.addEventListener === 'function' && typeof worker.removeEventListener === 'function') {
        let seenInitProgressMessages = 0;
        const onWorkerInitMessage = (event) => {
          resetWorkerWatchdog();
          const kind = typeof event?.data?.kind === 'string' ? event.data.kind : 'unknown';
          if (kind === 'initProgressCallback') {
            seenInitProgressMessages += 1;
            if (seenInitProgressMessages === 1) {
              logWebLLMStage(
                'worker_first_message',
                { modelId: resolvedModelId, kind },
                { startMs: initStartMs }
              );
            }
          } else if (kind === 'return' || kind === 'throw') {
            logWebLLMStage(
              'worker_rpc_settlement',
              { modelId: resolvedModelId, kind },
              { startMs: initStartMs, level: kind === 'throw' ? 'warn' : 'log' }
            );
          }
        };
        worker.addEventListener('message', onWorkerInitMessage);
        detachWorkerDiagListener = () => {
          try {
            worker.removeEventListener('message', onWorkerInitMessage);
          } catch (_) {
            // Ignore
          }
        };
      }

      let lastLoggedWorkerBucket = -1;
      let lastLoggedWorkerPhase = '';
      const handleInitProgress = (report) => {
        resetWorkerWatchdog();
        const hasNumericProgress =
          typeof report?.progress === 'number' && Number.isFinite(report.progress);
        const rawProgress = hasNumericProgress
          ? Math.min(1, Math.max(0, report.progress))
          : null;
        // When artifacts are already verified in local Cache Storage, WebLLM's initial
        // { progress: 0, text: "Start to fetch params" } is purely internal cache-load setup;
        // keep progressPercent indeterminate (null) until rawProgress > 0 so UI never flashes 0%.
        const progressPercent =
          rawProgress !== null
            ? hasVerifiedLocalCache && rawProgress === 0
              ? null
              : Math.round(rawProgress * 100)
            : null;
        const text = String(report?.text || '').trim();
        const timeElapsed = typeof report?.timeElapsed === 'number' ? report.timeElapsed : 0;

        const lowerText = text.toLowerCase();
        const isFetchStep =
          !hasVerifiedLocalCache &&
          (lowerText.includes('fetching') || lowerText.includes('downloading') || lowerText.includes('start to fetch')) &&
          (rawProgress === null || rawProgress < 1);
        const isGpuLoadStep =
          lowerText.includes('loading model from cache') ||
          lowerText.includes('loading gpu') ||
          lowerText.includes('compiling') ||
          lowerText.includes('finish loading');

        const stepStatus =
          (rawProgress !== null && rawProgress >= 1) || isGpuLoadStep || hasVerifiedLocalCache
            ? 'loading'
            : isFetchStep
              ? 'downloading'
              : 'downloading';

        const pctBucket = rawProgress !== null ? Math.floor(rawProgress * 5) * 20 : -1;
        const phaseKey = lowerText.split('[')[0].trim().slice(0, 48);
        if (pctBucket > lastLoggedWorkerBucket || (phaseKey && phaseKey !== lastLoggedWorkerPhase)) {
          if (pctBucket > lastLoggedWorkerBucket) {
            lastLoggedWorkerBucket = pctBucket;
          }
          if (phaseKey) {
            lastLoggedWorkerPhase = phaseKey;
          }
          logWebLLMStage(
            'worker_init_progress',
            {
              modelId: resolvedModelId,
              stepStatus,
              progress: rawProgress ?? 'indeterminate',
              text: text.slice(0, 96)
            },
            { startMs: initStartMs }
          );
        }

        updateEngineState({
          status: stepStatus,
          modelId: resolvedModelId,
          loadedModelId: null,
          progress: rawProgress ?? 0,
          progressPercent,
          progressText: text || initialText,
          timeElapsed,
          isCached: hasVerifiedLocalCache
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
              isCached: hasVerifiedLocalCache
            });
          } catch (_) {
            // Never allow progress listener error to break initialization
          }
        }
      };

      const chatOpts = {
        context_window_size: catalogEntry?.contextWindowSize || 4096
      };

      const createdEngine = typeof customEngineFactory === 'function'
        ? await Promise.race([
            customEngineFactory({
              worker,
              modelId: resolvedModelId,
              handleInitProgress,
              chatOpts,
              signal: initController.signal
            }),
            workerCrashPromise
          ])
        : await Promise.race([
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

      clearWorkerWatchdog?.();
      detachWorkerDiagListener?.();
      detachWorkerDiagListener = null;
      activeInitAbortReject = null;

      // Keep runtime worker error listener active after init so runtime crashes recover cleanly
      worker.onerror = (event) => {
        console.error('[Orvix WebLLM] Runtime worker error:', event?.message || event);
        terminateWorkerImmediate();
        updateEngineState({
          status: 'error',
          loadedModelId: null,
          error: 'Browser AI worker stopped unexpectedly (possible GPU memory limit). Next message will reload the engine.'
        });
      };

      engineInstance = createdEngine;
      loadedModelId = resolvedModelId;

      const readyReport = {
        status: 'ready',
        modelId: resolvedModelId,
        loadedModelId: resolvedModelId,
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

      logWebLLMStage(
        'init_ready',
        { modelId: resolvedModelId, wasCachedBeforeInit },
        { startMs: initStartMs }
      );

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
      clearWorkerWatchdog?.();
      detachWorkerDiagListener?.();
      detachWorkerDiagListener = null;
      activeInitAbortReject = null;
      terminateWorkerImmediate();

      if (isAbortError(rawErr)) {
        logWebLLMStage('init_aborted', { modelId: resolvedModelId }, { startMs: initStartMs });
        updateEngineState({
          status: 'idle',
          loadedModelId: null,
          progress: 0,
          progressPercent: null,
          progressText: '',
          isCached: hasVerifiedLocalCache,
          error: null
        });
        throw rawErr;
      }

      const rawMsg = String(rawErr?.message || rawErr || '').toLowerCase();
      const isShaderF16Err = rawMsg.includes('shaderf16') || rawMsg.includes('shader-f16');
      if (
        isShaderF16Err &&
        allowF32Fallback &&
        catalogEntry?.f32FallbackModelId &&
        resolvedModelId !== catalogEntry.f32FallbackModelId
      ) {
        logWebLLMStage(
          'init_f32_fallback',
          { fromModelId: resolvedModelId, toModelId: catalogEntry.f32FallbackModelId },
          { startMs: initStartMs, level: 'warn' }
        );
        return await ensureWebLLMEngine({
          modelId: catalogEntry.f32FallbackModelId,
          allowF32Fallback: false,
          onProgress,
          signal
        });
      }

      const normalizedError = normalizeWebLLMError(rawErr, {
        modelId: resolvedModelId,
        phase: 'init',
        wasCached: hasVerifiedLocalCache
      });

      logWebLLMStage(
        'init_error',
        {
          modelId: resolvedModelId,
          code: normalizedError.errorCode,
          wasCached: hasVerifiedLocalCache,
          message: normalizedError.message
        },
        { startMs: initStartMs, level: 'warn' }
      );

      updateEngineState({
        status: 'error',
        modelId: resolvedModelId,
        loadedModelId: null,
        progress: 0,
        progressPercent: null,
        progressText: '',
        isCached: hasVerifiedLocalCache,
        error: normalizedError.message
      });

      throw normalizedError;
    } finally {
      clearWorkerWatchdog?.();
      detachWorkerDiagListener?.();
      if (removeAbortListener) {
        removeAbortListener();
      }
      if (activeInitAbortController === initController) {
        activeInitAbortController = null;
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

  if ((activeInitAbortController || activeInitAbortReject) && !engineInstance) {
    if (activeInitAbortController) {
      try {
        activeInitAbortController.abort();
      } catch (_) {
        // Ignore
      }
      activeInitAbortController = null;
    }
    if (activeInitAbortReject) {
      const rejectInit = activeInitAbortReject;
      activeInitAbortReject = null;
      terminateWorkerImmediate();
      rejectInit(createAbortError('Model initialization stopped by user.'));
    } else {
      terminateWorkerImmediate();
    }
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
  modelId: modelIdParam = null,
  attachments = [],
  onStart,
  onChunk,
  onProgress,
  signal,
  temperature = undefined,
  top_p = undefined,
  topP = undefined,
  max_tokens = undefined,
  maxTokens = undefined,
  repetition_penalty = undefined,
  repetitionPenalty = undefined
} = {}) {
  const cleanPrompt = typeof prompt === 'string' ? prompt.trim() : '';
  if (!cleanPrompt) {
    throw new WebLLMError('Prompt cannot be empty.', {
      code: 'INVALID_ARGUMENT',
      httpCode: 400,
      retryable: false
    });
  }

  // Validate generation parameters
  let effectiveTemperature = mode === 'coding' ? 0.3 : 0.7;
  if (temperature !== undefined) {
    const numTemp = Number(temperature);
    if (!Number.isFinite(numTemp) || numTemp < 0 || numTemp > 2) {
      throw new WebLLMError(
        `Invalid temperature parameter: expected a finite number between 0 and 2, got ${temperature}.`,
        {
          code: 'INVALID_ARGUMENT',
          httpCode: 400,
          retryable: false
        }
      );
    }
    effectiveTemperature = numTemp;
  }

  let effectiveTopP = 0.9;
  const rawTopP = top_p !== undefined ? top_p : topP;
  if (rawTopP !== undefined) {
    const numTopP = Number(rawTopP);
    if (!Number.isFinite(numTopP) || numTopP <= 0 || numTopP > 1) {
      throw new WebLLMError(
        `Invalid top_p parameter: expected a finite number between 0 and 1, got ${rawTopP}.`,
        {
          code: 'INVALID_ARGUMENT',
          httpCode: 400,
          retryable: false
        }
      );
    }
    effectiveTopP = numTopP;
  }

  const rawMaxTokens = max_tokens !== undefined ? max_tokens : maxTokens;
  let customMaxTokens = undefined;
  if (rawMaxTokens !== undefined) {
    const numMax = Number(rawMaxTokens);
    if (!Number.isFinite(numMax) || numMax <= 0) {
      throw new WebLLMError(
        `Invalid max_tokens parameter: expected a positive integer, got ${rawMaxTokens}.`,
        {
          code: 'INVALID_ARGUMENT',
          httpCode: 400,
          retryable: false
        }
      );
    }
    customMaxTokens = Math.floor(numMax);
  }

  const rawRepPenalty = repetition_penalty !== undefined ? repetition_penalty : repetitionPenalty;
  let customRepetitionPenalty = undefined;
  if (rawRepPenalty !== undefined) {
    const numRep = Number(rawRepPenalty);
    if (!Number.isFinite(numRep) || numRep <= 0 || numRep > 2) {
      throw new WebLLMError(
        `Invalid repetition_penalty parameter: expected a finite positive number up to 2, got ${rawRepPenalty}.`,
        {
          code: 'INVALID_ARGUMENT',
          httpCode: 400,
          retryable: false
        }
      );
    }
    customRepetitionPenalty = numRep;
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
      modelId: model || modelIdParam || DEFAULT_WEBLLM_MODEL_ID,
      onProgress,
      signal
    });

    if (signal?.aborted) {
      throw createAbortError();
    }

    const catalogEntry = WEBLLM_MODEL_CATALOG[modelId];
    const baseSystemInstruction = isRefinedTargetModel(modelId)
      ? buildProfileSystemInstruction(modelId, { username, preferences, mode })
      : buildLocalSystemInstruction(username, preferences, mode);

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

    const genParams = resolveProfileGenerationParams(modelId, {
      mode,
      preferences,
      temperature,
      top_p,
      topP,
      max_tokens,
      maxTokens,
      repetition_penalty: customRepetitionPenalty
    });

    const boundedMessages = trimMessagesToContextBudget(rawMessages, genParams.maxInputChars);

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

    const streamSanitizer = createStreamingResponseSanitizer(modelId, {
      onChunk,
      onStopDetected: () => {
        try {
          engine.interruptGenerate();
        } catch (_) {
          // Ignore
        }
      }
    });

    try {
      const completionPayload = {
        messages: boundedMessages,
        temperature: genParams.temperature,
        top_p: genParams.top_p,
        max_tokens: genParams.max_tokens,
        stream: true,
        stream_options: { include_usage: true }
      };

      if (genParams.repetition_penalty !== undefined) {
        completionPayload.repetition_penalty = genParams.repetition_penalty;
      }
      if (genParams.stop !== undefined && Array.isArray(genParams.stop)) {
        completionPayload.stop = genParams.stop;
      }
      if (genParams.extra_body !== undefined) {
        completionPayload.extra_body = genParams.extra_body;
      }

      const asyncChunkGenerator = await engine.chat.completions.create(completionPayload);

      for await (const chunk of asyncChunkGenerator) {
        if (signal?.aborted || manualStopRequested || streamSanitizer.isStopped()) {
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
          streamSanitizer.feed(delta, accumulatedText);
        }

        if (chunk?.usage) {
          finalUsage = chunk.usage;
        }
      }

      streamSanitizer.flush();

      if (signal?.aborted || manualStopRequested) {
        throw createAbortError();
      }

      const cleanedText = cleanModelOutput(accumulatedText, modelId);
      const finalText = cleanedText.trim();
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
        text: cleanedText,
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

      if (accumulatedText && accumulatedText.length > 0) {
        normalized.retryable = false;
        normalized.partial = true;
        normalized.partialText = cleanModelOutput(accumulatedText, modelId);
      }

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
