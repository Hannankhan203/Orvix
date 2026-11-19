import React, { useEffect, useMemo, useState } from 'react';
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
import {
  isFenceStart,
  isFenceClose,
  splitMarkdownIntoStreamingBlocks,
  usesReferenceOrFootnoteDefs
} from './markdownStreamingUtils.js';

export { splitMarkdownIntoStreamingBlocks, usesReferenceOrFootnoteDefs };

/**
 * Recursively extracts plain text from React nodes or arrays of tokens
 * @param {any} node
 * @returns {string}
 */
export function extractNodeText(node) {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (!node) return '';
  if (Array.isArray(node)) return node.map(extractNodeText).join('');
  if (node.props?.children) return extractNodeText(node.props.children);
  return '';
}

const BASE_REMARK_PLUGINS = [remarkGfm];
/** @type {any[]} */
const EMPTY_REHYPE_PLUGINS = [];
const UNESCAPED_DOLLAR_RE = /(?:^|[^\\])(?:\\\\)*\$/;
const POTENTIAL_MATH_RE = /(?:\$|\\\(|\\\[)/;
const MARKDOWN_COMPONENTS_CACHE = new Map();

/** @type {any} */
let cachedMathPlugins = null;
/** @type {Promise<any>|null} */
let mathPluginsPromise = null;

function loadMathMarkdownPlugins() {
  if (cachedMathPlugins) {
    return Promise.resolve(cachedMathPlugins);
  }
  if (!mathPluginsPromise) {
    mathPluginsPromise = import('./mathMarkdownPlugins.js')
      .then((mod) => {
        cachedMathPlugins = {
          remarkPlugins: [remarkGfm, mod.MATH_REMARK_PLUGIN],
          rehypePlugins: [mod.MATH_REHYPE_PLUGIN]
        };
        return cachedMathPlugins;
      })
      .catch((err) => {
        mathPluginsPromise = null;
        throw err;
      });
  }
  return mathPluginsPromise;
}

/**
 * @param {string} text
 * @param {number} startIdx
 * @param {number} tickLen
 */
function findClosingInlineCode(text, startIdx, tickLen) {
  let i = startIdx;
  while (i < text.length) {
    if (text[i] === '\n' && text[i + 1] === '\n') return -1;
    if (text[i] === '`') {
      let count = 0;
      while (i + count < text.length && text[i + count] === '`') count++;
      if (count === tickLen) return i;
      i += count;
      continue;
    }
    i++;
  }
  return -1;
}

/**
 * @param {string} text
 * @param {number} startIdx
 * @param {string} closeSeq
 * @param {boolean} [stopOnDoubleNewline=false]
 */
function findClosingDelimiter(text, startIdx, closeSeq, stopOnDoubleNewline = false) {
  let i = startIdx;
  while (i < text.length) {
    if (stopOnDoubleNewline && text[i] === '\n' && text[i + 1] === '\n') {
      return -1;
    }
    if (text[i] === '\\' && i + 1 < text.length) {
      if (text.startsWith(closeSeq, i)) {
        return i;
      }
      i += 2;
      continue;
    }
    if (text.startsWith(closeSeq, i)) {
      return i;
    }
    i++;
  }
  return -1;
}

/**
 * @param {string} text
 * @param {number} startIdx
 */
function findNextSingleDollarInParagraph(text, startIdx) {
  let i = startIdx;
  while (i < text.length) {
    if (text[i] === '\n' && text[i + 1] === '\n') return -1;
    if (text[i] === '\\' && i + 1 < text.length) {
      i += 2;
      continue;
    }
    if (text[i] === '`') {
      let tickLen = 0;
      while (i + tickLen < text.length && text[i + tickLen] === '`') tickLen++;
      const closeCode = findClosingInlineCode(text, i + tickLen, tickLen);
      if (closeCode !== -1) {
        i = closeCode + tickLen;
        continue;
      }
      i += tickLen;
      continue;
    }
    if (text[i] === '$') {
      if (text[i + 1] === '$') {
        i += 2;
        continue;
      }
      return i;
    }
    i++;
  }
  return -1;
}

/**
 * @param {string} text
 * @param {number} dollarIdx
 */
function isCurrencyDollar(text, dollarIdx) {
  const afterDollar = text.slice(dollarIdx + 1);
  const numMatch = afterDollar.match(
    /^(\d+(?:,\d{3})*(?:\.\d+)?|\.\d+)(?:[kKmMbBtT](?![a-zA-Z0-9_]))?/
  );
  if (!numMatch) return false;

  const afterNumIdx = dollarIdx + 1 + numMatch[0].length;
  const nextChar = text[afterNumIdx] || '';

  // Explicit single-number math like $5$
  if (nextChar === '$') return false;

  // Immediate math/TeX token after digits (e.g. $2x$, $10^{-5}$, $5\times$, $2(x)$, $5!$)
  if (/^[a-zA-Z\\^_{[(+*=<>\|\~°!]/.test(nextChar)) {
    return false;
  }

  // Short inline numeric/variable fraction closed by '$' (e.g. $1/2$, $3/4$, $1/n$),
  // while keeping currency rates like $5/month or $10/user escaped as literal currency.
  const rest = text.slice(afterNumIdx);
  if (/^\/(?:\d+(?:\.\d+)?|[a-zA-Z])\$(?!\d)/.test(rest)) {
    return false;
  }

  // Whitespace + math operator leading to a non-currency closing '$' (e.g. $5 + 3 = 8$)
  if (/^[ \t]+(?:[+\-*\/=<>^_\\|×÷≤≥≠≈±·])/.test(rest)) {
    const nextDollar = findNextSingleDollarInParagraph(text, afterNumIdx);
    if (nextDollar !== -1) {
      const charAfterClose = text[nextDollar + 1] || '';
      if (!/^\d/.test(charAfterClose)) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Normalizes LaTeX delimiters (\(...\) and \[...\]) and single-line standalone $$...$$
 * for remark-math while leaving fenced code blocks, inline code, incomplete streaming
 * delimiters, and ordinary currency amounts ($5, $10, $19.99, $5M) untouched.
 * @param {any} markdown
 * @param {{ isStreaming?: boolean }} [options]
 */
export function preprocessMathMarkdown(markdown, { isStreaming = false } = {}) {
  if (!markdown || typeof markdown !== 'string') return '';

  // Fast-path: skip character-by-character math scanner when no '$', '\', or '\r' exists
  if (!markdown.includes('$') && !markdown.includes('\\') && !markdown.includes('\r')) {
    return markdown;
  }

  const text = markdown.includes('\r')
    ? markdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    : markdown;
  let out = '';
  let i = 0;
  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;

  while (i < text.length) {
    const atLineStart = i === 0 || text[i - 1] === '\n';

    if (atLineStart) {
      const nextNl = text.indexOf('\n', i);
      const lineEnd = nextNl === -1 ? text.length : nextNl;
      const line = text.slice(i, lineEnd);

      if (inFence) {
        out += line;
        if (nextNl !== -1) out += '\n';
        if (isFenceClose(line, fenceChar, fenceLen)) {
          inFence = false;
          fenceChar = '';
          fenceLen = 0;
        }
        i = nextNl === -1 ? text.length : nextNl + 1;
        continue;
      }

      const fence = isFenceStart(line);
      if (fence) {
        inFence = true;
        fenceChar = fence.fenceChar;
        fenceLen = fence.fenceLen;
        out += line;
        if (nextNl !== -1) out += '\n';
        i = nextNl === -1 ? text.length : nextNl + 1;
        continue;
      }
    }

    if (inFence) {
      out += text[i++];
      continue;
    }

    // Preserve inline code spans verbatim
    if (text[i] === '`') {
      let tickLen = 0;
      while (i + tickLen < text.length && text[i + tickLen] === '`') tickLen++;
      const closeCode = findClosingInlineCode(text, i + tickLen, tickLen);
      if (closeCode !== -1) {
        out += text.slice(i, closeCode + tickLen);
        i = closeCode + tickLen;
        continue;
      }
      out += text.slice(i, i + tickLen);
      i += tickLen;
      continue;
    }

    // Handle backslash escapes and LaTeX \(...\) / \[...\] delimiters
    if (text[i] === '\\' && i + 1 < text.length) {
      const next = text[i + 1];
      if (next === '[') {
        const closeIdx = findClosingDelimiter(text, i + 2, '\\]', false);
        if (closeIdx !== -1) {
          const lineStart = out.lastIndexOf('\n') + 1;
          const beforeOnLine = out.slice(lineStart);
          const containerPrefix = /^(?:[ \t]*>[ \t]?)+[ \t]*$|^[ \t]*$/.test(beforeOnLine)
            ? beforeOnLine
            : null;
          let rawInner = text.slice(i + 2, closeIdx);
          if (containerPrefix && containerPrefix.includes('>')) {
            rawInner = rawInner
              .split('\n')
              .map((ln, idx) => (idx === 0 ? ln : ln.replace(/^(?:[ \t]*>[ \t]?)+/, '')))
              .join('\n');
          }
          const innerLines = rawInner.trim().split('\n');
          const afterClose = text[closeIdx + 2] || '';
          const needsTrailingNl = afterClose !== '' && afterClose !== '\n';

          if (containerPrefix !== null) {
            const prefixedInner = innerLines
              .map((ln) => `${containerPrefix}${ln}`)
              .join('\n');
            out += `$$\n${prefixedInner}\n${containerPrefix}$$${needsTrailingNl ? `\n${containerPrefix}` : ''}`;
          } else {
            const needsLeadingNl = out.length > 0 && !out.endsWith('\n');
            out += `${needsLeadingNl ? '\n' : ''}$$\n${innerLines.join('\n')}\n$$${needsTrailingNl ? '\n' : ''}`;
          }
          i = closeIdx + 2;
          continue;
        }
      } else if (next === '(') {
        const closeIdx = findClosingDelimiter(text, i + 2, '\\)', true);
        if (closeIdx !== -1) {
          const inner = text.slice(i + 2, closeIdx).trim();
          if (inner.length > 0) {
            out += `$${inner}$`;
            i = closeIdx + 2;
            continue;
          }
        }
      }
      out += text.slice(i, i + 2);
      i += 2;
      continue;
    }

    // Block math $$...$$
    if (text[i] === '$' && text[i + 1] === '$') {
      const closeIdx = findClosingDelimiter(text, i + 2, '$$', false);
      if (closeIdx !== -1) {
        const inner = text.slice(i + 2, closeIdx);
        const lineStart = out.lastIndexOf('\n') + 1;
        const beforeOnLine = out.slice(lineStart);
        const afterEndIdx = text.indexOf('\n', closeIdx + 2);
        const afterOnLine = text.slice(
          closeIdx + 2,
          afterEndIdx === -1 ? text.length : afterEndIdx
        );
        const isContainerPrefix = /^(?:[ \t]*>[ \t]?)+[ \t]*$|^[ \t]*$/.test(beforeOnLine);

        if (!inner.includes('\n') && isContainerPrefix && /^[ \t]*$/.test(afterOnLine)) {
          out += `$$\n${beforeOnLine}${inner.trim()}\n${beforeOnLine}$$`;
        } else {
          out += `$$${inner}$$`;
        }
        i = closeIdx + 2;
        continue;
      }
      // While streaming, escape unclosed $$ so micromark-extension-math does not auto-close
      // an incomplete block at EOF and flash a KaTeX parse error mid-response.
      out += isStreaming ? '\\$\\$' : '$$';
      i += 2;
      continue;
    }

    // Single '$': escape ordinary currency amounts so remark-math does not pair them
    if (text[i] === '$') {
      out += isCurrencyDollar(text, i) ? '\\$' : '$';
      i += 1;
      continue;
    }

    out += text[i++];
  }

  return out;
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
 * @param {boolean} [isStreaming=false]
 * @param {string} [effectiveMode='general']
 * @returns {any}
 */
export function createMarkdownComponents(isStreaming = false, effectiveMode = 'general') {
  return {
    // Pass-through wrapper for pre so inner code block receives isBlock flag
    pre: (/** @type {any} */ { node, children, ...props }) => {
      if (React.isValidElement(children)) {
        return React.cloneElement(/** @type {any} */ (children), { isBlock: true });
      }
      return <pre {...props}>{children}</pre>;
    },

    // Fenced code block or inline code
    code: (/** @type {any} */ { node, className, children, isBlock, ...props }) => {
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
    a: (/** @type {any} */ { node, href, children, ...props }) => {
      const isSafeHref = href && /^(https?:\/\/|mailto:)/i.test(href);
      return (
        <a
          href={isSafeHref ? href : '#'}
          target={isSafeHref ? '_blank' : undefined}
          rel={isSafeHref ? 'noopener noreferrer' : undefined}
          onClick={!isSafeHref ? (/** @type {any} */ e) => e.preventDefault() : undefined}
          className="markdown-link"
          {...props}
        >
          {children}
        </a>
      );
    },

    // Responsive scrollable tables with keyboard accessibility
    table: (/** @type {any} */ { node, children, ...props }) => (
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
    thead: (/** @type {any} */ { node, children, ...props }) => <thead className="markdown-thead" {...props}>{children}</thead>,
    tbody: (/** @type {any} */ { node, children, ...props }) => <tbody className="markdown-tbody" {...props}>{children}</tbody>,
    tr: (/** @type {any} */ { node, children, ...props }) => <tr className="markdown-tr" {...props}>{children}</tr>,
    th: (/** @type {any} */ { node, children, ...props }) => <th className="markdown-th" {...props}>{children}</th>,
    td: (/** @type {any} */ { node, children, ...props }) => <td className="markdown-td" {...props}>{children}</td>,

    // Semantic headings establishing visual hierarchy
    h1: (/** @type {any} */ { node, children, ...props }) => (
      <h1
        className={`markdown-h1 ${effectiveMode === 'learning' ? 'educational-topic-heading' : ''} ${effectiveMode === 'writing' ? 'writing-h1' : ''} ${effectiveMode === 'coding' ? 'coding-h1' : ''}`}
        {...props}
      >
        {children}
      </h1>
    ),
    h2: (/** @type {any} */ { node, children, ...props }) => (
      <h2
        className={`markdown-h2 ${effectiveMode === 'learning' ? 'educational-concept-heading' : ''} ${effectiveMode === 'writing' ? 'writing-h2' : ''} ${effectiveMode === 'coding' ? 'coding-h2' : ''}`}
        {...props}
      >
        {children}
      </h2>
    ),
    h3: (/** @type {any} */ { node, children, ...props }) => (
      <h3
        className={`markdown-h3 ${effectiveMode === 'learning' ? 'educational-subconcept-heading' : ''} ${effectiveMode === 'writing' ? 'writing-h3' : ''} ${effectiveMode === 'coding' ? 'coding-h3' : ''}`}
        {...props}
      >
        {children}
      </h3>
    ),
    h4: (/** @type {any} */ { node, children, ...props }) => (
      <h4
        className={`markdown-h4 ${effectiveMode === 'learning' ? 'educational-step-heading' : ''} ${effectiveMode === 'writing' ? 'writing-h4' : ''} ${effectiveMode === 'coding' ? 'coding-h4' : ''}`}
        {...props}
      >
        {children}
      </h4>
    ),
    h5: (/** @type {any} */ { node, children, ...props }) => (
      <h5 className={`markdown-h5 ${effectiveMode === 'writing' ? 'writing-h5' : ''} ${effectiveMode === 'coding' ? 'coding-h5' : ''}`} {...props}>
        {children}
      </h5>
    ),
    h6: (/** @type {any} */ { node, children, ...props }) => (
      <h6 className={`markdown-h6 ${effectiveMode === 'writing' ? 'writing-h6' : ''} ${effectiveMode === 'coding' ? 'coding-h6' : ''}`} {...props}>
        {children}
      </h6>
    ),

    // Text formatting with Learning Mode Educational Callout recognition
    p: (/** @type {any} */ { node, children, ...props }) => {
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
    strong: (/** @type {any} */ { node, children, ...props }) => <strong className="markdown-strong" {...props}>{children}</strong>,
    b: (/** @type {any} */ { node, children, ...props }) => <b className="markdown-strong" {...props}>{children}</b>,
    em: (/** @type {any} */ { node, children, ...props }) => <em className="markdown-em" {...props}>{children}</em>,
    i: (/** @type {any} */ { node, children, ...props }) => <i className="markdown-em" {...props}>{children}</i>,
    del: (/** @type {any} */ { node, children, ...props }) => <del className="markdown-del" {...props}>{children}</del>,
    s: (/** @type {any} */ { node, children, ...props }) => <s className="markdown-del" {...props}>{children}</s>,
    blockquote: (/** @type {any} */ { node, children, ...props }) => {
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
    ul: (/** @type {any} */ { node, children, ...props }) => (
      <ul className={`markdown-ul ${effectiveMode === 'writing' ? 'writing-ul' : ''}`} {...props}>
        {children}
      </ul>
    ),
    ol: (/** @type {any} */ { node, children, start, ...props }) => (
      <ol className={`markdown-ol ${effectiveMode === 'writing' ? 'writing-ol' : ''}`} start={start} {...props}>
        {children}
      </ol>
    ),
    li: (/** @type {any} */ { node, children, checked, ...props }) => {
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
    hr: (/** @type {any} */ { node, ...props }) => (
      <hr className={`markdown-divider ${effectiveMode === 'writing' ? 'writing-divider' : ''}`} {...props} />
    )
  };
}

function getCachedMarkdownComponents(isStreaming = false, effectiveMode = 'general') {
  const key = `${isStreaming ? '1' : '0'}:${effectiveMode || 'general'}`;
  let cached = MARKDOWN_COMPONENTS_CACHE.get(key);
  if (!cached) {
    cached = createMarkdownComponents(isStreaming, effectiveMode);
    MARKDOWN_COMPONENTS_CACHE.set(key, cached);
  }
  return cached;
}

/**
 * Single memoized Markdown block renderer.
 * Completed prefix blocks during streaming retain stable props so React skips
 * both preprocessMathMarkdown() and ReactMarkdown AST reparsing on every new token.
 */
const MemoizedMarkdownBlock = React.memo(
  /** @param {any} props */
  function MemoizedMarkdownBlock({
    rawBlock,
    isStreaming = false,
    effectiveMode = 'general',
    mathPlugins = null
  }) {
  const processedContent = useMemo(
    () => preprocessMathMarkdown(rawBlock, { isStreaming }),
    [rawBlock, isStreaming]
  );

  const needsMath = useMemo(
    () => processedContent.includes('$') && UNESCAPED_DOLLAR_RE.test(processedContent),
    [processedContent]
  );

  const components = getCachedMarkdownComponents(isStreaming, effectiveMode);
  const remarkPlugins = needsMath && mathPlugins ? mathPlugins.remarkPlugins : BASE_REMARK_PLUGINS;
  const rehypePlugins = needsMath && mathPlugins ? mathPlugins.rehypePlugins : EMPTY_REHYPE_PLUGINS;

  return (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      components={components}
    >
      {processedContent}
    </ReactMarkdown>
  );
});

/**
 * MarkdownContent Component
 * Renders sanitized Markdown with incremental block-level memoization during streaming
 * while preserving code highlighting, tables, math, callouts, and reference links.
 * @param {any} props
 */
function MarkdownContent({ content = '', isStreaming = false, effectiveMode = 'general' }) {
  const text = typeof content === 'string' ? content : '';

  const mayNeedMath = useMemo(
    () => POTENTIAL_MATH_RE.test(text),
    [text]
  );

  const [mathPlugins, setMathPlugins] = useState(() => cachedMathPlugins);

  useEffect(() => {
    if (!mayNeedMath || mathPlugins) return undefined;
    let cancelled = false;
    loadMathMarkdownPlugins()
      .then((plugins) => {
        if (!cancelled) {
          setMathPlugins(plugins);
        }
      })
      .catch((err) => {
        console.warn('Failed to load math rendering plugins:', err);
      });
    return () => {
      cancelled = true;
    };
  }, [mayNeedMath, mathPlugins]);

  // Keep cross-block reference links and footnotes unified once streaming finishes.
  const shouldUseBlockSplitting = useMemo(() => {
    if (!text) return false;
    if (isStreaming) return true;
    return !usesReferenceOrFootnoteDefs(text);
  }, [text, isStreaming]);

  const blocks = useMemo(() => {
    if (!text) return [];
    if (!shouldUseBlockSplitting) return [text];
    return splitMarkdownIntoStreamingBlocks(text);
  }, [text, shouldUseBlockSplitting]);

  if (blocks.length === 0) {
    return null;
  }

  if (blocks.length === 1) {
    return (
      <MemoizedMarkdownBlock
        rawBlock={blocks[0]}
        isStreaming={isStreaming}
        effectiveMode={effectiveMode}
        mathPlugins={mathPlugins}
      />
    );
  }

  const lastIndex = blocks.length - 1;
  return (
    <>
      {blocks.map((block, index) => (
        <MemoizedMarkdownBlock
          key={index}
          rawBlock={block}
          isStreaming={index === lastIndex ? isStreaming : false}
          effectiveMode={effectiveMode}
          mathPlugins={mathPlugins}
        />
      ))}
    </>
  );
}

export default React.memo(MarkdownContent);
