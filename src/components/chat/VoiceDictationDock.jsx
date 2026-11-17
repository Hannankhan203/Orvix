import React from 'react';
import {
  Mic,
  Square,
  Check,
  X,
  Pause,
  Play,
  ChevronDown,
  Loader2
} from 'lucide-react';

/**
 * VoiceDictationDock Component
 * Modern recording dock with animated waveform visualizer, recording timer,
 * recognition language picker, and control buttons (Pause, Resume, Stop, Cancel).
 */
export default function VoiceDictationDock({
  recordingState,
  isListening = false,
  isPaused = false,
  isRequesting = false,
  isStreamingWebSocket = false,
  formattedDuration = '00:00',
  audioLevel = 0,
  waveformBars = [],
  activeLang,
  supportedLanguages = [],
  selectedLanguage,
  langMenuOpen = false,
  langMenuRef,
  isPublicSharedViewer = false,
  isComposerBlocked = false,
  onToggleLangMenu,
  onSelectLanguage,
  onPauseListening,
  onResumeListening,
  onStopListening,
  onCancelListening
}) {
  return (
    <div
      className={`composer-listening-bar state-${recordingState}`}
      role="region"
      aria-label="Voice dictation controls"
    >
      <div className="listening-left-group">
        <div className="listening-indicator-content">
          <div className={`listening-mic-badge ${recordingState}`} aria-hidden="true">
            {recordingState === 'requesting' ||
            recordingState === 'stopping' ||
            recordingState === 'transcribing' ||
            recordingState === 'finalizing' ? (
              <Loader2 size={13} className="spin-icon" />
            ) : recordingState === 'listening' ? (
              <span className="recording-dot-pulse" />
            ) : recordingState === 'success' ? (
              <Check size={13} strokeWidth={2.5} className="badge-icon success" />
            ) : recordingState === 'cancelled' ? (
              <X size={13} className="badge-icon cancelled" />
            ) : (
              <Mic size={13} />
            )}
          </div>
          <span className="listening-text">
            {recordingState === 'requesting'
              ? 'Connecting...'
              : recordingState === 'paused'
              ? 'Paused'
              : recordingState === 'stopping'
              ? 'Stopping...'
              : recordingState === 'transcribing'
              ? 'Transcribing...'
              : recordingState === 'finalizing'
              ? 'Finishing...'
              : recordingState === 'success'
              ? 'Transcript ready'
              : recordingState === 'cancelled'
              ? 'Cancelled'
              : isStreamingWebSocket
              ? 'Live Streaming'
              : 'Recording'}
          </span>
          <span className="listening-timer" aria-label={`Recording duration: ${formattedDuration}`}>
            {formattedDuration}
          </span>
        </div>

        {/* Recognition Language Selector Pill */}
        {(() => {
          const isTerminalState =
            recordingState === 'stopping' ||
            recordingState === 'transcribing' ||
            recordingState === 'finalizing' ||
            recordingState === 'success' ||
            recordingState === 'cancelled';
          const isLangDisabled = Boolean(isPublicSharedViewer || isComposerBlocked || isTerminalState);
          const resolvedLang =
            (selectedLanguage && supportedLanguages.find((l) => l.code === selectedLanguage)) ||
            activeLang ||
            supportedLanguages[0];
          const currentSelectedCode = selectedLanguage || resolvedLang?.code || 'en-US';

          return (
            <div
              className={`dictation-lang-wrapper ${isLangDisabled ? 'disabled' : ''}`}
              ref={langMenuRef}
              title={
                isPublicSharedViewer
                  ? 'Voice dictation language selection is disabled in public read-only mode'
                  : isComposerBlocked
                  ? 'Voice dictation language selection is disabled while generating or read-only'
                  : undefined
              }
            >
              <button
                type="button"
                disabled={isLangDisabled}
                className={`dictation-lang-btn ${isLangDisabled ? 'disabled' : ''}`}
                onClick={() => !isLangDisabled && onToggleLangMenu?.()}
                title={
                  isPublicSharedViewer
                    ? 'Voice dictation language selection is disabled in public read-only mode'
                    : isComposerBlocked
                    ? 'Voice dictation language selection is disabled while generating or read-only'
                    : isTerminalState
                    ? 'Cannot change language while finalizing dictation'
                    : `Dictation language: ${resolvedLang?.label || 'English'}. Click to switch.`
                }
                aria-label={
                  isPublicSharedViewer
                    ? 'Voice dictation language selection is disabled in public read-only mode'
                    : `Select dictation language, currently ${resolvedLang?.label || 'English'}`
                }
                aria-disabled={isLangDisabled}
                aria-expanded={!isLangDisabled && langMenuOpen}
                aria-haspopup="menu"
              >
                <span className="lang-flag">{resolvedLang?.flag || '🇺🇸'}</span>
                <span className="lang-code">
                  {(resolvedLang?.code || currentSelectedCode || 'en').split('-')[0].toUpperCase()}
                </span>
                <ChevronDown
                  size={11}
                  className={`lang-chevron ${!isLangDisabled && langMenuOpen ? 'open' : ''}`}
                />
              </button>

              {!isLangDisabled && langMenuOpen && (
                <div className="dictation-lang-dropdown" role="menu" aria-label="Recognition Language">
                  <div className="lang-dropdown-header">Recognition Language</div>
                  {supportedLanguages.map((lang) => (
                    <button
                      key={lang.code}
                      type="button"
                      role="menuitem"
                      className={`dictation-lang-option ${lang.code === currentSelectedCode ? 'active' : ''}`}
                      onClick={() => onSelectLanguage?.(lang.code)}
                    >
                      <span className="lang-opt-flag">{lang.flag}</span>
                      <div className="lang-opt-info">
                        <span className="lang-opt-label">{lang.label}</span>
                        <span className="lang-opt-native">{lang.native}</span>
                      </div>
                      {lang.code === currentSelectedCode && <Check size={14} className="lang-check" />}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })()}
      </div>

      {/* Real Waveform Visualizer */}
      <div
        className="listening-waveform-area"
        aria-hidden="true"
        title={isListening ? `Microphone audio level: ${audioLevel}%` : 'Microphone audio visualizer'}
      >
        <div className="waveform-visualizer">
          {waveformBars.map((barVal, idx) => (
            <span
              key={idx}
              className={`waveform-bar ${isListening ? 'active' : ''}`}
              style={{
                height: isListening ? `${Math.max(4, Math.round(barVal * 24))}px` : '4px',
                opacity: isListening ? Math.max(0.35, Math.min(1, barVal * 1.5)) : 0.25
              }}
            />
          ))}
        </div>
      </div>

      {/* Action Buttons: Pause/Resume, Stop, Cancel */}
      <div className="listening-actions-group">
        {recordingState === 'stopping' || recordingState === 'transcribing' || recordingState === 'finalizing' ? (
          <button
            type="button"
            className="dictation-strip-btn cancel-btn"
            onClick={onCancelListening}
            title="Cancel transcription and discard audio"
            aria-label="Cancel transcription and discard audio"
          >
            <X size={13} className="btn-icon" aria-hidden="true" />
            <span className="btn-label">Cancel</span>
          </button>
        ) : recordingState === 'success' ? (
          <div className="dictation-status-pill success" aria-hidden="true">
            <Check size={12} strokeWidth={2.5} className="btn-icon" />
            <span className="btn-label">Inserted</span>
          </div>
        ) : recordingState === 'cancelled' ? (
          <div className="dictation-status-pill cancelled" aria-hidden="true">
            <X size={12} className="btn-icon" />
            <span className="btn-label">Discarded</span>
          </div>
        ) : (
          <>
            {recordingState === 'listening' ? (
              <button
                type="button"
                className="dictation-strip-btn pause-btn"
                onClick={onPauseListening}
                title="Pause recording"
                aria-label="Pause recording"
              >
                <Pause size={12} className="btn-icon" aria-hidden="true" />
                <span className="btn-label">Pause</span>
              </button>
            ) : recordingState === 'paused' ? (
              <button
                type="button"
                className="dictation-strip-btn resume-btn"
                onClick={onResumeListening}
                title="Resume recording"
                aria-label="Resume recording"
              >
                <Play size={12} fill="currentColor" className="btn-icon" aria-hidden="true" />
                <span className="btn-label">Resume</span>
              </button>
            ) : null}

            <button
              type="button"
              className="dictation-strip-btn stop-btn"
              onClick={onStopListening}
              title="Stop recording and insert transcript into composer"
              aria-label="Stop recording and insert transcript into composer"
            >
              <Square size={11} fill="currentColor" className="btn-icon" aria-hidden="true" />
              <span className="btn-label">Stop</span>
            </button>

            <button
              type="button"
              className="dictation-strip-btn cancel-btn"
              onClick={onCancelListening}
              title="Cancel recording (discard audio and keep existing text)"
              aria-label="Cancel recording and discard audio"
            >
              <X size={13} className="btn-icon" aria-hidden="true" />
              <span className="btn-label">Cancel</span>
            </button>
          </>
        )}
      </div>
    </div>
  );
}
