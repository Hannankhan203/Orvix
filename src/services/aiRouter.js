/**
 * Orvix AI Provider Router
 * Central dispatch service routing chat requests to the selected provider (Gemini, Groq, OpenRouter).
 * Normalizes parameters, formats, and outputs across all three providers.
 */

import { sendGeminiMessage, streamGeminiMessage, getGeminiApiKey } from './geminiService.js';
import { sendGroqMessage, streamGroqMessage, getGroqApiKey } from './groqService.js';
import { sendOpenRouterMessage, streamOpenRouterMessage, getOpenRouterApiKey } from './openrouterService.js';
import { sendCloudflareMessage, streamCloudflareMessage } from './cloudflareService.js';

export const AI_PROVIDERS = {
  GEMINI: 'gemini',
  GROQ: 'groq',
  OPENROUTER: 'openrouter',
  CLOUDFLARE: 'cloudflare'
};

export const PROVIDER_OPTIONS = [
  {
    id: AI_PROVIDERS.GEMINI,
    name: 'Gemini',
    modelTag: 'Gemini 3.1 Flash Lite',
    description: 'Google Gemini',
    envKey: 'VITE_GEMINI_API_KEY'
  },
  {
    id: AI_PROVIDERS.GROQ,
    name: 'Groq',
    modelTag: 'Llama 3.3 70B',
    description: 'Ultra-fast inference',
    envKey: 'VITE_GROQ_API_KEY'
  },
  {
    id: AI_PROVIDERS.OPENROUTER,
    name: 'OpenRouter',
    modelTag: 'Llama 3.3 70B (Free)',
    description: 'Multi-model gateway',
    envKey: 'VITE_OPENROUTER_API_KEY'
  },
  {
    id: AI_PROVIDERS.CLOUDFLARE,
    name: 'Cloudflare Workers AI',
    modelTag: 'Llama 3.1 8B',
    label: 'Cloudflare Workers AI — Llama 3.1 8B',
    description: 'Cloudflare Workers AI serverless GPU inference',
    envKey: 'CLOUDFLARE_API_TOKEN'
  }
];

export const DEFAULT_PROVIDER = AI_PROVIDERS.GEMINI;

/**
 * Checks if a given provider currently has an API key configured.
 * @param {string} provider
 * @returns {boolean}
 */
export function isProviderConfigured(provider) {
  switch (provider) {
    case AI_PROVIDERS.GROQ: {
      const key = getGroqApiKey();
      return Boolean(key && key !== 'YOUR_GROQ_API_KEY');
    }
    case AI_PROVIDERS.OPENROUTER: {
      const key = getOpenRouterApiKey();
      return Boolean(key && key !== 'YOUR_OPENROUTER_API_KEY');
    }
    case AI_PROVIDERS.CLOUDFLARE: {
      return true;
    }
    case AI_PROVIDERS.GEMINI:
    default: {
      const key = getGeminiApiKey();
      return Boolean(key && key !== 'YOUR_GEMINI_API_KEY');
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
/**
 * Parses raw error representations into clean, friendly error objects
 */
function parseRouterError(rawError, statusCode = 500) {
  let cleanMsg = typeof rawError === 'string' ? rawError : rawError?.message || '';
  let code = Number(rawError?.code || statusCode || 500);
  let status = String(rawError?.status || '');
  let retryable = rawError?.retryable;

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
        if (parsed.error.message) cleanMsg = String(parsed.error.message);
        else break;
      } else {
        break;
      }
    } catch (_) {
      break;
    }
  }

  const lowerMsg = String(cleanMsg).toLowerCase();
  const upperStatus = String(status).toUpperCase();

  // Distinct error classification
  if (
    code === 503 ||
    upperStatus === 'UNAVAILABLE' ||
    (lowerMsg.includes('high demand') && !lowerMsg.includes('500')) ||
    (lowerMsg.includes('spikes in demand') && !lowerMsg.includes('500')) ||
    lowerMsg.includes('overloaded')
  ) {
    code = 503;
    status = 'UNAVAILABLE';
    retryable = true;
    cleanMsg = 'Google Gemini is currently experiencing high demand. Spikes in demand are usually temporary. Please try again in a few moments.';
  } else if (
    code === 429 ||
    upperStatus === 'RESOURCE_EXHAUSTED' ||
    lowerMsg.includes('rate limit') ||
    lowerMsg.includes('quota')
  ) {
    code = 429;
    status = 'RESOURCE_EXHAUSTED';
    retryable = true;
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
    cleanMsg = 'Invalid or unauthorized API key. Please check your configuration.';
  } else if (code === 404 || upperStatus === 'NOT_FOUND') {
    code = 404;
    status = 'NOT_FOUND';
    retryable = false;
  } else if (code === 400 || upperStatus === 'INVALID_ARGUMENT') {
    code = 400;
    status = 'INVALID_ARGUMENT';
    retryable = false;
  } else if (code === 504 || upperStatus === 'DEADLINE_EXCEEDED') {
    code = 504;
    status = 'DEADLINE_EXCEEDED';
    retryable = true;
    cleanMsg = 'The AI service timed out while waiting for a response. Please try again.';
  } else if (code === 500 || upperStatus === 'INTERNAL') {
    code = 500;
    status = 'INTERNAL';
    retryable = false;
    if (!cleanMsg || cleanMsg === 'Internal Server Error' || cleanMsg.includes('Server request failed (500)')) {
      cleanMsg = 'The AI service encountered an internal error. Please try again or switch providers.';
    }
  }

  const err = new Error(cleanMsg || 'An unexpected error occurred while communicating with the AI service.');
  err.code = code;
  err.status = status;
  err.retryable = retryable ?? (code === 503 || code === 429);
  return err;
}

export async function streamAIMessage({
  provider = DEFAULT_PROVIDER,
  mode = 'general',
  prompt,
  history = [],
  username = null,
  preferences = null,
  attachments = [],
  onChunk,
  onStart,
  signal
}) {
  const normalizedProvider = provider.toLowerCase();
  const normalizedMode = (mode || 'general').toLowerCase();

  // Primary path: Use secure server-side proxy route /api/chat with SSE
  // Server executes bounded retries with jitter; avoid multiplying client-side delays
  const maxClientAttempts = 1;
  let clientAttempt = 0;

  while (clientAttempt < maxClientAttempts) {
    clientAttempt++;
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream'
        },
        body: JSON.stringify({
          provider: normalizedProvider,
          mode: normalizedMode,
          prompt,
          history,
          username: username ? String(username).trim() : null,
          preferences: preferences || null,
          attachments: Array.isArray(attachments) ? attachments : [],
          stream: true
        }),
        signal
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => null);
        const parsedErr = parseRouterError(errJson?.error || `Server request failed (${res.status})`, res.status);
        if (errJson?.code) parsedErr.code = errJson.code;
        if (errJson?.status) parsedErr.status = errJson.status;
        if (typeof errJson?.retryable === 'boolean') parsedErr.retryable = errJson.retryable;
        if (errJson?.provider) parsedErr.provider = errJson.provider;
        if (typeof errJson?.canFallback === 'boolean') parsedErr.canFallback = errJson.canFallback;
        if (Array.isArray(errJson?.suggestedProviders)) parsedErr.suggestedProviders = errJson.suggestedProviders;

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

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || !trimmed.startsWith('data: ')) continue;
              const dataStr = trimmed.slice(6);
              try {
                const data = JSON.parse(dataStr);
                if (data.type === 'start') {
                  modelUsed = data.modelUsed;
                  finalProvider = data.provider || normalizedProvider;
                  onStart?.({ modelUsed, provider: finalProvider });
                } else if (data.type === 'chunk' && data.text) {
                  accumulatedText += data.text;
                  onChunk?.(data.text, accumulatedText);
                } else if (data.type === 'done') {
                  if (data.modelUsed) modelUsed = data.modelUsed;
                  if (data.provider) finalProvider = data.provider;
                  const finalText = data.text || accumulatedText;
                  return {
                    text: finalText,
                    modelUsed: modelUsed || 'AI Model',
                    provider: finalProvider
                  };
                } else if (data.type === 'error') {
                  const streamErr = parseRouterError(data.error || 'Stream error occurred.', data.code || 500);
                  if (data.code) streamErr.code = data.code;
                  if (data.status) streamErr.status = data.status;
                  if (typeof data.retryable === 'boolean') streamErr.retryable = data.retryable;
                  throw streamErr;
                }
              } catch (jsonErr) {
                if (jsonErr.message && !jsonErr.message.includes('JSON')) {
                  throw jsonErr;
                }
              }
            }
          }

          if (buffer && buffer.trim().startsWith('data: ')) {
            const dataStr = buffer.trim().slice(6);
            try {
              const data = JSON.parse(dataStr);
              if (data.type === 'start') {
                modelUsed = data.modelUsed;
                finalProvider = data.provider || normalizedProvider;
                onStart?.({ modelUsed, provider: finalProvider });
              } else if (data.type === 'chunk' && data.text) {
                accumulatedText += data.text;
                onChunk?.(data.text, accumulatedText);
              } else if (data.type === 'done') {
                if (data.modelUsed) modelUsed = data.modelUsed;
                if (data.provider) finalProvider = data.provider;
                return {
                  text: data.text || accumulatedText,
                  modelUsed: modelUsed || 'AI Model',
                  provider: finalProvider
                };
              } else if (data.type === 'error') {
                const streamErr = parseRouterError(data.error || 'Stream error occurred.', data.code || 500);
                throw streamErr;
              }
            } catch (_) {}
          }

          return {
            text: accumulatedText,
            modelUsed: modelUsed || 'AI Model',
            provider: finalProvider
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
          provider: data.provider || normalizedProvider
        };
      }
    } catch (apiErr) {
      if (signal?.aborted) throw apiErr;

      if (apiErr?.retryable && clientAttempt < maxClientAttempts) {
        const delay = 1000 + Math.random() * 500;
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      if (apiErr.name === 'TypeError' && isProviderConfigured(normalizedProvider)) {
        console.warn('Backend proxy unreachable, attempting client-side streaming fallback:', apiErr.message);
        break;
      }

      throw apiErr;
    }
  }

  // Client-side direct service fallback
  switch (normalizedProvider) {
    case AI_PROVIDERS.GROQ: {
      const result = await streamGroqMessage({ prompt, history, mode: normalizedMode, onChunk, signal });
      return {
        ...result,
        provider: AI_PROVIDERS.GROQ
      };
    }

    case AI_PROVIDERS.OPENROUTER: {
      const result = await streamOpenRouterMessage({ prompt, history, mode: normalizedMode, onChunk, signal });
      return {
        ...result,
        provider: AI_PROVIDERS.OPENROUTER
      };
    }

    case AI_PROVIDERS.CLOUDFLARE: {
      const result = await streamCloudflareMessage({ prompt, history, mode: normalizedMode, onChunk, signal });
      return {
        ...result,
        provider: AI_PROVIDERS.CLOUDFLARE
      };
    }

    case AI_PROVIDERS.GEMINI:
    default: {
      const result = await streamGeminiMessage({ prompt, history, username, mode: normalizedMode, onChunk, signal });
      return {
        ...result,
        provider: AI_PROVIDERS.GEMINI
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
