import type {
  DiagnosticLogData,
  GeminiLifecycleEventName,
  GeminiLifecycleLogEntry
} from './serverTypes.ts';

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
