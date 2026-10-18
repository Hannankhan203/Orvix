import React, { useRef, useEffect } from 'react';
import { ArrowUp, Mic, Square, AlertCircle, X } from 'lucide-react';
import WelcomeScreen from './WelcomeScreen.jsx';
import MessageList from './MessageList.jsx';
import Button from '../ui/Button.jsx';
import { useVoiceDictation } from '../../hooks/useVoiceDictation.js';

/**
 * ChatArea Component
 * Coordinates the scrollable message stream / empty welcome state,
 * error retries, and the fixed bottom message composer with voice dictation.
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
  inputValue = '',
  onInputChange,
  onSubmit,
  activeTitle = null,
  onRetry,
  onRestorePrompt,
  selectedProvider = 'gemini'
}) {
  const textareaRef = useRef(null);

  // Hook into browser speech recognition
  const {
    isListening,
    dictationError,
    isSupported,
    stopListening,
    toggleListening,
    clearDictationError
  } = useVoiceDictation({
    inputValue,
    onInputChange
  });

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
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (isListening) {
        stopListening();
      }
      if (onSubmit && inputValue.trim() && !isLoading) {
        onSubmit();
      }
    }
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (isListening) {
      stopListening();
    }
    if (onSubmit && inputValue.trim() && !isLoading) {
      onSubmit();
    }
  };

  const hasContent = inputValue.trim().length > 0;
  const hasMessages = messages.length > 0;

  return (
    <main className="chat-area-container" role="main">
      {/* Scrollable Viewport */}
      <div className="chat-scroll-viewport">
        <div className="chat-content-constrained">
          {!hasMessages ? (
            <WelcomeScreen onSelectPrompt={handlePromptSelect} />
          ) : (
            <MessageList
              messages={messages}
              isLoading={isLoading}
              onRetry={onRetry}
              onRestorePrompt={onRestorePrompt}
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

          {/* Active Listening Indicator */}
          {isListening && (
            <div className="composer-listening-bar" role="status" aria-live="polite">
              <div className="listening-indicator-content">
                <span className="listening-pulse-dot" aria-hidden="true" />
                <div className="listening-soundwave" aria-hidden="true">
                  <span className="soundwave-bar" />
                  <span className="soundwave-bar" />
                  <span className="soundwave-bar" />
                </div>
                <span className="listening-text">Listening... Speak now</span>
              </div>
              <button
                type="button"
                className="listening-stop-btn"
                onClick={stopListening}
                aria-label="Stop dictation"
              >
                Done
              </button>
            </div>
          )}

          <form onSubmit={handleSubmit} className="composer-form" aria-label="Message composer">
            <textarea
              ref={textareaRef}
              className="composer-textarea"
              placeholder={
                isListening
                  ? 'Listening to speech...'
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
                    : 'Dictate message (Speech to text)'
                }
                ariaLabel={isListening ? 'Stop listening' : 'Start voice dictation'}
                className={`composer-mic-btn ${isListening ? 'listening' : ''}`}
                icon={isListening ? <Square size={13} fill="currentColor" /> : <Mic size={18} />}
              />

              {/* Message Submission Button */}
              <Button
                type="submit"
                variant={hasContent && !isLoading ? 'primary' : 'ghost'}
                size="icon-round"
                disabled={!hasContent || isLoading}
                title={isLoading ? 'Orvix is responding...' : 'Send message (Enter)'}
                ariaLabel="Send message"
                className="composer-send-btn"
                icon={<ArrowUp size={18} />}
              />
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
