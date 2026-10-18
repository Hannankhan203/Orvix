import React, { useRef, useEffect, useState } from 'react';
import {
  ArrowUp,
  Mic,
  Square,
  AlertCircle,
  X,
  Check,
  Pause,
  Play,
  ChevronDown,
  Sparkles,
  Loader2,
  Globe
} from 'lucide-react';
import WelcomeScreen from './WelcomeScreen.jsx';
import MessageList from './MessageList.jsx';
import Button from '../ui/Button.jsx';
import { useVoiceDictation } from '../../hooks/useVoiceDictation.js';
import { sendAIMessage } from '../../services/aiRouter.js';

/**
 * ChatArea Component
 * Coordinates the scrollable message stream / welcome state,
 * error retries, and the fixed bottom message composer with professional voice dictation.
 *
 * @param {Object} props
 * @param {Array} props.messages
 * @param {boolean} [props.isLoading=false]
 * @param {string} props.inputValue
 * @param {(val: string) => void} props.onInputChange
 * @param {() => void} props.onSubmit
 * @param {string|null} [props.activeTitle=null]
 * @param {(failedMessage: Object) => void} [props.onRetry]
 * @param {(promptText: string) => void} [props.onRestorePrompt]
 * @param {string} [props.selectedProvider='gemini']
 */
export default function ChatArea({
  messages = [],
  isLoading = false,
  messagesLoading = false,
  isNewChat = true,
  username = null,
  inputValue = '',
  onInputChange,
  onSubmit,
  activeTitle = null,
  onRetry,
  onRestorePrompt,
  onRegenerate,
  onStopGenerating,
  selectedProvider = 'gemini'
}) {
  const textareaRef = useRef(null);
  const langMenuRef = useRef(null);

  // Language dropdown toggle state
  const [langMenuOpen, setLangMenuOpen] = useState(false);

  // AI Transcript Refinement (Phase 4) state
  const [isCleaningTranscript, setIsCleaningTranscript] = useState(false);
  const [suggestedRefinement, setSuggestedRefinement] = useState(null);

  // Hook into upgraded speech recognition engine
  const {
    recordingState,
    isListening,
    isPaused,
    isRequesting,
    isSupported,
    dictationError,
    interimTranscript,
    lastSessionTranscript,
    selectedLanguage,
    setSelectedLanguage,
    supportedLanguages,
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
  } = useVoiceDictation({
    inputValue,
    onInputChange
  });

  const activeLang =
    supportedLanguages.find((l) => l.code === selectedLanguage) || supportedLanguages[0];

  // Close language menu when clicking outside
  useEffect(() => {
    if (!langMenuOpen) return;
    const handleClickOutside = (e) => {
      if (langMenuRef.current && !langMenuRef.current.contains(e.target)) {
        setLangMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [langMenuOpen]);

  // Auto-resize textarea according to text length
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      const newHeight = Math.min(textareaRef.current.scrollHeight, 180);
      textareaRef.current.style.height = `${Math.max(newHeight, 44)}px`;
    }
  }, [inputValue]);

  const handlePromptSelect = (promptText) => {
    if (onInputChange) {
      onInputChange(promptText);
    }
    if (textareaRef.current) {
      textareaRef.current.focus();
      try {
        const len = (promptText || '').length;
        textareaRef.current.setSelectionRange(len, len);
      } catch (_) {}
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Escape' && isLoading && onStopGenerating) {
      e.preventDefault();
      onStopGenerating();
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (recordingState !== 'idle') {
        stopListening();
      }
      clearLastSessionTranscript();
      setSuggestedRefinement(null);
      if (onSubmit && inputValue.trim() && !isLoading) {
        onSubmit();
      }
    }
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (recordingState !== 'idle') {
      stopListening();
    }
    clearLastSessionTranscript();
    setSuggestedRefinement(null);
    if (onSubmit && inputValue.trim() && !isLoading) {
      onSubmit();
    }
  };

  // Optional AI Transcript Refinement Handler (Phase 4)
  const handleImproveTranscript = async () => {
    if (!lastSessionTranscript || isCleaningTranscript) return;
    setIsCleaningTranscript(true);

    try {
      const cleanPrompt = `You are a specialized speech-to-text transcript polisher.
Improve punctuation, capitalization, and obvious speech recognition phonetic glitches in the provided spoken transcript.

STRICT CONSTRAINTS:
1. Preserve the speaker's exact meaning, words, names, and technical terms.
2. DO NOT summarize, rewrite, or add any commentary.
3. DO NOT translate (if Urdu, keep Urdu; if English, keep English).
4. Return ONLY the refined transcript text and nothing else.

Transcript:
"${lastSessionTranscript}"`;

      const res = await sendAIMessage({
        provider: selectedProvider || 'gemini',
        prompt: cleanPrompt,
        history: [],
        username: null
      });

      if (res && res.text) {
        const polished = res.text.replace(/^["']|["']$/g, '').trim();
        setSuggestedRefinement(polished);
      }
    } catch (err) {
      console.warn('Transcript refinement failed:', err);
    } finally {
      setIsCleaningTranscript(false);
    }
  };

  const handleApplyRefinement = () => {
    if (!suggestedRefinement) return;

    if (inputValue.includes(lastSessionTranscript)) {
      onInputChange(inputValue.replace(lastSessionTranscript, suggestedRefinement));
    } else {
      onInputChange(suggestedRefinement);
    }

    setSuggestedRefinement(null);
    clearLastSessionTranscript();
  };

  const hasContent = inputValue.trim().length > 0;
  const hasMessages = messages.length > 0;
  const isRecordingActive = recordingState !== 'idle';

  return (
    <main className="chat-area-container" role="main">
      {/* Scrollable Viewport */}
      <div className="chat-scroll-viewport">
        <div className="chat-content-constrained">
          {isNewChat && !hasMessages ? (
            <WelcomeScreen onSelectPrompt={handlePromptSelect} username={username} />
          ) : messagesLoading && !hasMessages ? (
            <div className="messages-loading-state" role="status" aria-label="Loading conversation">
              <Loader2 size={24} className="spin-icon" />
              <span>Loading conversation...</span>
            </div>
          ) : (
            <MessageList
              messages={messages}
              isLoading={isLoading}
              onRetry={onRetry}
              onRestorePrompt={onRestorePrompt}
              onRegenerate={onRegenerate}
              onStopGenerating={onStopGenerating}
            />
          )}
        </div>
      </div>

      {/* Message Composer Dock */}
      <div className="chat-composer-dock">
        <div className="chat-composer-inner">
          {/* Voice Dictation Error Notification */}
          {dictationError && (
            <div className="composer-dictation-error" role="alert">
              <div className="dictation-error-content">
                <AlertCircle size={14} className="dictation-error-icon" aria-hidden="true" />
                <span>{dictationError}</span>
              </div>
              <button
                type="button"
                className="dictation-error-dismiss"
                onClick={clearDictationError}
                aria-label="Dismiss error notification"
              >
                <X size={13} />
              </button>
            </div>
          )}

          {/* Professional ChatGPT-Style Active Dictation Dock */}
          {isRecordingActive && (
            <div
              className={`composer-listening-bar state-${recordingState}`}
              role="status"
              aria-live="polite"
            >
              <div className="listening-left-group">
                <div className="listening-indicator-content">
                  <span className={`listening-pulse-dot ${recordingState}`} aria-hidden="true" />
                  <div
                    className="listening-soundwave"
                    aria-hidden="true"
                    title={`Microphone audio level: ${audioLevel}%`}
                  >
                    {audioFrequencies.map((freq, idx) => (
                      <span
                        key={idx}
                        className="soundwave-bar dynamic"
                        style={{
                          height: `${Math.max(5, Math.round(freq * 20))}px`,
                          opacity: Math.max(0.4, Math.min(1, freq * 1.2))
                        }}
                      />
                    ))}
                  </div>
                  <span className="listening-text">
                    {recordingState === 'requesting'
                      ? 'Connecting mic...'
                      : recordingState === 'paused'
                      ? 'Paused'
                      : recordingState === 'finalizing'
                      ? 'Finalizing...'
                      : 'Listening...'}
                  </span>
                </div>

                {/* Recognition Language Selector Pill */}
                <div className="dictation-lang-wrapper" ref={langMenuRef}>
                  <button
                    type="button"
                    className="dictation-lang-btn"
                    onClick={() => setLangMenuOpen((prev) => !prev)}
                    title={`Dictation language: ${activeLang.label}. Click to switch.`}
                    aria-label="Select dictation language"
                    aria-expanded={langMenuOpen}
                  >
                    <span className="lang-flag">{activeLang.flag}</span>
                    <span className="lang-code">{activeLang.code.split('-')[0].toUpperCase()}</span>
                    <ChevronDown size={12} className={`lang-chevron ${langMenuOpen ? 'open' : ''}`} />
                  </button>

                  {langMenuOpen && (
                    <div className="dictation-lang-dropdown" role="menu">
                      <div className="lang-dropdown-header">Recognition Language</div>
                      {supportedLanguages.map((lang) => (
                        <button
                          key={lang.code}
                          type="button"
                          role="menuitem"
                          className={`dictation-lang-option ${lang.code === selectedLanguage ? 'active' : ''}`}
                          onClick={() => {
                            setSelectedLanguage(lang.code);
                            setLangMenuOpen(false);
                          }}
                        >
                          <span className="lang-opt-flag">{lang.flag}</span>
                          <div className="lang-opt-info">
                            <span className="lang-opt-label">{lang.label}</span>
                            <span className="lang-opt-native">{lang.native}</span>
                          </div>
                          {lang.code === selectedLanguage && <Check size={14} className="lang-check" />}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Interim Transcript Live Preview */}
              <div className="listening-preview-area" title={interimTranscript || 'Live speech preview'}>
                {interimTranscript ? (
                  <span className="live-speech-bubble">"{interimTranscript}"</span>
                ) : (
                  <span className="live-speech-placeholder">
                    {recordingState === 'paused' ? 'Speech paused' : 'Speak clearly...'}
                  </span>
                )}
              </div>

              {/* Controls: Pause/Resume, Cancel, Done */}
              <div className="listening-actions-group">
                {recordingState === 'listening' ? (
                  <button
                    type="button"
                    className="listening-action-btn pause-btn"
                    onClick={pauseListening}
                    title="Pause dictation"
                    aria-label="Pause dictation"
                  >
                    <Pause size={13} />
                    <span>Pause</span>
                  </button>
                ) : recordingState === 'paused' ? (
                  <button
                    type="button"
                    className="listening-action-btn resume-btn"
                    onClick={resumeListening}
                    title="Resume dictation"
                    aria-label="Resume dictation"
                  >
                    <Play size={13} fill="currentColor" />
                    <span>Resume</span>
                  </button>
                ) : null}

                <button
                  type="button"
                  className="listening-action-btn cancel-btn"
                  onClick={cancelListening}
                  title="Cancel voice input (discards speech from this session)"
                  aria-label="Cancel dictation"
                >
                  <X size={13} />
                  <span>Cancel</span>
                </button>

                <button
                  type="button"
                  className="listening-action-btn done-btn"
                  onClick={stopListening}
                  title="Done — keep text in composer"
                  aria-label="Finish dictation"
                >
                  <Check size={13} />
                  <span>Done</span>
                </button>
              </div>
            </div>
          )}

          {/* Optional AI Transcript Refinement Notification (Phase 4) */}
          {lastSessionTranscript && !isRecordingActive && !suggestedRefinement && (
            <div className="transcript-cleanup-banner" role="region" aria-label="Transcript helper">
              <div className="cleanup-banner-left">
                <Sparkles size={13} className="cleanup-icon" />
                <span className="cleanup-hint">Dictated speech recorded:</span>
                <span className="cleanup-snippet">
                  "{lastSessionTranscript.length > 46 ? lastSessionTranscript.slice(0, 46) + '...' : lastSessionTranscript}"
                </span>
              </div>
              <div className="cleanup-banner-actions">
                <button
                  type="button"
                  className="cleanup-action-trigger"
                  onClick={handleImproveTranscript}
                  disabled={isCleaningTranscript}
                  title="Use AI to polish punctuation and capitalization without changing words or translating"
                >
                  {isCleaningTranscript ? (
                    <Loader2 size={12} className="spin-icon" />
                  ) : (
                    <Sparkles size={12} />
                  )}
                  <span>{isCleaningTranscript ? 'Polishing...' : 'Improve transcript'}</span>
                </button>
                <button
                  type="button"
                  className="cleanup-dismiss-btn"
                  onClick={clearLastSessionTranscript}
                  title="Dismiss helper"
                  aria-label="Dismiss transcript helper"
                >
                  <X size={12} />
                </button>
              </div>
            </div>
          )}

          {/* AI Refinement Comparison Card (Phase 4) */}
          {suggestedRefinement && (
            <div className="transcript-review-card" role="dialog" aria-labelledby="review-card-title">
              <div className="review-card-header">
                <div className="review-header-left">
                  <Sparkles size={14} className="review-icon" />
                  <span id="review-card-title" className="review-title">Review Transcript Polish</span>
                </div>
                <button
                  type="button"
                  className="review-close-btn"
                  onClick={() => setSuggestedRefinement(null)}
                  aria-label="Close review"
                >
                  <X size={14} />
                </button>
              </div>

              <div className="review-card-body">
                <div className="review-field">
                  <span className="field-label">Original:</span>
                  <p className="field-content original-text">{lastSessionTranscript}</p>
                </div>
                <div className="review-field">
                  <span className="field-label">Suggested Polish:</span>
                  <p className="field-content suggested-text">{suggestedRefinement}</p>
                </div>
              </div>

              <div className="review-card-actions">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setSuggestedRefinement(null);
                    clearLastSessionTranscript();
                  }}
                >
                  Keep original
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleApplyRefinement}
                  icon={<Check size={13} />}
                >
                  Apply Polish
                </Button>
              </div>
            </div>
          )}

          <form onSubmit={handleSubmit} className="composer-form" aria-label="Message composer">
            <textarea
              ref={textareaRef}
              className="composer-textarea"
              placeholder={
                isListening
                  ? 'Listening to speech...'
                  : isPaused
                  ? 'Dictation paused — speak or type...'
                  : isLoading
                  ? 'Orvix is responding...'
                  : 'Ask Orvix anything...'
              }
              value={inputValue}
              rows={1}
              onChange={(e) => onInputChange && onInputChange(e.target.value)}
              onKeyDown={handleKeyDown}
              aria-label="Message input text"
            />

            <div className="composer-actions">
              {/* Voice Dictation Microphone Button */}
              <Button
                type="button"
                variant={isListening ? 'primary' : 'ghost'}
                size="icon-round"
                disabled={isLoading}
                onClick={toggleListening}
                title={
                  !isSupported
                    ? 'Voice dictation is not supported in this browser'
                    : isListening
                    ? 'Stop listening (Voice dictation active)'
                    : isPaused
                    ? 'Resume listening (Voice dictation paused)'
                    : `Dictate message (${activeLang.label})`
                }
                ariaLabel={
                  isListening
                    ? 'Stop listening'
                    : isPaused
                    ? 'Resume dictation'
                    : 'Start voice dictation'
                }
                className={`composer-mic-btn ${isListening ? 'listening' : isPaused ? 'paused' : ''}`}
                icon={
                  isListening ? (
                    <Square size={13} fill="currentColor" />
                  ) : isPaused ? (
                    <Play size={13} fill="currentColor" />
                  ) : (
                    <Mic size={18} />
                  )
                }
              />

              {/* Message Submission or Stop Generating Button */}
              {isLoading ? (
                <Button
                  type="button"
                  variant="outline"
                  size="icon-round"
                  onClick={onStopGenerating}
                  title="Stop generating response (Esc)"
                  ariaLabel="Stop generating response"
                  className="composer-stop-btn"
                  icon={<Square size={13} fill="currentColor" />}
                />
              ) : (
                <Button
                  type="submit"
                  variant={hasContent ? 'primary' : 'ghost'}
                  size="icon-round"
                  disabled={!hasContent}
                  title="Send message (Enter)"
                  ariaLabel="Send message"
                  className="composer-send-btn"
                  icon={<ArrowUp size={18} />}
                />
              )}
            </div>
          </form>

          <p className="composer-footnote">
            {selectedProvider === 'groq'
              ? 'Orvix is powered by Groq (Llama 3.3 70B). Ultra-fast inference — verify important facts independently.'
              : selectedProvider === 'openrouter'
              ? 'Orvix is powered by OpenRouter (Llama 3.3 70B Free). Multi-model gateway — verify important facts independently.'
              : 'Orvix is powered by Google Gemini (Gemini 3.1 Flash Lite). Client integration — verify important facts independently.'}
          </p>
        </div>
      </div>
    </main>
  );
}
