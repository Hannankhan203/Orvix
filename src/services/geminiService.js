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
export async function sendGeminiMessage({ prompt, history = [], username = null }) {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      provider: 'gemini',
      prompt,
      history,
      username: username ? String(username).trim() : null
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
