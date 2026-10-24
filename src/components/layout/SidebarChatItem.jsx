import React, { useState, useRef, useEffect } from 'react';
import { MessageSquare, Pencil, Trash2, Check, X, Pin, Code, PenTool, BookOpen, Sparkles } from 'lucide-react';

/**
 * SidebarChatItem Component
 * Renders an individual conversation item with active highlighting,
 * inline renaming, safe deletion confirmation, and pinning.
 *
 * @param {Object} props
 * @param {Object} props.chat
 * @param {string} props.chat.id
 * @param {string} props.chat.title
 * @param {string} props.chat.timestamp
 * @param {boolean} [props.chat.isPinned]
 * @param {boolean} props.isActive
 * @param {() => void} props.onSelect
 * @param {(newTitle: string) => Promise<void>} props.onRename
 * @param {() => Promise<void>} props.onDelete
 * @param {() => Promise<void>} [props.onTogglePin]
 */
export default function SidebarChatItem({
  chat,
  isActive,
  onSelect,
  onRename,
  onDelete,
  onTogglePin
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(chat.title);
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const [isBusy, setIsBusy] = useState(false);

  const inputRef = useRef(null);

  // Sync title if changed externally
  useEffect(() => {
    setEditTitle(chat.title);
  }, [chat.title]);

  // Auto-focus input when entering edit mode
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleStartRename = (e) => {
    e.stopPropagation();
    setIsEditing(true);
    setIsConfirmingDelete(false);
  };

  const handleCancelRename = (e) => {
    if (e) e.stopPropagation();
    setIsEditing(false);
    setEditTitle(chat.title);
  };

  const handleSaveRename = async (e) => {
    if (e) e.stopPropagation();
    const sanitized = editTitle.trim();
    if (!sanitized || sanitized === chat.title) {
      setIsEditing(false);
      return;
    }

    setIsBusy(true);
    try {
      if (onRename) {
        await onRename(sanitized);
      }
      setIsEditing(false);
    } catch (err) {
      console.error('Rename error:', err);
    } finally {
      setIsBusy(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSaveRename();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      handleCancelRename();
    }
  };

  const handleStartDelete = (e) => {
    e.stopPropagation();
    setIsConfirmingDelete(true);
    setIsEditing(false);
  };

  const handleCancelDelete = (e) => {
    if (e) e.stopPropagation();
    setIsConfirmingDelete(false);
  };

  const handleConfirmDelete = async (e) => {
    if (e) e.stopPropagation();
    setIsBusy(true);
    try {
      if (onDelete) {
        await onDelete();
      }
    } catch (err) {
      console.error('Delete error:', err);
      setIsConfirmingDelete(false);
    } finally {
      setIsBusy(false);
    }
  };

  // State A: Inline Renaming Mode
  if (isEditing) {
    return (
      <div className="recent-chat-item-editing" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          type="text"
          className="chat-rename-input"
          value={editTitle}
          onChange={(e) => setEditTitle(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isBusy}
          maxLength={60}
          aria-label="Rename conversation"
        />
        <div className="chat-item-actions visible">
          <button
            type="button"
            className="chat-action-btn check-btn"
            onClick={handleSaveRename}
            disabled={isBusy || !editTitle.trim()}
            title="Save title (Enter)"
            aria-label="Save title"
          >
            <Check size={13} />
          </button>
          <button
            type="button"
            className="chat-action-btn cancel-btn"
            onClick={handleCancelRename}
            disabled={isBusy}
            title="Cancel (Esc)"
            aria-label="Cancel"
          >
            <X size={13} />
          </button>
        </div>
      </div>
    );
  }

  // State B: Inline Deletion Confirmation Mode
  if (isConfirmingDelete) {
    return (
      <div className="recent-chat-item-confirm-delete" onClick={(e) => e.stopPropagation()}>
        <span className="confirm-delete-label">Delete chat?</span>
        <div className="chat-item-actions visible">
          <button
            type="button"
            className="chat-action-btn danger-confirm-btn"
            onClick={handleConfirmDelete}
            disabled={isBusy}
            title="Confirm deletion"
            aria-label="Confirm deletion"
          >
            <Check size={13} />
          </button>
          <button
            type="button"
            className="chat-action-btn cancel-btn"
            onClick={handleCancelDelete}
            disabled={isBusy}
            title="Cancel"
            aria-label="Cancel deletion"
          >
            <X size={13} />
          </button>
        </div>
      </div>
    );
  }

  // State C: Standard Conversation Item
  const chatMode = chat.mode || 'general';
  const ModeIcon =
    chatMode === 'coding'
      ? Code
      : chatMode === 'writing'
      ? PenTool
      : chatMode === 'learning'
      ? BookOpen
      : MessageSquare;

  return (
    <div
      className={`recent-chat-item-container ${isActive ? 'active' : ''} mode-${chatMode}`}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      title={`${chat.title} (${chatMode === 'general' ? 'General' : chatMode.charAt(0).toUpperCase() + chatMode.slice(1)} Mode)`}
    >
      <div className="chat-item-content">
        <ModeIcon size={15} className={`chat-item-icon mode-icon-${chatMode}`} aria-hidden="true" />
        <div className="chat-item-info">
          <div className="flex items-center gap-1.5 min-w-0">
            {chat.isPinned && (
              <Pin size={12} className="text-amber-400 rotate-45 flex-shrink-0 fill-current" title="Pinned chat" aria-label="Pinned chat" />
            )}
            <span className="chat-item-title">{chat.title}</span>
          </div>
          <div className="flex items-center gap-1 min-w-0">
            <span className="chat-item-meta">{chat.timestamp}</span>
            {chatMode !== 'general' && (
              <>
                <span className="chat-item-meta-dot" aria-hidden="true">·</span>
                <span className={`chat-item-mode-text mode-${chatMode}`}>
                  {chatMode}
                </span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Action Controls for Pinning, Renaming and Deleting */}
      <div className="chat-item-actions">
        {onTogglePin && (
          <button
            type="button"
            className={`chat-action-btn pin-btn ${chat.isPinned ? 'active text-amber-400' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              onTogglePin();
            }}
            title={chat.isPinned ? 'Unpin chat' : 'Pin chat'}
            aria-label={chat.isPinned ? 'Unpin chat' : 'Pin chat'}
          >
            <Pin size={13} className={chat.isPinned ? 'rotate-45 fill-current' : ''} />
          </button>
        )}
        {onRename && (
          <button
            type="button"
            className="chat-action-btn"
            onClick={handleStartRename}
            title="Rename conversation"
            aria-label={`Rename ${chat.title}`}
          >
            <Pencil size={13} />
          </button>
        )}
        {onDelete && (
          <button
            type="button"
            className="chat-action-btn delete-btn"
            onClick={handleStartDelete}
            title="Delete conversation"
            aria-label={`Delete ${chat.title}`}
          >
            <Trash2 size={13} />
          </button>
        )}
      </div>
    </div>
  );
}
