/**
 * Orvix Global Error Classification & Normalization Service
 * Phase 4H — Unified error contract, deterministic precedence, sensitive data sanitization,
 * and strict local privacy invariants across all six AI providers:
 * 1. Gemini
 * 2. Groq
 * 3. OpenRouter
 * 4. Cloudflare
 * 5. Ollama
 * 6. WebLLM
 */

import { normalizeProviderId } from './providerModelSanitizer.js';

export const ERROR_CATEGORIES = Object.freeze({
  CONFIGURATION_AND_VALIDATION: 'configuration_and_validation',
  CONNECTIVITY_AND_TRANSPORT: 'connectivity_and_transport',
  TIMEOUTS_AND_RESOURCE_LIMITS: 'timeouts_and_resource_limits',
  UPSTREAM_API_AND_MODEL: 'upstream_api_and_model',
  STREAMING_AND_GENERATION: 'streaming_and_generation',
  CANCELLATION_AND_ISOLATION: 'cancellation_and_isolation'
});

export const STANDARD_ERROR_CODES = Object.freeze({
  // 1. Configuration & Validation
  MISSING_CREDENTIALS: 'MISSING_CREDENTIALS',
  PROVIDER_NOT_CONFIGURED: 'PROVIDER_NOT_CONFIGURED',
  AUTH_FAILED: 'AUTH_FAILED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  INVALID_MODEL: 'INVALID_MODEL',
  UNSUPPORTED_MODEL: 'UNSUPPORTED_MODEL',
  INVALID_REQUEST_PARAMETERS: 'INVALID_REQUEST_PARAMETERS',
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  LOCAL_PROVIDER_ONLY: 'LOCAL_PROVIDER_ONLY',

  // 2. Connectivity & Transport
  CONNECTION_REFUSED: 'CONNECTION_REFUSED',
  NETWORK_FAILURE: 'NETWORK_FAILURE',
  NETWORK_ERROR: 'NETWORK_ERROR',
  DNS_FAILURE: 'DNS_FAILURE',
  FETCH_FAILED: 'FETCH_FAILED',
  SSL_ERROR: 'SSL_ERROR',

  // 3. Timeouts & Resource Limits
  DEADLINE_EXCEEDED: 'DEADLINE_EXCEEDED',
  REQUEST_TIMEOUT: 'REQUEST_TIMEOUT',
  RATE_LIMITED: 'RATE_LIMITED',
  RESOURCE_EXHAUSTED: 'RESOURCE_EXHAUSTED',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  OUT_OF_MEMORY: 'OUT_OF_MEMORY',
  DEVICE_LOST: 'DEVICE_LOST',
  INSUFFICIENT_STORAGE: 'INSUFFICIENT_STORAGE',
  WEBGPU_UNSUPPORTED: 'WEBGPU_UNSUPPORTED',
  WEBGPU_ADAPTER_UNAVAILABLE: 'WEBGPU_ADAPTER_UNAVAILABLE',
  SHADER_F16_UNSUPPORTED: 'SHADER_F16_UNSUPPORTED',
  OFFLINE_UNCACHED: 'OFFLINE_UNCACHED',

  // 4. Upstream API & Model Errors
  NOT_FOUND: 'NOT_FOUND',
  MODEL_NOT_FOUND: 'MODEL_NOT_FOUND',
  MODEL_DECOMMISSIONED: 'MODEL_DECOMMISSIONED',
  SAFETY_BLOCKED: 'SAFETY_BLOCKED',
  CONTEXT_LENGTH_EXCEEDED: 'CONTEXT_LENGTH_EXCEEDED',
  BAD_GATEWAY: 'BAD_GATEWAY',
  UNAVAILABLE: 'UNAVAILABLE',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  INTERNAL: 'INTERNAL',
  UPSTREAM_SERVICE_ERROR: 'UPSTREAM_SERVICE_ERROR',

  // 5. Streaming & Generation Errors
  STREAM_INTERRUPTED: 'STREAM_INTERRUPTED',
  MALFORMED_STREAM_FRAME: 'MALFORMED_STREAM_FRAME',
  EMPTY_RESPONSE: 'EMPTY_RESPONSE',
  WORKER_CRASHED: 'WORKER_CRASHED',
  GENERATION_FAILED: 'GENERATION_FAILED',

  // 6. Cancellation & Isolation
  REQUEST_CANCELLED: 'REQUEST_CANCELLED',
  REQUEST_ABORTED: 'REQUEST_ABORTED',
  REQUEST_SUPERSEDED: 'REQUEST_SUPERSEDED'
});

/**
 * Sanitizes an error message or string by stripping API keys, tokens, auth headers,
 * secret env vars, and potential raw user prompts before presentation.
 *
 * @param {string} raw
 * @param {Object} [options]
 * @param {string} [options.promptText]
 * @returns {string}
 */
export function sanitizeErrorMessage(raw, options = {}) {
  if (typeof raw !== 'string') {
    if (raw === null || raw === undefined) return '';
    raw = String(raw);
  }

  let sanitized = raw;

  // Redact Bearer tokens
  sanitized = sanitized.replace(/Bearer\s+[A-Za-z0-9_\-\.]+/gi, 'Bearer [REDACTED]');

  // Redact Google AI Studio / Gemini API keys (AIza...)
  sanitized = sanitized.replace(/AIza[0-9A-Za-z-_]{20,}/g, '[REDACTED_API_KEY]');

  // Redact Groq API keys (gsk_...)
  sanitized = sanitized.replace(/gsk_[A-Za-z0-9_\-]{20,}/g, '[REDACTED_API_KEY]');

  // Redact OpenRouter API keys (sk-or-...)
  sanitized = sanitized.replace(/sk-or-[A-Za-z0-9_\-\.]{15,}/g, '[REDACTED_API_KEY]');

  // Redact generic OpenAI / Cloudflare format keys (sk-...)
  sanitized = sanitized.replace(/\bsk-[A-Za-z0-9_\-]{20,}/g, '[REDACTED_API_KEY]');

  // Redact URL query parameter keys (e.g., ?key=... or &key=...)
  sanitized = sanitized.replace(/([?&]key=)[A-Za-z0-9_\-]+/gi, '$1[REDACTED]');

  // Redact env var assignment formats
  sanitized = sanitized.replace(
    /\b(GEMINI_API_KEY|GROQ_API_KEY|OPENROUTER_API_KEY|CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID)\s*=\s*[^\s,;]+/gi,
    '$1=[REDACTED]'
  );

  // Redact raw authorization headers if exposed
  sanitized = sanitized.replace(/(authorization:\s*)([^\r\n,;]+)/gi, '$1[REDACTED]');

  // Redact user prompt text if echoed in error text
  if (options.promptText && typeof options.promptText === 'string' && options.promptText.trim().length > 3) {
    const cleanPrompt = options.promptText.trim();
    if (sanitized.includes(cleanPrompt)) {
      sanitized = sanitized.split(cleanPrompt).join('[USER_PROMPT]');
    }
  }

  return sanitized.trim();
}

/**
 * Standard Canonical AI Error class adhering to the Phase 4H contract.
 */
export class CanonicalAIError extends Error {
  /**
   * @param {Object} [options]
   */
  constructor(options = {}) {
    const safeMsg =
      sanitizeErrorMessage(options.message, { promptText: options.promptText }) ||
      'An unexpected AI service error occurred.';
    super(safeMsg);

    this.name = 'CanonicalAIError';
    this.code = options.code || STANDARD_ERROR_CODES.UPSTREAM_SERVICE_ERROR;
    this.status = this.code;
    this.errorCode = this.code;
    this.category = options.category || ERROR_CATEGORIES.UPSTREAM_API_AND_MODEL;
    this.message = safeMsg;

    const rawProvider = options.provider || 'gemini';
    this.provider = normalizeProviderId(rawProvider) || 'gemini';
    this.model = typeof options.model === 'string' && options.model.trim() ? options.model.trim() : null;

    this.httpStatus =
      Number.isInteger(options.httpStatus) && options.httpStatus >= 400 && options.httpStatus <= 599
        ? options.httpStatus
        : 500;

    this.cancelled = Boolean(options.cancelled);
    this.timeout = Boolean(options.timeout);
    this.retryable = Boolean(options.retryable);
    this.partial = Boolean(options.partial);
    this.partialText = typeof options.partialText === 'string' ? options.partialText : '';

    // CRITICAL PRIVACY, CANCELLATION & PARTIAL INVARIANTS:
    // 1. Ollama and WebLLM local providers MUST NEVER have canFallback: true
    // 2. Cancelled or aborted requests MUST strictly have canFallback: false and retryable: false
    // 3. Partial streamed output MUST strictly have canFallback: false and retryable: false
    if (
      this.provider === 'ollama' ||
      this.provider === 'webllm' ||
      this.cancelled ||
      this.partial ||
      (this.partialText && this.partialText.trim().length > 0)
    ) {
      this.canFallback = false;
      if (this.cancelled || this.partial || (this.partialText && this.partialText.trim().length > 0)) {
        this.retryable = false;
      }
    } else {
      this.canFallback = Boolean(options.canFallback);
    }

    this.requestId = options.requestId !== undefined && options.requestId !== null ? options.requestId : null;

    this.attemptedProviders = Array.isArray(options.attemptedProviders)
      ? [...options.attemptedProviders]
      : [this.provider];
    this.fallbackHistory = Array.isArray(options.fallbackHistory)
      ? [...options.fallbackHistory]
      : [];

    if (Array.isArray(options.suggestedProviders)) {
      this.suggestedProviders = [...options.suggestedProviders];
    }
    if (options.finishReason) {
      this.finishReason = String(options.finishReason);
    }
    if (options.retryAfterSeconds !== undefined && Number.isFinite(options.retryAfterSeconds)) {
      this.retryAfterSeconds = options.retryAfterSeconds;
    }
    if (options.serverRetriesExhausted) {
      this.serverRetriesExhausted = true;
    }
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      status: this.status,
      errorCode: this.errorCode,
      category: this.category,
      message: this.message,
      provider: this.provider,
      model: this.model,
      httpStatus: this.httpStatus,
      retryable: this.retryable,
      canFallback: this.canFallback,
      cancelled: this.cancelled,
      timeout: this.timeout,
      partial: this.partial,
      partialText: this.partialText,
      requestId: this.requestId,
      attemptedProviders: this.attemptedProviders,
      fallbackHistory: this.fallbackHistory,
      suggestedProviders: this.suggestedProviders,
      finishReason: this.finishReason,
      retryAfterSeconds: this.retryAfterSeconds
    };
  }
}

/**
 * Returns true if the object is already a CanonicalAIError instance.
 * @param {any} err
 * @returns {boolean}
 */
export function isCanonicalAIError(err) {
  return Boolean(err && (err instanceof CanonicalAIError || err.name === 'CanonicalAIError'));
}

/**
 * Unpacks nested JSON strings (e.g. from Google GenAI SDK or fetch response texts).
 * @param {string} text
 * @returns {{ cleanMsg: string, parsedData: any }}
 */
function unpackNestedJson(text) {
  let cleanMsg = String(text || '');
  let parsedData = null;

  for (let i = 0; i < 3; i++) {
    if (typeof cleanMsg !== 'string') break;
    const match = cleanMsg.match(/\{[\s\S]*\}/);
    if (!match) break;
    try {
      const parsed = JSON.parse(match[0]);
      if (parsed) {
        parsedData = parsed;
        if (parsed.error) {
          if (typeof parsed.error === 'string') {
            cleanMsg = parsed.error;
          } else if (parsed.error.message) {
            cleanMsg = String(parsed.error.message);
          }
          break;
        } else if (parsed.message) {
          cleanMsg = String(parsed.message);
          break;
        }
      }
      break;
    } catch (_) {
      break;
    }
  }

  return { cleanMsg, parsedData };
}

/**
 * Determines whether an error or signal represents an intentional request abort/cancellation.
 * @param {any} error
 * @param {AbortSignal | null} [signal=null]
 * @returns {boolean}
 */
export function isAbortLike(error, signal = null) {
  if (signal?.aborted) return true;
  if (!error) return false;
  if (error?.name === 'AbortError') return true;
  if (error?.cancelled === true) return true;
  const msg = String(error?.message || error || '').toLowerCase();
  return (
    msg.includes('aborted') ||
    msg.includes('generation cancelled') ||
    msg.includes('stopped by user') ||
    msg.includes('request cancelled')
  );
}

/**
 * Normalizes any error representation into a consistent CanonicalAIError object
 * across all six providers while enforcing deterministic classification precedence,
 * data sanitization, and local privacy guarantees.
 *
 * @param {any} rawError
 * @param {Object} [context={}]
 * @param {string} [context.provider]
 * @param {string} [context.model]
 * @param {number} [context.httpStatus]
 * @param {string | number} [context.requestId]
 * @param {string} [context.partialText]
 * @param {boolean} [context.partial]
 * @param {AbortSignal} [context.signal]
 * @param {string} [context.promptText]
 * @param {boolean} [context.retryable]
 * @param {boolean} [context.canFallback]
 * @param {Array<string>} [context.suggestedProviders]
 * @param {boolean} [context.isTimeout]
 * @param {string} [context.finishReason]
 * @param {number} [context.retryAfterSeconds]
 * @returns {CanonicalAIError}
 */
export function normalizeAIError(rawError, context = {}) {
  // If already canonical and context doesn't require overriding provider/model/partial, return or clone
  if (isCanonicalAIError(rawError)) {
    const needsOverride =
      (context.provider && normalizeProviderId(context.provider) !== rawError.provider) ||
      (context.model && context.model !== rawError.model) ||
      (context.requestId && context.requestId !== rawError.requestId) ||
      (typeof context.partialText === 'string' && context.partialText !== rawError.partialText) ||
      (typeof context.partial === 'boolean' && context.partial !== rawError.partial);

    if (!needsOverride) {
      return rawError;
    }

    return new CanonicalAIError({
      ...rawError.toJSON(),
      provider: context.provider || rawError.provider,
      model: context.model || rawError.model,
      requestId: context.requestId !== undefined ? context.requestId : rawError.requestId,
      partial: typeof context.partial === 'boolean' ? context.partial : rawError.partial,
      partialText: typeof context.partialText === 'string' ? context.partialText : rawError.partialText,
      attemptedProviders: context.attemptedProviders || rawError.attemptedProviders,
      fallbackHistory: context.fallbackHistory || rawError.fallbackHistory,
      cause: rawError.cause
    });
  }

  const isObject = rawError !== null && typeof rawError === 'object';
  const signal = context.signal || null;

  // Extract raw message and status
  let initialMsg = '';
  if (typeof rawError === 'string') {
    initialMsg = rawError;
  } else if (typeof rawError?.error === 'string') {
    initialMsg = rawError.error;
  } else if (typeof rawError?.message === 'string') {
    initialMsg = rawError.message;
  } else if (rawError === null || rawError === undefined) {
    initialMsg = '';
  } else {
    initialMsg = String(rawError);
  }

  const { cleanMsg, parsedData } = unpackNestedJson(initialMsg);

  // Resolve provider
  const rawProviderCandidate =
    context.provider ||
    rawError?.provider ||
    parsedData?.provider ||
    parsedData?.error?.provider ||
    '';
  const provider = normalizeProviderId(rawProviderCandidate) || 'gemini';
  const isOllama = provider === 'ollama';
  const isWebLLM = provider === 'webllm';
  const isLocalProvider = isOllama || isWebLLM;

  // Resolve model
  const model =
    context.model ||
    rawError?.model ||
    rawError?.modelUsed ||
    parsedData?.model ||
    parsedData?.modelUsed ||
    null;

  // Resolve status string and HTTP status code
  let rawStatus = String(
    rawError?.status ||
    rawError?.errorCode ||
    rawError?.code ||
    parsedData?.status ||
    parsedData?.errorCode ||
    parsedData?.error?.status ||
    ''
  ).trim();

  let httpStatus =
    Number(context.httpStatus) ||
    Number(rawError?.httpStatus) ||
    Number(rawError?.statusCode) ||
    Number(rawError?.code) ||
    Number(parsedData?.code) ||
    Number(parsedData?.error?.code) ||
    500;

  if (!Number.isInteger(httpStatus) || httpStatus < 400 || httpStatus > 599) {
    httpStatus = 500;
  }

  // Resolve partial stream information
  const partialText =
    typeof context.partialText === 'string'
      ? context.partialText
      : typeof rawError?.partialText === 'string'
      ? rawError.partialText
      : '';
  const partial = Boolean(
    context.partial ||
    rawError?.partial ||
    (partialText && partialText.trim().length > 0)
  );

  const requestId = context.requestId !== undefined ? context.requestId : (rawError?.requestId ?? null);
  const promptText = context.promptText || '';

  const lowerMsg = cleanMsg.toLowerCase();
  const upperStatus = rawStatus.toUpperCase();

  // Retry-after seconds
  let retryAfterSeconds =
    context.retryAfterSeconds !== undefined
      ? context.retryAfterSeconds
      : rawError?.retryAfterSeconds;

  // =========================================================================
  // DETERMINISTIC CLASSIFICATION PRECEDENCE
  // =========================================================================

  let code = STANDARD_ERROR_CODES.UPSTREAM_SERVICE_ERROR;
  let category = ERROR_CATEGORIES.UPSTREAM_API_AND_MODEL;
  let userMessage = cleanMsg;
  let retryable = false;
  let canFallback = !isLocalProvider;
  let cancelled = false;
  let timeout = false;

  // Helper check for explicit timeout
  const hasTimeoutSignal =
    context.isTimeout === true ||
    rawError?.isTimeout === true ||
    rawError?.timeout === true ||
    rawError?.name === 'TimeoutError' ||
    httpStatus === 504 ||
    upperStatus === 'DEADLINE_EXCEEDED' ||
    upperStatus === 'REQUEST_TIMEOUT' ||
    lowerMsg.includes('timed out') ||
    lowerMsg.includes('timeout') ||
    lowerMsg.includes('deadline exceeded') ||
    lowerMsg.includes('deadline expired');

  // 1. CANCELLATION / ABORT (User Intent)
  // Exception: if the abort was specifically caused by a deadline/timeout, precedence goes to TIMEOUT
  if (isAbortLike(rawError, signal) && !hasTimeoutSignal) {
    code = STANDARD_ERROR_CODES.REQUEST_CANCELLED;
    category = ERROR_CATEGORIES.CANCELLATION_AND_ISOLATION;
    cancelled = true;
    timeout = false;
    retryable = false;
    canFallback = false;
    httpStatus = 499;
    userMessage = 'Generation cancelled by user.';
  }
  // 2. TIMEOUT / DEADLINE EXCEEDED
  else if (hasTimeoutSignal) {
    code = STANDARD_ERROR_CODES.DEADLINE_EXCEEDED;
    category = ERROR_CATEGORIES.TIMEOUTS_AND_RESOURCE_LIMITS;
    timeout = true;
    cancelled = false;
    httpStatus = 504;
    retryable = !isLocalProvider && !partial;
    canFallback = !isLocalProvider;

    if (isOllama) {
      userMessage =
        'Local AI (Ollama) timed out while waiting for a response. Verify Ollama is responsive at http://127.0.0.1:11434.';
      retryable = false;
      canFallback = false;
    } else if (isWebLLM) {
      userMessage = 'Browser AI (WebLLM) timed out during local model execution.';
      retryable = false;
      canFallback = false;
    } else {
      userMessage =
        'The AI service timed out while waiting for a response. Please try again or switch providers.';
    }
  }
  // 3. WEBGPU / HARDWARE / LOCAL RUNTIME (WebLLM Specific)
  else if (
    isWebLLM ||
    upperStatus.startsWith('WEBLLM_') ||
    upperStatus.startsWith('WEBGPU_') ||
    lowerMsg.includes('webgpu') ||
    lowerMsg.includes('shader-f16') ||
    lowerMsg.includes('devicelost')
  ) {
    category = ERROR_CATEGORIES.TIMEOUTS_AND_RESOURCE_LIMITS;
    canFallback = false; // Strictly non-fallback for local provider

    if (
      upperStatus === 'SHADER_F16_UNSUPPORTED' ||
      upperStatus === 'WEBLLM_SHADER_F16_UNSUPPORTED' ||
      lowerMsg.includes('shader-f16') ||
      lowerMsg.includes('shaderf16')
    ) {
      code = STANDARD_ERROR_CODES.SHADER_F16_UNSUPPORTED;
      httpStatus = 400;
      retryable = false;
      userMessage =
        cleanMsg ||
        'Your GPU browser driver does not support the WebGPU 16-bit shader extension (shader-f16) required by this model.';
    } else if (
      upperStatus === 'WEBGPU_UNSUPPORTED' ||
      lowerMsg.includes('webgpu is not available') ||
      lowerMsg.includes('cannot find webgpu') ||
      lowerMsg.includes('webgpunotavailableerror')
    ) {
      code = STANDARD_ERROR_CODES.WEBGPU_UNSUPPORTED;
      httpStatus = 400;
      retryable = false;
      userMessage =
        cleanMsg ||
        'WebGPU is not available on this browser or device. Please use Chrome 113+, Edge 113+, or Safari 18+ with hardware acceleration enabled.';
    } else if (
      upperStatus === 'WEBGPU_ADAPTER_UNAVAILABLE' ||
      lowerMsg.includes('adapter') ||
      lowerMsg.includes('no compatible webgpu graphics adapter')
    ) {
      code = STANDARD_ERROR_CODES.WEBGPU_ADAPTER_UNAVAILABLE;
      httpStatus = 400;
      retryable = false;
      userMessage =
        cleanMsg ||
        'No compatible WebGPU graphics adapter was found. Please ensure hardware acceleration is enabled in your browser settings.';
    } else if (
      upperStatus === 'DEVICE_LOST' ||
      upperStatus === 'WEBLLM_DEVICE_LOST' ||
      lowerMsg.includes('devicelost') ||
      lowerMsg.includes('device was lost') ||
      lowerMsg.includes('device lost')
    ) {
      code = STANDARD_ERROR_CODES.DEVICE_LOST;
      httpStatus = 507;
      retryable = true;
      userMessage =
        cleanMsg ||
        'Your device ran out of GPU memory during local inference. Try closing other GPU-heavy browser tabs or applications and retry.';
    } else if (
      upperStatus === 'INSUFFICIENT_STORAGE' ||
      upperStatus === 'WEBLLM_INSUFFICIENT_STORAGE' ||
      lowerMsg.includes('storage quota') ||
      lowerMsg.includes('quotaexceedederror')
    ) {
      code = STANDARD_ERROR_CODES.INSUFFICIENT_STORAGE;
      httpStatus = 507;
      retryable = false;
      userMessage =
        cleanMsg ||
        'Not enough browser storage is available to cache the requested model. Please free up browser storage and try again.';
    } else if (
      upperStatus === 'OFFLINE_UNCACHED' ||
      upperStatus === 'WEBLLM_OFFLINE_UNCACHED' ||
      lowerMsg.includes('has not been downloaded to this browser yet')
    ) {
      code = STANDARD_ERROR_CODES.OFFLINE_UNCACHED;
      httpStatus = 503;
      retryable = true;
      userMessage =
        cleanMsg ||
        'This Browser AI model has not been downloaded to this device yet. Connect to the internet once to download and cache the model for local use.';
    } else if (
      upperStatus === 'UNSUPPORTED_MODEL' ||
      upperStatus === 'WEBLLM_UNSUPPORTED_MODEL' ||
      lowerMsg.includes('unsupported browser ai model') ||
      lowerMsg.includes('unsupported model') ||
      lowerMsg.includes('not supported') ||
      lowerMsg.includes('modelnotfounderror')
    ) {
      code = STANDARD_ERROR_CODES.UNSUPPORTED_MODEL;
      httpStatus = 400;
      retryable = false;
      userMessage = cleanMsg || 'The requested Browser AI model is not supported.';
    } else if (
      upperStatus === 'WORKER_CRASHED' ||
      upperStatus === 'WEBLLM_WORKER_CRASHED' ||
      lowerMsg.includes('worker crashed') ||
      lowerMsg.includes('worker error')
    ) {
      code = STANDARD_ERROR_CODES.WORKER_CRASHED;
      category = ERROR_CATEGORIES.STREAMING_AND_GENERATION;
      httpStatus = 500;
      retryable = true;
      userMessage =
        cleanMsg ||
        'The dedicated Browser AI worker encountered an unexpected error. Please retry to restart the engine.';
    } else {
      code = STANDARD_ERROR_CODES.GENERATION_FAILED;
      category = ERROR_CATEGORIES.STREAMING_AND_GENERATION;
      httpStatus = 500;
      retryable = true;
      userMessage = cleanMsg || 'Browser AI encountered a local generation error.';
    }
  }
  // 4. PROVIDER CONFIGURATION & AUTHENTICATION
  else if (
    upperStatus === 'PROVIDER_NOT_CONFIGURED' ||
    upperStatus === 'MISSING_CREDENTIALS' ||
    lowerMsg.includes('not configured on the server') ||
    lowerMsg.includes('not configured on this server') ||
    lowerMsg.includes('provider is not configured')
  ) {
    code = STANDARD_ERROR_CODES.PROVIDER_NOT_CONFIGURED;
    category = ERROR_CATEGORIES.CONFIGURATION_AND_VALIDATION;
    httpStatus = 503;
    retryable = false;
    canFallback = !isLocalProvider;
    userMessage =
      cleanMsg ||
      'This AI provider is not configured on the server. Please select a configured provider or configure the required server environment credentials.';
  } else if (
    httpStatus === 401 ||
    httpStatus === 403 ||
    upperStatus === 'AUTH_FAILED' ||
    upperStatus === 'UNAUTHENTICATED' ||
    upperStatus === 'PERMISSION_DENIED' ||
    lowerMsg.includes('api_key_invalid') ||
    lowerMsg.includes('api key not valid') ||
    lowerMsg.includes('unauthorized') ||
    lowerMsg.includes('permission denied') ||
    lowerMsg.includes('forbidden')
  ) {
    code = httpStatus === 401 ? STANDARD_ERROR_CODES.UNAUTHENTICATED : STANDARD_ERROR_CODES.PERMISSION_DENIED;
    category = ERROR_CATEGORIES.CONFIGURATION_AND_VALIDATION;
    httpStatus = httpStatus === 401 ? 401 : 403;
    retryable = false;
    canFallback = !isLocalProvider;
    userMessage =
      cleanMsg ||
      'Invalid or unauthorized API key. Please check your credentials or switch providers.';
  }
  // 5. MODEL SELECTION & COMPATIBILITY
  else if (
    upperStatus === 'INVALID_MODEL' ||
    upperStatus === 'UNSUPPORTED_MODEL' ||
    lowerMsg.includes('invalid model identifier') ||
    lowerMsg.includes('cross-provider')
  ) {
    code = STANDARD_ERROR_CODES.INVALID_MODEL;
    category = ERROR_CATEGORIES.CONFIGURATION_AND_VALIDATION;
    httpStatus = 400;
    retryable = false;
    canFallback = false;
    userMessage =
      cleanMsg ||
      'The requested model identifier is not valid for the selected AI provider.';
  } else if (
    httpStatus === 404 ||
    upperStatus === 'NOT_FOUND' ||
    upperStatus === 'MODEL_NOT_FOUND' ||
    upperStatus === 'MODEL_DECOMMISSIONED' ||
    lowerMsg.includes('model not found') ||
    lowerMsg.includes('is no longer available') ||
    lowerMsg.includes('does not exist') ||
    lowerMsg.includes('decommissioned') ||
    lowerMsg.includes('retired')
  ) {
    code = STANDARD_ERROR_CODES.MODEL_NOT_FOUND;
    category = ERROR_CATEGORIES.UPSTREAM_API_AND_MODEL;
    httpStatus = 404;
    retryable = false;
    canFallback = !isLocalProvider;

    if (isOllama) {
      code = STANDARD_ERROR_CODES.MODEL_NOT_FOUND;
      canFallback = false;
      userMessage =
        'The requested Ollama model was not found. Please ensure it is installed locally using "ollama pull qwen2.5:1.5b".';
    } else {
      userMessage =
        cleanMsg && !cleanMsg.includes('Server request failed') && cleanMsg !== 'Not Found'
          ? cleanMsg
          : 'The requested AI model was not found or is no longer available. Please select another provider or model.';
    }
  }
  // 6. PAYLOAD / ATTACHMENT BUDGET LIMITS
  else if (
    httpStatus === 413 ||
    upperStatus === 'PAYLOAD_TOO_LARGE' ||
    lowerMsg.includes('payload too large') ||
    lowerMsg.includes('request entity too large') ||
    lowerMsg.includes('entity.too.large') ||
    lowerMsg.includes('image payload exceeds')
  ) {
    code = STANDARD_ERROR_CODES.PAYLOAD_TOO_LARGE;
    category = ERROR_CATEGORIES.TIMEOUTS_AND_RESOURCE_LIMITS;
    httpStatus = 413;
    retryable = false;
    canFallback = false; // Cannot fallback because large payload would fail on all providers
    userMessage =
      'The attached image payload exceeds the supported request budget (3.0 MB max per image, 4.2 MB max total request). Please resize or compress the image and try again.';
  }
  // 7. CONTEXT LENGTH / TOKEN LIMIT EXCEEDED
  else if (
    upperStatus === 'CONTEXT_LENGTH_EXCEEDED' ||
    lowerMsg.includes('context length') ||
    lowerMsg.includes('maximum context length') ||
    lowerMsg.includes('tokens exceed') ||
    (lowerMsg.includes('token') && (lowerMsg.includes('at most') || lowerMsg.includes('maximum') || lowerMsg.includes('exceed') || lowerMsg.includes('limit') || lowerMsg.includes('requested')))
  ) {
    code = STANDARD_ERROR_CODES.CONTEXT_LENGTH_EXCEEDED;
    category = ERROR_CATEGORIES.UPSTREAM_API_AND_MODEL;
    httpStatus = 400;
    retryable = false;
    canFallback = false;
    userMessage =
      cleanMsg ||
      'This prompt exceeds the maximum context length supported by the model. Please shorten your prompt or clear earlier history.';
  }
  // 8. SAFETY & CONTENT FILTER BLOCKING
  else if (
    upperStatus === 'SAFETY_BLOCKED' ||
    rawError?.finishReason === 'SAFETY' ||
    context.finishReason === 'SAFETY' ||
    lowerMsg.includes('safety') ||
    lowerMsg.includes('blocked by safety') ||
    lowerMsg.includes('candidate was blocked')
  ) {
    code = STANDARD_ERROR_CODES.SAFETY_BLOCKED;
    category = ERROR_CATEGORIES.UPSTREAM_API_AND_MODEL;
    httpStatus = 400;
    retryable = false;
    canFallback = !isLocalProvider;
    userMessage =
      "The response was blocked by the AI provider's safety filters. Please rephrase your request.";
  }
  // 9. RATE LIMITING & QUOTA EXHAUSTION
  else if (
    httpStatus === 429 ||
    upperStatus === 'RESOURCE_EXHAUSTED' ||
    upperStatus === 'RATE_LIMITED' ||
    upperStatus === 'QUOTA_EXCEEDED' ||
    lowerMsg.includes('rate limit') ||
    lowerMsg.includes('quota') ||
    lowerMsg.includes('resource_exhausted')
  ) {
    code = STANDARD_ERROR_CODES.RATE_LIMITED;
    category = ERROR_CATEGORIES.TIMEOUTS_AND_RESOURCE_LIMITS;
    httpStatus = 429;
    retryable = !partial; // Only retryable if no partial output was emitted
    canFallback = !isLocalProvider;
    userMessage =
      'AI rate limit or quota exceeded. Please wait a moment before trying again.';
  }
  // 10. LOCAL OLLAMA CONNECTION FAILURES
  else if (
    isOllama &&
    (httpStatus === 503 ||
      upperStatus === 'NETWORK_FAILURE' ||
      upperStatus === 'NETWORK_ERROR' ||
      upperStatus === 'CONNECTION_REFUSED' ||
      lowerMsg.includes('econnrefused') ||
      lowerMsg.includes('failed to fetch') ||
      lowerMsg.includes('fetch failed') ||
      lowerMsg.includes('11434'))
  ) {
    code = STANDARD_ERROR_CODES.CONNECTION_REFUSED;
    category = ERROR_CATEGORIES.CONNECTIVITY_AND_TRANSPORT;
    httpStatus = 503;
    retryable = false;
    canFallback = false; // Strictly non-fallback for local provider
    userMessage =
      'Unable to connect to Local AI (Ollama) at http://127.0.0.1:11434. Please ensure Ollama is running ("ollama serve") and model "qwen2.5:1.5b" is installed.';
  }
  // 11. GENERAL NETWORK & TRANSPORT FAILURES
  else if (
    upperStatus === 'NETWORK_FAILURE' ||
    upperStatus === 'NETWORK_ERROR' ||
    upperStatus === 'CONNECTION_REFUSED' ||
    upperStatus === 'FETCH_FAILED' ||
    lowerMsg === 'fetch failed' ||
    lowerMsg === 'failed to fetch' ||
    lowerMsg.includes('econnrefused') ||
    lowerMsg.includes('enotfound') ||
    lowerMsg.includes('econnreset') ||
    lowerMsg.includes('network error')
  ) {
    code = lowerMsg.includes('econnrefused')
      ? STANDARD_ERROR_CODES.CONNECTION_REFUSED
      : STANDARD_ERROR_CODES.NETWORK_ERROR;
    category = ERROR_CATEGORIES.CONNECTIVITY_AND_TRANSPORT;
    httpStatus = 503;
    retryable = true;
    canFallback = !isLocalProvider;
    userMessage =
      'Unable to establish network connection with the AI service. Please check your internet connection or try again in a few moments.';
  }
  // 12. STREAM INTERRUPTIONS & MALFORMED FRAMES
  else if (
    upperStatus === 'STREAM_INTERRUPTED' ||
    upperStatus === 'MALFORMED_STREAM_FRAME' ||
    upperStatus === 'STREAM_FAILED' ||
    lowerMsg.includes('stream connection was closed') ||
    lowerMsg.includes('stream interrupted') ||
    lowerMsg.includes('terminated mid-stream') ||
    lowerMsg.includes('mid-stream') ||
    lowerMsg.includes('stream failed') ||
    lowerMsg.includes('malformed') ||
    lowerMsg.includes('unexpected end of json') ||
    lowerMsg.includes('unterminated string')
  ) {
    code =
      upperStatus === 'MALFORMED_STREAM_FRAME' ||
      lowerMsg.includes('malformed') ||
      lowerMsg.includes('unexpected end of json') ||
      lowerMsg.includes('unterminated string')
        ? STANDARD_ERROR_CODES.MALFORMED_STREAM_FRAME
        : STANDARD_ERROR_CODES.STREAM_INTERRUPTED;
    category = ERROR_CATEGORIES.STREAMING_AND_GENERATION;
    httpStatus = 500;
    retryable = !partial;
    canFallback = !isLocalProvider;
    userMessage =
      partial
        ? 'Response stream was interrupted before completion.'
        : 'The AI streaming connection was interrupted. Please try again.';
  }
  // 12b. EMPTY RESPONSE OR STREAM COMPLETION WITHOUT OUTPUT
  else if (
    upperStatus === 'EMPTY_RESPONSE' ||
    upperStatus === 'EMPTY_STREAM_RESPONSE' ||
    upperStatus === 'UPSTREAM_SERVICE_ERROR' ||
    lowerMsg.includes('empty response') ||
    lowerMsg.includes('empty completed response') ||
    lowerMsg.includes('stream completed without returning any response')
  ) {
    code = STANDARD_ERROR_CODES.UPSTREAM_SERVICE_ERROR;
    category = ERROR_CATEGORIES.STREAMING_AND_GENERATION;
    httpStatus = 502;
    retryable = !partial;
    canFallback = !isLocalProvider;
    userMessage = 'The AI service returned an empty response. Please try again or switch providers.';
  }
  // 13. UPSTREAM SERVICE TEMPORARY OUTAGES (502 / 503)
  else if (
    httpStatus === 502 ||
    upperStatus === 'BAD_GATEWAY' ||
    lowerMsg.includes('bad gateway')
  ) {
    code = STANDARD_ERROR_CODES.BAD_GATEWAY;
    category = ERROR_CATEGORIES.UPSTREAM_API_AND_MODEL;
    httpStatus = 502;
    retryable = !partial;
    canFallback = !isLocalProvider;
    userMessage =
      'The AI gateway returned a temporary upstream error (502). Please try again in a few moments.';
  } else if (
    httpStatus === 503 ||
    upperStatus === 'UNAVAILABLE' ||
    upperStatus === 'SERVICE_UNAVAILABLE' ||
    lowerMsg.includes('high demand') ||
    lowerMsg.includes('spikes in demand') ||
    lowerMsg.includes('overloaded')
  ) {
    code = STANDARD_ERROR_CODES.SERVICE_UNAVAILABLE;
    category = ERROR_CATEGORIES.UPSTREAM_API_AND_MODEL;
    httpStatus = 503;
    retryable = !partial;
    canFallback = !isLocalProvider;
    userMessage =
      'The AI service is currently experiencing high demand. Spikes in demand are usually temporary. Please try again in a few moments.';
  }
  // 14. INVALID ARGUMENT / BAD REQUEST
  else if (httpStatus === 400 || upperStatus === 'INVALID_ARGUMENT') {
    code = STANDARD_ERROR_CODES.INVALID_ARGUMENT;
    category = ERROR_CATEGORIES.CONFIGURATION_AND_VALIDATION;
    httpStatus = 400;
    retryable = false;
    canFallback = false;
    userMessage = cleanMsg || 'Invalid request parameters provided to the AI service.';
  }
  // 15. INTERNAL SERVER ERROR (500)
  else if (httpStatus === 500 || upperStatus === 'INTERNAL') {
    code = STANDARD_ERROR_CODES.INTERNAL;
    category = ERROR_CATEGORIES.UPSTREAM_API_AND_MODEL;
    httpStatus = 500;
    retryable = false;
    canFallback = !isLocalProvider;
    userMessage =
      cleanMsg && !cleanMsg.includes('Server request failed') && cleanMsg !== 'Internal Server Error'
        ? cleanMsg
        : 'The AI service encountered an internal error. Please try again or switch providers.';
  }

  // Explicit overrides if caller provided strict flags
  if (typeof context.retryable === 'boolean') {
    retryable = context.retryable;
  } else if (isObject && typeof rawError.retryable === 'boolean') {
    retryable = rawError.retryable;
  }

  if (typeof context.canFallback === 'boolean') {
    canFallback = context.canFallback;
  } else if (isObject && typeof rawError.canFallback === 'boolean') {
    canFallback = rawError.canFallback;
  }

  // If server retries were already exhausted, never retry again automatically
  if (rawError?.serverRetriesExhausted === true) {
    retryable = false;
  }

  // CRITICAL RETRY & PARTIAL INVARIANT:
  // If partial output was emitted, retryable must strictly be false to avoid duplicating user-visible text
  if (partial) {
    retryable = false;
  }

  // CRITICAL CANCELLATION INVARIANT:
  // Cancellation is never retryable and never fallback-eligible, regardless of caller hints
  if (cancelled || code === STANDARD_ERROR_CODES.REQUEST_CANCELLED || code === STANDARD_ERROR_CODES.REQUEST_ABORTED) {
    retryable = false;
    canFallback = false;
  }

  // ENFORCE PRIVACY INVARIANT: Ollama and WebLLM must strictly have canFallback: false
  if (isLocalProvider) {
    canFallback = false;
  }

  const suggestedProviders =
    context.suggestedProviders ||
    rawError?.suggestedProviders ||
    parsedData?.suggestedProviders ||
    undefined;

  const finishReason =
    context.finishReason ||
    rawError?.finishReason ||
    parsedData?.finishReason ||
    undefined;

  return new CanonicalAIError({
    code,
    category,
    message: userMessage,
    provider,
    model,
    httpStatus,
    retryable,
    canFallback,
    cancelled,
    timeout,
    partial,
    partialText,
    requestId,
    attemptedProviders: context.attemptedProviders || rawError?.attemptedProviders || [provider],
    fallbackHistory: context.fallbackHistory || rawError?.fallbackHistory || [],
    suggestedProviders,
    finishReason,
    retryAfterSeconds,
    promptText,
    cause: isObject ? rawError : undefined
  });
}
