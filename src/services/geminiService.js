/**
 * Orvix Gemini AI Service
 * Dedicated service module handling communication with Google Gemini API.
 *
 * NOTE: As per prototype requirements, the client reads VITE_GEMINI_API_KEY.
 * For production deployment, API requests should be proxied through a secure backend
 * to protect the API key from client exposure.
 */

import { GoogleGenAI } from '@google/genai';

/**
 * Retrieves the configured Gemini API key from Vite environment variables.
 */
export function getGeminiApiKey() {
  try {
    if (typeof import.meta !== 'undefined' && import.meta?.env?.VITE_GEMINI_API_KEY) {
      return import.meta.env.VITE_GEMINI_API_KEY;
    }
  } catch (_) {
    // Ignore error in non-Vite environments
  }

  if (typeof process !== 'undefined' && process.env) {
    return process.env.VITE_GEMINI_API_KEY || process.env.GEMINI_API_KEY || '';
  }

  return '';
}

// Model priority: gemini-3.1-flash-lite provides fast response times and high availability,
// with gemini-3.8-flash available as fallback.
const PRIMARY_MODEL = 'gemini-3.1-flash-lite';
const FALLBACK_MODEL = 'gemini-3.8-flash';

/**
 * Formats in-memory chat messages into the multi-turn format expected by GoogleGenAI SDK.
 * Applies a reasonable context window (e.g., last 12 messages) to preserve token limits.
 *
 * @param {Array<{ sender: string, content: string }>} messages
 * @param {string} currentPrompt
 * @param {number} [maxContextMessages=12]
 * @returns {Array<{ role: 'user' | 'model', parts: Array<{ text: string }> }>}
 */
export function formatConversationHistory(messages = [], currentPrompt, maxContextMessages = 12) {
  const contents = [];

  // Slice recent conversation messages within the limit
  const recentMessages = messages.slice(-maxContextMessages);

  for (const msg of recentMessages) {
    if (!msg.content || !msg.content.trim()) continue;
    // Map 'user' -> 'user', 'assistant' -> 'model'
    const role = msg.sender === 'user' ? 'user' : 'model';
    contents.push({
      role,
      parts: [{ text: msg.content.trim() }]
    });
  }

  // Ensure current user prompt is appended
  if (currentPrompt && currentPrompt.trim()) {
    contents.push({
      role: 'user',
      parts: [{ text: currentPrompt.trim() }]
    });
  }

  // Ensure conversation starts with 'user' role as required by Gemini API
  while (contents.length > 0 && contents[0].role !== 'user') {
    contents.shift();
  }

  return contents;
}

/**
 * Sends a conversation to the Gemini API and returns the generated text.
 * Handles rate limits, quota issues, network failures, and model fallbacks.
 *
 * @param {Object} params
 * @param {string} params.prompt - Current user input prompt
 * @param {Array} [params.history=[]] - Previous conversation messages
 * @returns {Promise<{ text: string, modelUsed: string }>}
 */
export async function sendGeminiMessage({ prompt, history = [] }) {
  const apiKey = getGeminiApiKey();

  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    throw new Error(
      'Missing or invalid Gemini API key. Please configure VITE_GEMINI_API_KEY in your environment.'
    );
  }

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build'
      }
    }
  });

  const contents = formatConversationHistory(history, prompt);

  // Attempt with primary model, fall back to secondary model if unavailable/503
  let lastError = null;
  const modelsToTry = [PRIMARY_MODEL, FALLBACK_MODEL];

  for (const model of modelsToTry) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction: 'You are Orvix, an intelligent, helpful, and concise AI conversation companion. Provide clear explanations, code blocks with languages where appropriate, and formatted answers.'
        }
      });

      if (!response || !response.text) {
        throw new Error('Received an empty response from Gemini.');
      }

      return {
        text: response.text,
        modelUsed: model
      };
    } catch (err) {
      lastError = err;
      const errorMsg = String(err.message || err);

      // If the model is 503 (high demand) or 404 (unavailable), try the fallback model
      if (
        (errorMsg.includes('503') || errorMsg.includes('UNAVAILABLE') || errorMsg.includes('404')) &&
        model !== FALLBACK_MODEL
      ) {
        console.warn(`Model ${model} was unavailable, falling back to ${FALLBACK_MODEL}...`);
        continue;
      }

      // For invalid keys, quota, or permission errors, break immediately with clean explanation
      break;
    }
  }

  // Parse and normalize the error message for friendly user presentation
  throw normalizeGeminiError(lastError);
}

/**
 * Masks any potential API keys, auth tokens, or query secrets from error strings
 */
function maskSensitiveSecrets(str) {
  if (!str) return '';
  return String(str)
    .replace(/AIza[0-9A-Za-z-_]{35}/g, '[REDACTED_API_KEY]')
    .replace(/([?&]key=)[^& \n\r]+/gi, '$1[REDACTED]')
    .replace(/(Bearer\s+)[a-zA-Z0-9_\-\.]+/gi, '$1[REDACTED]');
}

/**
 * Normalizes API errors into user-friendly diagnostic messages
 */
function normalizeGeminiError(error) {
  const raw = maskSensitiveSecrets(String(error?.message || error || 'Unknown error'));

  if (raw.includes('API_KEY_INVALID') || raw.includes('API key not valid') || raw.includes('401') || raw.includes('403')) {
    return new Error('Invalid or unauthorized Gemini API key. Please verify VITE_GEMINI_API_KEY in your settings.');
  }

  if (raw.includes('RESOURCE_EXHAUSTED') || raw.includes('429') || raw.includes('quota') || raw.includes('Quota exceeded')) {
    return new Error('Gemini API quota or rate limit exceeded. Please wait a moment before retrying.');
  }

  if (raw.includes('503') || raw.includes('UNAVAILABLE') || raw.includes('high demand') || raw.includes('overloaded')) {
    return new Error('The AI model is temporarily experiencing high traffic. Please retry in a few seconds.');
  }

  if (
    raw.includes('Failed to fetch') ||
    raw.includes('NetworkError') ||
    raw.includes('network') ||
    raw.includes('ECONNREFUSED') ||
    raw.includes('ETIMEDOUT')
  ) {
    return new Error('Network connection error. Please check your internet connection and try again.');
  }

  // Extract clean message if wrapped in JSON string
  const cleanMsg = raw.replace(/^{.*"message":"([^"]+)".*}$/, '$1');
  return new Error(`Gemini request failed: ${cleanMsg}`);
}
