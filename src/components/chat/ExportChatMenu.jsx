import React, { useState, useRef, useEffect } from 'react';
import { Download, ChevronDown, FileText, FileCode } from 'lucide-react';
import Button from '../ui/Button.jsx';

/**
 * ExportChatMenu Component
 * Provides a clean, accessible dropdown menu for exporting the currently
 * selected conversation as Markdown (.md) or Plain Text (.txt).
 *
 * @param {Object} props
 * @param {() => void} props.onExportMarkdown
 * @param {() => void} props.onExportText
 * @param {boolean} [props.hasMessages=true]
 * @param {boolean} [props.compact=false]
 * @param {string} [props.className='']
 */
export default function ExportChatMenu({
  onExportMarkdown,
  onExportText,
  hasMessages = true,
  compact = false,
  className = ''
}) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef(null);

  // Close menu on click outside or Escape key
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
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

  const handleSelectMarkdown = () => {
    setIsOpen(false);
    if (onExportMarkdown) {
      onExportMarkdown();
    }
  };

  const handleSelectText = () => {
    setIsOpen(false);
    if (onExportText) {
      onExportText();
    }
  };

  return (
    <div className={`export-chat-menu-wrapper ${className}`} ref={menuRef}>
      {compact ? (
        <button
          type="button"
          className={`export-menu-trigger-compact ${isOpen ? 'active' : ''}`}
          onClick={() => setIsOpen((prev) => !prev)}
          title="Export conversation (.md, .txt)"
          aria-label="Export conversation menu"
          aria-expanded={isOpen}
          aria-haspopup="menu"
        >
          <Download size={15} />
        </button>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setIsOpen((prev) => !prev)}
          className={`export-menu-trigger-btn ${isOpen ? 'active' : ''}`}
          title="Export conversation as Markdown or Plain Text"
          ariaLabel="Export conversation"
          aria-expanded={isOpen}
          aria-haspopup="menu"
          icon={<Download size={14} />}
        >
          <span>Export</span>
          <ChevronDown size={12} className={`export-chevron ${isOpen ? 'open' : ''}`} />
        </Button>
      )}

      {isOpen && (
        <div
          className="export-dropdown-popover"
          role="menu"
          aria-label="Export conversation options"
        >
          <div className="export-dropdown-header">
            <span className="export-dropdown-title">Export Conversation</span>
            <span className="export-dropdown-subtitle">
              {hasMessages ? 'Download active thread' : 'No messages to export'}
            </span>
          </div>

          <div className="export-dropdown-options">
            <button
              type="button"
              role="menuitem"
              className="export-dropdown-item"
              onClick={handleSelectMarkdown}
            >
              <div className="export-item-icon-wrap markdown">
                <FileCode size={16} />
              </div>
              <div className="export-item-text">
                <span className="export-item-name">Markdown (.md)</span>
                <span className="export-item-desc">
                  Formatted text, headings, and code blocks
                </span>
              </div>
            </button>

            <button
              type="button"
              role="menuitem"
              className="export-dropdown-item"
              onClick={handleSelectText}
            >
              <div className="export-item-icon-wrap text">
                <FileText size={16} />
              </div>
              <div className="export-item-text">
                <span className="export-item-name">Plain Text (.txt)</span>
                <span className="export-item-desc">
                  Clean unformatted text for simple viewing
                </span>
              </div>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
