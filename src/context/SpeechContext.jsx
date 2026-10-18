import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { cleanTextForSpeech, splitTextIntoSpeechChunks } from '../utils/speechTextCleaner.js';

const SpeechContext = createContext(null);

// Module-level Set to retain references and prevent Chromium garbage-collection of active SpeechSynthesisUtterances
const retainedUtterances = new Set();

export function useSpeech() {
  const context = useContext(SpeechContext);
  if (!context) {
    throw new Error('useSpeech must be used within a SpeechProvider');
  }
  return context;
}

export function SpeechProvider({ children }) {
  const isSupported =
    typeof window !== 'undefined' &&
    'speechSynthesis' in window &&
    typeof window.SpeechSynthesisUtterance !== 'undefined';

  const [voices, setVoices] = useState([]);
  const [speakingState, setSpeakingState] = useState('idle'); // 'idle' | 'playing' | 'paused'
  const [currentMessageId, setCurrentMessageId] = useState(null);
  const [speechError, setSpeechError] = useState(null);

  // Speech rate: 0.75, 1 (normal), 1.25, 1.5, 2
  const [speechRate, setSpeechRateState] = useState(() => {
    if (typeof window !== 'undefined') {
      try {
        const stored = localStorage.getItem('orvix_speech_rate');
        const num = parseFloat(stored);
        if (num >= 0.5 && num <= 2.5) return num;
      } catch (_) {}
    }
    return 1;
  });

  // Selected Voice URI
  const [selectedVoiceURI, setSelectedVoiceURIState] = useState(() => {
    if (typeof window !== 'undefined') {
      try {
        return localStorage.getItem('orvix_speech_voice_uri') || '';
      } catch (_) {}
    }
    return '';
  });

  // Synchronous refs to prevent stale closure bugs in callbacks and async events
  const speakingStateRef = useRef(speakingState);
  const currentMessageIdRef = useRef(currentMessageId);
  const speechRateRef = useRef(speechRate);
  const selectedVoiceURIRef = useRef(selectedVoiceURI);
  const voicesRef = useRef(voices);
  const currentSessionIdRef = useRef(0);
  const chunksRef = useRef([]);
  const currentChunkIndexRef = useRef(0);
  const keepAliveIntervalRef = useRef(null);
  const pendingSpeakTimerRef = useRef(null);

  // Synchronously update ref and state
  const setSpeakingStateSync = useCallback((state) => {
    speakingStateRef.current = state;
    setSpeakingState(state);
  }, []);

  const setCurrentMessageIdSync = useCallback((id) => {
    currentMessageIdRef.current = id;
    setCurrentMessageId(id);
  }, []);

  const setSpeechRate = useCallback((rate) => {
    const num = parseFloat(rate) || 1;
    const clamped = Math.min(2.5, Math.max(0.5, num));
    speechRateRef.current = clamped;
    setSpeechRateState(clamped);
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem('orvix_speech_rate', String(clamped));
      } catch (_) {}
    }
  }, []);

  const setSelectedVoiceURI = useCallback((uri) => {
    const cleanUri = typeof uri === 'string' ? uri : '';
    selectedVoiceURIRef.current = cleanUri;
    setSelectedVoiceURIState(cleanUri);
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem('orvix_speech_voice_uri', cleanUri);
      } catch (_) {}
    }
  }, []);

  // Load voices safely, handling asynchronous voice population in Chromium & WebKit
  useEffect(() => {
    if (!isSupported) return;

    let mounted = true;

    const populateVoices = () => {
      try {
        const availableVoices = window.speechSynthesis.getVoices() || [];
        if (mounted && availableVoices.length > 0) {
          // Deduplicate voices by voiceURI or name
          const seen = new Set();
          const unique = [];
          for (const v of availableVoices) {
            const key = v.voiceURI || v.name;
            if (key && !seen.has(key)) {
              seen.add(key);
              unique.push(v);
            }
          }
          setVoices(unique);
          voicesRef.current = unique;
        }
      } catch (err) {
        console.warn('Error reading speechSynthesis voices:', err);
      }
    };

    populateVoices();

    if (window.speechSynthesis.addEventListener) {
      window.speechSynthesis.addEventListener('voiceschanged', populateVoices);
    } else if (window.speechSynthesis.onvoiceschanged !== undefined) {
      window.speechSynthesis.onvoiceschanged = populateVoices;
    }

    // Safety polling for browsers that don't trigger voiceschanged immediately
    const timer1 = setTimeout(populateVoices, 100);
    const timer2 = setTimeout(populateVoices, 500);
    const timer3 = setTimeout(populateVoices, 1500);

    return () => {
      mounted = false;
      clearTimeout(timer1);
      clearTimeout(timer2);
      clearTimeout(timer3);
      if (window.speechSynthesis.removeEventListener) {
        window.speechSynthesis.removeEventListener('voiceschanged', populateVoices);
      }
      if (window.speechSynthesis.onvoiceschanged === populateVoices) {
        window.speechSynthesis.onvoiceschanged = null;
      }
    };
  }, [isSupported]);

  // Keep-alive timer to prevent Chrome from silently stopping long speech sessions (>15s)
  const startKeepAlive = useCallback(() => {
    if (keepAliveIntervalRef.current) {
      clearInterval(keepAliveIntervalRef.current);
    }
    keepAliveIntervalRef.current = setInterval(() => {
      if (
        isSupported &&
        window.speechSynthesis.speaking &&
        speakingStateRef.current === 'playing'
      ) {
        try {
          window.speechSynthesis.pause();
          window.speechSynthesis.resume();
        } catch (_) {}
      }
    }, 10000);
  }, [isSupported]);

  const stopKeepAlive = useCallback(() => {
    if (keepAliveIntervalRef.current) {
      clearInterval(keepAliveIntervalRef.current);
      keepAliveIntervalRef.current = null;
    }
  }, []);

  /**
   * Stops any currently active speech synthesis and resets queue.
   */
  const stopSpeech = useCallback(() => {
    // Invalidate any in-flight playback sessions
    currentSessionIdRef.current += 1;

    if (pendingSpeakTimerRef.current) {
      clearTimeout(pendingSpeakTimerRef.current);
      pendingSpeakTimerRef.current = null;
    }

    stopKeepAlive();
    chunksRef.current = [];
    currentChunkIndexRef.current = 0;
    retainedUtterances.clear();

    if (isSupported) {
      try {
        window.speechSynthesis.cancel();
        if (window.speechSynthesis.paused) {
          window.speechSynthesis.resume();
        }
      } catch (_) {}
    }

    setSpeakingStateSync('idle');
    setCurrentMessageIdSync(null);
    setSpeechError(null);
  }, [isSupported, stopKeepAlive, setSpeakingStateSync, setCurrentMessageIdSync]);

  /**
   * Speaks a specific chunk by index for a given session.
   */
  const speakChunk = useCallback(
    (index, sessionId) => {
      if (!isSupported) return;

      // Invalidate if user switched speech session or stopped
      if (sessionId !== currentSessionIdRef.current) {
        return;
      }

      if (speakingStateRef.current !== 'playing') {
        return;
      }

      const chunks = chunksRef.current;
      if (index >= chunks.length) {
        // Finished speaking all message chunks
        stopSpeech();
        return;
      }

      currentChunkIndexRef.current = index;
      const textToSpeak = chunks[index];

      try {
        const utterance = new SpeechSynthesisUtterance(textToSpeak);
        utterance.rate = Math.min(2.5, Math.max(0.5, speechRateRef.current || 1));
        utterance.pitch = 1.0;

        // Apply selected voice if available
        const currentVoices =
          (typeof window !== 'undefined' && window.speechSynthesis.getVoices()) ||
          voicesRef.current ||
          [];

        if (selectedVoiceURIRef.current) {
          const match = currentVoices.find(
            (v) =>
              v.voiceURI === selectedVoiceURIRef.current ||
              v.name === selectedVoiceURIRef.current
          );
          if (match) {
            utterance.voice = match;
            if (match.lang) {
              utterance.lang = match.lang;
            }
          }
        }

        // Retain utterance reference in module set to avoid Chrome GC bug
        retainedUtterances.add(utterance);

        utterance.onend = () => {
          retainedUtterances.delete(utterance);
          if (sessionId !== currentSessionIdRef.current) return;
          if (speakingStateRef.current === 'playing') {
            speakChunk(index + 1, sessionId);
          }
        };

        utterance.onerror = (e) => {
          retainedUtterances.delete(utterance);
          if (sessionId !== currentSessionIdRef.current) return;

          // Ignore benign abort or cancellation events (e.g. user stopped speech)
          if (e.error === 'canceled' || e.error === 'interrupted') {
            return;
          }
          console.warn('SpeechSynthesisUtterance error:', e.error);
          setSpeechError(`Speech synthesis error: ${e.error}`);
          stopSpeech();
        };

        window.speechSynthesis.speak(utterance);

        // Resume if browser got into stuck paused state
        if (window.speechSynthesis.paused) {
          window.speechSynthesis.resume();
        }
      } catch (err) {
        console.warn('Speech synthesis execution failed:', err);
        setSpeechError('Unable to start speech synthesis in this browser.');
        stopSpeech();
      }
    },
    [isSupported, stopSpeech]
  );

  /**
   * Pauses the active speech synthesis.
   */
  const pauseSpeech = useCallback(() => {
    if (!isSupported) return;

    try {
      setSpeakingStateSync('paused');
      stopKeepAlive();
      window.speechSynthesis.pause();
    } catch (err) {
      console.warn('Speech pause error:', err);
    }
  }, [isSupported, stopKeepAlive, setSpeakingStateSync]);

  /**
   * Resumes paused speech synthesis.
   */
  const resumeSpeech = useCallback(() => {
    if (!isSupported) return;

    try {
      setSpeakingStateSync('playing');
      startKeepAlive();

      // If synthesis engine is paused, try native resume
      if (window.speechSynthesis.paused) {
        window.speechSynthesis.resume();
      } else {
        // Fallback: re-speak from current chunk index if browser unpaused but dropped audio
        speakChunk(currentChunkIndexRef.current, currentSessionIdRef.current);
      }
    } catch (_) {
      speakChunk(currentChunkIndexRef.current, currentSessionIdRef.current);
    }
  }, [isSupported, startKeepAlive, setSpeakingStateSync, speakChunk]);

  /**
   * Begins reading aloud an assistant message or settings voice preview.
   * Cancels any previously active speech before starting.
   *
   * @param {string} messageId - The unique identifier of the message (or 'settings-preview')
   * @param {string} rawMarkdown - The Markdown or plain text content to clean and read
   */
  const playMessage = useCallback(
    (messageId, rawMarkdown) => {
      if (!isSupported) {
        setSpeechError('Text-to-speech is not supported by your browser.');
        return;
      }

      // If already playing this exact message, toggle pause
      if (currentMessageIdRef.current === messageId && speakingStateRef.current === 'playing') {
        pauseSpeech();
        return;
      }

      // Stop any prior playback
      if (pendingSpeakTimerRef.current) {
        clearTimeout(pendingSpeakTimerRef.current);
        pendingSpeakTimerRef.current = null;
      }

      stopKeepAlive();
      retainedUtterances.clear();

      if (isSupported) {
        try {
          window.speechSynthesis.cancel();
          if (window.speechSynthesis.paused) {
            window.speechSynthesis.resume();
          }
        } catch (_) {}
      }

      const cleaned = cleanTextForSpeech(rawMarkdown);
      if (!cleaned) {
        setSpeechError('No readable text found in this message.');
        return;
      }

      const chunks = splitTextIntoSpeechChunks(cleaned);
      if (chunks.length === 0) {
        return;
      }

      // Assign new session ID for this playback sequence
      const sessionId = ++currentSessionIdRef.current;

      chunksRef.current = chunks;
      currentChunkIndexRef.current = 0;
      setCurrentMessageIdSync(messageId);
      setSpeakingStateSync('playing');
      setSpeechError(null);

      startKeepAlive();

      // Small 30ms timeout allows the browser's speech queue to drain cleanly after cancel()
      pendingSpeakTimerRef.current = setTimeout(() => {
        pendingSpeakTimerRef.current = null;
        if (sessionId !== currentSessionIdRef.current) return;
        speakChunk(0, sessionId);
      }, 30);
    },
    [isSupported, pauseSpeech, stopKeepAlive, setCurrentMessageIdSync, setSpeakingStateSync, startKeepAlive, speakChunk]
  );

  /**
   * Toggle Play / Pause / Resume for a given message.
   */
  const toggleSpeech = useCallback(
    (messageId, rawMarkdown) => {
      if (currentMessageIdRef.current === messageId) {
        if (speakingStateRef.current === 'playing') {
          pauseSpeech();
        } else if (speakingStateRef.current === 'paused') {
          resumeSpeech();
        } else {
          playMessage(messageId, rawMarkdown);
        }
      } else {
        playMessage(messageId, rawMarkdown);
      }
    },
    [playMessage, pauseSpeech, resumeSpeech]
  );

  // Clean up on component unmount or window beforeunload
  useEffect(() => {
    const handleUnload = () => {
      if (isSupported) {
        try {
          window.speechSynthesis.cancel();
        } catch (_) {}
      }
    };

    window.addEventListener('beforeunload', handleUnload);

    return () => {
      window.removeEventListener('beforeunload', handleUnload);
      if (pendingSpeakTimerRef.current) {
        clearTimeout(pendingSpeakTimerRef.current);
        pendingSpeakTimerRef.current = null;
      }
      stopKeepAlive();
      retainedUtterances.clear();
      if (isSupported) {
        try {
          window.speechSynthesis.cancel();
        } catch (_) {}
      }
    };
  }, [isSupported, stopKeepAlive]);

  // Find currently active voice object
  const activeVoice =
    voices.find(
      (v) =>
        v.voiceURI === selectedVoiceURI ||
        v.name === selectedVoiceURI
    ) ||
    voices.find((v) => v.default) ||
    voices[0] ||
    null;

  const value = {
    isSupported,
    speakingState,
    currentMessageId,
    speechError,
    voices,
    activeVoice,
    selectedVoiceURI,
    setSelectedVoiceURI,
    speechRate,
    setSpeechRate,
    playMessage,
    pauseSpeech,
    resumeSpeech,
    stopSpeech,
    toggleSpeech
  };

  return <SpeechContext.Provider value={value}>{children}</SpeechContext.Provider>;
}
