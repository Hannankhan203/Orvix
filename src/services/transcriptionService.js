/**
 * Orvix Audio Transcription Service (Phase 5.3)
 * High-accuracy Whisper-based speech-to-text service module.
 *
 * Transcribes audio via the secure server-side endpoint (/api/transcribe).
 * Provider API keys are strictly kept on the server.
 */

/**
 * Transcribes a recorded audio Blob by submitting it to the /api/transcribe backend endpoint.
 *
 * @param {Object} params
 * @param {Blob} params.audioBlob - Captured audio Blob (WebM, OGG, MP4, WAV, etc.)
 * @param {string} [params.language='en-US'] - Language tag (e.g., 'en-US', 'ur-PK')
 * @param {string} [params.prompt=''] - Optional vocabulary conditioning prompt
 * @param {AbortSignal} [params.signal] - AbortSignal for user cancellation
 * @returns {Promise<{
 *   success: boolean,
 *   text: string,
 *   language: string,
 *   duration: number,
 *   model: string,
 *   provider: string,
 *   highAccuracy: boolean
 * }>}
 */
export async function transcribeAudioBlob({
  audioBlob,
  language = 'en-US',
  prompt = '',
  signal
}) {
  if (!audioBlob || !(audioBlob instanceof Blob)) {
    throw new Error('Valid audio recording is required for transcription.');
  }

  if (audioBlob.size === 0) {
    throw new Error('Audio recording buffer is empty.');
  }

  const mimeType = (audioBlob.type || 'audio/webm').toLowerCase();
  let ext = 'webm';
  if (mimeType.includes('mp4') || mimeType.includes('m4a')) ext = 'm4a';
  else if (mimeType.includes('ogg')) ext = 'ogg';
  else if (mimeType.includes('wav')) ext = 'wav';
  else if (mimeType.includes('mpeg') || mimeType.includes('mp3')) ext = 'mp3';
  else if (mimeType.includes('aac')) ext = 'aac';
  else if (mimeType.includes('flac')) ext = 'flac';

  const formData = new FormData();
  formData.append('file', audioBlob, `dictation-${Date.now()}.${ext}`);
  formData.append('language', language);
  if (prompt) {
    formData.append('prompt', prompt);
  }

  const response = await fetch('/api/transcribe', {
    method: 'POST',
    body: formData,
    signal
  });

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
    error.statusCode = response.status;
    error.fallbackAvailable = Boolean(errJson?.fallbackAvailable ?? true);
    error.isTimeout = response.status === 504 || errJson?.code === 'TRANSCRIPTION_TIMEOUT';
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
    highAccuracy: Boolean(data.highAccuracy ?? true)
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
