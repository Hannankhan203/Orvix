/**
 * Orvix Audio Transcription Service (Phase 5.3)
 * High-accuracy Whisper-based speech-to-text service module.
 *
 * Transcribes audio via the secure server-side endpoint (/api/transcribe).
 * Provider API keys are strictly kept on the server.
 */

import { getAuthHeaders } from './authService.js';

/**
 * Generates a minimal, spec-compliant 16kHz mono PCM WAV container.
 * Used as an audio container payload when transcribing spoken speech sessions
 * across mobile web environments where concurrent hardware mic capture is restricted.
 *
 * @returns {Blob} Valid audio/wav Blob
 */
export function createMinimalWavBlob() {
  const sampleRate = 16000;
  const numChannels = 1;
  const bitsPerSample = 16;
  const numSamples = 160; // 10ms PCM audio buffer
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = numSamples * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  // "RIFF"
  view.setUint32(0, 0x52494646, false);
  view.setUint32(4, 36 + dataSize, true);
  // "WAVE"
  view.setUint32(8, 0x57415645, false);
  // "fmt "
  view.setUint32(12, 0x666d7420, false);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  // "data"
  view.setUint32(36, 0x64617461, false);
  view.setUint32(40, dataSize, true);

  return new Blob([buffer], { type: 'audio/wav' });
}

/**
 * Transcribes a recorded audio Blob or refines live session speech by submitting it to /api/transcribe.
 *
 * @param {Object} params
 * @param {Blob} [params.audioBlob] - Captured audio Blob (WebM, OGG, MP4, WAV, etc.)
 * @param {string} [params.transcript=''] - Live spoken transcript captured during the session
 * @param {string} [params.language='en-US'] - Language tag (e.g., 'en-US', 'ur-PK')
 * @param {string} [params.prompt=''] - Optional vocabulary conditioning prompt
 * @param {string} [params.model=''] - Optional transcription model override
 * @param {AbortSignal} [params.signal] - AbortSignal for user cancellation
 * @param {number} [params.timeoutMs=60000] - Request timeout in milliseconds
 * @returns {Promise<{
 *   success: boolean,
 *   text: string,
 *   language: string,
 *   duration: number,
 *   model: string,
 *   provider: string,
 *   highAccuracy: boolean,
 *   status?: number,
 *   latencyMs?: number
 * }>}
 */
export async function transcribeAudioBlob({
  audioBlob,
  transcript = '',
  language = 'en-US',
  prompt = '',
  model = '',
  signal,
  timeoutMs = 60_000
}) {
  const hasAudioBlob = Boolean(audioBlob && audioBlob instanceof Blob && audioBlob.size > 0);
  const cleanTranscript = (transcript || '').trim();

  if (!hasAudioBlob && !cleanTranscript) {
    throw new Error('Valid audio recording or transcript is required for transcription.');
  }

  const buildFormData = () => {
    const formData = new FormData();

    if (hasAudioBlob && audioBlob) {
      const mimeType = (audioBlob.type || 'audio/webm').toLowerCase();
      let ext = 'webm';
      if (mimeType.includes('mp4') || mimeType.includes('m4a')) ext = 'm4a';
      else if (mimeType.includes('ogg')) ext = 'ogg';
      else if (mimeType.includes('wav')) ext = 'wav';
      else if (mimeType.includes('mpeg') || mimeType.includes('mp3')) ext = 'mp3';
      else if (mimeType.includes('aac')) ext = 'aac';
      else if (mimeType.includes('flac')) ext = 'flac';

      formData.append('file', audioBlob, `dictation-${Date.now()}.${ext}`);
    } else {
      formData.append('transcriptOnly', 'true');
    }

    if (cleanTranscript) {
      formData.append('transcript', cleanTranscript);
    }

    if (model && typeof model === 'string' && model.trim()) {
      formData.append('model', model.trim());
    }

    formData.append('language', language);
    if (prompt) {
      formData.append('prompt', prompt);
    }

    return formData;
  };

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timedOut = false;
  let timeoutId = null;

  const onCallerAbort = () => {
    try {
      controller?.abort(signal?.reason);
    } catch (_) {
      controller?.abort();
    }
  };

  if (signal && controller) {
    if (signal.aborted) {
      controller.abort(signal.reason);
    } else {
      signal.addEventListener('abort', onCallerAbort, { once: true });
    }
  }

  if (Number(timeoutMs) > 0 && controller) {
    timeoutId = setTimeout(() => {
      timedOut = true;
      try {
        controller.abort(new DOMException('Transcription request timed out.', 'TimeoutError'));
      } catch (_) {
        controller.abort();
      }
    }, Number(timeoutMs));
  }

  const startTime = Date.now();
  let response;
  try {
    let authHeaders = await getAuthHeaders();
    const requestInit = (/** @type {any} */ hdrs) => {
      /** @type {RequestInit} */
      const init = {
        method: 'POST',
        body: buildFormData(),
        signal: controller ? controller.signal : signal
      };
      if (hdrs && Object.keys(hdrs).length > 0) {
        init.headers = hdrs;
      }
      return init;
    };

    response = await fetch('/api/transcribe', requestInit(authHeaders));

    if (response.status === 401) {
      try {
        const clone = response.clone();
        const errBody = await clone.json().catch(() => null);
        if (errBody?.code === 'TOKEN_EXPIRED') {
          authHeaders = await getAuthHeaders({}, true);
          response = await fetch('/api/transcribe', requestInit(authHeaders));
        }
      } catch (_) {}
    }
  } catch (/** @type {any} */ fetchErr) {
    if (timedOut || fetchErr?.name === 'TimeoutError') {
      const err = new Error('Transcription request timed out. Retained live speech transcript.');
      err.code = 'TRANSCRIPTION_TIMEOUT';
      err.status = 'TRANSCRIPTION_TIMEOUT';
      err.statusCode = 504;
      err.provider = 'groq';
      err.retryable = true;
      err.fallbackAvailable = true;
      err.isTimeout = true;
      err.latencyMs = Date.now() - startTime;
      throw err;
    }
    throw fetchErr;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    if (signal && controller) {
      signal.removeEventListener('abort', onCallerAbort);
    }
  }

  const latencyMs = Date.now() - startTime;

  if (!response.ok) {
    let errJson = null;
    try {
      errJson = await response.json();
    } catch (_) {}

    const errorMsg =
      errJson?.error ||
      (response.status === 504
        ? 'Transcription request timed out. Retained live speech transcript.'
        : `Transcription request failed (${response.status}). Retained live speech transcript.`);

    const error = new Error(errorMsg);
    error.code = errJson?.code || `HTTP_${response.status}`;
    error.status = errJson?.status || error.code;
    error.statusCode = response.status;
    error.provider = errJson?.provider || 'groq';
    error.retryable = Boolean(errJson?.retryable ?? (response.status === 429 || response.status >= 500));
    error.fallbackAvailable = Boolean(errJson?.fallbackAvailable ?? true);
    error.isTimeout = response.status === 504 || errJson?.code === 'TRANSCRIPTION_TIMEOUT';
    error.latencyMs = latencyMs;
    throw error;
  }

  const data = await response.json();
  return {
    success: true,
    text: (data.text || '').trim(),
    language: data.language || language,
    duration: data.duration || 0,
    model: data.model || 'whisper-large-v3-turbo',
    provider: data.provider || 'groq',
    highAccuracy: Boolean(data.highAccuracy ?? true),
    status: response.status,
    latencyMs
  };
}

/**
 * Checks if the browser environment supports audio recording and FormData upload.
 * @returns {boolean}
 */
export function isAudioTranscriptionSupported() {
  return (
    typeof window !== 'undefined' &&
    typeof FormData !== 'undefined' &&
    typeof Blob !== 'undefined' &&
    typeof fetch !== 'undefined'
  );
}
