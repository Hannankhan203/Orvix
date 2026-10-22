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
  Square,
  Volume2,
  VolumeX,
  Cpu,
  Pause,
  Play,
  Paperclip,
  Timer
} from 'lucide-react';
import Button from '../ui/Button.jsx';
import OrvixLogo from '../ui/OrvixLogo.jsx';
import CodeBlock from './CodeBlock.jsx';
import AttachmentCard from './AttachmentCard.jsx';
import ImageAttachmentCard from './ImageAttachmentCard.jsx';
import { isImageAttachment } from '../../services/documentContextService.js';
import { useSpeech } from '../../context/SpeechContext.jsx';
import { PROVIDER_OPTIONS } from '../../services/aiRouter.js';
import { formatResponseTime } from '../../utils/formatResponseTime.js';

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
 * Generates a clean, user-friendly title for the error banner based on error text
 */
function getErrorTitle(content = '') {
  const text = String(content || '').toLowerCase();
  if (text.includes('rate limit') || text.includes('quota') || text.includes('429') || text.includes('resource_exhausted')) {
    return 'Rate Limit or Quota Exceeded';
  }
  if (text.includes('high demand') || text.includes('503') || text.includes('spikes in demand') || text.includes('overloaded') || text.includes('unavailable')) {
    return 'Service Temporarily Busy';
  }
  if (text.includes('auth') || text.includes('permission') || text.includes('api key') || text.includes('401') || text.includes('403')) {
    return 'Authentication or Permission Issue';
  }
  if (text.includes('internal error') || text.includes('500') || text.includes('service error')) {
    return 'AI Provider Service Error';
  }
  if (text.includes('network') || text.includes('fetch') || text.includes('connection') || text.includes('offline')) {
    return 'Network Connection Error';
  }
  return 'Request Failed';
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
 * @param {(failedMessage: Object, newProviderId: string) => void} [props.onSwitchProvider]
 * @param {(promptText: string) => void} [props.onRestorePrompt]
 * @param {(assistantMessage: Object) => void} [props.onRegenerate]
 * @param {() => void} [props.onStopGenerating]
 * @param {boolean} [props.isLoading=false]
 */
/**
 * LiveResponseTimer Component
 * Lightweight, self-contained live timer that updates every 100ms while AI generation is actively running.
 * Only re-renders this tiny badge component, completely avoiding chat re-renders.
 */
function formatLiveElapsed(startTime) {
  if (typeof startTime !== 'number' || startTime <= 0) return '0.0s';
  const elapsedMs = Math.max(0, performance.now() - startTime);
  if (elapsedMs <= 0) return '0.0s';
  if (elapsedMs < 60000) {
    const sec = elapsedMs / 1000;
    const rounded = Math.round(sec * 10) / 10;
    return `${rounded.toFixed(1)}s`;
  }
  return formatResponseTime(elapsedMs) || `${(elapsedMs / 1000).toFixed(1)}s`;
}

function LiveResponseTimer({ startTime }) {
  const [elapsedText, setElapsedText] = useState(() => formatLiveElapsed(startTime));

  useEffect(() => {
    if (typeof startTime !== 'number' || startTime <= 0) return;

    const updateTimer = () => {
      setElapsedText(formatLiveElapsed(startTime));
    };

    updateTimer();
    const intervalId = setInterval(updateTimer, 100);

    return () => clearInterval(intervalId);
  }, [startTime]);

  return (
    <span
      className="response-time-badge live"
      title={`Thinking... ${elapsedText}`}
      aria-label={`Thinking... ${elapsedText}`}
    >
      <Timer size={11} className="response-time-icon" aria-hidden="true" />
      <span>Thinking... {elapsedText}</span>
    </span>
  );
}

export default function ChatMessage({
  message,
  onRetry,
  onSwitchProvider,
  onRestorePrompt,
  onRegenerate,
  onStopGenerating,
  isLoading = false,
  isEditing = false,
  onStartEdit,
  onCancelEdit,
  onEditResend,
  showTimestamps = true,
  selectedProvider = 'gemini'
}) {
  const isUser = message?.sender === 'user';
  const isError = Boolean(message?.isError);
  const isStreaming = Boolean(message?.isStreaming);
  const isStopped = Boolean(message?.isStopped);
  const hasContent = Boolean(message?.content && message.content.length > 0);

  const {
    isSupported: isSpeechSupported,
    speakingState,
    currentMessageId,
    speechError,
    playMessage,
    pauseSpeech,
    resumeSpeech,
    stopSpeech,
    resetMessageSpeech,
    hasSavedPosition
  } = useSpeech();

  const isCurrentActive = Boolean(message?.id && currentMessageId === message.id);
  const isSpeakingThis = isCurrentActive && (speakingState === 'speaking' || speakingState === 'playing');
  const isCurrentSpeaking = isSpeakingThis;
  const isPausedThis = isCurrentActive && speakingState === 'paused';
  const isCompletedThis = isCurrentActive && speakingState === 'completed';
  const isErrorThis = isCurrentActive && speakingState === 'error';
  const hasSavedThis = Boolean(message?.id && hasSavedPosition(message.id));
  const isResumableThis = isPausedThis || (!isCurrentActive && hasSavedThis);

  const handleStartSpeech = () => {
    if (!hasContent || !message?.content || !message?.id) return;
    playMessage(message.id, message.content, false);
  };

  const handlePauseSpeech = () => {
    pauseSpeech();
  };

  const handleResumeSpeech = () => {
    if (!hasContent || !message?.content || !message?.id) return;
    if (isPausedThis) {
      resumeSpeech();
    } else {
      playMessage(message.id, message.content, false);
    }
  };

  const handleStopSpeech = () => {
    if (!message?.id) return;
    if (isCurrentActive) {
      stopSpeech(false);
    } else {
      resetMessageSpeech(message.id);
    }
  };

  const handleResetSpeech = () => {
    if (!message?.id) return;
    resetMessageSpeech(message.id);
  };

  // Safely pause speech if this message is unmounted while speaking
  useEffect(() => {
    return () => {
      if (isSpeakingThis) {
        pauseSpeech();
      }
    };
  }, [isSpeakingThis, pauseSpeech]);

  const currentProviderId = message.failedProvider || message.provider || selectedProvider;
  const currentProviderObj =
    PROVIDER_OPTIONS.find((p) => p.id === currentProviderId) || {
      id: currentProviderId,
      name: currentProviderId.charAt(0).toUpperCase() + currentProviderId.slice(1)
    };
  const fallbackProviders = PROVIDER_OPTIONS.filter((p) => p.id !== currentProviderId);

  const [copied, setCopied] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState('Copy');
  const [draftContent, setDraftContent] = useState(message?.content || '');
  const editInputRef = useRef(null);

  const markdownComponents = useMemo(
    () => createMarkdownComponents(isStreaming),
    [isStreaming]
  );

  const formattedResponseTime = useMemo(
    () =>
      !isUser && !isError && !isStopped && !message?.isInterrupted && typeof message?.responseTimeMs === 'number'
        ? formatResponseTime(message?.responseTimeMs)
        : null,
    [isUser, isError, isStopped, message?.isInterrupted, message?.responseTimeMs]
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
      className={`message-wrapper ${isUser ? 'user-wrapper' : 'assistant-wrapper'} ${isError ? 'error-wrapper' : ''} ${isStreaming ? 'streaming-wrapper' : ''} ${isStopped ? 'stopped-wrapper' : ''} ${isEditing ? 'is-editing' : ''} ${isCurrentSpeaking ? 'is-speaking-message' : ''}`}
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

          {isCurrentActive && (isSpeakingThis || isPausedThis || isErrorThis) && (
            <span
              className={`message-speaking-badge ${isSpeakingThis ? 'playing' : isPausedThis ? 'paused' : 'error'}`}
              role="status"
              aria-label={
                isSpeakingThis
                  ? 'Currently reading aloud'
                  : isPausedThis
                  ? 'Speech playback paused'
                  : 'Speech playback error'
              }
            >
              {isSpeakingThis ? (
                <Volume2 size={11} className="speaking-badge-icon pulse" />
              ) : isPausedThis ? (
                <Pause size={11} />
              ) : (
                <AlertCircle size={11} />
              )}
              <span>
                {isSpeakingThis
                  ? 'Reading Aloud'
                  : isPausedThis
                  ? 'Speech Paused'
                  : 'Speech Error'}
              </span>
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

          {/* Response Time Badge: Live while generating (isStreaming && !message?.responseTimeMs), or Final once responseTimeMs is available */}
          {!isUser && !isError && !isStopped && !message?.isInterrupted && (
            <>
              {isStreaming && !message?.responseTimeMs && typeof message?.requestStartTime === 'number' && (
                <LiveResponseTimer startTime={message.requestStartTime} />
              )}
              {formattedResponseTime && (
                <span
                  className="response-time-badge"
                  title={`Response time: ${formattedResponseTime}`}
                  aria-label={`Response time: ${formattedResponseTime}`}
                >
                  <Timer size={11} className="response-time-icon" aria-hidden="true" />
                  <span>Response time: {formattedResponseTime}</span>
                </span>
              )}
            </>
          )}

          {showTimestamps && message.timestamp && (
            <span className="message-timestamp">{message.timestamp}</span>
          )}
        </div>

        <div className="message-content">
          {isError ? (
            <div className="error-message-box" role="alert" aria-live="assertive">
              <div className="error-message-header">
                <div className="error-header-title-wrap">
                  <span className="error-icon-badge" aria-hidden="true">
                    <AlertCircle size={14} />
                  </span>
                  <span className="error-header-title">
                    {getErrorTitle(message.content)}
                  </span>
                </div>
                {currentProviderObj?.name && (
                  <span className="error-provider-tag" title={`Request failed on ${currentProviderObj.name}`}>
                    {currentProviderObj.name}
                  </span>
                )}
              </div>

              {message.referencedAttachments && message.referencedAttachments.length > 0 && (
                <div className="assistant-referenced-attachments error-referenced-attachments" aria-label="Referenced files">
                  <div className="referenced-attachments-header">
                    <Paperclip size={11} className="referenced-icon" />
                    <span>Referenced file{message.referencedAttachments.length > 1 ? 's' : ''}:</span>
                  </div>
                  <div className="referenced-attachments-list">
                    {message.referencedAttachments.map((att, idx) => (
                      <AttachmentCard key={att.id || idx} attachment={att} compact={true} />
                    ))}
                  </div>
                </div>
              )}

              <div className="error-message-body">
                <p className="error-text">{message.content || 'An error occurred while communicating with the AI service.'}</p>
              </div>

              <div className="error-actions" role="group" aria-label="Error recovery options">
                {onRetry && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onRetry(message)}
                    icon={<RotateCcw size={13} />}
                    title={`Retry this request with ${currentProviderObj.name}`}
                    className="error-action-btn error-retry-btn"
                  >
                    Retry with {currentProviderObj.name}
                  </Button>
                )}
                {onSwitchProvider &&
                  fallbackProviders.map((p) => (
                    <Button
                      key={p.id}
                      variant="secondary"
                      size="sm"
                      onClick={() => onSwitchProvider(message, p.id)}
                      icon={<Cpu size={13} />}
                      title={`Switch to ${p.name} and send prompt`}
                      className="fallback-provider-btn error-action-btn error-fallback-btn"
                    >
                      Try with {p.name}
                    </Button>
                  ))}
                {onRestorePrompt && message.failedPrompt && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onRestorePrompt(message.failedPrompt)}
                    icon={<Edit3 size={13} />}
                    title="Restore prompt into composer"
                    className="error-action-btn error-restore-btn"
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
              /* Render user messages safely as plain text, visible image thumbnails, and document chips */
              <div className="user-message-content-wrapper">
                {(() => {
                  const allAtts = Array.isArray(message.attachments) ? message.attachments : [];
                  const imageAtts = allAtts.filter(isImageAttachment);
                  const docAtts = allAtts.filter((a) => !isImageAttachment(a));

                  return (
                    <>
                      {imageAtts.length > 0 && (
                        <div
                          className={`message-image-attachments-grid ${imageAtts.length > 1 ? 'is-multi' : 'is-single'}`}
                          role="group"
                          aria-label="Attached images"
                        >
                          {imageAtts.map((att, idx) => (
                            <ImageAttachmentCard key={att.id || idx} attachment={att} />
                          ))}
                        </div>
                      )}
                      {docAtts.length > 0 && (
                        <div className="message-attachments-list" role="region" aria-label="Attached documents">
                          {docAtts.map((att, idx) => (
                            <AttachmentCard key={att.id || idx} attachment={att} />
                          ))}
                        </div>
                      )}
                    </>
                  );
                })()}
                {message.content ? (
                  <p className="user-text-content">{message.content}</p>
                ) : null}
              </div>
            )
          ) : (
            /* Render AI messages as rich, safe Markdown with progressive streaming cursor */
            <div className={`ai-markdown-container ${isStreaming ? 'is-streaming' : ''}`}>
              {message.referencedAttachments && message.referencedAttachments.length > 0 && (
                <div className="assistant-referenced-attachments" aria-label="Referenced files">
                  <div className="referenced-attachments-header">
                    <Paperclip size={11} className="referenced-icon" />
                    <span>Referenced file{message.referencedAttachments.length > 1 ? 's' : ''}:</span>
                  </div>
                  <div className="referenced-attachments-list">
                    {message.referencedAttachments.map((att, idx) => (
                      <AttachmentCard key={att.id || idx} attachment={att} compact={true} />
                    ))}
                  </div>
                </div>
              )}

              {isStreaming && !hasContent ? (
                /* Subtle thinking state before first streaming chunk arrives */
                <div className="streaming-thinking-state" role="status" aria-label="Thinking">
                  <span className="typing-dot dot-1" />
                  <span className="typing-dot dot-2" />
                  <span className="typing-dot dot-3" />
                </div>
              ) : (
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={markdownComponents}
                >
                  {message.content || ''}
                </ReactMarkdown>
              )}

              {message.isInterrupted && message.failedPrompt && (
                <div className="interrupted-retry-actions" role="group" aria-label="Interrupted response recovery options">
                  {onRetry && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onRetry(message)}
                      icon={<RotateCcw size={13} />}
                      title={`Retry this request with ${currentProviderObj.name}`}
                      className="error-action-btn error-retry-btn"
                    >
                      Retry with {currentProviderObj.name}
                    </Button>
                  )}
                  {onSwitchProvider &&
                    fallbackProviders.map((p) => (
                      <Button
                        key={p.id}
                        variant="secondary"
                        size="sm"
                        onClick={() => onSwitchProvider(message, p.id)}
                        icon={<Cpu size={13} />}
                        title={`Switch to ${p.name} and send prompt`}
                        className="fallback-provider-btn error-action-btn error-fallback-btn"
                      >
                        Try with {p.name}
                      </Button>
                    ))}
                  {onRestorePrompt && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onRestorePrompt(message.failedPrompt)}
                      icon={<Edit3 size={13} />}
                      title="Restore prompt into composer"
                      className="error-action-btn error-restore-btn"
                    >
                      Edit prompt
                    </Button>
                  )}
                </div>
              )}
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

                {/* Read Aloud & Resume / Pause / Stop Controls */}
                {hasContent && (
                  <div className="read-aloud-active-controls inline-flex items-center gap-1.5">
                    {isSpeakingThis ? (
                      /* Active Speaking State: Show Pause & Stop buttons */
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={handlePauseSpeech}
                          className="message-action-btn speech-pause-btn active"
                          title="Pause reading aloud"
                          ariaLabel="Pause reading message aloud"
                          icon={<Pause size={12} />}
                        >
                          Pause
                        </Button>

                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={handleStopSpeech}
                          className="message-action-btn speech-stop-btn"
                          title="Stop reading and reset to beginning"
                          ariaLabel="Stop reading and reset to beginning"
                          icon={<Square size={11} fill="currentColor" />}
                        >
                          Stop
                        </Button>

                        <span className="speech-soundwave-mini" aria-hidden="true" title="Reading aloud">
                          <span className="mini-wave-bar bar-1" />
                          <span className="mini-wave-bar bar-2" />
                          <span className="mini-wave-bar bar-3" />
                        </span>
                      </>
                    ) : isResumableThis ? (
                      /* Paused / Resumable State: Show Resume & Stop buttons */
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={handleResumeSpeech}
                          disabled={!isSpeechSupported}
                          className="message-action-btn speech-resume-btn"
                          title="Resume reading from paused position"
                          ariaLabel="Resume reading message aloud"
                          icon={<Play size={12} fill="currentColor" />}
                        >
                          Resume
                        </Button>

                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={handleStopSpeech}
                          disabled={!isSpeechSupported}
                          className="message-action-btn speech-stop-btn"
                          title="Stop reading and reset to beginning"
                          ariaLabel="Stop reading and reset to beginning"
                          icon={<Square size={11} fill="currentColor" />}
                        >
                          Stop
                        </Button>
                      </>
                    ) : isErrorThis ? (
                      /* Error State: Retry button */
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={handleStartSpeech}
                          className="message-action-btn"
                          title="Retry reading aloud"
                          ariaLabel="Retry reading aloud"
                          icon={<RotateCcw size={12} />}
                        >
                          Retry
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={handleResetSpeech}
                          className="message-action-btn speech-stop-btn"
                          title="Dismiss speech error"
                          ariaLabel="Dismiss speech error"
                          icon={<Square size={11} fill="currentColor" />}
                        >
                          Dismiss
                        </Button>
                      </>
                    ) : (
                      /* Idle / Completed State: Read Aloud button */
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleStartSpeech}
                        disabled={!isSpeechSupported}
                        className="message-action-btn read-aloud-btn"
                        title={
                          !isSpeechSupported
                            ? 'Read aloud is not supported in this browser'
                            : 'Read aloud'
                        }
                        ariaLabel={
                          !isSpeechSupported
                            ? 'Read aloud not supported'
                            : 'Read message aloud'
                        }
                        icon={
                          !isSpeechSupported ? (
                            <VolumeX size={13} />
                          ) : (
                            <Volume2 size={13} />
                          )
                        }
                      >
                        Read aloud
                      </Button>
                    )}
                  </div>
                )}

                {/* Regenerate Response Button */}
                {onRegenerate && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      if (isCurrentSpeaking) stopSpeech(false);
                      if (message?.id) resetMessageSpeech(message.id);
                      onRegenerate(message);
                    }}
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
