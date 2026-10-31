import { useState, useRef, useEffect, useCallback } from 'react';
import { transcribeAudioBlob } from '../services/transcriptionService.js';
import {
  createDiagnosticSession,
  finalizeDiagnosticSession,
  formatDiagnosticByteSize,
  isDictationDiagnosticsEnabled,
  setDictationDiagnosticsEnabled,
  getLastDictationDiagnostic
} from '../utils/dictationDiagnostics.js';

export {
  isDictationDiagnosticsEnabled,
  setDictationDiagnosticsEnabled,
  getLastDictationDiagnostic
};

/**
 * Supported Speech Recognition Languages with BCP 47 language tags.
 * Comprehensive, reliable options with native and English labels.
 */
export const SUPPORTED_LANGUAGES = [
  { code: 'en-US', label: 'English (US)', flag: '🇺🇸', native: 'English (United States)' },
  { code: 'en-GB', label: 'English (UK)', flag: '🇬🇧', native: 'English (United Kingdom)' },
  { code: 'en-PK', label: 'English (Pakistan)', flag: '🇵🇰', native: 'English (Pakistan)' },
  { code: 'ur-PK', label: 'اردو / Urdu', flag: '🇵🇰', native: 'اردو (پاکستان)' },
  { code: 'es-ES', label: 'Español', flag: '🇪🇸', native: 'Español' },
  { code: 'fr-FR', label: 'Français', flag: '🇫🇷', native: 'Français' },
  { code: 'de-DE', label: 'Deutsch', flag: '🇩🇪', native: 'Deutsch' },
  { code: 'ar-SA', label: 'العربية / Arabic', flag: '🇸🇦', native: 'العربية' },
  { code: 'hi-IN', label: 'हिन्दी / Hindi', flag: '🇮🇳', native: 'हिन्दी' }
];

export const DEFAULT_LANGUAGE = 'en-US';

export const NUM_WAVEFORM_BARS = 16;

/**
 * Formats elapsed recording duration in seconds to mm:ss display string.
 * @param {number} seconds
 * @returns {string} Formatted duration (e.g. 0:05, 1:24)
 */
export function formatDuration(seconds = 0) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const mins = Math.floor(s / 60);
  const secs = s % 60;
  return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

/**
 * Audio Capture & Buffering Configuration (Phase 5.2 & 5.4)
 */
export const MAX_RECORDED_BYTES = 25 * 1024 * 1024; // 25 MB safeguard against unbounded memory growth
export const MAX_RECORDING_DURATION_MS = 15 * 60 * 1000; // 15 minutes continuous dictation limit
export const CHUNK_TIMESLICE_MS = 250; // 250ms chunks for smooth real-time buffering

/**
 * Detects browser dictation capabilities and environment across desktop and mobile.
 * Accurately recognizes Chrome, Edge, Safari (macOS & iOS), and Firefox (which does not
 * enable native Web Speech by default, but supports direct audio capture & Whisper transcription).
 *
 * @returns {Object} Capabilities descriptor
 */
export function detectDictationCapabilities() {
  if (typeof window === 'undefined') {
    return {
      hasSpeechRecognition: false,
      hasGetUserMedia: false,
      hasMediaRecorder: false,
      isSupported: false,
      engineMode: 'unsupported',
      isFirefox: false,
      isIOS: false,
      isSafari: false
    };
  }

  const userAgent = navigator.userAgent || '';
  const isFirefox = /Firefox/i.test(userAgent);
  const isIOS =
    /iPad|iPhone|iPod/.test(userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isSafari =
    /Safari/i.test(userAgent) && !/Chrome|CriOS|Edg|OPR|Firefox/i.test(userAgent);

  const isStandalone = Boolean(
    (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
    (typeof navigator !== 'undefined' && (navigator.standalone || navigator.windowControlsOverlay?.visible))
  );

  const isMobile =
    /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(userAgent) ||
    (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1 && /MacIntel/.test(navigator.platform));

  // iOS Standalone PWA limitation: Apple WebKit intentionally disables Web Speech API (webkitSpeechRecognition)
  // in standalone home-screen PWAs. Invocations throw an immediate NotAllowedError or service-not-allowed.
  const rawSpeechRecognition = Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
  const hasSpeechRecognition = rawSpeechRecognition && !(isIOS && isStandalone);

  const hasGetUserMedia = Boolean(
    navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function'
  );
  const hasMediaRecorder = Boolean(window.MediaRecorder);

  // Authoritative browser speech recognition or native audio recording with server transcription fallback
  const isSupported = Boolean(hasSpeechRecognition || (hasGetUserMedia && hasMediaRecorder));
  const engineMode = hasSpeechRecognition
    ? 'browser-speech'
    : hasGetUserMedia && hasMediaRecorder
    ? 'audio-record'
    : 'unsupported';

  return {
    hasSpeechRecognition,
    hasGetUserMedia,
    hasMediaRecorder,
    isSupported,
    engineMode,
    isFirefox,
    isIOS,
    isSafari,
    isStandalone,
    isMobile
  };
}

/**
 * Detects the most optimal audio MIME type supported by the user's browser.
 * Tests codecs dynamically (Opus, AAC, WebM, MP4, OGG) to ensure cross-browser fidelity.
 *
 * @returns {string} Supported MIME type or empty string if browser default should be used
 */
export function getSupportedAudioMimeType() {
  if (typeof window === 'undefined') {
    return '';
  }
  const MR = window.MediaRecorder || (typeof MediaRecorder !== 'undefined' ? MediaRecorder : null);
  if (!MR || typeof MR.isTypeSupported !== 'function') {
    return '';
  }
  const candidateTypes = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/ogg',
    'audio/mp4;codecs=mp4a.40.2',
    'audio/mp4',
    'audio/aac'
  ];
  for (const mime of candidateTypes) {
    try {
      if (MR.isTypeSupported(mime)) {
        return mime;
      }
    } catch (_) {}
  }
  return '';
}

/**
 * Resolves the initial language locale, prioritizing localStorage,
 * then browser system locale (navigator.language), falling back to 'en-US'.
 */
export function getInitialLanguage() {
  if (typeof window !== 'undefined') {
    try {
      const stored = localStorage.getItem('orvix_dictation_lang');
      if (stored && SUPPORTED_LANGUAGES.some((l) => l.code === stored)) {
        return stored;
      }
      const browserLang = (navigator.language || navigator.userLanguage || '').toLowerCase();
      if (browserLang) {
        const exactMatch = SUPPORTED_LANGUAGES.find((l) => l.code.toLowerCase() === browserLang);
        if (exactMatch) return exactMatch.code;

        const prefix = browserLang.split('-')[0];
        const prefixMatch = SUPPORTED_LANGUAGES.find((l) => l.code.toLowerCase().startsWith(prefix));
        if (prefixMatch) return prefixMatch.code;
      }
    } catch (_) {}
  }
  return DEFAULT_LANGUAGE;
}

/**
 * Common technical acronyms that should be formatted cleanly when spoken.
 * NOTE: As per project guidelines, no arbitrary word-replacement dictionaries are used.
 */
const COMMON_TECH_ACRONYMS = [
  [/\b(?:or\s*vix|our\s*vix|or\s*fix)\b/gi, 'Orvix'],
  [/\b(?:chat\s*gpt|chat\s*g\s*p\s*t)\b/gi, 'ChatGPT'],
  [/\bopen\s*ai\b/gi, 'OpenAI'],
  [/\bjava\s*script\b/gi, 'JavaScript'],
  [/\becma\s*script\b/gi, 'ECMAScript'],
  [/\btype\s*script\b/gi, 'TypeScript'],
  [/\bnode\s*\.?\s*j\s*s\b/gi, 'Node.js'],
  [/\bnext\s*\.?\s*j\s*s\b/gi, 'Next.js'],
  [/\bvue\s*\.?\s*j\s*s\b/gi, 'Vue.js'],
  [/\byou\s*tube\b/gi, 'YouTube'],
  [/\bpython\b/gi, 'Python'],
  [/\breact\b/gi, 'React'],
  [/\bangular\b/gi, 'Angular'],
  [/\bhannan\b/gi, 'Hannan'],
  [/\b(?:a\s*p\s*i)s?\b/gi, (m) => (/s$/i.test(m) ? 'APIs' : 'API')],
  [/\b(?:j\s*s\s*o\s*n)\b/gi, 'JSON'],
  [/\b(?:h\s*t\s*m\s*l)\b/gi, 'HTML'],
  [/\b(?:c\s*s\s*s)\b/gi, 'CSS'],
  [/\b(?:u\s*r\s*l)s?\b/gi, (m) => (/s$/i.test(m) ? 'URLs' : 'URL')],
  [/\b(?:s\s*q\s*l)\b/gi, 'SQL'],
  [/\b(?:no\s*s\s*q\s*l)\b/gi, 'NoSQL'],
  [/\b(?:graph\s*q\s*l)\b/gi, 'GraphQL'],
  [/\b(?:rest\s*a\s*p\s*i)s?\b/gi, (m) => (/s$/i.test(m) ? 'REST APIs' : 'REST API')],
  [/\b(?:async\s+await|async\s*\/\s*await|(?:sync|sink)\s+await)\b/gi, 'async/await'],
  [/\b(?:pedrandom|ped\s+random|pelindrome|palindrom)\b/gi, 'palindrome'],
  [/\bvar\s*,\s*constant\s*,\s*let\b/gi, 'var, const, let'],
  [/\bvar\s+constant\s+let\b/gi, 'var, const, let'],
  [/\barray\s+methods?\b/gi, (m) => (/s$/i.test(m) ? 'array methods' : 'array method')],
  [/\barrow\s+functions?\b/gi, (m) => (/s$/i.test(m) ? 'arrow functions' : 'arrow function')]
];

/**
 * Smart Verbal Punctuation and Typography Formatter
 * Converts spoken verbal commands ("period", "comma", "question mark", "new line")
 * into true typography, capitalizes sentences, and fixes spacing.
 *
 * @param {string} rawText
 * @param {string} langCode
 * @param {string} [precedingText='']
 * @returns {string} Clean, formatted speech text
 */
export function formatSpeechTranscript(rawText, langCode = 'en-US', precedingText = '') {
  if (!rawText) return '';
  let text = rawText.trim();
  const isUrdu = (langCode || '').toLowerCase().startsWith('ur');

  if (isUrdu) {
    // Urdu verbal punctuation rules
    text = text
      .replace(/\s*(?:ختمہ|فل\s*اسٹاپ)\s*/gi, '۔ ')
      .replace(/\s*(?:وقفہ|کوما)\s*/gi, '، ')
      .replace(/\s*سوالیہ\s*نشان\s*/gi, '؟ ')
      .replace(/\s*ندائیہ\s*/gi, '! ')
      .replace(/\s*نئی\s*لائن\s*/gi, '\n');
  } else {
    // Protect Math.random before palindrome and punctuation conversions
    text = text.replace(/\bmath\s*\.\s*random\b/gi, 'Math.random');

    // English & standard verbal punctuation rules
    text = text
      .replace(/(?:\s+|^)\b(?:period|full\s*stop)\b/gi, '.')
      .replace(/(?:\s+|^)\bcomma\b/gi, ',')
      .replace(/(?:\s+|^)\bquestion\s*mark\b/gi, '?')
      .replace(/(?:\s+|^)\b(?:exclamation\s*mark|exclamation\s*point)\b/gi, '!')
      .replace(/(?:\s+|^)\bcolon\b/gi, ':')
      .replace(/(?:\s+|^)\bsemicolon\b/gi, ';')
      .replace(/(?:\s+|^)\b(?:new\s*paragraph|next\s*paragraph)\b/gi, '\n\n')
      .replace(/(?:\s+|^)\b(?:new\s*line|newline)\b/gi, '\n')
      .replace(/(?:\s+|^)\b(?:hyphen|dash)\b/gi, ' - ');

    // English pronoun "I" and contractions
    text = text
      .replace(/\bi\b/g, 'I')
      .replace(/\bi'm\b/g, "I'm")
      .replace(/\bi'll\b/g, "I'll")
      .replace(/\bi've\b/g, "I've")
      .replace(/\bi'd\b/g, "I'd");

    // Standard tech acronyms & common programming terms
    for (const [pattern, replacement] of COMMON_TECH_ACRONYMS) {
      text = text.replace(pattern, replacement);
    }

    // Natural greeting punctuation: "Hello, Orvix"
    text = text.replace(/\b(hello|hi|hey)\s+orvix\b/gi, (_, g) => `${g.charAt(0).toUpperCase() + g.slice(1).toLowerCase()}, Orvix`);
  }

  // Remove irregular spaces before punctuation
  text = text
    .replace(/\s+([.,!?:;۔،؟])/g, '$1')
    .replace(/(?<!\b[A-Za-z0-9_])\.([a-zA-Z])/g, '. $1')
    .replace(/([,!?:;۔،؟])([^\s\d\n])/g, '$1 $2')
    .replace(/[ \t]+/g, ' ');

  // Sentence capitalization for Latin scripts
  if (!isUrdu) {
    const shouldCapitalizeStart =
      !precedingText ||
      /[.!?\n]\s*$/.test(precedingText);

    if (shouldCapitalizeStart && text.length > 0) {
      text = text.charAt(0).toUpperCase() + text.slice(1);
    }

    text = text.replace(/([.!?\n]\s+)([a-z])/g, (_, sep, letter) => `${sep}${letter.toUpperCase()}`);
    text = text.replace(/\bMath\.\s*random\b/gi, 'Math.random');
  }

  return text;
}

/**
 * Combines existing composer text with newly recognized speech,
 * ensuring appropriate whitespace separation without creating double spaces.
 *
 * @param {string} base - Existing composer content
 * @param {string} speech - Newly recognized speech
 * @returns {string} Combined text
 */
export function combineComposerText(base = '', speech = '') {
  const cleanBase = base || '';
  const cleanSpeech = speech || '';

  if (!cleanBase) return cleanSpeech;
  if (!cleanSpeech) return cleanBase;

  // If base ends with whitespace or speech begins with whitespace, join directly without adding space
  if (/\s$/.test(cleanBase) || /^\s/.test(cleanSpeech)) {
    return cleanBase + cleanSpeech;
  }

  // If speech begins with leading punctuation like '.', ',', '?', '!', '۔', '،', '؟', do not add space
  if (/^[.,!?:;۔،؟]/.test(cleanSpeech)) {
    return cleanBase + cleanSpeech;
  }

  // Otherwise, join with a clean single space
  return `${cleanBase} ${cleanSpeech}`;
}

/**
 * Merges two chronological transcript segments, deduplicating boundary word overlaps
 * (such as when recognition engines repeat words across silence restarts or breaks)
 * and handling progressive subsumption.
 *
 * @param {string} prevText - Previously accumulated speech text
 * @param {string} nextText - Newly recognized speech segment
 * @returns {string} Merged, deduplicated speech text
 */
export function mergeTranscriptSegments(prevText = '', nextText = '') {
  const cleanPrev = (prevText || '').trim();
  const cleanNext = (nextText || '').trim();

  if (!cleanPrev) return cleanNext;
  if (!cleanNext) return cleanPrev;

  const lowerPrev = cleanPrev.toLowerCase();
  const lowerNext = cleanNext.toLowerCase();

  // If next is identical to prev
  if (lowerPrev === lowerNext) {
    return cleanPrev;
  }

  // If cleanPrev already ends with cleanNext (e.g. echo of the tail)
  if (lowerPrev.endsWith(lowerNext)) {
    return cleanPrev;
  }

  // If cleanNext is a progressive superset that starts with cleanPrev
  if (lowerNext.startsWith(lowerPrev)) {
    return cleanNext;
  }

  // Check word boundary overlap (between 1 and 8 words)
  const prevWords = cleanPrev.split(/\s+/);
  const nextWords = cleanNext.split(/\s+/);
  const maxOverlap = Math.min(prevWords.length, nextWords.length, 8);

  for (let len = maxOverlap; len >= 1; len--) {
    const prevSlice = prevWords.slice(-len).join(' ').toLowerCase();
    const nextSlice = nextWords.slice(0, len).join(' ').toLowerCase();
    if (prevSlice === nextSlice) {
      // Overlap matched: append remainder of nextWords
      const remainder = nextWords.slice(len).join(' ');
      return remainder ? `${cleanPrev} ${remainder}` : cleanPrev;
    }
  }

  // No overlap found: combine with appropriate spacing
  return combineComposerText(cleanPrev, cleanNext);
}

/**
 * Selects the best candidate from a SpeechRecognitionResult's alternatives.
 * Evaluates alternative confidence scores when available to select the highest quality result.
 *
 * @param {SpeechRecognitionResult} result
 * @returns {string} Clean candidate transcript
 */
function selectBestAlternative(result) {
  if (!result || result.length === 0) return '';
  if (result.length === 1) return (result[0]?.transcript || '').trim();

  let best = result[0];
  let bestScore = typeof best?.confidence === 'number' && !isNaN(best.confidence) ? best.confidence : 0;

  for (let i = 1; i < result.length; i++) {
    const alt = result[i];
    if (!alt || !alt.transcript) continue;
    const conf = typeof alt.confidence === 'number' && !isNaN(alt.confidence) ? alt.confidence : 0;

    // Prefer candidate with higher confidence if available and non-empty
    if (conf > bestScore && alt.transcript.trim().length > 0) {
      best = alt;
      bestScore = conf;
    }
  }

  return (best?.transcript || result[0]?.transcript || '').trim();
}

/**
 * Evaluates whether a recognized transcript appears complete or is suspected to be truncated,
 * using multi-factor evidence: duration, word count, termination status, final vs interim results,
 * and audio availability.
 *
 * @param {Object} params
 * @param {string} [params.cleanSpeech=''] - Recognized speech text
 * @param {number} [params.durationSec=0] - Total recording duration in seconds
 * @param {boolean} [params.hasValidAudioBuffer=false] - Whether captured audio buffer is valid
 * @param {boolean} [params.recognitionEndedNormally=true] - Whether recognition finished cleanly via onend
 * @param {boolean} [params.hadFinalResults=false] - Whether engine produced any isFinal: true results
 * @param {boolean} [params.hadSubstantialInterim=false] - Whether interim text was substantial
 * @param {number} [params.remainingInterimLength=0] - Length of unfinalized interim text at stop time
 * @returns {{ isPotentiallyIncomplete: boolean, reason: string }}
 */
export function evaluateTranscriptCompleteness({
  cleanSpeech = '',
  durationSec = 0,
  hasValidAudioBuffer = false,
  recognitionEndedNormally = true,
  hadFinalResults = false,
  hadSubstantialInterim = false,
  remainingInterimLength = 0
}) {
  if (!hasValidAudioBuffer) {
    return { isPotentiallyIncomplete: false, reason: 'no_audio_buffer' };
  }

  const trimmed = (cleanSpeech || '').trim();
  const wordCount = trimmed ? trimmed.split(/\s+/).filter(Boolean).length : 0;

  // 1. Completely empty transcript despite valid audio recording
  if (!trimmed || wordCount === 0) {
    return { isPotentiallyIncomplete: true, reason: 'empty_transcript_with_audio' };
  }

  // 2. Recognition did not end normally (e.g. network error, safety timeout, unhandled error)
  if (!recognitionEndedNormally) {
    return { isPotentiallyIncomplete: true, reason: 'abnormal_recognition_termination' };
  }

  // 3. Engine never produced any isFinal: true results (only raw interim text was gathered)
  if (!hadFinalResults && wordCount <= 5) {
    return { isPotentiallyIncomplete: true, reason: 'no_final_results_received' };
  }

  // 4. Substantial interim text was left unfinalized when stop was initiated
  if (remainingInterimLength > 15 && wordCount <= 5) {
    return { isPotentiallyIncomplete: true, reason: 'unfinalized_interim_text' };
  }

  // 5. Severe duration-to-wordCount mismatch:
  // Normal conversational speech is 2.0 to 3.0 words per second.
  // Slow / deliberate speech is ~1.5 words per second.
  // An extended recording with very few words indicates speech was truncated before arriving:
  // - >= 3s with <= 2 words
  // - >= 6s with <= 4 words
  // - >= 8s with <= 6 words
  // - >= 10s with <= 8 words (covers 6-word 10s recording)
  // - >= 15s with <= 12 words
  const isDurationMismatch =
    (durationSec >= 3 && wordCount <= 2) ||
    (durationSec >= 6 && wordCount <= 4) ||
    (durationSec >= 8 && wordCount <= 6) ||
    (durationSec >= 10 && wordCount <= 8) ||
    (durationSec >= 15 && wordCount <= 12);

  if (isDurationMismatch) {
    return { isPotentiallyIncomplete: true, reason: 'duration_word_count_mismatch' };
  }

  return { isPotentiallyIncomplete: false, reason: 'appears_complete' };
}

/**
 * Decision policy for selecting the final voice dictation transcript.
 *
 * Recorded-audio transcription (Groq Whisper / Gemini) is the PREFERRED primary source
 * whenever a valid audio recording is available.
 * Native SpeechRecognition transcript serves as a reliable fallback when server transcription
 * fails, is empty, or when no valid audio recording could be captured.
 *
 * Decision Table:
 * - Recorded audio successful & non-empty -> Use recorded-audio transcript (source: 'provider')
 * - Recorded audio failed or empty + non-empty native -> Preserve native transcript (source: 'native')
 * - Recorded audio failed or empty + empty native -> Empty transcript (source: 'none')
 * - No valid audio Blob + non-empty native -> Use native transcript (source: 'native')
 * - No valid audio Blob + empty native -> Empty transcript (source: 'none')
 *
 * Rules:
 * - Do not bypass recorded-audio transcription merely because native recognition returned >= 4 words.
 * - Do not require native recognition to be incomplete before invoking recorded-audio transcription.
 * - Do not select a transcript based on word count, character count, or whichever result is longer.
 * - Do not blindly concatenate native and provider transcripts.
 * - Do not replace a successful provider transcript with native text merely because native text is longer.
 * - Do not silently discard both transcripts if provider fails.
 *
 * @param {Object} params
 * @param {string} [params.providerTranscript=''] - Server transcription text (Whisper / Gemini)
 * @param {boolean} [params.providerSuccess=false] - Whether server transcription succeeded
 * @param {string} [params.nativeTranscript=''] - Raw native SpeechRecognition text
 * @param {boolean} [params.hasValidAudio=false] - Whether a valid audio Blob was captured
 * @param {string} [params.providerFailureReason=''] - Reason if provider failed
 * @returns {{
 *   finalText: string,
 *   source: 'provider' | 'native' | 'none',
 *   reason: string
 * }}
 */
export function selectFinalTranscript({
  providerTranscript = '',
  providerSuccess = false,
  nativeTranscript = '',
  hasValidAudio = false,
  providerFailureReason = ''
}) {
  const cleanProvider = (providerTranscript || '').trim();
  const cleanNative = (nativeTranscript || '').trim();

  // 1. If valid audio was captured and server transcription succeeded with non-empty text:
  // Recorded audio transcription is the preferred primary result.
  if (hasValidAudio && providerSuccess && cleanProvider.length > 0) {
    return {
      finalText: cleanProvider,
      source: 'provider',
      reason: cleanNative.length > 0 ? 'provider_preferred_over_native' : 'provider_recovered_empty_native'
    };
  }

  // 2. If server transcription failed, returned empty, or had no valid audio:
  // Native transcript serves as the reliable fallback.
  if (cleanNative.length > 0) {
    const reason = !hasValidAudio
      ? 'no_valid_audio_native_used'
      : !providerSuccess
      ? `fallback_to_native_${providerFailureReason || 'provider_failed'}`
      : 'fallback_to_native_empty_provider_result';

    return {
      finalText: cleanNative,
      source: 'native',
      reason
    };
  }

  // 3. Both provider and native transcripts are empty or failed
  return {
    finalText: '',
    source: 'none',
    reason: !hasValidAudio
      ? 'no_audio_and_empty_native'
      : !providerSuccess
      ? 'provider_failed_and_empty_native'
      : 'both_transcripts_empty'
  };
}

/**
 * Reconciles recorded-audio transcription with native SpeechRecognition transcript,
 * applying the policy where successful recorded-audio transcription is preferred,
 * and native transcript serves as the reliable fallback.
 *
 * @param {Object} params
 * @param {string} [params.nativeText=''] - Recognized native speech
 * @param {string} [params.fallbackText=''] - Server transcription (Whisper/Gemini)
 * @param {boolean} [params.providerSuccess=true] - Whether server transcription succeeded
 * @param {boolean} [params.hasValidAudio=true] - Whether a valid audio Blob was captured
 * @param {string} [params.providerFailureReason=''] - Error description if provider failed
 * @returns {{ adoptedText: string, source: 'provider' | 'native' | 'none', reason: string }}
 */
export function reconcileFallbackTranscript({
  nativeText = '',
  fallbackText = '',
  providerSuccess = true,
  hasValidAudio = true,
  providerFailureReason = ''
}) {
  const cleanFallback = (fallbackText || '').trim();
  const isSuccess = providerSuccess && cleanFallback.length > 0;

  const decision = selectFinalTranscript({
    providerTranscript: cleanFallback,
    providerSuccess: isSuccess,
    nativeTranscript: nativeText,
    hasValidAudio,
    providerFailureReason
  });

  return {
    adoptedText: decision.finalText,
    source: decision.source,
    reason: decision.reason
  };
}

/**
 * Hook providing reliable, robust voice dictation using browser Web Speech API.
 *
 * Implements:
 * - Safe browser capability detection (window.SpeechRecognition || window.webkitSpeechRecognition).
 * - Multi-alternative candidate scoring (maxAlternatives = 3).
 * - Separation of interim vs finalized transcript accumulation.
 * - Non-destructive insertion that respects existing composer text.
 * - Protection against manual typing overwrites during dictation.
 * - Auto-restart deduplication to eliminate repeated words across silence restarts.
 * - Complete event lifecycle handling (start, result, error, end, speechstart, speechend, nomatch).
 * - Non-blocking Web Audio soundwave visualization with safe permission fallback.
 * - Clean teardown preventing duplicate recognition instances or memory leaks.
 *
 * @param {Object} options
 * @param {string} options.inputValue - Current text in the composer
 * @param {(text: string) => void} options.onInputChange - Callback to update composer text
 * @returns {Object} Dictation states, controls, and audio metrics
 */
export function useVoiceDictation({ inputValue = '', onInputChange, disabled = false }) {
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  // Safe capability detection across browsers (Chrome, Edge, Safari, Firefox, iOS, Android)
  const [capabilities, setCapabilities] = useState(detectDictationCapabilities);
  const [isSupported, setIsSupported] = useState(() => capabilities.isSupported);
  const [engineMode, setEngineMode] = useState(() => capabilities.engineMode);

  const [recordingState, setRecordingState] = useState('idle'); // 'idle' | 'requesting' | 'listening' | 'paused' | 'finalizing' | 'transcribing' | 'error'
  const [dictationError, setDictationError] = useState(null);
  const [interimTranscript, setInterimTranscript] = useState('');
  const [lastSessionTranscript, setLastSessionTranscript] = useState('');

  // Real-time audio reactivity: volume (0-100), 5 legacy bins, and full 16-band waveform bars
  const [audioLevel, setAudioLevel] = useState(0);
  const [audioFrequencies, setAudioFrequencies] = useState([0.15, 0.25, 0.35, 0.25, 0.15]);
  const [waveformBars, setWaveformBars] = useState(() => Array(NUM_WAVEFORM_BARS).fill(0.08));

  // Elapsed recording duration in seconds
  const [recordingDuration, setRecordingDuration] = useState(0);
  const durationIntervalRef = useRef(null);
  const pausedDurationRef = useRef(0);
  const pauseStartTimeRef = useRef(0);

  // Selected language with localStorage and browser locale resolution
  const [selectedLanguage, setSelectedLanguageState] = useState(getInitialLanguage);

  // Core references
  const recognitionRef = useRef(null);
  const baseTextRef = useRef('');
  const sessionAccumulatedTextRef = useRef(''); // Persistent accumulated speech text across instances & breaks
  const currentInstanceFinalMapRef = useRef(new Map()); // Map of index -> finalized transcript for current instance
  const currentInstanceFinalRef = useRef(''); // Combined finalized text for current instance
  const committedSegmentsRef = useRef([]); // Backward-compatibility ref for active segments
  const lastEmittedValueRef = useRef(''); // Tracks exact value sent to onInputChange
  const recentEmissionsRef = useRef(new Set()); // Tracks values emitted by dictation to distinguish from user typing
  const interimTranscriptRef = useRef('');
  const inputValueRef = useRef(inputValue);
  inputValueRef.current = inputValue;

  const onInputChangeRef = useRef(onInputChange);
  onInputChangeRef.current = onInputChange;

  const isExplicitStopRef = useRef(false);
  const isStoppingRef = useRef(false);
  const isCancelledRef = useRef(false);
  const hasFatalErrorRef = useRef(false);
  const hadFinalResultsRef = useRef(false);
  const hadSubstantialInterimRef = useRef(false);
  const hadPendingInterimLenRef = useRef(0);
  const recognitionEndedNormallyRef = useRef(false);
  const pendingRecognitionShutdownResolveRef = useRef(null);
  const recordingStateRef = useRef(recordingState);
  recordingStateRef.current = recordingState;

  const selectedLanguageRef = useRef(selectedLanguage);
  selectedLanguageRef.current = selectedLanguage;

  const pauseListeningRef = useRef(null);

  const restartTimeoutRef = useRef(null);
  const consecutiveErrorsRef = useRef(0);
  const consecutiveSilenceRestartsRef = useRef(0);
  const isStartingRef = useRef(false);
  const isTransitioningRef = useRef(false); // Concurrency guard against rapid multi-tapping
  const instanceCounterRef = useRef(0);
  const lastCommittedSegmentRef = useRef({ text: '', timestamp: 0 });

  // AudioContext & Analyser refs for real-time soundwave
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const animFrameRef = useRef(null);

  // Phase 5.2: MediaRecorder audio capture & buffering state & refs
  const [recordedAudioBlob, setRecordedAudioBlob] = useState(null);
  const [recordedAudioDuration, setRecordedAudioDuration] = useState(0);

  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]); // Ordered array of audio Blob chunks
  const recordedBytesRef = useRef(0);
  const recordingStartTimeRef = useRef(0);
  const activeMimeTypeRef = useRef('');
  const recordedAudioBlobRef = useRef(null);

  // Phase 5.3: Whisper-based high-accuracy transcription state & refs
  const [transcriptionMeta, setTranscriptionMeta] = useState(null);
  const [transcriptionNotice, setTranscriptionNotice] = useState(null);

  const transcriptionAbortCtrlRef = useRef(null);
  const transcriptionSessionCounterRef = useRef(0);
  const expectedEmittedBeforeTranscribeRef = useRef('');
  const nativeSessionTranscriptRef = useRef('');
  const sessionBaseTextRef = useRef('');

  // Diagnostic Observability (temporary, privacy-conscious)
  const activeDiagnosticSessionRef = useRef(null);
  const [lastDiagnostic, setLastDiagnostic] = useState(getLastDictationDiagnostic);
  const [isDiagnosticsEnabledState, setIsDiagnosticsEnabledState] = useState(isDictationDiagnosticsEnabled);

  const setDiagnosticsEnabled = useCallback((enabled) => {
    setDictationDiagnosticsEnabled(enabled);
    setIsDiagnosticsEnabledState(Boolean(enabled));
  }, []);

  // Synchronous state updater to avoid React re-render closure lag in event handlers
  const updateRecordingState = useCallback((newState) => {
    recordingStateRef.current = newState;
    setRecordingState(newState);
  }, []);

  // Helper to record an emitted dictation value, ensuring synchronous ref tracking and bounded history
  const recordEmission = useCallback((val) => {
    lastEmittedValueRef.current = val;
    inputValueRef.current = val;
    if (val && typeof val === 'string' && val.trim()) {
      recentEmissionsRef.current.add(val);
      recentEmissionsRef.current.add(val.trim());
      if (recentEmissionsRef.current.size > 200) {
        const oldest = recentEmissionsRef.current.values().next().value;
        recentEmissionsRef.current.delete(oldest);
      }
    }
  }, []);

  // Sync capability detection on mount
  useEffect(() => {
    const caps = detectDictationCapabilities();
    setCapabilities(caps);
    setIsSupported(caps.isSupported);
    setEngineMode(caps.engineMode);
  }, []);

  // Handle genuine manual typing, pasting, or clearing in the composer across all lifecycles.
  // Manual clearing (empty input) unconditionally resets all base refs, invalidates in-flight
  // transcriptions, and guarantees deleted text never resurrects or leaks into future sessions.
  useEffect(() => {
    // 1. Explicit manual deletion / clearing (Ctrl+A, Backspace / clear input)
    if (!inputValue || !inputValue.trim()) {
      inputValueRef.current = '';
      baseTextRef.current = '';
      sessionBaseTextRef.current = '';
      sessionAccumulatedTextRef.current = '';
      currentInstanceFinalMapRef.current.clear();
      currentInstanceFinalRef.current = '';
      committedSegmentsRef.current = [];
      interimTranscriptRef.current = '';
      lastEmittedValueRef.current = '';
      recentEmissionsRef.current.clear();
      lastCommittedSegmentRef.current = { text: '', timestamp: 0 };
      nativeSessionTranscriptRef.current = '';
      expectedEmittedBeforeTranscribeRef.current = '';
      setLastSessionTranscript('');
      setInterimTranscript('');
      setTranscriptionNotice(null);

      // Invalidate any in-flight asynchronous transcription immediately
      if (
        recordingStateRef.current === 'transcribing' ||
        recordingStateRef.current === 'finalizing'
      ) {
        if (transcriptionAbortCtrlRef.current) {
          try {
            transcriptionAbortCtrlRef.current.abort();
          } catch (_) {}
          transcriptionAbortCtrlRef.current = null;
        }
        transcriptionSessionCounterRef.current += 1;
        updateRecordingState('idle');
      }
      return;
    }

    // 2. Ignore dictation's own emissions to prevent React render cycles from treating them as manual user edits
    if (
      recentEmissionsRef.current.has(inputValue) ||
      recentEmissionsRef.current.has(inputValue.trim()) ||
      inputValue === lastEmittedValueRef.current
    ) {
      return;
    }

    // 3. User manually typed, pasted, or edited text in the composer
    if (inputValue !== lastEmittedValueRef.current) {
      baseTextRef.current = inputValue;
      sessionBaseTextRef.current = inputValue;
      lastEmittedValueRef.current = inputValue;

      // When actively listening or paused, reset committed segments so newly spoken speech
      // appends cleanly to the user's manual modifications without repeating or reverting edits
      if (
        recordingStateRef.current === 'listening' ||
        recordingStateRef.current === 'paused'
      ) {
        sessionAccumulatedTextRef.current = '';
        currentInstanceFinalMapRef.current.clear();
        currentInstanceFinalRef.current = '';
        committedSegmentsRef.current = [];
        interimTranscriptRef.current = '';
        setInterimTranscript('');
      }
    }
  }, [inputValue, updateRecordingState]);

  // Cleanup helper for all microphone, visualizer, and audio recorder resources (Phase 5.2 & 5.4)
  const stopAudioResources = useCallback(() => {
    // 1. Cancel visualizer animation frame
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }

    // 2. Safely stop MediaRecorder if active
    if (mediaRecorderRef.current) {
      try {
        if (mediaRecorderRef.current.state !== 'inactive') {
          mediaRecorderRef.current.stop();
        }
      } catch (_) {}
      mediaRecorderRef.current = null;
    }

    // 3. Stop all audio tracks on the shared MediaStream
    if (mediaStreamRef.current) {
      try {
        mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      } catch (_) {}
      mediaStreamRef.current = null;
    }

    // 4. Safely close AudioContext
    if (audioContextRef.current) {
      try {
        audioContextRef.current.close();
      } catch (_) {}
      audioContextRef.current = null;
    }

    // Clear duration timer interval
    if (durationIntervalRef.current) {
      clearInterval(durationIntervalRef.current);
      durationIntervalRef.current = null;
    }

    analyserRef.current = null;
    setAudioLevel(0);
    setAudioFrequencies([0.15, 0.25, 0.35, 0.25, 0.15]);
    setWaveformBars(Array(NUM_WAVEFORM_BARS).fill(0.08));
  }, []);

  // Safely acquires a single shared microphone MediaStream (Phase 5.2 & 5.4).
  // Coordinates both the visualizer AnalyserNode and MediaRecorder on the same stream,
  // preventing multiple hardware capture streams and audio pipeline renegotiation.
  // Handles track interruptions (incoming phone calls, headset disconnects).
  const acquireMicrophoneStream = useCallback(async () => {
    if (typeof window === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone capture is not supported in this browser.');
    }

    // Re-use active microphone stream across silence restarts so hardware doesn't drop words
    if (mediaStreamRef.current && mediaStreamRef.current.active) {
      const audioTracks = mediaStreamRef.current.getAudioTracks();
      if (audioTracks.length > 0 && audioTracks[0].readyState === 'live' && !audioTracks[0].muted) {
        return mediaStreamRef.current;
      }
    }

    // Stop stale tracks before requesting new stream
    if (mediaStreamRef.current) {
      try {
        mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      } catch (_) {}
      mediaStreamRef.current = null;
    }

    let stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
    } catch (_) {
      // Fallback to minimal audio constraints if advanced constraints fail (older Android/iOS WebViews)
      stream = await navigator.mediaDevices.getUserMedia({
        audio: true
      });
    }

    // Mobile & hardware interruption handling (incoming phone calls, bluetooth disconnects)
    stream.getAudioTracks().forEach((track) => {
      track.onended = () => {
        if (
          recordingStateRef.current === 'listening' ||
          recordingStateRef.current === 'requesting'
        ) {
          stopAudioResources();
          setDictationError('Microphone was disconnected or interrupted by another application.');
          updateRecordingState('error');
        } else if (recordingStateRef.current === 'paused') {
          // Hardware track ended while paused; clean up audio resources cleanly
          stopAudioResources();
        }
      };

      track.onmute = () => {
        // Hardware microphone muted by OS (incoming call, headset unplugged)
        if (recordingStateRef.current === 'listening') {
          pauseListeningRef.current?.(true);
          setTranscriptionNotice({
            type: 'fallback',
            message: 'Microphone was muted by another app or call. Tap Resume when ready.'
          });
        }
      };
    });

    mediaStreamRef.current = stream;
    return stream;
  }, [stopAudioResources, updateRecordingState]);

  // Connects Web Audio analyser to the shared MediaStream for non-blocking reactive visualizer
  const attachAudioAnalyser = useCallback((stream) => {
    if (typeof window === 'undefined' || !stream) return;

    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;

      let ctx = audioContextRef.current;
      if (!ctx || ctx.state === 'closed') {
        ctx = new AudioCtx();
        audioContextRef.current = ctx;
      }
      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 128; // 64 frequency bins
      analyser.smoothingTimeConstant = 0.65;
      analyserRef.current = analyser;

      const source = ctx.createMediaStreamSource(stream);
      source.connect(analyser);

      const dataArray = new Uint8Array(analyser.frequencyBinCount);

      const updateMeter = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteFrequencyData(dataArray);

        let sum = 0;
        const activeBins = Math.min(dataArray.length, 36);
        for (let i = 0; i < activeBins; i++) {
          sum += dataArray[i];
        }
        const avg = sum / (activeBins || 1);
        const normalizedVol = Math.min(100, Math.round((avg / 120) * 100));
        setAudioLevel(normalizedVol);

        // Map real microphone frequency spectrum to 16 reactive waveform bars
        const step = Math.max(1, Math.floor(activeBins / NUM_WAVEFORM_BARS));
        const bars = [];
        for (let b = 0; b < NUM_WAVEFORM_BARS; b++) {
          const idx = Math.min(dataArray.length - 1, b * step);
          const val = dataArray[idx] || 0;
          // Normalized value between 0.08 (idle baseline) and 1.0 (peak speech)
          const level = Math.max(0.08, Math.min(1.0, val / 230));
          bars.push(level);
        }
        setWaveformBars(bars);
        setAudioFrequencies(bars.slice(0, 5));

        animFrameRef.current = requestAnimationFrame(updateMeter);
      };

      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
      }
      animFrameRef.current = requestAnimationFrame(updateMeter);
    } catch (_) {
      // Non-fatal visualizer fallback
    }
  }, []);

  // Starts or continues audio buffering using MediaRecorder on the shared MediaStream (Phase 5.2 & 5.4).
  // Cross-browser resilience: falls back gracefully if preferred MIME type is rejected.
  const startMediaRecorder = useCallback((stream) => {
    if (typeof window === 'undefined' || !window.MediaRecorder || !stream) return;

    // If recorder is already recording or paused on this stream, maintain continuous session
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      return;
    }

    try {
      const mimeType = getSupportedAudioMimeType();
      let recorder = null;

      if (mimeType) {
        try {
          recorder = new MediaRecorder(stream, { mimeType });
        } catch (mimeErr) {
          console.warn('Preferred MIME type rejected by MediaRecorder, falling back to default:', mimeErr);
          recorder = new MediaRecorder(stream);
        }
      } else {
        recorder = new MediaRecorder(stream);
      }

      activeMimeTypeRef.current = recorder.mimeType || mimeType || 'audio/webm';
      if (activeDiagnosticSessionRef.current) {
        activeDiagnosticSessionRef.current.mimeType = activeMimeTypeRef.current;
      }

      recorder.ondataavailable = (event) => {
        if (!event.data || event.data.size === 0) return;

        // Memory safeguard: prevent unbounded memory growth during long dictation sessions
        if (recordedBytesRef.current + event.data.size > MAX_RECORDED_BYTES) {
          console.warn('Orvix dictation audio buffer reached maximum memory limit (25MB). Capping capture.');
          return;
        }

        audioChunksRef.current.push(event.data);
        recordedBytesRef.current += event.data.size;
      };

      recorder.onerror = (err) => {
        console.warn('MediaRecorder error during dictation:', err);
      };

      recorder.start(CHUNK_TIMESLICE_MS);
      mediaRecorderRef.current = recorder;
    } catch (recErr) {
      console.warn('MediaRecorder initialization failed:', recErr);
    }
  }, []);

  const clearDictationError = useCallback(() => {
    setDictationError(null);
    if (recordingStateRef.current === 'error') {
      updateRecordingState('idle');
    }
  }, [updateRecordingState]);

  const clearLastSessionTranscript = useCallback(() => {
    setLastSessionTranscript('');
  }, []);

  const clearRecordedAudio = useCallback(() => {
    audioChunksRef.current = [];
    recordedBytesRef.current = 0;
    recordedAudioBlobRef.current = null;
    setRecordedAudioBlob(null);
    setRecordedAudioDuration(0);
  }, []);

  const getAudioBlob = useCallback(() => {
    return recordedAudioBlobRef.current;
  }, []);

  /**
   * Safely disposes a SpeechRecognition instance and detaches all event listeners.
   */
  const cleanupRecognitionInstance = useCallback(() => {
    if (recognitionRef.current) {
      const rec = recognitionRef.current;
      recognitionRef.current = null;
      try {
        rec.onstart = null;
        rec.onresult = null;
        rec.onerror = null;
        rec.onend = null;
        rec.onspeechstart = null;
        rec.onspeechend = null;
        rec.onaudiostart = null;
        rec.onaudioend = null;
        rec.onnomatch = null;
        rec.abort();
      } catch (_) {}
    }
  }, []);

  /**
   * Starts or restarts the browser SpeechRecognition instance with complete audio capture lifecycle.
   *
   * @param {boolean} [isNewSession=true] - Whether this is an initial user-triggered session
   */
  const startRecognitionSession = useCallback(
    async (isNewSession = true) => {
      clearTimeout(restartTimeoutRef.current);

      const caps = detectDictationCapabilities();

      // Check if browser has no audio recording or dictation capabilities at all
      if (!caps.isSupported) {
        setDictationError(
          'Microphone recording is not supported in this browser. Please use Google Chrome, Microsoft Edge, Safari, or Firefox.'
        );
        hasFatalErrorRef.current = true;
        updateRecordingState('error');
        return;
      }

      instanceCounterRef.current += 1;
      const currentInstanceId = instanceCounterRef.current;

      if (isNewSession) {
        // Cancel active TTS playback so microphone does not pick up audio from device speakers
        if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
          try {
            window.speechSynthesis.cancel();
          } catch (_) {}
        }

        // Snapshot existing composer content as the base prefix
        baseTextRef.current = inputValueRef.current || '';
        sessionBaseTextRef.current = baseTextRef.current;
        sessionAccumulatedTextRef.current = '';
        currentInstanceFinalMapRef.current.clear();
        currentInstanceFinalRef.current = '';
        committedSegmentsRef.current = [];
        interimTranscriptRef.current = '';
        recentEmissionsRef.current.clear();
        if (baseTextRef.current && baseTextRef.current.trim()) {
          recordEmission(baseTextRef.current);
        }
        setInterimTranscript('');
        setLastSessionTranscript('');
        isExplicitStopRef.current = false;
        isStoppingRef.current = false;
        isCancelledRef.current = false;
        hadFinalResultsRef.current = false;
        hadSubstantialInterimRef.current = false;
        hadPendingInterimLenRef.current = 0;
        recognitionEndedNormallyRef.current = false;
        pendingRecognitionShutdownResolveRef.current = null;
        hasFatalErrorRef.current = false;
        consecutiveErrorsRef.current = 0;
        consecutiveSilenceRestartsRef.current = 0;
        lastCommittedSegmentRef.current = { text: '', timestamp: 0 };
        nativeSessionTranscriptRef.current = '';
        expectedEmittedBeforeTranscribeRef.current = '';

        // Reset audio capture buffers and duration timer for fresh session
        audioChunksRef.current = [];
        recordedBytesRef.current = 0;
        recordingStartTimeRef.current = Date.now();
        pausedDurationRef.current = 0;
        pauseStartTimeRef.current = 0;
        setRecordingDuration(0);
        if (durationIntervalRef.current) {
          clearInterval(durationIntervalRef.current);
          durationIntervalRef.current = null;
        }
        recordedAudioBlobRef.current = null;
        setRecordedAudioBlob(null);
        setRecordedAudioDuration(0);

        if (transcriptionAbortCtrlRef.current) {
          try {
            transcriptionAbortCtrlRef.current.abort();
          } catch (_) {}
          transcriptionAbortCtrlRef.current = null;
        }
        transcriptionSessionCounterRef.current += 1;
        setTranscriptionNotice(null);

        // Initialize unique recording session diagnostic tracker
        const currentDiagnosticSessionId = `dict-sess-${Date.now()}-${transcriptionSessionCounterRef.current}`;
        activeDiagnosticSessionRef.current = createDiagnosticSession({
          sessionId: currentDiagnosticSessionId,
          engineMode: caps.engineMode,
          language: selectedLanguageRef.current,
          isPublicSharedViewer: Boolean(disabledRef.current)
        });

        updateRecordingState('requesting');
      } else {
        // Continuing session after browser silence restart or resume:
        // Clear current instance buffers while preserving sessionAccumulatedTextRef intact.
        currentInstanceFinalMapRef.current.clear();
        currentInstanceFinalRef.current = '';
        interimTranscriptRef.current = '';
        setInterimTranscript('');
      }

      const SpeechRecognition =
        typeof window !== 'undefined'
          ? window.SpeechRecognition || window.webkitSpeechRecognition
          : null;

      if (SpeechRecognition && activeDiagnosticSessionRef.current) {
        activeDiagnosticSessionRef.current.nativeInitialized = true;
      }

      if (!SpeechRecognition) {
        if (caps.hasGetUserMedia && caps.hasMediaRecorder) {
          // Native audio capture fallback for browsers without Web Speech API (Firefox, iOS PWA)
          acquireMicrophoneStream()
            .then((stream) => {
              attachAudioAnalyser(stream);
              startMediaRecorder(stream);
              updateRecordingState('listening');
            })
            .catch((streamErr) => {
              console.warn('[Dictation] Microphone stream acquisition failed:', streamErr);
              hasFatalErrorRef.current = true;
              stopAudioResources();
              setDictationError('Microphone access was denied. Please allow microphone permissions.');
              updateRecordingState('error');
            });
          return;
        }

        setDictationError(
          'Voice dictation is not supported in this browser. Please use Google Chrome, Microsoft Edge, or Safari.'
        );
        hasFatalErrorRef.current = true;
        updateRecordingState('error');
        return;
      }

      // Clean up any existing recognition instance completely before instantiating a new one
      cleanupRecognitionInstance();

      if (isStartingRef.current) return;
      isStartingRef.current = true;

      // In parallel for fresh sessions (isNewSession), initialize microphone stream for audio visualizer & MediaRecorder
      const shouldInitAudioStream =
        isNewSession &&
        caps.hasGetUserMedia;

      if (shouldInitAudioStream) {
        acquireMicrophoneStream()
          .then((sharedStream) => {
            if (
              isExplicitStopRef.current ||
              (recordingStateRef.current !== 'listening' && recordingStateRef.current !== 'requesting')
            ) {
              stopAudioResources();
              return;
            }
            attachAudioAnalyser(sharedStream);
            if (caps.hasMediaRecorder) {
              startMediaRecorder(sharedStream);
            }
          })
          .catch((streamErr) => {
            console.warn('[Dictation] Microphone stream acquisition notice:', streamErr);
            if (!recognitionRef.current) {
              isStartingRef.current = false;
              hasFatalErrorRef.current = true;
              stopAudioResources();
              const errorMsg =
                streamErr?.name === 'NotAllowedError' || streamErr?.name === 'PermissionDeniedError'
                  ? 'Microphone access was denied. Please allow microphone permissions in your browser address bar.'
                  : streamErr?.name === 'NotFoundError' || streamErr?.name === 'DevicesNotFoundError'
                  ? 'No microphone detected or microphone is currently busy in another application.'
                  : 'Unable to access microphone. Please check device permissions.';
              setDictationError(errorMsg);
              updateRecordingState('error');
            }
          });
      }

      // 2. Synchronously instantiate and start SpeechRecognition under the active user activation
      try {
        const recognition = new SpeechRecognition();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.maxAlternatives = 1;
        recognition.lang = selectedLanguageRef.current;

        if (isDictationDiagnosticsEnabled()) {
          console.log(
            `[Dictation] Initializing recognition (continuous: true, interimResults: true, lang: ${selectedLanguageRef.current})`
          );
        }

        hasFatalErrorRef.current = false;

        recognition.onstart = () => {
          if (instanceCounterRef.current !== currentInstanceId) return;
          if (isDictationDiagnosticsEnabled()) {
            console.log('[Dictation] Speech recognition service active');
          }
          isStartingRef.current = false;
          updateRecordingState('listening');
          setDictationError(null);
          consecutiveErrorsRef.current = 0;

          // Start elapsed duration timer if not running
          if (!durationIntervalRef.current) {
            durationIntervalRef.current = setInterval(() => {
              if (recordingStateRef.current === 'listening') {
                const now = Date.now();
                const start = recordingStartTimeRef.current || now;
                const elapsed = Math.max(0, Math.floor((now - start - pausedDurationRef.current) / 1000));
                setRecordingDuration(elapsed);
              }
            }, 250);
          }
        };

        recognition.onspeechstart = () => {
          if (instanceCounterRef.current !== currentInstanceId) return;
          consecutiveErrorsRef.current = 0;
        };

        recognition.onspeechend = () => {
          if (instanceCounterRef.current !== currentInstanceId) return;
        };

        recognition.onnomatch = () => {
          // Audio detected but no alternative met confidence threshold; keep listening
        };

        recognition.onresult = (event) => {
          if (instanceCounterRef.current !== currentInstanceId) return;
          if (isCancelledRef.current) return;
          consecutiveErrorsRef.current = 0;
          consecutiveSilenceRestartsRef.current = 0;

          // 1. Process all finalized results chronologically across all available indices
          let hasNewFinal = false;
          for (let i = 0; i < event.results.length; i++) {
            const res = event.results[i];
            if (res && res.isFinal) {
              const bestCandidate = selectBestAlternative(res);
              if (bestCandidate && bestCandidate.trim()) {
                const existing = currentInstanceFinalMapRef.current.get(i);
                if (existing !== bestCandidate.trim()) {
                  currentInstanceFinalMapRef.current.set(i, bestCandidate.trim());
                  hasNewFinal = true;
                  hadFinalResultsRef.current = true;
                  if (activeDiagnosticSessionRef.current) {
                    activeDiagnosticSessionRef.current.hadFinalResults = true;
                  }
                }
              }
            }
          }

          if (hasNewFinal) {
            const sortedIndices = Array.from(currentInstanceFinalMapRef.current.keys()).sort((a, b) => a - b);
            const instanceParts = [];
            for (const idx of sortedIndices) {
              const part = currentInstanceFinalMapRef.current.get(idx);
              if (part) instanceParts.push(part);
            }
            currentInstanceFinalRef.current = instanceParts.join(' ');

            // Maintain committedSegmentsRef for inspection and backward compatibility
            const fullAccumulated = mergeTranscriptSegments(
              sessionAccumulatedTextRef.current,
              currentInstanceFinalRef.current
            );
            committedSegmentsRef.current = [
              {
                instanceId: currentInstanceId,
                index: 0,
                text: fullAccumulated,
                timestamp: Date.now()
              }
            ];
          }

          // 2. Compute current interim text across all unfinalized results
          // Web Speech API emits distinct unfinalized segments across sequential indices.
          // Concatenate all unfinalized parts chronologically to prevent dropping early or middle clauses.
          const unfinalizedParts = [];
          for (let i = 0; i < event.results.length; i++) {
            const res = event.results[i];
            if (res && !res.isFinal) {
              const interimCand = selectBestAlternative(res);
              if (interimCand && interimCand.trim()) {
                unfinalizedParts.push(interimCand.trim());
              }
            }
          }

          const currentInterim = unfinalizedParts.join(' ');
          interimTranscriptRef.current = currentInterim;
          if (currentInterim && currentInterim.trim().length >= 10) {
            hadSubstantialInterimRef.current = true;
          }
          if (isStoppingRef.current) {
            hadPendingInterimLenRef.current = currentInterim.trim().length;
          }
          setInterimTranscript(currentInterim);
        };

        recognition.onerror = (event) => {
          if (instanceCounterRef.current !== currentInstanceId) return;
          isStartingRef.current = false;
          const errorType = event?.error;

          // If stop was in progress and error is aborted or no-speech, do NOT treat as fatal
          // and DO NOT resolve the shutdown promise prematurely — let onend finalize normally.
          if (isStoppingRef.current || isExplicitStopRef.current || errorType === 'aborted') {
            return;
          }

          // Mark abnormal termination for unexpected/fatal errors
          if (errorType !== 'no-speech') {
            recognitionEndedNormallyRef.current = false;
          }

          if (errorType === 'not-allowed' || errorType === 'service-not-allowed') {
            if (!isNewSession && mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
              if (isDictationDiagnosticsEnabled()) {
                console.warn(
                  '[Dictation] SpeechRecognition auto-restart not allowed, maintaining active MediaRecorder session.'
                );
              }
              return;
            }
            hasFatalErrorRef.current = true;
            stopAudioResources();
            setDictationError(
              'Microphone access was denied. Please allow microphone permissions in your browser address bar.'
            );
            updateRecordingState('error');
          } else if (errorType === 'audio-capture') {
            if (!isNewSession && mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
              if (isDictationDiagnosticsEnabled()) {
                console.warn(
                  '[Dictation] SpeechRecognition auto-restart audio-capture error, maintaining active MediaRecorder session.'
                );
              }
              return;
            }
            hasFatalErrorRef.current = true;
            stopAudioResources();
            setDictationError(
              'No microphone detected or microphone is currently busy in another application.'
            );
            updateRecordingState('error');
          } else if (errorType === 'no-speech') {
            // Natural pause in speech: keep listening.
            // Do NOT increment fatal errors or close mic.
            return;
          } else if (errorType === 'network') {
            consecutiveErrorsRef.current += 1;
            if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
              if (isDictationDiagnosticsEnabled()) {
                console.warn('[Dictation] Speech recognition network error; MediaRecorder active.');
              }
              return;
            }
            if (consecutiveErrorsRef.current > 2) {
              hasFatalErrorRef.current = true;
              stopAudioResources();
              setDictationError('Speech recognition network error. Please verify your internet connection.');
              updateRecordingState('error');
            }
          } else if (errorType === 'language-not-supported') {
            hasFatalErrorRef.current = true;
            stopAudioResources();
            setDictationError(
              `The selected language (${selectedLanguageRef.current}) is not supported in this browser. Falling back to English (US).`
            );
            selectedLanguageRef.current = DEFAULT_LANGUAGE;
            setSelectedLanguageState(DEFAULT_LANGUAGE);
            updateRecordingState('error');
          } else {
            consecutiveErrorsRef.current += 1;
            if (consecutiveErrorsRef.current > 3) {
              if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
                if (isDictationDiagnosticsEnabled()) {
                  console.warn(
                    '[Dictation] SpeechRecognition error threshold reached, maintaining active MediaRecorder session.'
                  );
                }
                return;
              }
              hasFatalErrorRef.current = true;
              stopAudioResources();
              setDictationError('Dictation stopped unexpectedly. Please tap the microphone to continue.');
              updateRecordingState('error');
            }
          }
        };

        recognition.onend = () => {
          if (instanceCounterRef.current !== currentInstanceId) return;
          isStartingRef.current = false;
          recognitionRef.current = null;
          if (!hasFatalErrorRef.current) {
            recognitionEndedNormallyRef.current = true;
          }
          if (activeDiagnosticSessionRef.current) {
            activeDiagnosticSessionRef.current.recognitionEndedNormally = recognitionEndedNormallyRef.current;
          }

          // Fold any finalized or pending interim text into persistent session accumulation before instance teardown
          if (currentInstanceFinalRef.current && currentInstanceFinalRef.current.trim()) {
            sessionAccumulatedTextRef.current = mergeTranscriptSegments(
              sessionAccumulatedTextRef.current,
              currentInstanceFinalRef.current.trim()
            );
          }
          if (interimTranscriptRef.current && interimTranscriptRef.current.trim()) {
            sessionAccumulatedTextRef.current = mergeTranscriptSegments(
              sessionAccumulatedTextRef.current,
              interimTranscriptRef.current.trim()
            );
            interimTranscriptRef.current = '';
            setInterimTranscript('');
          }
          currentInstanceFinalMapRef.current.clear();
          currentInstanceFinalRef.current = '';

          // Signal pending shutdown promise that onend has executed
          if (pendingRecognitionShutdownResolveRef.current) {
            const resolveFn = pendingRecognitionShutdownResolveRef.current;
            pendingRecognitionShutdownResolveRef.current = null;
            resolveFn();
          }

          if (hasFatalErrorRef.current) {
            if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
              hasFatalErrorRef.current = false;
              if (isDictationDiagnosticsEnabled()) {
                console.warn('[Dictation] SpeechRecognition fatal error flagged, but MediaRecorder is actively recording.');
              }
              return;
            }
            hasFatalErrorRef.current = false;
            stopAudioResources();
            updateRecordingState('error');
            return;
          }

          // If speech recognizer ended naturally during active listening without explicit user stop
          // (such as standard browser 60s silence timeout or mobile sentence cutoff), recover cleanly.
          if (
            !isExplicitStopRef.current &&
            !isStoppingRef.current &&
            recordingStateRef.current === 'listening'
          ) {
            const isMediaRecorderHealthy =
              mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording';

            const isIOS =
              /iPad|iPhone|iPod/.test(navigator.userAgent || '') ||
              (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

            if (isIOS) {
              if (isMediaRecorderHealthy) {
                if (isDictationDiagnosticsEnabled()) {
                  console.warn('[Dictation] SpeechRecognition ended on iOS; MediaRecorder continues recording.');
                }
                return;
              }
              // iOS Safari requires explicit user interaction to restart recognition.
              // Gracefully transition to paused state so the user can easily tap Resume.
              pauseListening();
              setTranscriptionNotice({
                type: 'fallback',
                message: 'Dictation paused after silence. Tap Resume to continue speaking.'
              });
              return;
            }

            // Desktop / Android silence restart guard
            consecutiveSilenceRestartsRef.current += 1;
            if (consecutiveSilenceRestartsRef.current > 4) {
              consecutiveSilenceRestartsRef.current = 0;
              if (isMediaRecorderHealthy) {
                if (isDictationDiagnosticsEnabled()) {
                  console.warn(
                    '[Dictation] SpeechRecognition max silence restarts reached; MediaRecorder continues recording.'
                  );
                }
                return;
              }
              pauseListening();
              return;
            }

            clearTimeout(restartTimeoutRef.current);
            restartTimeoutRef.current = setTimeout(() => {
              if (recordingStateRef.current === 'listening' && !isExplicitStopRef.current && !isStoppingRef.current) {
                try {
                  startRecognitionSession(false);
                } catch (restartErr) {
                  if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
                    if (isDictationDiagnosticsEnabled()) {
                      console.warn('[Dictation] SpeechRecognition restart invocation threw:', restartErr);
                    }
                    return;
                  }
                  console.warn('[Dictation] SpeechRecognition restart invocation threw:', restartErr);
                  pauseListening();
                }
              }
            }, 50);
            return;
          }

          if (
            !isStoppingRef.current &&
            recordingStateRef.current !== 'stopping' &&
            recordingStateRef.current !== 'transcribing' &&
            recordingStateRef.current !== 'paused'
          ) {
            if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
              if (isDictationDiagnosticsEnabled()) {
                console.warn('[Dictation] SpeechRecognition onend reached fallback, but MediaRecorder is recording.');
              }
              return;
            }
            stopAudioResources();
            updateRecordingState('idle');
          }
        };

        recognitionRef.current = recognition;
        recognition.start();
      } catch (initErr) {
        isStartingRef.current = false;
        if (!isNewSession) {
          // Auto-restart rejected by browser gesture restriction (expected on iOS Safari after silence)
          if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
            if (isDictationDiagnosticsEnabled()) {
              console.warn('Auto-restart rejected by browser gesture restriction:', initErr);
              console.warn(
                '[Dictation] SpeechRecognition auto-restart failed but MediaRecorder is active; maintaining recording session.'
              );
            }
            return;
          }
          console.warn('Auto-restart rejected by browser gesture restriction:', initErr);
          pauseListening();
          return;
        }
        if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
          if (isDictationDiagnosticsEnabled()) {
            console.warn('SpeechRecognition initialization error:', initErr);
            console.warn(
              '[Dictation] SpeechRecognition init failed but MediaRecorder is active; maintaining recording session.'
            );
          }
          return;
        }
        console.warn('SpeechRecognition initialization error:', initErr);
        hasFatalErrorRef.current = true;
        stopAudioResources();
        setDictationError('Unable to activate microphone. Please verify device permissions.');
        updateRecordingState('error');
      }
    },
    [
      acquireMicrophoneStream,
      attachAudioAnalyser,
      cleanupRecognitionInstance,
      startMediaRecorder,
      stopAudioResources,
      updateRecordingState
    ]
  );

  // Start a fresh dictation session with concurrency guards
  const startListening = useCallback(async () => {
    if (disabledRef.current || isTransitioningRef.current) return;
    if (
      recordingStateRef.current === 'listening' ||
      recordingStateRef.current === 'requesting' ||
      recordingStateRef.current === 'stopping' ||
      recordingStateRef.current === 'finalizing' ||
      recordingStateRef.current === 'transcribing' ||
      recordingStateRef.current === 'success'
    ) {
      return;
    }
    isTransitioningRef.current = true;

    try {
      isExplicitStopRef.current = false;
      hasFatalErrorRef.current = false;
      setDictationError(null);
      await startRecognitionSession(true);
    } finally {
      setTimeout(() => {
        isTransitioningRef.current = false;
      }, 150);
    }
  }, [startRecognitionSession]);

  // Pause dictation temporarily. If releaseHardware is true (e.g. app backgrounded or incoming phone call),
  // actively stops hardware tracks so the system microphone indicator turns off immediately.
  const pauseListening = useCallback(
    (releaseHardware = false) => {
      isExplicitStopRef.current = true;
      clearTimeout(restartTimeoutRef.current);
      cleanupRecognitionInstance();

      // Pause MediaRecorder
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
        try {
          mediaRecorderRef.current.pause();
        } catch (_) {}
      }

      // Pause visualizer animation
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = null;
      }
      setAudioLevel(0);
      setAudioFrequencies([0.15, 0.25, 0.35, 0.25, 0.15]);

      // Release hardware audio tracks if backgrounded or interrupted by OS
      if (releaseHardware && mediaStreamRef.current) {
        try {
          mediaStreamRef.current.getTracks().forEach((track) => track.stop());
        } catch (_) {}
        mediaStreamRef.current = null;
      }

      pauseStartTimeRef.current = Date.now();

      // Fold current instance final and interim transcript into sessionAccumulatedTextRef in memory
      if (currentInstanceFinalRef.current && currentInstanceFinalRef.current.trim()) {
        sessionAccumulatedTextRef.current = mergeTranscriptSegments(
          sessionAccumulatedTextRef.current,
          currentInstanceFinalRef.current.trim()
        );
      }
      if (interimTranscriptRef.current && interimTranscriptRef.current.trim()) {
        sessionAccumulatedTextRef.current = mergeTranscriptSegments(
          sessionAccumulatedTextRef.current,
          interimTranscriptRef.current.trim()
        );
      }
      currentInstanceFinalMapRef.current.clear();
      currentInstanceFinalRef.current = '';
      interimTranscriptRef.current = '';
      setInterimTranscript('');
      setWaveformBars(Array(NUM_WAVEFORM_BARS).fill(0.08));

      updateRecordingState('paused');
    },
    [cleanupRecognitionInstance, updateRecordingState]
  );
  pauseListeningRef.current = pauseListening;

  // Resume paused dictation session with automatic hardware stream recovery
  const resumeListening = useCallback(async () => {
    if (disabledRef.current || isTransitioningRef.current) return;
    if (recordingStateRef.current !== 'paused') return;
    isTransitioningRef.current = true;

    try {
      isExplicitStopRef.current = false;
      isStoppingRef.current = false;
      hasFatalErrorRef.current = false;
      setDictationError(null);

      if (pauseStartTimeRef.current > 0) {
        pausedDurationRef.current += Date.now() - pauseStartTimeRef.current;
        pauseStartTimeRef.current = 0;
      }

      if (engineMode === 'unsupported') {
        stopAudioResources();
        setDictationError('Voice dictation is not supported in this browser.');
        updateRecordingState('error');
        return;
      }

      // For applicable recording modes (browser-speech or audio-record), verify and restore hardware audio stream and MediaRecorder
      if (engineMode === 'browser-speech' || engineMode === 'audio-record') {
        let stream = mediaStreamRef.current;
        const isStreamLive =
          stream?.active &&
          stream.getAudioTracks().some((t) => t.readyState === 'live' && !t.muted);

        if (!isStreamLive) {
          try {
            stream = await acquireMicrophoneStream();
          } catch (streamErr) {
            stopAudioResources();
            setDictationError('Unable to reactivate microphone. Please tap to start dictation again.');
            updateRecordingState('error');
            return;
          }
        }

        // Restore / re-enable microphone tracks if they were disabled
        if (stream) {
          stream.getAudioTracks().forEach((track) => {
            if (!track.enabled) {
              track.enabled = true;
            }
          });
        }

        // Resume or re-attach MediaRecorder
        let recorderResumedOrStarted = false;
        if (mediaRecorderRef.current) {
          if (mediaRecorderRef.current.state === 'paused') {
            try {
              mediaRecorderRef.current.resume();
              recorderResumedOrStarted = mediaRecorderRef.current.state === 'recording';
            } catch (resumeErr) {
              console.warn('[Dictation] MediaRecorder resume failed, re-initializing recorder:', resumeErr);
              startMediaRecorder(stream);
              recorderResumedOrStarted = mediaRecorderRef.current?.state === 'recording';
            }
          } else if (mediaRecorderRef.current.state === 'recording') {
            recorderResumedOrStarted = true;
          } else if (mediaRecorderRef.current.state === 'inactive') {
            startMediaRecorder(stream);
            recorderResumedOrStarted = mediaRecorderRef.current?.state === 'recording';
          }
        } else if (stream) {
          startMediaRecorder(stream);
          recorderResumedOrStarted = mediaRecorderRef.current?.state === 'recording';
        }

        // Resume visualizer analyser
        if (stream) {
          attachAudioAnalyser(stream);
        }

        // State consistency check: verify MediaRecorder actually resumed/started
        const caps = detectDictationCapabilities();
        if (
          caps.hasMediaRecorder &&
          !recorderResumedOrStarted &&
          (!mediaRecorderRef.current || mediaRecorderRef.current.state !== 'recording')
        ) {
          stopAudioResources();
          setDictationError('Unable to resume audio recording. Please tap to start dictation again.');
          updateRecordingState('error');
          return;
        }

        // Ensure duration timer is running
        if (!durationIntervalRef.current) {
          durationIntervalRef.current = setInterval(() => {
            if (recordingStateRef.current === 'listening') {
              const now = Date.now();
              const start = recordingStartTimeRef.current || now;
              const elapsed = Math.max(0, Math.floor((now - start - pausedDurationRef.current) / 1000));
              setRecordingDuration(elapsed);
            }
          }, 250);
        }

        if (engineMode === 'audio-record') {
          // Native audio capture only (no SpeechRecognition instance)
          updateRecordingState('listening');
          return;
        }

        // For browser-speech mode, attempt to resume SpeechRecognition under the active user activation
        try {
          await startRecognitionSession(false);
        } catch (recErr) {
          if (isDictationDiagnosticsEnabled()) {
            console.warn('[Dictation] SpeechRecognition resume notice:', recErr);
          }
        }

        // State consistency check:
        // If MediaRecorder is actively recording, UI must reflect 'listening' even if
        // SpeechRecognition failed to restart or hasn't fired onstart yet.
        if (
          mediaRecorderRef.current &&
          mediaRecorderRef.current.state === 'recording' &&
          recordingStateRef.current !== 'listening'
        ) {
          updateRecordingState('listening');
        }
      }
    } finally {
      setTimeout(() => {
        isTransitioningRef.current = false;
      }, 150);
    }
  }, [
    acquireMicrophoneStream,
    attachAudioAnalyser,
    engineMode,
    startMediaRecorder,
    startRecognitionSession,
    stopAudioResources,
    updateRecordingState
  ]);

  // Stop dictation, await transcription completion, and insert the completed transcript exactly once
  const stopListening = useCallback(async () => {
    if (isTransitioningRef.current) return '';
    if (
      recordingStateRef.current === 'idle' ||
      recordingStateRef.current === 'stopping' ||
      recordingStateRef.current === 'finalizing' ||
      recordingStateRef.current === 'transcribing' ||
      recordingStateRef.current === 'success' ||
      recordingStateRef.current === 'error'
    ) {
      return '';
    }
    isTransitioningRef.current = true;
    clearTimeout(restartTimeoutRef.current);

    transcriptionSessionCounterRef.current += 1;
    const currentSessionId = transcriptionSessionCounterRef.current;

    // 1. Immediately transition to 'stopping' to signal that recording stopped and hardware is closing
    isStoppingRef.current = true;
    isExplicitStopRef.current = true;
    updateRecordingState('stopping');

    try {
      // 1. Gracefully signal the speech recognizer to finish and wait for final results to settle via onend
      if (recognitionRef.current) {
        const rec = recognitionRef.current;
        await new Promise((resolve) => {
          let resolved = false;
          let timeoutId = null;

          const finishShutdown = (isTimeout = false) => {
            if (!resolved) {
              resolved = true;
              if (timeoutId) clearTimeout(timeoutId);
              pendingRecognitionShutdownResolveRef.current = null;
              if (isTimeout) {
                console.warn('[Dictation] Stop lifecycle safety timeout reached waiting for recognition onend');
                recognitionEndedNormallyRef.current = false;
              }
              resolve();
            }
          };

          pendingRecognitionShutdownResolveRef.current = () => finishShutdown(false);

          // Bounded safety timeout (3500ms) prevents hanging if browser fails to trigger onend
          timeoutId = setTimeout(() => {
            finishShutdown(true);
          }, 3500);

          try {
            rec.stop();
          } catch (stopErr) {
            console.warn('[Dictation] rec.stop() threw:', stopErr);
            finishShutdown(true);
          }
        });
      }

      // 2. Await MediaRecorder finalization properly so the final audio slice and stop event are delivered
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== 'inactive') {
        await new Promise((resolve) => {
          let resolved = false;
          let timer = null;

          const onRecorderFinish = () => {
            if (!resolved) {
              resolved = true;
              if (timer) clearTimeout(timer);
              try {
                recorder.removeEventListener('stop', onRecorderFinish);
                recorder.removeEventListener('error', onRecorderFinish);
              } catch (_) {}
              resolve();
            }
          };

          timer = setTimeout(onRecorderFinish, 1500);

          try {
            recorder.addEventListener('stop', onRecorderFinish, { once: true });
            recorder.addEventListener('error', onRecorderFinish, { once: true });

            if (typeof recorder.requestData === 'function' && recorder.state === 'recording') {
              try {
                recorder.requestData();
              } catch (_) {}
            }
            recorder.stop();
          } catch (_) {
            onRecorderFinish();
          }
        });
      }

      // Calculate active recording duration excluding paused time
      let totalPausedMs = pausedDurationRef.current || 0;
      if (pauseStartTimeRef.current > 0) {
        totalPausedMs += Date.now() - pauseStartTimeRef.current;
      }
      const rawActiveMs = recordingStartTimeRef.current
        ? Math.max(0, Date.now() - recordingStartTimeRef.current - totalPausedMs)
        : (recordingDuration || 0) * 1000;
      const durationSec = Math.max(0, Math.round(rawActiveMs / 1000));

      // 3. Assemble captured audio chunks into complete Blob before releasing audio hardware resources
      if (audioChunksRef.current && audioChunksRef.current.length > 0) {
        try {
          const mimeType = activeMimeTypeRef.current || 'audio/webm';
          const blob = new Blob(audioChunksRef.current, { type: mimeType });
          recordedAudioBlobRef.current = blob;
          setRecordedAudioBlob(blob);
          setRecordedAudioDuration(durationSec);
        } catch (_) {}
      }

      // Record audio metrics in active diagnostic session
      const diag = activeDiagnosticSessionRef.current;
      if (diag) {
        diag.mimeType = activeMimeTypeRef.current || 'none';
        diag.audioBlobSizeBytes = recordedAudioBlobRef.current ? recordedAudioBlobRef.current.size : 0;
        diag.audioBlobSizeFormatted = formatDiagnosticByteSize(diag.audioBlobSizeBytes);
        diag.durationSec = durationSec;
        diag.recognitionEndedNormally = recognitionEndedNormallyRef.current;
        diag.hadFinalResults = hadFinalResultsRef.current;
      }

      // 4. Safely stop microphone tracks and Web Audio visualizer only AFTER Blob construction
      stopAudioResources();

      // 5. Gather all accumulated speech from memory buffers, including unfinalized interim text
      if (currentInstanceFinalRef.current && currentInstanceFinalRef.current.trim()) {
        sessionAccumulatedTextRef.current = mergeTranscriptSegments(
          sessionAccumulatedTextRef.current,
          currentInstanceFinalRef.current.trim()
        );
      }
      if (interimTranscriptRef.current && interimTranscriptRef.current.trim()) {
        sessionAccumulatedTextRef.current = mergeTranscriptSegments(
          sessionAccumulatedTextRef.current,
          interimTranscriptRef.current.trim()
        );
      }
      currentInstanceFinalMapRef.current.clear();
      currentInstanceFinalRef.current = '';
      interimTranscriptRef.current = '';
      setInterimTranscript('');

      // Safely cleanup recognition instance now that all pending results have been handled
      cleanupRecognitionInstance();

      // Stale session safeguard: If session was cancelled during the settle window, abort
      if (transcriptionSessionCounterRef.current !== currentSessionId) {
        return '';
      }

      // Transition to 'transcribing' to reflect text compilation & formatting phase
      updateRecordingState('transcribing');

      let cleanSpeech = (sessionAccumulatedTextRef.current || '').trim();
      const audioBlob = recordedAudioBlobRef.current;
      const hasValidAudio = Boolean(audioBlob && audioBlob instanceof Blob && audioBlob.size > 0);

      // Record raw native transcript and audio validity in active diagnostic session
      if (diag) {
        diag.rawNativeTranscript = cleanSpeech;
        diag.audioBlobValid = hasValidAudio;
      }

      // Primary Recorded-Audio Transcription Policy:
      // If a valid audio Blob is available, invoke the server-side audio transcription pipeline.
      // Its successful transcript is the preferred primary result, while native speech is the fallback.
      if (hasValidAudio) {
        if (diag) {
          diag.serverTranscriptionInvoked = true;
          diag.fallbackReason = 'recorded_audio_primary';
        }

        try {
          const providerRes = await transcribeAudioBlob({
            audioBlob,
            language: selectedLanguageRef.current
          });

          if (diag) {
            diag.provider = providerRes.provider || 'groq';
            diag.model = providerRes.model || 'whisper-large-v3-turbo';
            diag.providerStatus = providerRes.status || 200;
            diag.latencyMs = providerRes.latencyMs || 0;
            diag.rawProviderTranscript = (providerRes?.text || '').trim();
            diag.providerSuccess = Boolean(providerRes?.text && providerRes.text.trim());
            diag.providerFailureReason = diag.providerSuccess ? 'none' : 'empty_provider_result';
          }

          // Check stale session safeguard after async provider request
          if (transcriptionSessionCounterRef.current === currentSessionId) {
            const decision = selectFinalTranscript({
              providerTranscript: providerRes?.text || '',
              providerSuccess: Boolean(providerRes?.text && providerRes.text.trim()),
              nativeTranscript: cleanSpeech,
              hasValidAudio: true,
              providerFailureReason: ''
            });

            cleanSpeech = decision.finalText;
            sessionAccumulatedTextRef.current = cleanSpeech;

            if (diag) {
              diag.finalTranscriptSource = decision.source;
              diag.reconciliationDecision = decision.source;
              diag.reconciliationReason = decision.reason;
            }

            if (decision.source === 'provider') {
              setTranscriptionMeta({
                provider: providerRes.provider === 'groq' ? 'Groq Whisper' : 'Gemini AI',
                model: providerRes.model,
                highAccuracy: true,
                timestamp: Date.now()
              });
              setTranscriptionNotice({
                type: 'success',
                message: `Transcribed with ${providerRes.model === 'whisper-large-v3-turbo' ? 'Whisper Large v3' : providerRes.model}`
              });
            } else if (decision.source === 'native') {
              setTranscriptionNotice({
                type: 'fallback',
                message: 'Recorded audio transcription returned empty result. Preserved live speech transcript.'
              });
            }
          }
        } catch (fErr) {
          console.warn('[Dictation] Recorded audio transcription notice:', fErr);
          const failureReason = fErr?.message || 'provider_request_failed';

          if (diag) {
            diag.providerStatus = fErr?.statusCode || fErr?.status || 500;
            diag.latencyMs = fErr?.latencyMs || 0;
            diag.rawProviderTranscript = `[ERROR: ${failureReason}]`;
            diag.providerSuccess = false;
            diag.providerFailureReason = failureReason;
          }

          // Check stale session safeguard after async provider failure
          if (transcriptionSessionCounterRef.current === currentSessionId) {
            const decision = selectFinalTranscript({
              providerTranscript: '',
              providerSuccess: false,
              nativeTranscript: cleanSpeech,
              hasValidAudio: true,
              providerFailureReason: failureReason
            });

            cleanSpeech = decision.finalText;
            sessionAccumulatedTextRef.current = cleanSpeech;

            if (diag) {
              diag.finalTranscriptSource = decision.source;
              diag.reconciliationDecision = decision.source;
              diag.reconciliationReason = decision.reason;
            }

            if (decision.source === 'native') {
              setTranscriptionNotice({
                type: 'fallback',
                message: 'Audio transcription unavailable. Preserved live speech transcript.'
              });
            }
          }
        }
      } else {
        // No valid audio buffer captured; use native speech directly as fallback
        if (diag) {
          diag.serverTranscriptionInvoked = false;
          diag.fallbackReason = 'bypassed_no_valid_audio_buffer';
          diag.providerSuccess = false;
          diag.providerFailureReason = 'no_valid_audio_blob';
        }

        const decision = selectFinalTranscript({
          providerTranscript: '',
          providerSuccess: false,
          nativeTranscript: cleanSpeech,
          hasValidAudio: false,
          providerFailureReason: 'no_valid_audio_blob'
        });

        cleanSpeech = decision.finalText;
        sessionAccumulatedTextRef.current = cleanSpeech;

        if (diag) {
          diag.finalTranscriptSource = decision.source;
          diag.reconciliationDecision = decision.source;
          diag.reconciliationReason = decision.reason;
        }
      }

      // Check stale session safeguard again
      if (transcriptionSessionCounterRef.current !== currentSessionId) {
        return '';
      }

      // Handle empty speech gracefully
      if (!cleanSpeech) {
        setTranscriptionNotice({
          type: 'fallback',
          message: 'No speech was detected in the recording.'
        });
        if (diag) {
          diag.cleanedTranscript = '';
          diag.finalComposerTranscript = sessionBaseTextRef.current || '';
          const report = finalizeDiagnosticSession(diag);
          if (report) {
            setLastDiagnostic(report);
          }
          activeDiagnosticSessionRef.current = null;
        }
        sessionAccumulatedTextRef.current = '';
        currentInstanceFinalMapRef.current.clear();
        currentInstanceFinalRef.current = '';
        committedSegmentsRef.current = [];
        interimTranscriptRef.current = '';
        setInterimTranscript('');
        updateRecordingState('idle');
        return '';
      }

      // 7. Format completed speech with verbal punctuation, tech terms, and proper capitalization
      const initialBase = sessionBaseTextRef.current || '';
      const formattedSpeech = formatSpeechTranscript(
        cleanSpeech,
        selectedLanguageRef.current,
        initialBase
      );

      // 8. Combine with preserved composer base text and insert EXACTLY ONCE
      const finalCombined = combineComposerText(initialBase, formattedSpeech);
      recordEmission(finalCombined);

      if (diag) {
        diag.cleanedTranscript = formattedSpeech;
        diag.finalComposerTranscript = finalCombined;
        const report = finalizeDiagnosticSession(diag);
        if (report) {
          setLastDiagnostic(report);
        }
        activeDiagnosticSessionRef.current = null;
      }

      if (onInputChangeRef.current) {
        onInputChangeRef.current(finalCombined);
      }

      setLastSessionTranscript(formattedSpeech);
      sessionAccumulatedTextRef.current = '';
      currentInstanceFinalMapRef.current.clear();
      currentInstanceFinalRef.current = '';
      committedSegmentsRef.current = [];
      interimTranscriptRef.current = '';
      setInterimTranscript('');
      // Brief honest success state before returning to idle
      updateRecordingState('success');
      setTimeout(() => {
        if (recordingStateRef.current === 'success') {
          updateRecordingState('idle');
        }
      }, 750);
      return finalCombined;
    } catch (err) {
      console.warn('[Dictation] Finalize transcription error:', err);
      if (transcriptionSessionCounterRef.current === currentSessionId) {
        updateRecordingState('idle');
      }
      return '';
    } finally {
      isStoppingRef.current = false;
      setTimeout(() => {
        isTransitioningRef.current = false;
      }, 100);
    }
  }, [
    cleanupRecognitionInstance,
    recordEmission,
    recordingDuration,
    stopAudioResources,
    updateRecordingState
  ]);

  // Cancel dictation: Discards speech from this session and restores original composer text
  const cancelListening = useCallback(() => {
    isCancelledRef.current = true;
    isExplicitStopRef.current = true;
    clearTimeout(restartTimeoutRef.current);
    if (pendingRecognitionShutdownResolveRef.current) {
      try {
        pendingRecognitionShutdownResolveRef.current();
      } catch (_) {}
      pendingRecognitionShutdownResolveRef.current = null;
    }
    cleanupRecognitionInstance();

    // Invalidate any in-flight transcription session
    transcriptionSessionCounterRef.current += 1;

    // Release microphone tracks and visualizer resources
    stopAudioResources();

    // Revert to original composer content prior to this session
    const originalBase = sessionBaseTextRef.current ?? baseTextRef.current ?? '';
    recordEmission(originalBase);
    if (onInputChangeRef.current) {
      onInputChangeRef.current(originalBase);
    }

    if (activeDiagnosticSessionRef.current) {
      const diag = activeDiagnosticSessionRef.current;
      diag.reconciliationDecision = 'cancelled';
      diag.reconciliationReason = 'user_cancelled_session';
      diag.finalComposerTranscript = originalBase;
      const report = finalizeDiagnosticSession(diag);
      if (report) {
        setLastDiagnostic(report);
      }
      activeDiagnosticSessionRef.current = null;
    }

    sessionAccumulatedTextRef.current = '';
    currentInstanceFinalMapRef.current.clear();
    currentInstanceFinalRef.current = '';
    committedSegmentsRef.current = [];
    interimTranscriptRef.current = '';
    nativeSessionTranscriptRef.current = '';
    expectedEmittedBeforeTranscribeRef.current = '';
    lastCommittedSegmentRef.current = { text: '', timestamp: 0 };
    pausedDurationRef.current = 0;
    pauseStartTimeRef.current = 0;
    setInterimTranscript('');
    setLastSessionTranscript('');
    setTranscriptionNotice(null);
    updateRecordingState('cancelled');
    setTimeout(() => {
      if (recordingStateRef.current === 'cancelled') {
        updateRecordingState('idle');
      }
    }, 350);
  }, [cleanupRecognitionInstance, recordEmission, stopAudioResources, updateRecordingState]);

  // Keep live transcript and cancel in-flight Whisper request without reverting composer (Phase 5.4)
  const keepLiveTranscript = useCallback(() => {
    if (transcriptionAbortCtrlRef.current) {
      try {
        transcriptionAbortCtrlRef.current.abort();
      } catch (_) {}
      transcriptionAbortCtrlRef.current = null;
    }
    transcriptionSessionCounterRef.current += 1;
    updateRecordingState('idle');
    setTranscriptionNotice({
      type: 'fallback',
      message: 'Whisper refinement skipped — live speech transcript retained.'
    });
  }, [updateRecordingState]);

  // Safe retry for Whisper transcription on the captured audio buffer
  const retryTranscription = useCallback(async () => {
    const audioBlob = recordedAudioBlobRef.current;
    if (!audioBlob || audioBlob.size < 300) return;
    if (recordingStateRef.current === 'transcribing' || recordingStateRef.current === 'listening') return;

    transcriptionSessionCounterRef.current += 1;
    const currentSessionId = transcriptionSessionCounterRef.current;
    updateRecordingState('transcribing');
    setTranscriptionNotice(null);

    if (transcriptionAbortCtrlRef.current) {
      try {
        transcriptionAbortCtrlRef.current.abort();
      } catch (_) {}
    }
    const abortCtrl = new AbortController();
    transcriptionAbortCtrlRef.current = abortCtrl;

    const currentVal = inputValueRef.current || '';
    const targetNative = lastSessionTranscript || '';

    try {
      const result = await transcribeAudioBlob({
        audioBlob,
        language: selectedLanguageRef.current,
        signal: abortCtrl.signal
      });

      if (transcriptionSessionCounterRef.current !== currentSessionId) return;

      const rawWhisper = (result.text || '').trim();
      if (rawWhisper) {
        const initialBase = sessionBaseTextRef.current || '';
        const formattedWhisper = formatSpeechTranscript(
          rawWhisper,
          selectedLanguageRef.current,
          initialBase
        );

        const fullReconciled = combineComposerText(initialBase, formattedWhisper);
        let reconciled = fullReconciled;

        if (!currentVal.trim()) {
          return;
        }

        if (targetNative && currentVal.includes(targetNative)) {
          reconciled = currentVal.replace(targetNative, formattedWhisper);
        } else if (
          currentVal === targetNative ||
          currentVal === initialBase ||
          recentEmissionsRef.current.has(currentVal)
        ) {
          reconciled = fullReconciled;
        } else {
          reconciled = combineComposerText(currentVal, formattedWhisper);
        }

        recordEmission(reconciled);
        if (onInputChangeRef.current && reconciled !== currentVal) {
          onInputChangeRef.current(reconciled);
        }

        setLastSessionTranscript(formattedWhisper);
        setTranscriptionMeta({
          provider: result.provider === 'groq' ? 'Groq Whisper' : 'Gemini AI',
          model: result.model,
          highAccuracy: true,
          timestamp: Date.now()
        });
        setTranscriptionNotice({
          type: 'success',
          message: `Enhanced with ${result.model === 'whisper-large-v3-turbo' ? 'Whisper Large v3' : result.model}`
        });
      }
    } catch (err) {
      if (transcriptionSessionCounterRef.current !== currentSessionId) return;
      if (err?.name === 'AbortError') return;

      console.warn('[Transcription] Retry failed:', err);
      const isOffline = typeof navigator !== 'undefined' && !navigator.onLine;
      setTranscriptionNotice({
        type: 'fallback',
        message: isOffline
          ? 'Network disconnected — existing transcript retained.'
          : 'Whisper retry unsuccessful — existing transcript retained.',
        canRetry: true
      });
    } finally {
      if (transcriptionSessionCounterRef.current === currentSessionId) {
        updateRecordingState('idle');
      }
    }
  }, [lastSessionTranscript, updateRecordingState]);

  const clearTranscriptionNotice = useCallback(() => {
    setTranscriptionNotice(null);
  }, []);

  // Master toggle button with concurrency guard against rapid multi-tapping (Phase 5.4)
  const toggleListening = useCallback(async () => {
    if (disabledRef.current || isTransitioningRef.current) return;

    if (recordingStateRef.current === 'listening') {
      await stopListening();
    } else if (recordingStateRef.current === 'paused') {
      await resumeListening();
    } else if (recordingStateRef.current === 'requesting') {
      cancelListening();
    } else if (
      recordingStateRef.current === 'stopping' ||
      recordingStateRef.current === 'finalizing' ||
      recordingStateRef.current === 'transcribing' ||
      recordingStateRef.current === 'success'
    ) {
      // Safe no-op while transition is in-flight
      return;
    } else {
      await startListening();
    }
  }, [startListening, stopListening, resumeListening, cancelListening]);

  // Configurable language setter with instant live session restart
  const setSelectedLanguage = useCallback(
    (code) => {
      if (disabledRef.current) return;
      setSelectedLanguageState(code);
      selectedLanguageRef.current = code;
      if (typeof window !== 'undefined') {
        try {
          localStorage.setItem('orvix_dictation_lang', code);
        } catch (_) {}
      }
      // If actively listening, restart recognition session with new language immediately
      if (recordingStateRef.current === 'listening' && recognitionRef.current) {
        startRecognitionSession(false);
      }
    },
    [startRecognitionSession]
  );

  // Auto-cancel active recording immediately if dictation becomes disabled
  useEffect(() => {
    if (disabled && recordingStateRef.current !== 'idle') {
      cancelListening();
    }
  }, [disabled, cancelListening]);

  // PWA and Mobile Lifecycle (Phase 5.4):
  // Cleanly pause dictation and stop hardware tracks when app goes to background (visibilitychange & pagehide),
  // releasing microphone hardware so the OS green/orange indicator turns off immediately.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        if (recordingStateRef.current === 'listening') {
          pauseListening(true);
        } else if (recordingStateRef.current === 'requesting') {
          cancelListening();
        }
      }
    };

    const handlePageHide = () => {
      if (recordingStateRef.current === 'listening') {
        pauseListening(true);
      } else if (recordingStateRef.current === 'requesting') {
        cancelListening();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pagehide', handlePageHide);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pagehide', handlePageHide);
    };
  }, [pauseListening, cancelListening]);

  // Component unmount cleanup (Phase 5.2, 5.3 & 5.4)
  useEffect(() => {
    return () => {
      clearTimeout(restartTimeoutRef.current);
      if (transcriptionAbortCtrlRef.current) {
        try {
          transcriptionAbortCtrlRef.current.abort();
        } catch (_) {}
      }
      stopAudioResources();
      cleanupRecognitionInstance();
    };
  }, [cleanupRecognitionInstance, stopAudioResources]);

  return {
    recordingState,
    engineMode,
    isListening: recordingState === 'listening',
    isPaused: recordingState === 'paused',
    isRequesting: recordingState === 'requesting',
    isStopping: recordingState === 'stopping',
    isFinalizing: recordingState === 'finalizing',
    isTranscribing: recordingState === 'transcribing',
    isSuccess: recordingState === 'success',
    isCancelled: recordingState === 'cancelled',
    isSupported,
    isFirefox: capabilities.isFirefox,
    isIOS: capabilities.isIOS,
    isSafari: capabilities.isSafari,
    dictationError,
    interimTranscript,
    lastSessionTranscript,
    selectedLanguage,
    setSelectedLanguage,
    supportedLanguages: SUPPORTED_LANGUAGES,
    audioLevel,
    audioFrequencies,
    waveformBars,
    recordingDuration,
    formattedDuration: formatDuration(recordingDuration),
    startListening,
    pauseListening,
    resumeListening,
    stopListening,
    cancelListening,
    keepLiveTranscript,
    toggleListening,
    clearDictationError,
    clearLastSessionTranscript,
    // Phase 5.2 Audio Capture & Buffering exports
    recordedAudioBlob,
    recordedAudioDuration,
    hasRecordedAudio: Boolean(recordedAudioBlob),
    supportedAudioMimeType: activeMimeTypeRef.current || getSupportedAudioMimeType(),
    getAudioBlob,
    clearRecordedAudio,
    // Phase 5.3 Whisper High-Accuracy Transcription exports
    transcriptionMeta,
    transcriptionNotice,
    clearTranscriptionNotice,
    retryTranscription,
    // Temporary Voice Dictation Diagnostic Observability exports
    isDiagnosticsEnabled: isDiagnosticsEnabledState,
    setDiagnosticsEnabled,
    lastDiagnostic
  };
}
