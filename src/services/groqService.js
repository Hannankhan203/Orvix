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
  try {
    if (typeof import.meta !== 'undefined' && import.meta?.env?.VITE_GROQ_API_KEY) {
      return import.meta.env.VITE_GROQ_API_KEY;
    }
  } catch (_) {
    // Ignore error in non-Vite environments
  }

  if (typeof process !== 'undefined' && process.env) {
    return process.env.VITE_GROQ_API_KEY || '';
  }

  return '';
}

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
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
      const prepDoc = prepareDocumentContext(prompt, docs);
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
 * Sends a conversation to the Groq API and returns the generated text.
 * @param {Object} params
 * @param {string} params.prompt - Current user input prompt
 * @param {Array} [params.history=[]] - Previous conversation messages
 * @param {Array} [params.attachments=[]]
 * @returns {Promise<{ text: string, modelUsed: string }>}
 */
export async function sendGroqMessage({ prompt, history = [], mode = 'general', attachments = [] }) {
  if (Array.isArray(attachments) && attachments.length > 0) {
    const docs = normalizeAttachments(attachments);
    if (docs.length > 0) {
      const prepDoc = prepareDocumentContext(prompt, docs);
      if (prepDoc?.directAnswer) {
        return {
          text: prepDoc.directAnswer,
          modelUsed: 'Document Analyzer'
        };
      }
    }
  }

  const apiKey = getGroqApiKey();

  if (!apiKey || apiKey === 'YOUR_GROQ_API_KEY') {
    throw new Error(
      'Groq is not configured yet. Please add VITE_GROQ_API_KEY to your environment configuration.'
    );
  }

  const messages = formatGroqMessages(history, prompt, 12, mode, attachments);

  let response;
  try {
    response = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        messages,
        max_tokens: 4096,
        temperature: 0.7
      })
    });
  } catch (netErr) {
    throw new Error('Network connection error while contacting Groq. Please check your internet connection.');
  }

  if (!response.ok) {
    let errorDetail = '';
    try {
      const errJson = await response.json();
      errorDetail = errJson?.error?.message || '';
    } catch (_) {
      errorDetail = await response.text();
    }

    if (response.status === 404) {
      throw new Error(`Groq model not found or decommissioned (${errorDetail || 'Model unavailable'}). Please verify your model configuration.`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error('Invalid or unauthorized Groq API key. Please check VITE_GROQ_API_KEY.');
    }
    if (response.status === 429) {
      throw new Error('Groq rate limit or quota exceeded. Please wait a moment before trying again.');
    }
    if (response.status === 503) {
      throw new Error('Groq service is temporarily unavailable. Please retry shortly.');
    }

    throw new Error(`Groq request failed (${response.status}): ${errorDetail || response.statusText}`);
  }

  const data = await response.json();
  const choice = data?.choices?.[0];

  if (!choice || !choice.message || !choice.message.content) {
    throw new Error('Received an empty response from Groq.');
  }

  return {
    text: choice.message.content,
    modelUsed: data.model || DEFAULT_MODEL
  };
}

/**
 * Streams conversation responses from Groq's API incrementally.
 * @param {Object} params
 * @param {string} params.prompt
 * @param {Array} [params.history=[]]
 * @param {(chunk: string, accumulated: string) => void} [params.onChunk]
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<{ text: string, modelUsed: string }>}
 */
export async function streamGroqMessage({ prompt, history = [], mode = 'general', onChunk, signal, attachments = [] }) {
  if (Array.isArray(attachments) && attachments.length > 0) {
    const docs = normalizeAttachments(attachments);
    if (docs.length > 0) {
      const prepDoc = prepareDocumentContext(prompt, docs);
      if (prepDoc?.directAnswer) {
        onChunk?.(prepDoc.directAnswer, prepDoc.directAnswer);
        return {
          text: prepDoc.directAnswer,
          modelUsed: 'Document Analyzer'
        };
      }
    }
  }

  const apiKey = getGroqApiKey();

  if (!apiKey || apiKey === 'YOUR_GROQ_API_KEY') {
    throw new Error(
      'Groq is not configured yet. Please add VITE_GROQ_API_KEY to your environment configuration.'
    );
  }

  const messages = formatGroqMessages(history, prompt, 12, mode, attachments);

  let response;
  try {
    response = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        messages,
        max_tokens: 4096,
        temperature: 0.7,
        stream: true
      }),
      signal
    });
  } catch (netErr) {
    if (signal?.aborted) throw netErr;
    throw new Error('Network connection error while contacting Groq. Please check your internet connection.');
  }

  if (!response.ok) {
    let errorDetail = '';
    try {
      const errJson = await response.json();
      errorDetail = errJson?.error?.message || '';
    } catch (_) {
      errorDetail = await response.text();
    }
    if (response.status === 404) {
      throw new Error(`Groq model not found or decommissioned (${errorDetail || 'Model unavailable'}). Please verify your model configuration.`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error('Invalid or unauthorized Groq API key. Please check VITE_GROQ_API_KEY.');
    }
    if (response.status === 429) {
      throw new Error('Groq rate limit or quota exceeded. Please wait a moment before trying again.');
    }
    if (response.status === 503) {
      throw new Error('Groq service is temporarily unavailable. Please retry shortly.');
    }
    throw new Error(`Groq request failed (${response.status}): ${errorDetail || response.statusText}`);
  }

  if (!response.body) {
    throw new Error('No readable response body received from Groq.');
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
      if (!trimmed || !trimmed.startsWith('data:')) continue;
      const dataStr = trimmed.slice(5).trim();
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

  const finalDecoded = decoder.decode();
  if (finalDecoded) buffer += finalDecoded;
  if (buffer) {
    const trailingLines = buffer.split('\n');
    for (const line of trailingLines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) continue;
      const dataStr = trimmed.slice(5).trim();
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

