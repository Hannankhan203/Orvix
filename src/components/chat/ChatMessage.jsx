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
  Timer,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Sparkles,
  BookOpen,
  Lightbulb,
  AlertTriangle,
  CheckCircle2,
  Bookmark,
  Info
} from 'lucide-react';
import Button from '../ui/Button.jsx';
import OrvixLogo from '../ui/OrvixLogo.jsx';
import CodeBlock from './CodeBlock.jsx';
import AttachmentCard from './AttachmentCard.jsx';
import ImageAttachmentCard from './ImageAttachmentCard.jsx';
import { isImageAttachment } from '../../services/documentContextService.js';
import { useSpeech } from '../../context/SpeechContext.jsx';
import { PROVIDER_OPTIONS } from '../../services/aiRouter.js';
import { formatResponseTime, formatLiveElapsed } from '../../utils/formatResponseTime.js';
export { formatLiveElapsed };
import { getAlternativeMetrics, getActiveAlternative } from '../../services/alternativeResponseService.js';
import { copyFormattedMessage } from '../../utils/clipboardFormatter.js';
import {
  filterAvailableFallbackProviders,
  getProviderConfigAvailability
} from '../../services/providerModelSanitizer.js';

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
function getErrorTitle(content = '', providerId = '', errorCode = '') {
  const text = String(content || '').toLowerCase();
  const normalizedCode = String(errorCode || '').toUpperCase();
  const normalizedProvider = String(providerId || '').toLowerCase();
  const isOllama = normalizedProvider === 'ollama';
  const isWebLLM = normalizedProvider === 'webllm';

  if (
    normalizedCode === 'PROVIDER_NOT_CONFIGURED' ||
    text.includes('not configured on this server')
  ) {
    return 'Provider Not Configured';
  }
  if (
    normalizedCode === 'INVALID_MODEL' ||
    (text.includes('model identifier') && text.includes('not valid'))
  ) {
    return 'Invalid Model Identifier';
  }
  if (
    normalizedCode === 'DEADLINE_EXCEEDED' ||
    text.includes('timed out waiting for') ||
    text.includes('timed out')
  ) {
    return 'Provider Request Timed Out';
  }
  if ((isOllama || text.includes('ollama')) && (text.includes('not found') || text.includes('pull'))) {
    return 'Local Model Not Found';
  }
  if (isOllama || text.includes('ollama') || text.includes('11434')) {
    return 'Local AI Unavailable';
  }
  if (isWebLLM || text.includes('webgpu') || text.includes('browser ai')) {
    if (text.includes('webgpu') || text.includes('adapter') || text.includes('secure context') || text.includes('shader-f16')) {
      return 'Browser Compatibility Issue';
    }
    if (text.includes('not been downloaded') || text.includes('not cached') || text.includes('connect to the internet once')) {
      return 'Model Not Cached Offline';
    }
    if (text.includes('storage') || text.includes('quota')) {
      return 'Insufficient Browser Storage';
    }
    if (text.includes('gpu memory') || text.includes('out of memory') || text.includes('device was lost')) {
      return 'GPU Memory Limit Reached';
    }
    if (text.includes('interrupted while downloading') || text.includes('downloading')) {
      return 'Model Download Interrupted';
    }
    return 'Browser AI Error';
  }
  if (text.includes('rate limit') || text.includes('quota') || text.includes('429') || text.includes('resource_exhausted')) {
    return 'Rate Limit or Quota Exceeded';
  }
  if (text.includes('not found') || text.includes('does not exist') || text.includes('decommissioned') || text.includes('retired')) {
    return 'Model Unavailable';
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

const CalloutContext = React.createContext(false);

/**
 * Detects educational callout structures (Important, Note, Warning, Tip, Key takeaway, Definition, Example, Comparison)
 * Supports GFM alert tags, emoji prefixes, and conversational bold/italic headers with optional qualifiers.
 */
function detectCalloutType(text = '') {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();

  // Strip leading blockquote angle brackets and optional leading emojis / variation selectors
  const cleanText = trimmed.replace(
    /^(?:>+\s*)?[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}]*\s*/u,
    ''
  );

  // 1. GFM Alert tags: [!NOTE], [!TIP], [!IMPORTANT], [!WARNING], [!CAUTION], [!INFO]
  if (/^\[!(NOTE|INFO)\]/i.test(cleanText)) {
    return { type: 'note', label: 'Note', icon: Info };
  }
  if (/^\[!TIP\]/i.test(cleanText)) {
    return { type: 'tip', label: 'Tip', icon: Lightbulb };
  }
  if (/^\[!(IMPORTANT|ATTENTION)\]/i.test(cleanText)) {
    return { type: 'important', label: 'Important', icon: AlertCircle };
  }
  if (/^\[!(WARNING|CAUTION)\]/i.test(cleanText)) {
    return { type: 'warning', label: 'Warning', icon: AlertTriangle };
  }

  // 2. Structured educational prefixes with optional numbering, parentheticals, and colon placement
  const calloutPatterns = [
    {
      type: 'important',
      label: 'Important',
      icon: AlertCircle,
      pattern: /^(?:[\*\_]{1,3})?(?:Important|Caution|Notice|Crucial|Critical)(?:\s*(?:\([^\)]+\)|#?\d+|[A-Z]))?\s*(?::\s*(?:[\*\_]{1,3})?|(?:[\*\_]{1,3})?\s*:)/i
    },
    {
      type: 'warning',
      label: 'Warning',
      icon: AlertTriangle,
      pattern: /^(?:[\*\_]{1,3})?(?:Warnings?|Common Pitfalls?|Pitfalls?|Watch Out|Common Mistakes?)(?:\s*(?:\([^\)]+\)|#?\d+|[A-Z]))?\s*(?::\s*(?:[\*\_]{1,3})?|(?:[\*\_]{1,3})?\s*:)/i
    },
    {
      type: 'note',
      label: 'Note',
      icon: Info,
      pattern: /^(?:[\*\_]{1,3})?(?:Notes?|Quick Notes?|FYI|Please Note|Info|Information)(?:\s*(?:\([^\)]+\)|#?\d+|[A-Z]))?\s*(?::\s*(?:[\*\_]{1,3})?|(?:[\*\_]{1,3})?\s*:)/i
    },
    {
      type: 'tip',
      label: 'Tip',
      icon: Lightbulb,
      pattern: /^(?:[\*\_]{1,3})?(?:Tips?|Study Tips?|Pro Tips?|Helpful Tips?)(?:\s*(?:\([^\)]+\)|#?\d+|[A-Z]))?\s*(?::\s*(?:[\*\_]{1,3})?|(?:[\*\_]{1,3})?\s*:)/i
    },
    {
      type: 'takeaway',
      label: 'Key Takeaway',
      icon: CheckCircle2,
      pattern: /^(?:[\*\_]{1,3})?(?:Key Takeaways?|Takeaways?|Key Points?|Core Concepts?|Summary|In Summary)(?:\s*(?:\([^\)]+\)|#?\d+|[A-Z]))?\s*(?::\s*(?:[\*\_]{1,3})?|(?:[\*\_]{1,3})?\s*:)/i
    },
    {
      type: 'definition',
      label: 'Definition',
      icon: BookOpen,
      pattern: /^(?:[\*\_]{1,3})?(?:Definitions?|Terminology|Key Terms?|Concept Definitions?)(?:\s*(?:\([^\)]+\)|#?\d+|[A-Z]))?\s*(?::\s*(?:[\*\_]{1,3})?|(?:[\*\_]{1,3})?\s*:)/i
    },
    {
      type: 'example',
      label: 'Example',
      icon: Bookmark,
      pattern: /^(?:[\*\_]{1,3})?(?:Examples?|Real-World Examples?|Practical Examples?|Analog(?:y|ies)|Everyday Analog(?:y|ies)|Illustrative Examples?|Worked Examples?)(?:\s*(?:\([^\)]+\)|#?\d+|[A-Z]))?\s*(?::\s*(?:[\*\_]{1,3})?|(?:[\*\_]{1,3})?\s*:)/i
    },
    {
      type: 'comparison',
      label: 'Comparison',
      icon: Sparkles,
      pattern: /^(?:[\*\_]{1,3})?(?:Comparisons?|Comparison Matrix|Contrast|Side-by-Side)(?:\s*(?:\([^\)]+\)|#?\d+|[A-Z]))?\s*(?::\s*(?:[\*\_]{1,3})?|(?:[\*\_]{1,3})?\s*:)/i
    }
  ];

  for (const item of calloutPatterns) {
    if (item.pattern.test(cleanText)) {
      return { type: item.type, label: item.label, icon: item.icon };
    }
  }

  return null;
}

/**
 * Creates custom components configuration for ReactMarkdown
 * Enforces sanitization, accessible tables, and developer-friendly code highlighting
 */
function createMarkdownComponents(isStreaming = false, effectiveMode = 'general') {
  return {
    // Pass-through wrapper for pre so inner code block receives isBlock flag
    pre: ({ node, children, ...props }) => {
      if (React.isValidElement(children)) {
        return React.cloneElement(children, { isBlock: true });
      }
      return <pre {...props}>{children}</pre>;
    },

    // Fenced code block or inline code
    code: ({ node, className, children, isBlock, ...props }) => {
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
            mode={effectiveMode}
          />
        );
      }

      return (
        <code className={`inline-code ${effectiveMode === 'coding' ? 'coding-inline-code' : ''}`} {...props}>
          {children}
        </code>
      );
    },

    // Safe external links (prevents javascript: URLs and opens external links safely)
    a: ({ node, href, children, ...props }) => {
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

    // Responsive scrollable tables with keyboard accessibility
    table: ({ node, children, ...props }) => (
      <div
        className={`table-responsive-wrapper ${effectiveMode === 'writing' ? 'writing-table-wrapper' : ''} ${effectiveMode === 'coding' ? 'coding-table-wrapper' : ''}`}
        tabIndex={0}
        role="region"
        aria-label="Scrollable data table"
      >
        <table className={`markdown-table ${effectiveMode === 'writing' ? 'writing-table' : ''} ${effectiveMode === 'coding' ? 'coding-table' : ''}`} {...props}>
          {children}
        </table>
      </div>
    ),
    thead: ({ node, children, ...props }) => <thead className="markdown-thead" {...props}>{children}</thead>,
    tbody: ({ node, children, ...props }) => <tbody className="markdown-tbody" {...props}>{children}</tbody>,
    tr: ({ node, children, ...props }) => <tr className="markdown-tr" {...props}>{children}</tr>,
    th: ({ node, children, ...props }) => <th className="markdown-th" {...props}>{children}</th>,
    td: ({ node, children, ...props }) => <td className="markdown-td" {...props}>{children}</td>,

    // Semantic headings establishing visual hierarchy
    h1: ({ node, children, ...props }) => (
      <h1
        className={`markdown-h1 ${effectiveMode === 'learning' ? 'educational-topic-heading' : ''} ${effectiveMode === 'writing' ? 'writing-h1' : ''} ${effectiveMode === 'coding' ? 'coding-h1' : ''}`}
        {...props}
      >
        {children}
      </h1>
    ),
    h2: ({ node, children, ...props }) => (
      <h2
        className={`markdown-h2 ${effectiveMode === 'learning' ? 'educational-concept-heading' : ''} ${effectiveMode === 'writing' ? 'writing-h2' : ''} ${effectiveMode === 'coding' ? 'coding-h2' : ''}`}
        {...props}
      >
        {children}
      </h2>
    ),
    h3: ({ node, children, ...props }) => (
      <h3
        className={`markdown-h3 ${effectiveMode === 'learning' ? 'educational-subconcept-heading' : ''} ${effectiveMode === 'writing' ? 'writing-h3' : ''} ${effectiveMode === 'coding' ? 'coding-h3' : ''}`}
        {...props}
      >
        {children}
      </h3>
    ),
    h4: ({ node, children, ...props }) => (
      <h4
        className={`markdown-h4 ${effectiveMode === 'learning' ? 'educational-step-heading' : ''} ${effectiveMode === 'writing' ? 'writing-h4' : ''} ${effectiveMode === 'coding' ? 'coding-h4' : ''}`}
        {...props}
      >
        {children}
      </h4>
    ),
    h5: ({ node, children, ...props }) => (
      <h5 className={`markdown-h5 ${effectiveMode === 'writing' ? 'writing-h5' : ''} ${effectiveMode === 'coding' ? 'coding-h5' : ''}`} {...props}>
        {children}
      </h5>
    ),
    h6: ({ node, children, ...props }) => (
      <h6 className={`markdown-h6 ${effectiveMode === 'writing' ? 'writing-h6' : ''} ${effectiveMode === 'coding' ? 'coding-h6' : ''}`} {...props}>
        {children}
      </h6>
    ),

    // Text formatting with Learning Mode Educational Callout recognition
    p: ({ node, children, ...props }) => {
      const isInsideCallout = React.useContext(CalloutContext);

      if (effectiveMode === 'learning') {
        // If already inside a blockquote callout, strip any raw alert tag like [!NOTE] so it isn't shown redundantly
        if (isInsideCallout) {
          if (typeof children === 'string' && /^\[!(NOTE|INFO|TIP|IMPORTANT|WARNING|CAUTION|ATTENTION)\]/i.test(children.trim())) {
            const stripped = children.replace(/^\[!(NOTE|INFO|TIP|IMPORTANT|WARNING|CAUTION|ATTENTION)\]\s*/i, '');
            if (!stripped) return null;
            return <p className="markdown-p educational-callout-text" {...props}>{stripped}</p>;
          }
          if (Array.isArray(children) && typeof children[0] === 'string' && /^\[!(NOTE|INFO|TIP|IMPORTANT|WARNING|CAUTION|ATTENTION)\]/i.test(children[0].trim())) {
            const firstStripped = children[0].replace(/^\[!(NOTE|INFO|TIP|IMPORTANT|WARNING|CAUTION|ATTENTION)\]\s*/i, '');
            const rest = children.slice(1);
            return (
              <p className="markdown-p educational-callout-text" {...props}>
                {firstStripped}
                {rest}
              </p>
            );
          }
          return <p className="markdown-p educational-callout-text" {...props}>{children}</p>;
        }

        // If not already inside a callout, detect callout trigger
        const textContent = extractNodeText(children);
        const callout = detectCalloutType(textContent);
        if (callout) {
          const IconComponent = callout.icon;
          return (
            <CalloutContext.Provider value={true}>
              <div className={`educational-callout-block callout-${callout.type}`} role="note">
                <div className="educational-callout-header">
                  <IconComponent size={14} className="educational-callout-icon" aria-hidden="true" />
                  <span className="educational-callout-label">{callout.label}</span>
                </div>
                <p className="markdown-p educational-callout-text" {...props}>
                  {children}
                </p>
              </div>
            </CalloutContext.Provider>
          );
        }
      }

      if (effectiveMode === 'writing') {
        const textContent = extractNodeText(children).trim();
        // Detect memo / formal email header lines (e.g., **Subject:**, **To:**, **From:**, **Date:**)
        const isMemoHeader =
          /^(?:\*{1,2}|_{1,2})?(?:Subject|To|From|Date|Cc|Bcc|Regarding|Re)\s*:/i.test(textContent);

        return (
          <p className={`markdown-p writing-p ${isMemoHeader ? 'writing-memo-field' : ''}`} {...props}>
            {children}
          </p>
        );
      }

      return <p className="markdown-p" {...props}>{children}</p>;
    },
    strong: ({ node, children, ...props }) => <strong className="markdown-strong" {...props}>{children}</strong>,
    b: ({ node, children, ...props }) => <b className="markdown-strong" {...props}>{children}</b>,
    em: ({ node, children, ...props }) => <em className="markdown-em" {...props}>{children}</em>,
    i: ({ node, children, ...props }) => <i className="markdown-em" {...props}>{children}</i>,
    del: ({ node, children, ...props }) => <del className="markdown-del" {...props}>{children}</del>,
    s: ({ node, children, ...props }) => <s className="markdown-del" {...props}>{children}</s>,
    blockquote: ({ node, children, ...props }) => {
      if (effectiveMode === 'learning') {
        const textContent = extractNodeText(children);
        const callout = detectCalloutType(textContent);
        if (callout) {
          const IconComponent = callout.icon;
          return (
            <CalloutContext.Provider value={true}>
              <blockquote className={`markdown-blockquote educational-callout callout-${callout.type}`} role="note" {...props}>
                <div className="educational-callout-header">
                  <IconComponent size={14} className="educational-callout-icon" aria-hidden="true" />
                  <span className="educational-callout-label">{callout.label}</span>
                </div>
                <div className="educational-callout-body">
                  {children}
                </div>
              </blockquote>
            </CalloutContext.Provider>
          );
        }
      }
      return (
        <blockquote
          className={`markdown-blockquote ${effectiveMode === 'writing' ? 'writing-blockquote' : ''}`}
          {...props}
        >
          {children}
        </blockquote>
      );
    },
    ul: ({ node, children, ...props }) => (
      <ul className={`markdown-ul ${effectiveMode === 'writing' ? 'writing-ul' : ''}`} {...props}>
        {children}
      </ul>
    ),
    ol: ({ node, children, start, ...props }) => (
      <ol className={`markdown-ol ${effectiveMode === 'writing' ? 'writing-ol' : ''}`} start={start} {...props}>
        {children}
      </ol>
    ),
    li: ({ node, children, checked, ...props }) => {
      if (typeof checked === 'boolean') {
        return (
          <li className="markdown-li markdown-task-item" {...props}>
            <input
              type="checkbox"
              checked={checked}
              readOnly
              disabled
              className="markdown-task-checkbox"
              aria-label="Task item"
            />
            <span className="markdown-task-label">{children}</span>
          </li>
        );
      }
      return (
        <li className="markdown-li" {...props}>
          {children}
        </li>
      );
    },
    hr: ({ node, ...props }) => (
      <hr className={`markdown-divider ${effectiveMode === 'writing' ? 'writing-divider' : ''}`} {...props} />
    )
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

function ChatMessage({
  message,
  onRetry,
  onSwitchProvider,
  onRestorePrompt,
  onRegenerate,
  onGenerateAlternative,
  onSwitchAlternative,
  onStopGenerating,
  isLoading = false,
  isEditing = false,
  onStartEdit,
  onCancelEdit,
  onEditResend,
  showTimestamps = true,
  selectedProvider = 'gemini',
  activeMode = 'general',
  providerConfig = null
}) {
  const effectiveMode = message?.mode || activeMode || 'general';
  const isUser = message?.sender === 'user';
  const isError = Boolean(message?.isError);
  const isStreaming = Boolean(message?.isStreaming);
  const isStopped = Boolean(message?.isStopped);
  const hasContent = Boolean(message?.content && message.content.length > 0);

  const [showAltMenu, setShowAltMenu] = useState(false);
  const altMenuRef = useRef(null);

  const altMetrics = useMemo(() => getAlternativeMetrics(message), [message]);

  useEffect(() => {
    if (!showAltMenu) return;

    const focusMenuItem = (index) => {
      if (!altMenuRef.current) return;
      const items = Array.from(
        altMenuRef.current.querySelectorAll('.alternative-provider-option:not(:disabled)')
      );
      if (items.length === 0) return;
      const bounded = ((index % items.length) + items.length) % items.length;
      items[bounded].focus();
    };

    const rafId = requestAnimationFrame(() => {
      focusMenuItem(0);
    });

    const handleClickOutside = (e) => {
      if (altMenuRef.current && !altMenuRef.current.contains(e.target)) {
        setShowAltMenu(false);
      }
    };
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowAltMenu(false);
        const triggerBtn = altMenuRef.current?.querySelector('.alternative-trigger-btn');
        triggerBtn?.focus();
        return;
      }
      if (!altMenuRef.current) return;
      const items = Array.from(
        altMenuRef.current.querySelectorAll('.alternative-provider-option:not(:disabled)')
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
  }, [showAltMenu]);

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

  const activeAlt = useMemo(() => {
    if (!message) return null;
    return getActiveAlternative(message);
  }, [message]);

  const currentProviderId = message.failedProvider || activeAlt?.provider || message.provider || selectedProvider;
  const currentProviderObj =
    PROVIDER_OPTIONS.find((p) => p.id === currentProviderId) || {
      id: currentProviderId,
      name: currentProviderId.charAt(0).toUpperCase() + currentProviderId.slice(1)
    };
  const fallbackProviders = useMemo(() => {
    const filtered = filterAvailableFallbackProviders(
      PROVIDER_OPTIONS,
      currentProviderId,
      providerConfig
    );
    if (Array.isArray(message?.suggestedProviders) && message.suggestedProviders.length > 0) {
      const suggestedSet = new Set(message.suggestedProviders.map((id) => String(id).toLowerCase()));
      const matchingSuggested = filtered.filter((p) => suggestedSet.has(p.id));
      if (matchingSuggested.length > 0) {
        return matchingSuggested;
      }
    }
    return filtered;
  }, [currentProviderId, providerConfig, message?.suggestedProviders]);

  // Available models for "Regenerate with another AI Model" (reuses existing Orvix provider/model configuration)
  const availableAlternativeModels = PROVIDER_OPTIONS;

  const activeAlternativeModelName = useMemo(() => {
    if (activeAlt?.modelUsed) return activeAlt.modelUsed;
    if (message?.modelUsed) return message.modelUsed;
    return currentProviderObj?.name || 'AI Model';
  }, [activeAlt, message?.modelUsed, currentProviderObj]);

  const selectableModels = availableAlternativeModels;

  const [copied, setCopied] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState('Copy');
  const [draftContent, setDraftContent] = useState(message?.content || '');
  const editInputRef = useRef(null);

  const markdownComponents = useMemo(
    () => createMarkdownComponents(isStreaming, effectiveMode),
    [isStreaming, effectiveMode]
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
      const success = await copyFormattedMessage(message.content);
      if (success) {
        setCopied(true);
        setCopyFeedback('Copied');
        setTimeout(() => {
          setCopied(false);
          setCopyFeedback('Copy');
        }, 2000);
        return;
      }
      throw new Error('All clipboard writing strategies failed');
    } catch (err) {
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
              {message.provider === 'webllm'
                ? 'Browser AI: '
                : message.provider
                  ? `${message.provider.charAt(0).toUpperCase() + message.provider.slice(1)}: `
                  : ''}
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
                    {getErrorTitle(message.content, currentProviderId, message.errorCode)}
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
                {onRetry && message.errorCode !== 'PROVIDER_NOT_CONFIGURED' && (
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
                  message.canSwitchProvider !== false &&
                  currentProviderId !== 'ollama' &&
                  currentProviderId !== 'webllm' &&
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
            <div className={`ai-markdown-container mode-${effectiveMode} ${isStreaming ? 'is-streaming' : ''}`}>
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
                onClick={() => onStartEdit(message.id)}
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
                {/* Copy Response Button (copies dual-format rich HTML and structured plain text) */}
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

                {/* Alternative Responses Navigation (< 1 of 3 >) */}
                {altMetrics.total > 1 && (
                  <div className="alternative-nav-wrapper" role="group" aria-label="Response alternatives">
                    <button
                      type="button"
                      className="alternative-nav-btn prev"
                      disabled={isLoading || !altMetrics.canGoPrevious}
                      onClick={() => {
                        if (onSwitchAlternative && altMetrics.canGoPrevious) {
                          const prevAlt = altMetrics.alternatives[altMetrics.currentIndex - 1];
                          if (prevAlt) onSwitchAlternative(message.id, prevAlt.id);
                        }
                      }}
                      title="Previous alternative response"
                      aria-label="Previous alternative response"
                    >
                      <ChevronLeft size={13} />
                    </button>
                    <span
                      className="alternative-nav-counter"
                      title={`Alternative ${altMetrics.currentIndex + 1} of ${altMetrics.total}`}
                    >
                      {altMetrics.currentIndex + 1} of {altMetrics.total}
                    </span>
                    <span
                      className="alternative-nav-model-badge"
                      title={`Currently viewing response generated by ${activeAlternativeModelName}`}
                    >
                      {activeAlternativeModelName}
                    </span>
                    <button
                      type="button"
                      className="alternative-nav-btn next"
                      disabled={isLoading || !altMetrics.canGoNext}
                      onClick={() => {
                        if (onSwitchAlternative && altMetrics.canGoNext) {
                          const nextAlt = altMetrics.alternatives[altMetrics.currentIndex + 1];
                          if (nextAlt) onSwitchAlternative(message.id, nextAlt.id);
                        }
                      }}
                      title="Next alternative response"
                      aria-label="Next alternative response"
                    >
                      <ChevronRight size={13} />
                    </button>
                  </div>
                )}

                {/* Regenerate with another AI Model Action & Selection Menu */}
                {onGenerateAlternative && (
                  <div className="alternative-generate-menu-wrapper" ref={altMenuRef}>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowAltMenu((prev) => !prev)}
                      disabled={isLoading}
                      className={`message-action-btn alternative-trigger-btn ${showAltMenu ? 'active' : ''}`}
                      title={isLoading ? 'Generation in progress...' : 'Regenerate with another AI Model'}
                      ariaLabel="Regenerate with another AI Model"
                      aria-haspopup="true"
                      aria-expanded={showAltMenu}
                      aria-controls={`alt-menu-${message?.id || 'dropdown'}`}
                      icon={<Sparkles size={13} />}
                    >
                      <span className="action-label-full">Regenerate with another AI Model</span>
                      <span className="action-label-compact">Another Model</span>
                    </Button>

                    {showAltMenu && (
                      <div
                        id={`alt-menu-${message?.id || 'dropdown'}`}
                        className="alternative-provider-dropdown"
                        role="menu"
                        aria-label="Select AI model for alternative response"
                      >
                        <div className="alternative-dropdown-header">
                          <span>Regenerate with another model:</span>
                        </div>
                        <div className="alternative-provider-list">
                          {selectableModels.length > 0 ? (
                            selectableModels.map((provider) => {
                              const isCurrent = provider.id === currentProviderId;
                              const hasExistingAlt = (message.alternatives || []).some((a) => a.provider === provider.id);
                              const altAvailability = getProviderConfigAvailability(provider.id, providerConfig);
                              const isConfirmedUnconfigured = altAvailability.state === 'unconfigured';
                              return (
                                <button
                                  key={provider.id}
                                  type="button"
                                  className={`alternative-provider-option ${isCurrent ? 'is-active-provider' : ''}`}
                                  onClick={() => {
                                    setShowAltMenu(false);
                                    onGenerateAlternative(message, provider.id);
                                  }}
                                  disabled={isLoading}
                                  role="menuitem"
                                >
                                  <div className="alt-provider-info">
                                    <span className="alt-provider-name">{provider.name}</span>
                                    <span className="alt-provider-model">{provider.modelTag}</span>
                                  </div>
                                  {isCurrent ? (
                                    <span className="alt-provider-current-tag" title="Currently viewing this model's response">
                                      Current
                                    </span>
                                  ) : hasExistingAlt ? (
                                    <span className="alt-provider-existing-tag" title="An alternative with this model was generated">
                                      Generated
                                    </span>
                                  ) : isConfirmedUnconfigured ? (
                                    <span className="alt-provider-existing-tag" title="Server API key not configured">
                                      Setup required
                                    </span>
                                  ) : (
                                    <span className="alt-provider-ready-tag">Generate</span>
                                  )}
                                </button>
                              );
                            })
                          ) : (
                            <div className="alt-empty-note">No other models available</div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

export default React.memo(ChatMessage);
