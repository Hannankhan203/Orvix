import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { cleanTextForSpeech, splitTextIntoSpeechChunks, getWordBoundaryOffset } from '../utils/speechTextCleaner.js';

const SpeechContext = createContext(null);

// Global module-level and window-level Set to retain references and prevent
// V8 and JavaScriptCore garbage-collection of active SpeechSynthesisUtterance objects on mobile
if (typeof window !== 'undefined') {
  if (!window.__orvix_utterances__) {
    window.__orvix_utterances__ = new Set();
  }
}
const retainedUtterances = typeof window !== 'undefined' && window.__orvix_utterances__
  ? window.__orvix_utterances__
  : new Set();

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
  // Standardized playback states: 'idle' | 'speaking' | 'paused' | 'completed' | 'error'
  const [speakingState, setSpeakingState] = useState('idle');
  const [currentMessageId, setCurrentMessageId] = useState(null);
  const [speechError, setSpeechError] = useState(null);

  // Saved reading positions per AI response:
  // { [messageId: string]: { chunkIndex: number, charOffset: number, cleanedText: string } }
  const [readingPositions, setReadingPositions] = useState({});

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
  const currentCharIndexRef = useRef(0);
  const currentChunkStartOffsetRef = useRef(0);
  const activeCleanedTextRef = useRef('');
  const readingPositionsRef = useRef(readingPositions);

  // Mobile timing and watchdog refs
  const chunkStartTimeRef = useRef(0);
  const lastAudioActivityRef = useRef(0);
  const isAdvancingChunkRef = useRef(false);
  const advancingTimeoutRef = useRef(null);
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

  // Update a reading position for a specific message
  const updateReadingPosition = useCallback((messageId, pos) => {
    if (!messageId || messageId === 'settings-preview') return;
    setReadingPositions((prev) => {
      const next = {
        ...prev,
        [messageId]: pos
      };
      // Limit to 50 active items to prevent unbounded memory growth
      const keys = Object.keys(next);
      if (keys.length > 50) {
        delete next[keys[0]];
      }
      readingPositionsRef.current = next;
      return next;
    });
  }, []);

  // Remove saved reading position for a specific message
  const removeReadingPosition = useCallback((messageId) => {
    if (!messageId) return;
    setReadingPositions((prev) => {
      if (!prev[messageId]) return prev;
      const next = { ...prev };
      delete next[messageId];
      readingPositionsRef.current = next;
      return next;
    });
  }, []);

  // Check if a message has a saved non-zero reading position
  const hasSavedPosition = useCallback((messageId) => {
    if (!messageId) return false;
    const pos = readingPositionsRef.current[messageId] || readingPositions[messageId];
    if (!pos) return false;
    return pos.chunkIndex > 0 || pos.charOffset > 0;
  }, [readingPositions]);

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

  /**
   * Captures and persists the current chunk and character offset for the active message.
   * If onboundary is not fired on mobile WebKit/Android, estimates offset via elapsed time.
   */
  const captureCurrentPosition = useCallback(() => {
    const activeMsgId = currentMessageIdRef.current;
    if (!activeMsgId || activeMsgId === 'settings-preview') return;

    const chunkIdx = currentChunkIndexRef.current;
    let charOff = currentCharIndexRef.current;
    const currentChunkText = chunksRef.current[chunkIdx] || '';

    // If onboundary never updated charOff, estimate from elapsed speaking time
    if (charOff <= currentChunkStartOffsetRef.current && chunkStartTimeRef.current > 0) {
      const elapsedSec = (Date.now() - chunkStartTimeRef.current) / 1000;
      const rate = speechRateRef.current || 1;
      // Approx 14 characters per second at 1.0x rate
      const estimatedChars = Math.floor(elapsedSec * 14 * rate);
      charOff = Math.min(currentChunkText.length, currentChunkStartOffsetRef.current + estimatedChars);
    }

    const cleaned = activeCleanedTextRef.current;
    const totalChunks = chunksRef.current.length;
    const isNearEnd =
      chunkIdx >= totalChunks - 1 &&
      charOff >= Math.max(0, currentChunkText.length - 4);

    if (totalChunks > 0 && !isNearEnd) {
      updateReadingPosition(activeMsgId, {
        chunkIndex: chunkIdx,
        charOffset: charOff,
        cleanedText: cleaned
      });
    } else {
      removeReadingPosition(activeMsgId);
    }
  }, [updateReadingPosition, removeReadingPosition]);

  /**
   * Handles natural completion when all chunks of the message have finished speaking.
   */
  const handleNaturalCompletion = useCallback(() => {
    const activeMsgId = currentMessageIdRef.current;
    if (activeMsgId) {
      removeReadingPosition(activeMsgId);
    }

    currentSessionIdRef.current += 1;
    chunksRef.current = [];
    currentChunkIndexRef.current = 0;
    currentCharIndexRef.current = 0;
    activeCleanedTextRef.current = '';
    retainedUtterances.clear();

    setSpeakingStateSync('completed');

    // Smoothly transition from completed to idle
    setTimeout(() => {
      if (speakingStateRef.current === 'completed') {
        setSpeakingStateSync('idle');
        setCurrentMessageIdSync(null);
      }
    }, 250);
  }, [removeReadingPosition, setSpeakingStateSync, setCurrentMessageIdSync]);

  /**
   * Speaks a specific chunk by index for a given session.
   * Supports starting from a specific character offset within the initial chunk on resume.
   *
   * @param {number} index - Chunk index to speak
   * @param {number} sessionId - Unique session identifier
   * @param {number} [initialOffset=0] - Character offset within this chunk to start speaking from
   */
  const speakChunk = useCallback(
    (index, sessionId, initialOffset = 0) => {
      if (!isSupported) return;

      // Invalidate if user switched speech session or paused/stopped
      if (sessionId !== currentSessionIdRef.current) {
        return;
      }

      if (speakingStateRef.current !== 'speaking') {
        return;
      }

      const chunks = chunksRef.current;
      if (index >= chunks.length) {
        handleNaturalCompletion();
        return;
      }

      const fullChunk = chunks[index];
      let alignedOffset = 0;
      let textToSpeak = fullChunk;

      if (initialOffset > 0) {
        alignedOffset = getWordBoundaryOffset(fullChunk, initialOffset);
        // If aligned offset is at the end or remaining text is empty, advance to next chunk
        if (alignedOffset >= fullChunk.length - 2 || fullChunk.slice(alignedOffset).trim().length === 0) {
          isAdvancingChunkRef.current = true;
          advancingTimeoutRef.current = setTimeout(() => {
            advancingTimeoutRef.current = null;
            isAdvancingChunkRef.current = false;
            if (sessionId !== currentSessionIdRef.current) return;
            if (speakingStateRef.current === 'speaking') {
              speakChunk(index + 1, sessionId, 0);
            }
          }, 40);
          return;
        }
        textToSpeak = fullChunk.slice(alignedOffset).trim();
      }

      currentChunkIndexRef.current = index;
      currentChunkStartOffsetRef.current = alignedOffset;
      currentCharIndexRef.current = alignedOffset;
      chunkStartTimeRef.current = Date.now();
      lastAudioActivityRef.current = Date.now();

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

        // Retain utterance reference in global Set to prevent GC
        retainedUtterances.add(utterance);

        utterance.onstart = () => {
          lastAudioActivityRef.current = Date.now();
        };

        utterance.onboundary = (e) => {
          if (sessionId !== currentSessionIdRef.current) return;
          lastAudioActivityRef.current = Date.now();
          if (typeof e.charIndex === 'number') {
            currentCharIndexRef.current = alignedOffset + e.charIndex;
          }
        };

        utterance.onend = () => {
          retainedUtterances.delete(utterance);
          lastAudioActivityRef.current = Date.now();

          if (sessionId !== currentSessionIdRef.current) return;
          if (speakingStateRef.current !== 'speaking') return;

          // 40ms inter-chunk breather: allows mobile audio thread to cleanly
          // cycle buffers without cutting off audio or dropping the next utterance
          isAdvancingChunkRef.current = true;
          advancingTimeoutRef.current = setTimeout(() => {
            advancingTimeoutRef.current = null;
            isAdvancingChunkRef.current = false;
            if (sessionId !== currentSessionIdRef.current) return;
            if (speakingStateRef.current === 'speaking') {
              speakChunk(index + 1, sessionId, 0);
            }
          }, 40);
        };

        utterance.onerror = (e) => {
          retainedUtterances.delete(utterance);
          if (sessionId !== currentSessionIdRef.current) return;

          // Check if cancelled/interrupted intentionally or unexpectedly
          if (e.error === 'canceled' || e.error === 'interrupted') {
            if (speakingStateRef.current !== 'speaking') return;

            // Unexpected system interruption (e.g. mobile incoming call or OS audio grab)
            console.warn('Speech playback interrupted by system:', e.error);
            captureCurrentPosition();
            setSpeakingStateSync('paused');
            return;
          }

          console.warn('SpeechSynthesisUtterance error:', e.error);
          setSpeechError(`Speech playback error: ${e.error}`);
          setSpeakingStateSync('error');
        };

        // Resume engine if stuck in paused state prior to speak
        if (window.speechSynthesis.paused) {
          try {
            window.speechSynthesis.resume();
          } catch (_) {}
        }

        window.speechSynthesis.speak(utterance);
      } catch (err) {
        console.warn('Speech synthesis execution failed:', err);
        setSpeechError('Unable to start speech synthesis in this browser.');
        setSpeakingStateSync('error');
      }
    },
    [isSupported, handleNaturalCompletion, captureCurrentPosition, setSpeakingStateSync]
  );

  /**
   * Pauses active speech synthesis and accurately preserves position.
   */
  const pauseSpeech = useCallback(() => {
    if (!isSupported) return;
    if (speakingStateRef.current !== 'speaking') return;

    // Invalidate active session callbacks
    currentSessionIdRef.current += 1;

    if (advancingTimeoutRef.current) {
      clearTimeout(advancingTimeoutRef.current);
      advancingTimeoutRef.current = null;
    }
    isAdvancingChunkRef.current = false;

    // Capture reading position
    captureCurrentPosition();

    // Cancel active utterance so mobile hardware audio channel is cleanly released
    try {
      window.speechSynthesis.cancel();
      if (window.speechSynthesis.paused) {
        window.speechSynthesis.resume();
      }
    } catch (_) {}

    setSpeakingStateSync('paused');
  }, [isSupported, captureCurrentPosition, setSpeakingStateSync]);

  /**
   * Resumes paused speech synthesis from the exact saved chunk and character offset.
   */
  const resumeSpeech = useCallback(() => {
    if (!isSupported) return;
    const activeMsgId = currentMessageIdRef.current;
    if (!activeMsgId) return;

    const saved = readingPositionsRef.current[activeMsgId];
    const chunkIdx = saved?.chunkIndex ?? currentChunkIndexRef.current ?? 0;
    const charOff = saved?.charOffset ?? currentCharIndexRef.current ?? 0;

    // Assign new session ID for resumption
    const sessionId = ++currentSessionIdRef.current;

    setSpeakingStateSync('speaking');
    setSpeechError(null);

    // Clean cancellation of any lingering audio
    try {
      window.speechSynthesis.cancel();
      if (window.speechSynthesis.paused) {
        window.speechSynthesis.resume();
      }
    } catch (_) {}

    // 40ms timeout ensures cancel has completed before speaking on mobile
    if (pendingSpeakTimerRef.current) {
      clearTimeout(pendingSpeakTimerRef.current);
    }
    pendingSpeakTimerRef.current = setTimeout(() => {
      pendingSpeakTimerRef.current = null;
      if (sessionId !== currentSessionIdRef.current) return;
      speakChunk(chunkIdx, sessionId, charOff);
    }, 40);
  }, [isSupported, setSpeakingStateSync, speakChunk]);

  /**
   * Stops active speech synthesis.
   * If `preservePosition` is true, stores the active reading position in `readingPositions`.
   * If false, resets the reading position so subsequent playback starts from the beginning.
   *
   * @param {boolean} [preservePosition=false] - Whether to capture the current reading position
   */
  const stopSpeech = useCallback((preservePosition = false) => {
    const activeMsgId = currentMessageIdRef.current;

    // Invalidate in-flight playback sessions
    currentSessionIdRef.current += 1;

    if (pendingSpeakTimerRef.current) {
      clearTimeout(pendingSpeakTimerRef.current);
      pendingSpeakTimerRef.current = null;
    }
    if (advancingTimeoutRef.current) {
      clearTimeout(advancingTimeoutRef.current);
      advancingTimeoutRef.current = null;
    }
    isAdvancingChunkRef.current = false;

    if (preservePosition && activeMsgId && activeMsgId !== 'settings-preview') {
      captureCurrentPosition();
      setSpeakingStateSync('paused');
    } else {
      if (activeMsgId) {
        removeReadingPosition(activeMsgId);
      }
      setSpeakingStateSync('idle');
      setCurrentMessageIdSync(null);
    }

    chunksRef.current = [];
    currentChunkIndexRef.current = 0;
    currentCharIndexRef.current = 0;
    currentChunkStartOffsetRef.current = 0;
    activeCleanedTextRef.current = '';
    retainedUtterances.clear();

    if (isSupported) {
      try {
        window.speechSynthesis.cancel();
        if (window.speechSynthesis.paused) {
          window.speechSynthesis.resume();
        }
      } catch (_) {}
    }

    setSpeechError(null);
  }, [isSupported, captureCurrentPosition, removeReadingPosition, setSpeakingStateSync, setCurrentMessageIdSync]);

  /**
   * Resets reading position for a specific message and stops playback if active.
   *
   * @param {string} messageId - Message to reset
   */
  const resetMessageSpeech = useCallback((messageId) => {
    if (!messageId) return;

    if (currentMessageIdRef.current === messageId) {
      stopSpeech(false);
    }

    removeReadingPosition(messageId);
  }, [stopSpeech, removeReadingPosition]);

  /**
   * Begins reading aloud an assistant message or settings voice preview.
   * If the message has a saved reading position and `fromStart` is not requested,
   * resumes from the saved position rather than restarting.
   *
   * @param {string} messageId - The unique identifier of the message (or 'settings-preview')
   * @param {string} rawMarkdown - The Markdown or plain text content to clean and read
   * @param {boolean} [fromStart=false] - If true, clears any saved position and reads from the beginning
   */
  const playMessage = useCallback(
    (messageId, rawMarkdown, fromStart = false) => {
      if (!isSupported) {
        setSpeechError('Text-to-speech is not supported by your browser.');
        setSpeakingStateSync('error');
        return;
      }

      // If already speaking this exact message, pausing preserves position
      if (currentMessageIdRef.current === messageId && speakingStateRef.current === 'speaking' && !fromStart) {
        pauseSpeech();
        return;
      }

      // If another response was playing, preserve its position
      if (currentMessageIdRef.current && currentMessageIdRef.current !== messageId) {
        stopSpeech(true);
      }

      // Clear any pending speak or advance timers
      if (pendingSpeakTimerRef.current) {
        clearTimeout(pendingSpeakTimerRef.current);
        pendingSpeakTimerRef.current = null;
      }
      if (advancingTimeoutRef.current) {
        clearTimeout(advancingTimeoutRef.current);
        advancingTimeoutRef.current = null;
      }
      isAdvancingChunkRef.current = false;
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
        setSpeakingStateSync('error');
        return;
      }

      const chunks = splitTextIntoSpeechChunks(cleaned);
      if (chunks.length === 0) {
        return;
      }

      // Determine starting chunk and offset based on saved position
      let startChunk = 0;
      let startOffset = 0;

      const saved = readingPositionsRef.current[messageId];
      if (!fromStart && saved && saved.cleanedText === cleaned) {
        startChunk = Math.min(chunks.length - 1, Math.max(0, saved.chunkIndex || 0));
        startOffset = Math.max(0, saved.charOffset || 0);
      } else if (fromStart) {
        removeReadingPosition(messageId);
      }

      // Assign new session ID for this playback sequence
      const sessionId = ++currentSessionIdRef.current;

      chunksRef.current = chunks;
      activeCleanedTextRef.current = cleaned;
      currentChunkIndexRef.current = startChunk;
      currentChunkStartOffsetRef.current = startOffset;
      currentCharIndexRef.current = startOffset;

      setCurrentMessageIdSync(messageId);
      setSpeakingStateSync('speaking');
      setSpeechError(null);

      // 50ms breather allows mobile browser audio queue to clear cleanly after cancel()
      pendingSpeakTimerRef.current = setTimeout(() => {
        pendingSpeakTimerRef.current = null;
        if (sessionId !== currentSessionIdRef.current) return;
        speakChunk(startChunk, sessionId, startOffset);
      }, 50);
    },
    [
      isSupported,
      pauseSpeech,
      stopSpeech,
      removeReadingPosition,
      setCurrentMessageIdSync,
      setSpeakingStateSync,
      speakChunk
    ]
  );

  /**
   * Toggle Play / Pause / Resume for a given message.
   */
  const toggleSpeech = useCallback(
    (messageId, rawMarkdown) => {
      if (currentMessageIdRef.current === messageId) {
        if (speakingStateRef.current === 'speaking') {
          pauseSpeech();
        } else if (speakingStateRef.current === 'paused') {
          resumeSpeech();
        } else {
          playMessage(messageId, rawMarkdown, false);
        }
      } else {
        playMessage(messageId, rawMarkdown, false);
      }
    },
    [playMessage, pauseSpeech, resumeSpeech]
  );

  // Safe non-destructive Watchdog: detects stalled mobile TTS queues or dropped onend
  useEffect(() => {
    if (!isSupported) return;

    const watchdogInterval = setInterval(() => {
      if (speakingStateRef.current !== 'speaking') return;
      if (isAdvancingChunkRef.current) return;

      const isSpeaking = window.speechSynthesis.speaking;
      const isPending = window.speechSynthesis.pending;
      const silentDuration = Date.now() - lastAudioActivityRef.current;

      // If browser completely stopped speaking without firing onend (after at least 1.5s silence)
      if (!isSpeaking && !isPending && silentDuration > 1500) {
        const chunks = chunksRef.current;
        const currentIdx = currentChunkIndexRef.current;

        if (currentIdx >= chunks.length - 1) {
          handleNaturalCompletion();
        } else {
          console.warn('Speech engine stalled between utterances. Recovering...');
          speakChunk(currentIdx + 1, currentSessionIdRef.current, 0);
        }
      }
    }, 1000);

    return () => clearInterval(watchdogInterval);
  }, [isSupported, speakChunk, handleNaturalCompletion]);

  // Mobile PWA Lifecycle: Pause speech when app is backgrounded or screen locked
  useEffect(() => {
    if (!isSupported) return;

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        if (speakingStateRef.current === 'speaking') {
          // Pause and preserve position so user can resume when reopening app
          pauseSpeech();
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [isSupported, pauseSpeech]);

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
      if (advancingTimeoutRef.current) {
        clearTimeout(advancingTimeoutRef.current);
        advancingTimeoutRef.current = null;
      }
      retainedUtterances.clear();
      if (isSupported) {
        try {
          window.speechSynthesis.cancel();
        } catch (_) {}
      }
    };
  }, [isSupported]);

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
    speakingState, // 'idle' | 'speaking' | 'paused' | 'completed' | 'error'
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
    toggleSpeech,
    resetMessageSpeech,
    hasSavedPosition,
    readingPositions,
    // Convenience flags for backwards compatibility
    isPlaying: speakingState === 'speaking',
    isPaused: speakingState === 'paused'
  };

  return <SpeechContext.Provider value={value}>{children}</SpeechContext.Provider>;
}
