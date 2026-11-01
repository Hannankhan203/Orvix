import React, { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  AlertCircle,
  AlertTriangle,
  Lightbulb,
  CheckCircle2,
  BookOpen,
  Bookmark,
  Sparkles,
  Info
} from 'lucide-react';
import CodeBlock from './CodeBlock.jsx';

/**
 * Recursively extracts plain text from React nodes or arrays of tokens
 */
export function extractNodeText(node) {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (!node) return '';
  if (Array.isArray(node)) return node.map(extractNodeText).join('');
  if (node.props?.children) return extractNodeText(node.props.children);
  return '';
}

export const CalloutContext = React.createContext(false);

/**
 * Detects educational callout structures (Important, Note, Warning, Tip, Key takeaway, Definition, Example, Comparison)
 * Supports GFM alert tags, emoji prefixes, and conversational bold/italic headers with optional qualifiers.
 */
export function detectCalloutType(text = '') {
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
export function createMarkdownComponents(isStreaming = false, effectiveMode = 'general') {
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
 * MarkdownContent Component
 * Renders sanitized Markdown with custom typography, code highlighting, tables, and callouts
 */
export default function MarkdownContent({ content = '', isStreaming = false, effectiveMode = 'general' }) {
  const markdownComponents = useMemo(
    () => createMarkdownComponents(isStreaming, effectiveMode),
    [isStreaming, effectiveMode]
  );

  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
      {content || ''}
    </ReactMarkdown>
  );
}
