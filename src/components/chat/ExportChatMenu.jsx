import React, { useState, useRef, useEffect, useCallback, useLayoutEffect } from 'react';
import { Download, ChevronDown, FileText, FileCode } from 'lucide-react';
import Button from '../ui/Button.jsx';

/**
 * ExportChatMenu Component
 * Provides a clean, accessible dropdown menu for exporting the currently
 * selected conversation as Markdown (.md) or Plain Text (.txt).
 *
 * Dynamically positions the dropdown popover on mobile so it never clips against
 * screen edges, parent overflow: hidden containers, or viewport height limits.
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
  const [dropdownStyle, setDropdownStyle] = useState({});
  const menuRef = useRef(null);
  const popoverRef = useRef(null);

  // Dynamically position dropdown relative to trigger button and viewport bounds
  const updateDropdownPosition = useCallback(() => {
    if (!menuRef.current) return;
    const triggerEl = menuRef.current.querySelector('button') || menuRef.current;
    const rect = triggerEl.getBoundingClientRect();

    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 360;
    const viewportHeight =
      window.visualViewport?.height || window.innerHeight || document.documentElement.clientHeight || 640;

    const isMobile = compact || viewportWidth < 768;

    if (!isMobile) {
      // Desktop: preserve standard anchored styling below the Export button
      const spaceBelow = viewportHeight - rect.bottom - 8;
      const spaceAbove = rect.top - 8;
      const estimatedHeight = 190;
      const placeAbove = spaceBelow < estimatedHeight && spaceAbove > spaceBelow;

      if (placeAbove) {
        setDropdownStyle({
          position: 'absolute',
          bottom: 'calc(100% + 8px)',
          top: 'auto',
          right: '0',
          left: 'auto',
          maxHeight: `${Math.max(140, Math.floor(spaceAbove - 16))}px`,
          overflowY: 'auto'
        });
      } else {
        setDropdownStyle({
          position: 'absolute',
          top: 'calc(100% + 8px)',
          bottom: 'auto',
          right: '0',
          left: 'auto',
          maxHeight: `${Math.max(140, Math.floor(spaceBelow - 16))}px`,
          overflowY: 'auto'
        });
      }
      return;
    }

    // Mobile: fixed positioning relative to viewport to completely escape parent overflow: hidden
    const margin = viewportWidth <= 360 ? 8 : 12;
    const maxAvailableWidth = viewportWidth - margin * 2;
    const menuWidth = Math.min(260, Math.max(200, maxAvailableWidth));

    const popoverEl = popoverRef.current;
    const measuredHeight = popoverEl ? popoverEl.offsetHeight : 190;
    const menuHeight = measuredHeight > 0 ? measuredHeight : 190;

    const spaceBelow = viewportHeight - rect.bottom - 8;
    const spaceAbove = rect.top - 8;
    const placeAbove = spaceBelow < menuHeight && spaceAbove > spaceBelow;

    const availableVerticalSpace = placeAbove ? spaceAbove - margin : spaceBelow - margin;
    const maxHeight = Math.max(140, Math.min(380, availableVerticalSpace));

    let top;
    if (placeAbove) {
      top = Math.max(margin, rect.top - Math.min(menuHeight, maxHeight) - 8);
    } else {
      top = rect.bottom + 8;
    }

    // Horizontal alignment on mobile:
    // Try to align the right edge of dropdown with the right edge of trigger button
    let left = rect.right - menuWidth;

    // Clamp horizontally to stay within viewport margins [margin, viewportWidth - menuWidth - margin]
    if (left < margin) {
      left = margin;
    } else if (left + menuWidth > viewportWidth - margin) {
      left = Math.max(margin, viewportWidth - menuWidth - margin);
    }

    setDropdownStyle({
      position: 'fixed',
      top: `${Math.round(top)}px`,
      left: `${Math.round(left)}px`,
      width: `${Math.round(menuWidth)}px`,
      maxHeight: `${Math.round(maxHeight)}px`,
      right: 'auto',
      bottom: 'auto',
      overflowY: 'auto',
      WebkitOverflowScrolling: 'touch',
      zIndex: 100
    });
  }, [compact]);

  // Recalculate position synchronously whenever opened and on resize/scroll
  useLayoutEffect(() => {
    if (!isOpen) {
      setDropdownStyle({});
      return;
    }

    updateDropdownPosition();

    const handleUpdate = () => {
      updateDropdownPosition();
    };

    window.addEventListener('resize', handleUpdate);
    window.addEventListener('orientationchange', handleUpdate);
    window.addEventListener('scroll', handleUpdate, true);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', handleUpdate);
      window.visualViewport.addEventListener('scroll', handleUpdate);
    }

    return () => {
      window.removeEventListener('resize', handleUpdate);
      window.removeEventListener('orientationchange', handleUpdate);
      window.removeEventListener('scroll', handleUpdate, true);
      if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', handleUpdate);
        window.visualViewport.removeEventListener('scroll', handleUpdate);
      }
    };
  }, [isOpen, updateDropdownPosition]);

  // Close menu on click outside or Escape key, and support arrow-key navigation
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target) &&
        (!popoverRef.current || !popoverRef.current.contains(e.target))
      ) {
        setIsOpen(false);
      }
    };

    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setIsOpen(false);
        const triggerEl = menuRef.current?.querySelector('button');
        triggerEl?.focus();
        return;
      }

      if (!popoverRef.current) return;
      const items = Array.from(
        popoverRef.current.querySelectorAll('.export-dropdown-item:not(:disabled)')
      );
      if (items.length === 0) return;

      const currentIdx = items.indexOf(document.activeElement);

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const nextIdx = currentIdx === -1 || currentIdx === items.length - 1 ? 0 : currentIdx + 1;
        items[nextIdx].focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const prevIdx = currentIdx <= 0 ? items.length - 1 : currentIdx - 1;
        items[prevIdx].focus();
      } else if (e.key === 'Home') {
        e.preventDefault();
        items[0].focus();
      } else if (e.key === 'End') {
        e.preventDefault();
        items[items.length - 1].focus();
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
          ref={popoverRef}
          className="export-dropdown-popover"
          style={dropdownStyle}
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
              disabled={!hasMessages}
              aria-disabled={!hasMessages}
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
              disabled={!hasMessages}
              aria-disabled={!hasMessages}
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

