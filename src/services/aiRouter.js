/**
 * Orvix AI Provider Router
 * Central dispatch service routing chat requests to the selected provider (Gemini, Groq, OpenRouter).
 * Normalizes parameters, formats, and outputs across all three providers.
 */

import { sendGeminiMessage, getGeminiApiKey } from './geminiService.js';
import { sendGroqMessage, getGroqApiKey } from './groqService.js';
import { sendOpenRouterMessage, getOpenRouterApiKey } from './openrouterService.js';

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
 * Common entry point for sending chat messages to the selected AI provider.
 *
 * @param {Object} params
 * @param {string} [params.provider='gemini'] - The selected provider ('gemini' | 'groq' | 'openrouter')
 * @param {string} params.prompt - Current user input prompt
 * @param {Array} [params.history=[]] - Previous conversation messages
 * @param {string|null} [params.username=null] - Current user's preferred username for personalization
 * @returns {Promise<{ text: string, modelUsed: string, provider: string }>}
 */
export async function sendAIMessage({ provider = DEFAULT_PROVIDER, prompt, history = [], username = null }) {
  const normalizedProvider = provider.toLowerCase();

  // Primary path: Use secure server-side proxy route /api/chat
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        provider: normalizedProvider,
        prompt,
        history,
        username: username ? String(username).trim() : null
      })
    });

    if (res.ok) {
      const data = await res.json();
      return {
        text: data.text,
        modelUsed: data.modelUsed,
        provider: data.provider || normalizedProvider
      };
    }

    const errJson = await res.json().catch(() => null);
    if (errJson && errJson.error) {
      throw new Error(errJson.error);
    }
  } catch (apiErr) {
    // If it's a specific API error message from the backend, rethrow it
    if (apiErr.message && !apiErr.message.includes('fetch') && !apiErr.message.includes('Failed to fetch')) {
      throw apiErr;
    }
    // Otherwise fallback to direct client-side services if server route is unreachable
    console.warn('Backend proxy unreachable, attempting client-side fallback:', apiErr.message);
  }

  // Client-side fallback
  switch (normalizedProvider) {
    case AI_PROVIDERS.GROQ: {
      const result = await sendGroqMessage({ prompt, history });
      return {
        ...result,
        provider: AI_PROVIDERS.GROQ
      };
    }

    case AI_PROVIDERS.OPENROUTER: {
      const result = await sendOpenRouterMessage({ prompt, history });
      return {
        ...result,
        provider: AI_PROVIDERS.OPENROUTER
      };
    }

    case AI_PROVIDERS.GEMINI:
    default: {
      const result = await sendGeminiMessage({ prompt, history, username });
      return {
        ...result,
        provider: AI_PROVIDERS.GEMINI
      };
    }
  }
}
