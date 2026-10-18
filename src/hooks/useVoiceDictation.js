import { useState, useRef, useEffect, useCallback } from 'react';

/**
 * Custom hook providing robust speech-to-text dictation using the Web Speech API.
 * Uses window.SpeechRecognition or window.webkitSpeechRecognition.
 *
 * Handles:
 * - Start / stop toggle
 * - Safe accumulation of interim and final speech transcripts without duplicates
 * - Combining dictated text with previously typed text
 * - Comprehensive error handling (permissions, audio-capture, no-speech, unsupported browsers)
 * - Automatic cleanup on unmount or message submission
 *
 * @param {Object} options
 * @param {string} options.inputValue - Current text in the input
 * @param {(text: string) => void} options.onInputChange - Callback to update input text
 * @returns {Object} Voice dictation state and control functions
 */
export function useVoiceDictation({ inputValue = '', onInputChange }) {
  const [isListening, setIsListening] = useState(false);
  const [dictationError, setDictationError] = useState(null);
  const [isSupported, setIsSupported] = useState(false);

  const recognitionRef = useRef(null);
  const baseTextRef = useRef('');
  const inputValueRef = useRef(inputValue);
  inputValueRef.current = inputValue;

  // Check browser support on mount
  useEffect(() => {
    const SpeechRecognition =
      typeof window !== 'undefined'
        ? window.SpeechRecognition || window.webkitSpeechRecognition
        : null;
    setIsSupported(Boolean(SpeechRecognition));
  }, []);

  const clearDictationError = useCallback(() => {
    setDictationError(null);
  }, []);

  const stopListening = useCallback(() => {
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch (_) {
        // Recognition might already have stopped
      }
    }
    setIsListening(false);
  }, []);

  const startListening = useCallback(() => {
    setDictationError(null);

    const SpeechRecognition =
      typeof window !== 'undefined'
        ? window.SpeechRecognition || window.webkitSpeechRecognition
        : null;

    if (!SpeechRecognition) {
      setDictationError('Voice dictation is not supported in this browser. Please try Chrome, Edge, or Safari.');
      return;
    }

    // Stop any existing instance before starting a new one
    if (recognitionRef.current) {
      try {
        recognitionRef.current.abort();
      } catch (_) {}
      recognitionRef.current = null;
    }

    // Save existing text as base prefix
    baseTextRef.current = (inputValueRef.current || '').trim();

    try {
      const recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'en-US';

      recognition.onstart = () => {
        setIsListening(true);
        setDictationError(null);
      };

      recognition.onresult = (event) => {
        let sessionFinal = '';
        let interim = '';

        // Iterate through all results to reconstruct transcript cleanly without duplicates
        for (let i = 0; i < event.results.length; ++i) {
          const result = event.results[i];
          const text = result[0]?.transcript || '';
          if (result.isFinal) {
            sessionFinal += (sessionFinal ? ' ' : '') + text.trim();
          } else {
            interim += (interim ? ' ' : '') + text.trim();
          }
        }

        const sessionSpeech = [sessionFinal, interim].filter(Boolean).join(' ');
        const base = baseTextRef.current;

        let combined = '';
        if (base && sessionSpeech) {
          combined = `${base} ${sessionSpeech}`;
        } else if (sessionSpeech) {
          combined = sessionSpeech;
        } else {
          combined = base;
        }

        if (onInputChange) {
          onInputChange(combined);
        }
      };

      recognition.onerror = (event) => {
        const errorType = event.error;

        // User intentionally aborted or stopped — ignore without scary error
        if (errorType === 'aborted') {
          setIsListening(false);
          return;
        }

        if (errorType === 'not-allowed' || errorType === 'service-not-allowed') {
          setDictationError('Microphone permission was denied. Please allow microphone access in your browser settings.');
        } else if (errorType === 'audio-capture') {
          setDictationError('No microphone detected or microphone is in use by another app.');
        } else if (errorType === 'no-speech') {
          setDictationError('No speech was detected. Click the microphone to try again.');
        } else if (errorType === 'network') {
          setDictationError('Voice recognition network connection error. Please try again.');
        } else {
          setDictationError(`Voice recognition encountered an issue (${errorType}).`);
        }

        setIsListening(false);
      };

      recognition.onend = () => {
        setIsListening(false);
        recognitionRef.current = null;
      };

      recognitionRef.current = recognition;
      recognition.start();
    } catch (err) {
      console.warn('Failed to start SpeechRecognition:', err);
      setDictationError('Could not initialize speech recognition. Please verify microphone permissions.');
      setIsListening(false);
    }
  }, [onInputChange]);

  const toggleListening = useCallback(() => {
    if (isListening) {
      stopListening();
    } else {
      startListening();
    }
  }, [isListening, startListening, stopListening]);

  // Clean up recognition instance when unmounting
  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort();
        } catch (_) {}
        recognitionRef.current = null;
      }
    };
  }, []);

  return {
    isListening,
    dictationError,
    isSupported,
    startListening,
    stopListening,
    toggleListening,
    clearDictationError
  };
}
