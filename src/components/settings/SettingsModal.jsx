import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  X,
  Sliders,
  Sun,
  Moon,
  Laptop,
  MessageSquare,
  Keyboard,
  Clock,
  RotateCcw,
  Check,
  Sparkles,
  Cloud,
  HardDrive,
  Info,
  AlertTriangle,
  Volume2,
  VolumeX,
  Play,
  Square,
  Globe
} from 'lucide-react';
import { useSettings } from '../../context/SettingsContext.jsx';
import { useSpeech } from '../../context/SpeechContext.jsx';
import { THEME_OPTIONS, RESPONSE_LENGTH_OPTIONS, CHAT_MODE_PREFERENCE_OPTIONS } from '../../services/userSettingsService.js';
import Button from '../ui/Button.jsx';

export default function SettingsModal() {
  const {
    settings,
    effectiveTheme,
    updateSettings,
    resetToDefaults,
    isSettingsModalOpen,
    closeSettingsModal,
    isSaving,
    saveFeedback,
    isRegisteredUser
  } = useSettings();

  const {
    isSupported: isSpeechSupported,
    voices,
    selectedVoiceURI,
    setSelectedVoiceURI,
    speechRate,
    setSpeechRate,
    playMessage,
    stopSpeech,
    speakingState,
    currentMessageId
  } = useSpeech();

  const [confirmReset, setConfirmReset] = useState(false);
  const modalRef = useRef(null);
  const closeBtnRef = useRef(null);

  const isPreviewActive = currentMessageId === 'settings-preview' && speakingState !== 'idle';

  // Synchronize settings if loaded from cloud or external source
  useEffect(() => {
    if (settings?.speechVoiceURI !== undefined && settings.speechVoiceURI !== selectedVoiceURI) {
      setSelectedVoiceURI(settings.speechVoiceURI);
    }
  }, [settings?.speechVoiceURI, selectedVoiceURI, setSelectedVoiceURI]);

  useEffect(() => {
    if (settings?.speechRate !== undefined && Math.abs(settings.speechRate - speechRate) > 0.01) {
      setSpeechRate(settings.speechRate);
    }
  }, [settings?.speechRate, speechRate, setSpeechRate]);

  const handleModalClose = useCallback(() => {
    if (currentMessageId === 'settings-preview') {
      stopSpeech();
    }
    closeSettingsModal();
  }, [currentMessageId, stopSpeech, closeSettingsModal]);

  // Close on Escape key
  useEffect(() => {
    if (!isSettingsModalOpen) {
      setConfirmReset(false);
      return;
    }

    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        if (confirmReset) {
          setConfirmReset(false);
        } else {
          handleModalClose();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isSettingsModalOpen, confirmReset, handleModalClose]);

  // Focus modal on open
  useEffect(() => {
    if (isSettingsModalOpen) {
      setTimeout(() => {
        closeBtnRef.current?.focus();
      }, 50);
    }
  }, [isSettingsModalOpen]);

  const handleVoiceChange = (e) => {
    const uri = e.target.value;
    setSelectedVoiceURI(uri);
    updateSettings({ speechVoiceURI: uri });
  };

  const handleSpeechRateChange = (rate) => {
    setSpeechRate(rate);
    updateSettings({ speechRate: rate });
  };

  const handleTogglePreviewVoice = () => {
    if (isPreviewActive) {
      stopSpeech();
    } else {
      playMessage(
        'settings-preview',
        'Hello! I am Orvix. This is a preview of the selected voice and speech rate.'
      );
    }
  };

  const handleThemeChange = (newTheme) => {
    updateSettings({ theme: newTheme });
  };

  const handleResponseLengthChange = (length) => {
    updateSettings({ responseLength: length });
  };

  const handleDefaultModeChange = (mode) => {
    updateSettings({ defaultMode: mode });
  };

  const handleToggleBeginnerFriendly = () => {
    updateSettings({ beginnerFriendly: !settings.beginnerFriendly });
  };

  const handleToggleEnterToSend = () => {
    updateSettings({ enterToSend: !settings.enterToSend });
  };

  const handleToggleShowTimestamps = () => {
    updateSettings({ showTimestamps: !settings.showTimestamps });
  };

  const handleConfirmReset = async () => {
    stopSpeech();
    setSpeechRate(1);
    setSelectedVoiceURI('');
    await resetToDefaults();
    setConfirmReset(false);
  };

  if (!isSettingsModalOpen) return null;

  return (
    <div
      className="settings-modal-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          handleModalClose();
        }
      }}
    >
      <div
        className="settings-modal-container"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-dialog-title"
        ref={modalRef}
      >
        {/* Modal Header */}
        <div className="settings-modal-header">
          <div className="settings-header-title-block">
            <div className="settings-header-icon-wrap" aria-hidden="true">
              <Sliders size={18} />
            </div>
            <div>
              <h2 id="settings-dialog-title" className="settings-modal-title">
                Personalization Settings
              </h2>
              <p className="settings-modal-subtitle">
                Customize appearance, AI response style, and composer behavior
              </p>
            </div>
          </div>

          <div className="settings-header-actions">
            {saveFeedback === 'saved' && (
              <span className="settings-save-pill success" role="status">
                <Check size={12} />
                <span>Saved</span>
              </span>
            )}
            {saveFeedback === 'reset' && (
              <span className="settings-save-pill info" role="status">
                <Check size={12} />
                <span>Reset to defaults</span>
              </span>
            )}

            <button
              ref={closeBtnRef}
              type="button"
              className="settings-close-btn"
              onClick={handleModalClose}
              title="Close settings (Esc)"
              aria-label="Close settings"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Modal Body */}
        <div className="settings-modal-body">
          {/* Storage Location Badge */}
          <div className="settings-storage-banner">
            {isRegisteredUser ? (
              <>
                <Cloud size={14} className="text-blue-400 shrink-0" aria-hidden="true" />
                <span>
                  Synchronized with your account & Cloud Firestore.
                </span>
              </>
            ) : (
              <>
                <HardDrive size={14} className="text-slate-400 shrink-0" aria-hidden="true" />
                <span>
                  Guest session: Preferences are stored locally on this device.
                </span>
              </>
            )}
          </div>

          {/* SECTION 1: Theme */}
          <section className="settings-section" aria-labelledby="section-theme-heading">
            <div className="settings-section-header">
              <div className="settings-section-title-wrap">
                <span className="settings-section-icon" aria-hidden="true">
                  {effectiveTheme === 'dark' ? <Moon size={15} /> : <Sun size={15} />}
                </span>
                <h3 id="section-theme-heading" className="settings-section-title">
                  Interface Theme
                </h3>
              </div>
              <span className="settings-current-val">
                Active: {effectiveTheme === 'dark' ? 'Dark mode' : 'Light mode'}
              </span>
            </div>

            <div className="settings-theme-grid" role="radiogroup" aria-label="Theme selection">
              {THEME_OPTIONS.map((opt) => {
                const isSelected = settings.theme === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    role="radio"
                    aria-checked={isSelected}
                    onClick={() => handleThemeChange(opt.id)}
                    className={`settings-theme-card ${isSelected ? 'active' : ''}`}
                  >
                    <div className="theme-card-icon-wrap" aria-hidden="true">
                      {opt.id === 'system' ? (
                        <Laptop size={18} />
                      ) : opt.id === 'dark' ? (
                        <Moon size={18} />
                      ) : (
                        <Sun size={18} />
                      )}
                    </div>
                    <div className="theme-card-text">
                      <span className="theme-card-label">{opt.label}</span>
                      <span className="theme-card-desc">{opt.description}</span>
                    </div>
                    {isSelected && (
                      <span className="theme-card-check" aria-hidden="true">
                        <Check size={14} />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </section>

          {/* SECTION 2: Response Preferences */}
          <section className="settings-section" aria-labelledby="section-response-heading">
            <div className="settings-section-header">
              <div className="settings-section-title-wrap">
                <span className="settings-section-icon" aria-hidden="true">
                  <Sparkles size={15} />
                </span>
                <h3 id="section-response-heading" className="settings-section-title">
                  AI Response Style
                </h3>
              </div>
            </div>

            {/* Response Length */}
            <div className="settings-control-block">
              <div className="settings-control-label-wrap">
                <label className="settings-control-label" id="response-length-label">
                  Preferred response length
                </label>
                <p className="settings-control-subtext">
                  Guides how detailed or concise assistant answers are by default.
                </p>
              </div>

              <div
                className="settings-segmented-group"
                role="radiogroup"
                aria-labelledby="response-length-label"
              >
                {RESPONSE_LENGTH_OPTIONS.map((opt) => {
                  const isSelected = settings.responseLength === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      role="radio"
                      aria-checked={isSelected}
                      onClick={() => handleResponseLengthChange(opt.id)}
                      className={`settings-segment-btn ${isSelected ? 'active' : ''}`}
                      title={opt.description}
                    >
                      <span>{opt.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Default Chat Mode */}
            <div className="settings-control-block">
              <div className="settings-control-label-wrap">
                <label className="settings-control-label" id="default-mode-label">
                  Default Chat Mode for New Chats
                </label>
                <p className="settings-control-subtext">
                  Choose the starting mode for new conversations. You can always change it in any active chat.
                </p>
              </div>

              <div
                className="settings-segmented-group settings-segmented-modes"
                role="radiogroup"
                aria-labelledby="default-mode-label"
              >
                {CHAT_MODE_PREFERENCE_OPTIONS.map((opt) => {
                  const isSelected = (settings.defaultMode || 'general') === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      role="radio"
                      aria-checked={isSelected}
                      onClick={() => handleDefaultModeChange(opt.id)}
                      className={`settings-segment-btn ${isSelected ? 'active' : ''}`}
                      title={opt.description}
                    >
                      <span>{opt.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Beginner-Friendly Explanation */}
            <div className="settings-control-row">
              <div className="settings-control-text">
                <label
                  htmlFor="toggle-beginner-friendly"
                  className="settings-toggle-label cursor-pointer"
                >
                  Clear, beginner-friendly explanations
                </label>
                <p className="settings-control-subtext">
                  Uses accessible analogies and straightforward language for technical topics.
                </p>
              </div>

              <button
                id="toggle-beginner-friendly"
                type="button"
                role="switch"
                aria-checked={settings.beginnerFriendly}
                onClick={handleToggleBeginnerFriendly}
                className={`settings-switch-btn ${settings.beginnerFriendly ? 'checked' : ''}`}
                title={settings.beginnerFriendly ? 'Disable beginner-friendly explanations' : 'Enable beginner-friendly explanations'}
              >
                <span className="settings-switch-thumb" />
              </button>
            </div>
          </section>

          {/* SECTION 3: Composer Behavior */}
          <section className="settings-section" aria-labelledby="section-composer-heading">
            <div className="settings-section-header">
              <div className="settings-section-title-wrap">
                <span className="settings-section-icon" aria-hidden="true">
                  <Keyboard size={15} />
                </span>
                <h3 id="section-composer-heading" className="settings-section-title">
                  Composer Behavior
                </h3>
              </div>
            </div>

            <div className="settings-control-row">
              <div className="settings-control-text">
                <label
                  htmlFor="toggle-enter-to-send"
                  className="settings-toggle-label cursor-pointer"
                >
                  Press Enter to send message
                </label>
                <p className="settings-control-subtext">
                  {settings.enterToSend
                    ? 'Enter sends immediately. Shift+Enter creates a new line.'
                    : 'Enter inserts a new line. Messages are sent via the Send button or ⌘/Ctrl+Enter.'}
                </p>
              </div>

              <button
                id="toggle-enter-to-send"
                type="button"
                role="switch"
                aria-checked={settings.enterToSend}
                onClick={handleToggleEnterToSend}
                className={`settings-switch-btn ${settings.enterToSend ? 'checked' : ''}`}
                title={settings.enterToSend ? 'Turn off Enter to send' : 'Turn on Enter to send'}
              >
                <span className="settings-switch-thumb" />
              </button>
            </div>
          </section>

          {/* SECTION 4: Display Preferences */}
          <section className="settings-section" aria-labelledby="section-display-heading">
            <div className="settings-section-header">
              <div className="settings-section-title-wrap">
                <span className="settings-section-icon" aria-hidden="true">
                  <Clock size={15} />
                </span>
                <h3 id="section-display-heading" className="settings-section-title">
                  Display Preferences
                </h3>
              </div>
            </div>

            <div className="settings-control-row">
              <div className="settings-control-text">
                <label
                  htmlFor="toggle-show-timestamps"
                  className="settings-toggle-label cursor-pointer"
                >
                  Show message timestamps
                </label>
                <p className="settings-control-subtext">
                  Displays sent and received times beneath message header lines.
                </p>
              </div>

              <button
                id="toggle-show-timestamps"
                type="button"
                role="switch"
                aria-checked={settings.showTimestamps}
                onClick={handleToggleShowTimestamps}
                className={`settings-switch-btn ${settings.showTimestamps ? 'checked' : ''}`}
                title={settings.showTimestamps ? 'Hide message timestamps' : 'Show message timestamps'}
              >
                <span className="settings-switch-thumb" />
              </button>
            </div>
          </section>

          {/* SECTION 5: Speech & Audio (Read Aloud) */}
          <section className="settings-section" aria-labelledby="section-speech-heading">
            <div className="settings-section-header">
              <div className="settings-section-title-wrap">
                <span className="settings-section-icon" aria-hidden="true">
                  <Volume2 size={15} />
                </span>
                <h3 id="section-speech-heading" className="settings-section-title">
                  Speech & Audio (Read Aloud)
                </h3>
              </div>
              <span className="settings-current-val">
                {isSpeechSupported ? `${speechRate}x speed` : 'Unsupported'}
              </span>
            </div>

            {!isSpeechSupported ? (
              <div className="settings-control-block speech-unsupported-note">
                <div className="flex items-center gap-2 text-amber-400 text-xs">
                  <VolumeX size={15} className="shrink-0" aria-hidden="true" />
                  <span>Text-to-speech is not supported by your current browser.</span>
                </div>
              </div>
            ) : (
              <>
                {/* Voice Selection */}
                <div className="settings-control-block">
                  <div className="settings-control-label-wrap">
                    <label className="settings-control-label" htmlFor="speech-voice-select">
                      Synthesizer voice
                    </label>
                    <p className="settings-control-subtext">
                      Select from the voices detected on your system. Voices load dynamically from the browser.
                    </p>
                  </div>

                  <div className="speech-voice-control-wrap">
                    <select
                      id="speech-voice-select"
                      className="settings-voice-select"
                      value={selectedVoiceURI}
                      onChange={handleVoiceChange}
                      aria-label="Synthesizer voice selection"
                    >
                      <option value="">System Default Voice</option>
                      {voices.map((v) => (
                        <option key={v.voiceURI} value={v.voiceURI}>
                          {v.name} ({v.lang}){v.default ? ' — System Default' : ''}
                        </option>
                      ))}
                    </select>

                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleTogglePreviewVoice}
                      className="speech-preview-btn"
                      title={isPreviewActive ? 'Stop preview' : 'Preview voice and rate'}
                      ariaLabel={isPreviewActive ? 'Stop voice preview' : 'Preview voice and rate'}
                      icon={isPreviewActive ? <Square size={12} fill="currentColor" /> : <Play size={12} fill="currentColor" />}
                    >
                      {isPreviewActive ? 'Stop' : 'Preview'}
                    </Button>
                  </div>
                </div>

                {/* Speech Rate Control */}
                <div className="settings-control-block">
                  <div className="settings-control-label-wrap">
                    <label className="settings-control-label" id="speech-rate-label">
                      Speech playback speed
                    </label>
                    <p className="settings-control-subtext">
                      Adjust how quickly messages are read aloud.
                    </p>
                  </div>

                  <div
                    className="settings-segmented-group"
                    role="radiogroup"
                    aria-labelledby="speech-rate-label"
                  >
                    {[
                      { val: 0.75, label: '0.75x', title: 'Slower rate' },
                      { val: 1.0, label: '1.0x', title: 'Normal rate' },
                      { val: 1.25, label: '1.25x', title: 'Slightly faster' },
                      { val: 1.5, label: '1.5x', title: 'Fast rate' },
                      { val: 2.0, label: '2.0x', title: 'Double speed' }
                    ].map((opt) => {
                      const isSelected = Math.abs(speechRate - opt.val) < 0.05;
                      return (
                        <button
                          key={opt.val}
                          type="button"
                          role="radio"
                          aria-checked={isSelected}
                          onClick={() => handleSpeechRateChange(opt.val)}
                          className={`settings-segment-btn ${isSelected ? 'active' : ''}`}
                          title={opt.title}
                        >
                          <span>{opt.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </>
            )}
          </section>
        </div>

        {/* Modal Footer */}
        <div className="settings-modal-footer">
          {confirmReset ? (
            <div className="settings-confirm-reset-box">
              <div className="flex items-center gap-2 text-amber-400 text-xs font-medium">
                <AlertTriangle size={14} className="shrink-0" />
                <span>Reset all settings to original defaults?</span>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmReset(false)}
                  disabled={isSaving}
                >
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={handleConfirmReset}
                  disabled={isSaving}
                  icon={<RotateCcw size={12} />}
                >
                  Yes, Reset
                </Button>
              </div>
            </div>
          ) : (
            <div className="settings-footer-standard">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConfirmReset(true)}
                disabled={isSaving}
                icon={<RotateCcw size={13} />}
                title="Restore factory default preferences"
                className="text-slate-400 hover:text-slate-200"
              >
                Reset to Defaults
              </Button>

              <Button
                variant="primary"
                size="sm"
                onClick={handleModalClose}
                className="settings-done-btn"
              >
                Done
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
