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
 * Provides responsive mode selection dropdown for the Orvix header.
 *
 * @param {Object} props
 * @param {string} props.activeMode - Currently active mode ID ('general' | 'coding' | 'writing' | 'learning')
 * @param {(modeId: string) => void} props.onSelectMode - Callback when mode changes
 * @param {'compact'} [props.variant='compact']
 * @param {'left' | 'right' | 'auto'} [props.dropdownAlign='auto']
 * @param {boolean} [props.disabled=false]
 * @param {string} [props.className='']
 */
export default function ModeSelector({
  activeMode = 'general',
  onSelectMode,
  variant = 'compact',
  dropdownAlign = 'auto',
  disabled = false,
  className = ''
}) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef(null);

  const currentMode = getChatMode(activeMode);
  const ActiveIcon = ICON_COMPONENTS[currentMode.iconName] || Sparkles;

  // Close dropdown on outside click or Escape, and handle arrow navigation
  useEffect(() => {
    if (!isOpen) return;

    const focusMenuItem = (index) => {
      if (!containerRef.current) return;
      const items = Array.from(
        containerRef.current.querySelectorAll('.mode-dropdown-item:not(:disabled)')
      );
      if (items.length === 0) return;
      const bounded = ((index % items.length) + items.length) % items.length;
      items[bounded].focus();
    };

    const rafId = requestAnimationFrame(() => {
      if (!containerRef.current) return;
      const items = Array.from(
        containerRef.current.querySelectorAll('.mode-dropdown-item:not(:disabled)')
      );
      const selectedIdx = items.findIndex((el) => el.getAttribute('aria-checked') === 'true');
      focusMenuItem(selectedIdx >= 0 ? selectedIdx : 0);
    });

    const handleClickOutside = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setIsOpen(false);
      }
    };

    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setIsOpen(false);
        const triggerBtn = containerRef.current?.querySelector('.mode-compact-trigger');
        triggerBtn?.focus();
        return;
      }
      if (!containerRef.current) return;
      const items = Array.from(
        containerRef.current.querySelectorAll('.mode-dropdown-item:not(:disabled)')
      );
      if (items.length === 0) return;
      const currentIdx = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        focusMenuItem(currentIdx === -1 ? 0 : currentIdx + 1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        focusMenuItem(currentIdx === -1 ? items.length - 1 : currentIdx - 1);
      } else if (e.key === 'Home') {
        e.preventDefault();
        focusMenuItem(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        focusMenuItem(items.length - 1);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('touchstart', handleClickOutside);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      cancelAnimationFrame(rafId);
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

  // Compact Dropdown Popover (Header and composer bars)
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
          className={`mode-dropdown-menu align-${dropdownAlign}`}
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
