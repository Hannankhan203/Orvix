/**
 * Orvix AI Provider Router
 * Central dispatch service routing chat requests to the selected provider (Gemini, Groq, OpenRouter).
 * Normalizes parameters, formats, and outputs across all three providers.
 */

import { sendGeminiMessage, streamGeminiMessage, getGeminiApiKey } from './geminiService.js';
import { sendGroqMessage, streamGroqMessage, getGroqApiKey } from './groqService.js';
import { sendOpenRouterMessage, streamOpenRouterMessage, getOpenRouterApiKey } from './openrouterService.js';
import { streamWebLLMMessage, DEFAULT_WEBLLM_MODEL_ID } from './webllmService.js';

export const AI_PROVIDERS = {
  GEMINI: 'gemini',
  GROQ: 'groq',
  OPENROUTER: 'openrouter',
  CLOUDFLARE: 'cloudflare',
  OLLAMA: 'ollama',
  WEBLLM: 'webllm'
};

export const PROVIDER_OPTIONS = [
  {
    id: AI_PROVIDERS.GEMINI,
    name: 'Gemini',
    modelTag: 'Gemini 3.8 Flash',
    description: 'Google Gemini'
  },
  {
    id: AI_PROVIDERS.GROQ,
    name: 'Groq',
    modelTag: 'GPT OSS 120B',
    description: 'Ultra-fast inference'
  },
  {
    id: AI_PROVIDERS.OPENROUTER,
    name: 'OpenRouter',
    modelTag: 'Llama 3.3 70B (Free)',
    description: 'Multi-model gateway'
  },
  {
    id: AI_PROVIDERS.CLOUDFLARE,
    name: 'Cloudflare Workers AI',
    shortName: 'Cloudflare AI',
    modelTag: 'Llama 3.1 8B',
    description: 'Serverless inference',
    label: 'Cloudflare Workers AI — Llama 3.1 8B'
  },
  {
    id: AI_PROVIDERS.OLLAMA,
    name: 'Local AI (Ollama)',
    shortName: 'Ollama',
    modelTag: 'Qwen 2.5 1.5B',
    defaultModel: 'qwen2.5:1.5b',
    description: 'Local offline inference',
    label: 'Local AI (Ollama) — Qwen 2.5 1.5B'
  },
  {
    id: AI_PROVIDERS.WEBLLM,
    name: 'Browser AI (WebLLM)',
    shortName: 'Browser AI',
    modelTag: 'Qwen 2.5 1.5B',
    defaultModel: DEFAULT_WEBLLM_MODEL_ID,
    description: 'On-device WebGPU inference',
    label: 'Browser AI (WebLLM) — Qwen 2.5 1.5B'
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
    case AI_PROVIDERS.OLLAMA:
    case AI_PROVIDERS.WEBLLM: {
      // Local Ollama and Browser AI (WebLLM) require no cloud API key
      return true;
    }
    case AI_PROVIDERS.GROQ: {
      const key = getGroqApiKey();
      return Boolean(key && key !== 'YOUR_GROQ_API_KEY');
    }
    case AI_PROVIDERS.OPENROUTER: {
      const key = getOpenRouterApiKey();
      return Boolean(key && key !== 'YOUR_OPENROUTER_API_KEY');
    }
    case AI_PROVIDERS.CLOUDFLARE: {
      // Cloudflare credentials are kept strictly server-side
      return false;
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
function parseRouterError(rawError, statusCode = 500, providerHint = null) {
  let cleanMsg = typeof rawError === 'string' ? rawError : rawError?.message || '';
  let code = Number(rawError?.code || statusCode || 500);
  let status = String(rawError?.status || '');
  let retryable = rawError?.retryable;
  const normalizedHint = providerHint ? String(providerHint).toLowerCase() : '';

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
  const isNetwork =
    lowerMsg === 'fetch failed' ||
    lowerMsg === 'failed to fetch' ||
    lowerMsg.includes('econnrefused') ||
    lowerMsg.includes('enotfound') ||
    lowerMsg.includes('network error') ||
    lowerMsg.includes('network_failure') ||
    upperStatus === 'NETWORK_FAILURE' ||
    upperStatus === 'NETWORK_ERROR';

  const isOllamaContext =
    normalizedHint === AI_PROVIDERS.OLLAMA ||
    lowerMsg.includes('11434') ||
    lowerMsg.includes('ollama');

  // Dedicated Ollama local connection & missing model handling (never blame internet or cloud demand)
  if (isOllamaContext) {
    code = code === 404 ? 404 : (code === 400 ? 400 : 503);
    status = code === 404 ? 'NOT_FOUND' : (code === 400 ? 'INVALID_ARGUMENT' : 'NETWORK_ERROR');
    retryable = false;
    if (
      !cleanMsg ||
      isNetwork ||
      cleanMsg === 'Service Unavailable' ||
      cleanMsg === 'Bad Gateway' ||
      cleanMsg === 'Not Found' ||
      cleanMsg.includes('Server request failed') ||
      cleanMsg.includes('Stream connection was closed')
    ) {
      if (code === 404 || lowerMsg.includes('not found') || lowerMsg.includes('model')) {
        cleanMsg = 'The requested Ollama model was not found. Please ensure it is installed locally using "ollama pull qwen2.5:1.5b".';
      } else if (lowerMsg === 'failed to fetch' || lowerMsg === 'fetch failed') {
        cleanMsg = 'Local AI (Ollama) requires the local Orvix backend server and Ollama daemon. Please verify the local server is running and Ollama is active at http://127.0.0.1:11434.';
      } else {
        cleanMsg = 'Unable to connect to Local AI (Ollama) at http://127.0.0.1:11434. Please ensure Ollama is running ("ollama serve") and model "qwen2.5:1.5b" is installed.';
      }
    }
  } else if (isNetwork) {
    code = code === 500 ? 503 : code;
    status = 'NETWORK_ERROR';
    retryable = true;
    cleanMsg = 'Unable to establish network connection with the AI service. Please check your internet connection or try again in a few moments.';
  } else if (
    code === 503 ||
    upperStatus === 'UNAVAILABLE' ||
    (lowerMsg.includes('high demand') && !lowerMsg.includes('500')) ||
    (lowerMsg.includes('spikes in demand') && !lowerMsg.includes('500')) ||
    lowerMsg.includes('overloaded')
  ) {
    code = 503;
    status = 'UNAVAILABLE';
    retryable = true;
    cleanMsg = 'The AI service is currently experiencing high demand. Spikes in demand are usually temporary. Please try again in a few moments.';
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
    if (!cleanMsg || cleanMsg === 'Not Found' || cleanMsg.includes('Server request failed (404)')) {
      cleanMsg = 'The requested AI model was not found or is no longer available. Please select another provider or model.';
    }
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
  err.retryable = isOllamaContext ? false : (retryable ?? (code === 503 || code === 429));
  if (isOllamaContext) {
    err.provider = AI_PROVIDERS.OLLAMA;
    err.canFallback = false;
  } else if (normalizedHint) {
    err.provider = normalizedHint;
  }
  return err;
}

export async function streamAIMessage({
  provider = DEFAULT_PROVIDER,
  model = null,
  mode = 'general',
  prompt,
  history = [],
  username = null,
  preferences = null,
  onChunk,
  onStart,
  signal,
  conversationId = null,
  attachments = [],
  isContinuation = false,
  partNumber = 1,
  originalPrompt = null,
  previousContentSummary = null
}) {
  const normalizedProvider = provider.toLowerCase();
  const normalizedMode = (mode || 'general').toLowerCase();

  // Strictly local browser inference: route Browser AI (WebLLM) directly to webllmService.js.
  // Never send Browser AI requests to /api/chat, Ollama, Firebase, or any cloud provider.
  if (normalizedProvider === AI_PROVIDERS.WEBLLM) {
    let effectivePrompt = prompt;
    if (isContinuation) {
      const contHeader = originalPrompt
        ? `[Continuation Request — Part ${partNumber || 2} for original prompt: "${originalPrompt}"]\n`
        : `[Continuation Request — Part ${partNumber || 2}]\n`;
      const tailContext = previousContentSummary
        ? `Previous section ended with:\n"""\n${previousContentSummary}\n"""\n`
        : '';
      effectivePrompt = `${contHeader}${tailContext}Continue directly from where the previous response stopped without repeating prior text.\n\nUser request: ${prompt}`;
    }

    return streamWebLLMMessage({
      prompt: effectivePrompt,
      history,
      username: username ? String(username).trim() : null,
      preferences: preferences || null,
      mode: normalizedMode,
      model: model ? String(model).trim() : null,
      attachments: Array.isArray(attachments) ? attachments : [],
      onStart,
      onChunk,
      signal
    });
  }

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
          model: model ? String(model).trim() : null,
          mode: normalizedMode,
          prompt,
          history,
          username: username ? String(username).trim() : null,
          preferences: preferences || null,
          stream: true,
          conversationId: conversationId || null,
          attachments: Array.isArray(attachments) ? attachments : [],
          isContinuation: Boolean(isContinuation),
          partNumber: partNumber || 1,
          originalPrompt: originalPrompt || null,
          previousContentSummary: previousContentSummary || null
        }),
        signal
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => null);
        const parsedErr = parseRouterError(
          errJson?.error || `Server request failed (${res.status})`,
          res.status,
          normalizedProvider
        );
        if (errJson?.code) parsedErr.code = errJson.code;
        if (errJson?.status) parsedErr.status = errJson.status;
        if (typeof errJson?.retryable === 'boolean') parsedErr.retryable = errJson.retryable;
        parsedErr.provider = errJson?.provider || errJson?.error?.provider || normalizedProvider;
        if (typeof errJson?.canFallback === 'boolean') {
          parsedErr.canFallback = errJson.canFallback;
        } else if (normalizedProvider === AI_PROVIDERS.OLLAMA) {
          parsedErr.canFallback = false;
        }
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
        let receivedDone = false;

        const handleSSELine = (line) => {
          const trimmed = line.trim();
          // Transparently ignore keep-alive heartbeats (lines starting with ':') and blank lines
          if (!trimmed || trimmed.startsWith(':')) return null;
          if (!trimmed.startsWith('data:')) return null;
          const dataStr = trimmed.slice(5).trim();
          if (dataStr === '[DONE]') {
            receivedDone = true;
            return { done: true };
          }
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
              receivedDone = true;
              if (data.modelUsed) modelUsed = data.modelUsed;
              if (data.provider) finalProvider = data.provider;
              const finalText = data.text || accumulatedText;
              return {
                done: true,
                result: {
                  text: finalText,
                  modelUsed: modelUsed || 'AI Model',
                  provider: finalProvider
                }
              };
            } else if (data.type === 'error') {
              const streamErr = parseRouterError(
                data.error || 'Stream error occurred.',
                data.code || 500,
                data.provider || normalizedProvider
              );
              if (data.code) streamErr.code = data.code;
              if (data.status) streamErr.status = data.status;
              if (typeof data.retryable === 'boolean') streamErr.retryable = data.retryable;
              if (typeof data.canFallback === 'boolean') streamErr.canFallback = data.canFallback;
              streamErr.provider = data.provider || normalizedProvider;
              throw streamErr;
            }
          } catch (jsonErr) {
            if (jsonErr.message && !jsonErr.message.includes('JSON')) {
              throw jsonErr;
            }
          }
          return null;
        };

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              const res = handleSSELine(line);
              if (res?.result) {
                return res.result;
              }
            }
          }

          // Process any trailing bytes and buffered events
          const finalDecoded = decoder.decode();
          if (finalDecoded) {
            buffer += finalDecoded;
          }
          if (buffer) {
            const trailingLines = buffer.split('\n');
            for (const tLine of trailingLines) {
              const res = handleSSELine(tLine);
              if (res?.result) {
                return res.result;
              }
            }
          }

          // If standard completion was signaled
          if (receivedDone) {
            return {
              text: accumulatedText,
              modelUsed: modelUsed || 'AI Model',
              provider: finalProvider
            };
          }

          // If the client explicitly requested cancellation, stop cleanly
          if (signal?.aborted) {
            const abortErr = new Error('Generation cancelled by user.');
            abortErr.name = 'AbortError';
            throw abortErr;
          }

          // If the connection was abruptly dropped mid-stream (e.g. Vercel Hobby 60s serverless execution limit
          // or intermediate network drop), seamlessly continue generation without aborting or losing tokens:
          if (accumulatedText.length > 0 && (partNumber || 1) < 10) {
            console.log(`[Stream Continuation] Connection closed before 'done' event at ${accumulatedText.length} chars. Auto-continuing stream...`);
            const continuationPrompt = 'Please continue directly from where you stopped. Complete any unfinished sentences, items, or sections without repeating previous text.';
            const contResult = await streamAIMessage({
              provider: finalProvider || normalizedProvider,
              model: modelUsed || model,
              mode: normalizedMode,
              prompt: continuationPrompt,
              history: [
                ...history,
                { sender: 'user', content: prompt },
                { sender: 'assistant', content: accumulatedText }
              ],
              username,
              preferences,
              onChunk: (chunkText) => {
                accumulatedText += chunkText;
                onChunk?.(chunkText, accumulatedText);
              },
              onStart: (info) => {
                if (info?.modelUsed) modelUsed = info.modelUsed;
              },
              signal,
              conversationId,
              attachments: [],
              isContinuation: true,
              partNumber: (partNumber || 1) + 1,
              originalPrompt: originalPrompt || prompt,
              previousContentSummary: accumulatedText.slice(-300)
            });
            return contResult;
          }

          if (!accumulatedText && !receivedDone) {
            throw parseRouterError(
              'Stream connection was closed before response data was received.',
              503,
              finalProvider || normalizedProvider
            );
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

      if (apiErr.name === 'TypeError' && !apiErr.status) {
        const netErr = parseRouterError(apiErr.message || 'fetch failed', 503, normalizedProvider);
        netErr.provider = normalizedProvider;
        throw netErr;
      }

      throw apiErr;
    }
  }

  // Client-side direct service fallback
  switch (normalizedProvider) {
    case AI_PROVIDERS.GROQ: {
      const result = await streamGroqMessage({ prompt, history, mode: normalizedMode, onChunk, signal, attachments, conversationId });
      return {
        ...result,
        provider: AI_PROVIDERS.GROQ
      };
    }

    case AI_PROVIDERS.OPENROUTER: {
      const result = await streamOpenRouterMessage({ prompt, history, mode: normalizedMode, onChunk, signal, attachments, conversationId });
      return {
        ...result,
        provider: AI_PROVIDERS.OPENROUTER
      };
    }

    case AI_PROVIDERS.CLOUDFLARE: {
      const err = new Error(
        'Cloudflare Workers AI requires the backend server. Please verify the server is running and configured with CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.'
      );
      err.provider = AI_PROVIDERS.CLOUDFLARE;
      err.code = 503;
      throw err;
    }

    case AI_PROVIDERS.OLLAMA: {
      const err = new Error(
        'Local AI (Ollama) requires the local Orvix backend server. Please verify the local server is running and Ollama is active on http://127.0.0.1:11434.'
      );
      err.provider = AI_PROVIDERS.OLLAMA;
      err.code = 503;
      err.canFallback = false;
      throw err;
    }

    case AI_PROVIDERS.WEBLLM: {
      return streamWebLLMMessage({
        prompt,
        history,
        username: username ? String(username).trim() : null,
        preferences: preferences || null,
        mode: normalizedMode,
        model: model ? String(model).trim() : null,
        attachments: Array.isArray(attachments) ? attachments : [],
        onStart,
        onChunk,
        signal
      });
    }

    case AI_PROVIDERS.GEMINI:
    default: {
      const result = await streamGeminiMessage({ prompt, history, username, mode: normalizedMode, onChunk, signal, attachments, conversationId });
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
