/**
 * Orvix AI Provider Router
 * Central dispatch service routing chat requests to the selected provider
 * (Gemini, Groq, OpenRouter, Cloudflare, Ollama, WebLLM).
 * Normalizes parameters, model identifiers, retry semantics, stream continuation, and error formats.
 */

import {
  streamWebLLMMessage,
  DEFAULT_WEBLLM_MODEL_ID,
  WebLLMError,
  WEBLLM_ERROR_CODES
} from './webllmService.js';
import {
  prepareChatRequestBody,
  sanitizeAttachmentForNetwork,
  hydrateAttachmentsWithImageBytes
} from './attachmentStorageService.js';
import { isVisionCapableProvider, isImageAttachment } from './documentContextService.js';
import {
  normalizeProviderId,
  sanitizeModelForProvider,
  normalizeProviderConfigPayload,
  getProviderConfigAvailability,
  checkModelCompatibilityForProvider,
  resolveModelForProviderSwitch,
  getDeterministicFallbackChain,
  isProviderCapableOfTask,
  PROVIDER_DEFAULT_MODELS
} from './providerModelSanitizer.js';
import {
  sanitizeErrorMessage,
  normalizeAIError,
  isCanonicalAIError,
  CanonicalAIError,
  isAbortLike,
  STANDARD_ERROR_CODES
} from './errorNormalizationService.js';

export const AI_PROVIDERS = {
  GEMINI: 'gemini',
  GROQ: 'groq',
  OPENROUTER: 'openrouter',
  CLOUDFLARE: 'cloudflare',
  OLLAMA: 'ollama',
  WEBLLM: 'webllm'
};

export const PROVIDER_OPTIONS = [
  {
    id: AI_PROVIDERS.GEMINI,
    name: 'Gemini',
    modelTag: 'Gemini 2.5 Flash',
    defaultModel: 'gemini-2.5-flash',
    description: 'Google Gemini'
  },
  {
    id: AI_PROVIDERS.GROQ,
    name: 'Groq',
    modelTag: 'GPT OSS 120B',
    defaultModel: 'openai/gpt-oss-120b',
    description: 'Ultra-fast inference'
  },
  {
    id: AI_PROVIDERS.OPENROUTER,
    name: 'OpenRouter',
    modelTag: 'Free Models Router',
    defaultModel: 'openrouter/free',
    description: 'Dynamic free-tier model router (openrouter/free)'
  },
  {
    id: AI_PROVIDERS.CLOUDFLARE,
    name: 'Cloudflare Workers AI',
    shortName: 'Cloudflare AI',
    modelTag: 'Llama 3.1 8B',
    defaultModel: '@cf/meta/llama-3.1-8b-instruct',
    description: 'Serverless inference',
    label: 'Cloudflare Workers AI — Llama 3.1 8B'
  },
  {
    id: AI_PROVIDERS.OLLAMA,
    name: 'Local AI (Ollama)',
    shortName: 'Ollama',
    modelTag: 'Qwen 2.5 1.5B',
    defaultModel: 'qwen2.5:1.5b',
    description: 'Local offline inference',
    label: 'Local AI (Ollama) — Qwen 2.5 1.5B'
  },
  {
    id: AI_PROVIDERS.WEBLLM,
    name: 'Browser AI (WebLLM)',
    shortName: 'Browser AI',
    modelTag: 'Qwen 2.5 1.5B',
    defaultModel: DEFAULT_WEBLLM_MODEL_ID,
    description: 'On-device WebGPU inference',
    label: 'Browser AI (WebLLM) — Qwen 2.5 1.5B'
  }
];

export const DEFAULT_PROVIDER = AI_PROVIDERS.GEMINI;

/**
 * Cached `/api/config` availability snapshot (boolean-only, never stores secrets).
 */
let cachedProviderConfigState = {
  status: 'idle',
  data: null,
  fetchedAt: null
};

let inflightConfigPromise = null;

/**
 * Returns the latest cached `/api/config` availability state.
 * @returns {{ status: 'idle'|'loading'|'ready'|'error', data: Object|null, fetchedAt: number|null }}
 */
export function getCachedProviderConfig() {
  return cachedProviderConfigState;
}

/**
 * Resets cached `/api/config` state (primarily for deterministic testing).
 */
export function resetCachedProviderConfig() {
  cachedProviderConfigState = {
    status: 'idle',
    data: null,
    fetchedAt: null
  };
  inflightConfigPromise = null;
}

/**
 * Fetches `/api/config` safely to determine server-side provider availability.
 * Never throws on network or HTTP failures — degrades gracefully to `'unknown'`/`'error'`
 * so the UI never falsely claims cloud providers are unconfigured when `/api/config` is unreachable.
 *
 * @param {Object} [options={}]
 * @param {AbortSignal} [options.signal]
 * @param {boolean} [options.forceRefresh=false]
 * @returns {Promise<{ status: 'ready'|'error', data: Object|null, fetchedAt: number|null }>}
 */
export async function fetchProviderConfig({ signal, forceRefresh = false } = {}) {
  if (!forceRefresh && cachedProviderConfigState.status === 'ready' && cachedProviderConfigState.data) {
    return cachedProviderConfigState;
  }

  if (!forceRefresh && inflightConfigPromise && !signal) {
    return inflightConfigPromise;
  }

  const runFetch = async () => {
    try {
      const res = await fetch('/api/config', {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal
      });

      if (!res.ok) {
        cachedProviderConfigState = {
          status: 'error',
          data: cachedProviderConfigState.data,
          fetchedAt: cachedProviderConfigState.fetchedAt
        };
        return cachedProviderConfigState;
      }

      const raw = await res.json().catch(() => null);
      const normalized = normalizeProviderConfigPayload(raw);
      if (!normalized) {
        cachedProviderConfigState = {
          status: 'unavailable',
          data: cachedProviderConfigState.data,
          fetchedAt: cachedProviderConfigState.fetchedAt
        };
        return cachedProviderConfigState;
      }

      cachedProviderConfigState = {
        status: 'ready',
        data: normalized,
        fetchedAt: Date.now()
      };
      return cachedProviderConfigState;
    } catch (_) {
      cachedProviderConfigState = {
        status: 'unavailable',
        data: cachedProviderConfigState.data,
        fetchedAt: cachedProviderConfigState.fetchedAt
      };
      return cachedProviderConfigState;
    } finally {
      if (!signal) {
        inflightConfigPromise = null;
      }
    }
  };

  if (!signal) {
    inflightConfigPromise = runFetch();
    return inflightConfigPromise;
  }
  return runFetch();
}

/**
 * Checks if a given provider is confirmed configured according to `/api/config` (or local execution).
 * Returns `true` for local providers (`ollama`, `webllm`) and confirmed-configured cloud providers.
 * Returns `false` when `/api/config` reports the cloud provider is unconfigured or when config has not loaded.
 * Use `getProviderConfigAvailability()` when UI needs to distinguish `'unconfigured'` from `'unknown'`.
 *
 * @param {string} provider
 * @param {Object|null} [configStateOverride=null]
 * @returns {boolean}
 */
export function isProviderConfigured(provider, configStateOverride = null) {
  const availability = getProviderConfigAvailability(
    provider,
    configStateOverride || cachedProviderConfigState
  );
  return (
    availability.state === 'configured' ||
    availability.state === 'local' ||
    availability.state === 'demo'
  );
}

/**
 * Parses raw error representations into clean, structured error objects while honoring
 * explicit server metadata (`status`, `retryable: false`, `canFallback`, `suggestedProviders`).
 */
export function parseRouterError(rawError, statusCode = 500, providerHint = null) {
  const isObjectInput = rawError !== null && typeof rawError === 'object';
  let cleanMsg =
    typeof rawError === 'string'
      ? rawError
      : typeof rawError?.error === 'string'
      ? rawError.error
      : rawError?.message || '';
  let code = Number(rawError?.code || statusCode || 500);
  let status = String(rawError?.status || rawError?.errorCode || '');
  const explicitRetryable =
    isObjectInput && typeof rawError.retryable === 'boolean' ? rawError.retryable : undefined;
  let retryable = explicitRetryable;
  const normalizedHint = providerHint ? normalizeProviderId(providerHint) : '';

  // Unpack nested JSON representations if present
  for (let i = 0; i < 3; i++) {
    if (typeof cleanMsg !== 'string') break;
    const match = cleanMsg.match(/\{[\s\S]*\}/);
    if (!match) break;
    try {
      const parsed = JSON.parse(match[0]);
      if (parsed.error) {
        if (parsed.error.code) code = Number(parsed.error.code);
        if (parsed.error.status) status = String(parsed.error.status);
        if (typeof parsed.error === 'string') {
          cleanMsg = parsed.error;
          if (parsed.status) status = String(parsed.status);
          if (parsed.code) code = Number(parsed.code);
          break;
        } else if (parsed.error.message) {
          cleanMsg = String(parsed.error.message);
        } else {
          break;
        }
      } else {
        break;
      }
    } catch (_) {
      break;
    }
  }

  const lowerMsg = String(cleanMsg).toLowerCase();
  const upperStatus = String(status).toUpperCase();

  // 1. Explicit unconfigured provider error (never overwrite with generic 503 "high demand" copy)
  if (upperStatus === 'PROVIDER_NOT_CONFIGURED') {
    code = Number.isFinite(code) && code >= 400 ? code : 503;
    status = 'PROVIDER_NOT_CONFIGURED';
    retryable = false;
    if (!cleanMsg) {
      cleanMsg =
        'This AI provider is not configured on the server. Please select a configured provider or configure the required server environment credentials.';
    }
    const err = new Error(cleanMsg);
    err.code = code;
    err.status = status;
    err.errorCode = 'PROVIDER_NOT_CONFIGURED';
    err.retryable = false;
    err.canFallback = isObjectInput && typeof rawError.canFallback === 'boolean' ? rawError.canFallback : true;
    err.provider = (isObjectInput && rawError.provider) || normalizedHint || DEFAULT_PROVIDER;
    if (isObjectInput && Array.isArray(rawError.suggestedProviders)) {
      err.suggestedProviders = rawError.suggestedProviders;
    }
    return err;
  }

  // 2. Explicit invalid / cross-provider model identifier error
  if (upperStatus === 'INVALID_MODEL') {
    code = 400;
    status = 'INVALID_MODEL';
    retryable = false;
    if (!cleanMsg) {
      cleanMsg = 'The requested model identifier is not valid for the selected AI provider.';
    }
    const err = new Error(cleanMsg);
    err.code = code;
    err.status = status;
    err.errorCode = 'INVALID_MODEL';
    err.retryable = false;
    err.canFallback = false;
    err.provider = (isObjectInput && rawError.provider) || normalizedHint || DEFAULT_PROVIDER;
    return err;
  }

  // Distinct network failure classification
  const isNetwork =
    lowerMsg === 'fetch failed' ||
    lowerMsg === 'failed to fetch' ||
    lowerMsg.includes('econnrefused') ||
    lowerMsg.includes('enotfound') ||
    lowerMsg.includes('network error') ||
    lowerMsg.includes('network_failure') ||
    upperStatus === 'NETWORK_FAILURE' ||
    upperStatus === 'NETWORK_ERROR';

  const isOllamaContext =
    normalizedHint === AI_PROVIDERS.OLLAMA ||
    lowerMsg.includes('11434') ||
    lowerMsg.includes('ollama');

  const isWebLLMContext =
    normalizedHint === AI_PROVIDERS.WEBLLM ||
    (isObjectInput && normalizeProviderId(rawError.provider) === AI_PROVIDERS.WEBLLM) ||
    lowerMsg.includes('webllm') ||
    lowerMsg.includes('browser ai') ||
    upperStatus.startsWith('WEBLLM_') ||
    upperStatus.startsWith('WEBGPU_');

  // 3. Dedicated Ollama local connection, timeout, & missing model handling
  if (isOllamaContext) {
    if (code === 504 || upperStatus === 'DEADLINE_EXCEEDED') {
      code = 504;
      status = 'DEADLINE_EXCEEDED';
      retryable = false;
      if (!cleanMsg || cleanMsg.includes('Server request failed')) {
        cleanMsg =
          'Local AI (Ollama) timed out while waiting for response headers. Verify Ollama is responsive at http://127.0.0.1:11434.';
      }
    } else {
      code = code === 404 ? 404 : code === 400 ? 400 : 503;
      status = (isObjectInput && rawError.status) ? String(rawError.status) : (code === 404 ? 'NOT_FOUND' : code === 400 ? 'INVALID_ARGUMENT' : 'NETWORK_ERROR');
      retryable = false;
      const isGeneric =
        !cleanMsg ||
        cleanMsg === 'Service Unavailable' ||
        cleanMsg === 'Bad Gateway' ||
        cleanMsg === 'Not Found' ||
        cleanMsg.includes('Server request failed') ||
        cleanMsg.includes('Stream connection was closed');
      if (isGeneric || (!cleanMsg.includes('Unable to connect') && (lowerMsg === 'failed to fetch' || lowerMsg === 'fetch failed'))) {
        if (code === 404 || (code !== 503 && (lowerMsg.includes('not found') || lowerMsg.includes('model not found')))) {
          cleanMsg =
            'The requested Ollama model was not found. Please ensure it is installed locally using "ollama pull qwen2.5:1.5b".';
        } else if (lowerMsg === 'failed to fetch' || lowerMsg === 'fetch failed') {
          cleanMsg =
            'Local AI (Ollama) requires the local Orvix backend server and Ollama daemon. Please verify the local server is running and Ollama is active at http://127.0.0.1:11434.';
        } else {
          cleanMsg =
            'Unable to connect to Local AI (Ollama) at http://127.0.0.1:11434. Please ensure Ollama is running ("ollama serve") and model "qwen2.5:1.5b" is installed.';
        }
      }
    }
  } else if (isNetwork) {
    code = code === 500 ? 503 : code;
    status = 'NETWORK_ERROR';
    retryable = explicitRetryable ?? true;
    cleanMsg =
      'Unable to establish network connection with the AI service. Please check your internet connection or try again in a few moments.';
  } else if (
    code === 502 ||
    upperStatus === 'BAD_GATEWAY'
  ) {
    code = 502;
    status = 'BAD_GATEWAY';
    retryable = explicitRetryable ?? true;
    if (!cleanMsg || cleanMsg === 'Bad Gateway' || cleanMsg.includes('Server request failed (502)')) {
      cleanMsg =
        'The AI gateway returned a temporary upstream error (502). Please try again in a few moments.';
    }
  } else if (
    code === 503 ||
    upperStatus === 'UNAVAILABLE' ||
    (lowerMsg.includes('high demand') && !lowerMsg.includes('500')) ||
    (lowerMsg.includes('spikes in demand') && !lowerMsg.includes('500')) ||
    lowerMsg.includes('overloaded')
  ) {
    code = 503;
    status = status && upperStatus !== 'UNAVAILABLE' && explicitRetryable === false ? status : 'UNAVAILABLE';
    retryable = explicitRetryable ?? true;
    if (explicitRetryable !== false) {
      cleanMsg =
        'The AI service is currently experiencing high demand. Spikes in demand are usually temporary. Please try again in a few moments.';
    }
  } else if (
    code === 429 ||
    upperStatus === 'RESOURCE_EXHAUSTED' ||
    lowerMsg.includes('rate limit') ||
    lowerMsg.includes('quota')
  ) {
    code = 429;
    status = 'RESOURCE_EXHAUSTED';
    retryable = explicitRetryable ?? true;
    cleanMsg = 'AI rate limit or quota exceeded. Please wait a moment before trying again.';
  } else if (
    code === 401 ||
    code === 403 ||
    upperStatus === 'UNAUTHENTICATED' ||
    upperStatus === 'PERMISSION_DENIED' ||
    lowerMsg.includes('api_key_invalid') ||
    lowerMsg.includes('api key not valid') ||
    lowerMsg.includes('unauthorized') ||
    lowerMsg.includes('permission denied')
  ) {
    code = code === 401 ? 401 : 403;
    status = code === 401 ? 'UNAUTHENTICATED' : 'PERMISSION_DENIED';
    retryable = false;
    if (!cleanMsg || !lowerMsg.includes('cloudflare')) {
      cleanMsg = 'Invalid or unauthorized API key. Please check your configuration.';
    }
  } else if (code === 404 || upperStatus === 'NOT_FOUND') {
    code = 404;
    status = 'NOT_FOUND';
    retryable = false;
    if (!cleanMsg || cleanMsg === 'Not Found' || cleanMsg.includes('Server request failed (404)')) {
      cleanMsg =
        'The requested AI model was not found or is no longer available. Please select another provider or model.';
    }
  } else if (
    code === 413 ||
    upperStatus === 'PAYLOAD_TOO_LARGE' ||
    lowerMsg.includes('payload too large') ||
    lowerMsg.includes('request entity too large') ||
    lowerMsg.includes('entity.too.large') ||
    lowerMsg.includes('function_payload_too_large')
  ) {
    code = 413;
    status = 'PAYLOAD_TOO_LARGE';
    retryable = false;
    if (
      !cleanMsg ||
      cleanMsg === 'Payload Too Large' ||
      cleanMsg === 'Request Entity Too Large' ||
      cleanMsg.includes('Server request failed (413)')
    ) {
      cleanMsg =
        'The attached image payload exceeds the supported request budget (3.0 MB max per image, 4.2 MB max total request). Please resize or compress the image and try again.';
    }
  } else if (upperStatus === 'SAFETY_BLOCKED' || lowerMsg.includes('safety')) {
    code = 400;
    status = 'SAFETY_BLOCKED';
    retryable = false;
    if (!cleanMsg || cleanMsg.includes('Server request failed')) {
      cleanMsg = "The response was blocked by Google Gemini's safety filters. Please rephrase your request.";
    }
  } else if (upperStatus === 'CONTEXT_LENGTH_EXCEEDED') {
    code = 400;
    status = 'CONTEXT_LENGTH_EXCEEDED';
    retryable = false;
  } else if (code === 400 || upperStatus === 'INVALID_ARGUMENT') {
    code = 400;
    status = 'INVALID_ARGUMENT';
    retryable = false;
  } else if (code === 504 || upperStatus === 'DEADLINE_EXCEEDED') {
    code = 504;
    status = 'DEADLINE_EXCEEDED';
    retryable = explicitRetryable ?? true;
    if (explicitRetryable !== false) {
      cleanMsg = 'The AI service timed out while waiting for a response. Please try again.';
    }
  } else if (code === 500 || upperStatus === 'INTERNAL') {
    code = 500;
    status = 'INTERNAL';
    retryable = explicitRetryable ?? false;
    if (!cleanMsg || cleanMsg === 'Internal Server Error' || cleanMsg.includes('Server request failed (500)')) {
      cleanMsg = 'The AI service encountered an internal error. Please try again or switch providers.';
    }
  }

  const sanitizedMsg = sanitizeErrorMessage(
    cleanMsg || 'An unexpected error occurred while communicating with the AI service.'
  );
  const err = new Error(sanitizedMsg);
  err.code = code;
  err.httpStatus = Number.isFinite(code) && code >= 400 && code <= 599 ? code : 500;
  err.status = status;
  err.errorCode = isObjectInput && rawError.errorCode ? String(rawError.errorCode) : status;
  err.timeout = code === 504 || status === 'DEADLINE_EXCEEDED';
  err.cancelled = false;
  err.partial = Boolean(rawError?.partial);
  err.partialText = typeof rawError?.partialText === 'string' ? rawError.partialText : '';
  if (err.partial || (typeof err.partialText === 'string' && err.partialText.trim().length > 0)) {
    err.retryable = false;
  } else if (explicitRetryable === false || isOllamaContext) {
    err.retryable = false;
  } else if (typeof explicitRetryable === 'boolean') {
    err.retryable = explicitRetryable;
  } else {
    err.retryable = Boolean(retryable ?? (code === 502 || code === 503 || code === 504 || code === 429));
  }

  if (isOllamaContext) {
    err.provider = AI_PROVIDERS.OLLAMA;
    err.canFallback = false;
  } else if (isWebLLMContext) {
    err.provider = AI_PROVIDERS.WEBLLM;
    err.canFallback = false;
  } else if (code === 413 || status === 'PAYLOAD_TOO_LARGE') {
    if (normalizedHint) err.provider = normalizedHint;
    err.canFallback = false;
  } else {
    if (normalizedHint) err.provider = normalizedHint;
    const defaultCanFallback = !isOllamaContext && !isWebLLMContext && code !== 400 && code !== 413;
    err.canFallback =
      isObjectInput && typeof rawError.canFallback === 'boolean'
        ? rawError.canFallback
        : defaultCanFallback;
  }
  if (isObjectInput && typeof rawError.canFallback === 'boolean') {
    // Local privacy invariant: Ollama and WebLLM must NEVER have canFallback: true
    if (!isOllamaContext && !isWebLLMContext) {
      err.canFallback = rawError.canFallback;
    } else {
      err.canFallback = false;
    }
  }
  // Enforce strict invariants: partial output, cancellation, and local providers can never fallback
  if (err.partial || err.cancelled || isOllamaContext || isWebLLMContext) {
    err.canFallback = false;
    if (err.partial || err.cancelled) {
      err.retryable = false;
    }
  }
  if (isObjectInput && Array.isArray(rawError.suggestedProviders)) {
    err.suggestedProviders = rawError.suggestedProviders;
  }
  if (isObjectInput && rawError.finishReason) {
    err.finishReason = rawError.finishReason;
  }
  if (isObjectInput && rawError.serverRetriesExhausted === true) {
    err.serverRetriesExhausted = true;
    err.retryable = false;
  }
  return err;
}

function createRouterAbortError(cause = null) {
  if (cause && cause.name === 'AbortError') {
    return cause;
  }
  const abortErr = new Error('Generation cancelled by user.');
  abortErr.name = 'AbortError';
  return abortErr;
}

/**
 * Prepares attachment payloads for automatic stream continuation so document/OCR extraction
 * metadata and Gemini vision bytes are preserved across Part 1 -> Part 2 boundaries without
 * duplicating payloads inside `history` or exceeding size limits.
 */
async function prepareAttachmentsForContinuation(attachments, targetProvider, targetModel) {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return [];
  }
  if (isVisionCapableProvider(targetProvider, targetModel)) {
    return hydrateAttachmentsWithImageBytes(attachments, {
      provider: targetProvider,
      model: targetModel
    });
  }
  return attachments.map((att) =>
    sanitizeAttachmentForNetwork(att, { includeImageBytes: false })
  );
}

/**
 * Streams chat responses from the selected AI provider progressively.
 *
 * @param {Object} params
 * @param {string} [params.provider='gemini']
 * @param {string|null} [params.model=null]
 * @param {string} [params.mode='general']
 * @param {string} params.prompt
 * @param {Array} [params.history=[]]
 * @param {string|null} [params.username=null]
 * @param {Object|null} [params.preferences=null]
 * @param {(chunkText: string, accumulatedText: string) => void} [params.onChunk]
 * @param {({ modelUsed: string, provider: string, isDemo?: boolean }) => void} [params.onStart]
 * @param {AbortSignal} [params.signal]
 * @param {() => boolean} [params.isRequestActive]
 * @param {string|null} [params.conversationId=null]
 * @param {Array} [params.attachments=[]]
 * @param {boolean} [params.isContinuation=false]
 * @param {number} [params.partNumber=1]
 * @param {string|null} [params.originalPrompt=null]
 * @param {string|null} [params.previousContentSummary=null]
 * @param {string} [params.chatEndpoint='/api/chat']
 * @param {number} [params.retryBaseDelayMs=600]
 * @returns {Promise<{ text: string, modelUsed: string, provider: string, isDemo?: boolean }>}
 */
export async function streamAIMessage(params = {}) {
  if (params?.autoFallback === true) {
    return streamAIMessageWithFallback(params);
  }

  const {
    provider = DEFAULT_PROVIDER,
    model = null,
    mode = 'general',
    prompt,
    history = [],
    username = null,
    preferences = null,
    onChunk,
    onStart,
    signal,
    isRequestActive = null,
    conversationId = null,
    attachments = [],
    isContinuation = false,
    partNumber = 1,
    originalPrompt = null,
    previousContentSummary = null,
    chatEndpoint = '/api/chat',
    retryBaseDelayMs = 600
  } = params || {};

  const normalizedProvider = normalizeProviderId(provider);
  const normalizedMode = (mode || 'general').toLowerCase();
  const sanitizedModel = sanitizeModelForProvider(normalizedProvider, model);
  const isActive = () =>
    !signal?.aborted && (typeof isRequestActive !== 'function' || Boolean(isRequestActive()));

  if (!isActive()) {
    throw createRouterAbortError();
  }

  // Strictly local browser inference: route Browser AI (WebLLM) directly to webllmService.js.
  // Never send Browser AI requests to /api/chat, Ollama, Firebase, or any cloud provider.
  if (normalizedProvider === AI_PROVIDERS.WEBLLM) {
    if (model && typeof model === 'string' && model.trim()) {
      const compat = checkModelCompatibilityForProvider('webllm', model.trim());
      if (!compat.compatible) {
        throw new WebLLMError(
          compat.reason || `Model "${model.trim()}" is not valid for Browser AI (WebLLM).`,
          {
            code: WEBLLM_ERROR_CODES.UNSUPPORTED_MODEL,
            httpCode: 400,
            retryable: false
          }
        );
      }
    }

    let effectivePrompt = prompt;
    if (isContinuation) {
      const contHeader = originalPrompt
        ? `[Continuation Request — Part ${partNumber || 2} for original prompt: "${originalPrompt}"]\n`
        : `[Continuation Request — Part ${partNumber || 2}]\n`;
      const tailContext = previousContentSummary
        ? `Previous section ended with:\n"""\n${previousContentSummary}\n"""\n`
        : '';
      effectivePrompt = `${contHeader}${tailContext}Continue directly from where the previous response stopped without repeating prior text.\n\nUser request: ${prompt}`;
    }

    return streamWebLLMMessage({
      prompt: effectivePrompt,
      history,
      username: username ? String(username).trim() : null,
      preferences: preferences || null,
      mode: normalizedMode,
      model: sanitizedModel,
      attachments: Array.isArray(attachments)
        ? attachments.map((att) => sanitizeAttachmentForNetwork(att, { includeImageBytes: false }))
        : [],
      onStart: (info) => {
        if (!isActive()) return;
        onStart?.(info);
      },
      onChunk: (chunkText, acc) => {
        if (!isActive()) return;
        onChunk?.(chunkText, acc);
      },
      signal
    });
  }

  // Primary path: Use server-side proxy route /api/chat with SSE.
  // Allow at most 1 bounded retry (2 total attempts) ONLY for genuine transient errors
  // where `retryable !== false` and server-side multi-attempt retries were not already exhausted.
  const maxClientAttempts = 2;
  let clientAttempt = 0;

  while (clientAttempt < maxClientAttempts) {
    clientAttempt++;
    try {
      if (!isActive()) {
        throw createRouterAbortError();
      }

      const requestBody = prepareChatRequestBody({
        provider: normalizedProvider,
        model: sanitizedModel,
        mode: normalizedMode,
        prompt,
        history,
        username: username ? String(username).trim() : null,
        preferences: preferences || null,
        stream: true,
        conversationId: conversationId || null,
        attachments: Array.isArray(attachments) ? attachments : [],
        isContinuation: Boolean(isContinuation),
        partNumber: partNumber || 1,
        originalPrompt: originalPrompt || null,
        previousContentSummary: previousContentSummary || null
      });

      const res = await fetch(chatEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream'
        },
        body: requestBody,
        signal
      });

      if (!isActive()) {
        try {
          void res.body?.cancel?.().catch(() => {});
        } catch (_) {}
        throw createRouterAbortError();
      }

      if (!res.ok) {
        // Parse structured JSON error payload BEFORE making any retry decision
        const errJson = await res.json().catch(() => null);
        if (!isActive()) {
          throw createRouterAbortError();
        }

        const parsedErr = parseRouterError(
          errJson || `Server request failed (${res.status})`,
          res.status,
          normalizedProvider
        );

        if (errJson?.code) parsedErr.code = errJson.code;
        if (errJson?.status) parsedErr.status = errJson.status;
        if (errJson?.errorCode) parsedErr.errorCode = errJson.errorCode;
        if (typeof errJson?.retryable === 'boolean') {
          parsedErr.retryable = errJson.retryable;
        }
        if (errJson?.serverRetriesExhausted) {
          parsedErr.serverRetriesExhausted = true;
          parsedErr.retryable = false;
        }
        parsedErr.provider = errJson?.provider || errJson?.error?.provider || normalizedProvider;
        if (typeof errJson?.canFallback === 'boolean') {
          parsedErr.canFallback = errJson.canFallback;
        } else if (normalizedProvider === AI_PROVIDERS.OLLAMA) {
          parsedErr.canFallback = false;
        }
        if (Array.isArray(errJson?.suggestedProviders)) {
          parsedErr.suggestedProviders = errJson.suggestedProviders;
        }

        throw parsedErr;
      }

      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('text/event-stream') && res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let accumulatedText = '';
        let modelUsed = null;
        let finalProvider = normalizedProvider;
        let isDemoResponse = false;
        let receivedDone = false;

        const onSignalAbort = () => {
          try {
            void reader.cancel().catch(() => {});
          } catch (_) {}
        };

        if (signal) {
          if (signal.aborted) {
            onSignalAbort();
            try {
              reader.releaseLock();
            } catch (_) {}
            throw createRouterAbortError();
          }
          signal.addEventListener('abort', onSignalAbort, { once: true });
        }

        const handleSSELine = (line) => {
          if (!isActive()) {
            throw createRouterAbortError();
          }
          const trimmed = line.trim();
          // Transparently ignore keep-alive heartbeats (lines starting with ':') and blank lines
          if (!trimmed || trimmed.startsWith(':')) return null;
          if (!trimmed.startsWith('data:')) return null;
          const dataStr = trimmed.slice(5).trim();
          if (dataStr === '[DONE]') {
            receivedDone = true;
            return { done: true };
          }
          try {
            const data = JSON.parse(dataStr);
            if (data.type === 'start') {
              if (!isActive()) {
                throw createRouterAbortError();
              }
              modelUsed = data.modelUsed;
              finalProvider = data.provider || normalizedProvider;
              if (data.isDemo) isDemoResponse = true;
              onStart?.({ modelUsed, provider: finalProvider, isDemo: isDemoResponse });
            } else if (data.type === 'chunk' && data.text) {
              if (!isActive()) {
                throw createRouterAbortError();
              }
              accumulatedText += data.text;
              onChunk?.(data.text, accumulatedText);
            } else if (data.type === 'done') {
              if (!isActive()) {
                throw createRouterAbortError();
              }
              receivedDone = true;
              if (data.modelUsed) modelUsed = data.modelUsed;
              if (data.provider) finalProvider = data.provider;
              if (data.isDemo) isDemoResponse = true;
              const finalText = data.text || accumulatedText;
              return {
                done: true,
                result: {
                  text: finalText,
                  modelUsed: modelUsed || 'AI Model',
                  provider: finalProvider,
                  ...(isDemoResponse ? { isDemo: true } : {})
                }
              };
            } else if (data.type === 'error') {
              if (!isActive()) {
                throw createRouterAbortError();
              }
              const streamErr = parseRouterError(
                data,
                data.code || 500,
                data.provider || normalizedProvider
              );
              if (data.code) streamErr.code = data.code;
              if (data.status) streamErr.status = data.status;
              if (data.errorCode) {
                streamErr.errorCode = data.errorCode;
              } else if (streamErr.status && !streamErr.errorCode) {
                streamErr.errorCode = streamErr.status;
              }
              if (data.model) streamErr.model = data.model;
              if (typeof data.retryable === 'boolean') streamErr.retryable = data.retryable;
              if (typeof data.canFallback === 'boolean') streamErr.canFallback = data.canFallback;
              if (Array.isArray(data.suggestedProviders)) {
                streamErr.suggestedProviders = data.suggestedProviders;
              }
              if (typeof data.partial === 'boolean') {
                streamErr.partial = data.partial;
              }
              if (typeof data.partialText === 'string') {
                streamErr.partialText = data.partialText;
              }
              // Never auto-retry at the router layer if partial stream tokens were already emitted
              if (accumulatedText.length > 0) {
                streamErr.retryable = false;
                streamErr.partial = true;
                if (!streamErr.partialText) {
                  streamErr.partialText = accumulatedText;
                }
              }
              streamErr.provider = data.provider || normalizedProvider;
              throw streamErr;
            }
          } catch (jsonErr) {
            if (jsonErr?.name === 'AbortError') {
              throw jsonErr;
            }
            if (jsonErr.message && !jsonErr.message.includes('JSON')) {
              throw jsonErr;
            }
          }
          return null;
        };

        try {
          while (true) {
            if (!isActive()) {
              throw createRouterAbortError();
            }
            const { done, value } = await reader.read();
            if (!isActive()) {
              throw createRouterAbortError();
            }
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              const lineRes = handleSSELine(line);
              if (lineRes?.result) {
                return lineRes.result;
              }
            }
          }

          // Never process trailing buffered bytes or trigger auto-continuation if cancelled/superseded
          if (!isActive()) {
            throw createRouterAbortError();
          }

          // Process any trailing bytes and buffered events
          const finalDecoded = decoder.decode();
          if (finalDecoded) {
            buffer += finalDecoded;
          }
          if (buffer) {
            const trailingLines = buffer.split('\n');
            for (const tLine of trailingLines) {
              const lineRes = handleSSELine(tLine);
              if (lineRes?.result) {
                return lineRes.result;
              }
            }
          }

          if (!isActive()) {
            throw createRouterAbortError();
          }

          // If standard completion was signaled
          if (receivedDone) {
            return {
              text: accumulatedText,
              modelUsed: modelUsed || 'AI Model',
              provider: finalProvider,
              ...(isDemoResponse ? { isDemo: true } : {})
            };
          }

          // If the connection was abruptly dropped mid-stream (e.g. serverless execution limit
          // or intermediate network drop), seamlessly continue generation ONLY if the request is still active
          // while preserving original document/OCR/vision attachments safely:
          if (isActive() && accumulatedText.length > 0 && (partNumber || 1) < 10) {
            const contProvider = normalizeProviderId(finalProvider || normalizedProvider);
            const contModel =
              sanitizeModelForProvider(contProvider, modelUsed) ||
              sanitizeModelForProvider(contProvider, model);

            const continuationAttachments = await prepareAttachmentsForContinuation(
              attachments,
              contProvider,
              contModel
            );

            if (!isActive()) {
              throw createRouterAbortError();
            }

            const basePrefix = accumulatedText;
            const continuationPrompt =
              'Please continue directly from where you stopped. Complete any unfinished sentences, items, or sections without repeating previous text.';
            const contResult = await streamAIMessage({
              provider: contProvider,
              model: contModel,
              mode: normalizedMode,
              prompt: continuationPrompt,
              history: [
                ...history,
                { sender: 'user', content: prompt },
                { sender: 'assistant', content: basePrefix }
              ],
              username,
              preferences,
              onChunk: (chunkText) => {
                if (!isActive()) return;
                accumulatedText += chunkText;
                onChunk?.(chunkText, accumulatedText);
              },
              onStart: (info) => {
                if (!isActive()) return;
                if (info?.modelUsed) modelUsed = info.modelUsed;
              },
              signal,
              isRequestActive,
              conversationId,
              attachments: continuationAttachments,
              isContinuation: true,
              partNumber: (partNumber || 1) + 1,
              originalPrompt: originalPrompt || prompt,
              previousContentSummary: basePrefix.slice(-300),
              chatEndpoint,
              retryBaseDelayMs
            });

            if (!isActive()) {
              throw createRouterAbortError();
            }

            const mergedText =
              typeof contResult?.text === 'string' &&
              contResult.text.length >= accumulatedText.length - basePrefix.length
                ? basePrefix + contResult.text
                : accumulatedText;

            return {
              ...contResult,
              text: mergedText,
              modelUsed: contResult?.modelUsed || modelUsed || 'AI Model',
              provider: contResult?.provider || finalProvider
            };
          }

          if (!accumulatedText && !receivedDone) {
            throw parseRouterError(
              'Stream connection was closed before response data was received.',
              503,
              finalProvider || normalizedProvider
            );
          }

          return {
            text: accumulatedText,
            modelUsed: modelUsed || 'AI Model',
            provider: finalProvider,
            ...(isDemoResponse ? { isDemo: true } : {})
          };
        } finally {
          if (signal) {
            signal.removeEventListener('abort', onSignalAbort);
          }
          try {
            reader.releaseLock();
          } catch (_) {}
        }
      } else {
        // Non-streaming JSON response
        const data = await res.json();
        if (!isActive()) {
          throw createRouterAbortError();
        }
        onChunk?.(data.text, data.text);
        return {
          text: data.text,
          modelUsed: data.modelUsed,
          provider: data.provider || normalizedProvider,
          ...(data.isDemo ? { isDemo: true } : {})
        };
      }
    } catch (apiErr) {
      if (!isActive() || apiErr?.name === 'AbortError') {
        throw createRouterAbortError(apiErr);
      }

      // Normalize raw fetch TypeError before evaluating retry eligibility
      let normalizedErr = apiErr;
      if (apiErr?.name === 'TypeError' && !apiErr.status) {
        normalizedErr = parseRouterError(
          apiErr.message || 'fetch failed',
          503,
          normalizedProvider
        );
        normalizedErr.provider = normalizedProvider;
        normalizedErr.isNetworkError = true;
      }

      const canRetryTransient =
        normalizedErr?.retryable === true &&
        !normalizedErr?.serverRetriesExhausted &&
        clientAttempt < maxClientAttempts;

      if (canRetryTransient) {
        const baseMs = Math.max(0, Number(retryBaseDelayMs) || 0);
        const delay = baseMs > 0 ? baseMs + Math.random() * Math.min(250, baseMs) : 0;
        if (delay > 0) {
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, delay);
            if (signal) {
              signal.addEventListener(
                'abort',
                () => {
                  clearTimeout(timer);
                  resolve(undefined);
                },
                { once: true }
              );
            }
          });
        }
        if (!isActive()) {
          throw createRouterAbortError();
        }
        continue;
      }

      if (
        normalizedErr?.retryable === true &&
        !normalizedErr?.serverRetriesExhausted &&
        clientAttempt >= maxClientAttempts
      ) {
        normalizedErr.retriesExhausted = true;
      }

      throw normalizedErr;
    }
  }

  throw createRouterAbortError();
}

/**
 * Common entry point for sending chat messages to the selected AI provider.
 * Maintained for interface compatibility; internally streams or resolves the full response.
 *
 * @param {Object} params
 * @returns {Promise<{ text: string, modelUsed: string, provider: string, isDemo?: boolean }>}
 */
export async function sendAIMessage(params) {
  if (params?.autoFallback === true) {
    return streamAIMessageWithFallback(params);
  }
  return streamAIMessage(params);
}

/**
 * Re-exports model switching and fallback chain helpers for consumers.
 */
export { resolveModelForProviderSwitch, getDeterministicFallbackChain };

/**
 * Evaluates whether an error is eligible to trigger automated provider fallback.
 *
 * Strict policy:
 * - CANNOT fallback if cancelled, aborted, or superseded.
 * - CANNOT fallback if partial output has already been emitted (prevents duplicate text).
 * - CANNOT fallback if provider is local (Ollama or WebLLM) — strict local privacy boundary.
 * - CANNOT fallback if error is non-fallback (400, 401, 403, 413, invalid model, safety, quota, context length).
 * - CANNOT fallback if canFallback !== true.
 * - MAY fallback on transient 500, 502, 503, 504, timeout, network failure, or retry-exhausted provider outages.
 *
 * @param {any} error
 * @param {Object} [options={}]
 * @param {AbortSignal} [options.signal=null]
 * @param {() => boolean} [options.isRequestActive=null]
 * @param {boolean} [options.hasPartialOutput=false]
 * @returns {boolean}
 */
export function isFallbackEligible(error, { signal = null, isRequestActive = null, hasPartialOutput = false } = {}) {
  if (!error) return false;

  // 1. User cancellation / abort
  if (error.cancelled === true || isAbortLike(error, signal)) {
    return false;
  }
  if (signal?.aborted) {
    return false;
  }
  if (typeof isRequestActive === 'function' && !isRequestActive()) {
    return false;
  }

  // 2. Partial streamed output (must never replay after partial tokens shown)
  if (error.partial === true || hasPartialOutput) {
    return false;
  }
  if (typeof error.partialText === 'string' && error.partialText.trim().length > 0) {
    return false;
  }

  // 3. Local provider privacy boundary
  const normProvider = normalizeProviderId(error.provider);
  if (normProvider === 'ollama' || normProvider === 'webllm') {
    return false;
  }

  // 4. canFallback MUST strictly be true
  if (error.canFallback !== true) {
    return false;
  }

  // 5. Incompatible or non-recoverable error codes
  const code = String(error.code || error.status || error.errorCode || '').toUpperCase();
  const nonFallbackCodes = new Set([
    'REQUEST_CANCELLED',
    'REQUEST_ABORTED',
    'REQUEST_SUPERSEDED',
    'INVALID_MODEL',
    'UNSUPPORTED_MODEL',
    'AUTH_FAILED',
    'UNAUTHENTICATED',
    'PERMISSION_DENIED',
    'MISSING_CREDENTIALS',
    'INVALID_REQUEST_PARAMETERS',
    'INVALID_ARGUMENT',
    'SAFETY_BLOCKED',
    'CONTEXT_LENGTH_EXCEEDED',
    'PAYLOAD_TOO_LARGE',
    'LOCAL_PROVIDER_ONLY',
    'WEBGPU_UNSUPPORTED',
    'WEBGPU_ADAPTER_UNAVAILABLE',
    'SHADER_F16_UNSUPPORTED',
    'INSUFFICIENT_STORAGE'
  ]);
  if (nonFallbackCodes.has(code)) {
    return false;
  }

  // 6. Explicit HTTP status: 400, 401, 403, 413, 499 never fallback
  const httpStatus = Number(error.httpStatus || error.statusCode || error.code);
  if (httpStatus === 400 || httpStatus === 401 || httpStatus === 403 || httpStatus === 413 || httpStatus === 499) {
    return false;
  }

  return true;
}

/**
 * Creates a sanitized, structured fallback diagnostic record without exposing
 * API keys, authorization tokens, raw prompts, or sensitive attachment contents.
 *
 * @param {Object} data
 * @returns {Object}
 */
export function createFallbackDiagnostic({
  requestId,
  originalProvider,
  failedProvider,
  failureCode,
  fallbackEligibility,
  selectedFallbackProvider,
  attemptNumber
}) {
  return {
    requestId: String(requestId || `req-${Date.now()}`),
    originalProvider: normalizeProviderId(originalProvider),
    failedProvider: normalizeProviderId(failedProvider),
    failureCode: String(failureCode || 'UNKNOWN_ERROR'),
    fallbackEligibility: Boolean(fallbackEligibility),
    selectedFallbackProvider: selectedFallbackProvider ? normalizeProviderId(selectedFallbackProvider) : null,
    attemptNumber: Number(attemptNumber) || 1,
    timestamp: Date.now()
  };
}

/**
 * Logs a concise internal diagnostic for provider fallback operations.
 * Never logs secrets, tokens, or raw prompts.
 *
 * @param {Object} diag
 */
export function logFallbackDiagnostic(diag) {
  if (!diag) return;
  console.warn(
    `[AI Fallback] Request: ${diag.requestId} | Initial: ${diag.originalProvider} | Failed: ${diag.failedProvider} (${diag.failureCode}) | Eligible: ${diag.fallbackEligibility} | Target: ${diag.selectedFallbackProvider || 'None'} | Step: ${diag.attemptNumber}`
  );
}

/**
 * Streams chat responses with deterministic bounded retry and automatic fallback coordination
 * across configured, available AI providers.
 *
 * Flow:
 * 1. Attempt primary provider (up to maxClientAttempts per provider on transient failures).
 * 2. If primary succeeds -> returns { text, modelUsed, provider, attemptedProviders, fallbackHistory, ... }.
 * 3. If primary fails:
 *    - Cancellation? Stop immediately (no retry, no fallback).
 *    - Partial output emitted? Stop immediately (no fallback to prevent duplicate/corrupted output).
 *    - Non-fallback error (auth, 400, invalid model, local privacy boundary, canFallback: false)? Stop immediately.
 *    - Fallback eligible (500, 502, 503, 504, timeout, network failure, canFallback: true)?
 *      - Select next provider from deterministic fallback chain that has not yet been visited.
 *      - If none available -> formulate and throw single canonical final error.
 *      - Otherwise -> record diagnostic, switch model cleanly via resolveModelForProviderSwitch,
 *        and attempt fallback provider.
 *
 * @param {Object} params
 * @param {string} [params.provider='gemini']
 * @param {string|null} [params.model=null]
 * @param {string} [params.mode='general']
 * @param {string} params.prompt
 * @param {Array} [params.history=[]]
 * @param {Array} [params.attachments=[]]
 * @param {AbortSignal} [params.signal]
 * @param {() => boolean} [params.isRequestActive]
 * @param {(chunkText: string, accumulatedText: string) => void} [params.onChunk]
 * @param {({ modelUsed: string, provider: string, isDemo?: boolean }) => void} [params.onStart]
 * @param {(diagnostic: Object) => void} [params.onFallback]
 * @param {Array<string>} [params.fallbackChain]
 * @param {number} [params.maxFallbackProviders=3]
 * @param {string} [params.requestId]
 * @returns {Promise<{ text: string, modelUsed: string, provider: string, isDemo?: boolean, attemptedProviders: string[], fallbackHistory: Array<Object> }>}
 */
export async function streamAIMessageWithFallback(params = {}) {
  const requestId = params.requestId || `req-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const initialProvider = normalizeProviderId(params.provider || DEFAULT_PROVIDER);
  let currentProvider = initialProvider;
  let currentModel = params.model || null;

  // Track visited providers to prevent loops (e.g. A -> B -> A)
  const visitedProviders = new Set([initialProvider]);
  const attemptedProviders = [initialProvider];
  const fallbackHistory = [];

  // Determine if vision is required (e.g. raw image attachments)
  const hasImageAttachments = Array.isArray(params.attachments) && params.attachments.some(isImageAttachment);
  const requiresVision = hasImageAttachments;

  // Maximum fallback depth across providers (default 3 providers max)
  const maxFallbackDepth = Number.isInteger(params.maxFallbackProviders) && params.maxFallbackProviders > 0
    ? params.maxFallbackProviders
    : 3;

  let lastError = null;

  while (attemptedProviders.length <= maxFallbackDepth) {
    if (params.signal?.aborted || (typeof params.isRequestActive === 'function' && !params.isRequestActive())) {
      throw createRouterAbortError();
    }

    // Resolve model safely for current provider
    const effectiveModel = resolveModelForProviderSwitch(currentProvider, currentModel, initialProvider);

    // Track stream state for current provider
    let providerEmittedChunks = false;
    let accumulatedText = '';

    try {
      // Execute stream attempt on current provider (autoFallback: false so retries stay on this provider)
      const result = await streamAIMessage({
        ...params,
        provider: currentProvider,
        model: effectiveModel,
        autoFallback: false,
        onStart: (info) => {
          params.onStart?.({
            ...info,
            provider: currentProvider,
            modelUsed: info?.modelUsed || effectiveModel || PROVIDER_DEFAULT_MODELS[currentProvider]
          });
        },
        onChunk: (chunkText, currentAcc) => {
          providerEmittedChunks = true;
          accumulatedText = currentAcc;
          params.onChunk?.(chunkText, currentAcc);
        }
      });

      // Successful completion!
      return {
        ...result,
        attemptedProviders: [...attemptedProviders],
        fallbackHistory: [...fallbackHistory]
      };
    } catch (rawErr) {
      if (
        params.signal?.aborted ||
        (typeof params.isRequestActive === 'function' && !params.isRequestActive()) ||
        rawErr?.name === 'AbortError' ||
        rawErr?.cancelled ||
        isAbortLike(rawErr)
      ) {
        const abortErr = createRouterAbortError(rawErr);
        abortErr.cancelled = true;
        abortErr.retryable = false;
        abortErr.canFallback = false;
        abortErr.attemptedProviders = [...attemptedProviders];
        abortErr.fallbackHistory = [...fallbackHistory];
        throw abortErr;
      }

      const canonicalErr = normalizeAIError(rawErr, {
        provider: currentProvider,
        model: effectiveModel,
        requestId,
        partialText: accumulatedText,
        partial: providerEmittedChunks || Boolean(rawErr?.partial),
        promptText: params.prompt,
        attemptedProviders: [...attemptedProviders],
        fallbackHistory: [...fallbackHistory]
      });

      lastError = canonicalErr;

      // CRITICAL STREAMING INVARIANT:
      // If partial text was already emitted to the user, NEVER attempt fallback to another provider.
      if (providerEmittedChunks || canonicalErr.partial || (canonicalErr.partialText && canonicalErr.partialText.trim().length > 0)) {
        canonicalErr.partial = true;
        canonicalErr.canFallback = false;
        canonicalErr.retryable = false;
        throw canonicalErr;
      }

      // Check fallback eligibility
      const eligible = isFallbackEligible(canonicalErr, {
        signal: params.signal,
        isRequestActive: params.isRequestActive,
        hasPartialOutput: providerEmittedChunks
      });

      if (!eligible) {
        throw canonicalErr;
      }

      // Determine candidate fallback providers
      let candidates;
      if (Array.isArray(params.fallbackChain) && params.fallbackChain.length > 0) {
        candidates = params.fallbackChain
          .map(normalizeProviderId)
          .filter((p) => p && !visitedProviders.has(p) && isProviderCapableOfTask(p, { requiresVision, hasImageAttachments }));
      } else {
        candidates = getDeterministicFallbackChain(currentProvider, {
          providerConfig: params.providerConfig || getCachedProviderConfig(),
          requiresVision,
          visited: Array.from(visitedProviders)
        });
      }

      const nextProvider = candidates.find((p) => !visitedProviders.has(p));

      // No eligible fallback provider remaining or depth reached
      if (!nextProvider || attemptedProviders.length >= maxFallbackDepth) {
        const finalExhaustedErr = normalizeAIError(canonicalErr, {
          provider: currentProvider,
          model: effectiveModel,
          requestId,
          canFallback: false,
          attemptedProviders: [...attemptedProviders],
          fallbackHistory: [...fallbackHistory]
        });
        finalExhaustedErr.canFallback = false;
        throw finalExhaustedErr;
      }

      // Record diagnostic & advance to next provider
      const diag = createFallbackDiagnostic({
        requestId,
        originalProvider: initialProvider,
        failedProvider: currentProvider,
        failureCode: canonicalErr.code,
        fallbackEligibility: true,
        selectedFallbackProvider: nextProvider,
        attemptNumber: fallbackHistory.length + 1
      });
      fallbackHistory.push(diag);
      logFallbackDiagnostic(diag);
      params.onFallback?.(diag);

      visitedProviders.add(nextProvider);
      attemptedProviders.push(nextProvider);
      currentProvider = nextProvider;
      currentModel = null;
    }
  }

  throw (
    lastError ||
    normalizeAIError('All AI provider fallback attempts failed.', {
      provider: currentProvider,
      requestId,
      attemptedProviders: [...attemptedProviders],
      fallbackHistory: [...fallbackHistory]
    })
  );
}

