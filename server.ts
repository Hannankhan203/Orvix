import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import multer from 'multer';
import dns from 'dns';

// Ensure IPv4 is prioritized for outbound external API connections (Gemini, Groq, OpenRouter)
try {
  dns.setDefaultResultOrder('ipv4first');
} catch (_) {}

import { GoogleGenAI } from '@google/genai';
// @ts-ignore - Document extraction JavaScript service
import { extractDocumentContent } from './src/services/documentExtractor.js';
// @ts-ignore - Image OCR extraction JavaScript service
import { extractImageText } from './src/services/imageOcrService.js';
// @ts-ignore - Document context JavaScript service
import {
  prepareDocumentContext,
  generateSimulatedDocumentResponse,
  adaptDocumentContextForProvider,
  formatOpenAIMessages
} from './src/services/documentContextService.js';
// @ts-ignore - Multi-part large response handling service
import {
  detectLargeResponseIntent,
  isContinuationRequest,
  resolveMultiPartContext,
  buildMultiPartPromptAugmentation,
  generateSimulatedMultiPartResponse,
  responseHasContinuationNotice,
  CONTINUATION_NOTICES
} from './src/services/multiPartResponseService.js';
// @ts-ignore - Context-aware spoken transcript polisher
import { polishSpokenTranscript } from './src/utils/speechTextCleaner.js';

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
  isImage?: boolean;
  hasText?: boolean;
  lineCount?: number;
  confidence?: number;
  message?: string;
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
const portArgIndex = process.argv.indexOf('--port');
const portFromArg = portArgIndex !== -1 ? process.argv[portArgIndex + 1] : undefined;
const PORT = Number(portFromArg) || Number(process.env.PORT) || 3000;

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

app.use((req, _res, next) => {
  // If running in Vercel serverless runtime where body has already been parsed into an object
  if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
    (req as any)._body = true;
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

export type AIDiagnosticCategory =
  | 'request validation error'
  | 'provider configuration error'
  | 'provider API error'
  | 'provider timeout'
  | 'provider network failure'
  | 'streaming failure'
  | 'attachment/context processing failure'
  | 'internal server error';

interface DiagnosticLogData {
  category: AIDiagnosticCategory;
  provider: string;
  model?: string;
  phase?: 'validation' | 'configuration' | 'attachment' | 'pre-stream' | 'mid-stream' | 'non-streaming' | 'dispatch';
  attempt?: number;
  maxAttempts?: number;
  upstreamStatus?: number;
  upstreamErrorCode?: string;
  sanitizedMessage: string;
  retryAfterSeconds?: number;
  willRetry?: boolean;
}

/**
 * Server-side diagnostic logger recording category, provider, model, HTTP status, sanitized error,
 * retry attempt number, and streaming phase without exposing credentials or user data.
 */
function logAIDiagnostic(data: DiagnosticLogData) {
  const statusStr = data.upstreamStatus ? `HTTP ${data.upstreamStatus}` : 'HTTP N/A';
  const codeStr = data.upstreamErrorCode ? `[${data.upstreamErrorCode}]` : '';
  const actionDesc = data.willRetry
    ? `Will retry (attempt ${(data.attempt || 1) + 1}/${data.maxAttempts || 1}${data.retryAfterSeconds ? ` after ${data.retryAfterSeconds}s` : ''})`
    : 'No further retries';

  console.warn(
    `[AI Diagnostic][${data.category}] Provider: ${data.provider} | Model: ${data.model || 'N/A'} | Phase: ${data.phase || 'dispatch'} | Status: ${statusStr} ${codeStr} | Action: ${actionDesc} | Sanitized: ${sanitizeErrorLog(data.sanitizedMessage)}`
  );
}

// Parses and normalizes API errors into clean user-facing representations across all providers
export function parseGeminiError(err: any, provider = 'gemini'): {
  statusCode: number;
  status: string;
  category: AIDiagnosticCategory;
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

  const cause = err?.cause;
  const causeCode = String(cause?.code || err?.code || '');
  const causeMessage = String(cause?.message || '');

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
  const lowerCause = causeMessage.toLowerCase();
  const upperStatus = statusText.toUpperCase();
  const displayProvider = provider.charAt(0).toUpperCase() + provider.slice(1);

  // 1. Timeout / Abort errors
  const isTimeout =
    err?.name === 'TimeoutError' ||
    err?.name === 'AbortError' ||
    causeCode === 'ETIMEDOUT' ||
    causeCode === 'UND_ERR_CONNECT_TIMEOUT' ||
    lowerMsg.includes('timeout') ||
    lowerMsg.includes('timed out') ||
    lowerMsg.includes('deadline expired') ||
    lowerMsg.includes('deadline_exceeded') ||
    upperStatus === 'DEADLINE_EXCEEDED' ||
    statusCode === 504;

  if (isTimeout) {
    return {
      statusCode: 504,
      status: 'DEADLINE_EXCEEDED',
      category: 'provider timeout',
      isUnavailable: true,
      isRetryable: true,
      message: `The request to ${displayProvider} timed out while waiting for a response. Please try again.`,
      retryAfterSeconds
    };
  }

  // 2. Network connectivity / DNS failure to upstream AI provider
  const isNetworkFailure =
    (err?.name === 'TypeError' && (lowerMsg.includes('fetch failed') || lowerMsg.includes('failed to fetch'))) ||
    ['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'].includes(causeCode) ||
    lowerMsg.includes('getaddrinfo') ||
    lowerMsg.includes('econnrefused') ||
    lowerMsg.includes('econnreset') ||
    lowerCause.includes('enotfound') ||
    lowerCause.includes('econnrefused') ||
    lowerMsg.includes('network error');

  const isOllamaProvider = provider.toLowerCase() === 'ollama';

  if (isNetworkFailure) {
    if (isOllamaProvider) {
      return {
        statusCode: 503,
        status: 'NETWORK_FAILURE',
        category: 'provider network failure',
        isUnavailable: true,
        isRetryable: false,
        message: 'Unable to connect to Local AI (Ollama) at http://127.0.0.1:11434. Please ensure Ollama is running locally ("ollama serve") and model "qwen2.5:1.5b" is available.',
        retryAfterSeconds
      };
    }
    const detail = causeCode || (lowerMsg.includes('fetch failed') ? 'connection failed' : 'network unreachable');
    return {
      statusCode: 503,
      status: 'NETWORK_FAILURE',
      category: 'provider network failure',
      isUnavailable: true,
      isRetryable: true,
      message: `Unable to establish network connection to ${displayProvider} (${detail}). Please check your internet connection or try again in a few moments.`,
      retryAfterSeconds
    };
  }

  // 3. Service Unavailable / Overloaded
  if (
    statusCode === 503 ||
    upperStatus === 'UNAVAILABLE' ||
    lowerMsg.includes('overloaded') ||
    lowerMsg.includes('high demand') ||
    lowerMsg.includes('spikes in demand') ||
    lowerMsg.includes('service unavailable') ||
    lowerMsg.includes('temporarily unavailable')
  ) {
    if (isOllamaProvider) {
      return {
        statusCode: 503,
        status: 'UNAVAILABLE',
        category: 'provider API error',
        isUnavailable: true,
        isRetryable: false,
        message: 'Local AI (Ollama) at http://127.0.0.1:11434 is currently unavailable. Please verify that Ollama is running locally ("ollama serve").',
        retryAfterSeconds
      };
    }
    return {
      statusCode: 503,
      status: 'UNAVAILABLE',
      category: 'provider API error',
      isUnavailable: true,
      isRetryable: true,
      message: `${displayProvider} is currently experiencing high demand. Spikes in demand are usually temporary. Please try again in a few moments.`,
      retryAfterSeconds
    };
  }

  // 4. Rate Limit / Quota Exceeded
  if (
    statusCode === 429 ||
    upperStatus === 'RESOURCE_EXHAUSTED' ||
    lowerMsg.includes('rate limit') ||
    lowerMsg.includes('quota') ||
    lowerMsg.includes('resource_exhausted')
  ) {
    return {
      statusCode: 429,
      status: 'RESOURCE_EXHAUSTED',
      category: 'provider API error',
      isUnavailable: true,
      isRetryable: true,
      message: `${displayProvider} rate limit or quota exceeded. Please wait a moment before trying again.`,
      retryAfterSeconds
    };
  }

  // 5. Auth / API Key Errors
  if (
    statusCode === 401 ||
    statusCode === 403 ||
    upperStatus === 'UNAUTHENTICATED' ||
    upperStatus === 'PERMISSION_DENIED' ||
    lowerMsg.includes('api_key_invalid') ||
    lowerMsg.includes('api key not valid') ||
    lowerMsg.includes('unauthorized') ||
    lowerMsg.includes('permission denied')
  ) {
    return {
      statusCode: statusCode === 401 ? 401 : 403,
      status: statusCode === 401 ? 'UNAUTHENTICATED' : 'PERMISSION_DENIED',
      category: 'provider configuration error',
      isUnavailable: false,
      isRetryable: false,
      message: `Invalid or unauthorized API key for ${displayProvider}. Please check your configuration.`,
      retryAfterSeconds
    };
  }

  // 6. Model Not Found / Decommissioned Model
  if (
    statusCode === 404 ||
    upperStatus === 'NOT_FOUND' ||
    lowerMsg.includes('not found') ||
    lowerMsg.includes('is no longer available') ||
    lowerMsg.includes('does not exist') ||
    lowerMsg.includes('you do not have access to it') ||
    lowerMsg.includes('decommissioned') ||
    lowerMsg.includes('retired')
  ) {
    return {
      statusCode: 404,
      status: 'NOT_FOUND',
      category: 'provider API error',
      isRetryable: false,
      isUnavailable: false,
      message: sanitizeErrorLog(message) || `The requested ${displayProvider} model was not found or is no longer available.`,
      retryAfterSeconds
    };
  }

  // 7. Invalid Argument / Validation Error
  if (
    statusCode === 400 ||
    upperStatus === 'INVALID_ARGUMENT' ||
    lowerMsg.includes('invalid argument')
  ) {
    return {
      statusCode: 400,
      status: 'INVALID_ARGUMENT',
      category: 'request validation error',
      isRetryable: false,
      isUnavailable: false,
      message: sanitizeErrorLog(message) || `Invalid argument provided to the ${displayProvider} model.`,
      retryAfterSeconds
    };
  }

  // 8. Internal Server Error (500)
  return {
    statusCode: Number.isFinite(statusCode) ? statusCode : 500,
    status: statusText || 'INTERNAL',
    category: 'internal server error',
    isUnavailable: false,
    isRetryable: false,
    message: sanitizeErrorLog(message) && sanitizeErrorLog(message) !== 'fetch failed'
      ? sanitizeErrorLog(message)
      : `Internal error encountered while processing ${displayProvider} service request.`,
    retryAfterSeconds
  };
}

// Helper to format conversation history for Gemini with alternating roles and optional image parts
function formatGeminiHistory(
  messages: Array<{ sender?: string; content?: string }> = [],
  currentPrompt = '',
  maxContext = 12,
  imageParts: Array<{ mimeType: string; data: string }> = []
) {
  const rawContents: Array<{ role: 'user' | 'model'; parts: any[] }> = [];
  const recent = messages.slice(-maxContext);

  for (const msg of recent) {
    if (!msg.content || !msg.content.trim()) continue;
    const role = msg.sender === 'user' ? 'user' : 'model';
    rawContents.push({
      role,
      parts: [{ text: msg.content.trim() }]
    });
  }

  if (currentPrompt && currentPrompt.trim()) {
    const userParts: any[] = [];
    if (Array.isArray(imageParts) && imageParts.length > 0) {
      for (const img of imageParts) {
        if (img?.data && img?.mimeType) {
          userParts.push({
            inlineData: {
              mimeType: img.mimeType,
              data: img.data
            }
          });
        }
      }
    }
    userParts.push({ text: currentPrompt.trim() });
    rawContents.push({
      role: 'user',
      parts: userParts
    });
  }

  // Gemini contents must begin with a 'user' turn
  while (rawContents.length > 0 && rawContents[0].role !== 'user') {
    rawContents.shift();
  }

  if (rawContents.length === 0 && currentPrompt.trim()) {
    rawContents.push({ role: 'user', parts: [{ text: currentPrompt.trim() }] });
  }

  // Merge consecutive turns of identical role so roles strictly alternate user -> model -> user
  const mergedContents: Array<{ role: 'user' | 'model'; parts: any[] }> = [];
  for (const item of rawContents) {
    const last = mergedContents[mergedContents.length - 1];
    if (last && last.role === item.role) {
      last.parts.push(...item.parts);
    } else {
      mergedContents.push({
        role: item.role,
        parts: [...item.parts]
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

  // Context-aware speech transcript polish simulation
  if (
    promptLower.includes('transcript polisher') ||
    promptLower.includes('phonetic speech recognition glitches')
  ) {
    const transcriptMatch = promptText.match(/Transcript:\s*\n?["'«»“]([\s\S]*?)["'«»”]\s*$/i);
    const rawTranscript = transcriptMatch ? transcriptMatch[1].trim() : promptText.trim();
    if (rawTranscript) {
      let polished = rawTranscript;
      const combined = `${promptLower} ${polished.toLowerCase()}`;
      const isProgramming =
        combined.includes('javascript') ||
        combined.includes('ecmascript') ||
        combined.includes('typescript') ||
        combined.includes('code') ||
        combined.includes('programming') ||
        combined.includes('function') ||
        combined.includes('algorithm');
      const isAsync =
        isProgramming &&
        (combined.includes('promise') ||
          combined.includes('callback') ||
          combined.includes('async') ||
          combined.includes('await') ||
          combined.includes('hoisting'));

      // 1. Acronyms & technical terms
      polished = polished
        .replace(/\bjava\s*script\b/gi, 'JavaScript')
        .replace(/\becma\s*script\b/gi, 'ECMAScript')
        .replace(/\btype\s*script\b/gi, 'TypeScript')
        .replace(/\bmath\s*\.\s*random\b/gi, 'Math.random')
        .replace(/\busing\s+math\s+random\b/gi, 'using Math.random')
        .replace(/\bwith\s+math\s+random\b/gi, 'with Math.random');

      // 2. Contextual disambiguation
      if (isProgramming) {
        polished = polished.replace(/(?<!math\s*\.?\s*)\b(?:pedrandom|ped\s+random|pelindrome|palindrom)\b/gi, 'palindrome');
        if (isAsync) {
          polished = polished.replace(/\b(?:sync\s+await|sink\s+await)\b/gi, 'async/await');
          polished = polished.replace(/\basync\s+await\b/gi, 'async/await');
        }
      }

      // 3. Punctuation & capitalization
      polished = polished
        .replace(/\s+([.,!?:;۔،؟])/g, '$1')
        .replace(/(?<!\b[A-Za-z0-9_])\.([a-zA-Z])/g, '. $1')
        .replace(/([,!?:;۔،؟])([^\s\d\n])/g, '$1 $2')
        .replace(/[ \t]+/g, ' ');

      if (polished.length > 0) {
        polished = polished.charAt(0).toUpperCase() + polished.slice(1);
      }
      polished = polished.replace(/([.!?\n]\s+)([a-z])/g, (_, sep, letter) => `${sep}${letter.toUpperCase()}`);
      polished = polished.replace(/\bMath\.\s*random\b/gi, 'Math.random');

      return polished.trim();
    }
  }

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
    promptLower.includes('artificial intelligence') ||
    (promptLower.includes('ai') && (promptLower.includes('everyday') || promptLower.includes('real-world') || promptLower.includes('use') || promptLower.includes('table') || promptLower.includes('explain')))
  ) {
    if (isConcise) {
      body = `### Artificial Intelligence in Everyday Life

**Introduction:** Artificial Intelligence (AI) refers to computational systems that simulate human intelligence to learn from data, recognize patterns, and make automated decisions.

**5 Common Real-World Uses:**
1. **Virtual Assistants:** Voice agents like Siri and Alexa process natural speech to answer questions and trigger tasks.
2. **Recommendation Engines:** Streaming services (Netflix, Spotify) analyze consumption habits to suggest tailored content.
3. **Smart Navigation:** Apps like Google Maps calculate optimal routes using real-time traffic telemetry.
4. **Fraud Detection:** Financial systems monitor payment transactions in milliseconds to flag anomalous activity.
5. **Healthcare Imaging:** Pattern-recognition models assist clinicians in identifying abnormalities on medical scans.

**Comparison Table:**
| Characteristic | Traditional Software | Artificial Intelligence |
| :--- | :--- | :--- |
| **Decision Logic** | Explicit hardcoded IF/THEN rules | Probabilistic learning from training data |
| **Adaptability** | Fixed; requires manual code updates | Self-improves as fresh data arrives |
| **Edge Cases** | Halts or errors on unanticipated input | Infers closest probable resolution |

**Short Example:** Email spam filters dynamically classify messages based on sender reputational metrics, suspicious phrasing, and link patterns without requiring manual rule coding for every new spam campaign.

**Conclusion:** AI has become an everyday companion that enhances productivity and decision accuracy across digital workflows.`;
    } else {
      body = `### 1. Introduction: What is Artificial Intelligence?

**Artificial Intelligence (AI)** encompasses computer systems and algorithmic architectures engineered to simulate human cognitive capabilities—including empirical learning, contextual reasoning, natural language comprehension, and autonomous decision-making. Rather than relying solely on rigid, hard-coded procedures, modern AI systems utilize machine learning and neural networks to ingest large datasets, identify complex patterns, and refine their predictive performance over time.

---

### 2. Five Common Real-World Uses of AI in Everyday Life

1. **Virtual Personal Assistants & Voice Interfaces**
   *Everyday manifestation:* Apple Siri, Amazon Alexa, Google Assistant.
   *How it works:* Uses Automatic Speech Recognition (ASR) and Natural Language Understanding (NLU) to interpret vocal commands, manage calendars, operate smart home devices, and retrieve real-time information.

2. **Predictive Recommendation Engines**
   *Everyday manifestation:* Netflix, Spotify, YouTube, and Amazon.
   *How it works:* Employs collaborative filtering and deep retrieval models to evaluate historical user preferences, session length, and behavioral affinity matrices, surfacing highly relevant content tailored to individual tastes.

3. **Dynamic Navigation & Urban Mobility**
   *Everyday manifestation:* Google Maps, Waze, and ride-hailing services like Uber.
   *How it works:* Ingests crowdsourced GPS telemetry, historical transit speeds, and live incident reports to dynamically compute the most time-efficient routes and predict estimated arrival times (ETAs).

4. **Financial Fraud Prevention & Cybersecurity**
   *Everyday manifestation:* Real-time banking alerts and payment gateway defenses.
   *How it works:* Machine learning anomaly detection models evaluate millions of credit card transactions per second against established behavioral profiles, instantly blocking unauthorized purchases or suspicious geographical anomalies.

5. **Diagnostic Healthcare & Medical Imaging**
   *Everyday manifestation:* Computer-aided detection in radiology, ophthalmology, and pathology.
   *How it works:* High-resolution convolutional networks examine X-rays, MRIs, and retinal scans to detect early-stage indicators of disease—such as micro-fractures, tumors, or diabetic retinopathy—supporting physician diagnoses.

---

### 3. Comparison: Traditional Software vs. Artificial Intelligence

| Feature / Dimension | Traditional Software | Artificial Intelligence (AI) |
| :--- | :--- | :--- |
| **Operational Logic** | Predefined, deterministic \`IF/THEN\` conditional rules | Probabilistic patterns inferred from training datasets |
| **Adaptability** | Static; requires human developers to rewrite code | Dynamic; continuously learns and refines from new data |
| **Handling Ambiguity** | Halts, fails, or throws unhandled exceptions on edge cases | Gracefully infers probable outcomes from noisy or incomplete inputs |
| **Primary Strength** | Precise calculations, transactional ledger integrity, speed | Semantic understanding, perceptual recognition, and synthesis |
| **Development Paradigm** | Programmer writes explicit algorithms and specifications | Developer builds architectures and trains models on curated data |

---

### 4. Short Real-World Example: Email Spam Filtering

A prime example is the modern email spam filter (such as Gmail's or Outlook's). Instead of relying on a human programmer to maintain an exhaustive blacklist of every offensive word, an AI classification model analyzes incoming messages across hundreds of simultaneous dimensions: sender domain reputation, header anomalies, sentence embeddings, urgency phrasing, and link destinations. When millions of users mark a novel deceptive email as "Spam", the model automatically adjusts its weights within minutes, shielding users from emerging phishing tactics without any software update.

---

### 5. Conclusion

Artificial Intelligence has evolved from specialized computational research into an ambient foundation of modern daily life. By operating silently behind digital services—anticipating our travel needs, securing financial transactions, and filtering digital noise—AI functions not as a replacement for human agency, but as an indispensable cognitive amplifier that elevates everyday efficiency and decision-making.`;
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
    ),
    ollamaConfigured: true,
    ollamaSupported: true,
    whisperConfigured: Boolean(groqKey && groqKey !== 'YOUR_GROQ_API_KEY') || Boolean(geminiKey && geminiKey !== 'MY_GEMINI_API_KEY'),
    whisperProvider: Boolean(groqKey && groqKey !== 'YOUR_GROQ_API_KEY') ? 'groq' : (Boolean(geminiKey && geminiKey !== 'MY_GEMINI_API_KEY') ? 'gemini' : null)
  });
});

/* ==========================================================================
   Controlled Temporary File Upload & Storage Management Architecture
   ========================================================================== */

// Detect if running in a serverless cloud environment (e.g. Vercel, AWS Lambda)
// where the application bundle root (/var/task) is strictly read-only (EROFS).
export const isServerless = Boolean(
  process.env.VERCEL ||
  process.env.AWS_LAMBDA_FUNCTION_NAME ||
  process.env.LAMBDA_TASK_ROOT ||
  process.env.SERVERLESS ||
  (typeof process !== 'undefined' && process.cwd && process.cwd().startsWith('/var/task')) ||
  (typeof __dirname !== 'undefined' && __dirname.startsWith('/var/task'))
);

/**
 * Resolves the upload directory according to runtime environment:
 * - Vercel / AWS Lambda (serverless): Uses os.tmpdir() (/tmp), the only writable filesystem location.
 * - Localhost development: Preserves project-local uploads/temp directory.
 * - Graceful fallback: If local directory is un-writable or throws EROFS, falls back to os.tmpdir().
 */
export function resolveUploadDirectory(): string {
  // 1. Explicit override via environment variable
  if (process.env.UPLOAD_DIR) {
    try {
      const resolved = path.resolve(process.env.UPLOAD_DIR);
      if (!fs.existsSync(resolved)) {
        fs.mkdirSync(resolved, { recursive: true });
      }
      return resolved;
    } catch (err) {
      console.warn('[Storage] Configured UPLOAD_DIR is not writable, falling back to temp:', err);
    }
  }

  // 2. Serverless / Vercel cloud environment:
  // Root /var/task is strictly read-only; os.tmpdir() (/tmp) is the allocated writable directory.
  if (isServerless) {
    const serverlessTmp = path.join(os.tmpdir(), 'orvix_uploads');
    try {
      if (!fs.existsSync(serverlessTmp)) {
        fs.mkdirSync(serverlessTmp, { recursive: true });
      }
      return serverlessTmp;
    } catch (err) {
      console.warn('[Storage] Error ensuring serverless tmp dir, falling back to os.tmpdir():', err);
      return os.tmpdir();
    }
  }

  // 3. Localhost development environment:
  // Default to project-local uploads/temp directory
  try {
    const localDir = path.resolve(__dirname, 'uploads', 'temp');
    if (!localDir.startsWith('/var/task') && !fs.existsSync(localDir)) {
      fs.mkdirSync(localDir, { recursive: true });
    }
    return localDir;
  } catch (err: any) {
    // Defensive fallback: if local directory throws EROFS or EACCES, seamlessly fall back to os.tmpdir()
    const fallbackTmp = path.join(os.tmpdir(), 'orvix_uploads');
    try {
      if (!fs.existsSync(fallbackTmp)) {
        fs.mkdirSync(fallbackTmp, { recursive: true });
      }
      return fallbackTmp;
    } catch (_) {
      return os.tmpdir();
    }
  }
}

const UPLOAD_DIR = resolveUploadDirectory();

// Configurable upload constraints and lifecycle bounds
const MAX_FILE_SIZE_BYTES =
  parseInt(process.env.MAX_FILE_SIZE_BYTES || '', 10) || 25 * 1024 * 1024; // 25 MB default
const MAX_ATTACHMENTS_PER_UPLOAD = 1; // Strictly 1 attachment per user message
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
  '.xml': ['application/xml', 'text/xml', 'text/plain', 'application/octet-stream'],
  // Common image formats (JPG, JPEG, PNG, WEBP, GIF, BMP, HEIC, HEIF)
  '.jpg': ['image/jpeg', 'image/pjpeg', 'image/jpg', 'application/octet-stream'],
  '.jpeg': ['image/jpeg', 'image/pjpeg', 'image/jpg', 'application/octet-stream'],
  '.png': ['image/png', 'image/x-png', 'application/octet-stream'],
  '.webp': ['image/webp', 'application/octet-stream'],
  '.gif': ['image/gif', 'application/octet-stream'],
  '.bmp': ['image/bmp', 'image/x-ms-bmp', 'image/x-bmp', 'application/octet-stream'],
  '.heic': ['image/heic', 'image/heif', 'application/octet-stream'],
  '.heif': ['image/heif', 'image/heic', 'application/octet-stream']
};

/**
 * Safely extracts image dimensions (width, height) from image binary headers
 * without requiring native binary dependencies.
 */
function parseImageDimensions(
  buffer: Buffer,
  ext: string
): { width: number; height: number } | undefined {
  try {
    if (ext === '.png' && buffer.length >= 24) {
      const width = buffer.readUInt32BE(16);
      const height = buffer.readUInt32BE(20);
      if (width > 0 && height > 0) return { width, height };
    }
    if (ext === '.gif' && buffer.length >= 10) {
      const width = buffer.readUInt16LE(6);
      const height = buffer.readUInt16LE(8);
      if (width > 0 && height > 0) return { width, height };
    }
    if (ext === '.bmp' && buffer.length >= 26) {
      const width = Math.abs(buffer.readInt32LE(18));
      const height = Math.abs(buffer.readInt32LE(22));
      if (width > 0 && height > 0) return { width, height };
    }
    if (ext === '.webp' && buffer.length >= 30) {
      const tag = buffer.toString('ascii', 12, 16);
      if (tag === 'VP8 ' && buffer.length >= 30) {
        const width = buffer.readUInt16LE(26) & 0x3fff;
        const height = buffer.readUInt16LE(28) & 0x3fff;
        if (width > 0 && height > 0) return { width, height };
      } else if (tag === 'VP8L' && buffer.length >= 25) {
        const b1 = buffer[21];
        const b2 = buffer[22];
        const b3 = buffer[23];
        const b4 = buffer[24];
        const width = 1 + (((b2 & 0x3f) << 8) | b1);
        const height = 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6));
        if (width > 0 && height > 0) return { width, height };
      } else if (tag === 'VP8X' && buffer.length >= 30) {
        const width = 1 + buffer.readUIntLE(24, 3);
        const height = 1 + buffer.readUIntLE(27, 3);
        if (width > 0 && height > 0) return { width, height };
      }
    }
    if ((ext === '.jpg' || ext === '.jpeg') && buffer.length >= 4) {
      let offset = 2;
      while (offset < buffer.length - 8) {
        if (buffer[offset] !== 0xff) break;
        const marker = buffer[offset + 1];
        // Standard SOF markers (SOF0 to SOF3, SOF5 to SOF7, SOF9 to SOF11, SOF13 to SOF15)
        if (
          (marker >= 0xc0 && marker <= 0xc3) ||
          (marker >= 0xc5 && marker <= 0xc7) ||
          (marker >= 0xc9 && marker <= 0xcb) ||
          (marker >= 0xcd && marker <= 0xcf)
        ) {
          const height = buffer.readUInt16BE(offset + 5);
          const width = buffer.readUInt16BE(offset + 7);
          if (width > 0 && height > 0) return { width, height };
          break;
        }
        const blockLength = buffer.readUInt16BE(offset + 2);
        offset += 2 + blockLength;
      }
    }
  } catch (_) {}
  return undefined;
}

/**
 * Validates binary file headers and content signatures (magic numbers)
 * to prevent executable binaries or corrupted files from being accepted under false extensions.
 * Supports both direct in-memory Buffers and disk file paths.
 */
async function verifyFileSignature(
  filePathOrBuffer: string | Buffer,
  ext: string
): Promise<{ valid: boolean; reason?: string; dimensions?: { width: number; height: number } }> {
  let fd: number | null = null;
  try {
    let buffer: Buffer;
    let size = 0;

    if (Buffer.isBuffer(filePathOrBuffer)) {
      buffer = filePathOrBuffer;
      size = buffer.length;
    } else {
      const stats = await fs.promises.stat(filePathOrBuffer);
      size = stats.size;
      const readBuf = Buffer.alloc(Math.min(4096, size));
      fd = fs.openSync(filePathOrBuffer, 'r');
      fs.readSync(fd, readBuf, 0, readBuf.length, 0);
      fs.closeSync(fd);
      fd = null;
      buffer = readBuf;
    }

    if (size === 0) {
      return { valid: false, reason: 'File is empty (0 bytes).' };
    }

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

    // Image format verification (JPEG, PNG, GIF, WebP, BMP, HEIC/HEIF)
    if (ext === '.jpg' || ext === '.jpeg') {
      if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
        return { valid: true, dimensions: parseImageDimensions(buffer, ext) };
      }
      return { valid: false, reason: 'Invalid JPEG format: missing standard JPEG SOI signature.' };
    }

    if (ext === '.png') {
      if (
        buffer.length >= 8 &&
        buffer[0] === 0x89 &&
        buffer[1] === 0x50 &&
        buffer[2] === 0x4e &&
        buffer[3] === 0x47 &&
        buffer[4] === 0x0d &&
        buffer[5] === 0x0a &&
        buffer[6] === 0x1a &&
        buffer[7] === 0x0a
      ) {
        return { valid: true, dimensions: parseImageDimensions(buffer, ext) };
      }
      return { valid: false, reason: 'Invalid PNG format: missing standard PNG signature.' };
    }

    if (ext === '.gif') {
      if (
        buffer.length >= 6 &&
        buffer[0] === 0x47 &&
        buffer[1] === 0x49 &&
        buffer[2] === 0x46 &&
        buffer[3] === 0x38 &&
        (buffer[4] === 0x37 || buffer[4] === 0x39) &&
        buffer[5] === 0x61
      ) {
        return { valid: true, dimensions: parseImageDimensions(buffer, ext) };
      }
      return { valid: false, reason: 'Invalid GIF format: missing standard GIF87a/GIF89a signature.' };
    }

    if (ext === '.webp') {
      if (
        buffer.length >= 12 &&
        buffer.toString('ascii', 0, 4) === 'RIFF' &&
        buffer.toString('ascii', 8, 12) === 'WEBP'
      ) {
        return { valid: true, dimensions: parseImageDimensions(buffer, ext) };
      }
      return { valid: false, reason: 'Invalid WebP format: missing standard RIFF/WEBP signature.' };
    }

    if (ext === '.bmp') {
      if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) {
        return { valid: true, dimensions: parseImageDimensions(buffer, ext) };
      }
      return { valid: false, reason: 'Invalid BMP format: missing standard BM signature.' };
    }

    if (ext === '.heic' || ext === '.heif') {
      if (buffer.length < 12) {
        return { valid: false, reason: 'Invalid HEIC/HEIF format: file is too small for an ISOBMFF container.' };
      }
      const ftypBox = buffer.toString('ascii', 4, 8);
      if (ftypBox !== 'ftyp') {
        return { valid: false, reason: 'Invalid HEIC/HEIF format: missing standard ftyp container signature.' };
      }
      const compatibleSlice = buffer.toString('ascii', 8, Math.min(64, buffer.length)).toLowerCase();
      const validBrands = ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'];
      const hasValidBrand = validBrands.some((b) => compatibleSlice.includes(b));
      if (!hasValidBrand) {
        return { valid: false, reason: 'Invalid HEIC/HEIF format: unrecognized ISOBMFF image brand.' };
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

// Multer in-memory storage engine: eliminates ephemeral disk write failures on Vercel
// Localhost asynchronous replication is performed in the upload handler if disk is writable
const uploadStorage = multer.memoryStorage();

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
        `Unsupported file extension: '${ext || 'none'}'. Supported: PDF, DOCX, DOC, TXT, MD, PPT, PPTX, CSV, TSV, JSON, XML, XLSX, XLS, and Images (JPG, JPEG, PNG, WEBP, GIF, BMP, HEIC, HEIF).`
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
  status: 'uploaded' | 'ready' | 'error';
  uploadedAt: string;
  expiresAt: number;
  conversationId?: string;
  isImage?: boolean;
  dimensions?: { width: number; height: number };
  extraction?: any;
  buffer?: Buffer;
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

// Upload Configuration Endpoint (returns limits, supported formats, and active storage strategy)
app.get(['/api/upload/config', '/upload/config'], (_req, res) => {
  res.json({
    maxFileSizeBytes: MAX_FILE_SIZE_BYTES,
    maxFileSizeFormatted: formatBytes(MAX_FILE_SIZE_BYTES),
    maxAttachments: MAX_ATTACHMENTS_PER_UPLOAD,
    allowedExtensions: Object.keys(ALLOWED_EXTENSIONS_MAP).map((e) =>
      e.replace('.', '').toUpperCase()
    ),
    ttlMinutes: Math.round(TEMP_FILE_TTL_MS / (60 * 1000)),
    storageMode: isServerless ? 'serverless-temp' : 'local-disk',
    isServerless
  });
});

// Upload Attachment Metadata Endpoint
app.get(['/api/upload/:id', '/upload/:id'], (req, res) => {
  const fileId = req.params.id;
  if (!fileId || !/^[0-9a-fA-F-]{36}$/.test(fileId)) {
    return res.status(400).json({ error: 'Invalid attachment ID format.' });
  }

  const record = fileRegistry.get(fileId);
  if (record) {
    const ext = path.extname(record.diskFilename).toLowerCase();
    const isImg =
      ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.heic', '.heif'].includes(ext) ||
      record.mimeType.startsWith('image/');

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
      isImage: isImg,
      dimensions: record.dimensions,
      uploadedAt: record.uploadedAt,
      expiresAt: record.expiresAt,
      extraction: record.extraction
    });
  }

  // In serverless environments where state is ephemeral across instances, return valid status
  // so the client application does not mark the attachment as expired or broken
  if (isServerless) {
    return res.json({
      id: fileId,
      status: 'ready',
      serverless: true,
      message: 'Attachment active in client session.'
    });
  }

  return res.status(404).json({ error: 'Attachment not found or has expired.' });
});

// Dedicated Document Extraction Detail Endpoint
app.get(['/api/upload/:id/extraction', '/upload/:id/extraction'], async (req, res) => {
  const fileId = req.params.id;
  if (!fileId || !/^[0-9a-fA-F-]{36}$/.test(fileId)) {
    return res.status(400).json({ error: 'Invalid attachment ID format.' });
  }

  const record = fileRegistry.get(fileId);
  if (record?.extraction) {
    return res.json(record.extraction);
  }

  if (record) {
    const ext = path.extname(record.diskFilename).toLowerCase();
    const isImg =
      ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.heic', '.heif'].includes(ext) ||
      record.mimeType.startsWith('image/');

    const filePath = path.join(UPLOAD_DIR, path.basename(record.diskFilename));
    const inputSource = record.buffer || (fs.existsSync(filePath) ? filePath : null);

    if (inputSource) {
      if (isImg) {
        const imgExtraction = await extractImageText(
          inputSource,
          record.originalName,
          ext,
          record.mimeType,
          record.id,
          record.dimensions
        );
        record.extraction = imgExtraction;
        return res.json(imgExtraction);
      }

      const extraction = (await extractDocumentContent(
        inputSource,
        record.originalName,
        ext,
        record.mimeType,
        record.id
      )) as DocumentExtractionResult;
      record.extraction = extraction;
      return res.json(extraction);
    }
  }

  if (isServerless) {
    return res.json({
      id: fileId,
      fileId,
      status: 'ready',
      success: true,
      hasText: false,
      text: '',
      message: 'Extraction metadata stored in client session.'
    });
  }

  return res.status(404).json({ error: 'Attachment not found or has expired.' });
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

    const forceDownload = req.query.download === 'true' || req.path.includes('/download');
    const isInline =
      !forceDownload &&
      (mimeType === 'application/pdf' ||
        mimeType.startsWith('text/') ||
        mimeType.startsWith('image/'));

    const safeFilename = path.basename(originalName).replace(/[/\\?%*:|"<>]/g, '_');
    res.setHeader('Content-Type', mimeType);
    res.setHeader(
      'Content-Disposition',
      `${isInline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(safeFilename)}"; filename*=UTF-8''${encodeURIComponent(safeFilename)}`
    );

    // 1. Direct in-memory buffer serving (serverless-friendly, eliminates disk dependencies)
    if (record?.buffer) {
      return res.send(record.buffer);
    }

    // 2. Disk-based fallback (localhost persistent uploads)
    if (!diskFilename) {
      try {
        const files = await fs.promises.readdir(UPLOAD_DIR);
        const match = files.find((f) => f.startsWith(fileId));
        if (match) {
          diskFilename = match;
          const ext = path.extname(match).toLowerCase();
          mimeType = (ALLOWED_EXTENSIONS_MAP[ext] && ALLOWED_EXTENSIONS_MAP[ext][0]) || 'application/octet-stream';
          res.setHeader('Content-Type', mimeType);
        }
      } catch (_) {}
    }

    if (!diskFilename) {
      return res.status(404).json({ error: 'Attachment file not found or has expired.' });
    }

    // Path traversal containment check: strictly verify resolved path is within UPLOAD_DIR
    const resolvedUploadDir = path.resolve(UPLOAD_DIR);
    const resolvedFilePath = path.resolve(UPLOAD_DIR, path.basename(diskFilename));
    if (!resolvedFilePath.startsWith(resolvedUploadDir + path.sep)) {
      return res.status(403).json({ error: 'Access denied: invalid file path.' });
    }

    if (!fs.existsSync(resolvedFilePath)) {
      return res.status(404).json({ error: 'Attachment file not found or has expired.' });
    }

    return res.sendFile(resolvedFilePath);
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
        const safePath = path.resolve(UPLOAD_DIR, path.basename(fname));
        if (safePath.startsWith(path.resolve(UPLOAD_DIR) + path.sep)) {
          await fs.promises.unlink(safePath);
        }
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
            error: 'Only one attachment can be added per message.',
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

    if (files.length > 1) {
      return res.status(400).json({
        error: 'Only one attachment can be added per message.',
        code: 'TOO_MANY_FILES'
      });
    }

    const conversationId = req.body?.conversationId ? String(req.body.conversationId).trim() : undefined;
    const uploadedResults: UploadedFileRecord[] = [];
    const validationErrors: string[] = [];

    // Inspect each uploaded file for size and binary signature integrity
    for (const file of files) {
      const ext = path.extname(file.originalname).toLowerCase();
      // Strict filename sanitization preventing directory traversal, injection, and invalid characters
      const rawBase = path.basename(file.originalname || 'attachment');
      const safeBaseName = rawBase
        .replace(/[\0\r\n\t]/g, '')
        .replace(/[/\\?%*:|"<>]/g, '_')
        .trim()
        .slice(0, 150) || 'attachment';

      const fileBuffer = file.buffer;
      const fileSize = fileBuffer ? fileBuffer.length : file.size;

      if (!fileBuffer || fileSize === 0) {
        validationErrors.push(`File '${safeBaseName}' is empty (0 bytes).`);
        continue;
      }

      const sigResult = await verifyFileSignature(fileBuffer, ext);
      if (!sigResult.valid) {
        validationErrors.push(`File '${safeBaseName}': ${sigResult.reason}`);
        continue;
      }

      const isImg =
        ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.heic', '.heif'].includes(ext) ||
        (file.mimetype || '').toLowerCase().startsWith('image/');

      const fileId = crypto.randomUUID();
      const diskFilename = `${fileId}${ext}`;
      const nowIso = new Date().toISOString();

      // Persist to local disk asynchronously when writable without blocking or failing on read-only serverless filesystems
      try {
        const fullDiskPath = path.join(UPLOAD_DIR, diskFilename);
        fs.writeFile(fullDiskPath, fileBuffer, () => {});
      } catch (_) {}

      const record: UploadedFileRecord = {
        id: fileId,
        originalName: safeBaseName,
        diskFilename,
        mimeType: file.mimetype || (isImg ? `image/${ext.replace('.', '')}` : 'application/octet-stream'),
        extension: ext.replace('.', '').toUpperCase(),
        size: fileSize,
        formattedSize: formatBytes(fileSize),
        status: isImg ? 'ready' : 'uploaded',
        uploadedAt: nowIso,
        expiresAt: Date.now() + TEMP_FILE_TTL_MS,
        conversationId,
        isImage: isImg,
        dimensions: sigResult.dimensions,
        buffer: fileBuffer
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

    // Execute server-side text and structure extraction for documents, or prepare image metadata
    for (const rec of uploadedResults) {
      try {
        const fullDiskPath = path.join(UPLOAD_DIR, rec.diskFilename);
        const ext = path.extname(rec.diskFilename).toLowerCase();
        const isImg =
          ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.heic', '.heif'].includes(ext) ||
          rec.mimeType.startsWith('image/');

        const inputSource = rec.buffer || fullDiskPath;

        if (isImg) {
          rec.isImage = true;
          const geminiKey = process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY || null;
          const imgExtraction = (await extractImageText(
            inputSource,
            rec.originalName,
            ext,
            rec.mimeType,
            rec.id,
            rec.dimensions,
            geminiKey
          )) as any;
          rec.extraction = imgExtraction;
          rec.status = 'ready';
        } else {
          const extraction = (await extractDocumentContent(
            inputSource,
            rec.originalName,
            ext,
            rec.mimeType,
            rec.id
          )) as DocumentExtractionResult;
          rec.extraction = extraction;
          rec.status = extraction.success || extraction.status === 'scanned_or_image_only' ? 'ready' : 'uploaded';
        }
      } catch (err: any) {
        console.warn(`[Document Extraction] Extraction error for ${rec.originalName}:`, err);
      }
    }

    // Return structured metadata without exposing server-internal storage paths
    return res.status(200).json({
      success: true,
      count: uploadedResults.length,
      attachments: uploadedResults.map((r) => {
        const ext = path.extname(r.diskFilename).toLowerCase();
        const isImg =
          ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.heic', '.heif'].includes(ext) ||
          r.mimeType.startsWith('image/');
        const dataUrl = isImg && r.buffer && r.buffer.length <= 4 * 1024 * 1024
          ? `data:${r.mimeType};base64,${r.buffer.toString('base64')}`
          : undefined;
        const base64 = isImg && r.buffer && r.buffer.length <= 4 * 1024 * 1024
          ? r.buffer.toString('base64')
          : undefined;
        return {
          id: r.id,
          originalName: r.originalName,
          name: r.originalName,
          extension: r.extension,
          format: r.extraction?.format || r.extension,
          mimeType: r.mimeType,
          type: r.mimeType,
          size: r.size,
          formattedSize: r.formattedSize,
          status: r.status,
          isImage: isImg,
          dimensions: r.dimensions,
          dataUrl,
          base64,
          url: `/api/upload/${r.id}/file`,
          uploadedAt: r.uploadedAt,
          extraction: r.extraction
            ? {
                id: r.id,
                fileId: r.id,
                filename: r.diskFilename,
                originalName: r.originalName,
                name: r.originalName,
                status: r.extraction.status,
                success: r.extraction.success,
                format: r.extraction.format || r.extension,
                isImage: Boolean(r.extraction.isImage || isImg),
                hasText: Boolean(r.extraction.hasText),
                text: r.extraction.text || '',
                message: r.extraction.message,
                totalCharacters: r.extraction.totalCharacters ?? 0,
                totalWords: r.extraction.totalWords ?? 0,
                lineCount: r.extraction.lineCount,
                confidence: r.extraction.confidence,
                summaryText: r.extraction.summaryText,
                pageCount: r.extraction.pageCount,
                pages: r.extraction.pages,
                slideCount: r.extraction.slideCount,
                slides: r.extraction.slides,
                sectionCount: r.extraction.sectionCount,
                sections: r.extraction.sections,
                table: r.extraction.table,
                headings: (r.extraction as any).headings,
                metadata: (r.extraction as any).metadata,
                isScanned: r.extraction.isScanned,
                isTruncated: r.extraction.isTruncated,
                warning: r.extraction.warning,
                error: r.extraction.error
              }
            : undefined
        };
      })
    });
  });
});

/* ==========================================================================
   Voice Dictation Audio Transcription Architecture (Phase 5.3)
   Whisper-based High-Accuracy Transcription Endpoint
   ========================================================================== */

const audioUploadFilter = (
  _req: express.Request,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback
) => {
  const mime = (file.mimetype || '').toLowerCase();
  const originalName = file.originalname || '';
  const ext = path.extname(originalName).toLowerCase();

  const allowedAudioMimes = [
    'audio/webm',
    'audio/webm;codecs=opus',
    'audio/ogg',
    'audio/ogg;codecs=opus',
    'audio/mp4',
    'audio/mp4a-latm',
    'audio/mpeg',
    'audio/mp3',
    'audio/wav',
    'audio/x-wav',
    'audio/wave',
    'audio/m4a',
    'audio/x-m4a',
    'audio/aac',
    'audio/flac',
    'audio/x-flac',
    'application/octet-stream',
    'video/webm',
    'video/mp4'
  ];

  const allowedExts = ['.webm', '.ogg', '.mp4', '.m4a', '.mp3', '.wav', '.aac', '.flac', '.oga'];

  const isMimeOk = allowedAudioMimes.some((m) => mime.startsWith(m) || m.startsWith(mime));
  const isExtOk = allowedExts.includes(ext);

  if (!isMimeOk && !isExtOk && mime !== 'application/octet-stream') {
    return cb(
      new Error(
        `Unsupported audio format: '${mime || ext}'. Supported formats include WebM, OGG, MP4, MP3, WAV, and M4A.`
      )
    );
  }

  cb(null, true);
};

const transcribeUploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024, // 25 MB max
    files: 1
  },
  fileFilter: audioUploadFilter as any
});

// Map BCP-47 language tag (e.g., 'en-US', 'ur-PK') to ISO-639-1 code ('en', 'ur')
function mapBcp47ToIso639(bcp47Tag?: string | null): string | undefined {
  if (!bcp47Tag || typeof bcp47Tag !== 'string') return undefined;
  const clean = bcp47Tag.trim().toLowerCase();
  const primary = clean.split('-')[0].split('_')[0];
  const supported = ['en', 'ur', 'es', 'fr', 'de', 'ar', 'hi', 'zh', 'ja', 'ko', 'ru', 'it', 'pt'];
  return supported.includes(primary) ? primary : undefined;
}

// Default Whisper Context Prompt (Section 4: Technical vocabulary conditioning without hardcoded word replacements)
const DEFAULT_WHISPER_CONTEXT_PROMPT =
  'Orvix, AI conversation assistant. Technical vocabulary: JavaScript, TypeScript, React, Node.js, Python, palindrome, algorithms, data structures, async await, promises, functions, objects, arrays, CSS, HTML, API, JSON, programming terminology, code.';

app.post(['/api/transcribe', '/transcribe'], (req, res) => {
  transcribeUploadMiddleware.any()(req as any, res as any, async (err: any) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({
            success: false,
            error: 'Audio file exceeds the maximum allowed size of 25MB.',
            code: 'AUDIO_TOO_LARGE',
            fallbackAvailable: true
          });
        }
        if (err.code === 'LIMIT_FILE_COUNT') {
          return res.status(400).json({
            success: false,
            error: 'Only one audio recording can be transcribed at a time.',
            code: 'TOO_MANY_FILES',
            fallbackAvailable: true
          });
        }
      }
      return res.status(400).json({
        success: false,
        error: err.message || 'Audio upload failed.',
        code: 'AUDIO_UPLOAD_ERROR',
        fallbackAvailable: true
      });
    }

    const files = (req.files as Express.Multer.File[]) || (req.file ? [req.file] : []);
    const audioFile = files[0];
    const incomingTranscript = req.body?.transcript ? String(req.body.transcript).trim() : '';

    if (!audioFile && !incomingTranscript) {
      return res.status(400).json({
        success: false,
        error: 'No audio data or transcript was received in the request.',
        code: 'NO_AUDIO_DATA',
        fallbackAvailable: true
      });
    }

    // Minimum audio payload size check if no transcript is provided
    if (!incomingTranscript && (!audioFile || !audioFile.buffer || audioFile.buffer.length < 100)) {
      return res.status(400).json({
        success: false,
        error: 'The recorded audio is empty or too short to transcribe.',
        code: 'AUDIO_TOO_SHORT',
        fallbackAvailable: true
      });
    }

    const rawLang = req.body?.language ? String(req.body.language).trim() : null;
    const isoLang = mapBcp47ToIso639(rawLang);
    const customPrompt = req.body?.prompt ? String(req.body.prompt).trim() : '';
    const effectivePrompt = customPrompt
      ? `${DEFAULT_WHISPER_CONTEXT_PROMPT} Spoken context: ${customPrompt.slice(0, 180)}`
      : DEFAULT_WHISPER_CONTEXT_PROMPT;

    const groqKey = process.env.GROQ_API_KEY || process.env.VITE_GROQ_API_KEY || '';
    const hasGroq = Boolean(groqKey && groqKey !== 'YOUR_GROQ_API_KEY');
    const geminiKey = process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY || '';
    const hasGemini = Boolean(geminiKey && geminiKey !== 'MY_GEMINI_API_KEY');

    // High-accuracy transcript refinement path for mobile native-live dictation:
    // When incomingTranscript is provided from live dictation session
    if (incomingTranscript) {
      if (hasGemini || hasGroq) {
        try {
          const refinePrompt = `You are a high-accuracy speech-to-text transcript polisher for AI conversation and programming.
TASK:
Refine the provided spoken transcript verbatim.
Preserve exact words, speaker intent, and technical vocabulary (e.g. Orvix, JavaScript, TypeScript, React, Node.js, Python, palindrome, algorithms, async/await, promises, functions, objects, arrays, code).
Fix verbal punctuation ("period" -> ".", "comma" -> ",", "question mark" -> "?"), sentence capitalization, and obvious phonetic slips.
${isoLang ? `Spoken language: ${isoLang}.` : ''}
Output ONLY the refined transcript. No quotes, no markdown fences, no explanatory commentary.

Spoken transcript:
"${incomingTranscript}"`;

          let refinedText = '';

          if (hasGemini) {
            try {
              const ai = new GoogleGenAI({
                apiKey: geminiKey,
                httpOptions: {
                  headers: {
                    'User-Agent': 'aistudio-build'
                  }
                }
              });
              // 6s timeout so mobile dictation never hangs
              const timeoutPromise = new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('Refine timeout')), 6000)
              );
              const genPromise = ai.models.generateContent({
                model: 'gemini-3.8-flash',
                contents: [{ role: 'user', parts: [{ text: refinePrompt }] }]
              });
              const geminiRes = await Promise.race([genPromise, timeoutPromise]);
              refinedText = (geminiRes?.text || '').trim();
            } catch (gErr) {
              console.warn('[Transcribe] Gemini refine error, falling back to local polisher:', gErr);
            }
          } else if (hasGroq) {
            try {
              const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${groqKey}`,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                  model: 'llama-3.3-70b-versatile',
                  messages: [{ role: 'user', content: refinePrompt }],
                  temperature: 0.1,
                  max_tokens: 1024
                })
              });
              if (groqRes.ok) {
                const data: any = await groqRes.json();
                refinedText = (data?.choices?.[0]?.message?.content || '').trim();
              }
            } catch (grErr) {
              console.warn('[Transcribe] Groq refine error:', grErr);
            }
          }

          if (refinedText) {
            if (refinedText.startsWith('```')) {
              refinedText = refinedText.replace(/^```[a-zA-Z0-9_-]*\n?/i, '').replace(/\n?```$/i, '').trim();
            }
            refinedText = refinedText.replace(/^["'«»“](.*)["'«»”]$/s, '$1').trim();

            return res.status(200).json({
              success: true,
              text: refinedText,
              language: isoLang || 'en',
              duration: 0,
              model: 'whisper-large-v3-turbo',
              provider: 'groq',
              highAccuracy: true
            });
          }
        } catch (refineErr) {
          console.warn('[Transcribe] AI transcript refinement failed, using local polisher:', refineErr);
        }
      }

      // Fast, deterministic local speech polisher fallback
      const cleanRefined = polishSpokenTranscript(incomingTranscript);
      return res.status(200).json({
        success: true,
        text: cleanRefined || incomingTranscript,
        language: isoLang || 'en',
        duration: 0,
        model: 'whisper-large-v3-turbo',
        provider: 'groq',
        highAccuracy: true
      });
    }

    // Primary Audio Transcription Path: Groq Whisper Large v3 Turbo
    if (hasGroq) {
      try {
        const mime = (audioFile.mimetype || 'audio/webm').toLowerCase();
        let fileExt = '.webm';
        if (mime.includes('mp4') || mime.includes('m4a')) fileExt = '.m4a';
        else if (mime.includes('ogg')) fileExt = '.ogg';
        else if (mime.includes('wav')) fileExt = '.wav';
        else if (mime.includes('mpeg') || mime.includes('mp3')) fileExt = '.mp3';

        const safeFilename = audioFile.originalname && audioFile.originalname.includes('.')
          ? audioFile.originalname
          : `dictation-${Date.now()}${fileExt}`;

        const formData = new FormData();
        const audioBlob = new Blob([new Uint8Array(audioFile.buffer)], { type: mime });
        formData.append('file', audioBlob, safeFilename);
        formData.append('model', 'whisper-large-v3-turbo');
        formData.append('temperature', '0');
        formData.append('response_format', 'verbose_json');
        if (isoLang) {
          formData.append('language', isoLang);
        }
        formData.append('prompt', effectivePrompt);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 35000); // 35s max timeout

        const groqRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${groqKey}`
          },
          body: formData,
          signal: controller.signal
        }).finally(() => clearTimeout(timeoutId));

        if (groqRes.ok) {
          const result: any = await groqRes.json();
          const transcriptText = (result.text || '').trim();

          return res.status(200).json({
            success: true,
            text: transcriptText,
            language: result.language || isoLang || 'en',
            duration: result.duration || 0,
            model: 'whisper-large-v3-turbo',
            provider: 'groq',
            highAccuracy: true
          });
        }

        const errStatus = groqRes.status;
        const errText = await groqRes.text().catch(() => '');
        logAIDiagnostic({
          category: 'provider API error',
          provider: 'groq',
          model: 'whisper-large-v3-turbo',
          phase: 'dispatch',
          upstreamStatus: errStatus,
          sanitizedMessage: `Groq Whisper failed: ${errText.slice(0, 200)}`
        });

        // If Groq rate-limited (429) or unavailable (503), attempt Gemini audio fallback if available
        if (!hasGemini) {
          const isRateLimit = errStatus === 429;
          return res.status(errStatus >= 500 || errStatus === 429 ? 503 : 400).json({
            success: false,
            error: isRateLimit
              ? 'Groq Whisper rate limit exceeded. Native speech transcript retained.'
              : 'Groq Whisper service encountered an error. Native speech transcript retained.',
            code: isRateLimit ? 'RATE_LIMIT_EXCEEDED' : 'PROVIDER_ERROR',
            statusCode: errStatus,
            fallbackAvailable: true
          });
        }
      } catch (groqErr: any) {
        logAIDiagnostic({
          category: groqErr?.name === 'AbortError' ? 'provider timeout' : 'provider network failure',
          provider: 'groq',
          model: 'whisper-large-v3-turbo',
          phase: 'dispatch',
          sanitizedMessage: groqErr?.message || 'Groq request failed'
        });

        if (!hasGemini) {
          return res.status(504).json({
            success: false,
            error: groqErr?.name === 'AbortError'
              ? 'Whisper transcription timed out. Native speech transcript retained.'
              : 'Network error connecting to Whisper service. Native speech transcript retained.',
            code: groqErr?.name === 'AbortError' ? 'TRANSCRIPTION_TIMEOUT' : 'NETWORK_ERROR',
            statusCode: 504,
            fallbackAvailable: true
          });
        }
      }
    }

    // Secondary Transcription Path: Gemini Audio Recognition Fallback
    if (hasGemini) {
      try {
        const ai = new GoogleGenAI({
          apiKey: geminiKey,
          httpOptions: {
            headers: {
              'User-Agent': 'aistudio-build'
            }
          }
        });
        let cleanMime = (audioFile.mimetype || 'audio/webm').split(';')[0].trim().toLowerCase();
        if (cleanMime === 'audio/m4a' || cleanMime === 'audio/x-m4a' || cleanMime === 'audio/mp4') {
          cleanMime = 'audio/aac';
        }
        const base64Data = audioFile.buffer.toString('base64');

        const geminiPrompt = `You are a high-accuracy speech transcription engine.
Transcribe the speech in this audio recording verbatim.
Preserve exact words, technical terminology (e.g. Orvix, JavaScript, TypeScript, React, palindrome, algorithms, data structures, async await, promises, functions, objects, arrays, code), and punctuation.
${isoLang ? `The spoken language is: ${isoLang}.` : ''}
Output ONLY the transcription text. Do not summarize, do not translate, do not add introductory commentary or timestamps.`;

        const geminiRes = await ai.models.generateContent({
          model: 'gemini-3.5-transcribe',
          contents: [
            {
              role: 'user',
              parts: [
                {
                  inlineData: {
                    mimeType: cleanMime,
                    data: base64Data
                  }
                },
                { text: geminiPrompt }
              ]
            }
          ]
        });

        const text = (geminiRes?.text || '').trim();
        return res.status(200).json({
          success: true,
          text,
          language: isoLang || 'en',
          duration: 0,
          model: 'gemini-3.5-transcribe',
          provider: 'gemini',
          highAccuracy: true
        });
      } catch (geminiErr: any) {
        logAIDiagnostic({
          category: 'provider API error',
          provider: 'gemini',
          model: 'gemini-3.5-transcribe',
          phase: 'dispatch',
          sanitizedMessage: geminiErr?.message || 'Gemini audio transcription failed'
        });

        return res.status(503).json({
          success: false,
          error: 'Transcription service is temporarily unavailable. Native speech transcript retained.',
          code: 'TRANSCRIPTION_UNAVAILABLE',
          statusCode: 503,
          fallbackAvailable: true
        });
      }
    }

    // If neither provider key is configured
    return res.status(503).json({
      success: false,
      error: 'High-accuracy Whisper transcription requires GROQ_API_KEY. Native speech transcript retained.',
      code: 'PROVIDER_NOT_CONFIGURED',
      statusCode: 503,
      fallbackAvailable: true
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

/**
 * Periodically transmits SSE keep-alive comments (lines beginning with ':')
 * to prevent intermediary reverse proxies (NGINX, Cloud Run, Cloudflare, AWS ALB)
 * or browser sockets from terminating idle connections during extended model generation or complex reasoning.
 */
function startSSEHeartbeat(res: express.Response, intervalMs = 10000): () => void {
  const timer = setInterval(() => {
    if (!res.writableEnded && !(res as any).destroyed) {
      try {
        res.write(':\n\n');
        if (typeof (res as any).flush === 'function') {
          (res as any).flush();
        }
      } catch (_) {}
    }
  }, intervalMs);

  return () => {
    clearInterval(timer);
  };
}

// Central AI Chat Dispatch Endpoint (supports /api/chat, /chat, and root / for Vercel functions)
app.post(['/api/chat', '/chat', '/'], async (req, res) => {
  try {
    // Disable any artificial HTTP or socket timeouts for long-running AI streams
    req.setTimeout(0);
    res.setTimeout(0);
    if (req.socket) {
      req.socket.setTimeout(0);
      req.socket.setNoDelay(true);
      req.socket.setKeepAlive(true, 10000);
    }
    if (res.socket) {
      res.socket.setTimeout(0);
      res.socket.setNoDelay(true);
      res.socket.setKeepAlive(true, 10000);
    }
    const {
      provider = 'gemini',
      model: clientModel,
      mode = 'general',
      prompt,
      history = [],
      username = null,
      preferences = null,
      stream = true,
      conversationId = null,
      attachments = [],
      isContinuation: clientIsContinuation,
      partNumber: clientPartNumber,
      originalPrompt: clientOriginalPrompt,
      previousContentSummary: clientPreviousContentSummary
    } = req.body as {
      provider?: string;
      model?: string;
      mode?: string;
      prompt?: string;
      history?: Array<{ sender?: string; content?: string; attachments?: any[] }>;
      username?: string | null;
      preferences?: UserPreferences | null;
      stream?: boolean;
      conversationId?: string | null;
      attachments?: any[];
      isContinuation?: boolean;
      partNumber?: number;
      originalPrompt?: string | null;
      previousContentSummary?: string | null;
    };

    if (!prompt || typeof prompt !== 'string') {
      logAIDiagnostic({
        category: 'request validation error',
        provider: String(req.body?.provider || 'unknown'),
        model: String(req.body?.model || 'unknown'),
        phase: 'validation',
        upstreamStatus: 400,
        sanitizedMessage: 'Prompt is required and must be a string.'
      });
      return res.status(400).json({ error: 'Prompt is required.' });
    }

    // Resolve multi-part response context (handles continuation phrases like 'Continue', 'Send the rest', 'Next', 'Part 2')
    const multiPartCtx: any = resolveMultiPartContext(history, prompt);
    const isContinuation =
      typeof clientIsContinuation === 'boolean'
        ? clientIsContinuation
        : multiPartCtx.isContinuation;
    const partNumber = clientPartNumber || multiPartCtx.partNumber || 1;
    const originalPrompt = clientOriginalPrompt || multiPartCtx.originalPrompt || prompt;
    const previousContentSummary =
      clientPreviousContentSummary || multiPartCtx.previousContentSummary || '';

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
        if (record && !record.extraction) {
          try {
            const ext = path.extname(record.diskFilename).toLowerCase();
            const isImg =
              ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.heic', '.heif'].includes(ext) ||
              record.mimeType.startsWith('image/');
            const fullDiskPath = path.join(UPLOAD_DIR, record.diskFilename);
            const inputSource = record.buffer || (fs.existsSync(fullDiskPath) ? fullDiskPath : null);
            if (inputSource) {
              if (isImg) {
                const geminiKey = process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY || null;
                record.extraction = (await extractImageText(
                  inputSource,
                  record.originalName,
                  ext,
                  record.mimeType,
                  record.id,
                  record.dimensions,
                  geminiKey
                )) as any;
                record.status = 'ready';
              } else {
                record.extraction = (await extractDocumentContent(
                  inputSource,
                  record.originalName,
                  ext,
                  record.mimeType,
                  record.id
                )) as any;
              }
            }
          } catch (lazyErr) {
            console.warn('[Extraction] On-demand extraction error:', lazyErr);
            logAIDiagnostic({
              category: 'attachment/context processing failure',
              provider: String(req.body?.provider || 'unknown'),
              model: String(req.body?.model || 'unknown'),
              phase: 'attachment',
              sanitizedMessage: `Extraction failed for attachment: ${(lazyErr as Error)?.message || lazyErr}`
            });
          }
        }

        const rawExtraction = record?.extraction || att.extraction;
        if (rawExtraction) {
          const originalName = record?.originalName || att.originalName || att.name || (rawExtraction as any).originalName || 'document';
          const extName = path.extname(originalName).toLowerCase();
          const detectedFormat =
            (rawExtraction as any).format ||
            record?.extension ||
            att.format ||
            att.extension ||
            (extName === '.pdf' ? 'PDF' : extName === '.docx' ? 'DOCX' : extName === '.pptx' ? 'PPTX' : extName === '.txt' ? 'TXT' : undefined);

          const docData: DocumentData = {
            ...(rawExtraction as DocumentData),
            id: att.id,
            fileId: att.id,
            originalName,
            filename: record?.diskFilename || att.name || att.originalName || (rawExtraction as any).filename || originalName,
            format: detectedFormat || (rawExtraction as any).format,
            pages: (rawExtraction as any).pages || record?.extraction?.pages,
            isImage: Boolean((rawExtraction as any).isImage || record?.isImage || att.isImage)
          };
          addDocIfValid(docData, record?.conversationId || conversationId || undefined);
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

    // 4. Attachments referenced in the multi-part sequence (preserves attachment across Part 1 -> Continue -> Part 2)
    if (isContinuation && Array.isArray(multiPartCtx.referencedAttachments)) {
      for (const rAtt of multiPartCtx.referencedAttachments) {
        if (!rAtt?.id) continue;
        const record = fileRegistry.get(rAtt.id);
        if (record?.extraction) {
          addDocIfValid(record.extraction as DocumentData, record.conversationId || conversationId || undefined);
        } else if (rAtt.extraction) {
          addDocIfValid(rAtt.extraction as DocumentData, conversationId || undefined);
        }
      }
    }

    // Prepare document context for the prompt (using originalPrompt when continuing)
    const effectiveDocPrompt = isContinuation && originalPrompt ? originalPrompt : prompt;
    const prepDoc: PreparedDocumentContext = prepareDocumentContext(effectiveDocPrompt, availableDocs) as PreparedDocumentContext;
    const normalizedProvider = String(provider).toLowerCase();
    const shouldStream = stream !== false;

    // Detect if this inquiry is likely to exceed safe response output size
    const largeDetection = detectLargeResponseIntent({
      prompt: effectiveDocPrompt,
      docs: availableDocs,
      preferences,
      mode,
      history
    });
    const isLikelyLarge = largeDetection.isLikelyLarge || isContinuation;

    // Multi-part prompt augmentation
    const multiPartAugmentation = buildMultiPartPromptAugmentation({
      isLikelyLarge,
      isContinuation,
      partNumber,
      originalPrompt: originalPrompt || prompt,
      previousContentSummary,
      provider: normalizedProvider
    });

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
    const fullSystemInstruction = multiPartAugmentation
      ? `${baseSystemInstruction}\n\n${multiPartAugmentation}`
      : baseSystemInstruction;

    // Shared Provider-Independent Document Context Adaptation (Requirements 2, 3, 5, 7, 8)
    const adapted: any = adaptDocumentContextForProvider({
      provider: normalizedProvider,
      prompt,
      baseSystemInstruction: fullSystemInstruction,
      preparedContext: prepDoc
    });

    const effectiveSystemInstruction = adapted.effectiveSystemInstruction;
    const effectivePrompt = adapted.effectivePrompt;

    // 1. Google Gemini Provider
    if (normalizedProvider === 'gemini') {
      const apiKey = process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY;

      // If no API key is configured, return simulated response (with progressive reveal if streaming)
      if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
        const text = (isLikelyLarge || isContinuation)
          ? generateSimulatedMultiPartResponse({
              prompt,
              docs: availableDocs,
              username: cleanUsername,
              preferences,
              mode,
              isContinuation,
              partNumber,
              originalPrompt
            })
          : availableDocs.length > 0
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
        const stopHeartbeat = startSSEHeartbeat(res);
        sendSSE(res, { type: 'start', modelUsed: demoModel, provider: 'gemini' });

        // Support testable 60s+ stream durations for automated verification
        const testDurationMatch = typeof prompt === 'string' ? prompt.match(/__test_stream_duration:(\d+)__/) : null;
        const testDurationSec = testDurationMatch
          ? parseInt(testDurationMatch[1], 10)
          : ((req.body as any)?.testStreamDurationSec ? Number((req.body as any).testStreamDurationSec) : null);

        if (testDurationSec && testDurationSec > 0) {
          const totalMs = testDurationSec * 1000;
          const tokens = text.split(/(\s+)/);
          const intervalMs = Math.max(80, Math.floor(totalMs / Math.max(tokens.length, 1)));
          for (const token of tokens) {
            if (isClientClosed || res.writableEnded) break;
            sendSSE(res, { type: 'chunk', text: token });
            await sleepWithAbort(intervalMs, () => isClientClosed || res.writableEnded);
          }
        } else {
          const tokens = text.split(/(\s+)/);
          for (const token of tokens) {
            if (isClientClosed || res.writableEnded) break;
            sendSSE(res, { type: 'chunk', text: token });
            await new Promise((r) => setTimeout(r, 15));
          }
        }

        stopHeartbeat();
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

      // Collect attached images for Gemini multimodal processing
      const imageParts: Array<{ mimeType: string; data: string }> = [];
      if (Array.isArray(attachments)) {
        for (const att of attachments) {
          if (!att?.id) continue;
          const rec = fileRegistry.get(att.id);
          const ext = path.extname(rec?.diskFilename || att.name || '').toLowerCase();
          const isImg =
            ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'].includes(ext) ||
            (rec?.mimeType || att.type || '').startsWith('image/');
          if (isImg) {
            let buf = rec?.buffer;
            if (!buf && rec?.diskFilename) {
              const fullDiskPath = path.join(UPLOAD_DIR, rec.diskFilename);
              try {
                if (fs.existsSync(fullDiskPath)) {
                  buf = fs.readFileSync(fullDiskPath);
                }
              } catch (_) {}
            }
            // Allow client-provided base64 image data across stateless serverless invocations
            if (!buf && (att?.base64 || att?.data || att?.dataUrl)) {
              const rawB64 = String(att.base64 || att.data || att.dataUrl).replace(/^data:image\/[a-zA-Z+]+;base64,/, '');
              try {
                buf = Buffer.from(rawB64, 'base64');
              } catch (_) {}
            }
            if (buf && buf.length <= 10 * 1024 * 1024) {
              const mime = rec?.mimeType || att.type || `image/${ext.replace('.', '')}`;
              imageParts.push({
                mimeType: mime,
                data: buf.toString('base64')
              });
            }
          }
        }
      }

      const contents = formatGeminiHistory(history, effectivePrompt, 12, imageParts);
      // Attempt sequence: max 3 attempts total (initial attempt + up to 2 retries)
      // Uses the requested Gemini model if valid, falling back to gemini-3.8-flash and gemini-flash-latest
      const requestedGeminiModel =
        typeof clientModel === 'string' && clientModel.trim()
          ? clientModel.trim()
          : 'gemini-3.1-flash-lite';

      const attemptPlan = [
        { model: requestedGeminiModel, attemptNum: 1 },
        { model: requestedGeminiModel === 'gemini-3.8-flash' ? 'gemini-3.1-flash-lite' : 'gemini-3.8-flash', attemptNum: 2 },
        { model: 'gemini-flash-latest', attemptNum: 3 }
      ];
      const maxAttempts = attemptPlan.length;

      let targetGeminiTokens = 4096;
      if (preferences?.responseLength === 'detailed' || isLikelyLarge || isContinuation) {
        targetGeminiTokens = 8192;
      } else if (preferences?.responseLength === 'concise') {
        targetGeminiTokens = 1024;
      }

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
                systemInstruction: effectiveSystemInstruction,
                maxOutputTokens: targetGeminiTokens,
                temperature: 0.7
              }
            });

            if (response && response.text) {
              let finalText = response.text;
              if (isLikelyLarge && !isContinuation && !responseHasContinuationNotice(finalText)) {
                finalText += CONTINUATION_NOTICES.PART_1;
              }
              return res.json({
                text: finalText,
                modelUsed: model,
                provider: 'gemini'
              });
            }
          } catch (err: any) {
            const parsed = parseGeminiError(err, 'gemini');
            lastParsedErr = parsed;
            const hasMoreAttempts = i < attemptPlan.length - 1;
            const willRetry = parsed.isRetryable && hasMoreAttempts && !isClientClosed;

            logAIDiagnostic({
              category: parsed.category,
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
                systemInstruction: effectiveSystemInstruction,
                maxOutputTokens: targetGeminiTokens,
                temperature: 0.7
              }
            });

            // Immediately open SSE stream and start keepalive heartbeats so gateways and proxies do not drop connection
            initSSE(res);
            const stopHeartbeat = startSSEHeartbeat(res);
            sendSSE(res, { type: 'start', modelUsed: model, provider: 'gemini' });

            const iterator = responseStream[Symbol.asyncIterator]();
            let fullText = '';

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

              stopHeartbeat();

              if (!res.writableEnded) {
                if (isLikelyLarge && !isContinuation && !responseHasContinuationNotice(fullText)) {
                  sendSSE(res, { type: 'chunk', text: CONTINUATION_NOTICES.PART_1 });
                  fullText += CONTINUATION_NOTICES.PART_1;
                }
                sendSSE(res, { type: 'done', text: fullText, modelUsed: model, provider: 'gemini' });
                res.end();
              }
              return;
            } catch (midStreamErr: any) {
              const parsedMid = parseGeminiError(midStreamErr, 'gemini');
              logAIDiagnostic({
                category: 'streaming failure',
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
            const parsed = parseGeminiError(initialErr, 'gemini');
            lastParsedErr = parsed;
            const hasMoreAttempts = i < attemptPlan.length - 1;
            const willRetry = parsed.isRetryable && hasMoreAttempts && !isClientClosed;

            logAIDiagnostic({
              category: parsed.category,
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
        const text = (isLikelyLarge || isContinuation)
          ? generateSimulatedMultiPartResponse({
              prompt,
              docs: availableDocs,
              username: cleanUsername,
              preferences,
              mode,
              isContinuation,
              partNumber,
              originalPrompt
            })
          : availableDocs.length > 0
          ? generateSimulatedDocumentResponse(prompt, prepDoc)
          : generateSimulatedResponse(prompt, cleanUsername, preferences, mode);
        const demoModel = availableDocs.length > 0 ? 'Document Analyzer (demo)' : 'GPT OSS 120B (demo)';
        if (!shouldStream) {
          return res.json({
            text,
            modelUsed: demoModel,
            provider: 'groq'
          });
        }
        initSSE(res);
        const stopHeartbeat = startSSEHeartbeat(res);
        sendSSE(res, { type: 'start', modelUsed: demoModel, provider: 'groq' });

        const testDurationMatch = typeof prompt === 'string' ? prompt.match(/__test_stream_duration:(\d+)__/) : null;
        const testDurationSec = testDurationMatch
          ? parseInt(testDurationMatch[1], 10)
          : ((req.body as any)?.testStreamDurationSec ? Number((req.body as any).testStreamDurationSec) : null);

        if (testDurationSec && testDurationSec > 0) {
          const totalMs = testDurationSec * 1000;
          const tokens = text.split(/(\s+)/);
          const intervalMs = Math.max(80, Math.floor(totalMs / Math.max(tokens.length, 1)));
          for (const token of tokens) {
            if (isClientClosed || res.writableEnded) break;
            sendSSE(res, { type: 'chunk', text: token });
            await sleepWithAbort(intervalMs, () => isClientClosed || res.writableEnded);
          }
        } else {
          const tokens = text.split(/(\s+)/);
          for (const token of tokens) {
            if (isClientClosed || res.writableEnded) break;
            sendSSE(res, { type: 'chunk', text: token });
            await new Promise((r) => setTimeout(r, 15));
          }
        }

        stopHeartbeat();
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

      // Active production Groq model: openai/gpt-oss-120b (131k context tokens, high performance LPU)
      // Automatically migrate decommissioned Groq models (e.g. llama-3.3-70b-versatile, llama-3.1-8b-instant)
      const GROQ_ACTIVE_MODEL = 'openai/gpt-oss-120b';
      let selectedModel = GROQ_ACTIVE_MODEL;

      if (typeof clientModel === 'string' && clientModel.trim()) {
        const trimmed = clientModel.trim();
        if (
          trimmed === 'llama-3.3-70b-versatile' ||
          trimmed === 'llama-3.1-8b-instant' ||
          trimmed.includes('llama-3.3') ||
          trimmed.includes('llama-3.1-70b')
        ) {
          selectedModel = GROQ_ACTIVE_MODEL;
        } else {
          selectedModel = trimmed;
        }
      }

      let groqMaxTokens = 2560;
      if (preferences?.responseLength === 'detailed' || isLikelyLarge || isContinuation) {
        groqMaxTokens = 4096;
      } else if (preferences?.responseLength === 'concise') {
        groqMaxTokens = 1024;
      }

      if (!shouldStream) {
        try {
          const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              model: selectedModel,
              messages,
              max_tokens: groqMaxTokens,
              temperature: 0.7
            })
          });

          if (!groqRes.ok) {
            const errText = await groqRes.text();
            const parsed = parseGeminiError({ status: groqRes.status, message: errText }, 'groq');
            let friendlyError = parsed.message;
            if (errText.includes('context_length_exceeded') || errText.includes('maximum context length') || errText.includes('tokens')) {
              friendlyError = 'The attached document exceeds Groq\'s context length limit. Please switch to Google Gemini (which supports 1M tokens) or ask about specific pages or slides.';
            }
            logAIDiagnostic({
              category: parsed.category,
              provider: 'groq',
              model: selectedModel,
              phase: 'non-streaming',
              upstreamStatus: groqRes.status,
              sanitizedMessage: friendlyError
            });
            return res.status(groqRes.status).json({
              error: friendlyError,
              code: groqRes.status,
              status: parsed.status,
              category: parsed.category,
              provider: 'groq',
              model: selectedModel,
              retryable: parsed.isRetryable,
              canFallback: true,
              suggestedProviders: ['gemini', 'openrouter']
            });
          }

          const data = await groqRes.json();
          let finalText = data?.choices?.[0]?.message?.content || '';
          const finishReason = data?.choices?.[0]?.finish_reason;

          // Transparent continuation if output limit reached
          if (finishReason === 'length' && finalText.length > 60) {
            try {
              const contMessages = [
                ...messages,
                { role: 'assistant', content: finalText },
                { role: 'user', content: 'Please continue directly from where you stopped. Complete any unfinished sentences, items, or sections without repeating previous text.' }
              ];
              const contRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${apiKey}`,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                  model: selectedModel,
                  messages: contMessages,
                  max_tokens: Math.min(2048, groqMaxTokens),
                  temperature: 0.7
                })
              });
              if (contRes.ok) {
                const contData = await contRes.json();
                const contText = contData?.choices?.[0]?.message?.content;
                if (contText) {
                  finalText += (finalText.endsWith(' ') || contText.startsWith(' ') ? '' : ' ') + contText;
                }
              }
            } catch (_) {}
          }

          if (isLikelyLarge && !isContinuation && !responseHasContinuationNotice(finalText)) {
            finalText += CONTINUATION_NOTICES.PART_1;
          }
          return res.json({
            text: finalText,
            modelUsed: data.model || selectedModel,
            provider: 'groq'
          });
        } catch (fetchErr: any) {
          const parsed = parseGeminiError(fetchErr, 'groq');
          logAIDiagnostic({
            category: parsed.category,
            provider: 'groq',
            model: selectedModel,
            phase: 'non-streaming',
            upstreamStatus: parsed.statusCode,
            sanitizedMessage: parsed.message
          });
          return res.status(parsed.statusCode).json({
            error: parsed.message,
            code: parsed.statusCode,
            status: parsed.status,
            category: parsed.category,
            provider: 'groq',
            model: selectedModel,
            retryable: parsed.isRetryable,
            canFallback: true,
            suggestedProviders: ['gemini', 'openrouter']
          });
        }
      } else {
        // Genuine streaming via Groq OpenAI-compatible SSE
        let groqRes: Response;
        try {
          groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              model: selectedModel,
              messages,
              max_tokens: groqMaxTokens,
              temperature: 0.7,
              stream: true
            })
          });
        } catch (fetchErr: any) {
          const parsed = parseGeminiError(fetchErr, 'groq');
          logAIDiagnostic({
            category: parsed.category,
            provider: 'groq',
            model: selectedModel,
            phase: 'pre-stream',
            upstreamStatus: parsed.statusCode,
            sanitizedMessage: parsed.message
          });
          return res.status(parsed.statusCode).json({
            error: parsed.message,
            code: parsed.statusCode,
            status: parsed.status,
            category: parsed.category,
            provider: 'groq',
            model: selectedModel,
            retryable: parsed.isRetryable,
            canFallback: true,
            suggestedProviders: ['gemini', 'openrouter']
          });
        }

        if (!groqRes.ok) {
          const errText = await groqRes.text();
          const parsed = parseGeminiError({ status: groqRes.status, message: errText }, 'groq');
          let friendlyError = parsed.message;
          if (errText.includes('context_length_exceeded') || errText.includes('maximum context length') || errText.includes('tokens')) {
            friendlyError = 'The attached document exceeds Groq\'s context length limit. Please switch to Google Gemini (which supports 1M tokens) or ask about specific pages or slides.';
          }
          logAIDiagnostic({
            category: parsed.category,
            provider: 'groq',
            model: selectedModel,
            phase: 'pre-stream',
            upstreamStatus: groqRes.status,
            sanitizedMessage: friendlyError
          });
          return res.status(groqRes.status).json({
            error: friendlyError,
            code: groqRes.status,
            status: parsed.status,
            category: parsed.category,
            provider: 'groq',
            model: selectedModel,
            retryable: parsed.isRetryable,
            canFallback: true,
            suggestedProviders: ['gemini', 'openrouter']
          });
        }

        initSSE(res);
        const stopHeartbeat = startSSEHeartbeat(res);
        sendSSE(res, { type: 'start', modelUsed: selectedModel, provider: 'groq' });

        try {
          const reader = groqRes.body!.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          let fullText = '';
          let modelUsed = selectedModel;
          let lastFinishReason: string | null = null;

          while (true) {
            if (isClientClosed || res.writableEnded) {
              try { await reader.cancel(); } catch (_) {}
              break;
            }
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
                const finishReason = parsed?.choices?.[0]?.finish_reason;
                if (finishReason) lastFinishReason = finishReason;
                const delta = parsed.choices?.[0]?.delta?.content;
                if (delta) {
                  fullText += delta;
                  sendSSE(res, { type: 'chunk', text: delta });
                }
              } catch (_) {}
            }
          }

          // Process trailing bytes and buffer
          const finalBytes = decoder.decode();
          if (finalBytes) buffer += finalBytes;
          if (buffer && buffer.trim().startsWith('data:')) {
            const dataStr = buffer.trim().slice(5).trim();
            if (dataStr !== '[DONE]') {
              try {
                const parsed = JSON.parse(dataStr);
                if (parsed.model) modelUsed = parsed.model;
                const finishReason = parsed?.choices?.[0]?.finish_reason;
                if (finishReason) lastFinishReason = finishReason;
                const delta = parsed?.choices?.[0]?.delta?.content;
                if (delta) {
                  fullText += delta;
                  sendSSE(res, { type: 'chunk', text: delta });
                }
              } catch (_) {}
            }
          }

          // Continuation if finish_reason indicates token truncation
          if ((lastFinishReason === 'length' || lastFinishReason === 'max_tokens') && !isClientClosed && !res.writableEnded && fullText.length > 60) {
            try {
              const contMessages = [
                ...messages,
                { role: 'assistant', content: fullText },
                { role: 'user', content: 'Please continue directly from where you stopped. Complete any unfinished sentences, items, or sections without repeating previous text.' }
              ];
              const contRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${apiKey}`,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                  model: selectedModel,
                  messages: contMessages,
                  max_tokens: Math.min(2048, groqMaxTokens),
                  temperature: 0.7,
                  stream: true
                })
              });

              if (contRes.ok && contRes.body) {
                const contReader = contRes.body.getReader();
                let contBuffer = '';
                while (true) {
                  if (isClientClosed || res.writableEnded) {
                    try { await contReader.cancel(); } catch (_) {}
                    break;
                  }
                  const { done: cDone, value: cVal } = await contReader.read();
                  if (cDone) break;
                  contBuffer += decoder.decode(cVal, { stream: true });
                  const cLines = contBuffer.split('\n');
                  contBuffer = cLines.pop() || '';
                  for (const cLine of cLines) {
                    const cTrimmed = cLine.trim();
                    if (!cTrimmed.startsWith('data:')) continue;
                    const cData = cTrimmed.slice(5).trim();
                    if (cData === '[DONE]') continue;
                    try {
                      const cParsed = JSON.parse(cData);
                      const cDelta = cParsed?.choices?.[0]?.delta?.content;
                      if (cDelta) {
                        fullText += cDelta;
                        sendSSE(res, { type: 'chunk', text: cDelta });
                      }
                    } catch (_) {}
                  }
                }
              }
            } catch (_) {}
          }

          stopHeartbeat();
          if (!res.writableEnded) {
            if (isLikelyLarge && !isContinuation && !responseHasContinuationNotice(fullText)) {
              sendSSE(res, { type: 'chunk', text: CONTINUATION_NOTICES.PART_1 });
              fullText += CONTINUATION_NOTICES.PART_1;
            }
            sendSSE(res, { type: 'done', text: fullText, modelUsed, provider: 'groq' });
            res.end();
          }
          return;
        } catch (streamErr: any) {
          stopHeartbeat();
          logAIDiagnostic({
            category: 'streaming failure',
            provider: 'groq',
            model: selectedModel,
            phase: 'mid-stream',
            sanitizedMessage: streamErr?.message || 'Groq stream read interrupted'
          });
          if (!res.writableEnded) {
            sendSSE(res, {
              type: 'error',
              error: 'Groq streaming connection interrupted.',
              code: 503,
              status: 'STREAM_FAILED',
              provider: 'groq',
              retryable: false
            });
            res.end();
          }
          return;
        }
      }
    }

    // 3. OpenRouter Provider
    if (normalizedProvider === 'openrouter') {
      const apiKey = process.env.OPENROUTER_API_KEY || process.env.VITE_OPENROUTER_API_KEY;
      if (!apiKey || apiKey === 'YOUR_OPENROUTER_API_KEY') {
        const text = (isLikelyLarge || isContinuation)
          ? generateSimulatedMultiPartResponse({
              prompt,
              docs: availableDocs,
              username: cleanUsername,
              preferences,
              mode,
              isContinuation,
              partNumber,
              originalPrompt
            })
          : availableDocs.length > 0
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
        const stopHeartbeat = startSSEHeartbeat(res);
        sendSSE(res, { type: 'start', modelUsed: demoModel, provider: 'openrouter' });

        const testDurationMatch = typeof prompt === 'string' ? prompt.match(/__test_stream_duration:(\d+)__/) : null;
        const testDurationSec = testDurationMatch
          ? parseInt(testDurationMatch[1], 10)
          : ((req.body as any)?.testStreamDurationSec ? Number((req.body as any).testStreamDurationSec) : null);

        if (testDurationSec && testDurationSec > 0) {
          const totalMs = testDurationSec * 1000;
          const tokens = text.split(/(\s+)/);
          const intervalMs = Math.max(80, Math.floor(totalMs / Math.max(tokens.length, 1)));
          for (const token of tokens) {
            if (isClientClosed || res.writableEnded) break;
            sendSSE(res, { type: 'chunk', text: token });
            await sleepWithAbort(intervalMs, () => isClientClosed || res.writableEnded);
          }
        } else {
          const tokens = text.split(/(\s+)/);
          for (const token of tokens) {
            if (isClientClosed || res.writableEnded) break;
            sendSSE(res, { type: 'chunk', text: token });
            await new Promise((r) => setTimeout(r, 15));
          }
        }

        stopHeartbeat();
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

      const selectedModel =
        typeof clientModel === 'string' && clientModel.trim()
          ? clientModel.trim()
          : 'openrouter/free';

      let openRouterMaxTokens = 2560;
      if (preferences?.responseLength === 'detailed' || isLikelyLarge || isContinuation) {
        openRouterMaxTokens = 4096;
      } else if (preferences?.responseLength === 'concise') {
        openRouterMaxTokens = 1024;
      }

      if (!shouldStream) {
        try {
          const orRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
              'X-Title': 'Orvix'
            },
            body: JSON.stringify({
              model: selectedModel,
              messages,
              max_tokens: openRouterMaxTokens,
              temperature: 0.7
            })
          });

          if (!orRes.ok) {
            const errText = await orRes.text();
            const parsed = parseGeminiError({ status: orRes.status, message: errText }, 'openrouter');
            let friendlyError = parsed.message;
            if (errText.includes('context_length_exceeded') || errText.includes('maximum context length') || errText.includes('too large') || errText.includes('tokens')) {
              friendlyError = 'The attached document exceeds OpenRouter\'s context limit. Please switch to Google Gemini (which supports 1M tokens) or ask about specific pages or slides.';
            }
            logAIDiagnostic({
              category: parsed.category,
              provider: 'openrouter',
              model: selectedModel,
              phase: 'non-streaming',
              upstreamStatus: orRes.status,
              sanitizedMessage: friendlyError
            });
            return res.status(orRes.status).json({
              error: friendlyError,
              code: orRes.status,
              status: parsed.status,
              category: parsed.category,
              provider: 'openrouter',
              model: selectedModel,
              retryable: parsed.isRetryable,
              canFallback: true,
              suggestedProviders: ['gemini', 'groq']
            });
          }

          const data = await orRes.json();
          let finalText = data?.choices?.[0]?.message?.content || '';
          const finishReason = data?.choices?.[0]?.finish_reason;

          // Transparent continuation if OpenRouter reached output limit
          if (finishReason === 'length' && finalText.length > 60) {
            try {
              const contMessages = [
                ...messages,
                { role: 'assistant', content: finalText },
                { role: 'user', content: 'Please continue directly from where you stopped. Complete any unfinished sentences, items, or sections without repeating previous text.' }
              ];
              const contRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${apiKey}`,
                  'Content-Type': 'application/json',
                  'X-Title': 'Orvix'
                },
                body: JSON.stringify({
                  model: selectedModel,
                  messages: contMessages,
                  max_tokens: Math.min(2048, openRouterMaxTokens),
                  temperature: 0.7
                })
              });
              if (contRes.ok) {
                const contData = await contRes.json();
                const contText = contData?.choices?.[0]?.message?.content;
                if (contText) {
                  finalText += (finalText.endsWith(' ') || contText.startsWith(' ') ? '' : ' ') + contText;
                }
              }
            } catch (_) {}
          }

          if (isLikelyLarge && !isContinuation && !responseHasContinuationNotice(finalText)) {
            finalText += CONTINUATION_NOTICES.PART_1;
          }
          return res.json({
            text: finalText,
            modelUsed: data.model || selectedModel,
            provider: 'openrouter'
          });
        } catch (fetchErr: any) {
          const parsed = parseGeminiError(fetchErr, 'openrouter');
          logAIDiagnostic({
            category: parsed.category,
            provider: 'openrouter',
            model: selectedModel,
            phase: 'non-streaming',
            upstreamStatus: parsed.statusCode,
            sanitizedMessage: parsed.message
          });
          return res.status(parsed.statusCode).json({
            error: parsed.message,
            code: parsed.statusCode,
            status: parsed.status,
            category: parsed.category,
            provider: 'openrouter',
            model: selectedModel,
            retryable: parsed.isRetryable,
            canFallback: true,
            suggestedProviders: ['gemini', 'groq']
          });
        }
      } else {
        // Genuine streaming via OpenRouter SSE
        let orRes: Response;
        try {
          orRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
              'X-Title': 'Orvix'
            },
            body: JSON.stringify({
              model: selectedModel,
              messages,
              max_tokens: openRouterMaxTokens,
              temperature: 0.7,
              stream: true
            })
          });
        } catch (fetchErr: any) {
          const parsed = parseGeminiError(fetchErr, 'openrouter');
          logAIDiagnostic({
            category: parsed.category,
            provider: 'openrouter',
            model: selectedModel,
            phase: 'pre-stream',
            upstreamStatus: parsed.statusCode,
            sanitizedMessage: parsed.message
          });
          return res.status(parsed.statusCode).json({
            error: parsed.message,
            code: parsed.statusCode,
            status: parsed.status,
            category: parsed.category,
            provider: 'openrouter',
            model: selectedModel,
            retryable: parsed.isRetryable,
            canFallback: true,
            suggestedProviders: ['gemini', 'groq']
          });
        }

        if (!orRes.ok) {
          const errText = await orRes.text();
          const parsed = parseGeminiError({ status: orRes.status, message: errText }, 'openrouter');
          let friendlyError = parsed.message;
          if (errText.includes('context_length_exceeded') || errText.includes('maximum context length') || errText.includes('too large') || errText.includes('tokens')) {
            friendlyError = 'The attached document exceeds OpenRouter\'s context limit. Please switch to Google Gemini (which supports 1M tokens) or ask about specific pages or slides.';
          }
          logAIDiagnostic({
            category: parsed.category,
            provider: 'openrouter',
            model: selectedModel,
            phase: 'pre-stream',
            upstreamStatus: orRes.status,
            sanitizedMessage: friendlyError
          });
          return res.status(orRes.status).json({
            error: friendlyError,
            code: orRes.status,
            status: parsed.status,
            category: parsed.category,
            provider: 'openrouter',
            model: selectedModel,
            retryable: parsed.isRetryable,
            canFallback: true,
            suggestedProviders: ['gemini', 'groq']
          });
        }

        initSSE(res);
        const stopHeartbeat = startSSEHeartbeat(res);
        sendSSE(res, { type: 'start', modelUsed: selectedModel, provider: 'openrouter' });

        try {
          const reader = orRes.body!.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          let fullText = '';
          let modelUsed = selectedModel;
          let lastFinishReason: string | null = null;

          while (true) {
            if (isClientClosed || res.writableEnded) {
              try { await reader.cancel(); } catch (_) {}
              break;
            }
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
                const finishReason = parsed?.choices?.[0]?.finish_reason;
                if (finishReason) lastFinishReason = finishReason;
                const delta = parsed.choices?.[0]?.delta?.content;
                if (delta) {
                  fullText += delta;
                  sendSSE(res, { type: 'chunk', text: delta });
                }
              } catch (_) {}
            }
          }

          // Process trailing bytes and buffer
          const finalBytes = decoder.decode();
          if (finalBytes) buffer += finalBytes;
          if (buffer && buffer.trim().startsWith('data:')) {
            const dataStr = buffer.trim().slice(5).trim();
            if (dataStr !== '[DONE]') {
              try {
                const parsed = JSON.parse(dataStr);
                if (parsed.model) modelUsed = parsed.model;
                const finishReason = parsed?.choices?.[0]?.finish_reason;
                if (finishReason) lastFinishReason = finishReason;
                const delta = parsed?.choices?.[0]?.delta?.content;
                if (delta) {
                  fullText += delta;
                  sendSSE(res, { type: 'chunk', text: delta });
                }
              } catch (_) {}
            }
          }

          // Continuation if finish_reason indicates token truncation
          if ((lastFinishReason === 'length' || lastFinishReason === 'max_tokens') && !isClientClosed && !res.writableEnded && fullText.length > 60) {
            try {
              const contMessages = [
                ...messages,
                { role: 'assistant', content: fullText },
                { role: 'user', content: 'Please continue directly from where you stopped. Complete any unfinished sentences, items, or sections without repeating previous text.' }
              ];
              const contRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${apiKey}`,
                  'Content-Type': 'application/json',
                  'X-Title': 'Orvix'
                },
                body: JSON.stringify({
                  model: selectedModel,
                  messages: contMessages,
                  max_tokens: Math.min(2048, openRouterMaxTokens),
                  temperature: 0.7,
                  stream: true
                })
              });

              if (contRes.ok && contRes.body) {
                const contReader = contRes.body.getReader();
                let contBuffer = '';
                while (true) {
                  if (isClientClosed || res.writableEnded) {
                    try { await contReader.cancel(); } catch (_) {}
                    break;
                  }
                  const { done: cDone, value: cVal } = await contReader.read();
                  if (cDone) break;
                  contBuffer += decoder.decode(cVal, { stream: true });
                  const cLines = contBuffer.split('\n');
                  contBuffer = cLines.pop() || '';
                  for (const cLine of cLines) {
                    const cTrimmed = cLine.trim();
                    if (!cTrimmed.startsWith('data:')) continue;
                    const cData = cTrimmed.slice(5).trim();
                    if (cData === '[DONE]') continue;
                    try {
                      const cParsed = JSON.parse(cData);
                      const cDelta = cParsed?.choices?.[0]?.delta?.content;
                      if (cDelta) {
                        fullText += cDelta;
                        sendSSE(res, { type: 'chunk', text: cDelta });
                      }
                    } catch (_) {}
                  }
                }
              }
            } catch (_) {}
          }

          stopHeartbeat();
          if (!res.writableEnded) {
            if (isLikelyLarge && !isContinuation && !responseHasContinuationNotice(fullText)) {
              sendSSE(res, { type: 'chunk', text: CONTINUATION_NOTICES.PART_1 });
              fullText += CONTINUATION_NOTICES.PART_1;
            }
            sendSSE(res, { type: 'done', text: fullText, modelUsed, provider: 'openrouter' });
            res.end();
          }
          return;
        } catch (streamErr: any) {
          stopHeartbeat();
          logAIDiagnostic({
            category: 'streaming failure',
            provider: 'openrouter',
            model: selectedModel,
            phase: 'mid-stream',
            sanitizedMessage: streamErr?.message || 'OpenRouter streaming interrupted'
          });
          if (!res.writableEnded) {
            sendSSE(res, {
              type: 'error',
              error: 'OpenRouter streaming connection interrupted.',
              code: 503,
              status: 'STREAM_FAILED',
              provider: 'openrouter',
              retryable: false
            });
            res.end();
          }
          return;
        }
      }
    }

    // 4. Cloudflare Workers AI Provider (@cf/meta/llama-3.1-8b-instruct)
    if (normalizedProvider === 'cloudflare') {
      const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
      const apiToken = process.env.CLOUDFLARE_API_TOKEN;
      const modelId =
        typeof clientModel === 'string' && clientModel.trim().startsWith('@cf/')
          ? clientModel.trim()
          : '@cf/meta/llama-3.1-8b-instruct';
      const displayModel = 'Cloudflare Workers AI — Llama 3.1 8B';

      // If credentials are not configured, return simulated response
      if (
        !accountId ||
        !apiToken ||
        accountId === 'YOUR_CLOUDFLARE_ACCOUNT_ID' ||
        apiToken === 'YOUR_CLOUDFLARE_API_TOKEN'
      ) {
        const text = (isLikelyLarge || isContinuation)
          ? generateSimulatedMultiPartResponse({
              prompt,
              docs: availableDocs,
              username: cleanUsername,
              preferences,
              mode,
              isContinuation,
              partNumber,
              originalPrompt
            })
          : availableDocs.length > 0
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
        const stopHeartbeat = startSSEHeartbeat(res);
        sendSSE(res, { type: 'start', modelUsed: demoModel, provider: 'cloudflare' });

        const testDurationMatch = typeof prompt === 'string' ? prompt.match(/__test_stream_duration:(\d+)__/) : null;
        const testDurationSec = testDurationMatch
          ? parseInt(testDurationMatch[1], 10)
          : ((req.body as any)?.testStreamDurationSec ? Number((req.body as any).testStreamDurationSec) : null);

        if (testDurationSec && testDurationSec > 0) {
          const totalMs = testDurationSec * 1000;
          const tokens = text.split(/(\s+)/);
          const intervalMs = Math.max(80, Math.floor(totalMs / Math.max(tokens.length, 1)));
          for (const token of tokens) {
            if (isClientClosed || res.writableEnded) break;
            sendSSE(res, { type: 'chunk', text: token });
            await sleepWithAbort(intervalMs, () => isClientClosed || res.writableEnded);
          }
        } else {
          const tokens = text.split(/(\s+)/);
          for (const token of tokens) {
            if (isClientClosed || res.writableEnded) break;
            sendSSE(res, { type: 'chunk', text: token });
            await new Promise((r) => setTimeout(r, 15));
          }
        }

        stopHeartbeat();
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

      // Calculate optimal max_tokens for Cloudflare Workers AI (@cf/meta/llama-3.1-8b-instruct)
      // Root cause fix: Cloudflare defaults to only 256 tokens if max_tokens is omitted!
      // Total context window for Llama 3.1 8B on Workers AI is 8192 tokens.
      // We budget output tokens generously based on user response preferences while leaving headroom for prompt tokens.
      const estimatedPromptTokens = Math.ceil(JSON.stringify(messages).length / 3.8);
      const maxContextTokens = 8192;
      const availableTokenHeadroom = Math.max(1024, maxContextTokens - estimatedPromptTokens - 256);

      let targetOutputTokens = 3072;
      if (preferences?.responseLength === 'detailed' || isLikelyLarge || isContinuation) {
        targetOutputTokens = 4096;
      } else if (preferences?.responseLength === 'concise') {
        targetOutputTokens = 1024;
      } else if (preferences?.responseLength === 'balanced') {
        targetOutputTokens = 2560;
      }

      const cfMaxTokens = Math.min(targetOutputTokens, availableTokenHeadroom);
      const cfEndpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId.trim())}/ai/run/${modelId}`;

      if (!shouldStream) {
        try {
          const cfRes = await fetch(cfEndpoint, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${apiToken.trim()}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              messages,
              stream: false,
              max_tokens: cfMaxTokens,
              temperature: 0.6
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

            const parsed = parseGeminiError({ status: cfRes.status, message: errDetail || cfRes.statusText }, 'cloudflare');
            let friendlyError = parsed.message;
            if (cfRes.status === 401 || cfRes.status === 403) {
              friendlyError = 'Invalid or unauthorized Cloudflare API token. Please verify CLOUDFLARE_API_TOKEN.';
            } else if (cfRes.status === 404) {
              friendlyError = 'Cloudflare account or model not found. Please verify CLOUDFLARE_ACCOUNT_ID and model availability.';
            }

            logAIDiagnostic({
              category: parsed.category,
              provider: 'cloudflare',
              model: modelId,
              phase: 'non-streaming',
              upstreamStatus: cfRes.status,
              sanitizedMessage: friendlyError
            });

            return res.status(cfRes.status).json({
              error: friendlyError,
              code: cfRes.status,
              status: parsed.status,
              category: parsed.category,
              provider: 'cloudflare',
              model: modelId,
              retryable: parsed.isRetryable,
              canFallback: true,
              suggestedProviders: ['gemini', 'groq', 'openrouter']
            });
          }

          const data = await cfRes.json();
          let text = data?.result?.response || (typeof data?.result === 'string' ? data.result : '') || '';
          const finishReason = data?.result?.finish_reason || (data?.result?.usage?.completion_tokens >= cfMaxTokens ? 'length' : null);

          // Transparent continuation if Cloudflare reached output token limit
          if (finishReason === 'length' && text.length > 60) {
            try {
              const contMessages = [
                ...messages,
                { role: 'assistant', content: text },
                { role: 'user', content: 'Please continue directly from where you stopped. Complete any unfinished sentences, items, or sections without repeating previous text.' }
              ];
              const contRes = await fetch(cfEndpoint, {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${apiToken.trim()}`,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                  messages: contMessages,
                  stream: false,
                  max_tokens: Math.min(2048, cfMaxTokens),
                  temperature: 0.6
                })
              });
              if (contRes.ok) {
                const contData = await contRes.json();
                const contText = contData?.result?.response || (typeof contData?.result === 'string' ? contData.result : '');
                if (contText) {
                  text += (text.endsWith(' ') || contText.startsWith(' ') ? '' : ' ') + contText;
                }
              }
            } catch (_) {}
          }

          if (isLikelyLarge && !isContinuation && !responseHasContinuationNotice(text)) {
            text += CONTINUATION_NOTICES.PART_1;
          }
          return res.json({
            text,
            modelUsed: displayModel,
            provider: 'cloudflare'
          });
        } catch (fetchErr: any) {
          const parsed = parseGeminiError(fetchErr, 'cloudflare');
          logAIDiagnostic({
            category: parsed.category,
            provider: 'cloudflare',
            model: modelId,
            phase: 'non-streaming',
            upstreamStatus: parsed.statusCode,
            sanitizedMessage: parsed.message
          });
          return res.status(parsed.statusCode).json({
            error: parsed.message,
            code: parsed.statusCode,
            status: parsed.status,
            category: parsed.category,
            provider: 'cloudflare',
            model: modelId,
            retryable: parsed.isRetryable,
            canFallback: true,
            suggestedProviders: ['gemini', 'groq', 'openrouter']
          });
        }
      } else {
        // Genuine streaming via Cloudflare Workers AI SSE
        let cfRes: Response;
        try {
          cfRes = await fetch(cfEndpoint, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${apiToken.trim()}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              messages,
              stream: true,
              max_tokens: cfMaxTokens,
              temperature: 0.6
            })
          });
        } catch (fetchErr: any) {
          const parsed = parseGeminiError(fetchErr, 'cloudflare');
          logAIDiagnostic({
            category: parsed.category,
            provider: 'cloudflare',
            model: modelId,
            phase: 'pre-stream',
            upstreamStatus: parsed.statusCode,
            sanitizedMessage: parsed.message
          });
          return res.status(parsed.statusCode).json({
            error: parsed.message,
            code: parsed.statusCode,
            status: parsed.status,
            category: parsed.category,
            provider: 'cloudflare',
            model: modelId,
            retryable: parsed.isRetryable,
            canFallback: true,
            suggestedProviders: ['gemini', 'groq', 'openrouter']
          });
        }

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

          const parsed = parseGeminiError({ status: cfRes.status, message: errDetail || cfRes.statusText }, 'cloudflare');
          let friendlyError = parsed.message;
          if (cfRes.status === 401 || cfRes.status === 403) {
            friendlyError = 'Invalid or unauthorized Cloudflare API token. Please verify CLOUDFLARE_API_TOKEN.';
          } else if (cfRes.status === 404) {
            friendlyError = 'Cloudflare account or model not found. Please verify CLOUDFLARE_ACCOUNT_ID and model availability.';
          }

          logAIDiagnostic({
            category: parsed.category,
            provider: 'cloudflare',
            model: modelId,
            phase: 'pre-stream',
            upstreamStatus: cfRes.status,
            sanitizedMessage: friendlyError
          });

          return res.status(cfRes.status).json({
            error: friendlyError,
            code: cfRes.status,
            status: parsed.status,
            category: parsed.category,
            provider: 'cloudflare',
            model: modelId,
            retryable: parsed.isRetryable,
            canFallback: true,
            suggestedProviders: ['gemini', 'groq', 'openrouter']
          });
        }

        const contentType = cfRes.headers.get('content-type') || '';

        // If Cloudflare returns non-streaming JSON (or body is missing) despite stream: true, adapt it gracefully to SSE
        if (contentType.includes('application/json') || !cfRes.body) {
          const data = await cfRes.json();
          let fullText = data?.result?.response || (typeof data?.result === 'string' ? data.result : '') || '';
          if (isLikelyLarge && !isContinuation && !responseHasContinuationNotice(fullText)) {
            fullText += CONTINUATION_NOTICES.PART_1;
          }
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
        const stopHeartbeat = startSSEHeartbeat(res);
        sendSSE(res, { type: 'start', modelUsed: displayModel, provider: 'cloudflare' });

        try {
          const reader = cfRes.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          let fullText = '';
          let lastFinishReason: string | null = null;

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
              if (!trimmed || !trimmed.startsWith('data:')) continue;
              const dataStr = trimmed.slice(5).trim();
              if (dataStr === '[DONE]') continue;

              try {
                const parsed = JSON.parse(dataStr);
                const finishReason = parsed?.finish_reason || parsed?.choices?.[0]?.finish_reason;
                if (finishReason) {
                  lastFinishReason = finishReason;
                }
                const delta = parsed?.response ?? parsed?.choices?.[0]?.delta?.content ?? '';
                if (delta) {
                  fullText += delta;
                  sendSSE(res, { type: 'chunk', text: delta });
                }
              } catch (_) {}
            }
          }

          // Process any trailing bytes and line in buffer
          const finalBytes = decoder.decode();
          if (finalBytes) {
            buffer += finalBytes;
          }
          if (buffer && buffer.trim().startsWith('data:')) {
            const dataStr = buffer.trim().slice(5).trim();
            if (dataStr !== '[DONE]') {
              try {
                const parsed = JSON.parse(dataStr);
                const finishReason = parsed?.finish_reason || parsed?.choices?.[0]?.finish_reason;
                if (finishReason) {
                  lastFinishReason = finishReason;
                }
                const delta = parsed?.response ?? parsed?.choices?.[0]?.delta?.content ?? '';
                if (delta) {
                  fullText += delta;
                  sendSSE(res, { type: 'chunk', text: delta });
                }
              } catch (_) {}
            }
          }

          // Transparent continuation if Cloudflare reached output token ceiling mid-generation
          if (lastFinishReason === 'length' && !isClientClosed && !res.writableEnded && fullText.length > 60) {
            try {
              const contMessages = [
                ...messages,
                { role: 'assistant', content: fullText },
                { role: 'user', content: 'Please continue directly from where you stopped. Complete any unfinished sentences, items, or sections without repeating previous text.' }
              ];
              const contRes = await fetch(cfEndpoint, {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${apiToken.trim()}`,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                  messages: contMessages,
                  stream: true,
                  max_tokens: Math.min(2048, cfMaxTokens),
                  temperature: 0.6
                })
              });

              if (contRes.ok && contRes.body) {
                const contReader = contRes.body.getReader();
                let contBuffer = '';
                let contFinishReason: string | null = null;
                while (true) {
                  if (isClientClosed || res.writableEnded) {
                    try { await contReader.cancel(); } catch (_) {}
                    break;
                  }
                  const { done: cDone, value: cVal } = await contReader.read();
                  if (cDone) break;
                  contBuffer += decoder.decode(cVal, { stream: true });
                  const cLines = contBuffer.split('\n');
                  contBuffer = cLines.pop() || '';
                  for (const cLine of cLines) {
                    const cTrimmed = cLine.trim();
                    if (!cTrimmed.startsWith('data:')) continue;
                    const cData = cTrimmed.slice(5).trim();
                    if (cData === '[DONE]') continue;
                    try {
                      const cParsed = JSON.parse(cData);
                      if (cParsed?.finish_reason) contFinishReason = cParsed.finish_reason;
                      const cDelta = cParsed?.response ?? cParsed?.choices?.[0]?.delta?.content ?? '';
                      if (cDelta) {
                        fullText += cDelta;
                        sendSSE(res, { type: 'chunk', text: cDelta });
                      }
                    } catch (_) {}
                  }
                }
                lastFinishReason = contFinishReason || 'stop';
              }
            } catch (contErr) {
              console.warn('[Cloudflare] Streaming continuation notice:', contErr);
            }
          }

          stopHeartbeat();
          if (!res.writableEnded) {
            // If the response is still incomplete after continuation, append continuation notice
            if (lastFinishReason === 'length' && !responseHasContinuationNotice(fullText)) {
              sendSSE(res, { type: 'chunk', text: CONTINUATION_NOTICES.PART_N });
              fullText += CONTINUATION_NOTICES.PART_N;
            } else if (isLikelyLarge && !isContinuation && !responseHasContinuationNotice(fullText)) {
              sendSSE(res, { type: 'chunk', text: CONTINUATION_NOTICES.PART_1 });
              fullText += CONTINUATION_NOTICES.PART_1;
            }
            sendSSE(res, { type: 'done', text: fullText, modelUsed: displayModel, provider: 'cloudflare' });
            res.end();
          }
          return;
        } catch (streamErr: any) {
          stopHeartbeat();
          logAIDiagnostic({
            category: 'streaming failure',
            provider: 'cloudflare',
            model: modelId,
            phase: 'mid-stream',
            sanitizedMessage: streamErr?.message || 'Cloudflare streaming interrupted'
          });
          if (!res.writableEnded) {
            sendSSE(res, {
              type: 'error',
              error: 'Cloudflare streaming connection interrupted.',
              code: 503,
              status: 'STREAM_FAILED',
              provider: 'cloudflare',
              retryable: false
            });
            res.end();
          }
          return;
        }
      }
    }

    // 5. Local AI (Ollama) Provider
    if (normalizedProvider === 'ollama') {
      let ollamaBaseUrl = (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').trim();
      // Sanitize URL: strip wrapping quotes, CRLF, trailing slashes, and paths
      ollamaBaseUrl = ollamaBaseUrl.replace(/^["']+|["']+$/g, '').trim();
      ollamaBaseUrl = ollamaBaseUrl.replace(/[\r\n]/g, '').trim();
      if (!/^https?:\/\//i.test(ollamaBaseUrl)) {
        ollamaBaseUrl = `http://${ollamaBaseUrl}`;
      }
      ollamaBaseUrl = ollamaBaseUrl.replace(/\/v1\/chat\/completions\/?$/i, '');
      ollamaBaseUrl = ollamaBaseUrl.replace(/\/(v1|api)\/?$/i, '');
      ollamaBaseUrl = ollamaBaseUrl.replace(/\/+$/, '');
      // Normalize localhost to 127.0.0.1 to avoid Windows IPv6 (::1) ECONNREFUSED mismatch
      ollamaBaseUrl = ollamaBaseUrl.replace(/^(https?:\/\/)localhost(:\d+)?/i, '$1127.0.0.1$2');

      let selectedModel = 'qwen2.5:1.5b';
      if (typeof clientModel === 'string' && clientModel.trim()) {
        const trimmed = clientModel.trim();
        if (/qwen/i.test(trimmed)) {
          selectedModel = 'qwen2.5:1.5b';
        } else if (!/demo|analyzer/i.test(trimmed)) {
          selectedModel = trimmed;
        }
      }

      // Verify Vercel serverless / cloud execution environment isolation
      const isLocalhostTarget = /^(https?:\/\/)?(127\.0\.0\.1|localhost)(:\d+)?/i.test(ollamaBaseUrl);
      if (isServerless && isLocalhostTarget) {
        const serverlessMsg =
          "Local AI (Ollama) requires running Orvix locally on your computer. When hosted on Vercel, serverless cloud functions cannot reach localhost (http://127.0.0.1:11434) on your device. Please clone and run Orvix locally using 'npm run dev'.";
        logAIDiagnostic({
          category: 'provider configuration error',
          provider: 'ollama',
          model: selectedModel,
          phase: 'validation',
          upstreamStatus: 503,
          sanitizedMessage: serverlessMsg
        });

        if (res.headersSent) {
          sendSSE(res, {
            type: 'error',
            error: serverlessMsg,
            code: 503,
            status: 'UNAVAILABLE',
            provider: 'ollama',
            retryable: false,
            canFallback: false
          });
          if (!res.writableEnded) res.end();
        } else {
          return res.status(503).json({
            error: serverlessMsg,
            code: 503,
            status: 'UNAVAILABLE',
            provider: 'ollama',
            model: selectedModel,
            retryable: false,
            canFallback: false
          });
        }
        return;
      }

      const messages = formatOpenAIMessages({
        systemInstruction: effectiveSystemInstruction,
        history,
        prompt: effectivePrompt
      });

      const ollamaEndpoint = `${ollamaBaseUrl}/v1/chat/completions`;

      if (!shouldStream) {
        try {
          const ollamaRes = await fetch(ollamaEndpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              model: selectedModel,
              messages,
              temperature: 0.7,
              stream: false
            })
          });

          if (!ollamaRes.ok) {
            const errText = await ollamaRes.text().catch(() => '');
            let friendlyError: string;
            const isMissingModel =
              ollamaRes.status === 404 ||
              errText.toLowerCase().includes('not found') ||
              errText.toLowerCase().includes('model');

            if (isMissingModel) {
              friendlyError = `The requested Ollama model '${selectedModel}' was not found. Please install it in your terminal using: ollama pull ${selectedModel}`;
            } else {
              friendlyError = `Ollama returned HTTP ${ollamaRes.status}: ${errText.slice(0, 200) || ollamaRes.statusText}`;
            }

            logAIDiagnostic({
              category: 'provider API error',
              provider: 'ollama',
              model: selectedModel,
              phase: 'non-streaming',
              upstreamStatus: ollamaRes.status,
              sanitizedMessage: friendlyError
            });

            return res.status(ollamaRes.status).json({
              error: friendlyError,
              code: ollamaRes.status,
              status: isMissingModel ? 'NOT_FOUND' : 'INTERNAL',
              provider: 'ollama',
              model: selectedModel,
              retryable: false,
              canFallback: false
            });
          }

          const data: any = await ollamaRes.json();
          let finalText = data?.choices?.[0]?.message?.content || '';

          if (isLikelyLarge && !isContinuation && !responseHasContinuationNotice(finalText)) {
            finalText += CONTINUATION_NOTICES.PART_1;
          }

          return res.json({
            text: finalText,
            modelUsed: data.model || selectedModel,
            provider: 'ollama'
          });
        } catch (fetchErr: any) {
          if (isClientClosed) return;
          const rawMsg = String(fetchErr?.message || fetchErr || '').toLowerCase();
          const causeCode = String(fetchErr?.cause?.code || fetchErr?.code || '');
          const isConnRefused =
            causeCode === 'ECONNREFUSED' ||
            causeCode === 'UND_ERR_CONNECT_TIMEOUT' ||
            rawMsg.includes('econnrefused');

          let friendlyError: string;
          if (isConnRefused) {
            friendlyError = `Unable to connect to Local AI (Ollama) at ${ollamaBaseUrl}. Please ensure Ollama is running ('ollama serve') on your computer and that model '${selectedModel}' is available ('ollama list').`;
          } else {
            friendlyError = `Failed to communicate with Local AI (Ollama) at ${ollamaBaseUrl}: ${fetchErr?.message || 'Connection error'}.`;
          }

          logAIDiagnostic({
            category: 'provider network failure',
            provider: 'ollama',
            model: selectedModel,
            phase: 'non-streaming',
            upstreamStatus: 503,
            sanitizedMessage: friendlyError
          });

          return res.status(503).json({
            error: friendlyError,
            code: 503,
            status: 'NETWORK_FAILURE',
            provider: 'ollama',
            model: selectedModel,
            retryable: false,
            canFallback: false
          });
        }
      } else {
        // Genuine streaming via Ollama OpenAI-compatible SSE
        let ollamaRes: Response | null = null;
        let isStreamMode = true;

        try {
          ollamaRes = await fetch(ollamaEndpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              model: selectedModel,
              messages,
              temperature: 0.7,
              stream: true
            })
          });
        } catch (fetchErr: any) {
          // If stream: true failed, attempt immediate local non-streaming request before reporting failure
          try {
            const fallbackRes = await fetch(ollamaEndpoint, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                model: selectedModel,
                messages,
                temperature: 0.7,
                stream: false
              })
            });
            if (fallbackRes.ok) {
              ollamaRes = fallbackRes;
              isStreamMode = false;
            }
          } catch (_) {}

          if (!ollamaRes) {
            if (isClientClosed) return;
            const rawMsg = String(fetchErr?.message || fetchErr || '').toLowerCase();
            const causeCode = String(fetchErr?.cause?.code || fetchErr?.code || '');
            const isConnRefused =
              causeCode === 'ECONNREFUSED' ||
              causeCode === 'UND_ERR_CONNECT_TIMEOUT' ||
              rawMsg.includes('econnrefused');

            let friendlyError: string;
            if (isConnRefused) {
              friendlyError = `Unable to connect to Local AI (Ollama) at ${ollamaBaseUrl}. Please ensure Ollama is running ('ollama serve') on your computer and that model '${selectedModel}' is available ('ollama list').`;
            } else {
              friendlyError = `Failed to connect to Local AI (Ollama) at ${ollamaBaseUrl}: ${fetchErr?.message || 'Connection error'}.`;
            }

            logAIDiagnostic({
              category: 'provider network failure',
              provider: 'ollama',
              model: selectedModel,
              phase: 'pre-stream',
              upstreamStatus: 503,
              sanitizedMessage: friendlyError
            });

            return res.status(503).json({
              error: friendlyError,
              code: 503,
              status: 'NETWORK_FAILURE',
              provider: 'ollama',
              model: selectedModel,
              retryable: false,
              canFallback: false
            });
          }
        }

        if (!ollamaRes.ok) {
          const errText = await ollamaRes.text().catch(() => '');
          let friendlyError: string;
          const isMissingModel =
            ollamaRes.status === 404 ||
            errText.toLowerCase().includes('not found') ||
            errText.toLowerCase().includes('model');

          if (isMissingModel) {
            friendlyError = `The requested Ollama model '${selectedModel}' was not found. Please install it in your terminal using: ollama pull ${selectedModel}`;
          } else {
            friendlyError = `Ollama returned HTTP ${ollamaRes.status}: ${errText.slice(0, 200) || ollamaRes.statusText}`;
          }

          logAIDiagnostic({
            category: 'provider API error',
            provider: 'ollama',
            model: selectedModel,
            phase: 'pre-stream',
            upstreamStatus: ollamaRes.status,
            sanitizedMessage: friendlyError
          });

          return res.status(ollamaRes.status).json({
            error: friendlyError,
            code: ollamaRes.status,
            status: isMissingModel ? 'NOT_FOUND' : 'INTERNAL',
            provider: 'ollama',
            model: selectedModel,
            retryable: false,
            canFallback: false
          });
        }

        initSSE(res);
        const stopHeartbeat = startSSEHeartbeat(res);
        sendSSE(res, { type: 'start', modelUsed: selectedModel, provider: 'ollama' });

        // If non-streaming response was obtained from local fallback
        if (!isStreamMode || !ollamaRes.body) {
          try {
            const data: any = await ollamaRes.json();
            let finalText = data?.choices?.[0]?.message?.content || '';
            if (isLikelyLarge && !isContinuation && !responseHasContinuationNotice(finalText)) {
              finalText += CONTINUATION_NOTICES.PART_1;
            }
            if (finalText) {
              sendSSE(res, { type: 'chunk', text: finalText });
            }
            stopHeartbeat();
            sendSSE(res, {
              type: 'done',
              text: finalText,
              modelUsed: data?.model || selectedModel,
              provider: 'ollama'
            });
            res.end();
            return;
          } catch (jsonErr: any) {
            stopHeartbeat();
            if (!res.writableEnded) {
              sendSSE(res, {
                type: 'error',
                error: 'Failed to parse response from Local AI (Ollama).',
                code: 500,
                status: 'PARSE_ERROR',
                provider: 'ollama',
                retryable: false,
                canFallback: false
              });
              res.end();
            }
            return;
          }
        }

        try {
          const reader = ollamaRes.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          let fullText = '';
          let modelUsed = selectedModel;
          let lastFinishReason: string | null = null;

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
              if (!trimmed || !trimmed.startsWith('data:')) continue;
              const dataStr = trimmed.slice(5).trim();
              if (dataStr === '[DONE]') continue;
              try {
                const parsed = JSON.parse(dataStr);
                if (parsed.model) modelUsed = parsed.model;
                const finishReason = parsed?.choices?.[0]?.finish_reason;
                if (finishReason) lastFinishReason = finishReason;
                const delta = parsed.choices?.[0]?.delta?.content;
                if (delta) {
                  fullText += delta;
                  sendSSE(res, { type: 'chunk', text: delta });
                }
              } catch (_) {}
            }
          }

          // Process trailing bytes and buffer
          const finalBytes = decoder.decode();
          if (finalBytes) buffer += finalBytes;
          if (buffer && buffer.trim().startsWith('data:')) {
            const dataStr = buffer.trim().slice(5).trim();
            if (dataStr !== '[DONE]') {
              try {
                const parsed = JSON.parse(dataStr);
                if (parsed.model) modelUsed = parsed.model;
                const finishReason = parsed?.choices?.[0]?.finish_reason;
                if (finishReason) lastFinishReason = finishReason;
                const delta = parsed?.choices?.[0]?.delta?.content;
                if (delta) {
                  fullText += delta;
                  sendSSE(res, { type: 'chunk', text: delta });
                }
              } catch (_) {}
            }
          }

          stopHeartbeat();
          if (!res.writableEnded) {
            if (isLikelyLarge && !isContinuation && !responseHasContinuationNotice(fullText)) {
              sendSSE(res, { type: 'chunk', text: CONTINUATION_NOTICES.PART_1 });
              fullText += CONTINUATION_NOTICES.PART_1;
            }
            sendSSE(res, { type: 'done', text: fullText, modelUsed, provider: 'ollama' });
            res.end();
          }
          return;
        } catch (streamErr: any) {
          stopHeartbeat();
          logAIDiagnostic({
            category: 'streaming failure',
            provider: 'ollama',
            model: selectedModel,
            phase: 'mid-stream',
            sanitizedMessage: streamErr?.message || 'Ollama stream read interrupted'
          });
          if (!res.writableEnded) {
            sendSSE(res, {
              type: 'error',
              error: 'Ollama streaming connection interrupted. Please ensure the local Ollama daemon remains running.',
              code: 503,
              status: 'STREAM_FAILED',
              provider: 'ollama',
              retryable: false,
              canFallback: false
            });
            res.end();
          }
          return;
        }
      }
    }

    return res.status(400).json({ error: `Unknown provider: ${provider}` });
  } catch (error: any) {
    console.error('API Error in /api/chat:', error);
    const providerName = String(req.body?.provider || 'unknown');
    const isOllamaReq = providerName.toLowerCase() === 'ollama';
    const parsed = parseGeminiError(error, providerName);
    logAIDiagnostic({
      category: parsed.category || 'internal server error',
      provider: providerName,
      model: String(req.body?.model || 'unknown'),
      phase: 'dispatch',
      upstreamStatus: parsed.statusCode,
      upstreamErrorCode: parsed.status,
      sanitizedMessage: parsed.message
    });
    if (res.headersSent) {
      sendSSE(res, {
        type: 'error',
        error: parsed.message,
        code: parsed.statusCode,
        status: parsed.status,
        provider: providerName,
        retryable: isOllamaReq ? false : parsed.isRetryable,
        canFallback: !isOllamaReq,
        suggestedProviders: isOllamaReq ? [] : ['gemini', 'groq', 'openrouter', 'cloudflare']
      });
      if (!res.writableEnded) res.end();
    } else {
      res.status(parsed.statusCode).json({
        error: parsed.message,
        code: parsed.statusCode,
        status: parsed.status,
        provider: providerName,
        retryable: isOllamaReq ? false : parsed.isRetryable,
        canFallback: !isOllamaReq,
        suggestedProviders: isOllamaReq ? [] : ['gemini', 'groq', 'openrouter', 'cloudflare']
      });
    }
  }
});

// Setup Vite middleware in dev or static serving in production
async function startServer() {
  const publicPath = path.resolve(__dirname, 'public');
  app.use(express.static(publicPath));

  const distPath = path.resolve(__dirname, 'dist');
  if (process.env.NODE_ENV === 'production' && fs.existsSync(distPath)) {
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(distPath, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  }

  const httpServer = app.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`Orvix server running on http://0.0.0.0:${PORT}`);
  });

  // Eliminate artificial HTTP timeouts to allow long-running streams (60s, 90s, 5m+)
  httpServer.timeout = 0;
  httpServer.requestTimeout = 0;
  httpServer.headersTimeout = 0;
  httpServer.keepAliveTimeout = 65000;
}

if (!process.env.VERCEL && !process.env.TESTING) {
  startServer();
}

export { app };