/**
 * Orvix AI Provider Router
 * Central dispatch service routing chat requests to the selected provider (Gemini, Groq, OpenRouter).
 * Normalizes parameters, formats, and outputs across all three providers.
 */

import {
  sendGeminiMessage,
  streamGeminiMessage,
  getGeminiApiKey,
} from "./geminiService.js";
import {
  sendGroqMessage,
  streamGroqMessage,
  getGroqApiKey,
} from "./groqService.js";
import {
  sendOpenRouterMessage,
  streamOpenRouterMessage,
  getOpenRouterApiKey,
} from "./openrouterService.js";
import { formatImagePayload } from "../utils/imageValidator.js";

export const AI_PROVIDERS = {
  GEMINI: "gemini",
  GROQ: "groq",
  OPENROUTER: "openrouter",
};

export const PROVIDER_OPTIONS = [
  {
    id: AI_PROVIDERS.GEMINI,
    name: "Gemini",
    modelTag: "Gemini 3.1 Flash Lite",
    description: "Google Gemini",
    envKey: "VITE_GEMINI_API_KEY",
    supportsVision: true,
  },
  {
    id: AI_PROVIDERS.GROQ,
    name: "Groq",
    modelTag: "Llama 3.3 70B",
    description: "Ultra-fast inference",
    envKey: "VITE_GROQ_API_KEY",
    supportsVision: false,
  },
  {
    id: AI_PROVIDERS.OPENROUTER,
    name: "OpenRouter",
    modelTag: "Llama 3.3 70B (Free)",
    description: "Multi-model gateway",
    envKey: "VITE_OPENROUTER_API_KEY",
    supportsVision: false,
  },
];

export const DEFAULT_PROVIDER = AI_PROVIDERS.GEMINI;

/**
 * Checks whether the specified AI provider model supports image vision and visual text extraction.
 * @param {string} provider
 * @returns {boolean}
 */
export function isVisionSupported(provider) {
  const p = PROVIDER_OPTIONS.find(
    (opt) => opt.id === (provider || "").toLowerCase(),
  );
  return Boolean(p?.supportsVision);
}

let cachedConfiguredProviders = null;
let lastConfigFetchTime = 0;

/**
 * Resets the in-memory cache of configured providers.
 */
export function clearConfiguredProvidersCache() {
  cachedConfiguredProviders = null;
  lastConfigFetchTime = 0;
}

/**
 * Checks if a given provider currently has an API key configured on client or in cached server config.
 * @param {string} provider
 * @returns {boolean}
 */
export function isProviderConfigured(provider) {
  const norm = (provider || "").toLowerCase();
  if (Array.isArray(cachedConfiguredProviders) && cachedConfiguredProviders.includes(norm)) {
    return true;
  }
  switch (norm) {
    case AI_PROVIDERS.GROQ: {
      const key = getGroqApiKey();
      return Boolean(key && key !== "YOUR_GROQ_API_KEY");
    }
    case AI_PROVIDERS.OPENROUTER: {
      const key = getOpenRouterApiKey();
      return Boolean(key && key !== "YOUR_OPENROUTER_API_KEY");
    }
    case AI_PROVIDERS.GEMINI:
    default: {
      const key = getGeminiApiKey();
      return Boolean(key && key !== "YOUR_GEMINI_API_KEY");
    }
  }
}

/**
 * Fetches the list of genuinely configured AI providers from /api/config.
 * Results are cached in memory for 30 seconds to minimize network overhead.
 * @param {boolean} [forceRefresh=false]
 * @returns {Promise<string[]>}
 */
export async function fetchConfiguredProviders(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedConfiguredProviders && now - lastConfigFetchTime < 30000) {
    return cachedConfiguredProviders;
  }

  try {
    const res = await fetch("/api/config");
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data?.configuredProviders)) {
        cachedConfiguredProviders = data.configuredProviders.map((p) => String(p).toLowerCase());
        lastConfigFetchTime = now;
        return cachedConfiguredProviders;
      }
      const list = [];
      if (data?.geminiConfigured) list.push(AI_PROVIDERS.GEMINI);
      if (data?.groqConfigured) list.push(AI_PROVIDERS.GROQ);
      if (data?.openrouterConfigured) list.push(AI_PROVIDERS.OPENROUTER);
      cachedConfiguredProviders = list;
      lastConfigFetchTime = now;
      return list;
    }
  } catch (_) {}

  // Fallback to client-side env key detection
  const list = [];
  if (isProviderConfigured(AI_PROVIDERS.GEMINI)) list.push(AI_PROVIDERS.GEMINI);
  if (isProviderConfigured(AI_PROVIDERS.GROQ)) list.push(AI_PROVIDERS.GROQ);
  if (isProviderConfigured(AI_PROVIDERS.OPENROUTER)) list.push(AI_PROVIDERS.OPENROUTER);
  cachedConfiguredProviders = list;
  lastConfigFetchTime = now;
  return list;
}

/**
 * Determines whether an error is eligible for automatic alternative provider fallback.
 * Eligible: HTTP 429 / RESOURCE_EXHAUSTED / quota limit, HTTP 503 / UNAVAILABLE, HTTP 504 / DEADLINE_EXCEEDED.
 * Ineligible: 401/403 (auth errors), 400 (bad request), AbortError (user cancellation).
 * @param {any} error
 * @returns {boolean}
 */
export function isFallbackEligibleError(error) {
  if (!error) return false;

  // Never fallback on intentional user abort or cancellation
  if (
    error.name === "AbortError" ||
    error.code === 20 ||
    error.code === "ABORT_ERR" ||
    error.status === "CANCELLED"
  ) {
    return false;
  }

  // Authentication and permission errors require configuration fixes, not silent fallback
  if (
    error.code === 401 ||
    error.code === 403 ||
    error.status === "UNAUTHENTICATED" ||
    error.status === "PERMISSION_DENIED"
  ) {
    return false;
  }

  // Client validation / payload errors should not trigger alternative provider
  if (error.code === 400 || error.status === "INVALID_ARGUMENT") {
    return false;
  }

  const code = Number(error.code || error.statusCode);
  const status = String(error.status || "").toUpperCase();
  const lowerMsg = String(error.message || "").toLowerCase();

  const isRateLimit =
    code === 429 ||
    status === "RESOURCE_EXHAUSTED" ||
    lowerMsg.includes("rate limit") ||
    lowerMsg.includes("quota") ||
    lowerMsg.includes("too many requests") ||
    lowerMsg.includes("resource_exhausted");

  const isUnavailable =
    code === 503 ||
    code === 504 ||
    status === "UNAVAILABLE" ||
    status === "DEADLINE_EXCEEDED" ||
    lowerMsg.includes("high demand") ||
    lowerMsg.includes("spikes in demand") ||
    lowerMsg.includes("overloaded");

  return isRateLimit || isUnavailable;
}

/**
 * Selects an eligible alternative fallback provider.
 * Respects vision capabilities: Groq and OpenRouter cannot process images.
 * @param {string} failedProvider
 * @param {{ hasImages?: boolean }} [options]
 * @returns {Promise<string|null>}
 */
export async function getEligibleFallbackProvider(failedProvider, { hasImages = false } = {}) {
  // If images are attached, only Gemini supports vision analysis
  if (hasImages) {
    return null;
  }

  const configured = await fetchConfiguredProviders();
  const normalizedFailed = (failedProvider || "").toLowerCase();

  // Preferred fallback order: Groq (high speed inference) -> OpenRouter (multi-model)
  const candidates = [AI_PROVIDERS.GROQ, AI_PROVIDERS.OPENROUTER, AI_PROVIDERS.GEMINI];
  for (const candidate of candidates) {
    if (candidate !== normalizedFailed && configured.includes(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Streams chat responses from the selected AI provider progressively.
 *
 * @param {Object} params
 * @param {string} [params.provider='gemini'] - The selected provider ('gemini' | 'groq' | 'openrouter')
 * @param {string} params.prompt - Current user input prompt
 * @param {Array} [params.history=[]] - Previous conversation messages
 * @param {string|null} [params.username=null] - Preferred username for personalization
 * @param {Object|null} [params.preferences=null] - User response preferences (responseLength, beginnerFriendly)
 * @param {(chunkText: string, accumulatedText: string) => void} [params.onChunk]
 * @param {({ modelUsed: string, provider: string }) => void} [params.onStart]
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<{ text: string, modelUsed: string, provider: string }>}
 */
function toValidHttpStatus(code, fallback = 500) {
  if (code === null || code === undefined) return fallback;
  const num = typeof code === "number" ? code : parseInt(String(code), 10);
  return Number.isInteger(num) && num >= 100 && num <= 599 ? num : fallback;
}

/**
 * Parses raw error representations into clean, friendly error objects
 */
export function parseRouterError(rawError, statusCode = 500) {
  try {
    // 1. Detect AbortError, client cancellation, or DOMException code 20 immediately
    const isAbort =
      rawError?.name === "AbortError" ||
      rawError?.code === "ABORT_ERR" ||
      (rawError?.code === 20 && rawError?.name === "DOMException");

    if (isAbort) {
      const abortErr = new Error("Request was cancelled.");
      abortErr.name = "AbortError";
      abortErr.code = 20;
      abortErr.status = "CANCELLED";
      abortErr.retryable = false;
      return abortErr;
    }

    let cleanMsg = "";
    let status = "";
    let retryable = undefined;
    let provider = undefined;
    let model = undefined;
    let canFallback = undefined;
    let suggestedProviders = undefined;
    let retryAfterSeconds = undefined;

    if (rawError?.retryAfterSeconds) {
      const p = parseInt(String(rawError.retryAfterSeconds), 10);
      if (!isNaN(p)) retryAfterSeconds = p;
    }

    // 2. Read actual HTTP response status first when a Fetch Response is available
    if (typeof Response !== "undefined" && rawError instanceof Response) {
      statusCode = rawError.status;
      cleanMsg = `Server request failed (${toValidHttpStatus(rawError.status, 500)})`;
    } else if (typeof rawError === "string") {
      cleanMsg = rawError;
    } else if (rawError && typeof rawError === "object") {
      if (typeof rawError.error === "string") {
        cleanMsg = rawError.error;
      } else if (rawError.error && typeof rawError.error === "object") {
        cleanMsg = rawError.error.message || String(rawError.error);
        if (rawError.error.status) status = String(rawError.error.status);
      } else if (typeof rawError.message === "string") {
        cleanMsg = rawError.message;
      }

      if (rawError.status) status = String(rawError.status);
      if (typeof rawError.retryable === "boolean")
        retryable = rawError.retryable;
      if (rawError.provider) provider = String(rawError.provider);
      if (rawError.model) model = String(rawError.model);
      if (typeof rawError.canFallback === "boolean")
        canFallback = rawError.canFallback;
      if (Array.isArray(rawError.suggestedProviders))
        suggestedProviders = rawError.suggestedProviders;
    }

    // 3. Determine HTTP status code strictly in range 100-599
    // Accept only valid HTTP status codes
    let code = toValidHttpStatus(statusCode, 0);

    // If statusCode was not a valid HTTP status, check rawError properties with strict range validation
    if (!code) {
      if (rawError?.statusCode && toValidHttpStatus(rawError.statusCode, 0)) {
        code = toValidHttpStatus(rawError.statusCode);
      } else if (rawError?.code && toValidHttpStatus(rawError.code, 0)) {
        code = toValidHttpStatus(rawError.code);
      } else {
        code = 500;
      }
    }

    // 4. Unpack nested JSON strings safely (up to 3 levels)
    for (let i = 0; i < 3; i++) {
      if (typeof cleanMsg !== "string") break;
      const match = cleanMsg.match(/\{[\s\S]*\}/);
      if (!match) break;
      try {
        const parsed = JSON.parse(match[0]);
        if (parsed.error) {
          if (parsed.error.code && toValidHttpStatus(parsed.error.code, 0)) {
            code = toValidHttpStatus(parsed.error.code);
          }
          if (parsed.error.status) status = String(parsed.error.status);
          if (parsed.error.message) {
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

    // 5. Intercept and sanitize internal server RangeErrors such as "Invalid status code: 20"
    if (
      typeof cleanMsg === "string" &&
      (cleanMsg.includes("Invalid status code") ||
        cleanMsg.includes("ERR_HTTP_INVALID_STATUS_CODE") ||
        cleanMsg.includes("RangeError"))
    ) {
      cleanMsg =
        "The AI service encountered an internal error. Please try again or switch providers.";
      code = 500;
      status = "INTERNAL";
    }

    const lowerMsg = String(cleanMsg || "").toLowerCase();
    const upperStatus = String(status || "").toUpperCase();

    // 6. Distinct, user-friendly classifications while preserving original messages
    const isTimeout =
      code === 504 ||
      upperStatus === "DEADLINE_EXCEEDED" ||
      lowerMsg.includes("timed out") ||
      lowerMsg.includes("timeout") ||
      lowerMsg.includes("deadline exceeded");

    if (isTimeout) {
      code = 504;
      status = "DEADLINE_EXCEEDED";
      retryable = true;
      if (!cleanMsg || cleanMsg.includes("Server request failed")) {
        cleanMsg =
          "The AI service timed out while waiting for a response. Please try again.";
      }
    } else if (
      code === 503 ||
      upperStatus === "UNAVAILABLE" ||
      lowerMsg.includes("high demand") ||
      lowerMsg.includes("spikes in demand") ||
      lowerMsg.includes("overloaded")
    ) {
      code = 503;
      status = "UNAVAILABLE";
      retryable = true;
      if (!cleanMsg || cleanMsg.includes("Server request failed")) {
        cleanMsg =
          "Google Gemini is currently experiencing high demand. Spikes in demand are usually temporary. Please try again in a few moments.";
      }
    } else if (
      code === 429 ||
      upperStatus === "RESOURCE_EXHAUSTED" ||
      lowerMsg.includes("rate limit") ||
      lowerMsg.includes("quota")
    ) {
      code = 429;
      status = "RESOURCE_EXHAUSTED";
      retryable = true;
      if (!cleanMsg || cleanMsg.includes("Server request failed")) {
        cleanMsg =
          "AI rate limit or quota exceeded. Please wait a moment before trying again.";
      }
    } else if (
      code === 401 ||
      code === 403 ||
      upperStatus === "UNAUTHENTICATED" ||
      upperStatus === "PERMISSION_DENIED" ||
      lowerMsg.includes("api_key_invalid") ||
      lowerMsg.includes("api key not valid") ||
      lowerMsg.includes("unauthorized") ||
      lowerMsg.includes("permission denied")
    ) {
      code = code === 401 ? 401 : 403;
      status = code === 401 ? "UNAUTHENTICATED" : "PERMISSION_DENIED";
      retryable = false;
      if (!cleanMsg || cleanMsg.includes("Server request failed")) {
        cleanMsg =
          "Invalid or unauthorized API key. Please check your configuration.";
      }
    } else if (code === 404 || upperStatus === "NOT_FOUND") {
      code = 404;
      status = "NOT_FOUND";
      retryable = false;
    } else if (code === 400 || upperStatus === "INVALID_ARGUMENT") {
      code = 400;
      status = "INVALID_ARGUMENT";
      retryable = false;
    } else if (code === 500 || upperStatus === "INTERNAL") {
      code = 500;
      status = "INTERNAL";
      retryable = false;
      if (
        !cleanMsg ||
        cleanMsg === "Internal Server Error" ||
        cleanMsg.includes("Server request failed (500)")
      ) {
        cleanMsg =
          "The AI service encountered an internal error. Please try again or switch providers.";
      }
    }

    code = toValidHttpStatus(code, 500);

    const err = new Error(
      cleanMsg ||
        "An unexpected error occurred while communicating with the AI service.",
    );
    err.code = code;
    err.status = status || (code >= 500 ? "INTERNAL" : "ERROR");
    err.retryable =
      typeof retryable === "boolean"
        ? retryable
        : code === 503 || code === 429 || code === 504;
    if (provider) err.provider = provider;
    if (model) err.model = model;
    if (typeof canFallback === "boolean") err.canFallback = canFallback;
    if (suggestedProviders) err.suggestedProviders = suggestedProviders;
    if (retryAfterSeconds !== undefined) err.retryAfterSeconds = retryAfterSeconds;
    return err;
  } catch (_) {
    const fallbackErr = new Error(
      "The AI service encountered an error. Please try again.",
    );
    fallbackErr.code = 500;
    fallbackErr.status = "INTERNAL";
    fallbackErr.retryable = false;
    return fallbackErr;
  }
}

export async function streamAIMessage({
  provider = DEFAULT_PROVIDER,
  mode = "general",
  prompt,
  history = [],
  username = null,
  preferences = null,
  documents = [],
  images = [],
  onChunk,
  onStart,
  onFallback,
  signal,
  allowFallback = true,
}) {
  const normalizedInitialProvider = (provider || DEFAULT_PROVIDER).toLowerCase();
  const normalizedMode = (mode || "general").toLowerCase();
  const hasImages = Array.isArray(images) && images.length > 0;

  // Single-attempt streaming executor over /api/chat with SSE
  async function executeStreamAttempt(providerToUse, isFallbackAttempt = false) {
    let chunksEmitted = 0;
    let accumulatedText = "";
    let reportedModelUsed = null;
    let reportedProvider = providerToUse;

    const res = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        provider: providerToUse,
        mode: normalizedMode,
        prompt,
        history,
        username: username ? String(username).trim() : null,
        preferences: preferences || null,
        documents,
        images: formatImagePayload(images),
        stream: true,
        isFallback: isFallbackAttempt,
      }),
      signal,
    });

    if (!res.ok) {
      let errJson = null;
      let errText = "";
      try {
        const cloned = res.clone();
        errJson = await cloned.json().catch(() => null);
      } catch (_) {}
      if (!errJson) {
        errText = await res.text().catch(() => "");
      }

      const httpStatus = toValidHttpStatus(res.status, 500);
      const rawPayload =
        errJson || errText || `Server request failed (${httpStatus})`;
      const parsedErr = parseRouterError(rawPayload, httpStatus);

      parsedErr.provider = providerToUse;
      if (errJson?.provider) parsedErr.provider = errJson.provider;
      if (errJson?.model) parsedErr.model = errJson.model;
      if (typeof errJson?.retryable === "boolean")
        parsedErr.retryable = errJson.retryable;
      if (typeof errJson?.canFallback === "boolean")
        parsedErr.canFallback = errJson.canFallback;
      if (Array.isArray(errJson?.suggestedProviders))
        parsedErr.suggestedProviders = errJson.suggestedProviders;
      if (errJson?.retryAfterSeconds)
        parsedErr.retryAfterSeconds = errJson.retryAfterSeconds;

      throw parsedErr;
    }

    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("text/event-stream") && res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("data: ")) continue;
            const dataStr = trimmed.slice(6);

            try {
              const data = JSON.parse(dataStr);
              if (data.type === "start") {
                reportedModelUsed = data.modelUsed;
                reportedProvider = data.provider || providerToUse;
                onStart?.({
                  modelUsed: reportedModelUsed,
                  provider: reportedProvider,
                  isFallback: isFallbackAttempt,
                });
              } else if (data.type === "chunk" && data.text) {
                accumulatedText += data.text;
                chunksEmitted++;
                onChunk?.(data.text, accumulatedText);
              } else if (data.type === "done") {
                if (data.modelUsed) reportedModelUsed = data.modelUsed;
                if (data.provider) reportedProvider = data.provider;
                return {
                  text: data.text || accumulatedText,
                  modelUsed: reportedModelUsed || "AI Model",
                  provider: reportedProvider,
                  isFallback: isFallbackAttempt,
                  chunksEmitted,
                };
              } else if (data.type === "error") {
                const sseCode = toValidHttpStatus(data.code, 500);
                const streamErr = parseRouterError(data, sseCode);
                streamErr.provider = data.provider || providerToUse;
                if (data.model) streamErr.model = data.model;
                if (typeof data.retryable === "boolean")
                  streamErr.retryable = data.retryable;
                if (typeof data.canFallback === "boolean")
                  streamErr.canFallback = data.canFallback;
                if (Array.isArray(data.suggestedProviders))
                  streamErr.suggestedProviders = data.suggestedProviders;
                if (data.retryAfterSeconds)
                  streamErr.retryAfterSeconds = data.retryAfterSeconds;

                // Track whether any meaningful text was delivered to the user
                if (chunksEmitted > 0 || accumulatedText.length > 0) {
                  streamErr.partial = true;
                  streamErr.partialContent = accumulatedText;
                }
                throw streamErr;
              }
            } catch (jsonErr) {
              if (jsonErr.message && !jsonErr.message.includes("JSON")) {
                throw jsonErr;
              }
            }
          }
        }

        // Process any remainder in buffer
        if (buffer && buffer.trim().startsWith("data: ")) {
          const dataStr = buffer.trim().slice(6);
          try {
            const data = JSON.parse(dataStr);
            if (data.type === "done") {
              if (data.modelUsed) reportedModelUsed = data.modelUsed;
              if (data.provider) reportedProvider = data.provider;
              return {
                text: data.text || accumulatedText,
                modelUsed: reportedModelUsed || "AI Model",
                provider: reportedProvider,
                isFallback: isFallbackAttempt,
                chunksEmitted,
              };
            } else if (data.type === "error") {
              const sseCode = toValidHttpStatus(data.code, 500);
              const streamErr = parseRouterError(data, sseCode);
              if (chunksEmitted > 0 || accumulatedText.length > 0) {
                streamErr.partial = true;
                streamErr.partialContent = accumulatedText;
              }
              throw streamErr;
            }
          } catch (_) {}
        }

        return {
          text: accumulatedText,
          modelUsed: reportedModelUsed || "AI Model",
          provider: reportedProvider,
          isFallback: isFallbackAttempt,
          chunksEmitted,
        };
      } finally {
        reader.releaseLock();
      }
    } else {
      // Non-streaming JSON response fallback
      const data = await res.json();
      onChunk?.(data.text, data.text);
      return {
        text: data.text,
        modelUsed: data.modelUsed,
        provider: data.provider || providerToUse,
        isFallback: isFallbackAttempt,
        chunksEmitted: 1,
      };
    }
  }

  // Attempt primary provider
  try {
    const primaryResult = await executeStreamAttempt(
      normalizedInitialProvider,
      false,
    );
    return {
      ...primaryResult,
      fallbackOccurred: false,
    };
  } catch (primaryErr) {
    // 1. Never fallback on intentional user abort or cancellation
    if (
      signal?.aborted ||
      primaryErr?.name === "AbortError" ||
      primaryErr?.code === 20 ||
      primaryErr?.code === "ABORT_ERR"
    ) {
      throw primaryErr;
    }

    // 2. If partial stream content was already emitted to the user,
    // do not restart stream from another provider to avoid duplicating/contradicting partial answer
    if (primaryErr?.partial || primaryErr?.partialContent) {
      throw primaryErr;
    }

    // 3. Check fallback eligibility (429 rate-limit, 503 unavailable, 504 timeout)
    const isEligible = allowFallback && isFallbackEligibleError(primaryErr);
    if (!isEligible) {
      throw primaryErr;
    }

    // 4. Find an eligible alternative configured provider
    const fallbackProvider = await getEligibleFallbackProvider(
      normalizedInitialProvider,
      {
        hasImages,
      },
    );

    if (fallbackProvider) {
      console.warn(
        `[AI Router] Provider "${normalizedInitialProvider}" rate-limited/unavailable (${primaryErr.code || primaryErr.status}). Executing automatic fallback to "${fallbackProvider}".`,
      );

      onFallback?.({
        fromProvider: normalizedInitialProvider,
        toProvider: fallbackProvider,
        reason: primaryErr.message,
      });

      try {
        const fallbackResult = await executeStreamAttempt(
          fallbackProvider,
          true,
        );
        return {
          ...fallbackResult,
          fallbackOccurred: true,
          originalProvider: normalizedInitialProvider,
        };
      } catch (fallbackErr) {
        if (signal?.aborted) throw fallbackErr;
        console.error(
          `[AI Router] Fallback provider "${fallbackProvider}" also failed:`,
          fallbackErr.message,
        );

        const allFailedErr = new Error(
          "Orvix couldn't generate a response because the available AI providers are currently unavailable or rate-limited. Please try again later or check your provider configuration.",
        );
        allFailedErr.code = 503;
        allFailedErr.status = "UNAVAILABLE";
        allFailedErr.allProvidersFailed = true;
        allFailedErr.originalProvider = normalizedInitialProvider;
        allFailedErr.failedBackupProvider = fallbackProvider;
        allFailedErr.originalError = primaryErr;
        allFailedErr.fallbackError = fallbackErr;
        throw allFailedErr;
      }
    }

    // 5. No eligible alternative backup is configured
    const isRateLimit =
      primaryErr.code === 429 ||
      primaryErr.status === "RESOURCE_EXHAUSTED" ||
      String(primaryErr.message || "")
        .toLowerCase()
        .includes("rate limit") ||
      String(primaryErr.message || "")
        .toLowerCase()
        .includes("quota") ||
      String(primaryErr.message || "")
        .toLowerCase()
        .includes("too many requests");

    if (normalizedInitialProvider === AI_PROVIDERS.GEMINI && isRateLimit) {
      const quotaMsg = hasImages
        ? "Gemini has reached its current rate or quota limit. Image vision analysis is only supported by Google Gemini. Please wait a moment before trying again."
        : "Gemini has reached its current rate or quota limit. Please wait and try again, check your Gemini API quota, or configure Groq/OpenRouter for automatic fallback.";

      const quotaErr = new Error(quotaMsg);
      quotaErr.code = 429;
      quotaErr.status = "RESOURCE_EXHAUSTED";
      quotaErr.provider = AI_PROVIDERS.GEMINI;
      quotaErr.canFallback = false;
      quotaErr.retryAfterSeconds = primaryErr.retryAfterSeconds;
      quotaErr.originalError = primaryErr;
      throw quotaErr;
    }

    throw primaryErr;
  }
}

/**
 * Common entry point for sending chat messages to the selected AI provider.
 * Maintained for interface compatibility; internally streams or resolves the full response.
 *
 * @param {Object} params
 * @returns {Promise<{ text: string, modelUsed: string, provider: string }>}
 */
export async function sendAIMessage(params) {
  return streamAIMessage(params);
}
