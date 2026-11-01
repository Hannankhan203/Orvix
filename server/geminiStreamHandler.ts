import type {
  AIDiagnosticCategory,
  ConsumeGeminiStreamOptions,
  ConsumeGeminiStreamResult,
  GeminiTimeoutStage
} from './serverTypes.ts';
import {
  sanitizeErrorLog,
  logGeminiLifecycleEvent
} from './diagnosticLogger.ts';
import {
  getGeminiHeaderTimeoutMs,
  getGeminiFirstByteTimeoutMs,
  getGeminiStreamInactivityTimeoutMs,
  getGeminiTotalRequestTimeoutMs,
  createGeminiStageTimeoutError,
  createClientDisconnectedError
} from './serverConfig.ts';

/**
 * Consumes a Gemini streaming response with 4 distinct, non-conflated timeout tiers:
 *  1. Header timeout (bounds `generateContentStream` connection/header acquisition)
 *  2. First-byte timeout (bounds wait for the first chunk from `iterator.next()`, cleared on first chunk)
 *  3. Stream inactivity timeout (bounds idle gap between chunks, RESETTING on every incoming chunk)
 *  4. Total request timeout (bounds overall request lifetime across the stream)
 */
export async function consumeGeminiStreamWithWatchdog(
  options: ConsumeGeminiStreamOptions
): Promise<ConsumeGeminiStreamResult> {
  const {
    invokeStream,
    model,
    attemptNum = 1,
    maxAttempts = 1,
    requestStartTime = Date.now(),
    headerTimeoutMs = getGeminiHeaderTimeoutMs(false),
    firstByteTimeoutMs = getGeminiFirstByteTimeoutMs(),
    inactivityTimeoutMs = getGeminiStreamInactivityTimeoutMs(),
    totalRequestTimeoutMs = getGeminiTotalRequestTimeoutMs(),
    isClientClosed = () => false,
    registerController,
    unregisterController,
    onFirstChunk,
    onChunk,
    onLifecycleLog
  } = options;

  const elapsed = () => Math.max(0, Date.now() - requestStartTime);
  const remainingTotal = () => totalRequestTimeoutMs - elapsed();

  if (isClientClosed()) {
    logGeminiLifecycleEvent(
      {
        event: 'client_disconnect',
        elapsedMs: elapsed(),
        httpStatus: null,
        model,
        chunkCount: 0,
        streamState: 'aborted_before_start',
        attempt: attemptNum,
        maxAttempts
      },
      onLifecycleLog
    );
    throw createClientDisconnectedError();
  }

  if (remainingTotal() <= 0) {
    const totalErr = createGeminiStageTimeoutError('total_request_timeout', totalRequestTimeoutMs, false);
    logGeminiLifecycleEvent(
      {
        event: 'timeout',
        elapsedMs: elapsed(),
        httpStatus: 504,
        model,
        chunkCount: 0,
        streamState: 'expired_before_fetch',
        attempt: attemptNum,
        maxAttempts,
        timeoutStage: 'total_request_timeout',
        timeoutMs: totalRequestTimeoutMs
      },
      onLifecycleLog
    );
    throw totalErr;
  }

  const attemptController = new AbortController();
  registerController?.(attemptController);

  let headerTimer: ReturnType<typeof setTimeout> | null = null;
  let chunkTimer: ReturnType<typeof setTimeout> | null = null;
  let iterator: AsyncIterator<any> | null = null;
  let fullText = '';
  let chunkCount = 0;
  let streamedAnyChunk = false;
  let lastFinishReason: string | null = null;

  const disconnectAbortPromise = new Promise<never>((_resolve, reject) => {
    const onAbort = () => {
      const reason = attemptController.signal.reason;
      if (isClientClosed() || reason?.isClientDisconnected || reason?.code === 'CLIENT_DISCONNECTED') {
        reject(createClientDisconnectedError());
      }
    };
    if (attemptController.signal.aborted) {
      onAbort();
    } else {
      attemptController.signal.addEventListener('abort', onAbort, { once: true });
    }
  });
  disconnectAbortPromise.catch(() => {});

  const clearTimers = () => {
    if (headerTimer) {
      clearTimeout(headerTimer);
      headerTimer = null;
    }
    if (chunkTimer) {
      clearTimeout(chunkTimer);
      chunkTimer = null;
    }
  };

  try {
    logGeminiLifecycleEvent(
      {
        event: 'upstream_fetch_start',
        elapsedMs: elapsed(),
        httpStatus: null,
        model,
        chunkCount: 0,
        streamState: 'connecting',
        attempt: attemptNum,
        maxAttempts
      },
      onLifecycleLog
    );

    const effectiveHeaderTimeoutMs = Math.max(1, Math.min(headerTimeoutMs, remainingTotal()));
    const headerTimeoutStage: GeminiTimeoutStage =
      remainingTotal() < headerTimeoutMs ? 'total_request_timeout' : 'header_timeout';

    const headerTimeoutPromise = new Promise<never>((_resolve, reject) => {
      headerTimer = setTimeout(() => {
        headerTimer = null;
        if (isClientClosed()) {
          reject(createClientDisconnectedError());
          return;
        }
        const tErr = createGeminiStageTimeoutError(headerTimeoutStage, effectiveHeaderTimeoutMs, false);
        try {
          attemptController.abort(tErr);
        } catch (_) {}
        reject(tErr);
      }, effectiveHeaderTimeoutMs);
    });

    const responseStream = await Promise.race([
      invokeStream(attemptController.signal),
      headerTimeoutPromise,
      disconnectAbortPromise
    ]);

    if (headerTimer) {
      clearTimeout(headerTimer);
      headerTimer = null;
    }

    if (isClientClosed()) {
      logGeminiLifecycleEvent(
        {
          event: 'client_disconnect',
          elapsedMs: elapsed(),
          httpStatus: 200,
          model,
          chunkCount: 0,
          streamState: 'headers_received',
          attempt: attemptNum,
          maxAttempts
        },
        onLifecycleLog
      );
      throw createClientDisconnectedError();
    }

    logGeminiLifecycleEvent(
      {
        event: 'upstream_headers_received',
        elapsedMs: elapsed(),
        httpStatus: 200,
        model,
        chunkCount: 0,
        streamState: 'headers_received',
        attempt: attemptNum,
        maxAttempts
      },
      onLifecycleLog
    );

    iterator = responseStream[Symbol.asyncIterator]();

    while (true) {
      if (isClientClosed()) {
        logGeminiLifecycleEvent(
          {
            event: 'client_disconnect',
            elapsedMs: elapsed(),
            httpStatus: 200,
            model,
            chunkCount,
            streamState: streamedAnyChunk ? 'streaming' : 'waiting_first_byte',
            attempt: attemptNum,
            maxAttempts
          },
          onLifecycleLog
        );
        throw createClientDisconnectedError();
      }

      const remTotalMs = remainingTotal();
      if (remTotalMs <= 0) {
        const totalErr = createGeminiStageTimeoutError(
          'total_request_timeout',
          totalRequestTimeoutMs,
          streamedAnyChunk
        );
        try {
          attemptController.abort(totalErr);
        } catch (_) {}
        throw totalErr;
      }

      const isWaitingFirstByte = !streamedAnyChunk;
      const desiredStageTimeoutMs = isWaitingFirstByte ? firstByteTimeoutMs : inactivityTimeoutMs;
      const effectiveChunkTimeoutMs = Math.max(1, Math.min(desiredStageTimeoutMs, remTotalMs));
      const chunkTimeoutStage: GeminiTimeoutStage =
        remTotalMs < desiredStageTimeoutMs
          ? 'total_request_timeout'
          : isWaitingFirstByte
          ? 'first_byte_timeout'
          : 'stream_inactivity_timeout';

      const nextChunkTimeoutPromise = new Promise<never>((_resolve, reject) => {
        chunkTimer = setTimeout(() => {
          chunkTimer = null;
          if (isClientClosed()) {
            reject(createClientDisconnectedError());
            return;
          }
          const cErr = createGeminiStageTimeoutError(
            chunkTimeoutStage,
            effectiveChunkTimeoutMs,
            streamedAnyChunk
          );
          try {
            attemptController.abort(cErr);
          } catch (_) {}
          reject(cErr);
        }, effectiveChunkTimeoutMs);
      });

      const { done, value } = await Promise.race([
        iterator.next(),
        nextChunkTimeoutPromise,
        disconnectAbortPromise
      ]);

      if (chunkTimer) {
        clearTimeout(chunkTimer);
        chunkTimer = null;
      }

      if (isClientClosed()) {
        logGeminiLifecycleEvent(
          {
            event: 'client_disconnect',
            elapsedMs: elapsed(),
            httpStatus: 200,
            model,
            chunkCount,
            streamState: streamedAnyChunk ? 'streaming' : 'waiting_first_byte',
            attempt: attemptNum,
            maxAttempts
          },
          onLifecycleLog
        );
        throw createClientDisconnectedError();
      }

      if (done) {
        break;
      }

      const candidate = value?.candidates?.[0];
      const finishReason = candidate?.finishReason || (value as any)?.promptFeedback?.blockReason;
      if (finishReason) {
        lastFinishReason = finishReason;
      }

      let chunkText = '';
      try {
        chunkText = value?.text || '';
      } catch (textAccessErr: any) {
        if (String(textAccessErr?.message || '').toLowerCase().includes('safety')) {
          lastFinishReason = 'SAFETY';
        }
      }

      if (chunkText) {
        chunkCount++;
        const isFirstChunk = !streamedAnyChunk;
        streamedAnyChunk = true;
        fullText += chunkText;

        if (isFirstChunk) {
          logGeminiLifecycleEvent(
            {
              event: 'first_chunk_received',
              elapsedMs: elapsed(),
              httpStatus: 200,
              model,
              chunkCount,
              streamState: 'streaming',
              attempt: attemptNum,
              maxAttempts
            },
            onLifecycleLog
          );
          onFirstChunk?.({ model, elapsedMs: elapsed() });
        } else {
          logGeminiLifecycleEvent(
            {
              event: 'chunk_received',
              elapsedMs: elapsed(),
              httpStatus: 200,
              model,
              chunkCount,
              streamState: 'streaming',
              attempt: attemptNum,
              maxAttempts
            },
            onLifecycleLog
          );
        }

        onChunk?.(chunkText, value, { chunkCount, elapsedMs: elapsed() });
      }
    }

    logGeminiLifecycleEvent(
      {
        event: 'upstream_complete',
        elapsedMs: elapsed(),
        httpStatus: 200,
        model,
        chunkCount,
        streamState: 'completed',
        attempt: attemptNum,
        maxAttempts,
        finishReason: lastFinishReason
      },
      onLifecycleLog
    );

    return {
      fullText,
      chunkCount,
      streamedAnyChunk,
      lastFinishReason,
      model
    };
  } catch (err: any) {
    clearTimers();
    try {
      await iterator?.return?.();
    } catch (_) {}

    if (isClientClosed() || err?.isClientDisconnected) {
      logGeminiLifecycleEvent(
        {
          event: 'client_disconnect',
          elapsedMs: elapsed(),
          httpStatus: 200,
          model,
          chunkCount,
          streamState: streamedAnyChunk ? 'streaming' : 'waiting_response',
          attempt: attemptNum,
          maxAttempts
        },
        onLifecycleLog
      );
      throw createClientDisconnectedError();
    }

    if (err && typeof err === 'object') {
      err.streamedAnyChunk = streamedAnyChunk;
      err.partialText = fullText;
      err.chunkCount = chunkCount;
    }

    if (err?.isGeminiTimeout || err?.name === 'TimeoutError' || err?.code === 'DEADLINE_EXCEEDED') {
      logGeminiLifecycleEvent(
        {
          event: 'timeout',
          elapsedMs: elapsed(),
          httpStatus: 504,
          model,
          chunkCount,
          streamState: streamedAnyChunk ? 'streaming_stalled' : 'waiting_response',
          attempt: attemptNum,
          maxAttempts,
          timeoutStage: err?.timeoutStage || (streamedAnyChunk ? 'stream_inactivity_timeout' : 'header_timeout'),
          timeoutMs: err?.timeoutMs
        },
        onLifecycleLog
      );
    }

    throw err;
  } finally {
    clearTimers();
    unregisterController?.(attemptController);
  }
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
export function formatGeminiHistory(
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

  while (rawContents.length > 0 && rawContents[0].role !== 'user') {
    rawContents.shift();
  }

  if (rawContents.length === 0 && currentPrompt.trim()) {
    rawContents.push({ role: 'user', parts: [{ text: currentPrompt.trim() }] });
  }

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
