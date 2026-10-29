/**
 * Orvix Provider Configuration, Model Sanitization & Offline Guard Service
 *
 * Centralizes provider classification, `/api/config` availability normalization,
 * client/server model identifier sanitization and validation, and offline action guards.
 * Pure JavaScript ESM module shared across browser UI, client router, and server.ts.
 */

export const SUPPORTED_PROVIDER_IDS = Object.freeze([
  'gemini',
  'groq',
  'openrouter',
  'cloudflare',
  'webllm'
]);

export const CLOUD_PROVIDER_IDS = Object.freeze([
  'gemini',
  'groq',
  'openrouter',
  'cloudflare'
]);

export const LOCAL_PROVIDER_IDS = Object.freeze(['webllm']);

const CLOUD_PROVIDER_SET = new Set(CLOUD_PROVIDER_IDS);
const LOCAL_PROVIDER_SET = new Set(LOCAL_PROVIDER_IDS);
const SUPPORTED_PROVIDER_SET = new Set(SUPPORTED_PROVIDER_IDS);

export const PROVIDER_DISPLAY_NAMES = Object.freeze({
  gemini: 'Google Gemini',
  groq: 'Groq',
  openrouter: 'OpenRouter',
  cloudflare: 'Cloudflare Workers AI',
  webllm: 'Browser AI (WebLLM)'
});

export const GROQ_CHAT_MODELS = Object.freeze([
  'openai/gpt-oss-120b',
  'llama-3.1-8b-instant',
  'openai/gpt-oss-20b'
]);

export const GROQ_FALLBACK_CHAT_MODELS = Object.freeze([
  'openai/gpt-oss-120b',
  'llama-3.1-8b-instant'
]);

export const GROQ_TRANSCRIPTION_MODELS = Object.freeze([
  'whisper-large-v3-turbo',
  'whisper-large-v3'
]);

export const DEFAULT_GROQ_TRANSCRIPTION_MODEL = 'whisper-large-v3-turbo';

export const OPENROUTER_DEFAULT_MODEL = 'openrouter/free';

export const OPENROUTER_DYNAMIC_ROUTERS = Object.freeze([
  'openrouter/free',
  'openrouter/auto'
]);

export const CLOUDFLARE_DEFAULT_MODEL = '@cf/meta/llama-3.1-8b-instruct';

export const WEBLLM_SUPPORTED_MODELS = Object.freeze([
  'SmolLM2-135M-Instruct-q0f16-MLC',
  'SmolLM2-135M-Instruct-q0f32-MLC',
  'SmolLM2-360M-Instruct-q4f16_1-MLC',
  'SmolLM2-360M-Instruct-q4f32_1-MLC',
  'Qwen3-0.6B-q4f16_1-MLC',
  'Qwen3-0.6B-q4f32_1-MLC',
  'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
  'Qwen2.5-1.5B-Instruct-q4f32_1-MLC'
]);

export const RETIRED_GROQ_MODELS = Object.freeze([
  'llama3-70b-8192',
  'llama3-8b-8192',
  'mixtral-8x7b-32768',
  'gemma-7b-it',
  'gemma2-9b-it',
  'llama-3.1-70b-versatile',
  'llama-3.2-1b-preview',
  'llama-3.2-3b-preview',
  'llama-3.2-11b-vision-preview',
  'llama-3.2-90b-vision-preview',
  'distil-whisper-large-v3-en'
]);

const GROQ_TRANSCRIPTION_MODEL_SET = new Set(
  GROQ_TRANSCRIPTION_MODELS.map((m) => m.toLowerCase())
);
const RETIRED_GROQ_MODEL_SET = new Set(
  RETIRED_GROQ_MODELS.map((m) => m.toLowerCase())
);

/**
 * Validates a requested Groq audio transcription model identifier.
 * Keeps audio transcription models strictly separate from chat-completion models.
 *
 * @param {unknown} rawModel
 * @returns {{ valid: boolean, model: string, error?: string, code?: string }}
 */
export function validateGroqTranscriptionModel(rawModel) {
  if (rawModel === undefined || rawModel === null || rawModel === '') {
    return { valid: true, model: DEFAULT_GROQ_TRANSCRIPTION_MODEL };
  }
  if (typeof rawModel !== 'string') {
    return {
      valid: false,
      model: DEFAULT_GROQ_TRANSCRIPTION_MODEL,
      error: 'Invalid transcription model parameter: expected a string identifier.',
      code: 'INVALID_TRANSCRIPTION_MODEL'
    };
  }
  const trimmed = rawModel.trim();
  if (!trimmed) {
    return { valid: true, model: DEFAULT_GROQ_TRANSCRIPTION_MODEL };
  }
  const lower = trimmed.toLowerCase();
  if (GROQ_TRANSCRIPTION_MODEL_SET.has(lower)) {
    const canonical =
      GROQ_TRANSCRIPTION_MODELS.find((m) => m.toLowerCase() === lower) ||
      DEFAULT_GROQ_TRANSCRIPTION_MODEL;
    return { valid: true, model: canonical };
  }
  return {
    valid: false,
    model: DEFAULT_GROQ_TRANSCRIPTION_MODEL,
    error: `Model '${trimmed}' is not a valid Groq audio transcription model. Supported transcription models are: ${GROQ_TRANSCRIPTION_MODELS.join(', ')}.`,
    code: 'INVALID_TRANSCRIPTION_MODEL'
  };
}

export const PROVIDER_DEFAULT_MODELS = Object.freeze({
  gemini: 'gemini-3.8-flash',
  groq: 'openai/gpt-oss-120b',
  openrouter: 'openrouter/free',
  cloudflare: '@cf/meta/llama-3.1-8b-instruct',
  webllm: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC'
});

/**
 * Known synthetic / analyzer / placeholder labels that are never real upstream model IDs.
 */
const SYNTHETIC_NON_MODEL_LABELS = new Set([
  'document analyzer',
  'document analyzer (local)',
  'document analyzer (demo)',
  'ai model',
  'default',
  'auto'
]);

/**
 * Known human-readable UI display labels that can appear on message badges or metadata
 * and must never be sent upstream as raw API model identifiers.
 */
const KNOWN_UI_DISPLAY_LABELS = new Set([
  'gemini 3.8 flash',
  'gemini 3.1 flash lite',
  'google gemini',
  'gpt oss 120b',
  'llama 3.3 70b',
  'llama 3.3 70b (free)',
  'llama 3.3 70b free',
  'free models router',
  'free router',
  'openrouter (free models router)',
  'openrouter — free models router',
  'openrouter - free models router',
  'openrouter',
  'groq',
  'llama 3.1 8b',
  'cloudflare workers ai',
  'cloudflare workers ai — llama 3.1 8b',
  'cloudflare workers ai - llama 3.1 8b',
  'browser ai (webllm)',
  'browser ai (webllm) — qwen 2.5 1.5b',
  'browser ai (webllm) - qwen 2.5 1.5b',
  'browser ai (webllm) — smollm2 135m',
  'browser ai (webllm) - smollm2 135m',
  'browser ai (webllm) — smollm2 360m',
  'browser ai (webllm) - smollm2 360m',
  'browser ai (webllm) — qwen3 0.6b',
  'browser ai (webllm) - qwen3 0.6b',
  'qwen 2.5 1.5b',
  'qwen 2.5 coder 1.5b',
  'qwen3 0.6b',
  'qwen3',
  'smollm2 135m',
  'llama 3.2 1b',
  'smollm2 360m'
]);

/**
 * Normalizes a provider identifier to lowercase, defaulting to 'gemini' when omitted.
 * @param {string|null|undefined} provider
 * @returns {string}
 */
export function normalizeProviderId(provider) {
  if (!provider || typeof provider !== 'string') return 'gemini';
  const trimmed = provider.trim().toLowerCase();
  // Safe legacy fallback: if user previously selected ollama, gracefully route to gemini
  if (trimmed === 'ollama') return 'gemini';
  return trimmed || 'gemini';
}

/**
 * Returns true if the provider is a cloud-hosted provider requiring internet & server credentials.
 * @param {string|null|undefined} provider
 * @returns {boolean}
 */
export function isCloudProvider(provider) {
  if (!provider || typeof provider !== 'string') return false;
  return CLOUD_PROVIDER_SET.has(provider.trim().toLowerCase());
}

/**
 * Returns true if the provider executes locally (Browser WebLLM).
 * @param {string|null|undefined} provider
 * @returns {boolean}
 */
export function isLocalProvider(provider) {
  if (!provider || typeof provider !== 'string') return false;
  return LOCAL_PROVIDER_SET.has(provider.trim().toLowerCase());
}

/**
 * Returns true if the provider identifier is one of the 5 supported Orvix providers.
 * @param {string|null|undefined} provider
 * @returns {boolean}
 */
export function isSupportedProvider(provider) {
  if (!provider || typeof provider !== 'string') return false;
  return SUPPORTED_PROVIDER_SET.has(provider.trim().toLowerCase());
}

/**
 * Returns a clean human-readable provider name.
 * @param {string|null|undefined} provider
 * @returns {string}
 */
export function getProviderDisplayName(provider) {
  const norm = normalizeProviderId(provider);
  return PROVIDER_DISPLAY_NAMES[norm] || provider || 'AI Provider';
}

/**
 * Detects whether a model string has a `(demo)` suffix from simulated responses.
 * @param {unknown} model
 * @returns {boolean}
 */
export function hasDemoModelSuffix(model) {
  if (typeof model !== 'string') return false;
  return /\s*\(demo\)\s*$/i.test(model.trim());
}

/**
 * Detects whether a model string is a synthetic analyzer label (`Document Analyzer`, etc.).
 * @param {unknown} model
 * @returns {boolean}
 */
export function isSyntheticAnalyzerModel(model) {
  if (typeof model !== 'string') return false;
  const lower = model.trim().toLowerCase();
  return SYNTHETIC_NON_MODEL_LABELS.has(lower);
}

/**
 * Detects whether a model string is a human-readable UI display label rather than an API ID.
 * Note: No supported upstream provider (Gemini, Groq, OpenRouter, Cloudflare, WebLLM)
 * uses whitespace, parentheses, or em-dashes in raw model identifiers.
 * @param {unknown} model
 * @returns {boolean}
 */
export function isDisplayOnlyModelLabel(model) {
  if (typeof model !== 'string') return false;
  const trimmed = model.trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();
  if (KNOWN_UI_DISPLAY_LABELS.has(lower)) return true;
  if (hasDemoModelSuffix(trimmed)) return true;
  if (isSyntheticAnalyzerModel(trimmed)) return true;
  if (/[\s()—]/.test(trimmed)) return true;
  return false;
}

/**
 * Checks whether a clean, single-token model ID is structurally valid for a specific provider.
 * Rejects cross-provider model leakage (e.g., `@cf/...` sent to Gemini,
 * `Qwen2.5-...-MLC` sent to OpenRouter, `gemini-2.5-flash` sent to Cloudflare).
 *
 * @param {string} provider
 * @param {string} candidateModel
 * @returns {{ compatible: boolean, normalizedModel: string|null, reason?: string }}
 */
export function checkModelCompatibilityForProvider(provider, candidateModel) {
  const normProvider = normalizeProviderId(provider);
  const trimmed = typeof candidateModel === 'string' ? candidateModel.trim() : '';

  if (!trimmed) {
    return { compatible: true, normalizedModel: null };
  }

  // Reject any whitespace, parentheses, control chars, or em-dashes across all providers
  if (/[\s()\r\n\t—]/.test(trimmed)) {
    return {
      compatible: false,
      normalizedModel: null,
      reason: `Model "${trimmed}" is a display label or malformed identifier for ${getProviderDisplayName(normProvider)}.`
    };
  }

  const lower = trimmed.toLowerCase();

  switch (normProvider) {
    case 'gemini': {
      // Valid Gemini IDs: gemini-*, learnlm-*, gemma-*, or models/gemini-*
      if (/^(?:models\/)?(?:gemini|learnlm|gemma)-[a-z0-9._-]+$/i.test(trimmed) && !/-mlc$/i.test(trimmed)) {
        return { compatible: true, normalizedModel: trimmed };
      }
      return {
        compatible: false,
        normalizedModel: null,
        reason: `Model "${trimmed}" is not a valid Google Gemini model identifier.`
      };
    }

    case 'groq': {
      // Preserve legacy Llama 3.3 migration alias to current primary Groq chat model
      if (lower.includes('llama-3.3') && /^[a-z0-9._/-]+$/i.test(trimmed) && !lower.includes(':')) {
        return { compatible: true, normalizedModel: 'openai/gpt-oss-120b' };
      }
      // Reject audio transcription models (Whisper) when requested for Groq chat completions
      if (
        GROQ_TRANSCRIPTION_MODEL_SET.has(lower) ||
        lower.startsWith('whisper-') ||
        lower.startsWith('distil-whisper')
      ) {
        return {
          compatible: false,
          normalizedModel: null,
          reason: `Model "${trimmed}" is an audio transcription model and cannot be used for Groq chat completions.`
        };
      }
      // Reject verified retired / decommissioned Groq model IDs
      if (RETIRED_GROQ_MODEL_SET.has(lower)) {
        return {
          compatible: false,
          normalizedModel: null,
          reason: `Model "${trimmed}" has been retired on Groq. Please use "${PROVIDER_DEFAULT_MODELS.groq}" or "llama-3.1-8b-instant".`
        };
      }
      // Reject foreign provider formats: Cloudflare (@cf/@hf), OpenRouter (openrouter/* or :free/:variant),
      // Gemini (gemini-*/models/*), WebLLM (*-MLC)
      if (
        lower.startsWith('@cf/') ||
        lower.startsWith('@hf/') ||
        lower.startsWith('openrouter/') ||
        lower.startsWith('models/') ||
        lower.startsWith('gemini-') ||
        lower.includes(':') ||
        lower.endsWith('-mlc')
      ) {
        return {
          compatible: false,
          normalizedModel: null,
          reason: `Model "${trimmed}" belongs to another provider and is not valid for Groq.`
        };
      }
      if (/^(?:[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(trimmed)) {
        return { compatible: true, normalizedModel: trimmed };
      }
      return {
        compatible: false,
        normalizedModel: null,
        reason: `Model "${trimmed}" is not a valid Groq model identifier.`
      };
    }

    case 'openrouter': {
      // OpenRouter requires `openrouter/free`, `openrouter/auto`, or `<vendor>/<slug>[:<variant>]`
      if (
        lower.startsWith('@cf/') ||
        lower.startsWith('@hf/') ||
        lower.startsWith('models/') ||
        lower.endsWith('-mlc') ||
        GROQ_TRANSCRIPTION_MODEL_SET.has(lower) ||
        lower.includes('/whisper-')
      ) {
        return {
          compatible: false,
          normalizedModel: null,
          reason: `Model "${trimmed}" belongs to another provider and is not valid for OpenRouter.`
        };
      }
      if (lower.startsWith('openrouter/')) {
        if (OPENROUTER_DYNAMIC_ROUTERS.includes(lower)) {
          return { compatible: true, normalizedModel: lower };
        }
        return {
          compatible: false,
          normalizedModel: null,
          reason: `Model "${trimmed}" is not a recognized OpenRouter router. Supported routers are: ${OPENROUTER_DYNAMIC_ROUTERS.join(', ')}.`
        };
      }
      if (/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*(?::[a-z0-9._-]+)?$/i.test(trimmed)) {
        return { compatible: true, normalizedModel: trimmed };
      }
      return {
        compatible: false,
        normalizedModel: null,
        reason: `Model "${trimmed}" is not a valid OpenRouter model identifier.`
      };
    }

    case 'cloudflare': {
      // Cloudflare Workers AI chat models use `@cf/<org>/<model>` or `@hf/<org>/<model>`
      if (
        GROQ_TRANSCRIPTION_MODEL_SET.has(lower) ||
        lower.includes('/whisper') ||
        lower.endsWith('-mlc')
      ) {
        return {
          compatible: false,
          normalizedModel: null,
          reason: `Model "${trimmed}" is not a valid Cloudflare Workers AI chat model identifier.`
        };
      }
      if (/^@(?:cf|hf)\/[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)+$/i.test(trimmed)) {
        return { compatible: true, normalizedModel: trimmed };
      }
      return {
        compatible: false,
        normalizedModel: null,
        reason: `Model "${trimmed}" is not a valid Cloudflare Workers AI model identifier.`
      };
    }

    case 'webllm': {
      // Reject cross-provider model IDs (Gemini, Groq chat & Whisper transcription, OpenRouter, Cloudflare)
      if (
        lower.startsWith('@') ||
        lower.startsWith('gemini-') ||
        lower.startsWith('models/') ||
        lower.startsWith('openrouter/') ||
        lower.startsWith('openai/') ||
        lower.startsWith('anthropic/') ||
        lower.startsWith('gpt-') ||
        lower.startsWith('claude-') ||
        lower.startsWith('llama-') ||
        lower.includes(':') ||
        GROQ_TRANSCRIPTION_MODEL_SET.has(lower) ||
        lower.startsWith('whisper-') ||
        lower.startsWith('distil-whisper') ||
        GROQ_CHAT_MODELS.includes(lower) ||
        RETIRED_GROQ_MODEL_SET.has(lower)
      ) {
        return {
          compatible: false,
          normalizedModel: null,
          reason: `Model "${trimmed}" belongs to another provider and is not valid for Browser AI (WebLLM).`
        };
      }
      // Reject obsolete / retired Qwen 2.5 0.5B models
      if (lower.includes('0.5b') || lower.includes('qwen2.5-0.5b')) {
        return {
          compatible: false,
          normalizedModel: null,
          reason: `Model "${trimmed}" is obsolete and no longer supported. Supported Browser AI models are: SmolLM2 135M, SmolLM2 360M, Qwen3 0.6B, and Qwen 2.5 1.5B.`
        };
      }
      // Match against verified supported WebLLM models (case-insensitive)
      const matched = WEBLLM_SUPPORTED_MODELS.find(
        (m) => m.toLowerCase() === lower
      );
      if (matched) {
        return { compatible: true, normalizedModel: matched };
      }
      // Reject arbitrary unverified MLC model IDs
      if (/^[a-z0-9][a-z0-9._-]*-MLC$/i.test(trimmed)) {
        return {
          compatible: false,
          normalizedModel: null,
          reason: `Model "${trimmed}" is not in the supported Browser AI (WebLLM) model registry for this project.`
        };
      }
      return {
        compatible: false,
        normalizedModel: null,
        reason: `Model "${trimmed}" is not a valid Browser AI (WebLLM) model identifier.`
      };
    }

    default:
      return {
        compatible: false,
        normalizedModel: null,
        reason: `Unsupported provider "${provider}".`
      };
  }
}

/**
 * Sanitizes a stored or UI-derived model identifier before client dispatch, regeneration,
 * alternative generation, or stream continuation.
 *
 * Strips `(demo)` suffixes, `Document Analyzer*` synthetic tags, human-readable UI display labels,
 * and cross-provider model IDs, returning a clean upstream model ID or `null` (so the target
 * provider applies its configured default).
 *
 * @param {string|null|undefined} provider
 * @param {unknown} model
 * @returns {string|null}
 */
export function sanitizeModelForProvider(provider, model) {
  if (model === null || model === undefined) return null;
  if (typeof model !== 'string') return null;

  const trimmed = model.trim();
  if (!trimmed) return null;

  if (hasDemoModelSuffix(trimmed)) return null;
  if (isSyntheticAnalyzerModel(trimmed)) return null;
  if (isDisplayOnlyModelLabel(trimmed)) return null;

  const check = checkModelCompatibilityForProvider(provider, trimmed);
  return check.compatible ? check.normalizedModel : null;
}

/**
 * Sanitizes a model label stored on UI message/alternative records for badge display.
 * Preserves explicit `(demo)` markers and `Document Analyzer` labels for UI transparency,
 * migrates deprecated Groq Llama 3.3 IDs, and clears foreign cross-provider raw model IDs.
 *
 * Outgoing API calls must ALWAYS pass through `sanitizeModelForProvider()`, never this helper.
 *
 * @param {string|null|undefined} provider
 * @param {unknown} model
 * @returns {string|null}
 */
export function sanitizeStoredDisplayModel(provider, model) {
  if (model === null || model === undefined) return null;
  if (typeof model !== 'string') return null;

  const trimmed = model.trim();
  if (!trimmed) return null;

  // Preserve explicit opt-in demo markers and Document Analyzer indicators in UI history
  if (hasDemoModelSuffix(trimmed) || isSyntheticAnalyzerModel(trimmed) || isDisplayOnlyModelLabel(trimmed)) {
    return trimmed;
  }

  const normProvider = normalizeProviderId(provider);
  const lower = trimmed.toLowerCase();
  if (normProvider === 'groq' && (lower.includes('llama-3.3') || lower.includes('llama-3.1-70b'))) {
    return 'openai/gpt-oss-120b';
  }

  const check = checkModelCompatibilityForProvider(normProvider, trimmed);
  return check.compatible ? check.normalizedModel : null;
}

/**
 * Strict server-side `/api/chat` model validator.
 *
 * - `undefined`, `null`, or empty string -> `{ valid: true, model: null }` (use provider default).
 * - Valid model for the target provider -> `{ valid: true, model: normalizedModel }`.
 * - Non-string, `(demo)` label, `Document Analyzer*`, UI display label, or cross-provider model ->
 *   `{ valid: false, model: null, code: 400, status: 'INVALID_MODEL', error: string }`.
 *
 * @param {string} provider
 * @param {unknown} rawClientModel
 * @returns {{ valid: boolean, model: string|null, code?: number, status?: string, error?: string }}
 */
export function validateServerModelForProvider(provider, rawClientModel) {
  const normProvider = normalizeProviderId(provider);

  if (rawClientModel === undefined || rawClientModel === null) {
    return { valid: true, model: null };
  }

  if (typeof rawClientModel !== 'string') {
    return {
      valid: false,
      model: null,
      code: 400,
      status: 'INVALID_MODEL',
      error: `Invalid model value for ${getProviderDisplayName(normProvider)}: expected a model identifier string or null.`
    };
  }

  const trimmed = rawClientModel.trim();
  if (!trimmed) {
    return { valid: true, model: null };
  }

  if (hasDemoModelSuffix(trimmed)) {
    return {
      valid: false,
      model: null,
      code: 400,
      status: 'INVALID_MODEL',
      error: `Simulated demo model label "${trimmed}" cannot be sent as an upstream model identifier for ${getProviderDisplayName(normProvider)}.`
    };
  }

  if (isSyntheticAnalyzerModel(trimmed)) {
    return {
      valid: false,
      model: null,
      code: 400,
      status: 'INVALID_MODEL',
      error: `Synthetic label "${trimmed}" is not a valid upstream model identifier for ${getProviderDisplayName(normProvider)}.`
    };
  }

  if (isDisplayOnlyModelLabel(trimmed)) {
    return {
      valid: false,
      model: null,
      code: 400,
      status: 'INVALID_MODEL',
      error: `Display label "${trimmed}" is not a valid upstream API model identifier for ${getProviderDisplayName(normProvider)}.`
    };
  }

  const check = checkModelCompatibilityForProvider(normProvider, trimmed);
  if (!check.compatible) {
    return {
      valid: false,
      model: null,
      code: 400,
      status: 'INVALID_MODEL',
      error:
        check.reason ||
        `Model "${trimmed}" is not valid for ${getProviderDisplayName(normProvider)}.`
    };
  }

  return {
    valid: true,
    model: check.normalizedModel
  };
}

/**
 * Normalizes a `/api/config` response into a safe boolean-only availability object.
 * Never retains any unknown or secret-bearing properties.
 *
 * @param {any} raw
 * @returns {Object|null}
 */
export function normalizeProviderConfigPayload(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const hasAnyKnownBoolean =
    typeof raw.geminiConfigured === 'boolean' ||
    typeof raw.groqConfigured === 'boolean' ||
    typeof raw.openrouterConfigured === 'boolean' ||
    typeof raw.cloudflareConfigured === 'boolean';

  if (!hasAnyKnownBoolean) return null;

  return {
    geminiConfigured: Boolean(raw.geminiConfigured),
    groqConfigured: Boolean(raw.groqConfigured),
    openrouterConfigured: Boolean(raw.openrouterConfigured),
    cloudflareConfigured: Boolean(raw.cloudflareConfigured),
    webllmSupported: raw.webllmSupported !== undefined ? Boolean(raw.webllmSupported) : true,
    demoModeEnabled: Boolean(raw.demoModeEnabled),
    whisperConfigured: Boolean(raw.whisperConfigured),
    whisperProvider: typeof raw.whisperProvider === 'string' ? raw.whisperProvider : null
  };
}

/**
 * Resolves the UI availability state for a provider given the current `/api/config` state.
 * When `/api/config` has not loaded or failed to fetch (`status !== 'ready'`), returns
 * `state: 'unknown'` and `configured: null` so the UI never falsely marks providers unconfigured.
 *
 * @param {string} provider
 * @param {{ status?: string, data?: Object|null }|null|undefined} providerConfig
 * @returns {{ state: 'configured'|'unconfigured'|'local'|'demo'|'unavailable'|'unknown', configured: boolean|null, isDemo?: boolean }}
 */
export function getProviderConfigAvailability(provider, providerConfig) {
  const norm = normalizeProviderId(provider);

  if (!providerConfig || providerConfig.status !== 'ready' || !providerConfig.data) {
    return {
      state: isLocalProvider(norm) ? 'local' : 'unknown',
      configured: null
    };
  }

  const data = providerConfig.data;

  if (norm === 'webllm') {
    return {
      state: 'local',
      configured: data.webllmSupported !== false
    };
  }

  if (data.demoModeEnabled) {
    return { state: 'demo', configured: true, isDemo: true };
  }

  const keyMap = {
    gemini: data.geminiConfigured,
    groq: data.groqConfigured,
    openrouter: data.openrouterConfigured,
    cloudflare: data.cloudflareConfigured
  };

  if (Object.prototype.hasOwnProperty.call(keyMap, norm)) {
    const isConf = Boolean(keyMap[norm]);
    return {
      state: isConf ? 'configured' : 'unconfigured',
      configured: isConf
    };
  }

  return { state: 'unknown', configured: null };
}

/**
 * Filters candidate fallback providers so error cards prefer configured providers when `/api/config`
 * has loaded, while gracefully keeping candidates when config state is `'unknown'`.
 *
 * @param {Array<string>} candidates
 * @param {string} failedProvider
 * @param {{ status?: string, data?: Object|null }|null|undefined} providerConfig
 * @returns {Array<string>}
 */
export function filterAvailableFallbackProviders(candidates, failedProvider, providerConfig) {
  const failedNorm = normalizeProviderId(failedProvider);
  const list = Array.isArray(candidates) ? candidates : CLOUD_PROVIDER_IDS;

  return list.filter((cand) => {
    const rawId = typeof cand === 'string' ? cand : cand?.id;
    if (!rawId) return false;
    const norm = normalizeProviderId(rawId);
    if (norm === failedNorm) return false;
    const avail = getProviderConfigAvailability(norm, providerConfig);
    if (avail.state === 'unconfigured' || avail.state === 'unavailable') {
      return false;
    }
    return true;
  });
}

/**
 * Evaluates whether an interactive chat action should be blocked immediately because the browser
 * is offline and the target provider requires cloud connectivity.
 *
 * Local provider (`webllm`) is permitted offline; cloud providers (`gemini`, `groq`,
 * `openrouter`, `cloudflare`) are blocked before any loading or message-mutation side effects.
 *
 * @param {Object} params
 * @param {string} params.provider
 * @param {boolean} params.isOnline
 * @returns {{ allowed: boolean, blocked: boolean, code: string|null, provider: string, providerLabel: string, message: string|null }}
 */
export function evaluateOfflineProviderGuard({ provider, isOnline }) {
  const normProvider = normalizeProviderId(provider);
  const providerLabel = getProviderDisplayName(normProvider);

  if (isOnline !== false || !isCloudProvider(normProvider)) {
    return {
      allowed: true,
      blocked: false,
      code: null,
      provider: normProvider,
      providerLabel,
      message: null
    };
  }

  return {
    allowed: false,
    blocked: true,
    code: 'OFFLINE_CLOUD_PROVIDER',
    provider: normProvider,
    providerLabel,
    message: `You are currently offline. ${providerLabel} requires an internet connection — switch to Browser AI (WebLLM) to continue offline, or reconnect and try again.`
  };
}

/**
 * Resolves a model identifier when explicitly or automatically switching providers.
 *
 * Prevents Provider A + Model A from accidentally becoming Provider B + Model A.
 * If the current model is compatible with the target provider, normalizes and preserves it.
 * Otherwise, falls back to the target provider's default model.
 *
 * @param {string} toProvider Target provider ID
 * @param {string|null|undefined} currentModel Current model identifier
 * @param {string|null|undefined} [fromProvider=null] Source provider ID
 * @returns {string|null} Resolved model identifier for the target provider
 */
export function resolveModelForProviderSwitch(toProvider, currentModel, fromProvider = null) {
  const normTo = normalizeProviderId(toProvider);
  if (!normTo) return null;

  const defaultModel = PROVIDER_DEFAULT_MODELS[normTo] || null;
  if (!currentModel || typeof currentModel !== 'string' || !currentModel.trim()) {
    return defaultModel;
  }

  const sanitized = sanitizeModelForProvider(normTo, currentModel);
  return sanitized || defaultModel;
}

/**
 * Evaluates whether an AI provider is capable of processing the requested task parameters.
 * E.g., vision/image tasks require Gemini; text-only cloud/local providers cannot handle raw image payloads.
 *
 * @param {string} provider
 * @param {Object} [task={}]
 * @param {boolean} [task.requiresVision=false]
 * @param {boolean} [task.hasImageAttachments=false]
 * @param {string|null} [task.model=null]
 * @returns {boolean}
 */
export function isProviderCapableOfTask(provider, { requiresVision = false, hasImageAttachments = false, model = null } = {}) {
  const norm = normalizeProviderId(provider);
  if (!norm) return false;

  if (requiresVision || hasImageAttachments) {
    // Only Gemini supports multimodal image analysis / vision in this application
    return norm === 'gemini';
  }

  return true;
}

/**
 * Computes a deterministic fallback chain starting from a failed provider.
 *
 * Invariants:
 * 1. Strict Local Privacy: WebLLM local provider NEVER fallbacks to cloud.
 * 2. Vision Guard: If vision is required, no text-only provider can serve as fallback.
 * 3. Visited Protection: Providers already attempted in the request are excluded (no cycles).
 * 4. Availability: Unconfigured providers are excluded according to providerConfig availability.
 *
 * @param {string} currentProvider
 * @param {Object} [options={}]
 * @param {Object|null} [options.providerConfig=null]
 * @param {boolean} [options.requiresVision=false]
 * @param {Array<string>|Set<string>} [options.visited=[]]
 * @returns {Array<string>} Ordered list of candidate fallback provider IDs
 */
export function getDeterministicFallbackChain(currentProvider, { providerConfig = null, requiresVision = false, visited = [] } = {}) {
  const normCurrent = normalizeProviderId(currentProvider);

  // STRICT LOCAL PRIVACY INVARIANT: WebLLM local provider MUST NEVER fallback to cloud
  if (normCurrent === 'webllm') {
    return [];
  }

  // Vision requirement invariant: Only Gemini supports vision in this application
  if (requiresVision) {
    return [];
  }

  const visitedSet = new Set(
    (Array.isArray(visited) ? visited : Array.from(visited || [])).map(normalizeProviderId).filter(Boolean)
  );
  if (normCurrent) {
    visitedSet.add(normCurrent);
  }

  // Deterministic cloud fallback sequence
  const defaultOrder = ['gemini', 'groq', 'openrouter', 'cloudflare'];

  // Start with candidates that haven't been visited yet
  const candidates = defaultOrder.filter((p) => !visitedSet.has(p));

  // Filter against providerConfig if available (excludes confirmed unconfigured providers)
  return filterAvailableFallbackProviders(candidates, normCurrent, providerConfig);
}

