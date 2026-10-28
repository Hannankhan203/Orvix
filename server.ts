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
  formatOpenAIMessages,
  isVisionCapableProvider,
  isImageAttachment
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
// @ts-ignore - Shared attachment payload validation and vision image-part builder
import {
  buildVisionImageParts,
  MAX_VISION_IMAGE_BYTES,
  MAX_CHAT_REQUEST_BYTES
} from './src/services/attachmentStorageService.js';
// @ts-ignore - Shared provider configuration and model identifier validator
import {
  validateServerModelForProvider,
  validateGroqTranscriptionModel,
  GROQ_FALLBACK_CHAT_MODELS,
  getProviderDisplayName,
  PROVIDER_DEFAULT_MODELS
} from './src/services/providerModelSanitizer.js';

function getGroqApiBaseUrl(): string {
  const customBase = (process.env.ORVIX_GROQ_BASE_URL || '').trim().replace(/\/+$/, '');
  return customBase || 'https://api.groq.com/openai/v1';
}

function getOpenRouterApiBaseUrl(): string {
  const customBase = (process.env.ORVIX_OPENROUTER_BASE_URL || '').trim().replace(/\/+$/, '');
  return customBase || 'https://openrouter.ai/api/v1';
}

function getCloudflareApiBaseUrl(): string {
  const customBase = (process.env.ORVIX_CLOUDFLARE_BASE_URL || '').trim().replace(/\/+$/, '');
  return customBase || 'https://api.cloudflare.com/client/v4';
}

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
  base64?: string;
  data?: string;
  dataUrl?: string;
  type?: string;
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
  isVision?: boolean;
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

app.use(express.json({ limit: '25mb' }));

// Return structured JSON on oversized HTTP request bodies instead of default HTML 413 responses
app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err && (err.type === 'entity.too.large' || err.status === 413 || err.statusCode === 413)) {
    return res.status(413).json({
      error:
        'The request payload exceeds the maximum supported size (3.0 MB per image, 4.2 MB total chat request budget). Please resize or compress attached images and try again.',
      code: 413,
      status: 'PAYLOAD_TOO_LARGE',
      retryable: false,
      canFallback: false
    });
  }
  return next(err);
});

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
// Sanitizes error messages to ensure no API keys, tokens, or headers are ever logged or sent to users
export function sanitizeErrorLog(msg: string): string {
  if (!msg) return '';
  return String(msg)
    .replace(/Bearer\s+[A-Za-z0-9_\-\.]+/gi, 'Bearer [REDACTED]')
    .replace(/AIza[0-9A-Za-z_\-]{35}/g, '[REDACTED_API_KEY]')
    .replace(/gsk_[A-Za-z0-9_\-]{20,}/g, '[REDACTED_API_KEY]')
    .replace(/sk-or-[A-Za-z0-9_\-\.]{15,}/g, '[REDACTED_API_KEY]')
    .replace(/\bsk-[A-Za-z0-9_\-]{20,}/g, '[REDACTED_API_KEY]')
    .replace(/([?&]key=)[A-Za-z0-9_\-]+/gi, '$1[REDACTED]')
    .replace(/\b(GEMINI_API_KEY|GROQ_API_KEY|OPENROUTER_API_KEY|CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID)\s*=\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/(authorization:\s*)([^\r\n,;]+)/gi, '$1[REDACTED]');
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

const DEFAULT_UPSTREAM_HEADERS_TIMEOUT_MS = 30_000;
const SERVERLESS_UPSTREAM_HEADERS_TIMEOUT_MS = 25_000;

export function getUpstreamHeadersTimeoutMs(): number {
  const raw = Number(process.env.ORVIX_UPSTREAM_HEADERS_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  return isServerless ? SERVERLESS_UPSTREAM_HEADERS_TIMEOUT_MS : DEFAULT_UPSTREAM_HEADERS_TIMEOUT_MS;
}

export function isDemoModeEnabled(): boolean {
  return String(process.env.ORVIX_ENABLE_DEMO_MODE || '').trim().toLowerCase() === 'true';
}

const PROVIDER_ENV_REQUIREMENTS: Record<string, string> = {
  gemini: 'GEMINI_API_KEY',
  groq: 'GROQ_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  cloudflare: 'CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN'
};

function isConfiguredCredential(value: string): boolean {
  const trimmed = (value || '').trim();
  if (!trimmed) return false;
  if (/^(?:your|my|replace|insert|placeholder|enter)_[a-z0-9_]+$/i.test(trimmed)) {
    return false;
  }
  return true;
}

export function getServerProviderConfigStatus(serverlessRuntime = false) {
  const geminiKey = (process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY || '').trim();
  const groqKey = (process.env.GROQ_API_KEY || process.env.VITE_GROQ_API_KEY || '').trim();
  const openrouterKey = (process.env.OPENROUTER_API_KEY || process.env.VITE_OPENROUTER_API_KEY || '').trim();
  const cfAccountId = (process.env.CLOUDFLARE_ACCOUNT_ID || '').trim();
  const cfToken = (process.env.CLOUDFLARE_API_TOKEN || '').trim();

  const geminiConfigured = isConfiguredCredential(geminiKey);
  const groqConfigured = isConfiguredCredential(groqKey);
  const openrouterConfigured = isConfiguredCredential(openrouterKey);
  const cloudflareConfigured =
    isConfiguredCredential(cfAccountId) && isConfiguredCredential(cfToken);

  return {
    geminiConfigured,
    groqConfigured,
    openrouterConfigured,
    cloudflareConfigured,
    webllmSupported: true,
    demoModeEnabled: isDemoModeEnabled(),
    whisperConfigured: groqConfigured || geminiConfigured,
    whisperProvider: groqConfigured ? 'groq' : geminiConfigured ? 'gemini' : null
  };
}

export function getConfiguredFallbackProviders(excludeProvider: string, serverlessRuntime = false): string[] {
  const status = getServerProviderConfigStatus(serverlessRuntime);
  const candidates: string[] = [];
  if (status.geminiConfigured) candidates.push('gemini');
  if (status.groqConfigured) candidates.push('groq');
  if (status.openrouterConfigured) candidates.push('openrouter');
  if (status.cloudflareConfigured) candidates.push('cloudflare');
  if (status.webllmSupported) candidates.push('webllm');

  return candidates.filter((p) => p !== excludeProvider);
}

function sendProviderNotConfiguredError(
  res: express.Response,
  provider: string,
  serverlessRuntime = false
) {
  const displayProvider = getProviderDisplayName(provider);
  const envVarLabel = PROVIDER_ENV_REQUIREMENTS[provider] || 'provider API credentials';
  const errorMessage = `${displayProvider} is not configured on this server (missing ${envVarLabel}). Select an available provider from the model selector or configure ${envVarLabel} on the server.`;

  logAIDiagnostic({
    category: 'provider configuration error',
    provider,
    phase: 'configuration',
    upstreamStatus: 503,
    upstreamErrorCode: 'PROVIDER_NOT_CONFIGURED',
    sanitizedMessage: errorMessage,
    willRetry: false
  });

  return res.status(503).json({
    error: errorMessage,
    code: 503,
    status: 'PROVIDER_NOT_CONFIGURED',
    errorCode: 'PROVIDER_NOT_CONFIGURED',
    provider,
    retryable: false,
    canFallback: true,
    suggestedProviders: getConfiguredFallbackProviders(provider, serverlessRuntime)
  });
}

function createClientDisconnectedError(): Error {
  const err: any = new Error('Client disconnected before upstream response completed.');
  err.name = 'AbortError';
  err.code = 'CLIENT_DISCONNECTED';
  err.isClientDisconnected = true;
  return err;
}

function createUpstreamHeadersTimeoutError(provider: string, timeoutMs: number): Error {
  const displayProvider = getProviderDisplayName(provider);
  const seconds = Math.max(1, Math.round((timeoutMs / 1000) * 10) / 10);
  const err: any = new Error(
    `The request to ${displayProvider} timed out after ${seconds}s while waiting for initial response headers. Please try again.`
  );
  err.name = 'TimeoutError';
  err.status = 504;
  err.code = 'DEADLINE_EXCEEDED';
  err.isUpstreamHeadersTimeout = true;
  return err;
}

/**
 * Request-scoped upstream cancellation & initial header timeout guard.
 * Cancels outbound upstream requests immediately when the client disconnects
 * and bounds initial header wait time without cutting off active SSE streams after headers arrive.
 */
function createRequestUpstreamGuard(req: express.Request, res: express.Response) {
  let clientDisconnected = false;
  let cleanedUp = false;
  const activeControllers = new Set<AbortController>();
  const activeTimers = new Set<ReturnType<typeof setTimeout>>();

  const markDisconnected = () => {
    if (res.writableEnded) return;
    if (clientDisconnected) return;
    clientDisconnected = true;
    for (const ctrl of activeControllers) {
      try {
        ctrl.abort(createClientDisconnectedError());
      } catch (_) {}
    }
    activeControllers.clear();
  };

  const onResClose = () => {
    if (!res.writableEnded) {
      markDisconnected();
    }
  };

  const onReqAborted = () => {
    markDisconnected();
  };

  res.on('close', onResClose);
  req.on('aborted', onReqAborted);

  const isClientDisconnected = (err?: any): boolean => {
    if (clientDisconnected) return true;
    return Boolean(err?.isClientDisconnected || err?.code === 'CLIENT_DISCONNECTED');
  };

  const isUpstreamTimeout = (err?: any): boolean => {
    if (clientDisconnected) return false;
    return Boolean(
      err?.isUpstreamHeadersTimeout ||
        err?.name === 'TimeoutError' ||
        err?.code === 'DEADLINE_EXCEEDED'
    );
  };

  const fetchUpstream = async (
    url: string,
    init: RequestInit = {},
    options: { provider: string; headersTimeoutMs?: number } = { provider: 'AI Provider' }
  ): Promise<Response> => {
    if (clientDisconnected) {
      throw createClientDisconnectedError();
    }

    const timeoutMs = options.headersTimeoutMs ?? getUpstreamHeadersTimeoutMs();
    const controller = new AbortController();
    activeControllers.add(controller);
    let timedOut = false;

    const timer = setTimeout(() => {
      activeTimers.delete(timer);
      if (!clientDisconnected) {
        timedOut = true;
        try {
          controller.abort(createUpstreamHeadersTimeoutError(options.provider, timeoutMs));
        } catch (_) {}
      }
    }, timeoutMs);
    activeTimers.add(timer);

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal
      });
      clearTimeout(timer);
      activeTimers.delete(timer);
      if (clientDisconnected) {
        try {
          await response.body?.cancel();
        } catch (_) {}
        activeControllers.delete(controller);
        throw createClientDisconnectedError();
      }
      return response;
    } catch (err: any) {
      clearTimeout(timer);
      activeTimers.delete(timer);
      activeControllers.delete(controller);
      if (clientDisconnected || err?.isClientDisconnected) {
        throw createClientDisconnectedError();
      }
      if (timedOut || err?.isUpstreamHeadersTimeout) {
        throw createUpstreamHeadersTimeoutError(options.provider, timeoutMs);
      }
      throw err;
    }
  };

  const callGeminiWithGuard = async <T>(
    invoke: (signal: AbortSignal) => Promise<T>,
    options: { provider?: string; headersTimeoutMs?: number } = {}
  ): Promise<T> => {
    if (clientDisconnected) {
      throw createClientDisconnectedError();
    }

    const providerName = options.provider || 'gemini';
    const timeoutMs = options.headersTimeoutMs ?? getUpstreamHeadersTimeoutMs();
    const controller = new AbortController();
    activeControllers.add(controller);
    let timedOut = false;

    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        if (timer) activeTimers.delete(timer);
        if (!clientDisconnected) {
          timedOut = true;
          const timeoutErr = createUpstreamHeadersTimeoutError(providerName, timeoutMs);
          try {
            controller.abort(timeoutErr);
          } catch (_) {}
          reject(timeoutErr);
        } else {
          reject(createClientDisconnectedError());
        }
      }, timeoutMs);
      activeTimers.add(timer);
    });

    try {
      const result = await Promise.race([invoke(controller.signal), timeoutPromise]);
      if (timer) {
        clearTimeout(timer);
        activeTimers.delete(timer);
      }
      if (clientDisconnected) {
        activeControllers.delete(controller);
        throw createClientDisconnectedError();
      }
      return result;
    } catch (err: any) {
      if (timer) {
        clearTimeout(timer);
        activeTimers.delete(timer);
      }
      activeControllers.delete(controller);
      if (clientDisconnected || err?.isClientDisconnected) {
        throw createClientDisconnectedError();
      }
      if (timedOut || err?.isUpstreamHeadersTimeout) {
        throw createUpstreamHeadersTimeoutError(providerName, timeoutMs);
      }
      throw err;
    }
  };

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    res.off('close', onResClose);
    req.off('aborted', onReqAborted);
    for (const timer of activeTimers) {
      clearTimeout(timer);
    }
    activeTimers.clear();
    if (clientDisconnected) {
      for (const ctrl of activeControllers) {
        try {
          ctrl.abort();
        } catch (_) {}
      }
    }
    activeControllers.clear();
  };

  return {
    isClientClosed: () => clientDisconnected,
    isClientDisconnected,
    isUpstreamTimeout,
    fetchUpstream,
    callGeminiWithGuard,
    cleanup
  };
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

  if (isNetworkFailure) {
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

  // 6. Safety Filter Block
  if (
    lowerMsg.includes('safety') ||
    lowerMsg.includes('blocked due to safety') ||
    lowerMsg.includes('candidate was blocked') ||
    upperStatus === 'SAFETY' ||
    upperStatus === 'SAFETY_BLOCKED'
  ) {
    return {
      statusCode: 400,
      status: 'SAFETY_BLOCKED',
      category: 'request validation error',
      isUnavailable: false,
      isRetryable: false,
      message: "The response was blocked by Google Gemini's safety filters. Please rephrase your request.",
      retryAfterSeconds
    };
  }

  // 7. Model Not Found / Decommissioned Model
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

// API Config Check (indicates configured providers without leaking keys or secrets)
app.get(['/api/config', '/config'], (_req, res) => {
  try {
    return res.json(getServerProviderConfigStatus(isServerless));
  } catch (err) {
    console.warn('[Server] Error resolving provider config status:', err);
    return res.status(200).json({
      geminiConfigured: false,
      groqConfigured: false,
      openrouterConfigured: false,
      cloudflareConfigured: false,
      webllmSupported: true,
      demoModeEnabled: false,
      whisperConfigured: false,
      whisperProvider: null
    });
  }
});

/* ==========================================================================
   Controlled Temporary File Upload & Storage Management Architecture
   ========================================================================== */


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
  '.log': ['text/plain', 'text/x-log', 'application/octet-stream'],
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
    if (['.txt', '.log', '.md', '.markdown', '.csv', '.tsv', '.json', '.xml'].includes(ext)) {
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
        const isOfflineReq = req.query?.offline === 'true';
        const geminiKey = process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY || null;
        const imgExtraction = await extractImageText(
          inputSource,
          record.originalName,
          ext,
          record.mimeType,
          record.id,
          record.dimensions,
          geminiKey,
          { offline: isOfflineReq }
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
          const isOfflineUpload = String(req.body?.offline || '').toLowerCase() === 'true';
          const geminiKey = process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY || null;
          const imgExtraction = (await extractImageText(
            inputSource,
            rec.originalName,
            ext,
            rec.mimeType,
            rec.id,
            rec.dimensions,
            geminiKey,
            { offline: isOfflineUpload }
          )) as any;
          rec.extraction = imgExtraction;
          rec.status = imgExtraction?.status === 'error' ? 'error' : 'ready';
        } else {
          const isOfflineUpload = String(req.body?.offline || '').toLowerCase() === 'true';
          const geminiKey = process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY || null;
          const extraction = (await extractDocumentContent(
            inputSource,
            rec.originalName,
            ext,
            rec.mimeType,
            rec.id,
            { offline: isOfflineUpload, apiKey: geminiKey }
          )) as DocumentExtractionResult;
          rec.extraction = extraction;
          rec.status = extraction.success || extraction.status === 'scanned_or_image_only' || extraction.status === 'NO_TEXT_DETECTED' ? 'ready' : 'uploaded';
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
  'Orvix, AI conversation assistant. Technical vocabulary: JavaScript, TypeScript, React, Node.js, Python, palindrome, algorithms, data structures, async await, promises, functions, arrow functions, var, const, let, objects, arrays, callbacks, ECMAScript, CSS, HTML, API, JSON, programming terminology, code.';

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

    // Transcription model validation (separate audio transcription models from chat-completion models)
    const modelValidation = validateGroqTranscriptionModel(req.body?.model);
    if (!modelValidation.valid) {
      return res.status(400).json({
        success: false,
        error: modelValidation.error,
        code: modelValidation.code || 'INVALID_TRANSCRIPTION_MODEL',
        status: 'INVALID_ARGUMENT',
        provider: 'groq',
        retryable: false,
        fallbackAvailable: false
      });
    }
    const selectedTranscriptionModel = modelValidation.model;

    // Minimum audio payload size check if no transcript is provided
    const isTranscriptOnlyRequest = String(req.body?.transcriptOnly || '').toLowerCase() === 'true';
    const hasAudioPayload = Boolean(
      !isTranscriptOnlyRequest && audioFile && audioFile.buffer && audioFile.buffer.length >= 100
    );
    if (!incomingTranscript && !hasAudioPayload) {
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

    // Primary Audio Transcription Path: When audio payload is present, execute genuine Groq Whisper transcription
    if (hasAudioPayload && hasGroq) {
      try {
        const mime = (audioFile.mimetype || 'audio/webm').toLowerCase();
        let fileExt = '.webm';
        if (mime.includes('mp4') || mime.includes('m4a')) fileExt = '.m4a';
        else if (mime.includes('ogg')) fileExt = '.ogg';
        else if (mime.includes('wav')) fileExt = '.wav';
        else if (mime.includes('mpeg') || mime.includes('mp3')) fileExt = '.mp3';
        else if (mime.includes('aac')) fileExt = '.aac';
        else if (mime.includes('flac')) fileExt = '.flac';

        const safeFilename = audioFile.originalname && audioFile.originalname.includes('.')
          ? audioFile.originalname
          : `dictation-${Date.now()}${fileExt}`;

        const formData = new FormData();
        const audioBlob = new Blob([new Uint8Array(audioFile.buffer)], { type: mime });
        formData.append('file', audioBlob, safeFilename);
        formData.append('model', selectedTranscriptionModel);
        formData.append('temperature', '0');
        formData.append('response_format', 'verbose_json');
        if (isoLang) {
          formData.append('language', isoLang);
        }
        formData.append('prompt', effectivePrompt);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 35000); // 35s max timeout

        const groqRes = await fetch(`${getGroqApiBaseUrl()}/audio/transcriptions`, {
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
            model: selectedTranscriptionModel,
            provider: 'groq',
            highAccuracy: true
          });
        }

        const errStatus = groqRes.status;
        const errText = await groqRes.text().catch(() => '');
        let upstreamErrMsg = '';
        try {
          const parsedErr = JSON.parse(errText);
          if (typeof parsedErr?.error === 'string') {
            upstreamErrMsg = parsedErr.error;
          } else if (typeof parsedErr?.error?.message === 'string') {
            upstreamErrMsg = parsedErr.error.message;
          }
        } catch (_) {
          upstreamErrMsg = errText.slice(0, 200).trim();
        }

        logAIDiagnostic({
          category: 'provider API error',
          provider: 'groq',
          model: selectedTranscriptionModel,
          phase: 'dispatch',
          upstreamStatus: errStatus,
          sanitizedMessage: `Groq Whisper failed: ${(upstreamErrMsg || errText).slice(0, 200)}`
        });

        // Non-retryable authentication / permission / invalid-request / invalid-model failures
        if (errStatus === 401 || errStatus === 403) {
          return res.status(errStatus).json({
            success: false,
            error:
              upstreamErrMsg ||
              (errStatus === 401
                ? 'Groq API key is invalid or unauthorized for audio transcription.'
                : 'Groq API key does not have permission for audio transcription.'),
            code: errStatus === 401 ? 'UNAUTHENTICATED' : 'PERMISSION_DENIED',
            status: errStatus === 401 ? 'UNAUTHENTICATED' : 'PERMISSION_DENIED',
            provider: 'groq',
            model: selectedTranscriptionModel,
            statusCode: errStatus,
            retryable: false,
            fallbackAvailable: false
          });
        }

        if (errStatus === 400 || errStatus === 404 || errStatus === 413 || errStatus === 415 || errStatus === 422) {
          const isModelErr = errStatus === 404 || /model/i.test(upstreamErrMsg);
          return res.status(errStatus === 404 ? 404 : 400).json({
            success: false,
            error:
              upstreamErrMsg ||
              (isModelErr
                ? `Groq transcription model '${selectedTranscriptionModel}' was not found or is unsupported.`
                : 'Groq Whisper rejected the audio transcription request.'),
            code: isModelErr ? 'INVALID_TRANSCRIPTION_MODEL' : 'INVALID_AUDIO_REQUEST',
            status: errStatus === 404 ? 'NOT_FOUND' : 'INVALID_ARGUMENT',
            provider: 'groq',
            model: selectedTranscriptionModel,
            statusCode: errStatus,
            retryable: false,
            fallbackAvailable: false
          });
        }

        // If Groq rate-limited (429) or unavailable (5xx), attempt Gemini audio fallback only if available
        if (!hasGemini) {
          const isRateLimit = errStatus === 429;
          return res.status(isRateLimit ? 429 : 503).json({
            success: false,
            error: isRateLimit
              ? 'Groq Whisper rate limit exceeded. Native speech transcript retained.'
              : upstreamErrMsg || 'Groq Whisper service encountered an error. Native speech transcript retained.',
            code: isRateLimit ? 'RATE_LIMIT_EXCEEDED' : 'PROVIDER_ERROR',
            status: isRateLimit ? 'RESOURCE_EXHAUSTED' : 'UNAVAILABLE',
            provider: 'groq',
            model: selectedTranscriptionModel,
            statusCode: errStatus,
            retryable: true,
            fallbackAvailable: true
          });
        }
      } catch (groqErr: any) {
        logAIDiagnostic({
          category: 'provider API error',
          provider: 'groq',
          model: selectedTranscriptionModel,
          phase: 'dispatch',
          sanitizedMessage: groqErr?.message || 'Groq Whisper network error'
        });

        if (!hasGemini) {
          return res.status(504).json({
            success: false,
            error: groqErr?.name === 'AbortError'
              ? 'Whisper transcription timed out. Native speech transcript retained.'
              : 'Network error connecting to Whisper service. Native speech transcript retained.',
            code: groqErr?.name === 'AbortError' ? 'TRANSCRIPTION_TIMEOUT' : 'NETWORK_ERROR',
            status: groqErr?.name === 'AbortError' ? 'DEADLINE_EXCEEDED' : 'UNAVAILABLE',
            provider: 'groq',
            model: selectedTranscriptionModel,
            statusCode: 504,
            retryable: true,
            fallbackAvailable: true
          });
        }
      }
    }

    // Secondary Audio Path: Gemini Audio Recognition Fallback when audio payload exists
    if (hasAudioPayload && hasGemini) {
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
Preserve exact words, technical terminology (e.g. Orvix, JavaScript, TypeScript, React, palindrome, algorithms, data structures, async await, promises, functions, arrow functions, var, const, let, objects, arrays, callbacks, ECMAScript, code), and punctuation.
${isoLang ? `The spoken language is: ${isoLang}.` : ''}
Output ONLY the transcription text. Do not summarize, do not translate, do not add introductory commentary or timestamps.`;

        const transcriptionCandidates = ['gemini-3.5-transcribe', 'gemini-3.8-flash'];
        let geminiRes: any = null;
        let modelUsed = 'gemini-3.5-transcribe';
        let lastGeminiErr: any = null;

        for (const candidateModel of transcriptionCandidates) {
          try {
            geminiRes = await ai.models.generateContent({
              model: candidateModel,
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
            modelUsed = candidateModel;
            break;
          } catch (tErr: any) {
            lastGeminiErr = tErr;
            const parsed = parseGeminiError(tErr, 'gemini');
            if (parsed.statusCode !== 404 && !parsed.isRetryable) {
              break;
            }
          }
        }

        if (!geminiRes) {
          throw lastGeminiErr || new Error('Gemini audio transcription failed');
        }

        const text = (geminiRes?.text || '').trim();
        return res.status(200).json({
          success: true,
          text,
          language: isoLang || 'en',
          duration: 0,
          model: modelUsed,
          provider: 'gemini',
          highAccuracy: true
        });
      } catch (geminiErr: any) {
        logAIDiagnostic({
          category: 'provider API error',
          provider: 'gemini',
          model: 'gemini-3.8-flash',
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

    // Deterministic local transcript polisher when only a live browser speech transcript was supplied.
    // Never substitute a Groq chat-completion call for an audio transcription result.
    if (incomingTranscript) {
      const cleanRefined = polishSpokenTranscript(incomingTranscript);
      return res.status(200).json({
        success: true,
        text: cleanRefined || incomingTranscript,
        language: isoLang || 'en',
        duration: 0,
        model: 'local-polisher',
        provider: 'local',
        highAccuracy: false
      });
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

    // Request-scoped upstream cancellation & header timeout guard
    const upstreamGuard = createRequestUpstreamGuard(req, res);
    res.once('finish', () => upstreamGuard.cleanup());
    res.once('close', () => upstreamGuard.cleanup());

    // Validate target server provider & incoming model identifier before context preparation or dispatch
    let normalizedProvider = String(provider || 'gemini').trim().toLowerCase();
    // Safe legacy fallback: if client or old session sent 'ollama', gracefully route to 'gemini'
    if (normalizedProvider === 'ollama') {
      normalizedProvider = 'gemini';
    }
    const SERVER_SUPPORTED_PROVIDERS = new Set(['gemini', 'groq', 'openrouter', 'cloudflare']);
    if (!SERVER_SUPPORTED_PROVIDERS.has(normalizedProvider)) {
      upstreamGuard.cleanup();
      const errMessage =
        normalizedProvider === 'webllm'
          ? 'Browser AI (WebLLM) runs directly in the browser via WebGPU and cannot be dispatched to /api/chat.'
          : `Unknown provider: ${provider}`;
      logAIDiagnostic({
        category: 'request validation error',
        provider: normalizedProvider,
        model: String(clientModel || 'N/A'),
        phase: 'validation',
        upstreamStatus: 400,
        upstreamErrorCode: 'INVALID_ARGUMENT',
        sanitizedMessage: errMessage
      });
      return res.status(400).json({
        error: errMessage,
        code: 400,
        status: normalizedProvider === 'webllm' ? 'LOCAL_PROVIDER_ONLY' : 'INVALID_ARGUMENT',
        provider: normalizedProvider,
        retryable: false,
        canFallback: false
      });
    }

    const modelValidation = validateServerModelForProvider(normalizedProvider, clientModel);
    if (!modelValidation.valid) {
      upstreamGuard.cleanup();
      logAIDiagnostic({
        category: 'request validation error',
        provider: normalizedProvider,
        model: String(clientModel || 'invalid'),
        phase: 'validation',
        upstreamStatus: 400,
        upstreamErrorCode: 'INVALID_MODEL',
        sanitizedMessage: modelValidation.error || 'Invalid model identifier for provider.'
      });
      return res.status(400).json({
        error: modelValidation.error || 'Invalid model identifier for selected provider.',
        code: 400,
        status: 'INVALID_MODEL',
        errorCode: 'INVALID_MODEL',
        provider: normalizedProvider,
        retryable: false,
        canFallback: false
      });
    }
    const validatedClientModel: string | null = modelValidation.model;

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
    // Collect available documents for this specific conversation (Requirement 3: strict conversation isolation)
    const availableDocs: DocumentData[] = [];
    const seenDocIds = new Set<string>();

    const addDocIfValid = (docData: DocumentData, fromConvId?: string) => {
      // Never use a document associated with a different conversation!
      if (fromConvId && conversationId && fromConvId !== conversationId) {
        return;
      }
      const docKey = docData.fileId || docData.id || (docData.originalName ? `${docData.originalName}_${docData.sizeBytes || 0}` : docData.filename);
      if (docKey && !seenDocIds.has(docKey)) {
        seenDocIds.add(docKey);
        availableDocs.push(docData);
      }
    };

    // 1. Current turn attachments (Highest priority: explicitly attached to this request)
    const currentTurnAttachmentId = Array.isArray(attachments) && attachments[0]?.id ? String(attachments[0].id) : undefined;
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
              const isOfflineChat = Boolean(req.body?.offline);
              const geminiKey = process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY || null;

              if (isImg) {
                record.extraction = (await extractImageText(
                  inputSource,
                  record.originalName,
                  ext,
                  record.mimeType,
                  record.id,
                  record.dimensions,
                  geminiKey,
                  { offline: isOfflineChat }
                )) as any;
                record.status = record.extraction?.status === 'error' ? 'error' : 'ready';
              } else {
                record.extraction = (await extractDocumentContent(
                  inputSource,
                  record.originalName,
                  ext,
                  record.mimeType,
                  record.id,
                  { offline: isOfflineChat, apiKey: geminiKey }
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
            mimeType: record?.mimeType || att.mimeType || att.type || (rawExtraction as any).mimeType,
            type: record?.mimeType || att.type || att.mimeType || (rawExtraction as any).mimeType,
            sizeBytes: Number(record?.size || att.size || (rawExtraction as any).sizeBytes || 0),
            pages: (rawExtraction as any).pages || record?.extraction?.pages,
            isImage: Boolean((rawExtraction as any).isImage || record?.isImage || att.isImage)
          };
          addDocIfValid(docData, record?.conversationId || conversationId || undefined);
        }
      }
    }

    // 2. Attachments in history of this conversation (traverse from MOST RECENT to oldest)
    if (Array.isArray(history)) {
      for (let i = history.length - 1; i >= 0; i--) {
        const hMsg = history[i];
        if (Array.isArray(hMsg?.attachments)) {
          for (const hAtt of hMsg.attachments) {
            if (!hAtt?.id) continue;
            const record = fileRegistry.get(hAtt.id);
            if (record?.extraction) {
              addDocIfValid(record.extraction as DocumentData, record.conversationId || conversationId || undefined);
            } else if (hAtt.extraction) {
              const docData: any = {
                ...(hAtt.extraction as DocumentData),
                id: hAtt.id,
                fileId: hAtt.id,
                originalName: hAtt.originalName || hAtt.name,
                filename: hAtt.filename || hAtt.name || hAtt.originalName,
                mimeType: hAtt.mimeType || hAtt.type || (hAtt.extraction as any)?.mimeType,
                type: hAtt.type || hAtt.mimeType || (hAtt.extraction as any)?.mimeType,
                extension: hAtt.extension,
                sizeBytes: Number(hAtt.size || (hAtt.extraction as any)?.sizeBytes || 0),
                isImage: Boolean(hAtt.isImage || (hAtt.extraction as any)?.isImage),
                base64: hAtt.base64 || hAtt.dataUrl
              };
              addDocIfValid(docData, conversationId || undefined);
            }
          }
        }
      }
    }

    // 3. Conversation-registered files for this conversation (traverse in reverse insertion order)
    if (conversationId && conversationDocuments.has(conversationId)) {
      const convSet = Array.from(conversationDocuments.get(conversationId)!).reverse();
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
    const isVision = isVisionCapableProvider(
      normalizedProvider,
      validatedClientModel ?? undefined
    );
    const prepDoc: PreparedDocumentContext = prepareDocumentContext(effectiveDocPrompt, availableDocs, {
      provider: normalizedProvider,
      model: validatedClientModel ?? undefined,
      isVisionCapable: isVision,
      activeAttachmentId: currentTurnAttachmentId
    }) as PreparedDocumentContext;
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
    // Note: If the model is vision-capable (Gemini) and the document is an image without OCR text or with failed OCR,
    // do not prematurely abort with "No readable text detected" — let the image bytes reach Gemini.
    const isImageNoTextRejection =
      prepDoc.directAnswer === 'No readable text detected in this image.' ||
      (typeof prepDoc.directAnswer === 'string' &&
        prepDoc.directAnswer.toLowerCase().includes('no readable text detected') &&
        availableDocs.length > 0 &&
        availableDocs.every((d: any) => isImageAttachment(d)));

    if (prepDoc.directAnswer && !(isVision && isImageNoTextRejection)) {
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

    // Validate image payloads for vision providers before demo/live dispatch, and enforce the deployed /api/chat request budget
    let validatedGeminiImageParts: Array<{ mimeType: string; data: string }> = [];
    if (normalizedProvider === 'gemini') {
      try {
        validatedGeminiImageParts = buildGeminiImageParts({
          attachments: Array.isArray(attachments) ? attachments : [],
          availableDocs
        });
      } catch (imgErr: any) {
        const statusCode = Number(imgErr?.code) === 413 ? 413 : 400;
        const statusLabel = statusCode === 413 ? 'PAYLOAD_TOO_LARGE' : 'INVALID_ARGUMENT';
        return res.status(statusCode).json({
          error:
            imgErr?.message ||
            'Attached image payload could not be processed within the supported request limits.',
          code: statusCode,
          status: statusLabel,
          provider: 'gemini',
          retryable: false,
          canFallback: false
        });
      }
    }

    const serializedBodyBytes = Buffer.byteLength(JSON.stringify(req.body || {}), 'utf8');
    if (serializedBodyBytes > MAX_CHAT_REQUEST_BYTES) {
      return res.status(413).json({
        error: `The complete chat request (${(serializedBodyBytes / (1024 * 1024)).toFixed(1)} MB) exceeds the ${(MAX_CHAT_REQUEST_BYTES / (1024 * 1024)).toFixed(1)} MB serverless request budget (max ${(MAX_VISION_IMAGE_BYTES / (1024 * 1024)).toFixed(1)} MB per image). Please resize or compress attached images or start a new conversation.`,
        code: 413,
        status: 'PAYLOAD_TOO_LARGE',
        provider: normalizedProvider,
        retryable: false,
        canFallback: false
      });
    }

    // 1. Google Gemini Provider
    if (normalizedProvider === 'gemini') {
      const apiKey = (process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY || '').trim();

      if (!isConfiguredCredential(apiKey)) {
        if (!isDemoModeEnabled()) {
          return sendProviderNotConfiguredError(res, 'gemini', isServerless);
        }
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
        const demoModel = availableDocs.length > 0 ? 'Document Analyzer (demo)' : 'gemini-3.8-flash (demo)';
        if (!shouldStream) {
          return res.json({
            text,
            modelUsed: demoModel,
            provider: 'gemini',
            isDemo: true
          });
        }
        initSSE(res);
        const stopHeartbeat = startSSEHeartbeat(res);
        sendSSE(res, { type: 'start', modelUsed: demoModel, provider: 'gemini', isDemo: true });

        const testDurationMatch = typeof prompt === 'string' ? prompt.match(/__test_stream_duration:(\d+)__/) : null;
        const testDurationSec = testDurationMatch
          ? parseInt(testDurationMatch[1], 10)
          : ((req.body as any)?.testStreamDurationSec ? Number((req.body as any).testStreamDurationSec) : null);

        if (testDurationSec && testDurationSec > 0) {
          const totalMs = testDurationSec * 1000;
          const tokens = text.split(/(\s+)/);
          const intervalMs = Math.max(80, Math.floor(totalMs / Math.max(tokens.length, 1)));
          for (const token of tokens) {
            if (upstreamGuard.isClientClosed() || res.writableEnded) break;
            sendSSE(res, { type: 'chunk', text: token });
            await sleepWithAbort(intervalMs, () => upstreamGuard.isClientClosed() || res.writableEnded);
          }
        } else {
          const tokens = text.split(/(\s+)/);
          for (const token of tokens) {
            if (upstreamGuard.isClientClosed() || res.writableEnded) break;
            sendSSE(res, { type: 'chunk', text: token });
            await sleepWithAbort(15, () => upstreamGuard.isClientClosed() || res.writableEnded);
          }
        }

        stopHeartbeat();
        if (!res.writableEnded) {
          sendSSE(res, { type: 'done', text, modelUsed: demoModel, provider: 'gemini', isDemo: true });
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

      const imageParts: Array<{ mimeType: string; data: string }> = validatedGeminiImageParts;
      const contents = formatGeminiHistory(history, effectivePrompt, 12, imageParts);
      // Attempt sequence: max 3 attempts total (initial attempt + valid fallbacks)
      // Uses the validated Gemini model if specified, falling back to gemini-3.1-flash-lite
      const requestedGeminiModel = validatedClientModel || 'gemini-3.8-flash';
      const fallbackCandidates = ['gemini-3.8-flash', 'gemini-3.1-flash-lite'];
      const uniquePlanModels = [requestedGeminiModel];
      for (const cand of fallbackCandidates) {
        if (!uniquePlanModels.includes(cand)) {
          uniquePlanModels.push(cand);
        }
      }
      const attemptPlan = uniquePlanModels.map((m, idx) => ({
        model: m,
        attemptNum: idx + 1
      }));
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
          if (upstreamGuard.isClientClosed()) return;
          const { model, attemptNum } = attemptPlan[i];

          try {
            const response = await upstreamGuard.callGeminiWithGuard(
              (signal) =>
                ai.models.generateContent({
                  model,
                  contents,
                  config: {
                    abortSignal: signal,
                    systemInstruction: effectiveSystemInstruction,
                    maxOutputTokens: targetGeminiTokens,
                    temperature: 0.7
                  }
                }),
              { provider: 'gemini' }
            );

            if (upstreamGuard.isClientClosed()) return;

            const candidate = response?.candidates?.[0];
            const finishReason = candidate?.finishReason || (response as any)?.promptFeedback?.blockReason;

            // Handle safety filter block
            if (finishReason === 'SAFETY' || (response as any)?.promptFeedback?.blockReason === 'SAFETY') {
              return res.status(400).json({
                error: "The response was blocked by Google Gemini's safety filters. Please rephrase your request.",
                code: 400,
                status: 'SAFETY_BLOCKED',
                provider: 'gemini',
                model,
                retryable: false,
                canFallback: true,
                finishReason: 'SAFETY'
              });
            }

            let finalText = '';
            try {
              finalText = response?.text || '';
            } catch (textErr: any) {
              if (String(textErr?.message || '').toLowerCase().includes('safety')) {
                return res.status(400).json({
                  error: "The response was blocked by Google Gemini's safety filters. Please rephrase your request.",
                  code: 400,
                  status: 'SAFETY_BLOCKED',
                  provider: 'gemini',
                  model,
                  retryable: false,
                  canFallback: true,
                  finishReason: 'SAFETY'
                });
              }
            }

            if (finalText) {
              const isTruncated = finishReason === 'MAX_TOKENS';
              if ((isTruncated || isLikelyLarge) && !isContinuation && !responseHasContinuationNotice(finalText)) {
                finalText += CONTINUATION_NOTICES.PART_1;
              }
              return res.json({
                text: finalText,
                modelUsed: model,
                provider: 'gemini',
                ...(finishReason ? { finishReason } : {}),
                ...(isTruncated ? { truncated: true } : {})
              });
            }
          } catch (err: any) {
            if (upstreamGuard.isClientDisconnected(err)) {
              return;
            }
            const parsed = parseGeminiError(err, 'gemini');
            lastParsedErr = parsed;
            const hasMoreAttempts = i < attemptPlan.length - 1;

            const isModelNotFound = parsed.statusCode === 404 || parsed.status === 'NOT_FOUND';
            const willAdvanceFallback = isModelNotFound && hasMoreAttempts;
            const isTimeoutFailure = parsed.statusCode === 504 || parsed.status === 'DEADLINE_EXCEEDED';
            const willRetry =
              (parsed.isRetryable || willAdvanceFallback) &&
              hasMoreAttempts &&
              !upstreamGuard.isClientClosed() &&
              !(isServerless && isTimeoutFailure);

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

            if (!parsed.isRetryable && !willAdvanceFallback) {
              return res.status(parsed.statusCode).json({
                error: parsed.message,
                code: parsed.statusCode,
                status: parsed.status,
                provider: 'gemini',
                model,
                retryable: false,
                canFallback: true,
                suggestedProviders: getConfiguredFallbackProviders('gemini', isServerless)
              });
            }

            if (willRetry) {
              if (willAdvanceFallback) {
                // Immediately try fallback model without delay
                continue;
              }
              const delay = getBackoffWithJitter(attemptNum, parsed.retryAfterSeconds);
              const continueExecution = await sleepWithAbort(delay, () => upstreamGuard.isClientClosed());
              if (!continueExecution) return;
              continue;
            }
            break;
          }
        }

        if (upstreamGuard.isClientClosed()) return;

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
          model: requestedGeminiModel,
          retryable: fallbackErr.isRetryable,
          serverRetriesExhausted: true,
          canFallback: true,
          suggestedProviders: getConfiguredFallbackProviders('gemini', isServerless)
        });
      } else {
        // Genuine streaming via ai.models.generateContentStream with early SSE priming
        initSSE(res);
        const stopHeartbeat = startSSEHeartbeat(res, 8000);
        // Prime the stream with an initial keepalive comment so Vercel edge proxy receives HTTP 200 and initial bytes immediately (<10ms)
        res.write(': prime\n\n');
        res.flushHeaders?.();

        let lastParsedErr: any = null;
        let streamedAnyChunk = false;

        for (let i = 0; i < attemptPlan.length; i++) {
          if (upstreamGuard.isClientClosed() || res.writableEnded) {
            stopHeartbeat();
            return;
          }
          const { model, attemptNum } = attemptPlan[i];

          try {
            const responseStream = await upstreamGuard.callGeminiWithGuard(
              (signal) =>
                ai.models.generateContentStream({
                  model,
                  contents,
                  config: {
                    abortSignal: signal,
                    systemInstruction: effectiveSystemInstruction,
                    maxOutputTokens: targetGeminiTokens,
                    temperature: 0.7
                  }
                }),
              { provider: 'gemini' }
            );

            if (upstreamGuard.isClientClosed() || res.writableEnded) {
              stopHeartbeat();
              return;
            }

            sendSSE(res, { type: 'start', modelUsed: model, provider: 'gemini' });

            const iterator = responseStream[Symbol.asyncIterator]();
            let fullText = '';
            let lastFinishReason: string | null = null;

            try {
              while (true) {
                if (upstreamGuard.isClientClosed() || res.writableEnded) break;
                const { done, value } = await iterator.next();
                if (upstreamGuard.isClientClosed() || res.writableEnded) break;
                if (done) break;

                const candidate = value?.candidates?.[0];
                const finishReason = candidate?.finishReason;
                if (finishReason) {
                  lastFinishReason = finishReason;
                }

                const chunkText = value?.text;
                if (chunkText) {
                  streamedAnyChunk = true;
                  fullText += chunkText;
                  sendSSE(res, { type: 'chunk', text: chunkText });
                }
              }

              stopHeartbeat();

              if (!upstreamGuard.isClientClosed() && !res.writableEnded) {
                // If blocked by SAFETY with no text, send error
                if (lastFinishReason === 'SAFETY' && fullText.trim().length === 0) {
                  sendSSE(res, {
                    type: 'error',
                    error: "The response was blocked by Google Gemini's safety filters. Please rephrase your request.",
                    code: 400,
                    status: 'SAFETY_BLOCKED',
                    category: 'request validation error',
                    provider: 'gemini',
                    model,
                    retryable: false,
                    canFallback: false,
                    finishReason: 'SAFETY'
                  });
                  res.end();
                  return;
                }

                const isTruncated = lastFinishReason === 'MAX_TOKENS';
                if ((isTruncated || isLikelyLarge) && !isContinuation && !responseHasContinuationNotice(fullText)) {
                  sendSSE(res, { type: 'chunk', text: CONTINUATION_NOTICES.PART_1 });
                  fullText += CONTINUATION_NOTICES.PART_1;
                }
                sendSSE(res, {
                  type: 'done',
                  text: fullText,
                  modelUsed: model,
                  provider: 'gemini',
                  ...(lastFinishReason ? { finishReason: lastFinishReason } : {}),
                  ...(isTruncated ? { truncated: true } : {})
                });
                res.end();
              }
              return;
            } catch (midStreamErr: any) {
              stopHeartbeat();
              if (upstreamGuard.isClientDisconnected(midStreamErr)) {
                return;
              }
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
                  category: parsedMid.category,
                  provider: 'gemini',
                  model,
                  retryable: false,
                  canFallback: !streamedAnyChunk && parsedMid.statusCode !== 400 && parsedMid.statusCode !== 413,
                  partial: fullText.length > 0,
                  partialText: fullText.length > 0 ? fullText : undefined,
                  ...(parsedMid.status === 'SAFETY_BLOCKED' ? { finishReason: 'SAFETY' } : {})
                });
                res.end();
              }
              return;
            }
          } catch (initialErr: any) {
            if (upstreamGuard.isClientDisconnected(initialErr)) {
              stopHeartbeat();
              return;
            }
            const parsed = parseGeminiError(initialErr, 'gemini');
            lastParsedErr = parsed;
            const hasMoreAttempts = i < attemptPlan.length - 1;

            const isModelNotFound = parsed.statusCode === 404 || parsed.status === 'NOT_FOUND';
            const willAdvanceFallback = isModelNotFound && hasMoreAttempts;
            const isTimeoutFailure = parsed.statusCode === 504 || parsed.status === 'DEADLINE_EXCEEDED';
            const willRetry =
              (parsed.isRetryable || willAdvanceFallback) &&
              hasMoreAttempts &&
              !upstreamGuard.isClientClosed() &&
              !(isServerless && isTimeoutFailure);

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

            if (!parsed.isRetryable && !willAdvanceFallback) {
              stopHeartbeat();
              if (!res.writableEnded) {
                sendSSE(res, {
                  type: 'error',
                  error: parsed.message,
                  code: parsed.statusCode,
                  status: parsed.status,
                  category: parsed.category,
                  provider: 'gemini',
                  model,
                  retryable: false,
                  canFallback: parsed.statusCode !== 400 && parsed.statusCode !== 413,
                  suggestedProviders: getConfiguredFallbackProviders('gemini', isServerless)
                });
                res.end();
              }
              return;
            }

            if (willRetry) {
              if (willAdvanceFallback) {
                continue;
              }
              const delay = getBackoffWithJitter(attemptNum, parsed.retryAfterSeconds);
              const continueExecution = await sleepWithAbort(delay, () => upstreamGuard.isClientClosed());
              if (!continueExecution) {
                stopHeartbeat();
                return;
              }
              continue;
            }
            break;
          }
        }

        stopHeartbeat();
        if (upstreamGuard.isClientClosed()) return;

        const finalErr = lastParsedErr || {
          statusCode: 503,
          status: 'UNAVAILABLE',
          category: 'provider API error' as const,
          message: 'Google Gemini is currently experiencing high demand. Spikes in demand are usually temporary. Please try again in a few moments.',
          isRetryable: true
        };

        if (!res.writableEnded) {
          sendSSE(res, {
            type: 'error',
            error: finalErr.message,
            code: finalErr.statusCode,
            status: finalErr.status,
            category: finalErr.category,
            provider: 'gemini',
            model: requestedGeminiModel,
            retryable: false,
            serverRetriesExhausted: true,
            canFallback: finalErr.statusCode !== 400 && finalErr.statusCode !== 413,
            suggestedProviders: getConfiguredFallbackProviders('gemini', isServerless)
          });
          res.end();
        }
        return;
      }
    }

    // 2. Groq Provider
    if (normalizedProvider === 'groq') {
      const apiKey = (process.env.GROQ_API_KEY || process.env.VITE_GROQ_API_KEY || '').trim();
      if (!isConfiguredCredential(apiKey)) {
        if (!isDemoModeEnabled()) {
          return sendProviderNotConfiguredError(res, 'groq', isServerless);
        }
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
            provider: 'groq',
            isDemo: true
          });
        }
        initSSE(res);
        const stopHeartbeat = startSSEHeartbeat(res);
        sendSSE(res, { type: 'start', modelUsed: demoModel, provider: 'groq', isDemo: true });

        const testDurationMatch = typeof prompt === 'string' ? prompt.match(/__test_stream_duration:(\d+)__/) : null;
        const testDurationSec = testDurationMatch
          ? parseInt(testDurationMatch[1], 10)
          : ((req.body as any)?.testStreamDurationSec ? Number((req.body as any).testStreamDurationSec) : null);

        if (testDurationSec && testDurationSec > 0) {
          const totalMs = testDurationSec * 1000;
          const tokens = text.split(/(\s+)/);
          const intervalMs = Math.max(80, Math.floor(totalMs / Math.max(tokens.length, 1)));
          for (const token of tokens) {
            if (upstreamGuard.isClientClosed() || res.writableEnded) break;
            sendSSE(res, { type: 'chunk', text: token });
            await sleepWithAbort(intervalMs, () => upstreamGuard.isClientClosed() || res.writableEnded);
          }
        } else {
          const tokens = text.split(/(\s+)/);
          for (const token of tokens) {
            if (upstreamGuard.isClientClosed() || res.writableEnded) break;
            sendSSE(res, { type: 'chunk', text: token });
            await sleepWithAbort(15, () => upstreamGuard.isClientClosed() || res.writableEnded);
          }
        }

        stopHeartbeat();
        if (!res.writableEnded) {
          sendSSE(res, { type: 'done', text, modelUsed: demoModel, provider: 'groq', isDemo: true });
          res.end();
        }
        return;
      }

      const messages = formatOpenAIMessages({
        systemInstruction: effectiveSystemInstruction,
        history,
        prompt: effectivePrompt
      });

      const GROQ_ACTIVE_MODEL = 'openai/gpt-oss-120b';
      const requestedGroqModel = validatedClientModel || GROQ_ACTIVE_MODEL;
      const groqFallbackCandidates: string[] = Array.isArray(GROQ_FALLBACK_CHAT_MODELS)
        ? [...GROQ_FALLBACK_CHAT_MODELS]
        : ['openai/gpt-oss-120b', 'llama-3.1-8b-instant'];
      const uniqueGroqPlanModels = [requestedGroqModel];
      for (const cand of groqFallbackCandidates) {
        if (!uniqueGroqPlanModels.includes(cand)) {
          uniqueGroqPlanModels.push(cand);
        }
      }
      const groqAttemptPlan = uniqueGroqPlanModels.map((m, idx) => ({
        model: m,
        attemptNum: idx + 1
      }));
      const groqChatEndpoint = `${getGroqApiBaseUrl()}/chat/completions`;

      let groqMaxTokens = 2560;
      if (preferences?.responseLength === 'detailed' || isLikelyLarge || isContinuation) {
        groqMaxTokens = 4096;
      } else if (preferences?.responseLength === 'concise') {
        groqMaxTokens = 1024;
      }

      if (!shouldStream) {
        let lastParsedErr: any = null;
        let lastFailedModel = requestedGroqModel;

        for (let i = 0; i < groqAttemptPlan.length; i++) {
          if (upstreamGuard.isClientClosed()) return;
          const { model: currentModel, attemptNum } = groqAttemptPlan[i];
          lastFailedModel = currentModel;

          try {
            const groqRes = await upstreamGuard.fetchUpstream(
              groqChatEndpoint,
              {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${apiKey}`,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                  model: currentModel,
                  messages,
                  max_tokens: groqMaxTokens,
                  temperature: 0.7
                })
              },
              { provider: 'groq' }
            );

            if (!groqRes.ok) {
              const errText = await groqRes.text();
              const parsed = parseGeminiError({ status: groqRes.status, message: errText }, 'groq');
              let friendlyError = parsed.message;
              if (errText.includes('context_length_exceeded') || errText.includes('maximum context length') || errText.includes('tokens')) {
                friendlyError = 'The attached document exceeds Groq\'s context length limit. Please switch to Google Gemini (which supports 1M tokens) or ask about specific pages or slides.';
              }
              lastParsedErr = { ...parsed, message: friendlyError };

              const hasMoreAttempts = i < groqAttemptPlan.length - 1;
              const isModelNotFound = groqRes.status === 404 || parsed.status === 'NOT_FOUND';
              const willAdvanceFallback = isModelNotFound && hasMoreAttempts;

              logAIDiagnostic({
                category: parsed.category,
                provider: 'groq',
                model: currentModel,
                phase: 'non-streaming',
                attempt: attemptNum,
                upstreamStatus: groqRes.status,
                sanitizedMessage: friendlyError
              });

              if (willAdvanceFallback) {
                continue;
              }

              return res.status(groqRes.status).json({
                error: friendlyError,
                code: groqRes.status,
                status: parsed.status,
                category: parsed.category,
                provider: 'groq',
                model: currentModel,
                retryable: parsed.isRetryable,
                canFallback: true,
                suggestedProviders: getConfiguredFallbackProviders('groq', isServerless)
              });
            }

            const data = await groqRes.json();
            if (upstreamGuard.isClientClosed()) return;
            let finalText = data?.choices?.[0]?.message?.content || '';
            const finishReason = data?.choices?.[0]?.finish_reason;

            // Transparent continuation if output limit reached
            if (finishReason === 'length' && finalText.length > 60 && !upstreamGuard.isClientClosed()) {
              try {
                const contMessages = [
                  ...messages,
                  { role: 'assistant', content: finalText },
                  { role: 'user', content: 'Please continue directly from where you stopped. Complete any unfinished sentences, items, or sections without repeating previous text.' }
                ];
                const contRes = await upstreamGuard.fetchUpstream(
                  groqChatEndpoint,
                  {
                    method: 'POST',
                    headers: {
                      Authorization: `Bearer ${apiKey}`,
                      'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                      model: currentModel,
                      messages: contMessages,
                      max_tokens: Math.min(2048, groqMaxTokens),
                      temperature: 0.7
                    })
                  },
                  { provider: 'groq' }
                );
                if (contRes.ok) {
                  const contData = await contRes.json();
                  const contText = contData?.choices?.[0]?.message?.content;
                  if (contText) {
                    finalText += (finalText.endsWith(' ') || contText.startsWith(' ') ? '' : ' ') + contText;
                  }
                }
              } catch (_) {}
            }

            if (upstreamGuard.isClientClosed()) return;
            if (isLikelyLarge && !isContinuation && !responseHasContinuationNotice(finalText)) {
              finalText += CONTINUATION_NOTICES.PART_1;
            }
            return res.json({
              text: finalText,
              modelUsed: data.model || currentModel,
              provider: 'groq'
            });
          } catch (fetchErr: any) {
            if (upstreamGuard.isClientDisconnected(fetchErr)) {
              return;
            }
            const parsed = parseGeminiError(fetchErr, 'groq');
            lastParsedErr = parsed;
            const hasMoreAttempts = i < groqAttemptPlan.length - 1;
            const isModelNotFound = parsed.statusCode === 404 || parsed.status === 'NOT_FOUND';
            const willAdvanceFallback = isModelNotFound && hasMoreAttempts;

            logAIDiagnostic({
              category: parsed.category,
              provider: 'groq',
              model: currentModel,
              phase: 'non-streaming',
              attempt: attemptNum,
              upstreamStatus: parsed.statusCode,
              sanitizedMessage: parsed.message
            });

            if (willAdvanceFallback) {
              continue;
            }

            return res.status(parsed.statusCode).json({
              error: parsed.message,
              code: parsed.statusCode,
              status: parsed.status,
              category: parsed.category,
              provider: 'groq',
              model: currentModel,
              retryable: parsed.isRetryable,
              canFallback: true,
              suggestedProviders: getConfiguredFallbackProviders('groq', isServerless)
            });
          }
        }

        if (upstreamGuard.isClientClosed()) return;

        const fallbackErr = lastParsedErr || {
          statusCode: 404,
          status: 'NOT_FOUND',
          message: 'The requested Groq model was not found and all fallback options were exhausted.',
          isRetryable: false
        };
        return res.status(fallbackErr.statusCode).json({
          error: fallbackErr.message,
          code: fallbackErr.statusCode,
          status: fallbackErr.status,
          provider: 'groq',
          model: lastFailedModel,
          retryable: false,
          serverRetriesExhausted: true,
          canFallback: true,
          suggestedProviders: getConfiguredFallbackProviders('groq', isServerless)
        });
      } else {
        // Genuine streaming via Groq OpenAI-compatible SSE
        let groqRes: Response | null = null;
        let selectedModel = requestedGroqModel;
        let lastParsedErr: any = null;

        for (let i = 0; i < groqAttemptPlan.length; i++) {
          if (upstreamGuard.isClientClosed()) return;
          const { model: currentModel, attemptNum } = groqAttemptPlan[i];
          selectedModel = currentModel;

          try {
            const attemptRes = await upstreamGuard.fetchUpstream(
              groqChatEndpoint,
              {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${apiKey}`,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                  model: currentModel,
                  messages,
                  max_tokens: groqMaxTokens,
                  temperature: 0.7,
                  stream: true
                })
              },
              { provider: 'groq' }
            );

            if (!attemptRes.ok) {
              const errText = await attemptRes.text();
              const parsed = parseGeminiError({ status: attemptRes.status, message: errText }, 'groq');
              let friendlyError = parsed.message;
              if (errText.includes('context_length_exceeded') || errText.includes('maximum context length') || errText.includes('tokens')) {
                friendlyError = 'The attached document exceeds Groq\'s context length limit. Please switch to Google Gemini (which supports 1M tokens) or ask about specific pages or slides.';
              }
              lastParsedErr = { ...parsed, message: friendlyError };

              const hasMoreAttempts = i < groqAttemptPlan.length - 1;
              const isModelNotFound = attemptRes.status === 404 || parsed.status === 'NOT_FOUND';
              const willAdvanceFallback = isModelNotFound && hasMoreAttempts;

              logAIDiagnostic({
                category: parsed.category,
                provider: 'groq',
                model: currentModel,
                phase: 'pre-stream',
                attempt: attemptNum,
                upstreamStatus: attemptRes.status,
                sanitizedMessage: friendlyError
              });

              if (willAdvanceFallback) {
                continue;
              }

              return res.status(attemptRes.status).json({
                error: friendlyError,
                code: attemptRes.status,
                status: parsed.status,
                category: parsed.category,
                provider: 'groq',
                model: currentModel,
                retryable: parsed.isRetryable,
                canFallback: true,
                suggestedProviders: getConfiguredFallbackProviders('groq', isServerless)
              });
            }

            groqRes = attemptRes;
            break;
          } catch (fetchErr: any) {
            if (upstreamGuard.isClientDisconnected(fetchErr)) {
              return;
            }
            const parsed = parseGeminiError(fetchErr, 'groq');
            lastParsedErr = parsed;
            const hasMoreAttempts = i < groqAttemptPlan.length - 1;
            const isModelNotFound = parsed.statusCode === 404 || parsed.status === 'NOT_FOUND';
            const willAdvanceFallback = isModelNotFound && hasMoreAttempts;

            logAIDiagnostic({
              category: parsed.category,
              provider: 'groq',
              model: currentModel,
              phase: 'pre-stream',
              attempt: attemptNum,
              upstreamStatus: parsed.statusCode,
              sanitizedMessage: parsed.message
            });

            if (willAdvanceFallback) {
              continue;
            }

            return res.status(parsed.statusCode).json({
              error: parsed.message,
              code: parsed.statusCode,
              status: parsed.status,
              category: parsed.category,
              provider: 'groq',
              model: currentModel,
              retryable: parsed.isRetryable,
              canFallback: true,
              suggestedProviders: getConfiguredFallbackProviders('groq', isServerless)
            });
          }
        }

        if (!groqRes) {
          if (upstreamGuard.isClientClosed()) return;
          const fallbackErr = lastParsedErr || {
            statusCode: 404,
            status: 'NOT_FOUND',
            message: 'The requested Groq model was not found and all fallback options were exhausted.',
            isRetryable: false
          };
          return res.status(fallbackErr.statusCode).json({
            error: fallbackErr.message,
            code: fallbackErr.statusCode,
            status: fallbackErr.status,
            provider: 'groq',
            model: selectedModel,
            retryable: false,
            serverRetriesExhausted: true,
            canFallback: true,
            suggestedProviders: getConfiguredFallbackProviders('groq', isServerless)
          });
        }

        if (upstreamGuard.isClientClosed()) return;
        initSSE(res);
        const stopHeartbeat = startSSEHeartbeat(res);
        sendSSE(res, { type: 'start', modelUsed: selectedModel, provider: 'groq' });

        let fullText = '';
        try {
          const reader = groqRes.body!.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          let modelUsed = selectedModel;
          let lastFinishReason: string | null = null;
          let currentEventType: string | null = null;
          let streamFailed = false;

          const emitGroqStreamError = async (rawDataStr: string, explicitErrObj?: any) => {
            if (streamFailed) return;
            streamFailed = true;

            let parsedErrMessage = 'Groq streaming connection encountered an upstream error.';
            let rawErrCode = 0;
            let rawErrType = '';

            const extractFromErrorField = (errVal: any) => {
              if (typeof errVal === 'string' && errVal.trim()) {
                parsedErrMessage = errVal.trim();
              } else if (errVal && typeof errVal === 'object') {
                if (typeof errVal.message === 'string' && errVal.message.trim()) {
                  parsedErrMessage = errVal.message.trim();
                } else if (typeof errVal.error === 'string' && errVal.error.trim()) {
                  parsedErrMessage = errVal.error.trim();
                }
                const numCode = Number(errVal.code ?? errVal.status ?? errVal.statusCode);
                if (Number.isFinite(numCode) && numCode >= 400 && numCode < 600) {
                  rawErrCode = numCode;
                }
                if (typeof errVal.type === 'string' && errVal.type.trim()) {
                  rawErrType = errVal.type.trim();
                } else if (typeof errVal.status === 'string' && errVal.status.trim()) {
                  rawErrType = errVal.status.trim();
                } else if (typeof errVal.code === 'string' && errVal.code.trim()) {
                  rawErrType = errVal.code.trim();
                }
              }
            };

            if (explicitErrObj !== undefined) {
              extractFromErrorField(explicitErrObj);
            } else if (rawDataStr) {
              try {
                const errJson = JSON.parse(rawDataStr);
                extractFromErrorField(errJson?.error ?? errJson);
              } catch (_) {
                const cleaned = rawDataStr
                  .replace(/<[^>]*>/g, ' ')
                  .replace(/\s+/g, ' ')
                  .trim()
                  .slice(0, 280);
                if (cleaned) {
                  parsedErrMessage = cleaned;
                }
              }
            }

            if (!rawErrCode) {
              if (/rate_limit|429|quota|too many requests/i.test(`${rawErrType} ${parsedErrMessage}`)) {
                rawErrCode = 429;
              } else if (/auth|401|invalid_api_key/i.test(`${rawErrType} ${parsedErrMessage}`)) {
                rawErrCode = 401;
              } else if (/permission|403/i.test(`${rawErrType} ${parsedErrMessage}`)) {
                rawErrCode = 403;
              } else if (/not_found|404|model_not_found/i.test(`${rawErrType} ${parsedErrMessage}`)) {
                rawErrCode = 404;
              } else {
                rawErrCode = 500;
              }
            }

            const effectiveStatus = rawErrType || (rawErrCode === 429 ? 'RESOURCE_EXHAUSTED' : 'STREAM_ERROR');

            stopHeartbeat();
            try { await reader.cancel(); } catch (_) {}
            logAIDiagnostic({
              category: 'streaming failure',
              provider: 'groq',
              model: modelUsed || selectedModel,
              phase: 'mid-stream',
              upstreamStatus: rawErrCode,
              sanitizedMessage: parsedErrMessage
            });

            if (!upstreamGuard.isClientClosed() && !res.writableEnded) {
              sendSSE(res, {
                type: 'error',
                error: parsedErrMessage,
                code: rawErrCode,
                status: effectiveStatus,
                provider: 'groq',
                model: modelUsed || selectedModel,
                retryable: false,
                canFallback: true,
                suggestedProviders: getConfiguredFallbackProviders('groq', isServerless),
                partial: fullText.length > 0,
                partialText: fullText.length > 0 ? fullText : undefined
              });
              res.end();
            }
          };

          const processGroqSSELine = async (line: string): Promise<boolean> => {
            const trimmed = line.trim();
            if (!trimmed) {
              currentEventType = null;
              return false;
            }
            if (trimmed.startsWith(':')) return false;

            if (trimmed.startsWith('event:')) {
              currentEventType = trimmed.slice(6).trim().toLowerCase();
              return false;
            }

            if (!trimmed.startsWith('data:')) return false;
            const eventTypeForLine = currentEventType;
            currentEventType = null;

            const dataStr = trimmed.slice(5).trim();
            if (dataStr === '[DONE]') return false;

            if (eventTypeForLine === 'error') {
              await emitGroqStreamError(dataStr);
              return true;
            }

            try {
              const parsed = JSON.parse(dataStr);
              if (parsed && typeof parsed === 'object' && parsed.error) {
                await emitGroqStreamError(dataStr, parsed.error);
                return true;
              }

              if (parsed.model) modelUsed = parsed.model;
              const finishReason = parsed?.choices?.[0]?.finish_reason;
              if (finishReason) lastFinishReason = finishReason;
              const delta = parsed?.choices?.[0]?.delta?.content;
              if (delta) {
                fullText += delta;
                sendSSE(res, { type: 'chunk', text: delta });
              }
            } catch (_) {
              // Detect malformed or truncated error JSON frames (e.g., data: {"error": ...)
              if (/"error"\s*:/.test(dataStr)) {
                await emitGroqStreamError(dataStr);
                return true;
              }
            }
            return false;
          };

          while (true) {
            if (upstreamGuard.isClientClosed() || res.writableEnded) {
              try { await reader.cancel(); } catch (_) {}
              break;
            }
            const { done, value } = await reader.read();
            if (upstreamGuard.isClientClosed() || res.writableEnded) {
              try { await reader.cancel(); } catch (_) {}
              break;
            }
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              const haltedOnError = await processGroqSSELine(line);
              if (haltedOnError) return;
            }
          }

          // Process trailing bytes and buffer
          const finalBytes = decoder.decode();
          if (finalBytes) buffer += finalBytes;
          if (!streamFailed && !upstreamGuard.isClientClosed() && buffer && buffer.trim()) {
            const remainingLines = buffer.split('\n');
            for (const line of remainingLines) {
              const haltedOnError = await processGroqSSELine(line);
              if (haltedOnError) return;
            }
            if (!streamFailed && currentEventType === 'error') {
              await emitGroqStreamError(buffer.trim());
              return;
            }
          }

          // Continuation if finish_reason indicates token truncation
          if (!streamFailed && (lastFinishReason === 'length' || lastFinishReason === 'max_tokens') && !upstreamGuard.isClientClosed() && !res.writableEnded && fullText.length > 60) {
            try {
              const contMessages = [
                ...messages,
                { role: 'assistant', content: fullText },
                { role: 'user', content: 'Please continue directly from where you stopped. Complete any unfinished sentences, items, or sections without repeating previous text.' }
              ];
              const contRes = await upstreamGuard.fetchUpstream(
                groqChatEndpoint,
                {
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
                },
                { provider: 'groq' }
              );

              if (contRes.ok && contRes.body) {
                const contReader = contRes.body.getReader();
                let contBuffer = '';
                let contEventType: string | null = null;
                while (true) {
                  if (upstreamGuard.isClientClosed() || res.writableEnded) {
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
                    if (!cTrimmed) {
                      contEventType = null;
                      continue;
                    }
                    if (cTrimmed.startsWith(':')) continue;
                    if (cTrimmed.startsWith('event:')) {
                      contEventType = cTrimmed.slice(6).trim().toLowerCase();
                      continue;
                    }
                    if (!cTrimmed.startsWith('data:')) continue;
                    const lineEvt = contEventType;
                    contEventType = null;
                    const cData = cTrimmed.slice(5).trim();
                    if (cData === '[DONE]') continue;

                    if (lineEvt === 'error') {
                      try { await contReader.cancel(); } catch (_) {}
                      break;
                    }

                    try {
                      const cParsed = JSON.parse(cData);
                      if (cParsed.error) {
                        try { await contReader.cancel(); } catch (_) {}
                        break;
                      }
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
          if (!streamFailed && !upstreamGuard.isClientClosed() && !res.writableEnded) {
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
          if (upstreamGuard.isClientDisconnected(streamErr)) {
            return;
          }
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
              model: selectedModel,
              retryable: false,
              canFallback: true,
              suggestedProviders: getConfiguredFallbackProviders('groq', isServerless),
              partial: fullText.length > 0,
              partialText: fullText.length > 0 ? fullText : undefined
            });
            res.end();
          }
          return;
        }
      }
    }

    // 3. OpenRouter Provider
    if (normalizedProvider === 'openrouter') {
      const apiKey = (process.env.OPENROUTER_API_KEY || process.env.VITE_OPENROUTER_API_KEY || '').trim();
      if (!isConfiguredCredential(apiKey)) {
        if (!isDemoModeEnabled()) {
          return sendProviderNotConfiguredError(res, 'openrouter', isServerless);
        }
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
            provider: 'openrouter',
            isDemo: true
          });
        }
        initSSE(res);
        const stopHeartbeat = startSSEHeartbeat(res);
        sendSSE(res, { type: 'start', modelUsed: demoModel, provider: 'openrouter', isDemo: true });

        const testDurationMatch = typeof prompt === 'string' ? prompt.match(/__test_stream_duration:(\d+)__/) : null;
        const testDurationSec = testDurationMatch
          ? parseInt(testDurationMatch[1], 10)
          : ((req.body as any)?.testStreamDurationSec ? Number((req.body as any).testStreamDurationSec) : null);

        if (testDurationSec && testDurationSec > 0) {
          const totalMs = testDurationSec * 1000;
          const tokens = text.split(/(\s+)/);
          const intervalMs = Math.max(80, Math.floor(totalMs / Math.max(tokens.length, 1)));
          for (const token of tokens) {
            if (upstreamGuard.isClientClosed() || res.writableEnded) break;
            sendSSE(res, { type: 'chunk', text: token });
            await sleepWithAbort(intervalMs, () => upstreamGuard.isClientClosed() || res.writableEnded);
          }
        } else {
          const tokens = text.split(/(\s+)/);
          for (const token of tokens) {
            if (upstreamGuard.isClientClosed() || res.writableEnded) break;
            sendSSE(res, { type: 'chunk', text: token });
            await sleepWithAbort(15, () => upstreamGuard.isClientClosed() || res.writableEnded);
          }
        }

        stopHeartbeat();
        if (!res.writableEnded) {
          sendSSE(res, { type: 'done', text, modelUsed: demoModel, provider: 'openrouter', isDemo: true });
          res.end();
        }
        return;
      }

      const messages = formatOpenAIMessages({
        systemInstruction: effectiveSystemInstruction,
        history,
        prompt: effectivePrompt
      });

      const selectedModel = validatedClientModel || 'openrouter/free';
      const openRouterChatEndpoint = `${getOpenRouterApiBaseUrl()}/chat/completions`;
      const openRouterHeaders = {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://orvix.ai',
        'X-Title': 'Orvix'
      };

      const normalizeOpenRouterHttpError = (statusCode: number, errText: string) => {
        const parsed = parseGeminiError({ status: statusCode, message: errText }, 'openrouter');
        let friendlyError = parsed.message;
        let status = parsed.status;
        let isRetryable = parsed.isRetryable;
        let category = parsed.category;

        if (statusCode === 502) {
          status = 'BAD_GATEWAY';
          isRetryable = true;
          category = 'provider API error';
        } else if (statusCode === 500) {
          status = 'INTERNAL';
          isRetryable = true;
          category = 'provider API error';
        } else if (statusCode === 402) {
          status = 'PAYMENT_REQUIRED';
          isRetryable = false;
          category = 'provider configuration error';
        }

        const lowerErr = String(errText || '').toLowerCase();
        if (
          lowerErr.includes('context_length_exceeded') ||
          lowerErr.includes('maximum context length') ||
          (statusCode === 400 && (lowerErr.includes('too large') || lowerErr.includes('context length')))
        ) {
          friendlyError =
            "The attached document exceeds OpenRouter's context limit. Please switch to Google Gemini (which supports 1M tokens) or ask about specific pages or slides.";
          isRetryable = false;
        }

        return {
          statusCode,
          status,
          errorCode: status,
          category,
          isRetryable,
          message: friendlyError
        };
      };

      let openRouterMaxTokens = 2560;
      if (preferences?.responseLength === 'detailed' || isLikelyLarge || isContinuation) {
        openRouterMaxTokens = 4096;
      } else if (preferences?.responseLength === 'concise') {
        openRouterMaxTokens = 1024;
      }

      if (!shouldStream) {
        try {
          const orRes = await upstreamGuard.fetchUpstream(
            openRouterChatEndpoint,
            {
              method: 'POST',
              headers: openRouterHeaders,
              body: JSON.stringify({
                model: selectedModel,
                messages,
                max_tokens: openRouterMaxTokens,
                temperature: 0.7,
                stream: false
              })
            },
            { provider: 'openrouter' }
          );

          if (!orRes.ok) {
            const errText = await orRes.text();
            const normErr = normalizeOpenRouterHttpError(orRes.status, errText);
            logAIDiagnostic({
              category: normErr.category,
              provider: 'openrouter',
              model: selectedModel,
              phase: 'non-streaming',
              upstreamStatus: orRes.status,
              upstreamErrorCode: normErr.errorCode,
              sanitizedMessage: normErr.message
            });
            return res.status(orRes.status).json({
              error: normErr.message,
              code: orRes.status,
              status: normErr.status,
              errorCode: normErr.errorCode,
              category: normErr.category,
              provider: 'openrouter',
              model: selectedModel,
              retryable: normErr.isRetryable,
              canFallback: true,
              suggestedProviders: getConfiguredFallbackProviders('openrouter', isServerless)
            });
          }

          const data = await orRes.json();
          if (upstreamGuard.isClientClosed()) return;
          if (data?.error) {
            const embeddedCode = Number(data.error.code) || 502;
            const normErr = normalizeOpenRouterHttpError(
              embeddedCode >= 400 && embeddedCode < 600 ? embeddedCode : 502,
              JSON.stringify(data)
            );
            return res.status(normErr.statusCode).json({
              error: normErr.message,
              code: normErr.statusCode,
              status: normErr.status,
              errorCode: normErr.errorCode,
              category: normErr.category,
              provider: 'openrouter',
              model: selectedModel,
              retryable: normErr.isRetryable,
              canFallback: true,
              suggestedProviders: getConfiguredFallbackProviders('openrouter', isServerless)
            });
          }
          let finalText = data?.choices?.[0]?.message?.content || '';
          const finishReason = data?.choices?.[0]?.finish_reason;

          // Transparent continuation if OpenRouter reached output limit
          if (finishReason === 'length' && finalText.length > 60 && !upstreamGuard.isClientClosed()) {
            try {
              const contMessages = [
                ...messages,
                { role: 'assistant', content: finalText },
                { role: 'user', content: 'Please continue directly from where you stopped. Complete any unfinished sentences, items, or sections without repeating previous text.' }
              ];
              const contRes = await upstreamGuard.fetchUpstream(
                openRouterChatEndpoint,
                {
                  method: 'POST',
                  headers: openRouterHeaders,
                  body: JSON.stringify({
                    model: selectedModel,
                    messages: contMessages,
                    max_tokens: Math.min(2048, openRouterMaxTokens),
                    temperature: 0.7
                  })
                },
                { provider: 'openrouter' }
              );
              if (contRes.ok) {
                const contData = await contRes.json();
                const contText = contData?.choices?.[0]?.message?.content;
                if (contText) {
                  finalText += (finalText.endsWith(' ') || contText.startsWith(' ') ? '' : ' ') + contText;
                }
              }
            } catch (_) {}
          }

          if (upstreamGuard.isClientClosed()) return;
          if (isLikelyLarge && !isContinuation && !responseHasContinuationNotice(finalText)) {
            finalText += CONTINUATION_NOTICES.PART_1;
          }
          return res.json({
            text: finalText,
            modelUsed: data.model || selectedModel,
            provider: 'openrouter'
          });
        } catch (fetchErr: any) {
          if (upstreamGuard.isClientDisconnected(fetchErr)) {
            return;
          }
          const parsed = parseGeminiError(fetchErr, 'openrouter');
          logAIDiagnostic({
            category: parsed.category,
            provider: 'openrouter',
            model: selectedModel,
            phase: 'non-streaming',
            upstreamStatus: parsed.statusCode,
            upstreamErrorCode: parsed.status,
            sanitizedMessage: parsed.message
          });
          return res.status(parsed.statusCode).json({
            error: parsed.message,
            code: parsed.statusCode,
            status: parsed.status,
            errorCode: parsed.status,
            category: parsed.category,
            provider: 'openrouter',
            model: selectedModel,
            retryable: parsed.isRetryable,
            canFallback: true,
            suggestedProviders: getConfiguredFallbackProviders('openrouter', isServerless)
          });
        }
      } else {
        // Genuine streaming via OpenRouter SSE
        let orRes: Response;
        try {
          orRes = await upstreamGuard.fetchUpstream(
            openRouterChatEndpoint,
            {
              method: 'POST',
              headers: openRouterHeaders,
              body: JSON.stringify({
                model: selectedModel,
                messages,
                max_tokens: openRouterMaxTokens,
                temperature: 0.7,
                stream: true
              })
            },
            { provider: 'openrouter' }
          );
        } catch (fetchErr: any) {
          if (upstreamGuard.isClientDisconnected(fetchErr)) {
            return;
          }
          const parsed = parseGeminiError(fetchErr, 'openrouter');
          logAIDiagnostic({
            category: parsed.category,
            provider: 'openrouter',
            model: selectedModel,
            phase: 'pre-stream',
            upstreamStatus: parsed.statusCode,
            upstreamErrorCode: parsed.status,
            sanitizedMessage: parsed.message
          });
          return res.status(parsed.statusCode).json({
            error: parsed.message,
            code: parsed.statusCode,
            status: parsed.status,
            errorCode: parsed.status,
            category: parsed.category,
            provider: 'openrouter',
            model: selectedModel,
            retryable: parsed.isRetryable,
            canFallback: true,
            suggestedProviders: getConfiguredFallbackProviders('openrouter', isServerless)
          });
        }

        if (!orRes.ok) {
          const errText = await orRes.text();
          const normErr = normalizeOpenRouterHttpError(orRes.status, errText);
          logAIDiagnostic({
            category: normErr.category,
            provider: 'openrouter',
            model: selectedModel,
            phase: 'pre-stream',
            upstreamStatus: orRes.status,
            upstreamErrorCode: normErr.errorCode,
            sanitizedMessage: normErr.message
          });
          return res.status(orRes.status).json({
            error: normErr.message,
            code: orRes.status,
            status: normErr.status,
            errorCode: normErr.errorCode,
            category: normErr.category,
            provider: 'openrouter',
            model: selectedModel,
            retryable: normErr.isRetryable,
            canFallback: true,
            suggestedProviders: getConfiguredFallbackProviders('openrouter', isServerless)
          });
        }

        if (upstreamGuard.isClientClosed()) return;
        initSSE(res);
        const stopHeartbeat = startSSEHeartbeat(res);
        sendSSE(res, { type: 'start', modelUsed: selectedModel, provider: 'openrouter' });

        let fullText = '';
        let modelUsed = selectedModel;
        let streamFailed = false;

        try {
          const reader = orRes.body!.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          let lastFinishReason: string | null = null;
          let currentEventType: string | null = null;
          let sawDoneMarker = false;

          const emitOpenRouterStreamError = async (rawDataStr: string, explicitErrObj?: any) => {
            if (streamFailed) return;
            streamFailed = true;

            let parsedErrMessage = 'OpenRouter streaming connection encountered an upstream error.';
            let rawErrCode = 0;
            let rawErrType = '';

            const extractFromErrorField = (errVal: any) => {
              if (typeof errVal === 'string' && errVal.trim()) {
                parsedErrMessage = errVal.trim();
              } else if (errVal && typeof errVal === 'object') {
                if (typeof errVal.message === 'string' && errVal.message.trim()) {
                  parsedErrMessage = errVal.message.trim();
                } else if (typeof errVal.error === 'string' && errVal.error.trim()) {
                  parsedErrMessage = errVal.error.trim();
                }
                if (
                  typeof errVal.metadata?.raw === 'string' &&
                  errVal.metadata.raw.trim() &&
                  (!parsedErrMessage || parsedErrMessage.toLowerCase() === 'provider returned error')
                ) {
                  parsedErrMessage = `${parsedErrMessage}: ${errVal.metadata.raw.trim().slice(0, 200)}`;
                }
                const numCode = Number(errVal.code ?? errVal.status ?? errVal.statusCode);
                if (Number.isFinite(numCode) && numCode >= 400 && numCode < 600) {
                  rawErrCode = numCode;
                }
                if (typeof errVal.type === 'string' && errVal.type.trim()) {
                  rawErrType = errVal.type.trim();
                } else if (typeof errVal.status === 'string' && errVal.status.trim()) {
                  rawErrType = errVal.status.trim();
                } else if (typeof errVal.code === 'string' && errVal.code.trim()) {
                  rawErrType = errVal.code.trim();
                }
              }
            };

            if (explicitErrObj !== undefined) {
              extractFromErrorField(explicitErrObj);
            } else if (rawDataStr) {
              try {
                const errJson = JSON.parse(rawDataStr);
                extractFromErrorField(errJson?.error ?? errJson);
              } catch (_) {
                const cleaned = rawDataStr
                  .replace(/<[^>]*>/g, ' ')
                  .replace(/\s+/g, ' ')
                  .trim()
                  .slice(0, 280);
                if (cleaned) {
                  parsedErrMessage = cleaned;
                }
              }
            }

            if (!rawErrCode) {
              if (/rate_limit|429|quota|too many requests/i.test(`${rawErrType} ${parsedErrMessage}`)) {
                rawErrCode = 429;
              } else if (/auth|401|invalid_api_key/i.test(`${rawErrType} ${parsedErrMessage}`)) {
                rawErrCode = 401;
              } else if (/payment|402|credits/i.test(`${rawErrType} ${parsedErrMessage}`)) {
                rawErrCode = 402;
              } else if (/permission|403/i.test(`${rawErrType} ${parsedErrMessage}`)) {
                rawErrCode = 403;
              } else if (/not_found|404|model_not_found/i.test(`${rawErrType} ${parsedErrMessage}`)) {
                rawErrCode = 404;
              } else if (/502|bad gateway|malformed/i.test(`${rawErrType} ${parsedErrMessage}`)) {
                rawErrCode = 502;
              } else if (/503|unavailable|overloaded|interrupted/i.test(`${rawErrType} ${parsedErrMessage}`)) {
                rawErrCode = 503;
              } else if (/504|timeout|timed out/i.test(`${rawErrType} ${parsedErrMessage}`)) {
                rawErrCode = 504;
              } else {
                rawErrCode = 500;
              }
            }

            const effectiveStatus =
              rawErrType ||
              (rawErrCode === 429
                ? 'RESOURCE_EXHAUSTED'
                : rawErrCode === 401
                ? 'UNAUTHENTICATED'
                : rawErrCode === 402
                ? 'PAYMENT_REQUIRED'
                : rawErrCode === 403
                ? 'PERMISSION_DENIED'
                : rawErrCode === 404
                ? 'NOT_FOUND'
                : rawErrCode === 502
                ? 'BAD_GATEWAY'
                : rawErrCode === 503
                ? 'UNAVAILABLE'
                : rawErrCode === 504
                ? 'DEADLINE_EXCEEDED'
                : 'STREAM_ERROR');

            stopHeartbeat();
            try {
              await reader.cancel();
            } catch (_) {}
            logAIDiagnostic({
              category: 'streaming failure',
              provider: 'openrouter',
              model: modelUsed || selectedModel,
              phase: 'mid-stream',
              upstreamStatus: rawErrCode,
              upstreamErrorCode: effectiveStatus,
              sanitizedMessage: parsedErrMessage
            });

            if (!upstreamGuard.isClientClosed() && !res.writableEnded) {
              sendSSE(res, {
                type: 'error',
                error: parsedErrMessage,
                code: rawErrCode,
                status: effectiveStatus,
                errorCode: effectiveStatus,
                provider: 'openrouter',
                model: modelUsed || selectedModel,
                retryable: false,
                canFallback: true,
                suggestedProviders: getConfiguredFallbackProviders('openrouter', isServerless),
                partial: fullText.length > 0,
                partialText: fullText.length > 0 ? fullText : undefined
              });
              res.end();
            }
          };

          const processOpenRouterSSELine = async (line: string): Promise<boolean> => {
            const trimmed = line.trim();
            if (!trimmed) {
              currentEventType = null;
              return false;
            }
            if (trimmed.startsWith(':')) return false;

            if (trimmed.startsWith('event:')) {
              currentEventType = trimmed.slice(6).trim().toLowerCase();
              return false;
            }

            if (!trimmed.startsWith('data:')) {
              // Unexpected non-SSE line (e.g. raw HTML/JSON error body sent despite event-stream header)
              if (currentEventType === 'error' || /"error"\s*:|<html|bad gateway|service unavailable/i.test(trimmed)) {
                await emitOpenRouterStreamError(trimmed);
                return true;
              }
              return false;
            }

            const eventTypeForLine = currentEventType;
            currentEventType = null;

            const dataStr = trimmed.slice(5).trim();
            if (!dataStr) return false;
            if (dataStr === '[DONE]') {
              sawDoneMarker = true;
              return false;
            }

            if (eventTypeForLine === 'error') {
              await emitOpenRouterStreamError(dataStr);
              return true;
            }

            try {
              const parsed = JSON.parse(dataStr);
              if (parsed && typeof parsed === 'object' && parsed.error) {
                await emitOpenRouterStreamError(dataStr, parsed.error);
                return true;
              }

              if (parsed.model) modelUsed = parsed.model;
              const finishReason = parsed?.choices?.[0]?.finish_reason;
              if (finishReason === 'error') {
                await emitOpenRouterStreamError(dataStr, {
                  message: 'OpenRouter upstream provider terminated stream with finish_reason: error.',
                  code: 502,
                  type: 'UPSTREAM_STREAM_ERROR'
                });
                return true;
              }
              if (finishReason) lastFinishReason = finishReason;

              const delta = parsed?.choices?.[0]?.delta?.content;
              if (delta) {
                fullText += delta;
                sendSSE(res, { type: 'chunk', text: delta });
              }
            } catch (_) {
              await emitOpenRouterStreamError(
                dataStr,
                /"error"\s*:/.test(dataStr)
                  ? undefined
                  : {
                      message: `Malformed SSE data frame received from OpenRouter: ${dataStr.slice(0, 180)}`,
                      code: 502,
                      type: 'MALFORMED_STREAM_FRAME'
                    }
              );
              return true;
            }
            return false;
          };

          while (true) {
            if (upstreamGuard.isClientClosed() || res.writableEnded) {
              try {
                await reader.cancel();
              } catch (_) {}
              break;
            }
            const { done, value } = await reader.read();
            if (upstreamGuard.isClientClosed() || res.writableEnded) {
              try {
                await reader.cancel();
              } catch (_) {}
              break;
            }
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              const haltedOnError = await processOpenRouterSSELine(line);
              if (haltedOnError) return;
            }
          }

          // Process trailing bytes and buffer
          const finalBytes = decoder.decode();
          if (finalBytes) buffer += finalBytes;
          if (!streamFailed && !upstreamGuard.isClientClosed() && buffer && buffer.trim()) {
            const remainingLines = buffer.split('\n');
            for (const line of remainingLines) {
              const haltedOnError = await processOpenRouterSSELine(line);
              if (haltedOnError) return;
            }
            if (!streamFailed && currentEventType === 'error') {
              await emitOpenRouterStreamError(buffer.trim());
              return;
            }
          }

          if (!streamFailed && !upstreamGuard.isClientClosed()) {
            if (!sawDoneMarker && !lastFinishReason) {
              await emitOpenRouterStreamError('', {
                message: 'OpenRouter streaming connection closed unexpectedly before completion.',
                code: 503,
                type: 'STREAM_INTERRUPTED'
              });
              return;
            }
            if (fullText.length === 0) {
              await emitOpenRouterStreamError('', {
                message: 'OpenRouter stream completed without returning any response text.',
                code: 502,
                type: 'EMPTY_STREAM_RESPONSE'
              });
              return;
            }
          }

          // Continuation if finish_reason indicates token truncation
          if (!streamFailed && (lastFinishReason === 'length' || lastFinishReason === 'max_tokens') && !upstreamGuard.isClientClosed() && !res.writableEnded && fullText.length > 60) {
            try {
              const contMessages = [
                ...messages,
                { role: 'assistant', content: fullText },
                { role: 'user', content: 'Please continue directly from where you stopped. Complete any unfinished sentences, items, or sections without repeating previous text.' }
              ];
              const contRes = await upstreamGuard.fetchUpstream(
                openRouterChatEndpoint,
                {
                  method: 'POST',
                  headers: openRouterHeaders,
                  body: JSON.stringify({
                    model: selectedModel,
                    messages: contMessages,
                    max_tokens: Math.min(2048, openRouterMaxTokens),
                    temperature: 0.7,
                    stream: true
                  })
                },
                { provider: 'openrouter' }
              );

              if (contRes.ok && contRes.body) {
                const contReader = contRes.body.getReader();
                let contBuffer = '';
                let contEventType: string | null = null;
                while (true) {
                  if (upstreamGuard.isClientClosed() || res.writableEnded) {
                    try {
                      await contReader.cancel();
                    } catch (_) {}
                    break;
                  }
                  const { done: cDone, value: cVal } = await contReader.read();
                  if (cDone) break;
                  contBuffer += decoder.decode(cVal, { stream: true });
                  const cLines = contBuffer.split('\n');
                  contBuffer = cLines.pop() || '';
                  for (const cLine of cLines) {
                    const cTrimmed = cLine.trim();
                    if (!cTrimmed) {
                      contEventType = null;
                      continue;
                    }
                    if (cTrimmed.startsWith(':')) continue;
                    if (cTrimmed.startsWith('event:')) {
                      contEventType = cTrimmed.slice(6).trim().toLowerCase();
                      continue;
                    }
                    if (!cTrimmed.startsWith('data:')) continue;
                    const lineEvt = contEventType;
                    contEventType = null;
                    const cData = cTrimmed.slice(5).trim();
                    if (cData === '[DONE]') continue;
                    if (lineEvt === 'error') {
                      try {
                        await contReader.cancel();
                      } catch (_) {}
                      break;
                    }
                    try {
                      const cParsed = JSON.parse(cData);
                      if (cParsed.error) {
                        try {
                          await contReader.cancel();
                        } catch (_) {}
                        break;
                      }
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
          if (!streamFailed && !upstreamGuard.isClientClosed() && !res.writableEnded) {
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
          if (streamFailed || upstreamGuard.isClientDisconnected(streamErr)) {
            return;
          }
          streamFailed = true;
          logAIDiagnostic({
            category: 'streaming failure',
            provider: 'openrouter',
            model: modelUsed || selectedModel,
            phase: 'mid-stream',
            upstreamStatus: 503,
            upstreamErrorCode: 'STREAM_FAILED',
            sanitizedMessage: streamErr?.message || 'OpenRouter streaming interrupted'
          });
          if (!res.writableEnded) {
            sendSSE(res, {
              type: 'error',
              error: 'OpenRouter streaming connection interrupted.',
              code: 503,
              status: 'STREAM_FAILED',
              errorCode: 'STREAM_FAILED',
              provider: 'openrouter',
              model: modelUsed || selectedModel,
              retryable: false,
              canFallback: true,
              suggestedProviders: getConfiguredFallbackProviders('openrouter', isServerless),
              partial: fullText.length > 0,
              partialText: fullText.length > 0 ? fullText : undefined
            });
            res.end();
          }
          return;
        }
      }
    }

    // 4. Cloudflare Workers AI Provider (@cf/meta/llama-3.1-8b-instruct)
    if (normalizedProvider === 'cloudflare') {
      const accountId = (process.env.CLOUDFLARE_ACCOUNT_ID || '').trim();
      const apiToken = (process.env.CLOUDFLARE_API_TOKEN || '').trim();
      const modelId = validatedClientModel || '@cf/meta/llama-3.1-8b-instruct';

      if (!isConfiguredCredential(accountId) || !isConfiguredCredential(apiToken)) {
        if (!isDemoModeEnabled()) {
          return sendProviderNotConfiguredError(res, 'cloudflare', isServerless);
        }
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
            provider: 'cloudflare',
            isDemo: true
          });
        }
        initSSE(res);
        const stopHeartbeat = startSSEHeartbeat(res);
        sendSSE(res, { type: 'start', modelUsed: demoModel, provider: 'cloudflare', isDemo: true });

        const testDurationMatch = typeof prompt === 'string' ? prompt.match(/__test_stream_duration:(\d+)__/) : null;
        const testDurationSec = testDurationMatch
          ? parseInt(testDurationMatch[1], 10)
          : ((req.body as any)?.testStreamDurationSec ? Number((req.body as any).testStreamDurationSec) : null);

        if (testDurationSec && testDurationSec > 0) {
          const totalMs = testDurationSec * 1000;
          const tokens = text.split(/(\s+)/);
          const intervalMs = Math.max(80, Math.floor(totalMs / Math.max(tokens.length, 1)));
          for (const token of tokens) {
            if (upstreamGuard.isClientClosed() || res.writableEnded) break;
            sendSSE(res, { type: 'chunk', text: token });
            await sleepWithAbort(intervalMs, () => upstreamGuard.isClientClosed() || res.writableEnded);
          }
        } else {
          const tokens = text.split(/(\s+)/);
          for (const token of tokens) {
            if (upstreamGuard.isClientClosed() || res.writableEnded) break;
            sendSSE(res, { type: 'chunk', text: token });
            await sleepWithAbort(15, () => upstreamGuard.isClientClosed() || res.writableEnded);
          }
        }

        stopHeartbeat();
        if (!res.writableEnded) {
          sendSSE(res, { type: 'done', text, modelUsed: demoModel, provider: 'cloudflare', isDemo: true });
          res.end();
        }
        return;
      }

      const messages = formatOpenAIMessages({
        systemInstruction: effectiveSystemInstruction,
        history,
        prompt: effectivePrompt
      });

      const estimatedPromptTokens = Math.ceil(JSON.stringify(messages).length / 3.8);
      const maxContextTokens = 8192;
      if (estimatedPromptTokens >= maxContextTokens - 128) {
        const contextErrMsg = `Prompt is too large for the Cloudflare model context window (estimated ${estimatedPromptTokens} tokens, limit ${maxContextTokens}). Please shorten your message or start a new conversation.`;
        logAIDiagnostic({
          category: 'request validation error',
          provider: 'cloudflare',
          model: modelId,
          phase: shouldStream ? 'pre-stream' : 'non-streaming',
          upstreamStatus: 400,
          sanitizedMessage: contextErrMsg
        });
        return res.status(400).json({
          error: contextErrMsg,
          code: 400,
          status: 'CONTEXT_LENGTH_EXCEEDED',
          errorCode: 'CONTEXT_LENGTH_EXCEEDED',
          category: 'invalid request / model',
          provider: 'cloudflare',
          model: modelId,
          retryable: false,
          canFallback: true,
          suggestedProviders: getConfiguredFallbackProviders('cloudflare', isServerless)
        });
      }

      const availableTokenHeadroom = Math.max(256, maxContextTokens - estimatedPromptTokens - 256);

      let targetOutputTokens = 3072;
      if (preferences?.responseLength === 'detailed' || isLikelyLarge || isContinuation) {
        targetOutputTokens = 4096;
      } else if (preferences?.responseLength === 'concise') {
        targetOutputTokens = 1024;
      } else if (preferences?.responseLength === 'balanced') {
        targetOutputTokens = 2560;
      }

      const cfMaxTokens = Math.min(targetOutputTokens, availableTokenHeadroom);
      const cfEndpoint = `${getCloudflareApiBaseUrl()}/accounts/${encodeURIComponent(accountId)}/ai/run/${modelId}`;

      const normalizeCloudflareHttpError = (statusCode: number, errDetail: string) => {
        const lowerDetail = (errDetail || '').toLowerCase();
        const isContextLimit =
          (statusCode === 400 || statusCode === 413) &&
          (lowerDetail.includes('context length') ||
            lowerDetail.includes('context window') ||
            lowerDetail.includes('too many tokens') ||
            lowerDetail.includes('maximum context') ||
            lowerDetail.includes('prompt is too long') ||
            lowerDetail.includes('exceeds maximum') ||
            lowerDetail.includes('max_tokens'));

        if (isContextLimit) {
          return {
            status: 'CONTEXT_LENGTH_EXCEEDED',
            errorCode: 'CONTEXT_LENGTH_EXCEEDED',
            category: 'request validation error' as AIDiagnosticCategory,
            isRetryable: false,
            friendlyError: 'Prompt exceeds the Cloudflare model context window. Please shorten your message or clear older conversation turns.'
          };
        }

        const parsed = parseGeminiError({ status: statusCode, message: errDetail || `HTTP ${statusCode}` }, 'cloudflare');
        let friendlyError = parsed.message;
        let status = parsed.status;
        let isRetryable = parsed.isRetryable;

        if (statusCode === 401 || statusCode === 403) {
          friendlyError = 'Invalid or unauthorized Cloudflare API token. Please verify CLOUDFLARE_API_TOKEN.';
          status = statusCode === 401 ? 'UNAUTHENTICATED' : 'PERMISSION_DENIED';
          isRetryable = false;
        } else if (statusCode === 404) {
          friendlyError = 'Cloudflare account or model not found. Please verify CLOUDFLARE_ACCOUNT_ID and model availability.';
          status = 'NOT_FOUND';
          isRetryable = false;
        } else if (statusCode === 400) {
          status = 'INVALID_ARGUMENT';
          isRetryable = false;
        } else if (statusCode === 429) {
          status = 'RESOURCE_EXHAUSTED';
          isRetryable = true;
        } else if (statusCode === 500 || statusCode === 502 || statusCode === 503 || statusCode === 504) {
          isRetryable = true;
          if (statusCode === 500) status = 'INTERNAL';
          else if (statusCode === 502) status = 'BAD_GATEWAY';
          else if (statusCode === 503) status = 'UNAVAILABLE';
          else if (statusCode === 504) status = 'DEADLINE_EXCEEDED';
        }

        return {
          status,
          errorCode: status,
          category: parsed.category,
          isRetryable,
          friendlyError
        };
      };

      if (!shouldStream) {
        try {
          const cfRes = await upstreamGuard.fetchUpstream(
            cfEndpoint,
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${apiToken}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                messages,
                stream: false,
                max_tokens: cfMaxTokens,
                temperature: 0.6
              })
            },
            { provider: 'cloudflare' }
          );

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

            const normalizedErr = normalizeCloudflareHttpError(cfRes.status, errDetail || cfRes.statusText);

            logAIDiagnostic({
              category: normalizedErr.category,
              provider: 'cloudflare',
              model: modelId,
              phase: 'non-streaming',
              upstreamStatus: cfRes.status,
              sanitizedMessage: normalizedErr.friendlyError
            });

            return res.status(cfRes.status).json({
              error: normalizedErr.friendlyError,
              code: cfRes.status,
              status: normalizedErr.status,
              errorCode: normalizedErr.errorCode,
              category: normalizedErr.category,
              provider: 'cloudflare',
              model: modelId,
              retryable: normalizedErr.isRetryable,
              canFallback: true,
              suggestedProviders: getConfiguredFallbackProviders('cloudflare', isServerless)
            });
          }

          let data: any;
          try {
            data = await cfRes.json();
          } catch (_) {
            return res.status(502).json({
              error: 'Cloudflare returned an invalid JSON response.',
              code: 502,
              status: 'MALFORMED_UPSTREAM_RESPONSE',
              errorCode: 'MALFORMED_UPSTREAM_RESPONSE',
              category: 'upstream unavailable',
              provider: 'cloudflare',
              model: modelId,
              retryable: true,
              canFallback: true,
              suggestedProviders: getConfiguredFallbackProviders('cloudflare', isServerless)
            });
          }

          if (upstreamGuard.isClientClosed()) return;

          if (data?.success === false || (Array.isArray(data?.errors) && data.errors.length > 0)) {
            const errMsg = Array.isArray(data?.errors) && data.errors.length > 0
              ? data.errors.map((e: any) => e?.message || JSON.stringify(e)).join('; ')
              : (typeof data?.error === 'string' ? data.error : 'Cloudflare Workers AI reported an upstream failure.');
            const normalizedErr = normalizeCloudflareHttpError(502, errMsg);
            return res.status(502).json({
              error: normalizedErr.friendlyError,
              code: 502,
              status: normalizedErr.status,
              errorCode: normalizedErr.errorCode,
              category: normalizedErr.category,
              provider: 'cloudflare',
              model: modelId,
              retryable: normalizedErr.isRetryable,
              canFallback: true,
              suggestedProviders: getConfiguredFallbackProviders('cloudflare', isServerless)
            });
          }

          let text =
            data?.result?.response ??
            data?.choices?.[0]?.message?.content ??
            (typeof data?.result === 'string' ? data.result : '') ??
            '';
          if (typeof text !== 'string') {
            text = String(text || '');
          }

          if (!text.trim()) {
            return res.status(502).json({
              error: 'Cloudflare Workers AI returned an empty response.',
              code: 502,
              status: 'EMPTY_UPSTREAM_RESPONSE',
              errorCode: 'EMPTY_UPSTREAM_RESPONSE',
              category: 'upstream unavailable',
              provider: 'cloudflare',
              model: modelId,
              retryable: true,
              canFallback: true,
              suggestedProviders: getConfiguredFallbackProviders('cloudflare', isServerless)
            });
          }

          const finishReason = data?.result?.finish_reason || data?.choices?.[0]?.finish_reason || (data?.result?.usage?.completion_tokens >= cfMaxTokens ? 'length' : null);

          // Transparent continuation if Cloudflare reached output token limit
          if (finishReason === 'length' && text.length > 60 && !upstreamGuard.isClientClosed()) {
            try {
              const contMessages = [
                ...messages,
                { role: 'assistant', content: text },
                { role: 'user', content: 'Please continue directly from where you stopped. Complete any unfinished sentences, items, or sections without repeating previous text.' }
              ];
              const contRes = await upstreamGuard.fetchUpstream(
                cfEndpoint,
                {
                  method: 'POST',
                  headers: {
                    Authorization: `Bearer ${apiToken}`,
                    'Content-Type': 'application/json'
                  },
                  body: JSON.stringify({
                    messages: contMessages,
                    stream: false,
                    max_tokens: Math.min(2048, cfMaxTokens),
                    temperature: 0.6
                  })
                },
                { provider: 'cloudflare' }
              );
              if (contRes.ok) {
                const contData = await contRes.json();
                const contText = contData?.result?.response || (typeof contData?.result === 'string' ? contData.result : '');
                if (contText) {
                  text += (text.endsWith(' ') || contText.startsWith(' ') ? '' : ' ') + contText;
                }
              }
            } catch (_) {}
          }

          if (upstreamGuard.isClientClosed()) return;
          if (isLikelyLarge && !isContinuation && !responseHasContinuationNotice(text)) {
            text += CONTINUATION_NOTICES.PART_1;
          }
          return res.json({
            text,
            modelUsed: modelId,
            provider: 'cloudflare'
          });
        } catch (fetchErr: any) {
          if (upstreamGuard.isClientDisconnected(fetchErr)) {
            return;
          }
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
            errorCode: parsed.status,
            category: parsed.category,
            provider: 'cloudflare',
            model: modelId,
            retryable: parsed.isRetryable,
            canFallback: true,
            suggestedProviders: getConfiguredFallbackProviders('cloudflare', isServerless)
          });
        }
      } else {
        // Genuine streaming via Cloudflare Workers AI SSE
        let cfRes: Response;
        try {
          cfRes = await upstreamGuard.fetchUpstream(
            cfEndpoint,
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${apiToken}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                messages,
                stream: true,
                max_tokens: cfMaxTokens,
                temperature: 0.6
              })
            },
            { provider: 'cloudflare' }
          );
        } catch (fetchErr: any) {
          if (upstreamGuard.isClientDisconnected(fetchErr)) {
            return;
          }
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
            errorCode: parsed.status,
            category: parsed.category,
            provider: 'cloudflare',
            model: modelId,
            retryable: parsed.isRetryable,
            canFallback: true,
            suggestedProviders: getConfiguredFallbackProviders('cloudflare', isServerless)
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

          const normalizedErr = normalizeCloudflareHttpError(cfRes.status, errDetail || cfRes.statusText);

          logAIDiagnostic({
            category: normalizedErr.category,
            provider: 'cloudflare',
            model: modelId,
            phase: 'pre-stream',
            upstreamStatus: cfRes.status,
            sanitizedMessage: normalizedErr.friendlyError
          });

          return res.status(cfRes.status).json({
            error: normalizedErr.friendlyError,
            code: cfRes.status,
            status: normalizedErr.status,
            errorCode: normalizedErr.errorCode,
            category: normalizedErr.category,
            provider: 'cloudflare',
            model: modelId,
            retryable: normalizedErr.isRetryable,
            canFallback: true,
            suggestedProviders: getConfiguredFallbackProviders('cloudflare', isServerless)
          });
        }

        if (upstreamGuard.isClientClosed()) return;
        const contentType = cfRes.headers.get('content-type') || '';

        if (contentType.includes('application/json') || !cfRes.body) {
          let data: any;
          try {
            data = await cfRes.json();
          } catch (_) {
            return res.status(502).json({
              error: 'Cloudflare returned an invalid JSON response.',
              code: 502,
              status: 'MALFORMED_UPSTREAM_RESPONSE',
              errorCode: 'MALFORMED_UPSTREAM_RESPONSE',
              category: 'upstream unavailable',
              provider: 'cloudflare',
              model: modelId,
              retryable: true,
              canFallback: true,
              suggestedProviders: getConfiguredFallbackProviders('cloudflare', isServerless)
            });
          }

          if (upstreamGuard.isClientClosed()) return;

          if (data?.success === false || (Array.isArray(data?.errors) && data.errors.length > 0)) {
            const errMsg = Array.isArray(data?.errors) && data.errors.length > 0
              ? data.errors.map((e: any) => e?.message || JSON.stringify(e)).join('; ')
              : (typeof data?.error === 'string' ? data.error : 'Cloudflare Workers AI reported an upstream failure.');
            const normalizedErr = normalizeCloudflareHttpError(502, errMsg);
            return res.status(502).json({
              error: normalizedErr.friendlyError,
              code: 502,
              status: normalizedErr.status,
              errorCode: normalizedErr.errorCode,
              category: normalizedErr.category,
              provider: 'cloudflare',
              model: modelId,
              retryable: normalizedErr.isRetryable,
              canFallback: true,
              suggestedProviders: getConfiguredFallbackProviders('cloudflare', isServerless)
            });
          }

          let fullText =
            data?.result?.response ??
            data?.choices?.[0]?.message?.content ??
            (typeof data?.result === 'string' ? data.result : '') ??
            '';
          if (typeof fullText !== 'string') {
            fullText = String(fullText || '');
          }

          if (!fullText.trim()) {
            return res.status(502).json({
              error: 'Cloudflare Workers AI returned an empty response.',
              code: 502,
              status: 'EMPTY_UPSTREAM_RESPONSE',
              errorCode: 'EMPTY_UPSTREAM_RESPONSE',
              category: 'upstream unavailable',
              provider: 'cloudflare',
              model: modelId,
              retryable: true,
              canFallback: true,
              suggestedProviders: getConfiguredFallbackProviders('cloudflare', isServerless)
            });
          }

          if (isLikelyLarge && !isContinuation && !responseHasContinuationNotice(fullText)) {
            fullText += CONTINUATION_NOTICES.PART_1;
          }
          initSSE(res);
          sendSSE(res, { type: 'start', modelUsed: modelId, provider: 'cloudflare' });
          sendSSE(res, { type: 'chunk', text: fullText });
          sendSSE(res, { type: 'done', text: fullText, modelUsed: modelId, provider: 'cloudflare' });
          res.end();
          return;
        }

        initSSE(res);
        const stopHeartbeat = startSSEHeartbeat(res);
        sendSSE(res, { type: 'start', modelUsed: modelId, provider: 'cloudflare' });

        let fullText = '';
        let lastFinishReason: string | null = null;
        let sawDoneSentinel = false;
        let sawErrorEvent = false;
        let streamFailed = false;

        const emitCloudflareStreamError = (
          errMessage: string,
          status = 'STREAM_FAILED',
          code = 502,
          retryable = false
        ) => {
          if (streamFailed || upstreamGuard.isClientClosed() || res.writableEnded) return;
          streamFailed = true;
          stopHeartbeat();
          logAIDiagnostic({
            category: 'streaming failure',
            provider: 'cloudflare',
            model: modelId,
            phase: 'mid-stream',
            upstreamStatus: code,
            sanitizedMessage: errMessage
          });
          sendSSE(res, {
            type: 'error',
            error: errMessage,
            code,
            status,
            errorCode: status,
            provider: 'cloudflare',
            model: modelId,
            retryable,
            canFallback: true,
            suggestedProviders: getConfiguredFallbackProviders('cloudflare', isServerless),
            partial: fullText.length > 0,
            ...(fullText.length > 0 ? { partialText: fullText } : {})
          });
          res.end();
        };

        const processCloudflareSSELine = (rawLine: string): boolean => {
          const trimmed = rawLine.trim();
          if (!trimmed) {
            sawErrorEvent = false;
            return true;
          }
          if (trimmed.startsWith(':')) {
            return true;
          }
          if (trimmed.startsWith('event:')) {
            const eventType = trimmed.slice(6).trim().toLowerCase();
            sawErrorEvent = eventType === 'error';
            return true;
          }
          if (!trimmed.startsWith('data:')) {
            return true;
          }

          const dataStr = trimmed.slice(5).trim();
          if (!dataStr) return true;
          if (dataStr === '[DONE]') {
            sawDoneSentinel = true;
            return true;
          }

          let parsed: any;
          try {
            parsed = JSON.parse(dataStr);
          } catch (_) {
            emitCloudflareStreamError(
              'Malformed SSE data frame received from Cloudflare stream.',
              'MALFORMED_STREAM_FRAME',
              502,
              false
            );
            return false;
          }

          if (
            sawErrorEvent ||
            parsed?.error ||
            (Array.isArray(parsed?.errors) && parsed.errors.length > 0) ||
            parsed?.success === false
          ) {
            const upstreamErrMsg =
              typeof parsed?.error === 'string'
                ? parsed.error
                : parsed?.error?.message ||
                  (Array.isArray(parsed?.errors) && parsed.errors[0]?.message) ||
                  'Cloudflare Workers AI reported an error during streaming.';
            emitCloudflareStreamError(upstreamErrMsg, 'UPSTREAM_STREAM_ERROR', 502, false);
            return false;
          }

          const finishReason =
            parsed?.finish_reason ??
            parsed?.result?.finish_reason ??
            parsed?.choices?.[0]?.finish_reason ??
            null;
          if (finishReason) {
            lastFinishReason = finishReason;
            if (String(finishReason).toLowerCase() === 'error') {
              emitCloudflareStreamError(
                'Cloudflare stream terminated with finish_reason=error.',
                'STREAM_FINISH_ERROR',
                502,
                false
              );
              return false;
            }
          }

          const delta =
            parsed?.response ??
            parsed?.result?.response ??
            parsed?.choices?.[0]?.delta?.content ??
            '';
          if (typeof delta === 'string' && delta.length > 0) {
            fullText += delta;
            sendSSE(res, { type: 'chunk', text: delta });
          }

          return true;
        };

        try {
          const reader = cfRes.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          while (true) {
            if (upstreamGuard.isClientClosed() || res.writableEnded || streamFailed) {
              try {
                await reader.cancel();
              } catch (_) {}
              break;
            }

            const { done, value } = await reader.read();
            if (upstreamGuard.isClientClosed() || res.writableEnded || streamFailed) {
              try {
                await reader.cancel();
              } catch (_) {}
              break;
            }
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (!processCloudflareSSELine(line)) {
                try {
                  await reader.cancel();
                } catch (_) {}
                break;
              }
            }
          }

          // Process any trailing bytes and lines in buffer
          const finalBytes = decoder.decode();
          if (finalBytes) {
            buffer += finalBytes;
          }
          if (!upstreamGuard.isClientClosed() && !res.writableEnded && !streamFailed && buffer.trim()) {
            const remainingLines = buffer.split('\n');
            for (const remLine of remainingLines) {
              if (!processCloudflareSSELine(remLine)) {
                break;
              }
            }
          }

          if (streamFailed || upstreamGuard.isClientClosed() || res.writableEnded) {
            stopHeartbeat();
            return;
          }

          const completedCleanly =
            sawDoneSentinel ||
            (lastFinishReason !== null && lastFinishReason !== '');

          if (!completedCleanly) {
            emitCloudflareStreamError(
              'Cloudflare stream closed prematurely before completion signal.',
              'STREAM_INTERRUPTED',
              502,
              false
            );
            return;
          }

          if (!fullText.trim()) {
            emitCloudflareStreamError(
              'Cloudflare stream completed without returning any response content.',
              'EMPTY_STREAM_RESPONSE',
              502,
              true
            );
            return;
          }

          // Transparent continuation if Cloudflare reached output token ceiling mid-generation
          if (lastFinishReason === 'length' && !upstreamGuard.isClientClosed() && !res.writableEnded && fullText.length > 60) {
            try {
              const contMessages = [
                ...messages,
                { role: 'assistant', content: fullText },
                { role: 'user', content: 'Please continue directly from where you stopped. Complete any unfinished sentences, items, or sections without repeating previous text.' }
              ];
              const contRes = await upstreamGuard.fetchUpstream(
                cfEndpoint,
                {
                  method: 'POST',
                  headers: {
                    Authorization: `Bearer ${apiToken}`,
                    'Content-Type': 'application/json'
                  },
                  body: JSON.stringify({
                    messages: contMessages,
                    stream: true,
                    max_tokens: Math.min(2048, cfMaxTokens),
                    temperature: 0.6
                  })
                },
                { provider: 'cloudflare' }
              );

              if (contRes.ok && contRes.body) {
                const contReader = contRes.body.getReader();
                let contBuffer = '';
                let contFinishReason: string | null = null;
                while (true) {
                  if (upstreamGuard.isClientClosed() || res.writableEnded) {
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
            } catch (contErr: any) {
              if (!upstreamGuard.isClientDisconnected(contErr)) {
                console.warn('[Cloudflare] Streaming continuation notice:', sanitizeErrorLog(contErr?.message || String(contErr)));
              }
            }
          }

          stopHeartbeat();
          if (!upstreamGuard.isClientClosed() && !res.writableEnded && !streamFailed) {
            if (lastFinishReason === 'length' && !responseHasContinuationNotice(fullText)) {
              sendSSE(res, { type: 'chunk', text: CONTINUATION_NOTICES.PART_N });
              fullText += CONTINUATION_NOTICES.PART_N;
            } else if (isLikelyLarge && !isContinuation && !responseHasContinuationNotice(fullText)) {
              sendSSE(res, { type: 'chunk', text: CONTINUATION_NOTICES.PART_1 });
              fullText += CONTINUATION_NOTICES.PART_1;
            }
            sendSSE(res, { type: 'done', text: fullText, modelUsed: modelId, provider: 'cloudflare' });
            res.end();
          }
          return;
        } catch (streamErr: any) {
          if (upstreamGuard.isClientDisconnected(streamErr)) {
            stopHeartbeat();
            return;
          }
          emitCloudflareStreamError(
            'Cloudflare streaming connection interrupted.',
            'STREAM_FAILED',
            503,
            false
          );
          return;
        }
      }
    }

    if (provider.toLowerCase() === 'webllm') {
      logAIDiagnostic({
        category: 'request validation error',
        provider: 'webllm',
        phase: 'validation',
        upstreamStatus: 400,
        upstreamErrorCode: 'LOCAL_PROVIDER_ONLY',
        sanitizedMessage: 'Browser AI (WebLLM) runs on-device in the browser via WebGPU and cannot be dispatched to the server-side /api/chat endpoint.',
        willRetry: false
      });
      return res.status(400).json({
        error: 'Browser AI (WebLLM) runs on-device in the browser via WebGPU and cannot be dispatched to the server-side /api/chat endpoint.',
        code: 400,
        status: 'LOCAL_PROVIDER_ONLY',
        errorCode: 'LOCAL_PROVIDER_ONLY',
        provider: 'webllm',
        retryable: false,
        canFallback: false
      });
    }

    return res.status(400).json({ error: `Unknown provider: ${provider}` });
  } catch (error: any) {
    if (error?.isClientDisconnected || error?.code === 'CLIENT_DISCONNECTED') {
      return;
    }
    console.error('API Error in /api/chat:', sanitizeErrorLog(error?.message || String(error)));
    const providerName = String(req.body?.provider || 'unknown');
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
      if (!res.writableEnded) {
        sendSSE(res, {
          type: 'error',
          error: parsed.message,
          code: parsed.statusCode,
          status: parsed.status,
          provider: providerName,
          retryable: parsed.isRetryable,
          canFallback: parsed.isUnavailable ? true : false,
          suggestedProviders: getConfiguredFallbackProviders(providerName, isServerless)
        });
        res.end();
      }
    } else {
      res.status(parsed.statusCode).json({
        error: parsed.message,
        code: parsed.statusCode,
        status: parsed.status,
        provider: providerName,
        retryable: parsed.isRetryable,
        canFallback: parsed.isUnavailable ? true : false,
        suggestedProviders: getConfiguredFallbackProviders(providerName, isServerless)
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

export function buildGeminiImageParts({
  attachments = [],
  availableDocs = [],
  registry = fileRegistry,
  uploadDir = UPLOAD_DIR,
  maxImageBytes = MAX_VISION_IMAGE_BYTES,
  maxRequestBytes = MAX_CHAT_REQUEST_BYTES
}: {
  attachments?: any[];
  availableDocs?: any[];
  registry?: Map<string, any>;
  uploadDir?: string;
  maxImageBytes?: number;
  maxRequestBytes?: number;
} = {}): Array<{ mimeType: string; data: string }> {
  return buildVisionImageParts({
    attachments,
    availableDocs,
    maxImageBytes,
    maxRequestBytes,
    resolveRegisteredFile: (id: string) => {
      const rec = registry?.get(id);
      if (!rec) return null;
      let buf = rec.buffer;
      if (!buf && rec.diskFilename && uploadDir) {
        const fullDiskPath = path.join(uploadDir, rec.diskFilename);
        try {
          if (fs.existsSync(fullDiskPath)) {
            buf = fs.readFileSync(fullDiskPath);
          }
        } catch (_) {}
      }
      return {
        ...rec,
        buffer: buf
      };
    }
  });
}

if (!process.env.VERCEL && !process.env.TESTING) {
  startServer();
}

export { app };