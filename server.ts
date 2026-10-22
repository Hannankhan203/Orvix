import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import crypto from 'crypto';
import multer from 'multer';
import { GoogleGenAI } from '@google/genai';
// @ts-ignore - Document extraction JavaScript service
import { extractDocumentContent } from './src/services/documentExtractor.js';
// @ts-ignore - Document context JavaScript service
import {
  prepareDocumentContext,
  generateSimulatedDocumentResponse,
  adaptDocumentContextForProvider,
  formatOpenAIMessages
} from './src/services/documentContextService.js';

export interface DocumentData {
  fileId?: string;
  id?: string;
  filename?: string;
  originalName: string;
  name?: string;
  format: string;
  mimeType?: string;
  sizeBytes?: number;
  status: string;
  success?: boolean;
  text: string;
  summaryText?: string;
  totalCharacters: number;
  totalWords: number;
  pageCount?: number;
  pages?: Array<{ pageNumber: number; text: string; charCount: number }>;
  slideCount?: number;
  slides?: Array<{ slideNumber: number; title?: string; text: string; notes?: string; charCount: number }>;
  sectionCount?: number;
  sections?: Array<{ heading: string; level: number; content: string; charCount: number }>;
  table?: {
    headers: string[];
    rowCount: number;
    columnCount: number;
    previewRows: string[][];
    markdownTable: string;
  };
  isScanned?: boolean;
  isTruncated?: boolean;
  warning?: string;
  error?: string;
}

export interface PreparedDocumentContext {
  formattedContext: string;
  hasErrorsOrWarnings: boolean;
  unreadableDocNotes: string[];
  targetedDocs: DocumentData[];
  scope: string;
  isBoundedOrChunked: boolean;
  truncationNote?: string;
  directAnswer?: string;
}

export interface DocumentExtractionResult {
  fileId: string;
  filename: string;
  originalName: string;
  format: string;
  mimeType: string;
  sizeBytes: number;
  status: string;
  success: boolean;
  text: string;
  summaryText?: string;
  totalCharacters: number;
  totalWords: number;
  pageCount?: number;
  pages?: Array<{ pageNumber: number; text: string; charCount: number }>;
  slideCount?: number;
  slides?: Array<{ slideNumber: number; title?: string; text: string; notes?: string; charCount: number }>;
  sectionCount?: number;
  sections?: Array<{ heading: string; level: number; content: string; charCount: number }>;
  table?: {
    headers: string[];
    rowCount: number;
    columnCount: number;
    previewRows: string[][];
    markdownTable: string;
  };
  isScanned?: boolean;
  isTruncated?: boolean;
  warning?: string;
  error?: string;
  extractedAt: string;
}

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
  const cfAccountId = process.env.CLOUDFLARE_ACCOUNT_ID || '';
  const cfToken = process.env.CLOUDFLARE_API_TOKEN || '';

  res.json({
    geminiConfigured: Boolean(geminiKey && geminiKey !== 'MY_GEMINI_API_KEY'),
    groqConfigured: Boolean(groqKey && groqKey !== 'YOUR_GROQ_API_KEY'),
    openrouterConfigured: Boolean(openrouterKey && openrouterKey !== 'YOUR_OPENROUTER_API_KEY'),
    cloudflareConfigured: Boolean(
      cfAccountId &&
      cfAccountId !== 'YOUR_CLOUDFLARE_ACCOUNT_ID' &&
      cfToken &&
      cfToken !== 'YOUR_CLOUDFLARE_API_TOKEN'
    )
  });
});

/* ==========================================================================
   Controlled Temporary File Upload & Storage Management Architecture
   ========================================================================== */

// Vercel's deployed filesystem is read-only except for /tmp.
// Keep the existing persistent-looking directory locally,
// but use Vercel's writable temporary filesystem in production.
const UPLOAD_DIR = process.env.VERCEL
  ? path.join('/tmp', 'orvix-uploads')
  : path.resolve(__dirname, 'uploads', 'temp');

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Configurable upload constraints and lifecycle bounds
const MAX_FILE_SIZE_BYTES =
  parseInt(process.env.MAX_FILE_SIZE_BYTES || '', 10) || 25 * 1024 * 1024; // 25 MB default
const MAX_ATTACHMENTS_PER_UPLOAD =
  parseInt(process.env.MAX_ATTACHMENTS_PER_UPLOAD || '', 10) || 5; // Max 5 attachments per message
const TEMP_FILE_TTL_MS =
  parseInt(process.env.TEMP_FILE_TTL_MS || '', 10) || 2 * 60 * 60 * 1000; // 2 hours retention TTL

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const size = (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1);
  return `${size} ${units[i]}`;
}

// Strict whitelist of permitted file extensions and their corresponding MIME types
const ALLOWED_EXTENSIONS_MAP: Record<string, string[]> = {
  '.pdf': ['application/pdf'],
  '.docx': [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/zip',
    'application/octet-stream'
  ],
  '.doc': ['application/msword', 'application/octet-stream'],
  '.pptx': [
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/zip',
    'application/octet-stream'
  ],
  '.ppt': ['application/vnd.ms-powerpoint', 'application/octet-stream'],
  '.xlsx': [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/zip',
    'application/octet-stream'
  ],
  '.xls': ['application/vnd.ms-excel', 'application/octet-stream'],
  '.txt': ['text/plain', 'application/octet-stream'],
  '.md': ['text/markdown', 'text/plain', 'text/x-markdown', 'application/octet-stream'],
  '.markdown': ['text/markdown', 'text/plain', 'application/octet-stream'],
  '.csv': ['text/csv', 'text/plain', 'application/csv', 'application/vnd.ms-excel', 'application/octet-stream'],
  '.tsv': ['text/tab-separated-values', 'text/plain', 'application/octet-stream'],
  '.json': ['application/json', 'text/json', 'text/plain', 'application/octet-stream'],
  '.xml': ['application/xml', 'text/xml', 'text/plain', 'application/octet-stream']
};

/**
 * Validates binary file headers and content signatures (magic numbers)
 * to prevent executable binaries or corrupted files from being accepted under false extensions.
 */
async function verifyFileSignature(
  filePath: string,
  ext: string
): Promise<{ valid: boolean; reason?: string }> {
  let fd: number | null = null;
  try {
    const stats = await fs.promises.stat(filePath);
    if (stats.size === 0) {
      return { valid: false, reason: 'File is empty (0 bytes).' };
    }

    const buffer = Buffer.alloc(Math.min(512, stats.size));
    fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buffer, 0, buffer.length, 0);
    fs.closeSync(fd);
    fd = null;

    // Reject executable binary formats regardless of declared extension
    // Linux ELF binary
    if (
      buffer.length >= 4 &&
      buffer[0] === 0x7f &&
      buffer[1] === 0x45 &&
      buffer[2] === 0x4c &&
      buffer[3] === 0x46
    ) {
      return { valid: false, reason: 'Binary executable format (ELF) is not permitted.' };
    }
    // Windows PE / MZ executable
    if (buffer.length >= 2 && buffer[0] === 0x4d && buffer[1] === 0x5a) {
      return { valid: false, reason: 'Binary executable format (Windows PE) is not permitted.' };
    }
    // Mach-O binary
    if (
      buffer.length >= 4 &&
      ((buffer[0] === 0xfe && buffer[1] === 0xed && buffer[2] === 0xfa && (buffer[3] === 0xce || buffer[3] === 0xcf)) ||
       (buffer[0] === 0xcf && buffer[1] === 0xfa && buffer[2] === 0xed && buffer[3] === 0xfe))
    ) {
      return { valid: false, reason: 'Binary executable format (Mach-O) is not permitted.' };
    }

    // Format-specific verification
    if (ext === '.pdf') {
      const header = buffer.toString('utf-8', 0, Math.min(10, buffer.length));
      if (!header.startsWith('%PDF-')) {
        return { valid: false, reason: 'Invalid PDF format: missing standard %PDF- header signature.' };
      }
      return { valid: true };
    }

    if (ext === '.docx' || ext === '.pptx' || ext === '.xlsx') {
      // Standard PK Zip archive header: PK\x03\x04 or PK\x05\x06
      if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b) {
        return { valid: true };
      }
      return {
        valid: false,
        reason: `Invalid ${ext.toUpperCase().slice(1)} format: missing standard OpenXML zip container signature.`
      };
    }

    if (ext === '.doc' || ext === '.ppt' || ext === '.xls') {
      // OLE Compound File signature D0 CF 11 E0 A1 B1 1A E1
      if (
        buffer.length >= 8 &&
        buffer[0] === 0xd0 &&
        buffer[1] === 0xcf &&
        buffer[2] === 0x11 &&
        buffer[3] === 0xe0 &&
        buffer[4] === 0xa1 &&
        buffer[5] === 0xb1 &&
        buffer[6] === 0x1a &&
        buffer[7] === 0xe1
      ) {
        return { valid: true };
      }
      return { valid: false, reason: 'Invalid legacy Office document: missing OLE compound binary signature.' };
    }

    // Text formats: disallow null bytes \0 to prevent disguised binary files
    if (['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.xml'].includes(ext)) {
      for (let i = 0; i < buffer.length; i++) {
        if (buffer[i] === 0x00) {
          return { valid: false, reason: 'Text file contains unexpected null binary bytes.' };
        }
      }
      if (ext === '.json') {
        const str = buffer.toString('utf-8').trim();
        if (
          str &&
          !str.startsWith('{') &&
          !str.startsWith('[') &&
          !str.startsWith('"') &&
          !str.startsWith('true') &&
          !str.startsWith('false') &&
          !str.startsWith('null') &&
          isNaN(Number(str[0]))
        ) {
          return { valid: false, reason: 'Invalid JSON format: file does not begin with valid JSON syntax.' };
        }
      }
      return { valid: true };
    }

    return { valid: true };
  } catch (err: any) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (_) {}
    }
    return { valid: false, reason: `File inspection failed: ${err?.message || 'unknown error'}` };
  }
}

// Multer storage engine writing to controlled uploads/temp directory with secure UUIDs
const uploadStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const fileId = crypto.randomUUID();
    // Safe filename prevents path traversal
    cb(null, `${fileId}${ext}`);
  }
});

// Multer pre-upload file filter
const uploadFilter = (
  _req: express.Request,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback
) => {
  const originalName = file.originalname || '';
  const baseName = path.basename(originalName);
  const ext = path.extname(baseName).toLowerCase();

  if (!ext || !ALLOWED_EXTENSIONS_MAP[ext]) {
    return cb(
      new Error(
        `Unsupported file extension: '${ext || 'none'}'. Supported: PDF, DOCX, DOC, TXT, MD, PPT, PPTX, CSV, TSV, JSON, XML, XLSX, XLS.`
      )
    );
  }

  const allowedMimes = ALLOWED_EXTENSIONS_MAP[ext];
  const clientMime = (file.mimetype || '').toLowerCase();
  if (
    clientMime &&
    !allowedMimes.includes(clientMime) &&
    clientMime !== 'application/octet-stream'
  ) {
    return cb(
      new Error(
        `MIME type '${clientMime}' is not permitted for ${ext.toUpperCase()} files.`
      )
    );
  }

  cb(null, true);
};

const uploadMiddleware = multer({
  storage: uploadStorage,
  limits: {
    fileSize: MAX_FILE_SIZE_BYTES,
    files: MAX_ATTACHMENTS_PER_UPLOAD
  },
  fileFilter: uploadFilter as any
});

interface UploadedFileRecord {
  id: string;
  originalName: string;
  diskFilename: string;
  mimeType: string;
  extension: string;
  size: number;
  formattedSize: string;
  status: 'uploaded' | 'ready';
  uploadedAt: string;
  expiresAt: number;
  conversationId?: string;
  extraction?: DocumentExtractionResult;
}

// In-memory registry tracking uploaded temporary files and their lifecycle
const fileRegistry = new Map<string, UploadedFileRecord>();
// Conversation to file IDs association mapping (strictly isolates documents per conversation)
const conversationDocuments = new Map<string, Set<string>>();

/**
 * Automated lifecycle cleanup: Sweeps the temporary upload directory and registry,
 * unlinking files exceeding the TTL (default: 2 hours).
 */
function cleanupExpiredUploads() {
  try {
    const now = Date.now();
    for (const [id, record] of fileRegistry.entries()) {
      if (record.expiresAt <= now) {
        fileRegistry.delete(id);
        const fullPath = path.join(UPLOAD_DIR, record.diskFilename);
        fs.promises.unlink(fullPath).catch(() => {});
      }
    }

    fs.readdir(UPLOAD_DIR, (err, files) => {
      if (err || !Array.isArray(files)) return;
      for (const filename of files) {
        const filePath = path.join(UPLOAD_DIR, filename);
        fs.stat(filePath, (statErr, stats) => {
          if (statErr || !stats) return;
          if (now - stats.mtimeMs > TEMP_FILE_TTL_MS) {
            fs.unlink(filePath, () => {});
          }
        });
      }
    });
  } catch (e) {
    console.warn('[Upload Cleanup] Error during temp file cleanup:', e);
  }
}

// Run cleanup every 15 minutes
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;
const cleanupTimer = setInterval(cleanupExpiredUploads, CLEANUP_INTERVAL_MS);
if (cleanupTimer.unref) cleanupTimer.unref();

// Upload Configuration Endpoint (returns limits and supported formats)
app.get(['/api/upload/config', '/upload/config'], (_req, res) => {
  res.json({
    maxFileSizeBytes: MAX_FILE_SIZE_BYTES,
    maxFileSizeFormatted: formatBytes(MAX_FILE_SIZE_BYTES),
    maxAttachments: MAX_ATTACHMENTS_PER_UPLOAD,
    allowedExtensions: Object.keys(ALLOWED_EXTENSIONS_MAP).map((e) =>
      e.replace('.', '').toUpperCase()
    ),
    ttlMinutes: Math.round(TEMP_FILE_TTL_MS / (60 * 1000))
  });
});

// Upload Attachment Metadata Endpoint
app.get(['/api/upload/:id', '/upload/:id'], (req, res) => {
  const fileId = req.params.id;
  if (!fileId || !/^[0-9a-fA-F-]{36}$/.test(fileId)) {
    return res.status(400).json({ error: 'Invalid attachment ID format.' });
  }

  const record = fileRegistry.get(fileId);
  if (!record) {
    return res.status(404).json({ error: 'Attachment not found or has expired.' });
  }

  return res.json({
    id: record.id,
    name: record.originalName,
    originalName: record.originalName,
    extension: record.extension,
    mimeType: record.mimeType,
    type: record.mimeType,
    size: record.size,
    formattedSize: record.formattedSize,
    status: record.status,
    uploadedAt: record.uploadedAt,
    expiresAt: record.expiresAt,
    extraction: record.extraction
  });
});

// Dedicated Document Extraction Detail Endpoint
app.get(['/api/upload/:id/extraction', '/upload/:id/extraction'], async (req, res) => {
  const fileId = req.params.id;
  if (!fileId || !/^[0-9a-fA-F-]{36}$/.test(fileId)) {
    return res.status(400).json({ error: 'Invalid attachment ID format.' });
  }

  const record = fileRegistry.get(fileId);
  if (!record) {
    return res.status(404).json({ error: 'Attachment not found or has expired.' });
  }

  if (record.extraction) {
    return res.json(record.extraction);
  }

  const filePath = path.join(UPLOAD_DIR, record.diskFilename);
  const ext = path.extname(record.diskFilename);
  const extraction = (await extractDocumentContent(
    filePath,
    record.originalName,
    ext,
    record.mimeType,
    record.id
  )) as DocumentExtractionResult;
  record.extraction = extraction;
  return res.json(extraction);
});

// Dedicated Attachment File Serving & Download Endpoint (Requirements 4, 6, 8)
app.get(
  ['/api/upload/:id/file', '/upload/:id/file', '/api/upload/:id/download', '/upload/:id/download'],
  async (req, res) => {
    const fileId = req.params.id;
    if (!fileId || !/^[0-9a-fA-F-]{36}$/.test(fileId)) {
      return res.status(400).json({ error: 'Invalid attachment ID format.' });
    }

    const record = fileRegistry.get(fileId);
    let diskFilename = record?.diskFilename;
    let originalName = record?.originalName || 'document';
    let mimeType = record?.mimeType || 'application/octet-stream';

    if (!diskFilename) {
      try {
        const files = await fs.promises.readdir(UPLOAD_DIR);
        const match = files.find((f) => f.startsWith(fileId));
        if (match) {
          diskFilename = match;
          const ext = path.extname(match).toLowerCase();
          mimeType = (ALLOWED_EXTENSIONS_MAP[ext] && ALLOWED_EXTENSIONS_MAP[ext][0]) || 'application/octet-stream';
        }
      } catch (_) {}
    }

    if (!diskFilename) {
      return res.status(404).json({ error: 'Attachment file not found or has expired.' });
    }

    const filePath = path.join(UPLOAD_DIR, diskFilename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Attachment file not found or has expired.' });
    }

    const forceDownload = req.query.download === 'true' || req.path.includes('/download');
    const isInline =
      !forceDownload &&
      (mimeType === 'application/pdf' ||
        mimeType.startsWith('text/') ||
        mimeType.startsWith('image/'));

    const safeFilename = path.basename(originalName).replace(/["\r\n]/g, '_');
    res.setHeader('Content-Type', mimeType);
    res.setHeader(
      'Content-Disposition',
      `${isInline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(safeFilename)}"; filename*=UTF-8''${encodeURIComponent(safeFilename)}`
    );

    return res.sendFile(filePath);
  }
);

// Upload Deletion Endpoint (cleans up staging file if removed before submission)
app.delete(['/api/upload/:id', '/upload/:id'], async (req, res) => {
  const fileId = req.params.id;
  if (!fileId || !/^[0-9a-fA-F-]{36}$/.test(fileId)) {
    return res.status(400).json({ error: 'Invalid attachment ID format.' });
  }

  const record = fileRegistry.get(fileId);
  fileRegistry.delete(fileId);
  if (record?.conversationId && conversationDocuments.has(record.conversationId)) {
    conversationDocuments.get(record.conversationId)!.delete(fileId);
  }

  try {
    const files = await fs.promises.readdir(UPLOAD_DIR);
    for (const fname of files) {
      if (fname.startsWith(fileId)) {
        await fs.promises.unlink(path.join(UPLOAD_DIR, fname));
      }
    }
  } catch (_) {}

  return res.json({ success: true, id: fileId });
});

// Dedicated Multipart File Upload Endpoint
app.post(['/api/upload', '/upload'], (req, res) => {
  uploadMiddleware.array('files', MAX_ATTACHMENTS_PER_UPLOAD)(req as any, res as any, async (err: any) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({
            error: `File exceeds maximum allowed size of ${formatBytes(MAX_FILE_SIZE_BYTES)}.`,
            code: 'FILE_TOO_LARGE'
          });
        }
        if (err.code === 'LIMIT_FILE_COUNT') {
          return res.status(400).json({
            error: `Maximum of ${MAX_ATTACHMENTS_PER_UPLOAD} attachments allowed per upload.`,
            code: 'TOO_MANY_FILES'
          });
        }
        if (err.code === 'LIMIT_UNEXPECTED_FILE') {
          return res.status(400).json({
            error: "Unexpected field in upload. Expected field name 'files'.",
            code: 'UNEXPECTED_FIELD'
          });
        }
      }
      return res.status(400).json({
        error: err.message || 'File upload failed.',
        code: 'UPLOAD_ERROR'
      });
    }

    const files = req.files as Express.Multer.File[] | undefined;
    if (!files || files.length === 0) {
      return res.status(400).json({
        error: 'No files provided for upload.',
        code: 'NO_FILES'
      });
    }

    const conversationId = req.body?.conversationId ? String(req.body.conversationId).trim() : undefined;
    const uploadedResults: UploadedFileRecord[] = [];
    const validationErrors: string[] = [];

    // Inspect each uploaded file for size and binary signature integrity
    for (const file of files) {
      const ext = path.extname(file.originalname).toLowerCase();
      const safeBaseName = path.basename(file.originalname).replace(/[\r\n\t]/g, ' ').slice(0, 150);

      if (file.size === 0) {
        validationErrors.push(`File '${safeBaseName}' is empty (0 bytes).`);
        try {
          await fs.promises.unlink(file.path);
        } catch (_) {}
        continue;
      }

      const sigResult = await verifyFileSignature(file.path, ext);
      if (!sigResult.valid) {
        validationErrors.push(`File '${safeBaseName}': ${sigResult.reason}`);
        try {
          await fs.promises.unlink(file.path);
        } catch (_) {}
        continue;
      }

      const fileId = path.basename(file.filename, ext);
      const nowIso = new Date().toISOString();
      const record: UploadedFileRecord = {
        id: fileId,
        originalName: safeBaseName,
        diskFilename: file.filename,
        mimeType: file.mimetype || 'application/octet-stream',
        extension: ext.replace('.', '').toUpperCase(),
        size: file.size,
        formattedSize: formatBytes(file.size),
        status: 'uploaded',
        uploadedAt: nowIso,
        expiresAt: Date.now() + TEMP_FILE_TTL_MS,
        conversationId
      };

      fileRegistry.set(fileId, record);
      if (conversationId) {
        let docSet = conversationDocuments.get(conversationId);
        if (!docSet) {
          docSet = new Set<string>();
          conversationDocuments.set(conversationId, docSet);
        }
        docSet.add(fileId);
      }
      uploadedResults.push(record);
    }

    // If any file in this batch was invalid, purge all files uploaded in this batch
    if (validationErrors.length > 0) {
      for (const rec of uploadedResults) {
        fileRegistry.delete(rec.id);
        if (conversationId && conversationDocuments.has(conversationId)) {
          conversationDocuments.get(conversationId)!.delete(rec.id);
        }
        try {
          await fs.promises.unlink(path.join(UPLOAD_DIR, rec.diskFilename));
        } catch (_) {}
      }
      return res.status(400).json({
        error: validationErrors.join(' '),
        code: 'INVALID_FILE_CONTENT'
      });
    }

    // Execute server-side text and structure extraction for each uploaded file
    for (const rec of uploadedResults) {
      try {
        const fullDiskPath = path.join(UPLOAD_DIR, rec.diskFilename);
        const ext = path.extname(rec.diskFilename);
        const extraction = (await extractDocumentContent(
          fullDiskPath,
          rec.originalName,
          ext,
          rec.mimeType,
          rec.id
        )) as DocumentExtractionResult;
        rec.extraction = extraction;
        rec.status = extraction.success || extraction.status === 'scanned_or_image_only' ? 'ready' : 'uploaded';
      } catch (err: any) {
        console.warn(`[Document Extraction] Extraction error for ${rec.originalName}:`, err);
      }
    }

    // Return structured metadata without exposing server-internal storage paths
    return res.status(200).json({
      success: true,
      count: uploadedResults.length,
      attachments: uploadedResults.map((r) => ({
        id: r.id,
        originalName: r.originalName,
        name: r.originalName,
        extension: r.extension,
        mimeType: r.mimeType,
        type: r.mimeType,
        size: r.size,
        formattedSize: r.formattedSize,
        status: r.status,
        uploadedAt: r.uploadedAt,
        extraction: r.extraction || undefined
      }))
    });
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
      stream = true,
      conversationId = null,
      attachments = []
    } = req.body as {
      provider?: string;
      mode?: string;
      prompt?: string;
      history?: Array<{ sender?: string; content?: string; attachments?: any[] }>;
      username?: string | null;
      preferences?: UserPreferences | null;
      stream?: boolean;
      conversationId?: string | null;
      attachments?: any[];
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

    // Associate attachments sent in this turn with the conversation
    if (conversationId && Array.isArray(attachments)) {
      let docSet = conversationDocuments.get(conversationId);
      if (!docSet) {
        docSet = new Set<string>();
        conversationDocuments.set(conversationId, docSet);
      }
      for (const att of attachments) {
        if (att?.id) {
          docSet.add(att.id);
          const existing = fileRegistry.get(att.id);
          if (existing) {
            existing.conversationId = conversationId;
          } else if (att.extraction) {
            fileRegistry.set(att.id, {
              id: att.id,
              originalName: att.originalName || att.name || 'document',
              diskFilename: att.id,
              mimeType: att.type || att.mimeType || 'application/octet-stream',
              extension: att.extension || '',
              size: att.size || 0,
              formattedSize: att.formattedSize || '',
              status: att.status || 'ready',
              uploadedAt: att.uploadedAt || new Date().toISOString(),
              expiresAt: Date.now() + TEMP_FILE_TTL_MS,
              conversationId,
              extraction: att.extraction
            });
          }
        }
      }
    }

    // Collect available documents for this specific conversation (Requirement 3: strict conversation isolation)
    const availableDocs: DocumentData[] = [];
    const seenDocIds = new Set<string>();

    const addDocIfValid = (docData: DocumentData, fromConvId?: string) => {
      // Never use a document associated with a different conversation!
      if (fromConvId && conversationId && fromConvId !== conversationId) {
        return;
      }
      const docKey = docData.fileId || docData.id || docData.originalName || docData.filename;
      if (docKey && !seenDocIds.has(docKey)) {
        seenDocIds.add(docKey);
        availableDocs.push(docData);
      }
    };

    // 1. Current turn attachments
    if (Array.isArray(attachments)) {
      for (const att of attachments) {
        if (!att?.id) continue;
        const record = fileRegistry.get(att.id);
        if (record?.extraction) {
          addDocIfValid(record.extraction as DocumentData, record.conversationId);
        } else if (att.extraction) {
          addDocIfValid(att.extraction as DocumentData, conversationId || undefined);
        }
      }
    }

    // 2. Attachments in history of this conversation
    if (Array.isArray(history)) {
      for (const hMsg of history) {
        if (Array.isArray(hMsg?.attachments)) {
          for (const hAtt of hMsg.attachments) {
            if (!hAtt?.id) continue;
            const record = fileRegistry.get(hAtt.id);
            if (record?.extraction) {
              addDocIfValid(record.extraction as DocumentData, record.conversationId || conversationId || undefined);
            } else if (hAtt.extraction) {
              addDocIfValid(hAtt.extraction as DocumentData, conversationId || undefined);
            }
          }
        }
      }
    }

    // 3. Conversation-registered files for this conversation
    if (conversationId && conversationDocuments.has(conversationId)) {
      const convSet = conversationDocuments.get(conversationId)!;
      for (const fileId of convSet) {
        const record = fileRegistry.get(fileId);
        if (record?.extraction) {
          addDocIfValid(record.extraction as DocumentData, record.conversationId || conversationId);
        }
      }
    }

    // Prepare document context for the prompt
    const prepDoc: PreparedDocumentContext = prepareDocumentContext(prompt, availableDocs) as PreparedDocumentContext;
    const normalizedProvider = String(provider).toLowerCase();
    const shouldStream = stream !== false;

    // If an immediate direct answer is determined (e.g. unreadable scanned file, empty doc, page out of bounds)
    if (prepDoc.directAnswer) {
      if (!shouldStream) {
        return res.json({
          text: prepDoc.directAnswer,
          modelUsed: 'Document Analyzer',
          provider: normalizedProvider
        });
      }
      initSSE(res);
      sendSSE(res, { type: 'start', modelUsed: 'Document Analyzer', provider: normalizedProvider });
      sendSSE(res, { type: 'chunk', text: prepDoc.directAnswer });
      sendSSE(res, { type: 'done', text: prepDoc.directAnswer, modelUsed: 'Document Analyzer', provider: normalizedProvider });
      res.end();
      return;
    }

    const cleanUsername =
      typeof username === 'string' && username.trim()
        ? username.trim().slice(0, 50).replace(/[\r\n\t]/g, ' ')
        : null;

    const baseSystemInstruction = buildSystemInstruction(cleanUsername, preferences, mode);

    // Shared Provider-Independent Document Context Adaptation (Requirements 2, 3, 5, 7, 8)
    const adapted: any = adaptDocumentContextForProvider({
      provider: normalizedProvider,
      prompt,
      baseSystemInstruction,
      preparedContext: prepDoc
    });

    const effectiveSystemInstruction = adapted.effectiveSystemInstruction;
    const effectivePrompt = adapted.effectivePrompt;

    // 1. Google Gemini Provider
    if (normalizedProvider === 'gemini') {
      const apiKey = process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY;

      // If no API key is configured, return simulated response (with progressive reveal if streaming)
      if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
        const text = availableDocs.length > 0
          ? generateSimulatedDocumentResponse(prompt, prepDoc)
          : generateSimulatedResponse(prompt, cleanUsername, preferences, mode);
        const demoModel = availableDocs.length > 0 ? 'Document Analyzer (demo)' : 'gemini-3.1-flash-lite (demo)';
        if (!shouldStream) {
          return res.json({
            text,
            modelUsed: demoModel,
            provider: 'gemini'
          });
        }
        initSSE(res);
        sendSSE(res, { type: 'start', modelUsed: demoModel, provider: 'gemini' });
        const tokens = text.split(/(\s+)/);
        for (const token of tokens) {
          if (isClientClosed || res.writableEnded) break;
          sendSSE(res, { type: 'chunk', text: token });
          await new Promise((r) => setTimeout(r, 15));
        }
        if (!res.writableEnded) {
          sendSSE(res, { type: 'done', text, modelUsed: demoModel, provider: 'gemini' });
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

      const contents = formatGeminiHistory(history, effectivePrompt);
      // Attempt sequence: max 3 attempts total (initial attempt + up to 2 retries)
      // Attempt 1 tries gemini-3.8-flash (primary recommended model)
      // Attempt 2 tries gemini-3-flash-preview (fast reliable fallback preview model)
      // Attempt 3 tries gemini-3.1-flash-lite (alternative lite model)
      const attemptPlan = [
        { model: 'gemini-3.8-flash', attemptNum: 1 },
        { model: 'gemini-3-flash-preview', attemptNum: 2 },
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
                systemInstruction: effectiveSystemInstruction
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
                systemInstruction: effectiveSystemInstruction
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
        const text = availableDocs.length > 0
          ? generateSimulatedDocumentResponse(prompt, prepDoc)
          : generateSimulatedResponse(prompt, cleanUsername, preferences, mode);
        const demoModel = availableDocs.length > 0 ? 'Document Analyzer (demo)' : 'Llama 3.3 70B (demo)';
        if (!shouldStream) {
          return res.json({
            text,
            modelUsed: demoModel,
            provider: 'groq'
          });
        }
        initSSE(res);
        sendSSE(res, { type: 'start', modelUsed: demoModel, provider: 'groq' });
        const tokens = text.split(/(\s+)/);
        for (const token of tokens) {
          if (isClientClosed || res.writableEnded) break;
          sendSSE(res, { type: 'chunk', text: token });
          await new Promise((r) => setTimeout(r, 15));
        }
        if (!res.writableEnded) {
          sendSSE(res, { type: 'done', text, modelUsed: demoModel, provider: 'groq' });
          res.end();
        }
        return;
      }

      const messages = formatOpenAIMessages({
        systemInstruction: effectiveSystemInstruction,
        history,
        prompt: effectivePrompt
      });

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
          let friendlyError = `Groq request failed (${groqRes.status}): ${errText}`;
          if (errText.includes('context_length_exceeded') || errText.includes('maximum context length') || errText.includes('tokens')) {
            friendlyError = 'The attached document exceeds Groq\'s context length limit. Please switch to Google Gemini (which supports 1M tokens) or ask about specific pages or slides.';
          }
          return res.status(groqRes.status).json({
            error: friendlyError,
            code: groqRes.status,
            provider: 'groq',
            model: 'openai/gpt-oss-120b',
            canFallback: true,
            suggestedProviders: ['gemini', 'openrouter']
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
          let friendlyError = `Groq request failed (${groqRes.status}): ${errText}`;
          if (errText.includes('context_length_exceeded') || errText.includes('maximum context length') || errText.includes('tokens')) {
            friendlyError = 'The attached document exceeds Groq\'s context length limit. Please switch to Google Gemini (which supports 1M tokens) or ask about specific pages or slides.';
          }
          return res.status(groqRes.status).json({
            error: friendlyError,
            code: groqRes.status,
            provider: 'groq',
            model: 'openai/gpt-oss-120b',
            canFallback: true,
            suggestedProviders: ['gemini', 'openrouter']
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
        const text = availableDocs.length > 0
          ? generateSimulatedDocumentResponse(prompt, prepDoc)
          : generateSimulatedResponse(prompt, cleanUsername, preferences, mode);
        const demoModel = availableDocs.length > 0 ? 'Document Analyzer (demo)' : 'openrouter/free (demo)';
        if (!shouldStream) {
          return res.json({
            text,
            modelUsed: demoModel,
            provider: 'openrouter'
          });
        }
        initSSE(res);
        sendSSE(res, { type: 'start', modelUsed: demoModel, provider: 'openrouter' });
        const tokens = text.split(/(\s+)/);
        for (const token of tokens) {
          if (isClientClosed || res.writableEnded) break;
          sendSSE(res, { type: 'chunk', text: token });
          await new Promise((r) => setTimeout(r, 15));
        }
        if (!res.writableEnded) {
          sendSSE(res, { type: 'done', text, modelUsed: demoModel, provider: 'openrouter' });
          res.end();
        }
        return;
      }

      const messages = formatOpenAIMessages({
        systemInstruction: effectiveSystemInstruction,
        history,
        prompt: effectivePrompt
      });

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
          let friendlyError = `OpenRouter request failed (${orRes.status}): ${errText}`;
          if (errText.includes('context_length_exceeded') || errText.includes('maximum context length') || errText.includes('too large') || errText.includes('tokens')) {
            friendlyError = 'The attached document exceeds OpenRouter\'s context limit. Please switch to Google Gemini (which supports 1M tokens) or ask about specific pages or slides.';
          }
          return res.status(orRes.status).json({
            error: friendlyError,
            code: orRes.status,
            provider: 'openrouter',
            model: 'openrouter/free',
            canFallback: true,
            suggestedProviders: ['gemini', 'groq']
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
          let friendlyError = `OpenRouter request failed (${orRes.status}): ${errText}`;
          if (errText.includes('context_length_exceeded') || errText.includes('maximum context length') || errText.includes('too large') || errText.includes('tokens')) {
            friendlyError = 'The attached document exceeds OpenRouter\'s context limit. Please switch to Google Gemini (which supports 1M tokens) or ask about specific pages or slides.';
          }
          return res.status(orRes.status).json({
            error: friendlyError,
            code: orRes.status,
            provider: 'openrouter',
            model: 'openrouter/free',
            canFallback: true,
            suggestedProviders: ['gemini', 'groq']
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

    // 4. Cloudflare Workers AI Provider (@cf/meta/llama-3.1-8b-instruct)
    if (normalizedProvider === 'cloudflare') {
      const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
      const apiToken = process.env.CLOUDFLARE_API_TOKEN;
      const modelId = '@cf/meta/llama-3.1-8b-instruct';
      const displayModel = 'Cloudflare Workers AI — Llama 3.1 8B';

      // If credentials are not configured, return simulated response
      if (
        !accountId ||
        !apiToken ||
        accountId === 'YOUR_CLOUDFLARE_ACCOUNT_ID' ||
        apiToken === 'YOUR_CLOUDFLARE_API_TOKEN'
      ) {
        const text = availableDocs.length > 0
          ? generateSimulatedDocumentResponse(prompt, prepDoc)
          : generateSimulatedResponse(prompt, cleanUsername, preferences, mode);
        const demoModel = availableDocs.length > 0 ? 'Document Analyzer (demo)' : 'Cloudflare Workers AI — Llama 3.1 8B (demo)';
        if (!shouldStream) {
          return res.json({
            text,
            modelUsed: demoModel,
            provider: 'cloudflare'
          });
        }
        initSSE(res);
        sendSSE(res, { type: 'start', modelUsed: demoModel, provider: 'cloudflare' });
        const tokens = text.split(/(\s+)/);
        for (const token of tokens) {
          if (isClientClosed || res.writableEnded) break;
          sendSSE(res, { type: 'chunk', text: token });
          await new Promise((r) => setTimeout(r, 15));
        }
        if (!res.writableEnded) {
          sendSSE(res, { type: 'done', text, modelUsed: demoModel, provider: 'cloudflare' });
          res.end();
        }
        return;
      }

      const messages = formatOpenAIMessages({
        systemInstruction: effectiveSystemInstruction,
        history,
        prompt: effectivePrompt
      });

      const cfEndpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId.trim())}/ai/run/${modelId}`;

      if (!shouldStream) {
        const cfRes = await fetch(cfEndpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiToken.trim()}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            messages,
            stream: false
          })
        });

        if (!cfRes.ok) {
          let errDetail = '';
          try {
            const errJson = await cfRes.json();
            if (Array.isArray(errJson?.errors) && errJson.errors.length > 0) {
              errDetail = errJson.errors.map((e: any) => e.message || JSON.stringify(e)).join('; ');
            } else if (errJson?.error) {
              errDetail = typeof errJson.error === 'string' ? errJson.error : errJson.error.message;
            }
          } catch (_) {
            errDetail = await cfRes.text();
          }

          let friendlyError = `Cloudflare Workers AI request failed (${cfRes.status}): ${errDetail || cfRes.statusText}`;
          if (cfRes.status === 401 || cfRes.status === 403) {
            friendlyError = 'Invalid or unauthorized Cloudflare API token. Please verify CLOUDFLARE_API_TOKEN.';
          } else if (cfRes.status === 404) {
            friendlyError = 'Cloudflare account or model not found. Please verify CLOUDFLARE_ACCOUNT_ID and model availability.';
          } else if (cfRes.status === 429) {
            friendlyError = 'Cloudflare Workers AI rate limit exceeded. Please wait a moment before trying again.';
          } else if (cfRes.status === 500 || cfRes.status === 503 || cfRes.status === 504) {
            friendlyError = 'Cloudflare Workers AI service is temporarily unavailable. Please retry shortly.';
          }

          return res.status(cfRes.status).json({
            error: friendlyError,
            code: cfRes.status,
            provider: 'cloudflare',
            model: modelId,
            retryable: cfRes.status === 429 || cfRes.status === 503,
            canFallback: true,
            suggestedProviders: ['gemini', 'groq', 'openrouter']
          });
        }

        const data = await cfRes.json();
        const text = data?.result?.response || (typeof data?.result === 'string' ? data.result : '') || '';
        return res.json({
          text,
          modelUsed: displayModel,
          provider: 'cloudflare'
        });
      } else {
        // Genuine streaming via Cloudflare Workers AI SSE
        const cfRes = await fetch(cfEndpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiToken.trim()}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            messages,
            stream: true
          })
        });

        if (!cfRes.ok) {
          let errDetail = '';
          try {
            const errJson = await cfRes.json();
            if (Array.isArray(errJson?.errors) && errJson.errors.length > 0) {
              errDetail = errJson.errors.map((e: any) => e.message || JSON.stringify(e)).join('; ');
            } else if (errJson?.error) {
              errDetail = typeof errJson.error === 'string' ? errJson.error : errJson.error.message;
            }
          } catch (_) {
            errDetail = await cfRes.text();
          }

          let friendlyError = `Cloudflare Workers AI request failed (${cfRes.status}): ${errDetail || cfRes.statusText}`;
          if (cfRes.status === 401 || cfRes.status === 403) {
            friendlyError = 'Invalid or unauthorized Cloudflare API token. Please verify CLOUDFLARE_API_TOKEN.';
          } else if (cfRes.status === 404) {
            friendlyError = 'Cloudflare account or model not found. Please verify CLOUDFLARE_ACCOUNT_ID and model availability.';
          } else if (cfRes.status === 429) {
            friendlyError = 'Cloudflare Workers AI rate limit exceeded. Please wait a moment before trying again.';
          } else if (cfRes.status === 500 || cfRes.status === 503 || cfRes.status === 504) {
            friendlyError = 'Cloudflare Workers AI service is temporarily unavailable. Please retry shortly.';
          }

          return res.status(cfRes.status).json({
            error: friendlyError,
            code: cfRes.status,
            provider: 'cloudflare',
            model: modelId,
            retryable: cfRes.status === 429 || cfRes.status === 503,
            canFallback: true,
            suggestedProviders: ['gemini', 'groq', 'openrouter']
          });
        }

        const contentType = cfRes.headers.get('content-type') || '';

        // If Cloudflare returns non-streaming JSON (or body is missing) despite stream: true, adapt it gracefully to SSE
        if (contentType.includes('application/json') || !cfRes.body) {
          const data = await cfRes.json();
          const fullText = data?.result?.response || (typeof data?.result === 'string' ? data.result : '') || '';
          initSSE(res);
          sendSSE(res, { type: 'start', modelUsed: displayModel, provider: 'cloudflare' });
          if (fullText) {
            sendSSE(res, { type: 'chunk', text: fullText });
          }
          sendSSE(res, { type: 'done', text: fullText, modelUsed: displayModel, provider: 'cloudflare' });
          res.end();
          return;
        }

        initSSE(res);
        sendSSE(res, { type: 'start', modelUsed: displayModel, provider: 'cloudflare' });

        const reader = cfRes.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let fullText = '';

        while (true) {
          if (isClientClosed || res.writableEnded) {
            try {
              await reader.cancel();
            } catch (_) {}
            break;
          }

          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data: ')) continue;
            const dataStr = trimmed.slice(6).trim();
            if (dataStr === '[DONE]') continue;

            try {
              const parsed = JSON.parse(dataStr);
              const delta = parsed?.response ?? parsed?.choices?.[0]?.delta?.content ?? '';
              if (delta) {
                fullText += delta;
                sendSSE(res, { type: 'chunk', text: delta });
              }
            } catch (_) {}
          }
        }

        // Process any trailing line in buffer
        if (buffer && buffer.trim().startsWith('data: ')) {
          const dataStr = buffer.trim().slice(6).trim();
          if (dataStr !== '[DONE]') {
            try {
              const parsed = JSON.parse(dataStr);
              const delta = parsed?.response ?? parsed?.choices?.[0]?.delta?.content ?? '';
              if (delta) {
                fullText += delta;
                sendSSE(res, { type: 'chunk', text: delta });
              }
            } catch (_) {}
          }
        }

        if (!res.writableEnded) {
          sendSSE(res, { type: 'done', text: fullText, modelUsed: displayModel, provider: 'cloudflare' });
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
        suggestedProviders: ['gemini', 'groq', 'openrouter', 'cloudflare']
      });
      if (!res.writableEnded) res.end();
    } else {
      res.status(parsed.statusCode).json({
        error: parsed.message,
        code: parsed.statusCode,
        status: parsed.status,
        retryable: parsed.isRetryable,
        canFallback: true,
        suggestedProviders: ['gemini', 'groq', 'openrouter', 'cloudflare']
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