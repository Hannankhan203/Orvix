import type {
  DiagnosticLogData,
  GeminiLifecycleEventName,
  GeminiLifecycleLogEntry
} from './serverTypes.ts';

// Sanitizes error messages to ensure no API keys, tokens, PEM private keys, or headers are ever logged or sent to users
export function sanitizeErrorLog(msg: string): string {
  if (!msg) return '';
  return String(msg)
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]')
    .replace(/("private_key"\s*:\s*")[^"]*(")/gi, '$1[REDACTED]$2')
    .replace(/("privateKey"\s*:\s*")[^"]*(")/gi, '$1[REDACTED]$2')
    .replace(/Bearer\s+[A-Za-z0-9_\-\.=~+/]+/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_JWT]')
    .replace(/AIza[0-9A-Za-z_\-]{35}/g, '[REDACTED_API_KEY]')
    .replace(/gsk_[A-Za-z0-9_\-]{20,}/g, '[REDACTED_API_KEY]')
    .replace(/sk-or-[A-Za-z0-9_\-\.]{15,}/g, '[REDACTED_API_KEY]')
    .replace(/\bsk-[A-Za-z0-9_\-]{20,}/g, '[REDACTED_API_KEY]')
    .replace(/([?&]key=)[A-Za-z0-9_\-]+/gi, '$1[REDACTED]')
    .replace(
      /\b(GEMINI_API_KEY|GROQ_API_KEY|OPENROUTER_API_KEY|CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID|ORVIX_SIGNED_URL_SECRET|SIGNED_DECODE_URL_SECRET|SESSION_SECRET|FIREBASE_SERVICE_ACCOUNT|FIREBASE_SERVICE_ACCOUNT_KEY|SUPABASE_SECRET_KEY|SUPABASE_SERVICE_ROLE_KEY)\s*=\s*[^\s,;]+/gi,
      '$1=[REDACTED]'
    )
    .replace(/(authorization:\s*)([^\r\n,;]+)/gi, '$1[REDACTED]');
}

export type UploadDiagnosticStage =
  | 'signed_url_config'
  | 'firebase_auth'
  | 'project_id_resolution'
  | 'service_account_lookup'
  | 'service_account_parse'
  | 'firebase_admin_init'
  | 'firestore_transaction'
  | 'quota_lookup';

export interface UploadDiagnosticEntry {
  stage: UploadDiagnosticStage;
  code?: string | null;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Emits a safe, single-line structured diagnostic log for upload and quota failures.
 * Never logs secrets, Bearer tokens, raw service-account JSON, or PEM private keys.
 */
export function logUploadDiagnostic(entry: UploadDiagnosticEntry): void {
  const payload = {
    stage: entry.stage,
    ...(entry.code ? { code: String(entry.code) } : {}),
    message: sanitizeErrorLog(entry.message),
    ...(entry.details ? { details: entry.details } : {}),
    runtime: {
      vercel: Boolean(process.env.VERCEL),
      nodeEnv: process.env.NODE_ENV || 'unset'
    }
  };
  console.error(`[UploadDiagnostic] ${JSON.stringify(payload)}`);
}

/**
 * Server-side diagnostic logger recording category, provider, model, HTTP status, sanitized error,
 * retry attempt number, and streaming phase without exposing credentials or user data.
 */
export function logAIDiagnostic(data: DiagnosticLogData) {
  const statusStr = data.upstreamStatus ? `HTTP ${data.upstreamStatus}` : 'HTTP N/A';
  const codeStr = data.upstreamErrorCode ? `[${data.upstreamErrorCode}]` : '';
  const actionDesc = data.willRetry
    ? `Will retry (attempt ${(data.attempt || 1) + 1}/${data.maxAttempts || 1}${data.retryAfterSeconds ? ` after ${data.retryAfterSeconds}s` : ''})`
    : 'No further retries';

  console.warn(
    `[AI Diagnostic][${data.category}] Provider: ${data.provider} | Model: ${data.model || 'N/A'} | Phase: ${data.phase || 'dispatch'} | Status: ${statusStr} ${codeStr} | Action: ${actionDesc} | Sanitized: ${sanitizeErrorLog(data.sanitizedMessage)}`
  );
}

/**
 * Safe diagnostic logger for Gemini request lifecycle events.
 * Logs elapsed milliseconds, HTTP status, model, chunk count, and stream state.
 * Never logs API keys, auth headers, user secrets, full user prompts, or full Gemini responses.
 */
export function logGeminiLifecycleEvent(
  entry: GeminiLifecycleLogEntry,
  customSink?: (event: GeminiLifecycleEventName, payload: GeminiLifecycleLogEntry) => void
) {
  const safeEntry: GeminiLifecycleLogEntry = {
    event: entry.event,
    elapsedMs: Math.max(0, Math.round(Number(entry.elapsedMs) || 0)),
    httpStatus: entry.httpStatus ?? null,
    model: entry.model || 'gemini-3.8-flash',
    chunkCount: typeof entry.chunkCount === 'number' ? entry.chunkCount : 0,
    streamState: entry.streamState || 'idle',
    ...(typeof entry.attempt === 'number' ? { attempt: entry.attempt } : {}),
    ...(typeof entry.maxAttempts === 'number' ? { maxAttempts: entry.maxAttempts } : {}),
    ...(entry.timeoutStage ? { timeoutStage: entry.timeoutStage } : {}),
    ...(typeof entry.timeoutMs === 'number' ? { timeoutMs: entry.timeoutMs } : {}),
    ...(entry.errorCode ? { errorCode: sanitizeErrorLog(String(entry.errorCode)) } : {}),
    ...(typeof entry.willRetry === 'boolean' ? { willRetry: entry.willRetry } : {}),
    ...(entry.finishReason ? { finishReason: String(entry.finishReason) } : {})
  };

  if (typeof customSink === 'function') {
    try {
      customSink(entry.event, safeEntry);
    } catch (_) {}
  }

  const isDebugLogsEnabled = process.env.ORVIX_DEBUG_GEMINI_LOGS === '1';
  const isDebugModeEnabled = isDebugLogsEnabled || process.env.DEBUG === 'true';

  if (entry.event === 'chunk_received' && !isDebugLogsEnabled) {
    return safeEntry;
  }

  const isRoutineInformational =
    entry.event === 'request_start' ||
    entry.event === 'upstream_fetch_start' ||
    entry.event === 'upstream_headers_received' ||
    entry.event === 'first_chunk_received' ||
    entry.event === 'upstream_complete';

  if (isRoutineInformational && !isDebugModeEnabled) {
    return safeEntry;
  }

  const parts = [
    `elapsedMs=${safeEntry.elapsedMs}`,
    `httpStatus=${safeEntry.httpStatus ?? 'N/A'}`,
    `model=${safeEntry.model}`,
    `chunkCount=${safeEntry.chunkCount}`,
    `streamState=${safeEntry.streamState}`
  ];
  if (safeEntry.attempt !== undefined && safeEntry.maxAttempts !== undefined) {
    parts.push(`attempt=${safeEntry.attempt}/${safeEntry.maxAttempts}`);
  }
  if (safeEntry.timeoutStage) {
    parts.push(`timeoutStage=${safeEntry.timeoutStage}`);
  }
  if (safeEntry.timeoutMs !== undefined) {
    parts.push(`timeoutMs=${safeEntry.timeoutMs}`);
  }
  if (safeEntry.errorCode) {
    parts.push(`errorCode=${safeEntry.errorCode}`);
  }
  if (safeEntry.willRetry !== undefined) {
    parts.push(`willRetry=${safeEntry.willRetry}`);
  }
  if (safeEntry.finishReason) {
    parts.push(`finishReason=${safeEntry.finishReason}`);
  }
  const logFn = entry.event === 'upstream_error' || entry.event === 'timeout' ? console.warn : console.info;
  logFn(`[Gemini] ${entry.event} | ${parts.join(' | ')}`);

  return safeEntry;
}
