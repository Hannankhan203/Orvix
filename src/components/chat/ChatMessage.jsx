import React, { useState, useRef, useEffect, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  User,
  Copy,
  Check,
  AlertCircle,
  RotateCcw,
  Edit3,
  Square
} from 'lucide-react';
import Button from '../ui/Button.jsx';
import OrvixLogo from '../ui/OrvixLogo.jsx';
import CodeBlock from './CodeBlock.jsx';

/**
 * Recursively extracts plain text from React nodes or arrays of tokens
 */
function extractNodeText(node) {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (!node) return '';
  if (Array.isArray(node)) return node.map(extractNodeText).join('');
  if (node.props?.children) return extractNodeText(node.props.children);
  return '';
}

/**
 * Creates custom components configuration for ReactMarkdown
 * Enforces sanitization, accessible tables, and developer-friendly code highlighting
 */
function createMarkdownComponents(isStreaming = false) {
  return {
    // Pass-through wrapper for pre so inner code block receives isBlock flag
    pre: ({ children, ...props }) => {
      if (React.isValidElement(children)) {
        return React.cloneElement(children, { isBlock: true });
      }
      return <pre {...props}>{children}</pre>;
    },

    // Fenced code block or inline code
    code: ({ className, children, isBlock, ...props }) => {
      const match = /language-([\w-]+)/.exec(className || '');
      const codeString = extractNodeText(children);
      const isFenced = Boolean(isBlock) || Boolean(match) || (typeof codeString === 'string' && codeString.includes('\n'));

      if (isFenced) {
        const language = match ? match[1] : '';
        return (
          <CodeBlock
            code={codeString}
            language={language}
            isStreaming={isStreaming}
          />
        );
      }

      return (
        <code className="inline-code" {...props}>
          {children}
        </code>
      );
    },

    // Safe external links (prevents javascript: URLs and opens external links safely)
    a: ({ href, children, ...props }) => {
      const isSafeHref = href && /^(https?:\/\/|mailto:)/i.test(href);
      return (
        <a
          href={isSafeHref ? href : '#'}
          target={isSafeHref ? '_blank' : undefined}
          rel={isSafeHref ? 'noopener noreferrer' : undefined}
          onClick={!isSafeHref ? (e) => e.preventDefault() : undefined}
          className="markdown-link"
          {...props}
        >
          {children}
        </a>
      );
    },

    // Responsive scrollable tables
    table: ({ children, ...props }) => (
      <div className="table-responsive-wrapper">
        <table className="markdown-table" {...props}>
          {children}
        </table>
      </div>
    ),
    thead: ({ children, ...props }) => <thead className="markdown-thead" {...props}>{children}</thead>,
    tbody: ({ children, ...props }) => <tbody className="markdown-tbody" {...props}>{children}</tbody>,
    tr: ({ children, ...props }) => <tr className="markdown-tr" {...props}>{children}</tr>,
    th: ({ children, ...props }) => <th className="markdown-th" {...props}>{children}</th>,
    td: ({ children, ...props }) => <td className="markdown-td" {...props}>{children}</td>,

    // Semantic headings
    h1: ({ children, ...props }) => <h1 className="markdown-h1" {...props}>{children}</h1>,
    h2: ({ children, ...props }) => <h2 className="markdown-h2" {...props}>{children}</h2>,
    h3: ({ children, ...props }) => <h3 className="markdown-h3" {...props}>{children}</h3>,
    h4: ({ children, ...props }) => <h4 className="markdown-h4" {...props}>{children}</h4>,

    // Text formatting
    p: ({ children, ...props }) => <p className="markdown-p" {...props}>{children}</p>,
    blockquote: ({ children, ...props }) => (
      <blockquote className="markdown-blockquote" {...props}>
        {children}
      </blockquote>
    ),
    ul: ({ children, ...props }) => <ul className="markdown-ul" {...props}>{children}</ul>,
    ol: ({ children, ...props }) => <ol className="markdown-ol" {...props}>{children}</ol>,
    li: ({ children, ...props }) => <li className="markdown-li" {...props}>{children}</li>,
    hr: (props) => <hr className="markdown-divider" {...props} />
  };
}

/**
 * ChatMessage Component
 * Visually distinct user and AI messages with Markdown & Code rendering,
 * error handling, and assistant message controls: Copy, Regenerate, and Stop Generating.
 *
 * @param {Object} props
 * @param {Object} props.message
 * @param {(failedMessage: Object) => void} [props.onRetry]
 * @param {(promptText: string) => void} [props.onRestorePrompt]
 * @param {(assistantMessage: Object) => void} [props.onRegenerate]
 * @param {() => void} [props.onStopGenerating]
 * @param {boolean} [props.isLoading=false]
 */
export default function ChatMessage({
  message,
  onRetry,
  onRestorePrompt,
  onRegenerate,
  onStopGenerating,
  isLoading = false,
  isEditing = false,
  onStartEdit,
  onCancelEdit,
  onEditResend,
  showTimestamps = true
}) {
  const isUser = message?.sender === 'user';
  const isError = Boolean(message?.isError);
  const isStreaming = Boolean(message?.isStreaming);
  const isStopped = Boolean(message?.isStopped);
  const hasContent = Boolean(message?.content && message.content.length > 0);

  const [copied, setCopied] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState('Copy');
  const [draftContent, setDraftContent] = useState(message?.content || '');
  const editInputRef = useRef(null);

  const markdownComponents = useMemo(
    () => createMarkdownComponents(isStreaming),
    [isStreaming]
  );

  // Sync draftContent whenever isEditing is toggled or message content changes
  useEffect(() => {
    if (isEditing) {
      setDraftContent(message?.content || '');
    }
  }, [isEditing, message?.content]);

  // Focus and auto-size textarea when edit mode is entered
  useEffect(() => {
    if (isEditing && editInputRef.current) {
      editInputRef.current.focus();
      const length = editInputRef.current.value.length;
      editInputRef.current.setSelectionRange(length, length);
      editInputRef.current.style.height = 'auto';
      editInputRef.current.style.height = `${Math.min(260, Math.max(54, editInputRef.current.scrollHeight))}px`;
    }
  }, [isEditing]);

  const handleDraftChange = (e) => {
    setDraftContent(e.target.value);
    if (editInputRef.current) {
      editInputRef.current.style.height = 'auto';
      editInputRef.current.style.height = `${Math.min(260, Math.max(54, editInputRef.current.scrollHeight))}px`;
    }
  };

  const handleCancelEdit = () => {
    setDraftContent(message?.content || '');
    if (onCancelEdit) {
      onCancelEdit();
    }
  };

  const handleSaveAndResend = () => {
    const trimmed = draftContent.trim();
    if (!trimmed || isLoading) return;
    if (onEditResend) {
      onEditResend(message.id, trimmed);
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

  const handleCopyMessage = async () => {
    if (!message?.content) return;

    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(message.content);
        setCopied(true);
        setCopyFeedback('Copied');
        setTimeout(() => {
          setCopied(false);
          setCopyFeedback('Copy');
        }, 2000);
        return;
      }
      throw new Error('Clipboard API unavailable');
    } catch (err) {
      // Graceful fallback for restricted contexts (e.g. iframes / permissions)
      try {
        const textarea = document.createElement('textarea');
        textarea.value = message.content;
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        textarea.style.top = '0';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        const success = document.execCommand('copy');
        document.body.removeChild(textarea);

        if (success) {
          setCopied(true);
          setCopyFeedback('Copied');
          setTimeout(() => {
            setCopied(false);
            setCopyFeedback('Copy');
          }, 2000);
          return;
        }
      } catch (fallbackErr) {
        console.warn('Fallback copy failed:', fallbackErr);
      }

      console.warn('Clipboard write failed:', err);
      setCopyFeedback('Failed to copy');
      setTimeout(() => setCopyFeedback('Copy'), 2500);
    }
  };

  if (!message) return null;

  return (
    <article
      className={`message-wrapper ${isUser ? 'user-wrapper' : 'assistant-wrapper'} ${isError ? 'error-wrapper' : ''} ${isStreaming ? 'streaming-wrapper' : ''} ${isStopped ? 'stopped-wrapper' : ''} ${isEditing ? 'is-editing' : ''}`}
      aria-label={`${isUser ? 'User' : 'Orvix AI'} message`}
    >
      <div
        className={`message-avatar ${isUser ? 'user-avatar' : 'assistant-avatar'} ${isError ? 'error-avatar' : ''}`}
        aria-hidden="true"
      >
        {isUser ? <User size={16} /> : isError ? <AlertCircle size={16} /> : <OrvixLogo size={18} />}
      </div>

      <div className={`message-body ${isUser ? 'user-body' : 'assistant-body'} ${isError ? 'error-body' : ''}`}>
        <div className="message-sender-line">
          <span className="sender-name">{isUser ? 'You' : 'Orvix'}</span>

          {isStreaming && !hasContent && (
            <span className="sender-status">thinking...</span>
          )}

          {isStopped && (
            <span className="message-stopped-badge" title="Response generation stopped">
              Stopped
            </span>
          )}

          {message.modelUsed && (
            <span
              className="model-badge"
              title={`Model: ${message.modelUsed}${message.provider ? ` • Provider: ${message.provider}` : ''}`}
            >
              {message.provider ? `${message.provider.charAt(0).toUpperCase() + message.provider.slice(1)}: ` : ''}
              {message.modelUsed}
            </span>
          )}

          {showTimestamps && message.timestamp && (
            <span className="message-timestamp">{message.timestamp}</span>
          )}
        </div>

        <div className="message-content">
          {isError ? (
            <div className="error-message-box">
              <p className="error-text">{message.content || 'An error occurred.'}</p>
              <div className="error-actions">
                {onRetry && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onRetry(message)}
                    icon={<RotateCcw size={13} />}
                    title="Retry this request"
                  >
                    Retry
                  </Button>
                )}
                {onRestorePrompt && message.failedPrompt && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onRestorePrompt(message.failedPrompt)}
                    icon={<Edit3 size={13} />}
                    title="Restore prompt into composer"
                  >
                    Edit prompt
                  </Button>
                )}
              </div>
            </div>
          ) : isUser ? (
            isEditing ? (
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
            ) : (
              /* Render user messages safely as plain text */
              <p className="user-text-content">{message.content || ''}</p>
            )
          ) : isStreaming && !hasContent ? (
            /* Subtle thinking state before first streaming chunk arrives */
            <div className="streaming-thinking-state" role="status" aria-label="Thinking">
              <span className="typing-dot dot-1" />
              <span className="typing-dot dot-2" />
              <span className="typing-dot dot-3" />
            </div>
          ) : (
            /* Render AI messages as rich, safe Markdown with progressive streaming cursor */
            <div className={`ai-markdown-container ${isStreaming ? 'is-streaming' : ''}`}>
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={markdownComponents}
              >
                {message.content || ''}
              </ReactMarkdown>
            </div>
          )}
        </div>

        {/* User Message Actions: Copy, Edit and Resend */}
        {isUser && !isEditing && !isError && (
          <div className="message-action-bar user-action-bar">
            {hasContent && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleCopyMessage}
                className={`message-action-btn ${copied ? 'copied' : ''}`}
                title="Copy message"
                ariaLabel="Copy message text"
                icon={copied ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
              >
                {copyFeedback}
              </Button>
            )}

            {onStartEdit && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onStartEdit}
                disabled={isLoading}
                className="message-action-btn edit-message-btn"
                title={isLoading ? 'Generation in progress...' : 'Edit and resend this message'}
                ariaLabel="Edit message"
                icon={<Edit3 size={13} />}
              >
                Edit
              </Button>
            )}
          </div>
        )}

        {/* Assistant Message Actions: Copy, Regenerate, Stop Generating */}
        {!isUser && !isError && (
          <div className="message-action-bar">
            {/* When streaming: display immediate Stop Generating control */}
            {isStreaming ? (
              onStopGenerating && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onStopGenerating}
                  className="message-action-btn stop-generating-btn"
                  title="Stop generating response (Esc)"
                  ariaLabel="Stop generating response"
                  icon={<Square size={11} fill="currentColor" />}
                >
                  Stop
                </Button>
              )
            ) : (
              <>
                {/* Copy Response Button (copies raw content, never rendered HTML) */}
                {hasContent && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleCopyMessage}
                    className={`message-action-btn ${copied ? 'copied' : ''}`}
                    title="Copy response text"
                    ariaLabel="Copy response text"
                    icon={copied ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
                  >
                    {copyFeedback}
                  </Button>
                )}

                {/* Regenerate Response Button */}
                {onRegenerate && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onRegenerate(message)}
                    disabled={isLoading}
                    className="message-action-btn regenerate-btn"
                    title={isLoading ? 'Generation in progress...' : 'Regenerate response'}
                    ariaLabel="Regenerate response"
                    icon={<RotateCcw size={13} />}
                  >
                    Regenerate
                  </Button>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </article>
  );
}
