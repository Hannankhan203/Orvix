/**
 * Orvix Cloudflare Workers AI Service
 * Dedicated service module handling communication with Cloudflare Workers AI.
 * Model: @cf/meta/llama-3.1-8b-instruct
 *
 * NOTE: As per strict architectural constraints, all Cloudflare credentials (CLOUDFLARE_ACCOUNT_ID
 * and CLOUDFLARE_API_TOKEN) are maintained exclusively on the server in server.ts.
 * Requests route through the secure /api/chat server proxy.
 */

import { getChatMode } from '../config/chatModes.js';

export const DEFAULT_CLOUDFLARE_MODEL = '@cf/meta/llama-3.1-8b-instruct';

/**
 * Formats conversation history into the messages schema expected by Workers AI (@cf/meta/llama-3.1-8b-instruct).
 *
 * @param {Array} history - Previous conversation messages
 * @param {string} prompt - Current prompt
 * @param {number} [maxContextMessages=12]
 * @param {string} [mode='general']
 * @returns {Array<{ role: 'system' | 'user' | 'assistant', content: string }>}
 */
export function formatCloudflareMessages(history = [], prompt, maxContextMessages = 12, mode = 'general') {
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
 * Sends a conversation to Cloudflare Workers AI via the server-side proxy (/api/chat).
 *
 * @param {Object} params
 * @param {string} params.prompt
 * @param {Array} [params.history=[]]
 * @param {string|null} [params.username=null]
 * @param {Object|null} [params.preferences=null]
 * @param {string} [params.mode='general']
 * @returns {Promise<{ text: string, modelUsed: string }>}
 */
export async function sendCloudflareMessage({
  prompt,
  history = [],
  username = null,
  preferences = null,
  mode = 'general'
}) {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      provider: 'cloudflare',
      mode,
      prompt,
      history,
      username: username ? String(username).trim() : null,
      preferences: preferences || null,
      stream: false
    })
  });

  if (!response.ok) {
    let errorDetail = '';
    try {
      const errJson = await response.json();
      errorDetail = errJson?.error || '';
    } catch (_) {
      errorDetail = await response.text();
    }
    throw new Error(errorDetail || `Cloudflare Workers AI request failed (${response.status})`);
  }

  const data = await response.json();
  if (!data?.text) {
    throw new Error('Received an empty response from Cloudflare Workers AI.');
  }

  return {
    text: data.text,
    modelUsed: data.modelUsed || DEFAULT_CLOUDFLARE_MODEL
  };
}

/**
 * Streams conversation responses from Cloudflare Workers AI via the server-side SSE endpoint (/api/chat).
 *
 * @param {Object} params
 * @param {string} params.prompt
 * @param {Array} [params.history=[]]
 * @param {string|null} [params.username=null]
 * @param {Object|null} [params.preferences=null]
 * @param {string} [params.mode='general']
 * @param {(chunk: string, accumulated: string) => void} [params.onChunk]
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<{ text: string, modelUsed: string }>}
 */
export async function streamCloudflareMessage({
  prompt,
  history = [],
  username = null,
  preferences = null,
  mode = 'general',
  onChunk,
  signal
}) {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream'
    },
    body: JSON.stringify({
      provider: 'cloudflare',
      mode,
      prompt,
      history,
      username: username ? String(username).trim() : null,
      preferences: preferences || null,
      stream: true
    }),
    signal
  });

  if (!response.ok) {
    let errorDetail = '';
    try {
      const errJson = await response.json();
      errorDetail = errJson?.error || '';
    } catch (_) {
      errorDetail = await response.text();
    }
    throw new Error(errorDetail || `Cloudflare Workers AI request failed (${response.status})`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('text/event-stream') && response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let accumulated = '';
    let modelUsed = DEFAULT_CLOUDFLARE_MODEL;

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
          const parsed = JSON.parse(dataStr);
          if (parsed.modelUsed) modelUsed = parsed.modelUsed;
          if (parsed.type === 'chunk' && parsed.text) {
            accumulated += parsed.text;
            onChunk?.(parsed.text, accumulated);
          } else if (parsed.type === 'done') {
            if (parsed.modelUsed) modelUsed = parsed.modelUsed;
            return {
              text: parsed.text || accumulated,
              modelUsed
            };
          } else if (parsed.type === 'error') {
            throw new Error(parsed.error || 'Cloudflare Workers AI stream failed.');
          }
        } catch (jsonErr) {
          if (jsonErr.message && !jsonErr.message.includes('JSON')) {
            throw jsonErr;
          }
        }
      }
    }

    return {
      text: accumulated,
      modelUsed
    };
  }

  const data = await response.json();
  if (!data?.text) {
    throw new Error('Received an empty response from Cloudflare Workers AI.');
  }

  onChunk?.(data.text, data.text);
  return {
    text: data.text,
    modelUsed: data.modelUsed || DEFAULT_CLOUDFLARE_MODEL
  };
}
