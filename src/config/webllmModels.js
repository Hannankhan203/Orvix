// @ts-check
/**
 * Static WebLLM Browser AI model catalog, constants, and error definitions.
 * Decoupled from webllmService.js runtime logic so UI components and configs
 * can read model metadata without pulling WebGPU/worker orchestration code
 * into initial bundles.
 */

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
 *
 * @typedef {{ id: string, label: string, shortLabel: string, tier: string, tierLabel: string, parameters: string, description?: string, quantization: string, prefersShaderF16: boolean, f32FallbackModelId: string | null, vramRequiredMB: number, estimatedDownloadMB: number, minStorageBytes: number, contextWindowSize: number, maxDocChars: number, maxHistoryMessages: number, defaultMaxTokens: number, isDefault: boolean }} WebLLMModelEntry
 */
/** @type {Readonly<Record<string, Readonly<WebLLMModelEntry>>>} */
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
    minStorageBytes: 1_150 * 1024 * 1024,
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

export const INITIAL_WEBLLM_STATE = Object.freeze({
  status: 'idle',
  modelId: DEFAULT_WEBLLM_MODEL_ID,
  loadedModelId: null,
  isWarmed: false,
  progress: 0,
  progressPercent: null,
  progressText: '',
  timeElapsed: 0,
  isCached: false,
  hasShaderF16: null,
  error: null
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
   * @param {boolean} [options.timeout]
   * @param {boolean} [options.partial]
   * @param {string} [options.partialText]
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

/**
 * Returns the catalog of verified Browser AI models.
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
