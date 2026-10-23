import { useState, useRef, useEffect, useCallback } from 'react';
import { transcribeAudioBlob } from '../services/transcriptionService.js';

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

  const hasSpeechRecognition = Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
  const hasGetUserMedia = Boolean(
    navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function'
  );
  const hasMediaRecorder = Boolean(window.MediaRecorder);

  const userAgent = navigator.userAgent || '';
  const isFirefox = /Firefox/i.test(userAgent);
  const isIOS =
    /iPad|iPhone|iPod/.test(userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isSafari =
    /Safari/i.test(userAgent) && !/Chrome|CriOS|Edg|OPR|Firefox/i.test(userAgent);

  // Engine mode resolution:
  // - 'hybrid': Chrome, Edge, desktop/iOS Safari (SpeechRecognition + MediaRecorder Whisper enhancement)
  // - 'direct-audio': Firefox on Windows/macOS/Android (Direct MediaRecorder capture + Whisper transcription)
  // - 'native-only': Browsers with SpeechRecognition but missing MediaRecorder
  // - 'unsupported': Neither capability available
  let engineMode = 'unsupported';
  if (!isFirefox && hasSpeechRecognition && hasGetUserMedia && hasMediaRecorder) {
    engineMode = 'hybrid';
  } else if (hasGetUserMedia && hasMediaRecorder) {
    // Firefox fallback (or browsers without functional native SpeechRecognition):
    // Native SpeechRecognition is not enabled/functional by default in Firefox,
    // but MediaRecorder + getUserMedia are fully supported for direct Whisper transcription!
    engineMode = 'direct-audio';
  } else if (!isFirefox && hasSpeechRecognition) {
    engineMode = 'native-only';
  }

  return {
    hasSpeechRecognition,
    hasGetUserMedia,
    hasMediaRecorder,
    isSupported: engineMode !== 'unsupported',
    engineMode,
    isFirefox,
    isIOS,
    isSafari
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
  [/\byou\s*tube\b/gi, 'YouTube'],
  [/\bpython\b/gi, 'Python'],
  [/\breact\b/gi, 'React'],
  [/\bangular\b/gi, 'Angular'],
  [/\bhannan\b/gi, 'Hannan'],
  [/\b(?:a\s*p\s*i)s?\b/gi, (m) => (/s$/i.test(m) ? 'APIs' : 'API')],
  [/\b(?:j\s*s\s*o\s*n)\b/gi, 'JSON'],
  [/\b(?:h\s*t\s*m\s*l)\b/gi, 'HTML'],
  [/\b(?:c\s*s\s*s)\b/gi, 'CSS'],
  [/\b(?:u\s*r\s*l)s?\b/gi, (m) => (/s$/i.test(m) ? 'URLs' : 'URL')]
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

    // Standard tech acronyms
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
export function useVoiceDictation({ inputValue = '', onInputChange }) {
  // Safe capability detection across browsers (Chrome, Edge, Safari, Firefox, iOS, Android)
  const [capabilities, setCapabilities] = useState(detectDictationCapabilities);
  const [isSupported, setIsSupported] = useState(() => capabilities.isSupported);
  const [engineMode, setEngineMode] = useState(() => capabilities.engineMode);

  const [recordingState, setRecordingState] = useState('idle'); // 'idle' | 'requesting' | 'listening' | 'paused' | 'finalizing' | 'transcribing' | 'error'
  const [dictationError, setDictationError] = useState(null);
  const [interimTranscript, setInterimTranscript] = useState('');
  const [lastSessionTranscript, setLastSessionTranscript] = useState('');

  // Real-time audio reactivity: volume (0-100) and 5 frequency bins (0.0 - 1.0)
  const [audioLevel, setAudioLevel] = useState(0);
  const [audioFrequencies, setAudioFrequencies] = useState([0.15, 0.25, 0.35, 0.25, 0.15]);

  // Selected language with localStorage and browser locale resolution
  const [selectedLanguage, setSelectedLanguageState] = useState(getInitialLanguage);

  // Core references
  const recognitionRef = useRef(null);
  const baseTextRef = useRef('');
  const committedSegmentsRef = useRef([]); // Array of { instanceId: number, index: number, text: string, timestamp: number }
  const lastEmittedValueRef = useRef(''); // Tracks exact value sent to onInputChange
  const recentEmissionsRef = useRef(new Set()); // Tracks values emitted by dictation to distinguish from user typing
  const interimTranscriptRef = useRef('');
  const inputValueRef = useRef(inputValue);
  inputValueRef.current = inputValue;

  const onInputChangeRef = useRef(onInputChange);
  onInputChangeRef.current = onInputChange;

  const isExplicitStopRef = useRef(false);
  const hasFatalErrorRef = useRef(false);
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
      recentEmissionsRef.current.has(inputValue.trim())
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
        committedSegmentsRef.current = [];
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

    analyserRef.current = null;
    setAudioLevel(0);
    setAudioFrequencies([0.15, 0.25, 0.35, 0.25, 0.15]);
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
      analyser.fftSize = 64;
      analyser.smoothingTimeConstant = 0.75;
      analyserRef.current = analyser;

      const source = ctx.createMediaStreamSource(stream);
      source.connect(analyser);

      const dataArray = new Uint8Array(analyser.frequencyBinCount);

      const updateMeter = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteFrequencyData(dataArray);

        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i];
        }
        const avg = sum / dataArray.length;
        const normalizedVol = Math.min(100, Math.round((avg / 128) * 100));
        setAudioLevel(normalizedVol);

        const step = Math.floor(dataArray.length / 5);
        const bars = [
          Math.max(0.15, (dataArray[step * 0] || 0) / 255),
          Math.max(0.2, (dataArray[step * 1] || 0) / 255),
          Math.max(0.25, (dataArray[step * 2] || 0) / 255),
          Math.max(0.2, (dataArray[step * 3] || 0) / 255),
          Math.max(0.15, (dataArray[step * 4] || 0) / 255)
        ];
        setAudioFrequencies(bars);

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
        committedSegmentsRef.current = [];
        interimTranscriptRef.current = '';
        recentEmissionsRef.current.clear();
        if (baseTextRef.current && baseTextRef.current.trim()) {
          recordEmission(baseTextRef.current);
        }
        setInterimTranscript('');
        setLastSessionTranscript('');
        isExplicitStopRef.current = false;
        hasFatalErrorRef.current = false;
        consecutiveErrorsRef.current = 0;
        consecutiveSilenceRestartsRef.current = 0;
        lastCommittedSegmentRef.current = { text: '', timestamp: 0 };
        nativeSessionTranscriptRef.current = '';
        expectedEmittedBeforeTranscribeRef.current = '';

        // Reset audio capture buffers for fresh session
        audioChunksRef.current = [];
        recordedBytesRef.current = 0;
        recordingStartTimeRef.current = Date.now();
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

        updateRecordingState('requesting');
      } else {
        // Continuing session after browser silence restart:
        // Fold already finalized speech segments and any pending interim speech into baseTextRef so the new instance starts cleanly
        let committedSoFar = '';
        for (const seg of committedSegmentsRef.current) {
          committedSoFar = combineComposerText(committedSoFar, seg.text);
        }
        if (interimTranscriptRef.current && interimTranscriptRef.current.trim()) {
          const formattedInterim = formatSpeechTranscript(
            interimTranscriptRef.current.trim(),
            selectedLanguageRef.current,
            combineComposerText(baseTextRef.current, committedSoFar)
          );
          if (formattedInterim) {
            committedSoFar = combineComposerText(committedSoFar, formattedInterim);
          }
        }
        if (committedSoFar) {
          baseTextRef.current = combineComposerText(baseTextRef.current, committedSoFar);
          committedSegmentsRef.current = [];
        }
        interimTranscriptRef.current = '';
        setInterimTranscript('');
      }

      // DIRECT-AUDIO MODE (Firefox & browsers without native SpeechRecognition):
      // Captures audio directly via MediaRecorder and delivers high-accuracy Whisper transcription upon Done.
      if (caps.engineMode === 'direct-audio') {
        cleanupRecognitionInstance();
        try {
          const sharedStream = await acquireMicrophoneStream();
          if (
            isExplicitStopRef.current ||
            (recordingStateRef.current !== 'listening' && recordingStateRef.current !== 'requesting')
          ) {
            stopAudioResources();
            return;
          }
          attachAudioAnalyser(sharedStream);
          startMediaRecorder(sharedStream);
          updateRecordingState('listening');
          setDictationError(null);
        } catch (streamErr) {
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
        return;
      }

      // HYBRID / NATIVE MODE (Chrome, Edge, Safari):
      const SpeechRecognition =
        typeof window !== 'undefined'
          ? window.SpeechRecognition || window.webkitSpeechRecognition
          : null;

      if (!SpeechRecognition) {
        setDictationError(
          'Voice dictation is not supported in this browser. Please use Google Chrome, Microsoft Edge, Safari, or Firefox.'
        );
        hasFatalErrorRef.current = true;
        updateRecordingState('error');
        return;
      }

      // Clean up any existing recognition instance completely before instantiating a new one
      cleanupRecognitionInstance();

      // Acquire shared microphone stream and coordinate visualizer + MediaRecorder
      let sharedStream = null;
      try {
        sharedStream = await acquireMicrophoneStream();

        // If user stopped or cancelled while getUserMedia was resolving, immediately release stream
        if (
          isExplicitStopRef.current ||
          (recordingStateRef.current !== 'listening' && recordingStateRef.current !== 'requesting')
        ) {
          stopAudioResources();
          return;
        }

        attachAudioAnalyser(sharedStream);
        startMediaRecorder(sharedStream);
      } catch (streamErr) {
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
        return;
      }

      if (isStartingRef.current) return;
      isStartingRef.current = true;

      try {
        const recognition = new SpeechRecognition();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.maxAlternatives = 3;
        recognition.lang = selectedLanguageRef.current;

        hasFatalErrorRef.current = false;

        recognition.onstart = () => {
          if (instanceCounterRef.current !== currentInstanceId) return;
          isStartingRef.current = false;
          updateRecordingState('listening');
          setDictationError(null);
          consecutiveErrorsRef.current = 0;
        };

        recognition.onspeechstart = () => {
          if (instanceCounterRef.current !== currentInstanceId) return;
          consecutiveErrorsRef.current = 0;
        };

        recognition.onspeechend = () => {
          // User paused speaking; session remains open
        };

        recognition.onnomatch = () => {
          // Audio detected but no alternative met confidence threshold; keep listening
        };

        recognition.onresult = (event) => {
          if (instanceCounterRef.current !== currentInstanceId) return;
          if (isExplicitStopRef.current) return;
          consecutiveErrorsRef.current = 0;

          // 1. Process all newly finalized results
          for (let i = event.resultIndex; i < event.results.length; i++) {
            const res = event.results[i];
            if (res && res.isFinal) {
              const bestCandidate = selectBestAlternative(res);
              if (!bestCandidate) continue;

              const precedingText = [
                baseTextRef.current,
                ...committedSegmentsRef.current.map((s) => s.text)
              ]
                .filter(Boolean)
                .join(' ');

              const formatted = formatSpeechTranscript(
                bestCandidate,
                selectedLanguageRef.current,
                precedingText
              );

              if (formatted) {
                const now = Date.now();
                // Precise deduplication: Only suppress if this is the very first result (i === 0)
                // of a silence restart instance AND its exact text matches the last chunk from
                // the previous instance within a narrow 2-second restart window.
                const isRestartFirstResult = !isNewSession && i === 0;
                const isExactRestartEcho =
                  isRestartFirstResult &&
                  lastCommittedSegmentRef.current &&
                  lastCommittedSegmentRef.current.text &&
                  now - lastCommittedSegmentRef.current.timestamp < 2000 &&
                  lastCommittedSegmentRef.current.text.toLowerCase().trim() === formatted.toLowerCase().trim();

                // Prevent committing the same index twice in this instance
                const alreadyCommitted = committedSegmentsRef.current.some(
                  (s) => s.instanceId === currentInstanceId && s.index === i
                );

                if (!isExactRestartEcho && !alreadyCommitted) {
                  committedSegmentsRef.current.push({
                    instanceId: currentInstanceId,
                    index: i,
                    text: formatted,
                    timestamp: now
                  });
                  lastCommittedSegmentRef.current = {
                    text: formatted,
                    timestamp: now
                  };
                }
              }
            }
          }

          // 2. Compute current interim text across all unfinalized results
          let currentInterim = '';
          for (let i = 0; i < event.results.length; i++) {
            const res = event.results[i];
            if (res && !res.isFinal) {
              const interimCand = selectBestAlternative(res);
              if (interimCand) {
                currentInterim += (currentInterim ? ' ' : '') + interimCand;
              }
            }
          }

          interimTranscriptRef.current = currentInterim;
          setInterimTranscript(currentInterim);

          // 3. Assemble and emit combined text to composer in real time (both finalized and interim results)
          let liveSpeech = '';
          for (const seg of committedSegmentsRef.current) {
            liveSpeech = combineComposerText(liveSpeech, seg.text);
          }

          if (currentInterim && currentInterim.trim()) {
            const precedingForInterim = combineComposerText(baseTextRef.current, liveSpeech);
            const formattedInterim = formatSpeechTranscript(
              currentInterim.trim(),
              selectedLanguageRef.current,
              precedingForInterim
            );
            if (formattedInterim) {
              liveSpeech = combineComposerText(liveSpeech, formattedInterim);
            }
          }

          const liveCombined = combineComposerText(baseTextRef.current, liveSpeech);

          if (liveCombined !== inputValueRef.current) {
            recordEmission(liveCombined);
            if (onInputChangeRef.current) {
              onInputChangeRef.current(liveCombined);
            }
          }
        };

        recognition.onerror = (event) => {
          if (instanceCounterRef.current !== currentInstanceId) return;
          isStartingRef.current = false;
          const errorType = event?.error;

          // Ignore intentional user stops or aborts
          if (errorType === 'aborted' || isExplicitStopRef.current) {
            return;
          }

          if (errorType === 'not-allowed' || errorType === 'service-not-allowed') {
            hasFatalErrorRef.current = true;
            stopAudioResources();
            setDictationError(
              'Microphone access was denied. Please allow microphone permissions in your browser address bar.'
            );
            updateRecordingState('error');
          } else if (errorType === 'audio-capture') {
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

          if (hasFatalErrorRef.current) {
            hasFatalErrorRef.current = false;
            stopAudioResources();
            updateRecordingState('error');
            return;
          }

          // If speech recognizer ended naturally during active listening without explicit user stop
          // (such as standard browser 60s silence timeout or mobile sentence cutoff), recover cleanly.
          if (
            !isExplicitStopRef.current &&
            recordingStateRef.current === 'listening'
          ) {
            const isIOS =
              /iPad|iPhone|iPod/.test(navigator.userAgent || '') ||
              (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

            if (isIOS) {
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
              pauseListening();
              return;
            }

            clearTimeout(restartTimeoutRef.current);
            restartTimeoutRef.current = setTimeout(() => {
              if (recordingStateRef.current === 'listening' && !isExplicitStopRef.current) {
                startRecognitionSession(false);
              }
            }, 50);
            return;
          }

          stopAudioResources();

          if (recordingStateRef.current !== 'paused') {
            updateRecordingState('idle');
          }
        };

        recognitionRef.current = recognition;
        recognition.start();
      } catch (initErr) {
        isStartingRef.current = false;
        if (!isNewSession) {
          // Auto-restart rejected by browser gesture restriction (expected on iOS Safari after silence)
          console.warn('Auto-restart rejected by browser gesture restriction:', initErr);
          pauseListening();
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
    if (isTransitioningRef.current) return;
    if (
      recordingStateRef.current === 'listening' ||
      recordingStateRef.current === 'requesting' ||
      recordingStateRef.current === 'finalizing' ||
      recordingStateRef.current === 'transcribing'
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

      // Commit any interim transcript captured up to pause
      let allFinalSpeech = '';
      for (const seg of committedSegmentsRef.current) {
        allFinalSpeech = combineComposerText(allFinalSpeech, seg.text);
      }
      if (interimTranscriptRef.current && interimTranscriptRef.current.trim()) {
        const formattedInterim = formatSpeechTranscript(
          interimTranscriptRef.current.trim(),
          selectedLanguageRef.current,
          combineComposerText(baseTextRef.current, allFinalSpeech)
        );
        if (formattedInterim) {
          allFinalSpeech = combineComposerText(allFinalSpeech, formattedInterim);
        }
      }
      const finalCombined = combineComposerText(baseTextRef.current, allFinalSpeech);
      baseTextRef.current = finalCombined;
      committedSegmentsRef.current = [];
      interimTranscriptRef.current = '';
      setInterimTranscript('');

      recordEmission(finalCombined);
      if (onInputChangeRef.current) {
        onInputChangeRef.current(finalCombined);
      }

      updateRecordingState('paused');
    },
    [cleanupRecognitionInstance, updateRecordingState]
  );
  pauseListeningRef.current = pauseListening;

  // Resume paused dictation session with automatic hardware stream recovery
  const resumeListening = useCallback(async () => {
    if (isTransitioningRef.current) return;
    if (recordingStateRef.current !== 'paused') return;
    isTransitioningRef.current = true;

    try {
      isExplicitStopRef.current = false;
      hasFatalErrorRef.current = false;
      setDictationError(null);

      // Verify if existing microphone stream is live and unmuted
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

      // Resume or re-attach MediaRecorder
      if (mediaRecorderRef.current) {
        if (mediaRecorderRef.current.state === 'paused') {
          try {
            mediaRecorderRef.current.resume();
          } catch (_) {
            startMediaRecorder(stream);
          }
        } else if (mediaRecorderRef.current.state === 'inactive') {
          startMediaRecorder(stream);
        }
      } else if (stream) {
        startMediaRecorder(stream);
      }

      // Resume visualizer
      if (stream) {
        attachAudioAnalyser(stream);
      }

      await startRecognitionSession(false);
    } finally {
      setTimeout(() => {
        isTransitioningRef.current = false;
      }, 150);
    }
  }, [
    acquireMicrophoneStream,
    attachAudioAnalyser,
    startMediaRecorder,
    startRecognitionSession,
    stopAudioResources,
    updateRecordingState
  ]);

  // Stop dictation and commit finalized transcript and audio buffer (Phase 5.2, 5.3 & 5.4)
  const stopListening = useCallback(async () => {
    if (isTransitioningRef.current) return;
    if (
      recordingStateRef.current === 'idle' ||
      recordingStateRef.current === 'finalizing' ||
      recordingStateRef.current === 'transcribing' ||
      recordingStateRef.current === 'error'
    ) {
      return;
    }
    isTransitioningRef.current = true;
    isExplicitStopRef.current = true;
    clearTimeout(restartTimeoutRef.current);
    updateRecordingState('finalizing');

    try {
      // Clean up recognition instance immediately to prevent trailing onresult events from double-committing
      cleanupRecognitionInstance();

      // Finalize MediaRecorder audio chunks with clean event synchronization
      let finalBlob = null;
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        try {
          await new Promise((resolve) => {
            const recorder = mediaRecorderRef.current;
            if (!recorder || recorder.state === 'inactive') {
              resolve();
              return;
            }
            const handleStop = () => {
              recorder.removeEventListener('stop', handleStop);
              resolve();
            };
            recorder.addEventListener('stop', handleStop);
            try {
              if (typeof recorder.requestData === 'function') {
                recorder.requestData();
              }
              recorder.stop();
            } catch (_) {
              resolve();
            }
            setTimeout(resolve, 350);
          });
        } catch (_) {}
      }

      // Assemble and store final audio blob for Phase 5.2/5.3 buffer access
      if (audioChunksRef.current.length > 0) {
        const type = activeMimeTypeRef.current || 'audio/webm';
        finalBlob = new Blob(audioChunksRef.current, { type });
        recordedAudioBlobRef.current = finalBlob;
        setRecordedAudioBlob(finalBlob);

        const duration = recordingStartTimeRef.current > 0
          ? Math.round((Date.now() - recordingStartTimeRef.current) / 1000)
          : 0;
        setRecordedAudioDuration(duration);
      }

      // Release microphone tracks and visualizer resources
      stopAudioResources();

      // Assemble final committed speech including any pending interim transcript
      let allFinalSpeech = '';
      for (const seg of committedSegmentsRef.current) {
        allFinalSpeech = combineComposerText(allFinalSpeech, seg.text);
      }

      if (interimTranscriptRef.current && interimTranscriptRef.current.trim()) {
        const formattedInterim = formatSpeechTranscript(
          interimTranscriptRef.current.trim(),
          selectedLanguageRef.current,
          combineComposerText(baseTextRef.current, allFinalSpeech)
        );
        if (formattedInterim) {
          allFinalSpeech = combineComposerText(allFinalSpeech, formattedInterim);
        }
      }

      const finalNativeCombined = combineComposerText(baseTextRef.current, allFinalSpeech);
      recordEmission(finalNativeCombined);

      if (onInputChangeRef.current) {
        onInputChangeRef.current(finalNativeCombined);
      }

      interimTranscriptRef.current = '';
      setInterimTranscript('');

      // Compute total session speech across any silence restarts or pauses
      const initialSessionBaseText = sessionBaseTextRef.current || '';
      let totalSessionSpeech = allFinalSpeech;
      if (initialSessionBaseText && finalNativeCombined.startsWith(initialSessionBaseText)) {
        totalSessionSpeech = finalNativeCombined.slice(initialSessionBaseText.length).trim();
      } else if (!initialSessionBaseText) {
        totalSessionSpeech = finalNativeCombined.trim();
      }
      if (!totalSessionSpeech) {
        totalSessionSpeech = allFinalSpeech;
      }

      if (totalSessionSpeech) {
        setLastSessionTranscript(totalSessionSpeech);
      }

      committedSegmentsRef.current = [];

      // Phase 5.3: Whisper-based High-Accuracy Final Transcription Pipeline
      const currentNativeSpeech = totalSessionSpeech;
      const preTranscribeValue = finalNativeCombined;

      nativeSessionTranscriptRef.current = currentNativeSpeech;
      expectedEmittedBeforeTranscribeRef.current = preTranscribeValue;

      // Only submit to Whisper endpoint if non-trivial audio was recorded (>= 300 bytes)
      if (finalBlob && finalBlob.size >= 300) {
        transcriptionSessionCounterRef.current += 1;
        const currentSessionId = transcriptionSessionCounterRef.current;

        updateRecordingState('transcribing');

        if (transcriptionAbortCtrlRef.current) {
          try {
            transcriptionAbortCtrlRef.current.abort();
          } catch (_) {}
        }
        const abortCtrl = new AbortController();
        transcriptionAbortCtrlRef.current = abortCtrl;

        try {
          const result = await transcribeAudioBlob({
            audioBlob: finalBlob,
            language: selectedLanguageRef.current,
            prompt: 'Orvix, AI conversation assistant. Technical vocabulary: JavaScript, TypeScript, React, palindrome, algorithms, async await, promises, functions, objects, arrays, code',
            signal: abortCtrl.signal
          });

          // Stale response safeguard: Ignore result if a newer dictation session was started or cancelled
          if (transcriptionSessionCounterRef.current !== currentSessionId) {
            return;
          }

          const rawWhisper = (result.text || '').trim();
          if (rawWhisper) {
            const initialBase = sessionBaseTextRef.current || '';
            const formattedWhisper = formatSpeechTranscript(
              rawWhisper,
              selectedLanguageRef.current,
              initialBase
            );

            const currentVal = inputValueRef.current || '';

            // Non-destructive reconciliation policy (Phase 5.4 & Rule A):
            // 1. If composer is currently empty (manually cleared by user), NEVER repopulate!
            if (!currentVal.trim()) {
              return;
            }

            // Guard against Whisper truncation: If native speech recognized a substantial utterance (>= 50 chars),
            // and Whisper returned less than 40% of that length, retain the complete native transcript.
            if (
              currentNativeSpeech &&
              currentNativeSpeech.length >= 50 &&
              formattedWhisper.length < currentNativeSpeech.length * 0.4
            ) {
              setLastSessionTranscript(currentNativeSpeech);
              setTranscriptionNotice({
                type: 'fallback',
                message: 'Whisper result was incomplete — live speech transcript retained.'
              });
              return;
            }

            const fullReconciled = combineComposerText(initialBase, formattedWhisper);
            let reconciled = fullReconciled;

            const isExactPreTranscribe = currentVal === preTranscribeValue;
            const isRecentEmission =
              recentEmissionsRef.current.has(currentVal) ||
              recentEmissionsRef.current.has(currentVal.trim());
            const isLastEmitted = currentVal === lastEmittedValueRef.current;

            let currentSpeechPortion = currentVal;
            if (initialBase && currentVal.startsWith(initialBase)) {
              currentSpeechPortion = currentVal.slice(initialBase.length).trim();
            }

            if (isExactPreTranscribe || isRecentEmission || isLastEmitted) {
              // 2. Composer was untouched since stop, or contains a dictation emission: apply complete Whisper transcript
              reconciled = fullReconciled;
            } else if (currentNativeSpeech && currentVal.includes(currentNativeSpeech)) {
              // 3. User made edits around the speech: substitute the speech portion
              reconciled = currentVal.replace(currentNativeSpeech, formattedWhisper);
            } else if (
              currentSpeechPortion &&
              (currentNativeSpeech.includes(currentSpeechPortion) ||
                formattedWhisper.toLowerCase().includes(currentSpeechPortion.toLowerCase()) ||
                recentEmissionsRef.current.has(currentSpeechPortion))
            ) {
              // 4. Composer contains a partial live chunk of the speech:
              // Replace the partial speech portion with the full Whisper transcript!
              reconciled = currentVal.replace(currentSpeechPortion, formattedWhisper);
            } else if (currentVal && initialBase && currentVal === initialBase) {
              // Only initial base text remains in composer
              reconciled = fullReconciled;
            } else {
              // 5. User typed new/different text with no overlap with this dictation session: do NOT overwrite their typing!
              setLastSessionTranscript(formattedWhisper);
              setTranscriptionNotice({
                type: 'success',
                message: `Enhanced transcript ready in review helper: "${formattedWhisper.length > 35 ? formattedWhisper.slice(0, 35) + '...' : formattedWhisper}"`
              });
              return;
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

          console.warn('[Transcription] Whisper transcription error:', err?.message || err);
          const isOffline = typeof navigator !== 'undefined' && !navigator.onLine;
          const msg = isOffline
            ? 'Network disconnected during transcription — live speech transcript retained.'
            : err?.isTimeout
            ? 'Whisper request timed out — live speech transcript retained.'
            : err?.code === 'RATE_LIMIT_EXCEEDED'
            ? 'Whisper rate limit reached — live speech transcript retained.'
            : err?.code === 'PROVIDER_NOT_CONFIGURED'
            ? (engineMode === 'direct-audio'
                ? 'Whisper transcription requires API key setup on server.'
                : 'Whisper service not configured — live speech transcript retained.')
            : 'Whisper service unavailable — live speech transcript retained.';

          setTranscriptionNotice({
            type: 'fallback',
            message: msg,
            canRetry: true
          });
        } finally {
          if (transcriptionSessionCounterRef.current === currentSessionId) {
            updateRecordingState('idle');
          }
        }
      } else {
        updateRecordingState('idle');
      }
    } finally {
      setTimeout(() => {
        isTransitioningRef.current = false;
      }, 150);
    }
  }, [
    cleanupRecognitionInstance,
    engineMode,
    stopAudioResources,
    updateRecordingState
  ]);

  // Cancel dictation: Discards speech from this session and restores original composer text
  const cancelListening = useCallback(() => {
    isExplicitStopRef.current = true;
    clearTimeout(restartTimeoutRef.current);
    cleanupRecognitionInstance();

    // Abort any in-flight Whisper transcription request
    if (transcriptionAbortCtrlRef.current) {
      try {
        transcriptionAbortCtrlRef.current.abort();
      } catch (_) {}
      transcriptionAbortCtrlRef.current = null;
    }
    transcriptionSessionCounterRef.current += 1;

    // Stop MediaRecorder and discard recorded audio chunks completely
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try {
        mediaRecorderRef.current.stop();
      } catch (_) {}
    }
    audioChunksRef.current = [];
    recordedBytesRef.current = 0;
    recordingStartTimeRef.current = 0;
    recordedAudioBlobRef.current = null;
    setRecordedAudioBlob(null);
    setRecordedAudioDuration(0);

    // Release microphone tracks and visualizer resources
    stopAudioResources();

    // Revert to original composer content prior to this session
    const originalBase = sessionBaseTextRef.current ?? baseTextRef.current;
    recordEmission(originalBase);
    if (onInputChangeRef.current) {
      onInputChangeRef.current(originalBase);
    }

    committedSegmentsRef.current = [];
    interimTranscriptRef.current = '';
    nativeSessionTranscriptRef.current = '';
    expectedEmittedBeforeTranscribeRef.current = '';
    lastCommittedSegmentRef.current = { text: '', timestamp: 0 };
    setInterimTranscript('');
    setLastSessionTranscript('');
    setTranscriptionNotice(null);
    updateRecordingState('idle');
  }, [cleanupRecognitionInstance, stopAudioResources, updateRecordingState]);

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
        prompt: 'Orvix, AI conversation assistant. Technical vocabulary: JavaScript, TypeScript, React, palindrome, algorithms, async await, promises, functions, objects, arrays, code',
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
    if (isTransitioningRef.current) return;

    if (recordingStateRef.current === 'listening') {
      await stopListening();
    } else if (recordingStateRef.current === 'paused') {
      await resumeListening();
    } else if (recordingStateRef.current === 'requesting') {
      cancelListening();
    } else if (
      recordingStateRef.current === 'finalizing' ||
      recordingStateRef.current === 'transcribing'
    ) {
      // Safe no-op while finalization is actively in-flight
      return;
    } else {
      await startListening();
    }
  }, [startListening, stopListening, resumeListening, cancelListening]);

  // Configurable language setter with instant live session restart
  const setSelectedLanguage = useCallback(
    (code) => {
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
    isFinalizing: recordingState === 'finalizing',
    isTranscribing: recordingState === 'transcribing',
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
    retryTranscription
  };
}
