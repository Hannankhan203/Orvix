/**
 * Orvix AI Provider Router
 * Central dispatch service routing chat requests to the selected provider (Gemini, Groq, OpenRouter).
 * Normalizes parameters, formats, and outputs across all three providers.
 */

import { sendGeminiMessage, streamGeminiMessage, getGeminiApiKey } from './geminiService.js';
import { sendGroqMessage, streamGroqMessage, getGroqApiKey } from './groqService.js';
import { sendOpenRouterMessage, streamOpenRouterMessage, getOpenRouterApiKey } from './openrouterService.js';

export const AI_PROVIDERS = {
  GEMINI: 'gemini',
  GROQ: 'groq',
  OPENROUTER: 'openrouter'
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
 * @param {(chunkText: string, accumulatedText: string) => void} [params.onChunk]
 * @param {({ modelUsed: string, provider: string }) => void} [params.onStart]
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<{ text: string, modelUsed: string, provider: string }>}
 */
export async function streamAIMessage({
  provider = DEFAULT_PROVIDER,
  prompt,
  history = [],
  username = null,
  onChunk,
  onStart,
  signal
}) {
  const normalizedProvider = provider.toLowerCase();

  // Primary path: Use secure server-side proxy route /api/chat with SSE
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream'
      },
      body: JSON.stringify({
        provider: normalizedProvider,
        prompt,
        history,
        username: username ? String(username).trim() : null,
        stream: true
      }),
      signal
    });

    if (!res.ok) {
      const errJson = await res.json().catch(() => null);
      if (errJson && errJson.error) {
        throw new Error(errJson.error);
      }
      throw new Error(`Server request failed (${res.status})`);
    }

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('text/event-stream') && res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let accumulatedText = '';
      let modelUsed = null;
      let finalProvider = normalizedProvider;

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
              throw new Error(data.error || 'Stream error occurred.');
            }
          } catch (jsonErr) {
            if (jsonErr.message && !jsonErr.message.includes('JSON')) {
              throw jsonErr;
            }
          }
        }
      }

      return {
        text: accumulatedText,
        modelUsed: modelUsed || 'AI Model',
        provider: finalProvider
      };
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
    if (apiErr.message && !apiErr.message.includes('fetch') && !apiErr.message.includes('Failed to fetch')) {
      throw apiErr;
    }
    console.warn('Backend proxy unreachable, attempting client-side streaming fallback:', apiErr.message);
  }

  // Client-side direct service fallback
  switch (normalizedProvider) {
    case AI_PROVIDERS.GROQ: {
      const result = await streamGroqMessage({ prompt, history, onChunk, signal });
      return {
        ...result,
        provider: AI_PROVIDERS.GROQ
      };
    }

    case AI_PROVIDERS.OPENROUTER: {
      const result = await streamOpenRouterMessage({ prompt, history, onChunk, signal });
      return {
        ...result,
        provider: AI_PROVIDERS.OPENROUTER
      };
    }

    case AI_PROVIDERS.GEMINI:
    default: {
      const result = await streamGeminiMessage({ prompt, history, username, onChunk, signal });
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
