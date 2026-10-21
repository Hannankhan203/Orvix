/**
 * Orvix Hugging Face AI Service
 * Dedicated service module handling communication with Hugging Face Inference Providers.
 * Uses Hugging Face's OpenAI-compatible router endpoint: https://router.huggingface.co/v1/chat/completions
 *
 * NOTE: As per project architecture, requests are primarily proxied through server.ts (/api/chat)
 * so HUGGINGFACE_API_KEY remains protected on the backend.
 */

import { getChatMode } from '../config/chatModes.js';

export function getHuggingFaceApiKey() {
  try {
    if (typeof import.meta !== 'undefined' && import.meta?.env?.VITE_HUGGINGFACE_API_KEY) {
      return import.meta.env.VITE_HUGGINGFACE_API_KEY;
    }
  } catch (_) {
    // Ignore error in non-Vite environments
  }

  if (typeof process !== 'undefined' && process.env) {
    return process.env.HUGGINGFACE_API_KEY || process.env.VITE_HUGGINGFACE_API_KEY || '';
  }

  return '';
}

export const HUGGINGFACE_API_URL = 'https://router.huggingface.co/v1/chat/completions';
export const DEFAULT_HUGGINGFACE_MODEL = 'meta-llama/Llama-3.3-70B-Instruct';

/**
 * Formats conversation history into OpenAI-compatible format expected by Hugging Face router.
 * @param {Array} history
 * @param {string} prompt
 * @param {number} [maxContextMessages=12]
 * @param {string} [mode='general']
 * @returns {Array<{ role: string, content: string }>}
 */
export function formatHuggingFaceMessages(history = [], prompt, maxContextMessages = 12, mode = 'general') {
  const modeObj = getChatMode(mode);
  const systemContent = [
    'You are Orvix, an intelligent, helpful, and concise AI conversation companion. Provide clear explanations, code blocks with languages where appropriate, and formatted answers.',
    modeObj.instruction
  ].filter(Boolean).join(' ');

  const messages = [
    {
      role: 'system',
      content: systemContent
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
 * Non-streaming client fallback for Hugging Face Inference Providers.
 * @param {Object} params
 * @param {string} params.prompt
 * @param {Array} [params.history=[]]
 * @param {string} [params.mode='general']
 * @returns {Promise<{ text: string, modelUsed: string }>}
 */
export async function sendHuggingFaceMessage({ prompt, history = [], mode = 'general' }) {
  const apiKey = getHuggingFaceApiKey();

  if (!apiKey || apiKey === 'YOUR_HUGGINGFACE_API_KEY') {
    throw new Error(
      'Hugging Face is not configured yet. Please configure HUGGINGFACE_API_KEY in your server environment.'
    );
  }

  const messages = formatHuggingFaceMessages(history, prompt, 12, mode);

  let response;
  try {
    response = await fetch(HUGGINGFACE_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: DEFAULT_HUGGINGFACE_MODEL,
        messages,
        temperature: 0.7
      })
    });
  } catch (netErr) {
    throw new Error('Network connection error while contacting Hugging Face Inference Providers.');
  }

  if (!response.ok) {
    let errorDetail = '';
    try {
      const errJson = await response.json();
      errorDetail = errJson?.error || errJson?.error?.message || '';
    } catch (_) {
      errorDetail = await response.text();
    }

    if (response.status === 401) {
      throw new Error('Invalid or unauthorized Hugging Face API key. Please check HUGGINGFACE_API_KEY.');
    }
    if (response.status === 429) {
      throw new Error('Hugging Face rate limit or quota exceeded. Please wait a moment before trying again.');
    }
    if (response.status === 503) {
      throw new Error('Hugging Face Inference Providers are temporarily unavailable. Please retry shortly.');
    }

    throw new Error(`Hugging Face request failed (${response.status}): ${errorDetail || response.statusText}`);
  }

  const data = await response.json();
  const choice = data?.choices?.[0];

  if (!choice || !choice.message || !choice.message.content) {
    throw new Error('Received an empty response from Hugging Face Inference Providers.');
  }

  return {
    text: choice.message.content,
    modelUsed: data.model || DEFAULT_HUGGINGFACE_MODEL
  };
}

/**
 * Streaming client fallback for Hugging Face Inference Providers.
 * @param {Object} params
 * @param {string} params.prompt
 * @param {Array} [params.history=[]]
 * @param {string} [params.mode='general']
 * @param {(chunk: string, accumulated: string) => void} [params.onChunk]
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<{ text: string, modelUsed: string }>}
 */
export async function streamHuggingFaceMessage({ prompt, history = [], mode = 'general', onChunk, signal }) {
  const apiKey = getHuggingFaceApiKey();

  if (!apiKey || apiKey === 'YOUR_HUGGINGFACE_API_KEY') {
    throw new Error(
      'Hugging Face is not configured yet. Please configure HUGGINGFACE_API_KEY in your server environment.'
    );
  }

  const messages = formatHuggingFaceMessages(history, prompt, 12, mode);

  let response;
  try {
    response = await fetch(HUGGINGFACE_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: DEFAULT_HUGGINGFACE_MODEL,
        messages,
        temperature: 0.7,
        stream: true
      }),
      signal
    });
  } catch (netErr) {
    if (signal?.aborted) throw netErr;
    throw new Error('Network connection error while contacting Hugging Face Inference Providers.');
  }

  if (!response.ok) {
    let errorDetail = '';
    try {
      const errJson = await response.json();
      errorDetail = errJson?.error || errJson?.error?.message || '';
    } catch (_) {
      errorDetail = await response.text();
    }
    throw new Error(`Hugging Face request failed (${response.status}): ${errorDetail || response.statusText}`);
  }

  if (!response.body) {
    throw new Error('No readable response body received from Hugging Face.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let accumulated = '';
  let modelUsed = DEFAULT_HUGGINGFACE_MODEL;

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
          if (onChunk) onChunk(delta, accumulated);
        }
      } catch (_) {}
    }
  }

  return {
    text: accumulated,
    modelUsed
  };
}
