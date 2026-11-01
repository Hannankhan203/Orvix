import React, { useRef, useEffect } from 'react';
import { RotateCcw } from 'lucide-react';
import Button from '../ui/Button.jsx';

/**
 * UserInlineEditor Component
 * Handles inline editing of user messages with keyboard shortcuts (Enter to save, Esc to cancel)
 * and automatic textarea height adjustment.
 */
export default function UserInlineEditor({
  messageId,
  initialContent = '',
  isLoading = false,
  onCancelEdit,
  onEditResend
}) {
  const [draftContent, setDraftContent] = React.useState(initialContent);
  const editInputRef = useRef(null);
  const isSubmittingEditRef = useRef(false);

  useEffect(() => {
    isSubmittingEditRef.current = false;
    setDraftContent(initialContent);
  }, [initialContent]);

  useEffect(() => {
    if (editInputRef.current) {
      editInputRef.current.focus();
      const length = editInputRef.current.value.length;
      editInputRef.current.setSelectionRange(length, length);
      editInputRef.current.style.height = 'auto';
      editInputRef.current.style.height = `${Math.min(260, Math.max(54, editInputRef.current.scrollHeight))}px`;
    }
  }, []);

  const handleDraftChange = (e) => {
    setDraftContent(e.target.value);
    if (editInputRef.current) {
      editInputRef.current.style.height = 'auto';
      editInputRef.current.style.height = `${Math.min(260, Math.max(54, editInputRef.current.scrollHeight))}px`;
    }
  };

  const handleCancelEdit = () => {
    isSubmittingEditRef.current = false;
    setDraftContent(initialContent);
    if (onCancelEdit) {
      onCancelEdit();
    }
  };

  const handleSaveAndResend = () => {
    const trimmed = draftContent.trim();
    if (!trimmed || isLoading || isSubmittingEditRef.current) return;
    isSubmittingEditRef.current = true;
    if (onEditResend) {
      onEditResend(messageId, trimmed);
    }
  };

  const handleEditKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      handleCancelEdit();
      return;
    }

    // Ctrl+Enter or Cmd+Enter submits
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSaveAndResend();
      return;
    }

    // Enter without Shift submits; Shift+Enter creates a newline
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSaveAndResend();
    }
  };

  return (
    <div className="user-inline-editor">
      <textarea
        ref={editInputRef}
        className="user-edit-textarea"
        value={draftContent}
        onChange={handleDraftChange}
        onKeyDown={handleEditKeyDown}
        placeholder="Edit your message..."
        disabled={isLoading}
        rows={Math.min(8, Math.max(2, (draftContent || '').split('\n').length))}
        aria-label="Edit message text"
      />
      <div className="user-edit-actions">
        <span className="user-edit-hint">
          Enter or ⌘/Ctrl+Enter to save • Shift+Enter for newline • Esc to cancel
        </span>
        <div className="user-edit-btn-group">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleCancelEdit}
            disabled={isLoading}
            className="user-edit-cancel-btn"
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={handleSaveAndResend}
            disabled={isLoading || !draftContent.trim()}
            className="user-edit-resend-btn"
            icon={<RotateCcw size={13} />}
          >
            Save & Resend
          </Button>
        </div>
      </div>
    </div>
  );
}
