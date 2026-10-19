import { useState, useRef, useEffect, useCallback } from 'react';

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
 * Phonetic corrections for common speech engine slips in tech/AI context.
 */
const COMMON_TECH_CORRECTIONS = [
  [/\b(?:or\s*vix|our\s*vix|or\s*fix|aur\s*vix)\b/gi, 'Orvix'],
  [/\b(?:chat\s*gpt|chat\s*g\s*p\s*t)\b/gi, 'ChatGPT'],
  [/\bopen\s*ai\b/gi, 'OpenAI'],
  [/\bjava\s*script\b/gi, 'JavaScript'],
  [/\btype\s*script\b/gi, 'TypeScript'],
  [/\byou\s*tube\b/gi, 'YouTube'],
  [/\b(?:a\s*p\s*i)\b/gi, 'API'],
  [/\b(?:j\s*s\s*o\s*n)\b/gi, 'JSON'],
  [/\b(?:h\s*t\s*m\s*l)\b/gi, 'HTML'],
  [/\b(?:c\s*s\s*s)\b/gi, 'CSS'],
  [/\b(?:u\s*r\s*l)\b/gi, 'URL']
];

/**
 * Smart Verbal Punctuation and Formatting Engine
 * Converts spoken verbal commands ("period", "comma", "question mark", "new line")
 * into true typography, capitalizes sentences, and fixes spacing.
 *
 * @param {string} rawText
 * @param {string} langCode
 * @param {string} [precedingText='']
 * @returns {string} Polished text
 */
export function formatSpeechTranscript(rawText, langCode = 'en-US', precedingText = '') {
  if (!rawText) return '';
  let text = rawText.trim();
  const isUrdu = langCode.startsWith('ur');

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
      .replace(/\s+\b(?:period|full\s*stop)\b/gi, '.')
      .replace(/\s+\bcomma\b/gi, ',')
      .replace(/\s+\bquestion\s*mark\b/gi, '?')
      .replace(/\s+\b(?:exclamation\s*mark|exclamation\s*point)\b/gi, '!')
      .replace(/\s+\bcolon\b/gi, ':')
      .replace(/\s+\bsemicolon\b/gi, ';')
      .replace(/\s+\b(?:new\s*paragraph|next\s*paragraph)\b/gi, '\n\n')
      .replace(/\s+\b(?:new\s*line|newline)\b/gi, '\n')
      .replace(/\s+\b(?:hyphen|dash)\b/gi, ' - ');

    // English pronoun "I" and contractions
    text = text
      .replace(/\bi\b/g, 'I')
      .replace(/\bi'm\b/g, "I'm")
      .replace(/\bi'll\b/g, "I'll")
      .replace(/\bi've\b/g, "I've")
      .replace(/\bi'd\b/g, "I'd");

    // Tech phonetic glossary corrections
    for (const [pattern, replacement] of COMMON_TECH_CORRECTIONS) {
      text = text.replace(pattern, replacement);
    }
  }

  // Remove irregular spaces before punctuation
  text = text
    .replace(/\s+([.,!?:;۔،؟])/g, '$1')
    .replace(/([.,!?:;۔،؟])([^\s\d\n])/g, '$1 $2')
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
  }

  return text;
}

/**
 * Hook providing professional, ChatGPT-inspired voice dictation using browser Web Speech API
 * combined with Web Audio API real-time soundwave visualization.
 *
 * Solves:
 * - Phrase duplication & sentence repetition using stable result-index maps.
 * - Verbal punctuation ("comma", "period", "question mark", "new line").
 * - Dynamic 5-bar soundwave animation reacting to real microphone volume.
 * - Graceful silence recovery avoiding sudden cutoffs while thinking.
 * - Synchronous state tracking preventing duplicate recognition sessions or race conditions.
 * - Clean UI states (idle, requesting, listening, paused, finalizing, error).
 *
 * @param {Object} options
 * @param {string} options.inputValue - Current text in the composer
 * @param {(text: string) => void} options.onInputChange - Callback to update composer text
 * @returns {Object} Dictation states, real-time audio metrics, and controls
 */
export function useVoiceDictation({ inputValue = '', onInputChange }) {
  // Synchronous initial detection of browser SpeechRecognition support
  const [isSupported, setIsSupported] = useState(() => {
    if (typeof window !== 'undefined') {
      return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
    }
    return false;
  });

  const [recordingState, setRecordingState] = useState('idle'); // 'idle' | 'requesting' | 'listening' | 'paused' | 'finalizing' | 'error'
  const [dictationError, setDictationError] = useState(null);
  const [interimTranscript, setInterimTranscript] = useState('');
  const [lastSessionTranscript, setLastSessionTranscript] = useState('');

  // Real-time audio reactivity: volume (0-100) and 5 frequency bins (0.0 - 1.0)
  const [audioLevel, setAudioLevel] = useState(0);
  const [audioFrequencies, setAudioFrequencies] = useState([0.15, 0.25, 0.35, 0.25, 0.15]);

  // Selected language with localStorage persistence
  const [selectedLanguage, setSelectedLanguageState] = useState(() => {
    if (typeof window !== 'undefined') {
      try {
        const stored = localStorage.getItem('orvix_dictation_lang');
        if (stored && SUPPORTED_LANGUAGES.some((l) => l.code === stored)) {
          return stored;
        }
      } catch (_) {}
    }
    return DEFAULT_LANGUAGE;
  });

  const setSelectedLanguage = useCallback((code) => {
    setSelectedLanguageState(code);
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem('orvix_dictation_lang', code);
      } catch (_) {}
    }
  }, []);

  const recognitionRef = useRef(null);
  const baseTextRef = useRef('');
  const finalResultsMapRef = useRef(new Map());
  const interimTranscriptRef = useRef('');
  const inputValueRef = useRef(inputValue);
  inputValueRef.current = inputValue;

  const isExplicitStopRef = useRef(false);
  const hasFatalErrorRef = useRef(false);
  const recordingStateRef = useRef(recordingState);

  const selectedLanguageRef = useRef(selectedLanguage);
  selectedLanguageRef.current = selectedLanguage;

  const restartTimeoutRef = useRef(null);
  const consecutiveErrorsRef = useRef(0);

  // AudioContext & Analyser refs for real-time soundwave
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const animFrameRef = useRef(null);

  // Synchronous state updater to eliminate React re-render lag in asynchronous event callbacks
  const updateRecordingState = useCallback((newState) => {
    recordingStateRef.current = newState;
    setRecordingState(newState);
  }, []);

  // Check Web Speech API browser support on mount as safety check
  useEffect(() => {
    const SpeechRecognition =
      typeof window !== 'undefined'
        ? window.SpeechRecognition || window.webkitSpeechRecognition
        : null;
    setIsSupported(Boolean(SpeechRecognition));
  }, []);

  // Cleanup helper for Web Audio analyser
  const stopAudioAnalyser = useCallback(() => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    if (mediaStreamRef.current) {
      try {
        mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      } catch (_) {}
      mediaStreamRef.current = null;
    }
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

  // Start real-time audio visualization using Web Audio API safely
  const startAudioAnalyser = useCallback(async () => {
    if (typeof window === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      return;
    }
    stopAudioAnalyser();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      mediaStreamRef.current = stream;

      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;

      const ctx = new AudioCtx();
      audioContextRef.current = ctx;

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

      updateMeter();
    } catch (_) {
      // AudioContext mic access failed or denied; fallback to CSS animation without breaking dictation
    }
  }, [stopAudioAnalyser]);

  const clearDictationError = useCallback(() => {
    setDictationError(null);
    if (recordingStateRef.current === 'error') {
      updateRecordingState('idle');
    }
  }, [updateRecordingState]);

  const clearLastSessionTranscript = useCallback(() => {
    setLastSessionTranscript('');
  }, []);

  // Internal helper to start or restart the browser SpeechRecognition instance
  const startRecognitionSession = useCallback(
    (isNewSession = true) => {
      clearTimeout(restartTimeoutRef.current);

      const SpeechRecognition =
        typeof window !== 'undefined'
          ? window.SpeechRecognition || window.webkitSpeechRecognition
          : null;

      if (!SpeechRecognition) {
        setDictationError(
          'Voice dictation is not supported in this browser. Please use Google Chrome, Microsoft Edge, or Safari.'
        );
        hasFatalErrorRef.current = true;
        updateRecordingState('error');
        return;
      }

      if (isNewSession) {
        // Stop any active speech synthesis so microphone does not pick up speaker audio
        if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
          try {
            window.speechSynthesis.cancel();
          } catch (_) {}
        }

        // Snapshot existing composer content as base prefix
        baseTextRef.current = (inputValueRef.current || '').trim();
        finalResultsMapRef.current.clear();
        interimTranscriptRef.current = '';
        setInterimTranscript('');
        setLastSessionTranscript('');
        isExplicitStopRef.current = false;
        hasFatalErrorRef.current = false;
        consecutiveErrorsRef.current = 0;
      } else {
        // If continuing an active session after browser silence restart,
        // fold already finalized chunks into baseTextRef so indices reset cleanly
        const existingChunks = Array.from(finalResultsMapRef.current.entries())
          .sort((a, b) => a[0] - b[0])
          .map((entry) => entry[1]);

        if (existingChunks.length > 0) {
          const committedSoFar = existingChunks.join(' ').trim();
          const parts = [baseTextRef.current, committedSoFar].filter(Boolean);
          baseTextRef.current = parts.join(' ').trim();
          finalResultsMapRef.current.clear();
        }
      }

      // Clean up previous recognition instance completely
      if (recognitionRef.current) {
        try {
          recognitionRef.current.onstart = null;
          recognitionRef.current.onresult = null;
          recognitionRef.current.onerror = null;
          recognitionRef.current.onend = null;
          recognitionRef.current.abort();
        } catch (_) {}
        recognitionRef.current = null;
      }

      try {
        const recognition = new SpeechRecognition();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.maxAlternatives = 1;
        recognition.lang = selectedLanguageRef.current;

        updateRecordingState('requesting');
        hasFatalErrorRef.current = false;

        recognition.onstart = () => {
          updateRecordingState('listening');
          setDictationError(null);
          consecutiveErrorsRef.current = 0;
          startAudioAnalyser();
        };

        recognition.onresult = (event) => {
          let currentInterim = '';

          for (let i = event.resultIndex; i < event.results.length; ++i) {
            const res = event.results[i];
            const rawTranscript = res[0]?.transcript || '';

            if (res.isFinal) {
              const preceding = [
                baseTextRef.current,
                ...Array.from(finalResultsMapRef.current.values())
              ]
                .filter(Boolean)
                .join(' ');

              const formatted = formatSpeechTranscript(
                rawTranscript,
                selectedLanguageRef.current,
                preceding
              );

              if (formatted) {
                finalResultsMapRef.current.set(i, formatted);
              }
            } else {
              currentInterim += (currentInterim ? ' ' : '') + rawTranscript.trim();
            }
          }

          interimTranscriptRef.current = currentInterim;
          setInterimTranscript(currentInterim);

          const sortedFinals = Array.from(finalResultsMapRef.current.entries())
            .sort((a, b) => a[0] - b[0])
            .map((e) => e[1]);

          const allFinalSpeech = sortedFinals.join(' ').trim();
          const base = baseTextRef.current;

          const parts = [base, allFinalSpeech, currentInterim].filter(Boolean);
          const combined = parts.join(' ');

          if (onInputChange) {
            onInputChange(combined);
          }
        };

        recognition.onerror = (event) => {
          const errorType = event.error;

          // Ignore intentional user stops or aborts
          if (errorType === 'aborted' || isExplicitStopRef.current) {
            return;
          }

          consecutiveErrorsRef.current += 1;

          if (errorType === 'not-allowed' || errorType === 'service-not-allowed') {
            hasFatalErrorRef.current = true;
            stopAudioAnalyser();
            setDictationError(
              'Microphone access was denied. Please allow microphone permissions in your browser address bar.'
            );
            updateRecordingState('error');
          } else if (errorType === 'audio-capture') {
            hasFatalErrorRef.current = true;
            stopAudioAnalyser();
            setDictationError(
              'No microphone detected or microphone is currently busy in another application.'
            );
            updateRecordingState('error');
          } else if (errorType === 'no-speech') {
            // Natural pause in speech: do NOT abort or show error banner; stay listening
            if (recordingStateRef.current === 'listening' && consecutiveErrorsRef.current <= 3) {
              return;
            }
            stopAudioAnalyser();
            updateRecordingState('idle');
          } else if (errorType === 'network') {
            hasFatalErrorRef.current = true;
            stopAudioAnalyser();
            setDictationError('Speech recognition network error. Please verify your internet connection.');
            updateRecordingState('error');
          } else if (errorType === 'language-not-supported') {
            hasFatalErrorRef.current = true;
            stopAudioAnalyser();
            setDictationError(
              `The selected language (${selectedLanguageRef.current}) is not supported in this browser. Falling back to English (US).`
            );
            setSelectedLanguage(DEFAULT_LANGUAGE);
            updateRecordingState('error');
          } else {
            hasFatalErrorRef.current = true;
            stopAudioAnalyser();
            setDictationError(`Dictation issue: ${errorType}.`);
            updateRecordingState('error');
          }
        };

        recognition.onend = () => {
          recognitionRef.current = null;

          if (hasFatalErrorRef.current) {
            hasFatalErrorRef.current = false;
            stopAudioAnalyser();
            updateRecordingState('error');
            return;
          }

          // If speech recognizer ended naturally during active listening without explicit user stop
          // (such as standard browser 60s silence timeout), auto-restart gracefully
          if (
            !isExplicitStopRef.current &&
            recordingStateRef.current === 'listening' &&
            consecutiveErrorsRef.current < 4
          ) {
            clearTimeout(restartTimeoutRef.current);
            restartTimeoutRef.current = setTimeout(() => {
              if (recordingStateRef.current === 'listening' && !isExplicitStopRef.current) {
                startRecognitionSession(false);
              }
            }, 200);
            return;
          }

          stopAudioAnalyser();

          if (recordingStateRef.current !== 'paused') {
            updateRecordingState('idle');
          }
        };

        recognitionRef.current = recognition;
        recognition.start();
      } catch (initErr) {
        console.warn('SpeechRecognition initialization error:', initErr);
        hasFatalErrorRef.current = true;
        stopAudioAnalyser();
        setDictationError('Unable to activate microphone. Please verify device permissions.');
        updateRecordingState('error');
      }
    },
    [onInputChange, setSelectedLanguage, startAudioAnalyser, stopAudioAnalyser, updateRecordingState]
  );

  // Start a fresh dictation session
  const startListening = useCallback(() => {
    isExplicitStopRef.current = false;
    hasFatalErrorRef.current = false;
    setDictationError(null);
    startRecognitionSession(true);
  }, [startRecognitionSession]);

  // Pause dictation temporarily (keeps session memory intact)
  const pauseListening = useCallback(() => {
    isExplicitStopRef.current = true;
    clearTimeout(restartTimeoutRef.current);
    stopAudioAnalyser();

    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch (_) {}
    }

    interimTranscriptRef.current = '';
    setInterimTranscript('');
    updateRecordingState('paused');
  }, [stopAudioAnalyser, updateRecordingState]);

  // Resume paused dictation session
  const resumeListening = useCallback(() => {
    isExplicitStopRef.current = false;
    hasFatalErrorRef.current = false;
    setDictationError(null);
    startRecognitionSession(false);
  }, [startRecognitionSession]);

  // Stop dictation and commit finalized transcript into composer
  const stopListening = useCallback(() => {
    isExplicitStopRef.current = true;
    clearTimeout(restartTimeoutRef.current);
    updateRecordingState('finalizing');
    stopAudioAnalyser();

    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch (_) {}
    }

    // Assemble final committed speech including any pending interim transcript
    const sortedFinals = Array.from(finalResultsMapRef.current.entries())
      .sort((a, b) => a[0] - b[0])
      .map((e) => e[1]);

    let allFinalSpeech = sortedFinals.join(' ').trim();
    if (interimTranscriptRef.current && interimTranscriptRef.current.trim()) {
      const formattedInterim = formatSpeechTranscript(
        interimTranscriptRef.current.trim(),
        selectedLanguageRef.current,
        [baseTextRef.current, allFinalSpeech].filter(Boolean).join(' ')
      );
      if (formattedInterim) {
        allFinalSpeech = [allFinalSpeech, formattedInterim].filter(Boolean).join(' ');
      }
    }

    const base = baseTextRef.current;
    const parts = [base, allFinalSpeech].filter(Boolean);
    const finalCombined = parts.join(' ');

    if (onInputChange) {
      onInputChange(finalCombined);
    }

    interimTranscriptRef.current = '';
    setInterimTranscript('');
    if (allFinalSpeech) {
      setLastSessionTranscript(allFinalSpeech);
    }

    finalResultsMapRef.current.clear();
    updateRecordingState('idle');
  }, [onInputChange, stopAudioAnalyser, updateRecordingState]);

  // Cancel dictation: Discards speech from this session and restores original composer text
  const cancelListening = useCallback(() => {
    isExplicitStopRef.current = true;
    clearTimeout(restartTimeoutRef.current);
    stopAudioAnalyser();

    if (recognitionRef.current) {
      try {
        recognitionRef.current.abort();
      } catch (_) {}
      recognitionRef.current = null;
    }

    // Revert to original composer content prior to this session
    if (onInputChange) {
      onInputChange(baseTextRef.current);
    }

    finalResultsMapRef.current.clear();
    interimTranscriptRef.current = '';
    setInterimTranscript('');
    updateRecordingState('idle');
  }, [onInputChange, stopAudioAnalyser, updateRecordingState]);

  // Master toggle button with clean state routing
  const toggleListening = useCallback(() => {
    if (recordingStateRef.current === 'listening') {
      stopListening();
    } else if (recordingStateRef.current === 'paused') {
      resumeListening();
    } else if (recordingStateRef.current === 'requesting') {
      cancelListening();
    } else if (recordingStateRef.current === 'finalizing') {
      // Finalizing already in progress, ignore repeated clicks
      return;
    } else {
      startListening();
    }
  }, [startListening, stopListening, resumeListening, cancelListening]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clearTimeout(restartTimeoutRef.current);
      stopAudioAnalyser();
      if (recognitionRef.current) {
        try {
          recognitionRef.current.onstart = null;
          recognitionRef.current.onresult = null;
          recognitionRef.current.onerror = null;
          recognitionRef.current.onend = null;
          recognitionRef.current.abort();
        } catch (_) {}
        recognitionRef.current = null;
      }
    };
  }, [stopAudioAnalyser]);

  return {
    recordingState,
    isListening: recordingState === 'listening',
    isPaused: recordingState === 'paused',
    isRequesting: recordingState === 'requesting',
    isFinalizing: recordingState === 'finalizing',
    isSupported,
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
    toggleListening,
    clearDictationError,
    clearLastSessionTranscript
  };
}
