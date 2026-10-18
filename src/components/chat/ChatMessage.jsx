import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Bot, User, Copy, Check, AlertCircle, RotateCcw, Edit3 } from 'lucide-react';
import Button from '../ui/Button.jsx';
import OrvixLogo from '../ui/OrvixLogo.jsx';

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
 * Copy button for code blocks
 */
function CodeCopyButton({ text }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    if (navigator?.clipboard && text) {
      navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <button
      type="button"
      className="code-copy-btn"
      onClick={handleCopy}
      title="Copy snippet"
      aria-label="Copy code snippet"
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
      <span>{copied ? 'Copied' : 'Copy'}</span>
    </button>
  );
}

/**
 * Custom components configuration for ReactMarkdown
 * Enforces sanitization, accessible tables, and styled code containers
 */
const markdownComponents = {
  // Pass-through wrapper for pre so inner code block handles styling
  pre: ({ children }) => <>{children}</>,

  // Fenced code block or inline code
  code: ({ className, children, ...props }) => {
    const match = /language-(\w+)/.exec(className || '');
    const codeString = extractNodeText(children).replace(/\n$/, '');
    const isBlock = match || codeString.includes('\n');

    if (isBlock) {
      const language = match ? match[1] : 'code';
      return (
        <div className="code-block-container">
          <div className="code-block-header">
            <span className="code-lang-label">{language}</span>
            <CodeCopyButton text={codeString} />
          </div>
          <pre className="code-content">
            <code className={className} {...props}>
              {codeString}
            </code>
          </pre>
        </div>
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

/**
 * ChatMessage Component
 * Visually distinct user and AI messages with Markdown & Code rendering,
 * error handling, and copy action
 */
export default function ChatMessage({ message, onRetry, onRestorePrompt }) {
  const isUser = message?.sender === 'user';
  const isError = Boolean(message?.isError);
  const isStreaming = Boolean(message?.isStreaming);
  const hasContent = Boolean(message?.content && message.content.length > 0);
  const [copied, setCopied] = useState(false);

  const handleCopyMessage = () => {
    if (navigator?.clipboard && message?.content) {
      navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  if (!message) return null;

  return (
    <article
      className={`message-wrapper ${isUser ? 'user-wrapper' : 'assistant-wrapper'} ${isError ? 'error-wrapper' : ''} ${isStreaming ? 'streaming-wrapper' : ''}`}
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
          {message.modelUsed && (
            <span
              className="model-badge"
              title={`Model: ${message.modelUsed}${message.provider ? ` • Provider: ${message.provider}` : ''}`}
            >
              {message.provider ? `${message.provider.charAt(0).toUpperCase() + message.provider.slice(1)}: ` : ''}
              {message.modelUsed}
            </span>
          )}
          {message.timestamp && <span className="message-timestamp">{message.timestamp}</span>}
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
            /* Render user messages safely as plain text */
            <p className="user-text-content">{message.content || ''}</p>
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

        {!isUser && !isError && !isStreaming && (
          <div className="message-action-bar">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleCopyMessage}
              className="message-action-btn"
              title="Copy message text"
              ariaLabel="Copy message text"
              icon={copied ? <Check size={13} /> : <Copy size={13} />}
            >
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        )}
      </div>
    </article>
  );
}
