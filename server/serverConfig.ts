import express from 'express';
import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import type { GeminiTimeoutStage } from './serverTypes.ts';
import { logAIDiagnostic } from './diagnosticLogger.ts';
// @ts-ignore - provider model sanitizer service
import { getProviderDisplayName } from '../src/services/providerModelSanitizer.js';

const __filename =
  typeof import.meta !== 'undefined' && import.meta.url
    ? fileURLToPath(import.meta.url)
    : path.resolve(process.cwd(), 'server', 'serverConfig.ts');
const __dirname = path.dirname(__filename);

export function getGroqApiBaseUrl(): string {
  const customBase = (process.env.ORVIX_GROQ_BASE_URL || '').trim().replace(/\/+$/, '');
  return customBase || 'https://api.groq.com/openai/v1';
}

export function getOpenRouterApiBaseUrl(): string {
  const customBase = (process.env.ORVIX_OPENROUTER_BASE_URL || '').trim().replace(/\/+$/, '');
  return customBase || 'https://openrouter.ai/api/v1';
}

export function getCloudflareApiBaseUrl(): string {
  const customBase = (process.env.ORVIX_CLOUDFLARE_BASE_URL || '').trim().replace(/\/+$/, '');
  return customBase || 'https://api.cloudflare.com/client/v4';
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

// Distinct Gemini timeout tiers:
export const GEMINI_HEADER_TIMEOUT_MS = 45_000;
export const GEMINI_PRIMARY_FAILOVER_HEADER_TIMEOUT_MS = 20_000;
export const GEMINI_FIRST_BYTE_TIMEOUT_MS = 45_000;
export const GEMINI_STREAM_INACTIVITY_TIMEOUT_MS = 45_000;
export const GEMINI_TOTAL_REQUEST_TIMEOUT_MS = 270_000;
export const GEMINI_UNARY_TIMEOUT_MS = 90_000;

export function getGeminiHeaderTimeoutMs(hasFallbackModel = false): number {
  const explicitGemini = Number(process.env.ORVIX_GEMINI_HEADER_TIMEOUT_MS);
  if (Number.isFinite(explicitGemini) && explicitGemini > 0) {
    return Math.floor(explicitGemini);
  }
  const explicitUpstream = Number(process.env.ORVIX_UPSTREAM_HEADERS_TIMEOUT_MS);
  if (Number.isFinite(explicitUpstream) && explicitUpstream > 0) {
    return Math.floor(explicitUpstream);
  }
  return hasFallbackModel ? GEMINI_PRIMARY_FAILOVER_HEADER_TIMEOUT_MS : GEMINI_HEADER_TIMEOUT_MS;
}

export function getGeminiFirstByteTimeoutMs(): number {
  const raw = Number(process.env.ORVIX_GEMINI_FIRST_BYTE_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  return GEMINI_FIRST_BYTE_TIMEOUT_MS;
}

export function getGeminiStreamInactivityTimeoutMs(): number {
  const raw = Number(process.env.ORVIX_GEMINI_STREAM_INACTIVITY_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  return GEMINI_STREAM_INACTIVITY_TIMEOUT_MS;
}

export function getGeminiTotalRequestTimeoutMs(): number {
  const raw = Number(
    process.env.ORVIX_GEMINI_TOTAL_REQUEST_TIMEOUT_MS ||
      process.env.ORVIX_GEMINI_TOTAL_TIMEOUT_MS
  );
  if (Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  return GEMINI_TOTAL_REQUEST_TIMEOUT_MS;
}

export function getGeminiUnaryTimeoutMs(hasFallbackModel = false): number {
  const raw = Number(process.env.ORVIX_GEMINI_UNARY_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  const explicitUpstream = Number(process.env.ORVIX_UPSTREAM_HEADERS_TIMEOUT_MS);
  if (Number.isFinite(explicitUpstream) && explicitUpstream > 0) {
    return Math.floor(explicitUpstream);
  }
  return hasFallbackModel ? 30_000 : GEMINI_UNARY_TIMEOUT_MS;
}

export function createGeminiStageTimeoutError(
  stage: GeminiTimeoutStage,
  timeoutMs: number,
  streamedAnyChunk = false
): Error {
  const seconds = Math.max(0.1, Math.round((timeoutMs / 1000) * 10) / 10);
  let stageDescription = 'waiting for initial response headers';
  if (stage === 'first_byte_timeout') {
    stageDescription = 'waiting for the first response chunk';
  } else if (stage === 'stream_inactivity_timeout') {
    stageDescription = 'due to stream inactivity';
  } else if (stage === 'total_request_timeout') {
    stageDescription = 'after reaching maximum request lifetime';
  } else if (stage === 'unary_timeout') {
    stageDescription = 'waiting for response generation';
  }

  const err: any = new Error(
    `The request to Google Gemini timed out after ${seconds}s ${stageDescription}. Please try again.`
  );
  err.name = 'TimeoutError';
  err.status = 504;
  err.code = 'DEADLINE_EXCEEDED';
  err.timeoutStage = stage;
  err.timeoutMs = timeoutMs;
  err.isUpstreamHeadersTimeout = stage === 'header_timeout';
  err.isGeminiTimeout = true;
  err.streamedAnyChunk = streamedAnyChunk;
  return err;
}

export function isDemoModeEnabled(): boolean {
  return String(process.env.ORVIX_ENABLE_DEMO_MODE || '').trim().toLowerCase() === 'true';
}

let serverEnvLoaded = false;

/**
 * Ensures local/production .env files are loaded into process.env before credential inspection,
 * even if serverConfig.ts is imported directly before server.ts in serverless or test runtimes.
 */
export function ensureServerEnvLoaded(): void {
  if (serverEnvLoaded) return;
  serverEnvLoaded = true;
  try {
    const envFiles = ['.env', '.env.local', '.env.production', '.env.production.local'];
    const roots = Array.from(
      new Set([
        typeof process !== 'undefined' && process.cwd ? process.cwd() : '',
        __dirname,
        path.resolve(__dirname, '..')
      ].filter(Boolean))
    );

    for (const rootDir of roots) {
      for (const file of envFiles) {
        const fullPath = path.resolve(rootDir, file);
        if (!fs.existsSync(fullPath)) continue;
        const content = fs.readFileSync(fullPath, 'utf-8');
        for (const rawLine of content.split(/\r?\n/)) {
          const line = rawLine.trim();
          if (!line || line.startsWith('#')) continue;
          const normalizedLine = line.startsWith('export ') ? line.slice(7).trim() : line;
          const eqIdx = normalizedLine.indexOf('=');
          if (eqIdx <= 0) continue;
          const key = normalizedLine.slice(0, eqIdx).trim();
          let val = normalizedLine.slice(eqIdx + 1).trim();
          if (
            (val.startsWith('"') && val.endsWith('"')) ||
            (val.startsWith("'") && val.endsWith("'"))
          ) {
            val = val.slice(1, -1).trim();
          }
          if (key && (!process.env[key] || !process.env[key]?.trim())) {
            process.env[key] = val;
          }
        }
      }
    }
  } catch (_) {
    // Non-fatal in read-only or restricted serverless environments
  }
}

/**
 * Strips surrounding quotes, zero-width characters, accidental "Bearer " prefixes, and whitespace.
 */
export function sanitizeCredentialValue(value: unknown): string {
  if (typeof value !== 'string') return '';
  const cleaned = value
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/^[\s"'\u201C\u201D\u2018\u2019`]+|[\s"'\u201C\u201D\u2018\u2019`]+$/g, '')
    .trim();
  return cleaned.replace(/^Bearer\s+/i, '').trim();
}

export function isConfiguredCredential(value: string): boolean {
  const sanitized = sanitizeCredentialValue(value);
  if (!sanitized) return false;
  if (/^(?:undefined|null|none|false|true|todo|changeme|na|n\/a)$/i.test(sanitized)) return false;
  if (/^(?:your|my|replace|insert|placeholder|enter)_[a-z0-9_-]+$/i.test(sanitized)) {
    return false;
  }
  if (/^<[^>]+>$/.test(sanitized) || /^x{4,}$/i.test(sanitized)) {
    return false;
  }
  return true;
}

/**
 * Resolves a credential string from a list of candidate environment variable names.
 * Inspects process.env sequentially (skipping empty or placeholder values so valid fallback aliases win),
 * and falls back to a trimmed case-insensitive key scan for hosting dashboards with accidental key whitespace.
 */
function isClientPrefixedEnvKey(name: string): boolean {
  const upper = name.trim().toUpperCase();
  return (
    upper.startsWith('VITE_') ||
    upper.startsWith('NEXT_PUBLIC_') ||
    upper.startsWith('REACT_APP_')
  );
}

export function resolveEnvCredential(...candidateNames: string[]): string {
  ensureServerEnvLoaded();

  const serverCandidateNames = candidateNames.filter(
    (name) => typeof name === 'string' && !isClientPrefixedEnvKey(name)
  );

  // 1. Direct lookup across approved server candidate names in priority order
  for (const name of serverCandidateNames) {
    const raw = process.env[name];
    if (typeof raw === 'string') {
      const sanitized = sanitizeCredentialValue(raw);
      if (isConfiguredCredential(sanitized)) {
        return sanitized;
      }
    }
  }

  // 2. Fallback: trimmed case-insensitive key match in process.env
  const envEntries = Object.entries(process.env);
  for (const name of serverCandidateNames) {
    const targetUpper = name.trim().toUpperCase();
    for (const [envKey, rawVal] of envEntries) {
      if (isClientPrefixedEnvKey(envKey)) continue;
      if (typeof rawVal === 'string' && envKey.trim().toUpperCase() === targetUpper) {
        const sanitized = sanitizeCredentialValue(rawVal);
        if (isConfiguredCredential(sanitized)) {
          return sanitized;
        }
      }
    }
  }

  return '';
}

export const MIN_SIGNED_DECODE_URL_SECRET_LENGTH = 32;

export const SIGNED_DECODE_URL_SECRET_ENV_KEYS = [
  'ORVIX_SIGNED_URL_SECRET',
  'SIGNED_DECODE_URL_SECRET',
  'SESSION_SECRET'
] as const;

const WEAK_SECRET_LITERALS = new Set([
  'secret',
  'default',
  'example',
  'sample',
  'password',
  'passphrase',
  'token',
  'apikey',
  'api_key',
  'dev_secret',
  'dev-secret',
  'test_secret',
  'test-secret',
  'change_this',
  'change-this',
  'replace_this',
  'replace-this',
  'insert_secret',
  'insert-secret'
]);

let forceProductionSignedUrlCheckForTesting: boolean | null = null;

/**
 * Test hook to explicitly simulate production startup validation without altering process.env.NODE_ENV globally.
 */
export function setForceProductionSignedUrlSecretCheckForTesting(forced: boolean | null): void {
  forceProductionSignedUrlCheckForTesting = forced;
}

/**
 * Returns true when running in a production or multi-instance serverless deployment where
 * a shared, pre-configured signed decode secret is strictly required.
 */
export function isSignedDecodeProductionMode(): boolean {
  if (forceProductionSignedUrlCheckForTesting !== null) {
    return forceProductionSignedUrlCheckForTesting;
  }
  if (process.env.TESTING === '1' || process.env.TESTING === 'true') {
    return false;
  }
  return (
    process.env.NODE_ENV === 'production' ||
    Boolean(process.env.VERCEL) ||
    Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME) ||
    Boolean(process.env.LAMBDA_TASK_ROOT) ||
    Boolean(process.env.SERVERLESS)
  );
}

/**
 * Strips zero-width characters, surrounding quotes, and outer whitespace from a signing secret
 * without altering internal token characters or exposing its value.
 */
export function sanitizeSigningSecretValue(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/^[\s"'\u201C\u201D\u2018\u2019`]+|[\s"'\u201C\u201D\u2018\u2019`]+$/g, '')
    .trim();
}

export function validateSignedDecodeUrlSecretValue(rawValue: unknown):
  | { valid: true; secret: string }
  | { valid: false; reason: 'missing' | 'placeholder' | 'too_short' | 'low_entropy'; detail: string } {
  const cleaned = sanitizeSigningSecretValue(rawValue);
  if (!cleaned) {
    return {
      valid: false,
      reason: 'missing',
      detail: 'Secret value is empty.'
    };
  }

  if (!isConfiguredCredential(cleaned) || WEAK_SECRET_LITERALS.has(cleaned.toLowerCase())) {
    return {
      valid: false,
      reason: 'placeholder',
      detail: 'Secret value uses an insecure placeholder or default literal.'
    };
  }

  if (cleaned.length < MIN_SIGNED_DECODE_URL_SECRET_LENGTH) {
    return {
      valid: false,
      reason: 'too_short',
      detail: `Secret must be at least ${MIN_SIGNED_DECODE_URL_SECRET_LENGTH} characters long.`
    };
  }

  if (new Set(cleaned).size < 4) {
    return {
      valid: false,
      reason: 'low_entropy',
      detail: 'Secret has insufficient character diversity.'
    };
  }

  return { valid: true, secret: cleaned };
}

function lookupRawEnvCandidate(candidateName: string): string | undefined {
  if (typeof process.env[candidateName] === 'string') {
    return process.env[candidateName];
  }
  const targetUpper = candidateName.trim().toUpperCase();
  for (const [envKey, rawVal] of Object.entries(process.env)) {
    if (typeof rawVal === 'string' && envKey.trim().toUpperCase() === targetUpper) {
      return rawVal;
    }
  }
  return undefined;
}

export interface SignedDecodeUrlSecretResolution {
  configured: boolean;
  valid: boolean;
  secret: string | null;
  sourceKey: string | null;
  invalidReason?: 'missing' | 'placeholder' | 'too_short' | 'low_entropy';
  errorMessage?: string;
}

/**
 * Resolves and validates the shared HMAC secret used to sign & verify /api/upload/:id/file decoding URLs.
 * Never logs or includes secret values in error messages.
 */
export function resolveConfiguredSignedDecodeUrlSecret(): SignedDecodeUrlSecretResolution {
  ensureServerEnvLoaded();

  for (const key of SIGNED_DECODE_URL_SECRET_ENV_KEYS) {
    const raw = lookupRawEnvCandidate(key);
    if (typeof raw !== 'string') continue;

    // Treat empty string (e.g. "ORVIX_SIGNED_URL_SECRET=") as unset so fallbacks can still be checked
    const trimmed = sanitizeSigningSecretValue(raw);
    if (!trimmed) continue;

    const validation = validateSignedDecodeUrlSecretValue(raw);
    if (!validation.valid) {
      return {
        configured: true,
        valid: false,
        secret: null,
        sourceKey: key,
        invalidReason: validation.reason,
        errorMessage: `Invalid ${key}: ${validation.detail} Configure a shared random secret of at least ${MIN_SIGNED_DECODE_URL_SECRET_LENGTH} characters across all server instances.`
      };
    }

    return {
      configured: true,
      valid: true,
      secret: validation.secret,
      sourceKey: key
    };
  }

  return {
    configured: false,
    valid: false,
    secret: null,
    sourceKey: null,
    invalidReason: 'missing',
    errorMessage: `Missing required ORVIX_SIGNED_URL_SECRET environment variable (aliases: SIGNED_DECODE_URL_SECRET, SESSION_SECRET). Configure the same secret (>= ${MIN_SIGNED_DECODE_URL_SECRET_LENGTH} characters) across all production instances.`
  };
}

export function getGroqApiKey(): string {
  return resolveEnvCredential(
    'GROQ_API_KEY',
    'ORVIX_GROQ_API_KEY',
    'GROQ_KEY',
    'GROQ_API_TOKEN',
    'GROQ_API_SECRET'
  );
}

export function getOpenRouterApiKey(): string {
  return resolveEnvCredential(
    'OPENROUTER_API_KEY',
    'ORVIX_OPENROUTER_API_KEY',
    'OPEN_ROUTER_API_KEY',
    'OPENROUTER_KEY',
    'OPENROUTER_API_TOKEN',
    'OPENROUTER_API_SECRET'
  );
}

export function getGeminiApiKey(): string {
  return resolveEnvCredential(
    'GEMINI_API_KEY',
    'ORVIX_GEMINI_API_KEY',
    'GOOGLE_API_KEY'
  );
}

export function getSupabaseUrl(): string {
  const url = resolveEnvCredential(
    'SUPABASE_URL',
    'ORVIX_SUPABASE_URL'
  );
  return url.trim().replace(/\/+$/, '');
}

export function getSupabaseSecretKey(): string {
  return resolveEnvCredential(
    'SUPABASE_SECRET_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'ORVIX_SUPABASE_SECRET_KEY',
    'ORVIX_SUPABASE_SERVICE_ROLE_KEY'
  );
}

export const DEFAULT_SUPABASE_STORAGE_BUCKET = 'orvix-attachments';

export function getSupabaseStorageBucket(): string {
  const customBucket = resolveEnvCredential(
    'SUPABASE_STORAGE_BUCKET',
    'ORVIX_SUPABASE_STORAGE_BUCKET'
  );
  return customBucket.trim() || DEFAULT_SUPABASE_STORAGE_BUCKET;
}

export function isValidSupabaseUrl(url: string): boolean {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

export function isSupabaseStorageConfigured(): boolean {
  const url = getSupabaseUrl();
  const secretKey = getSupabaseSecretKey();
  return isConfiguredCredential(url) && isValidSupabaseUrl(url) && isConfiguredCredential(secretKey);
}

export const DEFAULT_SUPABASE_CLEANUP_INTERVAL_MS = 3_600_000; // 1 hour
export const DEFAULT_SUPABASE_CLEANUP_BATCH_SIZE = 50;

export function isSupabaseAttachmentCleanupEnabled(): boolean {
  const val = (process.env.SUPABASE_ATTACHMENT_CLEANUP_ENABLED ?? 'true').trim().toLowerCase();
  return val !== 'false' && val !== '0' && val !== 'no' && val !== 'off' && val !== 'disabled';
}

export function getSupabaseAttachmentCleanupIntervalMs(): number {
  const raw = Number(process.env.SUPABASE_ATTACHMENT_CLEANUP_INTERVAL_MS);
  if (Number.isFinite(raw) && raw >= 1000) {
    return Math.floor(raw);
  }
  return DEFAULT_SUPABASE_CLEANUP_INTERVAL_MS;
}

export function getSupabaseAttachmentCleanupBatchSize(): number {
  const raw = Number(process.env.SUPABASE_ATTACHMENT_CLEANUP_BATCH_SIZE);
  if (Number.isFinite(raw) && raw >= 1 && raw <= 500) {
    return Math.floor(raw);
  }
  return DEFAULT_SUPABASE_CLEANUP_BATCH_SIZE;
}

export function getCloudflareCredentials(): { accountId: string; apiToken: string } {
  const accountId = resolveEnvCredential(
    'CLOUDFLARE_ACCOUNT_ID',
    'ORVIX_CLOUDFLARE_ACCOUNT_ID'
  );
  const apiToken = resolveEnvCredential(
    'CLOUDFLARE_API_TOKEN',
    'ORVIX_CLOUDFLARE_API_TOKEN',
    'CLOUDFLARE_TOKEN',
    'CLOUDFLARE_API_KEY'
  );
  return { accountId, apiToken };
}

export const PROVIDER_ENV_REQUIREMENTS: Record<string, string> = {
  gemini: 'GEMINI_API_KEY',
  groq: 'GROQ_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  cloudflare: 'CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN'
};

let forceConfigStatusErrorForTesting: Error | null = null;

/**
 * Test hook to simulate an internal configuration resolution error when TESTING=1.
 */
export function setForceConfigStatusErrorForTesting(err: Error | null): void {
  forceConfigStatusErrorForTesting = err;
}

export function getServerProviderConfigStatus(serverlessRuntime = false) {
  if (
    forceConfigStatusErrorForTesting &&
    (process.env.TESTING === '1' || process.env.TESTING === 'true')
  ) {
    throw forceConfigStatusErrorForTesting;
  }

  const geminiKey = getGeminiApiKey();
  const groqKey = getGroqApiKey();
  const openrouterKey = getOpenRouterApiKey();
  const { accountId: cfAccountId, apiToken: cfToken } = getCloudflareCredentials();
  const supabaseConfigured = isSupabaseStorageConfigured();

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
    supabaseConfigured,
    webllmSupported: true,
    demoModeEnabled: isDemoModeEnabled(),
    whisperConfigured: groqConfigured || geminiConfigured,
    whisperProvider: groqConfigured ? 'groq' : geminiConfigured ? 'gemini' : null,
    websocketStreamingSupported: !serverlessRuntime && !isServerless,
    websocketStreamingEndpoint: !serverlessRuntime && !isServerless ? '/api/voice-stream' : null
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

export function sendProviderNotConfiguredError(
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

export function createClientDisconnectedError(): Error {
  const err: any = new Error('Client disconnected before upstream response completed.');
  err.name = 'AbortError';
  err.code = 'CLIENT_DISCONNECTED';
  err.isClientDisconnected = true;
  return err;
}

export function createUpstreamHeadersTimeoutError(provider: string, timeoutMs: number): Error {
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
export function createRequestUpstreamGuard(req: express.Request, res: express.Response) {
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

  const onReqClose = () => {
    if (!req.complete && !res.writableEnded) {
      markDisconnected();
    }
  };

  const onReqAborted = () => {
    markDisconnected();
  };

  res.on('close', onResClose);
  req.on('close', onReqClose);
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

  const registerController = (ctrl: AbortController) => {
    if (clientDisconnected) {
      try {
        ctrl.abort(createClientDisconnectedError());
      } catch (_) {}
      return;
    }
    activeControllers.add(ctrl);
  };

  const unregisterController = (ctrl: AbortController) => {
    activeControllers.delete(ctrl);
  };

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    res.off('close', onResClose);
    req.off('close', onReqClose);
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
    registerController,
    unregisterController,
    cleanup
  };
}

/**
 * Validates whether an incoming HTTP request origin is authorized.
 * Protects server-side AI execution, file uploads, and speech transcription from unauthorized cross-origin abuse.
 */
export function isAllowedOrigin(origin: string | undefined, req: express.Request): boolean {
  // Same-origin or non-browser server-to-server requests (curl, server jobs, mobile apps) have no Origin header
  if (!origin) {
    return true;
  }

  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch (_) {
    return false;
  }

  const hostHeader = (req.headers['x-forwarded-host'] as string) || req.headers.host || '';

  // 1. Direct same-origin match (Origin matches Host header)
  if (hostHeader) {
    const expectedHost = hostHeader.split(',')[0].trim().toLowerCase();
    if (originUrl.host.toLowerCase() === expectedHost) {
      return true;
    }
  }

  // 2. Localhost and loopback origins for development and local testing
  const hostname = originUrl.hostname.toLowerCase();
  if (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '0.0.0.0'
  ) {
    return true;
  }

  // 3. Explicit allowlist from environment variables (comma-delimited)
  const configuredOrigins = [
    process.env.ALLOWED_ORIGINS,
    process.env.CORS_ALLOWED_ORIGINS,
    process.env.VITE_PUBLIC_APP_URL,
    process.env.APP_URL
  ]
    .filter(Boolean)
    .flatMap((val) => (val as string).split(',').map((s) => s.trim().replace(/\/+$/, '')))
    .filter(Boolean);

  const normalizedOrigin = `${originUrl.protocol}//${originUrl.host}`.toLowerCase();
  for (const allowed of configuredOrigins) {
    if (allowed.toLowerCase() === normalizedOrigin) {
      return true;
    }
  }

  // 4. Trusted cloud platform domains: Vercel (*.vercel.app) and Google Cloud Run / AI Studio (*.run.app)
  if (
    hostname.endsWith('.vercel.app') ||
    hostname.endsWith('.run.app') ||
    hostname.endsWith('.aistudio.google.com')
  ) {
    return true;
  }

  return false;
}

/**
 * Controlled CORS middleware enforcing the explicit origin allowlist across both the
 * standalone Express server and individual Vercel serverless endpoint entry points.
 */
export function applyCorsMiddleware(app: express.Express): void {
  app.use((req, res, next) => {
    const origin = req.headers.origin as string | undefined;

    // Handle preflight OPTIONS request
    if (req.method === 'OPTIONS') {
      if (origin && !isAllowedOrigin(origin, req)) {
        return res.status(403).json({
          error: 'Cross-origin request blocked by CORS policy.',
          code: 403,
          status: 'FORBIDDEN'
        });
      }

      if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      }
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, X-Title');
      res.setHeader('Access-Control-Max-Age', '86400');
      return res.sendStatus(204);
    }

    // Handle actual requests (GET, POST, DELETE, etc.)
    if (origin) {
      if (!isAllowedOrigin(origin, req)) {
        if (
          req.path.startsWith('/api/') ||
          req.path.startsWith('/upload') ||
          req.path.startsWith('/chat') ||
          req.path.startsWith('/transcribe') ||
          req.path.startsWith('/config') ||
          req.path.startsWith('/health')
        ) {
          return res.status(403).json({
            error: 'Cross-origin request blocked by CORS policy.',
            code: 403,
            status: 'FORBIDDEN'
          });
        }
      } else {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, X-Title');
      }
    }

    next();
  });
}

/**
 * Applies Vercel pre-parsed body detection, 25 MB JSON parsing, and structured 413 handling.
 */
export function applyJsonBodyMiddleware(app: express.Express): void {
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
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function sleepWithAbort(ms: number, isAborted: () => boolean): Promise<boolean> {
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

export function getBackoffWithJitter(attempt: number, retryAfterSec?: number): number {
  if (retryAfterSec && retryAfterSec > 0 && retryAfterSec <= 10) {
    return retryAfterSec * 1000 + Math.random() * 300;
  }
  const base = Math.min(1000 * Math.pow(2, attempt - 1), 3000);
  const jitter = Math.random() * 400;
  return base + jitter;
}

