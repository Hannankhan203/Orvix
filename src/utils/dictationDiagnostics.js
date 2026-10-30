/**
 * src/utils/dictationDiagnostics.js
 * Temporary, privacy-conscious diagnostic observability for Orvix Voice Dictation.
 *
 * Captures end-to-end recording session diagnostics to identify the exact source
 * of voice dictation transcripts across Web Speech, MediaRecorder, Groq Whisper,
 * Gemini fallback, and postprocessing reconciliation.
 *
 * Privacy & Security Guarantees:
 * - Never logs actual audio buffers or streams.
 * - Never logs API keys, auth headers, or tokens.
 * - Never logs unrelated chat history.
 * - Raw transcript logging is strictly OPT-IN via localStorage ('orvix_dictation_diagnostics' === 'true')
 *   or window.__ORVIX_DICTATION_DIAGNOSTICS__ === true.
 * - Transient in-memory inspection only; never persisted to Firestore or server storage.
 * - Strictly suppressed in public shared-chat views.
 */

export const DICTATION_DIAGNOSTICS_STORAGE_KEY = 'orvix_dictation_diagnostics';

/**
 * Checks whether voice dictation diagnostics are currently enabled.
 * Defaults to false (explicit opt-in required for privacy).
 *
 * @returns {boolean}
 */
export function isDictationDiagnosticsEnabled() {
  if (typeof window === 'undefined') return false;

  try {
    if (window.__ORVIX_DICTATION_DIAGNOSTICS__ === true) {
      return true;
    }
    const val = localStorage.getItem(DICTATION_DIAGNOSTICS_STORAGE_KEY);
    return val === 'true';
  } catch (_) {
    return false;
  }
}

/**
 * Enables or disables voice dictation diagnostics.
 *
 * @param {boolean} enabled
 */
export function setDictationDiagnosticsEnabled(enabled) {
  if (typeof window === 'undefined') return;

  try {
    const isBool = Boolean(enabled);
    window.__ORVIX_DICTATION_DIAGNOSTICS__ = isBool;
    if (isBool) {
      localStorage.setItem(DICTATION_DIAGNOSTICS_STORAGE_KEY, 'true');
      console.info(
        '[Orvix Dictation Diagnostics] [ACTIVE] Diagnostics enabled. Session events will be logged to console. To disable, run setDictationDiagnosticsEnabled(false) or remove localStorage item.'
      );
    } else {
      localStorage.removeItem(DICTATION_DIAGNOSTICS_STORAGE_KEY);
      console.info('[Orvix Dictation Diagnostics] [DISABLED] Diagnostics disabled.');
    }
  } catch (_) {}
}

/**
 * Creates a new transient diagnostic record for a recording session.
 *
 * @param {Object} params
 * @param {string} params.sessionId - Unique session identifier
 * @param {string} params.engineMode - Active browser engine mode ('browser-speech' | 'audio-record' | 'unsupported')
 * @param {string} params.language - Selected BCP-47 language tag (e.g. 'en-PK', 'ur-PK')
 * @param {boolean} [params.isPublicSharedViewer=false] - Whether app is in read-only public viewer mode
 * @returns {Object} Diagnostic session accumulator
 */
export function createDiagnosticSession({
  sessionId,
  engineMode = 'browser-speech',
  language = 'en-US',
  isPublicSharedViewer = false
}) {
  const isEnabled = !isPublicSharedViewer && isDictationDiagnosticsEnabled();

  return {
    sessionId: sessionId || `dict-sess-${Date.now()}`,
    startTime: Date.now(),
    isEnabled,
    isPublicSharedViewer: Boolean(isPublicSharedViewer),
    engineMode,
    language,
    mimeType: '',
    audioBlobSizeBytes: 0,
    audioBlobSizeFormatted: '0 B',
    audioBlobValid: false,
    durationSec: 0,
    nativeInitialized: false,
    recognitionEndedNormally: false,
    hadFinalResults: false,
    rawNativeTranscript: '',
    serverTranscriptionInvoked: false,
    fallbackReason: '',
    provider: 'none',
    model: 'none',
    providerStatus: 0,
    providerSuccess: false,
    providerFailureReason: 'none',
    latencyMs: 0,
    rawProviderTranscript: '',
    finalTranscriptSource: 'none',
    reconciliationDecision: 'none',
    reconciliationReason: 'none',
    cleanedTranscript: '',
    finalComposerTranscript: '',
    completed: false
  };
}

/**
 * Formats a byte count into a human-readable size string.
 *
 * @param {number} bytes
 * @returns {string}
 */
export function formatDiagnosticByteSize(bytes = 0) {
  if (!bytes || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Emits and stores the final diagnostic report for a completed session.
 *
 * @param {Object} session - The diagnostic session object
 * @returns {Object|null} The final structured diagnostic report, or null if diagnostics are disabled
 */
export function finalizeDiagnosticSession(session) {
  if (!session) return null;
  session.completed = true;

  // Enforce privacy: If app is in public shared view, never record or expose diagnostics
  if (session.isPublicSharedViewer) {
    return null;
  }

  // Format final payload covering all diagnostic points
  const report = {
    // 1. Unique recording session ID
    sessionId: session.sessionId,
    // 2. Browser engine mode
    engineMode: session.engineMode,
    // 3. Selected language, including the complete BCP-47 tag
    language: session.language,
    // 4. MediaRecorder MIME type
    mimeType: session.mimeType || 'none',
    // 5. Audio Blob size, duration, and validity
    audioBlobSizeBytes: session.audioBlobSizeBytes,
    audioBlobSizeFormatted: session.audioBlobSizeFormatted,
    audioBlobValid: Boolean(session.audioBlobValid ?? (session.audioBlobSizeBytes > 0)),
    durationSec: session.durationSec,
    // 6. Whether native Web Speech recognition was initialized
    nativeInitialized: Boolean(session.nativeInitialized),
    // 7. Whether native recognition completed normally
    recognitionEndedNormally: Boolean(session.recognitionEndedNormally),
    // 8. Whether native final results were received
    hadFinalResults: Boolean(session.hadFinalResults),
    // 9. Raw native transcript before cleaning
    rawNativeTranscript: session.rawNativeTranscript || '',
    // 10. Whether server-side transcription was invoked
    serverTranscriptionInvoked: Boolean(session.serverTranscriptionInvoked),
    // 11. Exact reason for fallback invocation or bypass
    fallbackReason: session.fallbackReason || 'not_evaluated',
    // 12. Actual transcription provider and model
    provider: session.provider || 'none',
    model: session.model || 'none',
    // 13. Provider response status, success/failure, and latency
    providerStatus: session.providerStatus || 0,
    providerSuccess: Boolean(session.providerSuccess),
    providerFailureReason: session.providerFailureReason || (session.providerSuccess ? 'none' : 'not_invoked_or_failed'),
    latencyMs: session.latencyMs || 0,
    // 14. Raw provider transcript before client-side processing
    rawProviderTranscript: session.rawProviderTranscript || '',
    // 15. Final transcript source (provider or native) and decision reason
    finalTranscriptSource: session.finalTranscriptSource || session.reconciliationDecision || 'none',
    reconciliationDecision: session.reconciliationDecision || session.finalTranscriptSource || 'none',
    reconciliationReason: session.reconciliationReason || 'none',
    // 16. Transcript after cleaning and formatting
    cleanedTranscript: session.cleanedTranscript || '',
    // 17. Final transcript inserted into the composer
    finalComposerTranscript: session.finalComposerTranscript || '',
    timestamp: new Date().toISOString()
  };

  // If diagnostics are disabled, DO NOT log transcripts or report to console
  if (!session.isEnabled && !isDictationDiagnosticsEnabled()) {
    return null;
  }

  // Keep in transient window memory for active inspection / automated testing
  if (typeof window !== 'undefined') {
    window.__ORVIX_LAST_DICTATION_DIAGNOSTIC__ = report;
    if (!Array.isArray(window.__ORVIX_DICTATION_DIAGNOSTICS_HISTORY__)) {
      window.__ORVIX_DICTATION_DIAGNOSTICS_HISTORY__ = [];
    }
    // Retain only the last 10 sessions in memory
    window.__ORVIX_DICTATION_DIAGNOSTICS_HISTORY__.push(report);
    if (window.__ORVIX_DICTATION_DIAGNOSTICS_HISTORY__.length > 10) {
      window.__ORVIX_DICTATION_DIAGNOSTICS_HISTORY__.shift();
    }
  }

  // Log structured diagnostic report to the browser console
  try {
    const header = `[Orvix Dictation Diagnostic] Session: ${report.sessionId} | ${report.engineMode} | ${report.language}`;
    if (typeof console.groupCollapsed === 'function') {
      console.groupCollapsed(header);
    } else {
      console.log(`=== ${header} ===`);
    }

    console.log('1. Session ID:                  ', report.sessionId);
    console.log('2. Engine Mode:                 ', report.engineMode);
    console.log('3. Selected Language (BCP-47):  ', report.language);
    console.log('4. MediaRecorder MIME Type:     ', report.mimeType);
    console.log(`5. Audio Blob Size & Duration:   ${report.audioBlobSizeFormatted} (${report.audioBlobSizeBytes} bytes), ${report.durationSec}s (Valid: ${report.audioBlobValid})`);
    console.log('6. Native Speech Initialized:   ', report.nativeInitialized);
    console.log('7. Native Completed Normally:   ', report.recognitionEndedNormally);
    console.log('8. Native Had Final Results:    ', report.hadFinalResults);
    console.log('9. Raw Native Transcript:       ', report.rawNativeTranscript ? `"${report.rawNativeTranscript}"` : '[EMPTY]');
    console.log('10. Server Transcription Invoked:', report.serverTranscriptionInvoked);
    console.log('11. Invocation / Bypass Reason: ', report.fallbackReason);
    console.log(`12. Actual Provider & Model:    ${report.provider} (${report.model})`);
    console.log(`13. Provider Status & Latency:  HTTP ${report.providerStatus}, ${report.latencyMs}ms (Success: ${report.providerSuccess}${report.providerFailureReason !== 'none' ? `, Failure: ${report.providerFailureReason}` : ''})`);
    console.log('14. Raw Provider Transcript:    ', report.rawProviderTranscript ? `"${report.rawProviderTranscript}"` : '[NONE]');
    console.log(`15. Final Transcript Source:    ${report.finalTranscriptSource} (Decision: ${report.reconciliationDecision}, Reason: ${report.reconciliationReason})`);
    console.log('16. Cleaned / Formatted Speech: ', report.cleanedTranscript ? `"${report.cleanedTranscript}"` : '[EMPTY]');
    console.log('17. Final Emitted to Composer:  ', report.finalComposerTranscript ? `"${report.finalComposerTranscript}"` : '[EMPTY]');

    if (typeof console.groupEnd === 'function') {
      console.groupEnd();
    }
  } catch (_) {}

  return report;
}

/**
 * Retrieves the most recent dictation diagnostic report from memory.
 *
 * @returns {Object|null}
 */
export function getLastDictationDiagnostic() {
  if (typeof window === 'undefined') return null;
  return window.__ORVIX_LAST_DICTATION_DIAGNOSTIC__ || null;
}
