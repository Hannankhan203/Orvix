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

/**
 * Checks if a given provider currently has an API key configured.
 * @param {string} provider
 * @returns {boolean}
 */
export function isProviderConfigured(provider) {
  switch (provider) {
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
  signal,
}) {
  const normalizedProvider = provider.toLowerCase();
  const normalizedMode = (mode || "general").toLowerCase();

  // Primary path: Use secure server-side proxy route /api/chat with SSE
  // Server executes bounded retries with jitter; avoid multiplying client-side delays
  const maxClientAttempts = 1;
  let clientAttempt = 0;

  while (clientAttempt < maxClientAttempts) {
    clientAttempt++;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          provider: normalizedProvider,
          mode: normalizedMode,
          prompt,
          history,
          username: username ? String(username).trim() : null,
          preferences: preferences || null,
          documents,
          images: formatImagePayload(images),
          stream: true,
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

        if (errJson?.provider) parsedErr.provider = errJson.provider;
        if (errJson?.model) parsedErr.model = errJson.model;
        if (typeof errJson?.retryable === "boolean")
          parsedErr.retryable = errJson.retryable;
        if (typeof errJson?.canFallback === "boolean")
          parsedErr.canFallback = errJson.canFallback;
        if (Array.isArray(errJson?.suggestedProviders))
          parsedErr.suggestedProviders = errJson.suggestedProviders;

        throw parsedErr;
      }

      const contentType = res.headers.get("content-type") || "";
      if (contentType.includes("text/event-stream") && res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let accumulatedText = "";
        let modelUsed = null;
        let finalProvider = normalizedProvider;

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
                  modelUsed = data.modelUsed;
                  finalProvider = data.provider || normalizedProvider;
                  onStart?.({ modelUsed, provider: finalProvider });
                } else if (data.type === "chunk" && data.text) {
                  accumulatedText += data.text;
                  onChunk?.(data.text, accumulatedText);
                } else if (data.type === "done") {
                  if (data.modelUsed) modelUsed = data.modelUsed;
                  if (data.provider) finalProvider = data.provider;
                  const finalText = data.text || accumulatedText;
                  return {
                    text: finalText,
                    modelUsed: modelUsed || "AI Model",
                    provider: finalProvider,
                  };
                } else if (data.type === "error") {
                  const sseCode = toValidHttpStatus(data.code, 500);
                  const streamErr = parseRouterError(data, sseCode);
                  if (data.provider) streamErr.provider = data.provider;
                  if (data.model) streamErr.model = data.model;
                  if (typeof data.retryable === "boolean")
                    streamErr.retryable = data.retryable;
                  if (typeof data.canFallback === "boolean")
                    streamErr.canFallback = data.canFallback;
                  if (Array.isArray(data.suggestedProviders))
                    streamErr.suggestedProviders = data.suggestedProviders;
                  throw streamErr;
                }
              } catch (jsonErr) {
                if (jsonErr.message && !jsonErr.message.includes("JSON")) {
                  throw jsonErr;
                }
              }
            }
          }

          if (buffer && buffer.trim().startsWith("data: ")) {
            const dataStr = buffer.trim().slice(6);
            try {
              const data = JSON.parse(dataStr);
              if (data.type === "start") {
                modelUsed = data.modelUsed;
                finalProvider = data.provider || normalizedProvider;
                onStart?.({ modelUsed, provider: finalProvider });
              } else if (data.type === "chunk" && data.text) {
                accumulatedText += data.text;
                onChunk?.(data.text, accumulatedText);
              } else if (data.type === "done") {
                if (data.modelUsed) modelUsed = data.modelUsed;
                if (data.provider) finalProvider = data.provider;
                return {
                  text: data.text || accumulatedText,
                  modelUsed: modelUsed || "AI Model",
                  provider: finalProvider,
                };
              } else if (data.type === "error") {
                const sseCode = toValidHttpStatus(data.code, 500);
                const streamErr = parseRouterError(data, sseCode);
                if (data.provider) streamErr.provider = data.provider;
                if (data.model) streamErr.model = data.model;
                if (typeof data.retryable === "boolean")
                  streamErr.retryable = data.retryable;
                if (typeof data.canFallback === "boolean")
                  streamErr.canFallback = data.canFallback;
                if (Array.isArray(data.suggestedProviders))
                  streamErr.suggestedProviders = data.suggestedProviders;
                throw streamErr;
              }
            } catch (error) {
              if (error instanceof Error && error.message) {
                throw error;
              }
            }
          }

          return {
            text: accumulatedText,
            modelUsed: modelUsed || "AI Model",
            provider: finalProvider,
          };
        } finally {
          reader.releaseLock();
        }
      } else {
        // Non-streaming response fallback
        const data = await res.json();
        onChunk?.(data.text, data.text);
        return {
          text: data.text,
          modelUsed: data.modelUsed,
          provider: data.provider || normalizedProvider,
        };
      }
    } catch (apiErr) {
      if (
        signal?.aborted ||
        apiErr?.name === "AbortError" ||
        apiErr?.code === 20 ||
        apiErr?.code === "ABORT_ERR"
      ) {
        throw apiErr;
      }

      if (apiErr?.retryable && clientAttempt < maxClientAttempts) {
        const delay = 1000 + Math.random() * 500;
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      if (
        apiErr.name === "TypeError" &&
        isProviderConfigured(normalizedProvider)
      ) {
        console.warn(
          "Backend proxy unreachable, attempting client-side streaming fallback:",
          apiErr.message,
        );
        break;
      }

      throw apiErr;
    }
  }

  // Client-side direct service fallback
  if (images && images.length > 0 && !isVisionSupported(normalizedProvider)) {
    const visionErr = new Error(
      "Image vision analysis is currently supported by Google Gemini. Please switch to Gemini to analyze attached images.",
    );
    visionErr.code = 400;
    visionErr.status = "INVALID_ARGUMENT";
    visionErr.provider = normalizedProvider;
    visionErr.canFallback = true;
    visionErr.suggestedProviders = ["gemini"];
    throw visionErr;
  }

  switch (normalizedProvider) {
    case AI_PROVIDERS.GROQ: {
      const result = await streamGroqMessage({
        prompt,
        history,
        mode: normalizedMode,
        documents,
        onChunk,
        signal,
      });
      return {
        ...result,
        provider: AI_PROVIDERS.GROQ,
      };
    }

    case AI_PROVIDERS.OPENROUTER: {
      const result = await streamOpenRouterMessage({
        prompt,
        history,
        mode: normalizedMode,
        documents,
        onChunk,
        signal,
      });
      return {
        ...result,
        provider: AI_PROVIDERS.OPENROUTER,
      };
    }

    case AI_PROVIDERS.GEMINI:
    default: {
      const result = await streamGeminiMessage({
        prompt,
        history,
        username,
        mode: normalizedMode,
        documents,
        images,
        onChunk,
        signal,
      });
      return {
        ...result,
        provider: AI_PROVIDERS.GEMINI,
      };
    }
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
