import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));

// Helper to format conversation history for Gemini
function formatGeminiHistory(
  messages: Array<{ sender?: string; content?: string }> = [],
  currentPrompt = '',
  maxContext = 12
) {
  const contents = [];
  const recent = messages.slice(-maxContext);

  for (const msg of recent) {
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

// Helper to format system instruction with dynamic username personalization
function buildSystemInstruction(username?: string | null) {
  const baseInstruction =
    'You are Orvix, an intelligent, helpful, and concise AI conversation companion. Provide clear explanations, code blocks with languages where appropriate, and formatted answers.';

  if (!username || !username.trim()) {
    return baseInstruction;
  }

  const cleanName = username.trim().slice(0, 50).replace(/[\r\n\t]/g, ' ');
  return `${baseInstruction} The user's preferred name is ${cleanName}. You may address the user by this name naturally when appropriate. Do not overuse the name, do not invent additional personal information, and do not claim to remember information that has not been provided.`;
}

// Simulated fallback response for demo / guest mode
function generateSimulatedResponse(promptText = '', username: string | null = null) {
  const promptLower = promptText.toLowerCase();
  const greetingName = username ? ` ${username}` : '';
  const personalSignoff = username ? `, ${username}` : '';

  let body = '';
  if (promptLower.includes('code') || promptLower.includes('react') || promptLower.includes('javascript') || promptLower.includes('bug')) {
    body = `Here is a clean code example addressing your request:

\`\`\`javascript
// Streamlined conversational handler
async function handleUserMessage(prompt, context = []) {
  const sanitized = prompt.trim();
  if (!sanitized) return null;

  return {
    id: \`msg-\${Date.now()}\`,
    timestamp: new Date().toLocaleTimeString(),
    content: \`Processed query: \${sanitized}\`
  };
}
\`\`\`

Ã¢â‚¬Â¢ **State updates:** Messages are updated immutably in memory or synced to Firestore.
Ã¢â‚¬Â¢ **Responsive design:** Markdown blocks format with syntax highlights.`;
  } else if (promptLower.includes('brainstorm') || promptLower.includes('idea') || promptLower.includes('startup') || promptLower.includes('name')) {
    body = `Here are 4 creative concepts for your consideration:

1. **NexusPulse** Ã¢â‚¬â€ Ambient conversational workspace for asynchronous team synthesis.
2. **KiteFlow** Ã¢â‚¬â€ Low-friction, lightweight drafting engine for technical creators.
3. **OmniCanvas** Ã¢â‚¬â€ Multimodal canvas bringing notes, documents, and chat threads into one view.
4. **SpectraAI** Ã¢â‚¬â€ Precision intelligence layer tailored for high-speed research.

*Tip: You can select any conversation from the sidebar or click "+ New Chat" to start fresh.*`;
  } else if (promptLower.startsWith('hi') || promptLower.startsWith('hello') || promptLower.startsWith('hey')) {
    body = `Hello${greetingName}! I am **Orvix**, your intelligent AI conversation companion.

I can help you with:
Ã¢â‚¬Â¢ **Writing & Editing:** Craft essays, draft professional emails, and summarize reports.
Ã¢â‚¬Â¢ **Coding & Tech:** Debug React/Node code, explain architectures, and review syntax.
Ã¢â‚¬Â¢ **Brainstorming:** Generate fresh ideas, project names, and creative outlines.
Ã¢â‚¬Â¢ **Learning:** Break down complex topics simply and concisely.`;
  } else {
    body = `Thank you for your prompt${personalSignoff}:
> "${promptText}"

I am ready to assist with your questions, code samples, or writing projects. Feel free to ask more details or explore specific topics!`;
  }

  return body;
}

// API Health Check
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// API Config Check (indicates configured providers without leaking keys)
app.get('/api/config', (_req, res) => {
  const geminiKey = process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY || '';
  const groqKey = process.env.GROQ_API_KEY || process.env.VITE_GROQ_API_KEY || '';
  const openrouterKey = process.env.OPENROUTER_API_KEY || process.env.VITE_OPENROUTER_API_KEY || '';

  res.json({
    geminiConfigured: Boolean(geminiKey && geminiKey !== 'MY_GEMINI_API_KEY'),
    groqConfigured: Boolean(groqKey && groqKey !== 'YOUR_GROQ_API_KEY'),
    openrouterConfigured: Boolean(openrouterKey && openrouterKey !== 'YOUR_OPENROUTER_API_KEY')
  });
});

// Central AI Chat Dispatch Endpoint
app.post('/api/chat', async (req, res) => {
  try {
    const { provider = 'gemini', prompt, history = [], username = null } = req.body as {
      provider?: string;
      prompt?: string;
      history?: Array<{ sender?: string; content?: string }>;
      username?: string | null;
    };

    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'Prompt is required.' });
    }

    const cleanUsername =
      typeof username === 'string' && username.trim()
        ? username.trim().slice(0, 50).replace(/[\r\n\t]/g, ' ')
        : null;

    const systemInstruction = buildSystemInstruction(cleanUsername);
    const normalizedProvider = String(provider).toLowerCase();

    // 1. Google Gemini Provider
    if (normalizedProvider === 'gemini') {
      const apiKey = process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY;

      // If no API key is configured, return the high-quality simulated response gracefully
      if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
        const text = generateSimulatedResponse(prompt, cleanUsername);
        return res.json({
          text,
          modelUsed: 'gemini-3.1-flash-lite (demo)',
          provider: 'gemini'
        });
      }

      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build'
          }
        }
      });

      const contents = formatGeminiHistory(history, prompt);
      const modelsToTry = ['gemini-3.1-flash-lite', 'gemini-3.8-flash'];
      let lastErr = null;

      for (const model of modelsToTry) {
        try {
          const response = await ai.models.generateContent({
            model,
            contents,
            config: {
              systemInstruction
            }
          });

          if (response && response.text) {
            return res.json({
              text: response.text,
              modelUsed: model,
              provider: 'gemini'
            });
          }
        } catch (err: any) {
          lastErr = err;
          const msg = String(err?.message || err);
          if ((msg.includes('503') || msg.includes('UNAVAILABLE') || msg.includes('404')) && model !== 'gemini-3.8-flash') {
            continue;
          }
          break;
        }
      }

      throw lastErr || new Error('Received an empty response from Gemini.');
    }

    // 2. Groq Provider
    if (normalizedProvider === 'groq') {
      const apiKey = process.env.GROQ_API_KEY || process.env.VITE_GROQ_API_KEY;
      if (!apiKey || apiKey === 'YOUR_GROQ_API_KEY') {
        const text = generateSimulatedResponse(prompt, cleanUsername);
        return res.json({
          text,
          modelUsed: 'Llama 3.3 70B (demo)',
          provider: 'groq'
        });
      }

      const messages = [
        {
          role: 'system',
          content: systemInstruction
        }
      ];

      for (const msg of history.slice(-12)) {
        if (!msg.content) continue;
        messages.push({
          role: msg.sender === 'user' ? 'user' : 'assistant',
          content: msg.content.trim()
        });
      }
      messages.push({ role: 'user', content: prompt.trim() });

      const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'openai/gpt-oss-120b',
          messages,
          temperature: 0.7
        })
      });

      if (!groqRes.ok) {
        const errText = await groqRes.text();
        return res.status(groqRes.status).json({
          error: `Groq request failed (${groqRes.status}): ${errText}`
        });
      }

      const data = await groqRes.json();
      return res.json({
        text: data?.choices?.[0]?.message?.content || '',
        modelUsed: data.model || 'openai/gpt-oss-120b',
        provider: 'groq'
      });
    }

    // 3. OpenRouter Provider
    if (normalizedProvider === 'openrouter') {
      const apiKey = process.env.OPENROUTER_API_KEY || process.env.VITE_OPENROUTER_API_KEY;
      if (!apiKey || apiKey === 'YOUR_OPENROUTER_API_KEY') {
        const text = generateSimulatedResponse(prompt, cleanUsername);
        return res.json({
          text,
          modelUsed: 'openrouter/free (demo)',
          provider: 'openrouter'
        });
      }

      const messages = [
        {
          role: 'system',
          content: systemInstruction
        }
      ];

      for (const msg of history.slice(-12)) {
        if (!msg.content) continue;
        messages.push({
          role: msg.sender === 'user' ? 'user' : 'assistant',
          content: msg.content.trim()
        });
      }
      messages.push({ role: 'user', content: prompt.trim() });

      const orRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'X-Title': 'Orvix'
        },
        body: JSON.stringify({
          model: 'openrouter/free',
          messages,
          temperature: 0.7
        })
      });

      if (!orRes.ok) {
        const errText = await orRes.text();
        return res.status(orRes.status).json({
          error: `OpenRouter request failed (${orRes.status}): ${errText}`
        });
      }

      const data = await orRes.json();
      return res.json({
        text: data?.choices?.[0]?.message?.content || '',
        modelUsed: data.model || 'openrouter/free',
        provider: 'openrouter'
      });
    }

    return res.status(400).json({ error: `Unknown provider: ${provider}` });
  } catch (error: any) {
    console.error('API Error in /api/chat:', error);
    res.status(500).json({
      error: error?.message || 'Internal server error while processing AI chat request.'
    });
  }
});

// Setup Vite middleware in dev or static serving in production
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(distPath, 'index.html'));
    });
  }

  app.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`Orvix server running on http://0.0.0.0:${PORT}`);
  });
}

if (!process.env.VERCEL) {
  startServer();
}

export { app };