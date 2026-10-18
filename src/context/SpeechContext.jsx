import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { cleanTextForSpeech, splitTextIntoSpeechChunks, getWordBoundaryOffset } from '../utils/speechTextCleaner.js';

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
   * Stops active speech synthesis.
   * If `preservePosition` is true, accurately stores the active response's
   * chunk and character offset in `readingPositions` so reading can be resumed.
   *
   * @param {boolean} [preservePosition=true] - Whether to capture the current reading position
   */
  const stopSpeech = useCallback((preservePosition = true) => {
    const activeMsgId = currentMessageIdRef.current;

    // Capture reading position if user stopped playback mid-response
    if (preservePosition && activeMsgId && activeMsgId !== 'settings-preview') {
      const chunkIdx = currentChunkIndexRef.current;
      const charOff = currentCharIndexRef.current;
      const cleaned = activeCleanedTextRef.current;
      const totalChunks = chunksRef.current.length;
      const currentChunkText = chunksRef.current[chunkIdx] || '';

      // Only save if speech has not already reached the very end
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
    }

    // Invalidate any in-flight playback sessions
    currentSessionIdRef.current += 1;

    if (pendingSpeakTimerRef.current) {
      clearTimeout(pendingSpeakTimerRef.current);
      pendingSpeakTimerRef.current = null;
    }

    stopKeepAlive();
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

    setSpeakingStateSync('idle');
    setCurrentMessageIdSync(null);
    setSpeechError(null);
  }, [isSupported, stopKeepAlive, setSpeakingStateSync, setCurrentMessageIdSync, updateReadingPosition, removeReadingPosition]);

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

      // Invalidate if user switched speech session or stopped
      if (sessionId !== currentSessionIdRef.current) {
        return;
      }

      if (speakingStateRef.current !== 'playing') {
        return;
      }

      const chunks = chunksRef.current;
      if (index >= chunks.length) {
        // Finished speaking all message chunks naturally
        const msgId = currentMessageIdRef.current;
        if (msgId) {
          removeReadingPosition(msgId);
        }
        stopSpeech(false);
        return;
      }

      const fullChunk = chunks[index];
      let alignedOffset = 0;
      let textToSpeak = fullChunk;

      if (initialOffset > 0) {
        alignedOffset = getWordBoundaryOffset(fullChunk, initialOffset);
        // If aligned offset is at the end or remaining text is empty, advance to next chunk
        if (alignedOffset >= fullChunk.length - 2 || fullChunk.slice(alignedOffset).trim().length === 0) {
          speakChunk(index + 1, sessionId, 0);
          return;
        }
        textToSpeak = fullChunk.slice(alignedOffset).trim();
      }

      currentChunkIndexRef.current = index;
      currentChunkStartOffsetRef.current = alignedOffset;
      currentCharIndexRef.current = alignedOffset;

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

        utterance.onboundary = (e) => {
          if (sessionId !== currentSessionIdRef.current) return;
          if (typeof e.charIndex === 'number') {
            currentCharIndexRef.current = alignedOffset + e.charIndex;
          }
        };

        utterance.onend = () => {
          retainedUtterances.delete(utterance);
          if (sessionId !== currentSessionIdRef.current) return;
          if (speakingStateRef.current === 'playing') {
            // Subsequent chunks start from offset 0
            speakChunk(index + 1, sessionId, 0);
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
          stopSpeech(false);
        };

        window.speechSynthesis.speak(utterance);

        // Resume if browser got into stuck paused state
        if (window.speechSynthesis.paused) {
          window.speechSynthesis.resume();
        }
      } catch (err) {
        console.warn('Speech synthesis execution failed:', err);
        setSpeechError('Unable to start speech synthesis in this browser.');
        stopSpeech(false);
      }
    },
    [isSupported, stopSpeech, removeReadingPosition]
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
        // Fallback: re-speak from current chunk index and offset
        speakChunk(
          currentChunkIndexRef.current,
          currentSessionIdRef.current,
          currentCharIndexRef.current
        );
      }
    } catch (_) {
      speakChunk(
        currentChunkIndexRef.current,
        currentSessionIdRef.current,
        currentCharIndexRef.current
      );
    }
  }, [isSupported, startKeepAlive, setSpeakingStateSync, speakChunk]);

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
        return;
      }

      // If already playing this exact message, stopping it preserves reading position
      if (currentMessageIdRef.current === messageId && speakingStateRef.current === 'playing') {
        stopSpeech(true);
        return;
      }

      // If another response was playing, stop it and preserve its position
      if (currentMessageIdRef.current && currentMessageIdRef.current !== messageId) {
        stopSpeech(true);
      }

      // Stop any pending timer
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

      // Determine starting chunk and offset based on saved position
      let startChunk = 0;
      let startOffset = 0;

      const saved = readingPositionsRef.current[messageId];
      if (!fromStart && saved && saved.cleanedText === cleaned) {
        // Saved position is valid for this exact content
        startChunk = Math.min(chunks.length - 1, Math.max(0, saved.chunkIndex || 0));
        startOffset = Math.max(0, saved.charOffset || 0);
      } else if (fromStart) {
        // Explicit restart: clear saved position
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
      setSpeakingStateSync('playing');
      setSpeechError(null);

      startKeepAlive();

      // Small 30ms timeout allows the browser's speech queue to drain cleanly after cancel()
      pendingSpeakTimerRef.current = setTimeout(() => {
        pendingSpeakTimerRef.current = null;
        if (sessionId !== currentSessionIdRef.current) return;
        speakChunk(startChunk, sessionId, startOffset);
      }, 30);
    },
    [isSupported, stopKeepAlive, setCurrentMessageIdSync, setSpeakingStateSync, startKeepAlive, speakChunk, stopSpeech, removeReadingPosition]
  );

  /**
   * Toggle Play / Stop / Resume for a given message.
   */
  const toggleSpeech = useCallback(
    (messageId, rawMarkdown) => {
      if (currentMessageIdRef.current === messageId) {
        if (speakingStateRef.current === 'playing') {
          stopSpeech(true);
        } else {
          playMessage(messageId, rawMarkdown, false);
        }
      } else {
        playMessage(messageId, rawMarkdown, false);
      }
    },
    [playMessage, stopSpeech]
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
    toggleSpeech,
    resetMessageSpeech,
    hasSavedPosition,
    readingPositions
  };

  return <SpeechContext.Provider value={value}>{children}</SpeechContext.Provider>;
}
