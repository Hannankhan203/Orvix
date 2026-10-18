import React, { useState, useMemo } from 'react';
import { Check, Copy, Terminal, Code2 } from 'lucide-react';
import { tokenizeCode } from '../../utils/syntaxHighlighter.js';

/**
 * Normalized language mappings and friendly display names
 */
const LANGUAGE_META = {
  javascript: { id: 'javascript', label: 'JavaScript' },
  js: { id: 'javascript', label: 'JavaScript' },
  node: { id: 'javascript', label: 'JavaScript' },
  mjs: { id: 'javascript', label: 'JavaScript' },
  cjs: { id: 'javascript', label: 'JavaScript' },

  typescript: { id: 'typescript', label: 'TypeScript' },
  ts: { id: 'typescript', label: 'TypeScript' },

  jsx: { id: 'jsx', label: 'JSX' },
  tsx: { id: 'tsx', label: 'TSX' },

  html: { id: 'markup', label: 'HTML' },
  xml: { id: 'markup', label: 'XML' },
  svg: { id: 'markup', label: 'SVG' },
  markup: { id: 'markup', label: 'HTML' },

  css: { id: 'css', label: 'CSS' },
  scss: { id: 'css', label: 'SCSS' },
  sass: { id: 'css', label: 'Sass' },

  json: { id: 'json', label: 'JSON' },

  python: { id: 'python', label: 'Python' },
  py: { id: 'python', label: 'Python' },
  python3: { id: 'python', label: 'Python' },

  sql: { id: 'sql', label: 'SQL' },
  mysql: { id: 'sql', label: 'MySQL' },
  pgsql: { id: 'sql', label: 'PostgreSQL' },
  postgres: { id: 'sql', label: 'PostgreSQL' },
  postgresql: { id: 'sql', label: 'PostgreSQL' },
  sqlite: { id: 'sql', label: 'SQLite' },

  bash: { id: 'bash', label: 'Bash' },
  sh: { id: 'bash', label: 'Shell' },
  shell: { id: 'bash', label: 'Shell' },
  zsh: { id: 'bash', label: 'Zsh' },

  yaml: { id: 'yaml', label: 'YAML' },
  yml: { id: 'yaml', label: 'YAML' },

  markdown: { id: 'markdown', label: 'Markdown' },
  md: { id: 'markdown', label: 'Markdown' },

  c: { id: 'c', label: 'C' },
  cpp: { id: 'cpp', label: 'C++' },
  'c++': { id: 'cpp', label: 'C++' },
  cc: { id: 'cpp', label: 'C++' },
  cxx: { id: 'cpp', label: 'C++' },

  csharp: { id: 'csharp', label: 'C#' },
  'c#': { id: 'csharp', label: 'C#' },
  cs: { id: 'csharp', label: 'C#' },

  java: { id: 'java', label: 'Java' },
  go: { id: 'go', label: 'Go' },
  golang: { id: 'go', label: 'Go' },
  rust: { id: 'rust', label: 'Rust' },
  rs: { id: 'rust', label: 'Rust' },

  plaintext: { id: 'plaintext', label: 'Plain Text' },
  text: { id: 'plaintext', label: 'Plain Text' },
  txt: { id: 'plaintext', label: 'Plain Text' }
};

/**
 * Resolves a language identifier and display label
 */
function resolveLanguage(rawLang) {
  if (!rawLang || !rawLang.trim()) {
    return { id: 'plaintext', label: 'Code', isSpecified: false };
  }

  const clean = rawLang.toLowerCase().trim();
  if (LANGUAGE_META[clean]) {
    return { ...LANGUAGE_META[clean], isSpecified: true };
  }

  // Format custom/unlisted language nicely (e.g. "dockerfile" -> "Dockerfile")
  const capitalized = clean.charAt(0).toUpperCase() + clean.slice(1);
  return {
    id: clean,
    label: capitalized,
    isSpecified: true
  };
}

/**
 * Safely renders tokens to React nodes with exact whitespace and formatting preservation
 */
function renderHighlightedTokens(tokens) {
  if (!tokens || !tokens.length) return null;

  return tokens.map((token, index) => {
    if (token.type === 'plain') {
      return token.content;
    }
    return (
      <span key={index} className={`token ${token.type}`}>
        {token.content}
      </span>
    );
  });
}

/**
 * Developer-friendly Code Block Component
 * Features:
 * - Real-time syntax highlighting for major languages without external CJS/ESM dependencies
 * - Fallback to readable interim rendering during streaming or syntax glitches
 * - Strict text-only handling (no execution, zero XSS vulnerability)
 * - Copy Code button with success/error state feedback
 * - Horizontal scrolling for long lines without stretching page
 * - Line numbers for multiline code
 * - Preserves indentation, whitespace, and special characters
 */
export default function CodeBlock({ code = '', language = '', isStreaming = false }) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  // Normalize code string (stripping trailing newline once)
  const normalizedCode = useMemo(() => {
    return typeof code === 'string' ? code.replace(/\n$/, '') : String(code || '');
  }, [code]);

  const langInfo = useMemo(() => resolveLanguage(language), [language]);

  // Compute line count for line numbers
  const lines = useMemo(() => {
    return normalizedCode.split('\n');
  }, [normalizedCode]);

  const showLineNumbers = lines.length > 1;

  // Safe syntax highlighting via internal tokenizer
  const highlightedContent = useMemo(() => {
    if (!normalizedCode) return '';

    if (langInfo.id === 'plaintext') {
      return normalizedCode;
    }

    try {
      const tokens = tokenizeCode(normalizedCode, langInfo.id);
      return renderHighlightedTokens(tokens);
    } catch (err) {
      console.warn('Syntax highlighting encountered an issue, using plain text fallback:', err);
      return normalizedCode;
    }
  }, [normalizedCode, langInfo.id]);

  // Safe clipboard copy handler
  const handleCopy = async () => {
    if (!normalizedCode) return;

    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(normalizedCode);
        setCopied(true);
        setCopyFailed(false);
        setTimeout(() => setCopied(false), 2000);
        return;
      }
      throw new Error('Clipboard API unavailable');
    } catch (_) {
      try {
        const textarea = document.createElement('textarea');
        textarea.value = normalizedCode;
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
          setCopyFailed(false);
          setTimeout(() => setCopied(false), 2000);
          return;
        }
      } catch (err) {
        console.warn('Fallback code copy failed:', err);
      }

      setCopyFailed(true);
      setTimeout(() => setCopyFailed(false), 2500);
    }
  };

  const isTerminalLang = ['bash', 'sh', 'shell', 'zsh'].includes(langInfo.id);

  return (
    <div className={`code-block-container ${isStreaming ? 'streaming-code' : ''}`}>
      {/* Code Block Header */}
      <div className="code-block-header">
        <div className="code-header-left">
          {isTerminalLang ? (
            <Terminal size={13} className="code-lang-icon" aria-hidden="true" />
          ) : (
            <Code2 size={13} className="code-lang-icon" aria-hidden="true" />
          )}
          <span className="code-lang-label" title={langInfo.isSpecified ? `Language: ${langInfo.label}` : 'Code block'}>
            {langInfo.label}
          </span>
          {showLineNumbers && (
            <span className="code-lines-count" title={`${lines.length} lines of code`}>
              {lines.length} lines
            </span>
          )}
        </div>

        <button
          type="button"
          className={`code-copy-btn ${copied ? 'copied' : ''} ${copyFailed ? 'failed' : ''}`}
          onClick={handleCopy}
          title="Copy code to clipboard"
          aria-label="Copy code snippet"
        >
          {copied ? (
            <>
              <Check size={13} className="copy-icon success" />
              <span>Copied!</span>
            </>
          ) : copyFailed ? (
            <span>Failed</span>
          ) : (
            <>
              <Copy size={13} className="copy-icon" />
              <span>Copy code</span>
            </>
          )}
        </button>
      </div>

      {/* Code Block Body with Optional Line Numbers and Horizontal Scrolling */}
      <div className="code-content-wrapper">
        {showLineNumbers && (
          <div className="code-line-numbers" aria-hidden="true">
            {lines.map((_, index) => (
              <span key={index} className="line-number">
                {index + 1}
              </span>
            ))}
          </div>
        )}

        <pre className="code-content" tabIndex={0}>
          <code className={`code-syntax language-${langInfo.id}`}>
            {highlightedContent}
          </code>
        </pre>
      </div>
    </div>
  );
}
