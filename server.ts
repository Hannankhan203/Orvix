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

// Permissive CORS middleware for cross-origin and Vercel preview environments
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, X-Title');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

app.use(express.json({ limit: '10mb' }));

// Helper to pause execution with backoff
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Helper to pause execution while honoring client disconnect cancellation
async function sleepWithAbort(ms: number, isAborted: () => boolean): Promise<boolean> {
  const interval = 100;
  let elapsed = 0;
  while (elapsed < ms) {
    if (isAborted()) return false;
    const step = Math.min(interval, ms - elapsed);
    await sleep(step);
    elapsed += step;
  }
  return !isAborted();
}

function getBackoffWithJitter(attempt: number, retryAfterSec?: number): number {
  if (retryAfterSec && retryAfterSec > 0 && retryAfterSec <= 10) {
    return retryAfterSec * 1000 + Math.random() * 300;
  }
  const base = Math.min(1000 * Math.pow(2, attempt - 1), 3000);
  const jitter = Math.random() * 400;
  return base + jitter;
}

// Sanitizes error messages to ensure no API keys, tokens, or headers are ever logged
function sanitizeErrorLog(msg: string): string {
  if (!msg) return '';
  return String(msg)
    .replace(/AIza[0-9A-Za-z-_]{35}/g, '[REDACTED_API_KEY]')
    .replace(/Bearer\s+[A-Za-z0-9-_.]+/gi, 'Bearer [REDACTED]')
    .replace(/key=[^&\s]+/gi, 'key=[REDACTED]');
}

interface DiagnosticLogData {
  provider: string;
  model: string;
  phase: 'pre-stream' | 'mid-stream' | 'non-streaming';
  attempt: number;
  maxAttempts: number;
  upstreamStatus?: number;
  upstreamErrorCode?: string;
  sanitizedMessage: string;
  retryAfterSeconds?: number;
  willRetry: boolean;
}

/**
 * Server-side diagnostic logger recording provider, model, HTTP status, sanitized error,
 * retry attempt number, and streaming phase without exposing credentials or user data.
 */
function logAIDiagnostic(data: DiagnosticLogData) {
  const statusStr = data.upstreamStatus ? `HTTP ${data.upstreamStatus}` : 'HTTP N/A';
  const codeStr = data.upstreamErrorCode ? `[${data.upstreamErrorCode}]` : '';
  const actionDesc = data.willRetry
    ? `Will retry (attempt ${data.attempt + 1}/${data.maxAttempts}${data.retryAfterSeconds ? ` after ${data.retryAfterSeconds}s` : ''})`
    : 'No further retries';

  console.warn(
    `[AI Diagnostic] Provider: ${data.provider} | Model: ${data.model} | Phase: ${data.phase} | Status: ${statusStr} ${codeStr} | Attempt: ${data.attempt}/${data.maxAttempts} | Action: ${actionDesc} | Sanitized: ${sanitizeErrorLog(data.sanitizedMessage)}`
  );
}

// Parses and normalizes Gemini API errors into clean user-facing representations
export function parseGeminiError(err: any): {
  statusCode: number;
  status: string;
  isUnavailable: boolean;
  isRetryable: boolean;
  message: string;
  retryAfterSeconds?: number;
} {
  let statusCode = Number(err?.status || err?.code || err?.statusCode || 500);
  let statusText = String(err?.statusText || err?.status || '');
  let message = String(err?.message || err || '');
  let isRetryable = false;
  let isUnavailable = false;
  let retryAfterSeconds: number | undefined = undefined;

  // Unpack nested JSON from @google/genai errors (can be 2 levels deep)
  for (let i = 0; i < 3; i++) {
    if (typeof message !== 'string') break;
    const jsonMatch = message.match(/\{[\s\S]*\}/);
    if (!jsonMatch) break;
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.error) {
        if (parsed.error.code) statusCode = Number(parsed.error.code);
        if (parsed.error.status) statusText = String(parsed.error.status);
        if (parsed.error.message) {
          message = String(parsed.error.message);
        } else {
          break;
        }
      } else {
        break;
      }
    } catch (_) {
      break;
    }
  }

  // Check for Retry-After header if available
  if (err?.headers && typeof err.headers.get === 'function') {
    const retryHeader = err.headers.get('retry-after');
    if (retryHeader) {
      const parsedSec = parseInt(retryHeader, 10);
      if (!isNaN(parsedSec)) retryAfterSeconds = parsedSec;
    }
  }

  const lowerMsg = message.toLowerCase();
  const upperStatus = statusText.toUpperCase();

  // Classify error types accurately without masking non-503 errors
  if (
    statusCode === 503 ||
    statusCode === 504 ||
    upperStatus === 'UNAVAILABLE' ||
    upperStatus === 'DEADLINE_EXCEEDED' ||
    lowerMsg.includes('overloaded') ||
    lowerMsg.includes('high demand') ||
    lowerMsg.includes('spikes in demand') ||
    lowerMsg.includes('service unavailable') ||
    lowerMsg.includes('temporarily unavailable') ||
    lowerMsg.includes('deadline expired')
  ) {
    statusCode = statusCode === 504 || upperStatus === 'DEADLINE_EXCEEDED' ? 504 : 503;
    statusText = statusCode === 504 ? 'DEADLINE_EXCEEDED' : 'UNAVAILABLE';
    isUnavailable = true;
    isRetryable = true;
    message = 'Google Gemini is currently experiencing high demand. Spikes in demand are usually temporary. Please try again in a few moments.';
  } else if (
    statusCode === 429 ||
    upperStatus === 'RESOURCE_EXHAUSTED' ||
    lowerMsg.includes('rate limit') ||
    lowerMsg.includes('quota') ||
    lowerMsg.includes('resource_exhausted')
  ) {
    statusCode = 429;
    statusText = 'RESOURCE_EXHAUSTED';
    isUnavailable = true;
    isRetryable = true;
    message = 'Gemini rate limit or quota exceeded. Please wait a moment before trying again.';
  } else if (
    statusCode === 401 ||
    statusCode === 403 ||
    upperStatus === 'UNAUTHENTICATED' ||
    upperStatus === 'PERMISSION_DENIED' ||
    lowerMsg.includes('api_key_invalid') ||
    lowerMsg.includes('api key not valid') ||
    lowerMsg.includes('unauthorized') ||
    lowerMsg.includes('permission denied')
  ) {
    statusCode = statusCode === 401 ? 401 : 403;
    statusText = statusCode === 401 ? 'UNAUTHENTICATED' : 'PERMISSION_DENIED';
    isRetryable = false;
    message = 'Invalid or unauthorized Gemini API key. Please check your API configuration.';
  } else if (
    statusCode === 404 ||
    upperStatus === 'NOT_FOUND' ||
    lowerMsg.includes('not found') ||
    lowerMsg.includes('is no longer available')
  ) {
    statusCode = 404;
    statusText = 'NOT_FOUND';
    isRetryable = false;
    message = sanitizeErrorLog(message) || 'Requested Gemini model not found.';
  } else if (
    statusCode === 400 ||
    upperStatus === 'INVALID_ARGUMENT' ||
    lowerMsg.includes('invalid argument')
  ) {
    statusCode = 400;
    statusText = 'INVALID_ARGUMENT';
    isRetryable = false;
    message = sanitizeErrorLog(message) || 'Invalid argument provided to the Gemini model.';
  } else if (statusCode === 500 || upperStatus === 'INTERNAL') {
    statusCode = 500;
    statusText = 'INTERNAL';
    isRetryable = false;
    message = sanitizeErrorLog(message) || 'Internal error encountered by Google Gemini service.';
  }

  return {
    statusCode: Number.isFinite(statusCode) ? statusCode : 500,
    status: statusText || (isUnavailable ? 'UNAVAILABLE' : 'ERROR'),
    isUnavailable,
    isRetryable,
    message: sanitizeErrorLog(message),
    retryAfterSeconds
  };
}

// Helper to format conversation history for Gemini with alternating roles
function formatGeminiHistory(
  messages: Array<{ sender?: string; content?: string }> = [],
  currentPrompt = '',
  maxContext = 12
) {
  const rawContents: Array<{ role: 'user' | 'model'; text: string }> = [];
  const recent = messages.slice(-maxContext);

  for (const msg of recent) {
    if (!msg.content || !msg.content.trim()) continue;
    const role = msg.sender === 'user' ? 'user' : 'model';
    rawContents.push({
      role,
      text: msg.content.trim()
    });
  }

  if (currentPrompt && currentPrompt.trim()) {
    rawContents.push({
      role: 'user',
      text: currentPrompt.trim()
    });
  }

  // Gemini contents must begin with a 'user' turn
  while (rawContents.length > 0 && rawContents[0].role !== 'user') {
    rawContents.shift();
  }

  if (rawContents.length === 0 && currentPrompt.trim()) {
    rawContents.push({ role: 'user', text: currentPrompt.trim() });
  }

  // Merge consecutive turns of identical role so roles strictly alternate user -> model -> user
  const mergedContents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [];
  for (const item of rawContents) {
    const last = mergedContents[mergedContents.length - 1];
    if (last && last.role === item.role) {
      last.parts.push({ text: item.text });
    } else {
      mergedContents.push({
        role: item.role,
        parts: [{ text: item.text }]
      });
    }
  }

  return mergedContents;
}

interface UserPreferences {
  responseLength?: 'concise' | 'balanced' | 'detailed';
  beginnerFriendly?: boolean;
}

// Helper to format system instruction with dynamic username, response preferences, and chat mode
function buildSystemInstruction(
  username?: string | null,
  preferences?: UserPreferences | null,
  mode?: string | null
) {
  const baseInstruction =
    'You are Orvix, an intelligent, helpful, and concise AI conversation companion. Provide clear explanations, code blocks with languages where appropriate, and formatted answers.';

  const instructions = [baseInstruction];

  if (username && username.trim()) {
    const cleanName = username.trim().slice(0, 50).replace(/[\r\n\t]/g, ' ');
    instructions.push(
      `The user's preferred name is ${cleanName}. You may address the user by this name naturally when appropriate. Do not overuse the name, do not invent additional personal information, and do not claim to remember information that has not been provided.`
    );
  }

  // Consistent, non-intrusive response preferences layer
  if (preferences?.responseLength === 'concise') {
    instructions.push(
      'Preferred response length: Concise. Keep explanations brief, compact, focused, and directly to the point without filler or redundant commentary.'
    );
  } else if (preferences?.responseLength === 'detailed') {
    instructions.push(
      'Preferred response length: Detailed. Provide thorough, in-depth explanations with helpful background context, step-by-step reasoning, and practical code or concepts where appropriate.'
    );
  } else if (preferences?.responseLength === 'balanced') {
    instructions.push(
      'Preferred response length: Balanced. Provide an optimal balance between conciseness and thoroughness.'
    );
  }

  if (preferences?.beginnerFriendly) {
    instructions.push(
      'Explanation style: Clear and beginner-friendly. Explain technical and complex topics using plain language, accessible analogies, and approachable steps, avoiding unnecessary jargon without talking down to the user.'
    );
  }

  // Active Chat Mode instruction layer
  const normalizedMode = (mode || 'general').toLowerCase().trim();
  if (normalizedMode === 'coding') {
    instructions.push(
      'Active Mode: Coding. Prioritize high-quality programming guidance, software architecture, syntax review, and debugging. Provide clean, correct, and well-structured code blocks with accurate language identifiers. Explain how the code operates, highlight edge cases or potential pitfalls, and guide the user through step-by-step technical problem solving without making ungrounded assumptions.'
    );
  } else if (normalizedMode === 'writing') {
    instructions.push(
      'Active Mode: Writing. Prioritize drafting, editing, rewriting, tone adjustment, and prose enhancement. Focus on clarity, flow, rhythm, grammatical precision, and compelling structure. Offer constructive suggestions, varied phrasing alternatives, and polished text tailored to the user\'s intended audience and purpose.'
    );
  } else if (normalizedMode === 'learning') {
    instructions.push(
      'Active Mode: Learning. Prioritize clear educational explanations and concept mastery. Break complex topics down into logical, easily digestible steps. Use relatable real-world analogies, illustrative examples, and intuitive comparisons. Encourage deep understanding by highlighting key takeaways and offering helpful conceptual summaries.'
    );
  }

  return instructions.join(' ');
}

// Simulated fallback response for demo / guest mode with response preferences and chat modes support
function generateSimulatedResponse(
  promptText = '',
  username: string | null = null,
  preferences?: UserPreferences | null,
  mode?: string | null
) {
  const promptLower = promptText.toLowerCase();
  const greetingName = username ? ` ${username}` : '';
  const personalSignoff = username ? `, ${username}` : '';
  const isConcise = preferences?.responseLength === 'concise';
  const isDetailed = preferences?.responseLength === 'detailed';
  const isBeginner = Boolean(preferences?.beginnerFriendly);
  const normalizedMode = (mode || 'general').toLowerCase().trim();

  // Mode-specific simulated responses
  if (normalizedMode === 'coding') {
    if (isConcise) {
      return `\`\`\`javascript
// Clean implementation
export function solveProblem(input) {
  if (!input) return null;
  return Array.isArray(input) ? input.filter(Boolean) : [input];
}
\`\`\`
• Time complexity: O(N) | Space complexity: O(N)`;
    }
    return `### [Coding Mode] Technical Solution & Code Implementation

\`\`\`javascript
/**
 * Optimized solution addressing your query: "${promptText.slice(0, 40)}"
 * Handles edge cases, input validation, and asynchronous flow safely.
 */
export async function executeTask(payload = {}) {
  const sanitized = typeof payload === 'object' && payload !== null ? payload : {};

  try {
    if (sanitized.data === undefined) {
      return { success: true, count: 0, results: [] };
    }

    const items = Array.isArray(sanitized.data) ? sanitized.data : [sanitized.data];
    const processed = items.map((item, index) => ({
      index,
      timestamp: Date.now(),
      value: item
    }));

    return {
      success: true,
      count: processed.length,
      results: processed
    };
  } catch (error) {
    console.error('Execution error:', error);
    throw new Error(\`Failed to process task: \${error.message}\`);
  }
}
\`\`\`

#### Key Architectural Notes
1. **Defensive Validation:** Guards against undefined and non-object inputs before processing.
2. **Error Boundary:** Catches runtime exceptions and normalizes error responses.
3. **Complexity:** Executes in linear $O(N)$ time with minimal allocation overhead.`;
  }

  if (normalizedMode === 'writing') {
    if (isConcise) {
      return `Here is a refined, polished draft:

> **Draft:** Thank you for reaching out${greetingName}. We have reviewed the recent progress and are pleased to share that all primary milestones are currently on schedule. Please let us know if you would like to arrange a brief sync this week.

• Crisp tone, clear call-to-action, zero redundant filler.`;
    }
    return `### [Writing Mode] Content Draft & Style Breakdown

Here is a structured, compelling draft tailored to your request:

---

> **Subject:** Update regarding project milestones and upcoming sync
>
> Dear team${greetingName ? ` and ${greetingName}` : ''},
>
> I am writing to provide a concise update on our recent milestones and outline the next steps for our upcoming release. Over the past sprint, our team successfully finalized the core architecture and resolved all high-priority items.
>
> **Key Highlights:**
> • **Milestone Progress:** Phase 1 deliverables are complete and undergoing review.
> • **Quality Standards:** All automated test suites and validation checks have passed.
> • **Next Steps:** We will begin final integration testing on Thursday morning.
>
> Please feel free to reply with any initial thoughts or adjustments before our scheduled check-in.
>
> Best regards,  
> **Orvix**

---

#### Editorial Notes
• **Tone & Register:** Professional, measured, and approachable.  
• **Structural Flow:** Opening state → itemized highlights → clear closing call-to-action.  
• **Clarity:** Bulleted points improve reading scanability for busy readers.`;
  }

  if (normalizedMode === 'learning') {
    return `### [Learning Mode] Conceptual Breakdown

${isBeginner ? '> **Everyday Analogy:** Think of this concept like an orchestra conductor. Rather than playing every instrument, the conductor signals each section when to begin so the entire performance remains in harmony.\n\n' : ''}Let's break down **"${promptText.slice(0, 45)}"** step-by-step:

#### 1. Core Principle
At its foundation, this concept revolves around breaking a large, intimidating problem into smaller, self-contained pieces that can be reasoned about independently.

#### 2. How It Works (Step-by-Step)
1. **The Input / Trigger:** A request or data packet enters the system.
2. **The Transformation:** Internal rules or algorithms validate and organize the data.
3. **The Output:** The final result is returned to the requester in a standardized format.

#### 3. Real-World Applications
• **Scalability:** Enables high-volume systems to handle thousands of requests without crashing.  
• **Maintainability:** Makes isolating and fixing bugs straightforward without breaking neighboring features.

---
💡 **Quick Comprehension Check:** How would you describe the relationship between the input and the transformation in your own words?`;
  }

  let body = '';
  if (
    promptLower.includes('code') ||
    promptLower.includes('react') ||
    promptLower.includes('javascript') ||
    promptLower.includes('bug')
  ) {
    if (isConcise) {
      body = `Here is the concise implementation:

\`\`\`javascript
async function handleUserMessage(prompt) {
  const sanitized = prompt.trim();
  return sanitized ? { id: \`msg-\${Date.now()}\`, content: sanitized } : null;
}
\`\`\`

• Trim input and return structured message payload.`;
    } else if (isDetailed) {
      body = `Here is a comprehensive breakdown and code implementation:

${isBeginner ? '> **Beginner Analogy:** Think of this function like an envelope sealer: it checks if the letter has text inside, stamps the current time on it, and sends it on its way.\n\n' : ''}### Implementation
\`\`\`javascript
/**
 * Processes incoming user prompts and formats standard message objects.
 * Handles validation, whitespace sanitization, and timestamp creation.
 */
async function handleUserMessage(prompt, context = []) {
  const sanitized = typeof prompt === 'string' ? prompt.trim() : '';
  if (!sanitized) {
    throw new Error('Message cannot be empty.');
  }

  return {
    id: \`msg-\${Date.now()}-\${Math.random().toString(36).substr(2, 5)}\`,
    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    content: sanitized,
    contextLength: context.length
  };
}
\`\`\`

### Architectural Notes
1. **Input validation:** Rejects empty whitespace before state mutations.
2. **Immutable history:** Returned message objects integrate directly into component state arrays.
3. **Data persistence:** Synchronized to Cloud Firestore or cached in local storage.`;
    } else {
      body = `Here is a clean code example addressing your request:
${isBeginner ? '\n*Friendly tip: This function takes user text, cleans extra spaces, and packages it with an ID and timestamp.*\n' : ''}
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

• **State updates:** Messages are updated immutably in memory or synced to Firestore.
• **Responsive design:** Markdown blocks format with syntax highlights.`;
    }
  } else if (
    promptLower.includes('brainstorm') ||
    promptLower.includes('idea') ||
    promptLower.includes('startup') ||
    promptLower.includes('name')
  ) {
    if (isConcise) {
      body = `1. **NexusPulse** — Ambient async workspace.
2. **KiteFlow** — Low-friction drafting engine.
3. **OmniCanvas** — Unified notes & canvas.
4. **SpectraAI** — High-speed research layer.`;
    } else {
      body = `Here are 4 creative concepts for your consideration:
${isBeginner ? '\n*Each idea is framed around solving a practical everyday workflow obstacle:*\n' : ''}
1. **NexusPulse** — Ambient conversational workspace for asynchronous team synthesis.
2. **KiteFlow** — Low-friction, lightweight drafting engine for technical creators.
3. **OmniCanvas** — Multimodal canvas bringing notes, documents, and chat threads into one view.
4. **SpectraAI** — Precision intelligence layer tailored for high-speed research.

*Tip: You can select any conversation from the sidebar or click "+ New Chat" to start fresh.*`;
    }
  } else if (
    promptLower.startsWith('hi') ||
    promptLower.startsWith('hello') ||
    promptLower.startsWith('hey')
  ) {
    if (isConcise) {
      body = `Hello${greetingName}! I'm **Orvix**. How can I help with writing, code, or ideas today?`;
    } else {
      body = `Hello${greetingName}! I am **Orvix**, your intelligent AI conversation companion.

${isBeginner ? "If you're new here, feel free to ask questions in plain English—no technical jargon required!\n\n" : ''}I can help you with:
• **Writing & Editing:** Craft essays, draft professional emails, and summarize reports.
• **Coding & Tech:** Debug React/Node code, explain architectures, and review syntax.
• **Brainstorming:** Generate fresh ideas, project names, and creative outlines.
• **Learning:** Break down complex topics simply and concisely.`;
    }
  } else {
    body = `Thank you for your prompt${personalSignoff}:
> "${promptText}"

${isBeginner ? 'I will explain everything simply and step-by-step. ' : ''}I am ready to assist with your questions, code samples, or writing projects. Feel free to ask more details or explore specific topics!`;
  }

  return body;
}

// API Health Check (supports both standalone and Vercel sub-route paths)
app.get(['/api/health', '/health'], (_req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// API Config Check (indicates configured providers without leaking keys)
app.get(['/api/config', '/config'], (_req, res) => {
  const geminiKey = process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY || '';
  const groqKey = process.env.GROQ_API_KEY || process.env.VITE_GROQ_API_KEY || '';
  const openrouterKey = process.env.OPENROUTER_API_KEY || process.env.VITE_OPENROUTER_API_KEY || '';
  const huggingfaceKey = process.env.HUGGINGFACE_API_KEY || process.env.HF_TOKEN || '';

  res.json({
    geminiConfigured: Boolean(geminiKey && geminiKey !== 'MY_GEMINI_API_KEY'),
    groqConfigured: Boolean(groqKey && groqKey !== 'YOUR_GROQ_API_KEY'),
    openrouterConfigured: Boolean(openrouterKey && openrouterKey !== 'YOUR_OPENROUTER_API_KEY'),
    huggingfaceConfigured: Boolean(huggingfaceKey && huggingfaceKey !== 'YOUR_HUGGINGFACE_API_KEY')
  });
});

// Helper utilities for Server-Sent Events (SSE) streaming
function initSSE(res: express.Response) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
}

function sendSSE(res: express.Response, data: object) {
  if (res.writableEnded) return;
  res.write(`data: ${JSON.stringify(data)}\n\n`);
  if (typeof (res as any).flush === 'function') {
    (res as any).flush();
  }
}

// Central AI Chat Dispatch Endpoint (supports /api/chat, /chat, and root / for Vercel functions)
app.post(['/api/chat', '/chat', '/'], async (req, res) => {
  try {
    const {
      provider = 'gemini',
      mode = 'general',
      prompt,
      history = [],
      username = null,
      preferences = null,
      stream = true
    } = req.body as {
      provider?: string;
      mode?: string;
      prompt?: string;
      history?: Array<{ sender?: string; content?: string }>;
      username?: string | null;
      preferences?: UserPreferences | null;
      stream?: boolean;
    };

    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'Prompt is required.' });
    }

    // Accurately track client response disconnection (res.on('close')), NOT request stream upload end
    let isClientClosed = false;
    res.on('close', () => {
      if (!res.writableEnded) {
        isClientClosed = true;
      }
    });

    const cleanUsername =
      typeof username === 'string' && username.trim()
        ? username.trim().slice(0, 50).replace(/[\r\n\t]/g, ' ')
        : null;

    const systemInstruction = buildSystemInstruction(cleanUsername, preferences, mode);
    const normalizedProvider = String(provider).toLowerCase();
    const shouldStream = stream !== false;

    // 1. Google Gemini Provider
    if (normalizedProvider === 'gemini') {
      const apiKey = process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY;

      // If no API key is configured, return simulated response (with progressive reveal if streaming)
      if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
        const text = generateSimulatedResponse(prompt, cleanUsername, preferences, mode);
        if (!shouldStream) {
          return res.json({
            text,
            modelUsed: 'gemini-3.1-flash-lite (demo)',
            provider: 'gemini'
          });
        }
        initSSE(res);
        sendSSE(res, { type: 'start', modelUsed: 'gemini-3.1-flash-lite (demo)', provider: 'gemini' });
        const tokens = text.split(/(\s+)/);
        for (const token of tokens) {
          if (isClientClosed || res.writableEnded) break;
          sendSSE(res, { type: 'chunk', text: token });
          await new Promise((r) => setTimeout(r, 20));
        }
        if (!res.writableEnded) {
          sendSSE(res, { type: 'done', text, modelUsed: 'gemini-3.1-flash-lite (demo)', provider: 'gemini' });
          res.end();
        }
        return;
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
      // Attempt sequence: max 3 attempts total (initial attempt + up to 2 retries)
      // Attempt 1 & 2 try gemini-3.8-flash (primary recommended model)
      // Attempt 3 tries gemini-3.1-flash-lite (alternative fallback model)
      const attemptPlan = [
        { model: 'gemini-3.8-flash', attemptNum: 1 },
        { model: 'gemini-3.8-flash', attemptNum: 2 },
        { model: 'gemini-3.1-flash-lite', attemptNum: 3 }
      ];
      const maxAttempts = attemptPlan.length;

      if (!shouldStream) {
        let lastParsedErr = null;

        for (let i = 0; i < attemptPlan.length; i++) {
          if (isClientClosed) break;
          const { model, attemptNum } = attemptPlan[i];

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
            const parsed = parseGeminiError(err);
            lastParsedErr = parsed;
            const hasMoreAttempts = i < attemptPlan.length - 1;
            const willRetry = parsed.isRetryable && hasMoreAttempts && !isClientClosed;

            logAIDiagnostic({
              provider: 'gemini',
              model,
              phase: 'non-streaming',
              attempt: attemptNum,
              maxAttempts,
              upstreamStatus: parsed.statusCode,
              upstreamErrorCode: parsed.status,
              sanitizedMessage: parsed.message,
              retryAfterSeconds: parsed.retryAfterSeconds,
              willRetry
            });

            if (!parsed.isRetryable) {
              return res.status(parsed.statusCode).json({
                error: parsed.message,
                code: parsed.statusCode,
                status: parsed.status,
                provider: 'gemini',
                model,
                retryable: false,
                canFallback: true,
                suggestedProviders: ['groq', 'openrouter']
              });
            }

            if (willRetry) {
              const delay = getBackoffWithJitter(attemptNum, parsed.retryAfterSeconds);
              const continueExecution = await sleepWithAbort(delay, () => isClientClosed);
              if (!continueExecution) break;
              continue;
            }
            break;
          }
        }

        const fallbackErr = lastParsedErr || {
          statusCode: 503,
          status: 'UNAVAILABLE',
          message: 'Google Gemini is currently experiencing high demand. Spikes in demand are usually temporary. Please try again in a few moments.',
          isRetryable: true
        };
        return res.status(fallbackErr.statusCode).json({
          error: fallbackErr.message,
          code: fallbackErr.statusCode,
          status: fallbackErr.status,
          provider: 'gemini',
          model: 'gemini-3.8-flash',
          retryable: fallbackErr.isRetryable,
          canFallback: true,
          suggestedProviders: ['groq', 'openrouter']
        });
      } else {
        // Genuine streaming via ai.models.generateContentStream with delayed header initiation
        let lastParsedErr = null;

        for (let i = 0; i < attemptPlan.length; i++) {
          if (isClientClosed) break;
          const { model, attemptNum } = attemptPlan[i];

          try {
            const responseStream = await ai.models.generateContentStream({
              model,
              contents,
              config: {
                systemInstruction
              }
            });

            // CRITICAL: Await the first chunk BEFORE initializing SSE headers on res!
            // This verifies the stream actually started and prevents sending 200 SSE headers if model returns 503 UNAVAILABLE.
            const iterator = responseStream[Symbol.asyncIterator]();
            const firstChunkResult = await iterator.next();

            // Connection established successfully! Send headers and start event now.
            initSSE(res);
            sendSSE(res, { type: 'start', modelUsed: model, provider: 'gemini' });

            let fullText = '';
            if (!firstChunkResult.done && firstChunkResult.value) {
              const chunkText = firstChunkResult.value.text;
              if (chunkText) {
                fullText += chunkText;
                sendSSE(res, { type: 'chunk', text: chunkText });
              }
            }

            // Process subsequent stream chunks
            try {
              while (true) {
                if (isClientClosed || res.writableEnded) break;
                const { done, value } = await iterator.next();
                if (done) break;
                const chunkText = value?.text;
                if (chunkText) {
                  fullText += chunkText;
                  sendSSE(res, { type: 'chunk', text: chunkText });
                }
              }

              if (!res.writableEnded) {
                sendSSE(res, { type: 'done', text: fullText, modelUsed: model, provider: 'gemini' });
                res.end();
              }
              return;
            } catch (midStreamErr: any) {
              const parsedMid = parseGeminiError(midStreamErr);
              logAIDiagnostic({
                provider: 'gemini',
                model,
                phase: 'mid-stream',
                attempt: 1,
                maxAttempts: 1,
                upstreamStatus: parsedMid.statusCode,
                upstreamErrorCode: parsedMid.status,
                sanitizedMessage: parsedMid.message,
                willRetry: false
              });

              if (!res.writableEnded) {
                sendSSE(res, {
                  type: 'error',
                  error: parsedMid.message,
                  code: parsedMid.statusCode,
                  status: parsedMid.status,
                  provider: 'gemini',
                  model,
                  retryable: false, // Cannot retry mid-stream safely without duplicating output
                  partial: fullText.length > 0
                });
                res.end();
              }
              return;
            }
          } catch (initialErr: any) {
            // Initial connection failed BEFORE headers were sent!
            const parsed = parseGeminiError(initialErr);
            lastParsedErr = parsed;
            const hasMoreAttempts = i < attemptPlan.length - 1;
            const willRetry = parsed.isRetryable && hasMoreAttempts && !isClientClosed;

            logAIDiagnostic({
              provider: 'gemini',
              model,
              phase: 'pre-stream',
              attempt: attemptNum,
              maxAttempts,
              upstreamStatus: parsed.statusCode,
              upstreamErrorCode: parsed.status,
              sanitizedMessage: parsed.message,
              retryAfterSeconds: parsed.retryAfterSeconds,
              willRetry
            });

            if (!parsed.isRetryable) {
              return res.status(parsed.statusCode).json({
                error: parsed.message,
                code: parsed.statusCode,
                status: parsed.status,
                provider: 'gemini',
                model,
                retryable: false,
                canFallback: true,
                suggestedProviders: ['groq', 'openrouter']
              });
            }

            if (willRetry) {
              const delay = getBackoffWithJitter(attemptNum, parsed.retryAfterSeconds);
              const continueExecution = await sleepWithAbort(delay, () => isClientClosed);
              if (!continueExecution) break;
              continue;
            }
            break;
          }
        }

        const finalErr = lastParsedErr || {
          statusCode: 503,
          status: 'UNAVAILABLE',
          message: 'Google Gemini is currently experiencing high demand. Spikes in demand are usually temporary. Please try again in a few moments.',
          isRetryable: true
        };
        return res.status(finalErr.statusCode).json({
          error: finalErr.message,
          code: finalErr.statusCode,
          status: finalErr.status,
          provider: 'gemini',
          model: 'gemini-3.8-flash',
          retryable: finalErr.isRetryable,
          canFallback: true,
          suggestedProviders: ['groq', 'openrouter']
        });
      }
    }

    // 2. Groq Provider
    if (normalizedProvider === 'groq') {
      const apiKey = process.env.GROQ_API_KEY || process.env.VITE_GROQ_API_KEY;
      if (!apiKey || apiKey === 'YOUR_GROQ_API_KEY') {
        const text = generateSimulatedResponse(prompt, cleanUsername, preferences, mode);
        if (!shouldStream) {
          return res.json({
            text,
            modelUsed: 'Llama 3.3 70B (demo)',
            provider: 'groq'
          });
        }
        initSSE(res);
        sendSSE(res, { type: 'start', modelUsed: 'Llama 3.3 70B (demo)', provider: 'groq' });
        const tokens = text.split(/(\s+)/);
        for (const token of tokens) {
          if (isClientClosed || res.writableEnded) break;
          sendSSE(res, { type: 'chunk', text: token });
          await new Promise((r) => setTimeout(r, 20));
        }
        if (!res.writableEnded) {
          sendSSE(res, { type: 'done', text, modelUsed: 'Llama 3.3 70B (demo)', provider: 'groq' });
          res.end();
        }
        return;
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

      if (!shouldStream) {
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
      } else {
        // Genuine streaming via Groq OpenAI-compatible SSE
        const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: 'openai/gpt-oss-120b',
            messages,
            temperature: 0.7,
            stream: true
          })
        });

        if (!groqRes.ok) {
          const errText = await groqRes.text();
          return res.status(groqRes.status).json({
            error: `Groq request failed (${groqRes.status}): ${errText}`
          });
        }

        initSSE(res);
        sendSSE(res, { type: 'start', modelUsed: 'openai/gpt-oss-120b', provider: 'groq' });

        const reader = groqRes.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let fullText = '';
        let modelUsed = 'openai/gpt-oss-120b';

        while (true) {
          if (isClientClosed || res.writableEnded) break;
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
                fullText += delta;
                sendSSE(res, { type: 'chunk', text: delta });
              }
            } catch (_) {}
          }
        }

        if (!res.writableEnded) {
          sendSSE(res, { type: 'done', text: fullText, modelUsed, provider: 'groq' });
          res.end();
        }
        return;
      }
    }

    // 3. OpenRouter Provider
    if (normalizedProvider === 'openrouter') {
      const apiKey = process.env.OPENROUTER_API_KEY || process.env.VITE_OPENROUTER_API_KEY;
      if (!apiKey || apiKey === 'YOUR_OPENROUTER_API_KEY') {
        const text = generateSimulatedResponse(prompt, cleanUsername, preferences, mode);
        if (!shouldStream) {
          return res.json({
            text,
            modelUsed: 'openrouter/free (demo)',
            provider: 'openrouter'
          });
        }
        initSSE(res);
        sendSSE(res, { type: 'start', modelUsed: 'openrouter/free (demo)', provider: 'openrouter' });
        const tokens = text.split(/(\s+)/);
        for (const token of tokens) {
          if (isClientClosed || res.writableEnded) break;
          sendSSE(res, { type: 'chunk', text: token });
          await new Promise((r) => setTimeout(r, 20));
        }
        if (!res.writableEnded) {
          sendSSE(res, { type: 'done', text, modelUsed: 'openrouter/free (demo)', provider: 'openrouter' });
          res.end();
        }
        return;
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

      if (!shouldStream) {
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
      } else {
        // Genuine streaming via OpenRouter SSE
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
            temperature: 0.7,
            stream: true
          })
        });

        if (!orRes.ok) {
          const errText = await orRes.text();
          return res.status(orRes.status).json({
            error: `OpenRouter request failed (${orRes.status}): ${errText}`
          });
        }

        initSSE(res);
        sendSSE(res, { type: 'start', modelUsed: 'openrouter/free', provider: 'openrouter' });

        const reader = orRes.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let fullText = '';
        let modelUsed = 'openrouter/free';

        while (true) {
          if (isClientClosed || res.writableEnded) break;
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
                fullText += delta;
                sendSSE(res, { type: 'chunk', text: delta });
              }
            } catch (_) {}
          }
        }

        if (!res.writableEnded) {
          sendSSE(res, { type: 'done', text: fullText, modelUsed, provider: 'openrouter' });
          res.end();
        }
        return;
      }
    }

    // 4. Hugging Face Inference Providers
    if (normalizedProvider === 'huggingface') {
      const apiKey = process.env.HUGGINGFACE_API_KEY || process.env.HF_TOKEN || '';
      const hfModel = 'meta-llama/Llama-3.3-70B-Instruct';

      if (!apiKey || apiKey === 'YOUR_HUGGINGFACE_API_KEY') {
        const text = generateSimulatedResponse(prompt, cleanUsername, preferences, mode);
        if (!shouldStream) {
          return res.json({
            text,
            modelUsed: `${hfModel} (demo)`,
            provider: 'huggingface'
          });
        }
        initSSE(res);
        sendSSE(res, { type: 'start', modelUsed: `${hfModel} (demo)`, provider: 'huggingface' });
        const tokens = text.split(/(\s+)/);
        for (const token of tokens) {
          if (isClientClosed || res.writableEnded) break;
          sendSSE(res, { type: 'chunk', text: token });
          await new Promise((r) => setTimeout(r, 20));
        }
        if (!res.writableEnded) {
          sendSSE(res, { type: 'done', text, modelUsed: `${hfModel} (demo)`, provider: 'huggingface' });
          res.end();
        }
        return;
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

      if (!shouldStream) {
        let hfRes: any;
        try {
          hfRes = await fetch('https://router.huggingface.co/v1/chat/completions', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              model: hfModel,
              messages,
              temperature: 0.7
            })
          });
        } catch (fetchErr: any) {
          logAIDiagnostic({
            provider: 'huggingface',
            model: hfModel,
            phase: 'non-streaming',
            attempt: 1,
            maxAttempts: 1,
            sanitizedMessage: fetchErr?.message || 'Network error reaching Hugging Face router',
            willRetry: false
          });
          return res.status(502).json({
            error: 'Network connection error while contacting Hugging Face Inference Providers. Please try again.',
            code: 502,
            status: 'BAD_GATEWAY',
            provider: 'huggingface',
            model: hfModel,
            retryable: true,
            canFallback: true,
            suggestedProviders: ['gemini', 'groq', 'openrouter']
          });
        }

        if (!hfRes.ok) {
          const errText = await hfRes.text();
          let parsedError = errText;
          try {
            const errObj = JSON.parse(errText);
            if (errObj.error) {
              parsedError = typeof errObj.error === 'string' ? errObj.error : errObj.error.message || errText;
            }
          } catch (_) {}

          logAIDiagnostic({
            provider: 'huggingface',
            model: hfModel,
            phase: 'non-streaming',
            attempt: 1,
            maxAttempts: 1,
            upstreamStatus: hfRes.status,
            sanitizedMessage: parsedError,
            willRetry: false
          });

          return res.status(hfRes.status).json({
            error: sanitizeErrorLog(parsedError),
            code: hfRes.status,
            status: hfRes.status === 401 ? 'UNAUTHORIZED' : hfRes.status === 429 ? 'RATE_LIMIT' : 'ERROR',
            provider: 'huggingface',
            model: hfModel,
            retryable: hfRes.status === 429 || hfRes.status >= 500,
            canFallback: true,
            suggestedProviders: ['gemini', 'groq', 'openrouter']
          });
        }

        const data = await hfRes.json();
        return res.json({
          text: data?.choices?.[0]?.message?.content || '',
          modelUsed: data.model || hfModel,
          provider: 'huggingface'
        });
      } else {
        // Genuine streaming via Hugging Face OpenAI-compatible SSE
        let hfRes: any;
        try {
          hfRes = await fetch('https://router.huggingface.co/v1/chat/completions', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              model: hfModel,
              messages,
              temperature: 0.7,
              stream: true
            })
          });
        } catch (fetchErr: any) {
          logAIDiagnostic({
            provider: 'huggingface',
            model: hfModel,
            phase: 'pre-stream',
            attempt: 1,
            maxAttempts: 1,
            sanitizedMessage: fetchErr?.message || 'Network error reaching Hugging Face router',
            willRetry: false
          });
          return res.status(502).json({
            error: 'Network connection error while contacting Hugging Face Inference Providers. Please try again.',
            code: 502,
            status: 'BAD_GATEWAY',
            provider: 'huggingface',
            model: hfModel,
            retryable: true,
            canFallback: true,
            suggestedProviders: ['gemini', 'groq', 'openrouter']
          });
        }

        if (!hfRes.ok) {
          const errText = await hfRes.text();
          let parsedError = errText;
          try {
            const errObj = JSON.parse(errText);
            if (errObj.error) {
              parsedError = typeof errObj.error === 'string' ? errObj.error : errObj.error.message || errText;
            }
          } catch (_) {}

          logAIDiagnostic({
            provider: 'huggingface',
            model: hfModel,
            phase: 'pre-stream',
            attempt: 1,
            maxAttempts: 1,
            upstreamStatus: hfRes.status,
            sanitizedMessage: parsedError,
            willRetry: false
          });

          return res.status(hfRes.status).json({
            error: sanitizeErrorLog(parsedError),
            code: hfRes.status,
            status: hfRes.status === 401 ? 'UNAUTHORIZED' : hfRes.status === 429 ? 'RATE_LIMIT' : 'ERROR',
            provider: 'huggingface',
            model: hfModel,
            retryable: hfRes.status === 429 || hfRes.status >= 500,
            canFallback: true,
            suggestedProviders: ['gemini', 'groq', 'openrouter']
          });
        }

        initSSE(res);
        sendSSE(res, { type: 'start', modelUsed: hfModel, provider: 'huggingface' });

        const reader = hfRes.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let fullText = '';
        let modelUsed = hfModel;

        while (true) {
          if (isClientClosed || res.writableEnded) break;
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
                fullText += delta;
                sendSSE(res, { type: 'chunk', text: delta });
              }
            } catch (_) {}
          }
        }

        if (!res.writableEnded) {
          sendSSE(res, { type: 'done', text: fullText, modelUsed, provider: 'huggingface' });
          res.end();
        }
        return;
      }
    }

    return res.status(400).json({ error: `Unknown provider: ${provider}` });
  } catch (error: any) {
    console.error('API Error in /api/chat:', error);
    const parsed = parseGeminiError(error);
    if (res.headersSent) {
      sendSSE(res, {
        type: 'error',
        error: parsed.message,
        code: parsed.statusCode,
        status: parsed.status,
        retryable: parsed.isRetryable,
        canFallback: true,
        suggestedProviders: ['gemini', 'groq', 'openrouter', 'huggingface']
      });
      if (!res.writableEnded) res.end();
    } else {
      res.status(parsed.statusCode).json({
        error: parsed.message,
        code: parsed.statusCode,
        status: parsed.status,
        retryable: parsed.isRetryable,
        canFallback: true,
        suggestedProviders: ['gemini', 'groq', 'openrouter', 'huggingface']
      });
    }
  }
});

// Setup Vite middleware in dev or static serving in production
async function startServer() {
  const publicPath = path.resolve(__dirname, 'public');
  app.use(express.static(publicPath));

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