/**
 * Orvix Gemini AI Service
 * Dedicated service module routing Gemini chat requests through the secure server-side endpoint.
 * Calling Gemini from the server protects the API key and adheres to AI Studio best practices.
 */

/**
 * Retrieves the configured Gemini API key (kept for interface compatibility; server handles actual authentication).
 */
export function getGeminiApiKey() {
  return '';
}

/**
 * Formats in-memory chat messages into the multi-turn format expected by Gemini.
 *
 * @param {Array<{ sender: string, content: string }>} messages
 * @param {string} currentPrompt
 * @param {number} [maxContextMessages=12]
 * @returns {Array<{ role: 'user' | 'model', parts: Array<{ text: string }> }>}
 */
export function formatConversationHistory(messages = [], currentPrompt, maxContextMessages = 12) {
  const contents = [];
  const recentMessages = messages.slice(-maxContextMessages);

  for (const msg of recentMessages) {
    if (!msg.content || !msg.content.trim()) continue;
    const role = msg.sender === 'user' ? 'user' : 'model';
    contents.push({
      role,
      parts: [{ text: msg.content.trim() }]
    });
  }

  if (currentPrompt && currentPrompt.trim()) {
    contents.push({
      role: 'user',
      parts: [{ text: currentPrompt.trim() }]
    });
  }

  while (contents.length > 0 && contents[0].role !== 'user') {
    contents.shift();
  }

  return contents;
}

/**
 * Sends a conversation to the Gemini API via the server-side proxy and returns the generated text.
 *
 * @param {Object} params
 * @param {string} params.prompt - Current user input prompt
 * @param {Array} [params.history=[]] - Previous conversation messages
 * @param {string|null} [params.username=null] - Preferred username for personalization
 * @returns {Promise<{ text: string, modelUsed: string }>}
 */
export async function sendGeminiMessage({
  prompt,
  history = [],
  username = null,
  preferences = null,
  mode = 'general',
  conversationId = null,
  attachments = []
}) {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      provider: 'gemini',
      mode,
      prompt,
      history,
      username: username ? String(username).trim() : null,
      preferences: preferences || null,
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
    throw new Error(errorDetail || `Gemini request failed (${response.status})`);
  }

  const data = await response.json();
  if (!data?.text) {
    throw new Error('Received an empty response from Gemini.');
  }

  return {
    text: data.text,
    modelUsed: data.modelUsed || 'gemini-3.1-flash-lite'
  };
}

/**
 * Streams conversation responses from Gemini via the server-side SSE endpoint.
 * @param {Object} params
 * @param {string} params.prompt
 * @param {Array} [params.history=[]]
 * @param {string|null} [params.username=null]
 * @param {Object|null} [params.preferences=null]
 * @param {string} [params.mode='general']
 * @param {string|null} [params.model=null]
 * @param {(chunk: string, accumulated: string) => void} [params.onChunk]
 * @param {AbortSignal} [params.signal]
 * @param {string|null} [params.conversationId=null]
 * @param {Array} [params.attachments=[]]
 * @returns {Promise<{ text: string, modelUsed: string }>}
 */
export async function streamGeminiMessage({
  prompt,
  history = [],
  username = null,
  preferences = null,
  mode = 'general',
  model = null,
  onChunk,
  signal,
  conversationId = null,
  attachments = []
}) {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream'
    },
    body: JSON.stringify({
      provider: 'gemini',
      model: model ? String(model).trim() : null,
      mode,
      prompt,
      history,
      username: username ? String(username).trim() : null,
      preferences: preferences || null,
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
    throw new Error(errorDetail || `Gemini request failed (${response.status})`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('text/event-stream') && response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let accumulated = '';
    let modelUsed = 'gemini-3.1-flash-lite';

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
            throw new Error(parsed.error || 'Gemini stream failed.');
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
    throw new Error('Received an empty response from Gemini.');
  }

  onChunk?.(data.text, data.text);
  return {
    text: data.text,
    modelUsed: data.modelUsed || 'gemini-3.1-flash-lite'
  };
}

