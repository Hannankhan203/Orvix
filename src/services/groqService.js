/**
 * Orvix Groq AI Service
 * Dedicated service module handling communication with the Groq API.
 * Uses Groq's high-speed OpenAI-compatible API endpoint.
 *
 * NOTE: As per prototype requirements, the client reads VITE_GROQ_API_KEY.
 * For production deployment, API requests should be proxied through a secure backend.
 */

import { getChatMode } from '../config/chatModes.js';
import { prepareDocumentContext, adaptDocumentContextForProvider } from './documentContextService.js';

export function getGroqApiKey() {
  return '';
}

const DEFAULT_MODEL = 'openai/gpt-oss-120b';

function normalizeAttachments(attachments = []) {
  if (!Array.isArray(attachments)) return [];
  return attachments
    .filter((a) => a && (a.extraction || a.extractedText || a.text))
    .map((a) => {
      const ext = a.extraction || a;
      return {
        ...ext,
        id: ext.id || a.id || a.fileId,
        originalName: ext.originalName || a.originalName || a.name || a.filename || 'attachment',
        filename: ext.filename || a.filename || a.name || 'attachment',
        isImage: Boolean(ext.isImage ?? a.isImage ?? false)
      };
    });
}

/**
 * Formats conversation history into OpenAI-compatible format expected by Groq,
 * integrating document context adaptation when attachments are provided.
 * @param {Array} history
 * @param {string} prompt
 * @param {number} [maxContextMessages=12]
 * @param {string} [mode='general']
 * @param {Array} [attachments=[]]
 * @returns {Array<{ role: string, content: string }>}
 */
export function formatGroqMessages(history = [], prompt, maxContextMessages = 12, mode = 'general', attachments = []) {
  const modeObj = getChatMode(mode);
  const baseSystemContent = [
    'You are Orvix, an intelligent, helpful, and concise AI conversation companion. Provide clear explanations, code blocks with languages where appropriate, and formatted answers.',
    modeObj.instruction
  ].filter(Boolean).join(' ');

  let effectiveSystemContent = baseSystemContent;
  let effectivePrompt = prompt;

  if (Array.isArray(attachments) && attachments.length > 0) {
    const docs = normalizeAttachments(attachments);

    if (docs.length > 0) {
      const prepDoc = prepareDocumentContext(prompt, docs, { provider: 'groq' });
      const adapted = adaptDocumentContextForProvider({
        provider: 'groq',
        prompt,
        baseSystemInstruction: baseSystemContent,
        preparedContext: prepDoc
      });
      effectiveSystemContent = adapted.effectiveSystemInstruction;
      effectivePrompt = adapted.effectivePrompt;
    }
  }

  const messages = [
    {
      role: 'system',
      content: effectiveSystemContent
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

  if (effectivePrompt && effectivePrompt.trim()) {
    messages.push({
      role: 'user',
      content: effectivePrompt.trim()
    });
  }

  return messages;
}

/**
 * Sends a conversation to the Groq API via the server-side proxy and returns the generated text.
 * @param {Object} params
 * @param {string} params.prompt - Current user input prompt
 * @param {Array} [params.history=[]] - Previous conversation messages
 * @param {Array} [params.attachments=[]]
 * @returns {Promise<{ text: string, modelUsed: string }>}
 */
export async function sendGroqMessage({ prompt, history = [], mode = 'general', attachments = [], conversationId = null }) {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      provider: 'groq',
      mode,
      prompt,
      history,
      conversationId: conversationId || null,
      attachments: Array.isArray(attachments) ? attachments : []
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
    throw new Error(errorDetail || `Groq request failed (${response.status})`);
  }

  const data = await response.json();
  if (!data?.text) {
    throw new Error('Received an empty response from Groq.');
  }

  return {
    text: data.text,
    modelUsed: data.modelUsed || DEFAULT_MODEL
  };
}

/**
 * Streams conversation responses from Groq via the server-side SSE endpoint.
 * @param {Object} params
 * @param {string} params.prompt
 * @param {Array} [params.history=[]]
 * @param {(chunk: string, accumulated: string) => void} [params.onChunk]
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<{ text: string, modelUsed: string }>}
 */
export async function streamGroqMessage({ prompt, history = [], mode = 'general', onChunk, signal, attachments = [], conversationId = null }) {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream'
    },
    body: JSON.stringify({
      provider: 'groq',
      mode,
      prompt,
      history,
      stream: true,
      conversationId: conversationId || null,
      attachments: Array.isArray(attachments) ? attachments : []
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
    throw new Error(errorDetail || `Groq request failed (${response.status})`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('text/event-stream') && response.body) {
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
            throw new Error(parsed.error || 'Groq stream failed.');
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
    throw new Error('Received an empty response from Groq.');
  }

  onChunk?.(data.text, data.text);
  return {
    text: data.text,
    modelUsed: data.modelUsed || DEFAULT_MODEL
  };
}

