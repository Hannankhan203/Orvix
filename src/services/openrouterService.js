/**
 * Orvix OpenRouter AI Service
 * Dedicated service module handling communication with OpenRouter API.
 * Uses OpenRouter's OpenAI-compatible endpoint with free model preference.
 *
 * NOTE: As per prototype requirements, the client reads VITE_OPENROUTER_API_KEY.
 * For production deployment, API requests should be proxied through a secure backend.
 */

import { getChatMode } from '../config/chatModes.js';
import { buildDocumentContext } from '../utils/documentContext.js';

export function getOpenRouterApiKey() {
  try {
    if (typeof import.meta !== 'undefined' && import.meta?.env?.VITE_OPENROUTER_API_KEY) {
      return import.meta.env.VITE_OPENROUTER_API_KEY;
    }
  } catch (_) {
    // Ignore error in non-Vite environments
  }

  if (typeof process !== 'undefined' && process.env) {
    return process.env.VITE_OPENROUTER_API_KEY || '';
  }

  return '';
}

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
// OpenRouter free model
const DEFAULT_MODEL = 'openrouter/free';

/**
 * Formats conversation history into OpenAI-compatible format expected by OpenRouter.
 * @param {Array} history
 * @param {string} prompt
 * @param {number} [maxContextMessages=12]
 * @param {string} [mode='general']
 * @returns {Array<{ role: string, content: string }>}
 */
export function formatOpenRouterMessages(history = [], prompt, maxContextMessages = 12, mode = 'general', documents = []) {
  const modeObj = getChatMode(mode);
  const systemContentParts = [
    'You are Orvix, an intelligent, helpful, and concise AI conversation companion. Provide clear explanations, code blocks with languages where appropriate, and formatted answers.',
    modeObj.instruction
  ];

  if (documents && documents.length > 0) {
    const { documentContextText } = buildDocumentContext(documents, prompt);
    if (documentContextText) {
      systemContentParts.push(documentContextText);
    }
  }

  const messages = [
    {
      role: 'system',
      content: systemContentParts.filter(Boolean).join('\n\n')
    }
  ];

  const recent = history.slice(-maxContextMessages);
  for (const msg of recent) {
    if (!msg.content || !msg.content.trim()) continue;
    messages.push({
      role: msg.sender === 'user' ? 'user' : 'assistant',
      content: msg.content.trim()
    });
  }

  if (prompt && prompt.trim()) {
    messages.push({
      role: 'user',
      content: prompt.trim()
    });
  }

  return messages;
}

/**
 * Sends a conversation to the OpenRouter API and returns the generated text.
 * @param {Object} params
 * @param {string} params.prompt - Current user input prompt
 * @param {Array} [params.history=[]] - Previous conversation messages
 * @param {string} [params.mode='general']
 * @param {Array} [params.documents=[]]
 * @returns {Promise<{ text: string, modelUsed: string }>}
 */
export async function sendOpenRouterMessage({ prompt, history = [], mode = 'general', documents = [] }) {
  const apiKey = getOpenRouterApiKey();

  if (!apiKey || apiKey === 'YOUR_OPENROUTER_API_KEY') {
    throw new Error(
      'OpenRouter is not configured yet. Please add VITE_OPENROUTER_API_KEY to your environment configuration.'
    );
  }

  const messages = formatOpenRouterMessages(history, prompt, 12, mode, documents);

  let response;
  try {
    response = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000',
        'X-Title': 'Orvix AI Companion'
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        messages,
        temperature: 0.7
      })
    });
  } catch (netErr) {
    throw new Error('Network connection error while contacting OpenRouter. Please check your internet connection.');
  }

  if (!response.ok) {
    let errorDetail = '';
    try {
      const errJson = await response.json();
      errorDetail = errJson?.error?.message || '';
    } catch (_) {
      errorDetail = await response.text();
    }

    if (response.status === 401 || response.status === 403) {
      throw new Error('Invalid or unauthorized OpenRouter API key. Please check VITE_OPENROUTER_API_KEY.');
    }
    if (response.status === 429) {
      throw new Error('OpenRouter rate limit or credit limit reached. Please wait a moment before trying again.');
    }
    if (response.status === 503) {
      throw new Error('OpenRouter service is temporarily unavailable. Please retry shortly.');
    }

    throw new Error(`OpenRouter request failed (${response.status}): ${errorDetail || response.statusText}`);
  }

  const data = await response.json();
  const choice = data?.choices?.[0];

  if (!choice || !choice.message || !choice.message.content) {
    throw new Error('Received an empty response from OpenRouter.');
  }

  return {
    text: choice.message.content,
    modelUsed: data.model || DEFAULT_MODEL
  };
}

/**
 * Streams conversation responses from OpenRouter API incrementally.
 * @param {Object} params
 * @param {string} params.prompt
 * @param {Array} [params.history=[]]
 * @param {string} [params.mode='general']
 * @param {Array} [params.documents=[]]
 * @param {(chunk: string, accumulated: string) => void} [params.onChunk]
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<{ text: string, modelUsed: string }>}
 */
export async function streamOpenRouterMessage({ prompt, history = [], mode = 'general', documents = [], onChunk, signal }) {
  const apiKey = getOpenRouterApiKey();

  if (!apiKey || apiKey === 'YOUR_OPENROUTER_API_KEY') {
    throw new Error(
      'OpenRouter is not configured yet. Please add VITE_OPENROUTER_API_KEY to your environment configuration.'
    );
  }

  const messages = formatOpenRouterMessages(history, prompt, 12, mode, documents);

  let response;
  try {
    response = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000',
        'X-Title': 'Orvix AI Companion'
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        messages,
        temperature: 0.7,
        stream: true
      }),
      signal
    });
  } catch (netErr) {
    if (signal?.aborted) throw netErr;
    throw new Error('Network connection error while contacting OpenRouter. Please check your internet connection.');
  }

  if (!response.ok) {
    let errorDetail = '';
    try {
      const errJson = await response.json();
      errorDetail = errJson?.error?.message || '';
    } catch (_) {
      errorDetail = await response.text();
    }
    throw new Error(`OpenRouter request failed (${response.status}): ${errorDetail || response.statusText}`);
  }

  if (!response.body) {
    throw new Error('No readable response body received from OpenRouter.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let accumulated = '';
  let modelUsed = DEFAULT_MODEL;

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
      if (dataStr === '[DONE]') continue;
      try {
        const parsed = JSON.parse(dataStr);
        if (parsed.model) modelUsed = parsed.model;
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) {
          accumulated += delta;
          onChunk?.(delta, accumulated);
        }
      } catch (_) {}
    }
  }

  return {
    text: accumulated,
    modelUsed
  };
}

