import React, { useState, useRef, useEffect } from 'react';
import { ChevronDown, Check, Sparkles, Code, PenTool, BookOpen } from 'lucide-react';
import { CHAT_MODES, CHAT_MODE_LIST, getChatMode } from '../../config/chatModes.js';

const ICON_COMPONENTS = {
  Sparkles,
  Code,
  PenTool,
  BookOpen
};

/**
 * ModeSelector Component
 * Provides responsive mode selection for Orvix chat:
 * - 'pills': Segmented / card row for the WelcomeScreen.
 * - 'compact': Dropdown popover pill for composer and header bars.
 *
 * @param {Object} props
 * @param {string} props.activeMode - Currently active mode ID ('general' | 'coding' | 'writing' | 'learning')
 * @param {(modeId: string) => void} props.onSelectMode - Callback when mode changes
 * @param {'pills' | 'compact'} [props.variant='compact']
 * @param {boolean} [props.disabled=false]
 * @param {string} [props.className='']
 */
export default function ModeSelector({
  activeMode = 'general',
  onSelectMode,
  variant = 'compact',
  disabled = false,
  className = ''
}) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef(null);

  const currentMode = getChatMode(activeMode);
  const ActiveIcon = ICON_COMPONENTS[currentMode.iconName] || Sparkles;

  // Close dropdown on outside click or Escape
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setIsOpen(false);
      }
    };

    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('touchstart', handleClickOutside);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('touchstart', handleClickOutside);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  const handleSelect = (modeId) => {
    if (disabled) return;
    if (onSelectMode) {
      onSelectMode(modeId);
    }
    setIsOpen(false);
  };

  // Variant A: Interactive Mode Pills Row (Welcome / New Chat screen)
  if (variant === 'pills') {
    return (
      <div className={`mode-selector-pills-wrap ${className}`} role="radiogroup" aria-label="Select conversation mode">
        <div className="mode-pills-row">
          {CHAT_MODE_LIST.map((mode) => {
            const IconComp = ICON_COMPONENTS[mode.iconName] || Sparkles;
            const isSelected = mode.id === currentMode.id;

            return (
              <button
                key={mode.id}
                type="button"
                role="radio"
                aria-checked={isSelected}
                disabled={disabled}
                onClick={() => handleSelect(mode.id)}
                className={`mode-pill-btn ${isSelected ? 'active' : ''} mode-${mode.id}`}
                title={mode.description}
              >
                <span className="mode-pill-icon" aria-hidden="true">
                  <IconComp size={15} />
                </span>
                <span className="mode-pill-name">{mode.shortName}</span>
                {isSelected && <span className="mode-pill-active-dot" aria-hidden="true" />}
              </button>
            );
          })}
        </div>

        {/* Short mode description callout */}
        <div className="mode-pill-description" role="status" aria-live="polite">
          <span className="mode-desc-tag">{currentMode.name}:</span>
          <span className="mode-desc-text">{currentMode.description}</span>
        </div>
      </div>
    );
  }

  // Variant B: Compact Dropdown Popover (Composer toolbar & Header)
  return (
    <div
      ref={containerRef}
      className={`mode-selector-compact-container ${className} ${isOpen ? 'dropdown-open' : ''}`}
    >
      <button
        type="button"
        disabled={disabled}
        onClick={() => setIsOpen((prev) => !prev)}
        className={`mode-compact-trigger mode-${currentMode.id} ${isOpen ? 'active' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        title={`Active Mode: ${currentMode.name}. Click to switch.`}
        aria-label={`Active Mode: ${currentMode.name}. Click to switch mode.`}
      >
        <span className="mode-compact-icon" aria-hidden="true">
          <ActiveIcon size={14} />
        </span>
        <span className="mode-compact-label">{currentMode.shortName}</span>
        <ChevronDown size={12} className={`mode-compact-chevron ${isOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>

      {isOpen && (
        <div
          className="mode-dropdown-menu"
          role="menu"
          aria-label="Conversation modes"
        >
          <div className="mode-dropdown-header">
            <span className="mode-dropdown-title">Chat Mode</span>
            <span className="mode-dropdown-caption">Guides assistant behavior & response style</span>
          </div>

          <div className="mode-dropdown-items" role="radiogroup">
            {CHAT_MODE_LIST.map((mode) => {
              const IconComp = ICON_COMPONENTS[mode.iconName] || Sparkles;
              const isSelected = mode.id === currentMode.id;

              return (
                <button
                  key={mode.id}
                  type="button"
                  role="radio"
                  aria-checked={isSelected}
                  onClick={() => handleSelect(mode.id)}
                  className={`mode-dropdown-item ${isSelected ? 'selected' : ''}`}
                >
                  <div className={`mode-item-icon-wrap mode-${mode.id}`}>
                    <IconComp size={16} />
                  </div>
                  <div className="mode-item-text">
                    <div className="mode-item-heading-row">
                      <span className="mode-item-title">{mode.name}</span>
                      {isSelected && (
                        <span className="mode-item-check" aria-hidden="true">
                          <Check size={13} />
                        </span>
                      )}
                    </div>
                    <span className="mode-item-desc">{mode.description}</span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
