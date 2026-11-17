// @ts-check

const LIST_ITEM_RE = /^(?: {0,3})(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$)/;
const INDENTED_CONTINUATION_RE = /^(?: {2,}|\t)\S/;
const BLOCKQUOTE_RE = /^(?: {0,3})>/;
const REFERENCE_LINK_DEF_RE = /^[ \t]{0,3}\[[^\]\n]+\]:[ \t]*\S/m;
const REFERENCE_LINK_USAGE_RE = /\[[^\]\n]+\]\[[^\]\n]*\]/;
const FOOTNOTE_RE = /\[\^[^\]\s]+\]/;

/**
 * Checks whether a line opens a fenced code block (triple-backtick or triple-tilde).
 * @param {string} line
 * @returns {{ fenceChar: string, fenceLen: number } | null}
 */
export function isFenceStart(line) {
  const match = line.match(/^( {0,3})(`{3,}|~{3,})(.*)$/);
  if (!match) return null;
  const fenceChar = match[2][0];
  const fenceLen = match[2].length;
  const info = match[3] || '';
  if (fenceChar === '`' && info.includes('`')) return null;
  return { fenceChar, fenceLen };
}

/**
 * Checks whether a line closes the currently open fenced code block.
 * @param {string} line
 * @param {string} fenceChar
 * @param {number} fenceLen
 * @returns {boolean}
 */
export function isFenceClose(line, fenceChar, fenceLen) {
  const match = line.match(/^( {0,3})(`{3,}|~{3,})\s*$/);
  if (!match) return false;
  return match[2][0] === fenceChar && match[2].length >= fenceLen;
}

/**
 * Returns true if the markdown text contains reference-style links, reference definitions,
 * or footnotes that may require full-document resolution once streaming completes.
 *
 * @param {string} markdown
 * @returns {boolean}
 */
export function usesReferenceOrFootnoteDefs(markdown) {
  if (!markdown || typeof markdown !== 'string') return false;
  if (!markdown.includes('[')) return false;
  return (
    REFERENCE_LINK_DEF_RE.test(markdown) ||
    REFERENCE_LINK_USAGE_RE.test(markdown) ||
    FOOTNOTE_RE.test(markdown)
  );
}

/**
 * Splits a Markdown response into independent top-level blocks safe for incremental
 * memoized rendering during streaming.
 *
 * Never splits inside:
 * - Fenced code blocks (triple-backtick or triple-tilde)
 * - Multi-line display math blocks ($$...$$ or \[...\])
 * - Multi-paragraph lists / nested list continuations (preserving <ol> numbering & indentation)
 * - Multi-paragraph blockquotes / educational callouts
 * - Indented code continuations
 * - Trailing blank lines before the following content has arrived
 *
 * @param {string} markdown
 * @returns {string[]}
 */
export function splitMarkdownIntoStreamingBlocks(markdown) {
  if (!markdown || typeof markdown !== 'string') return [];

  const text = markdown.includes('\r')
    ? markdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    : markdown;

  if (!text) return [];

  const blocks = [];
  const len = text.length;
  let pos = 0;
  let blockStart = 0;

  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;
  let inDollarMath = false;
  let inBracketMath = false;

  let currentBlockHasList = false;
  let lastNonBlankWasBlockquote = false;
  let lastNonBlankWasIndented = false;
  let prevNonBlankEnd = -1;

  while (pos < len) {
    const nextNl = text.indexOf('\n', pos);
    const lineEnd = nextNl === -1 ? len : nextNl;
    const line = text.slice(pos, lineEnd);
    const lineIsBlank = line.trim().length === 0;

    if (inFence) {
      if (isFenceClose(line, fenceChar, fenceLen)) {
        inFence = false;
        fenceChar = '';
        fenceLen = 0;
      }
      prevNonBlankEnd = lineEnd;
      pos = nextNl === -1 ? len : nextNl + 1;
      continue;
    }

    if (inDollarMath) {
      if (/^[ \t]*\$\$[ \t]*$/.test(line) || (line.includes('$$') && !line.trimStart().startsWith('$$'))) {
        inDollarMath = false;
      }
      prevNonBlankEnd = lineEnd;
      pos = nextNl === -1 ? len : nextNl + 1;
      continue;
    }

    if (inBracketMath) {
      if (line.includes('\\]')) {
        inBracketMath = false;
      }
      prevNonBlankEnd = lineEnd;
      pos = nextNl === -1 ? len : nextNl + 1;
      continue;
    }

    if (!lineIsBlank) {
      const fence = isFenceStart(line);
      if (fence) {
        inFence = true;
        fenceChar = fence.fenceChar;
        fenceLen = fence.fenceLen;
        lastNonBlankWasBlockquote = false;
        lastNonBlankWasIndented = false;
        prevNonBlankEnd = lineEnd;
        pos = nextNl === -1 ? len : nextNl + 1;
        continue;
      }

      const trimmed = line.trim();
      // Multi-line $$ block open
      if (trimmed === '$$' || (trimmed.startsWith('$$') && !trimmed.slice(2).includes('$$'))) {
        inDollarMath = true;
      } else if (trimmed.startsWith('\\[') && !trimmed.slice(2).includes('\\]')) {
        inBracketMath = true;
      }

      if (LIST_ITEM_RE.test(line)) {
        currentBlockHasList = true;
      } else if (!INDENTED_CONTINUATION_RE.test(line) && !BLOCKQUOTE_RE.test(line)) {
        // Non-list, non-indented line outside a blank separator resets list tracking only on top-level paragraphs/headings
        if (
          /^(?: {0,3})#{1,6}(?:[ \t]|$)/.test(line) ||
          /^(?: {0,3})(?:[-*_]){3,}[ \t]*$/.test(line)
        ) {
          currentBlockHasList = false;
        }
      }

      lastNonBlankWasBlockquote = BLOCKQUOTE_RE.test(line);
      lastNonBlankWasIndented = INDENTED_CONTINUATION_RE.test(line);
      prevNonBlankEnd = lineEnd;
      pos = nextNl === -1 ? len : nextNl + 1;
      continue;
    }

    // Blank line at top level: look ahead past consecutive blank lines to the next non-blank line
    let scanPos = nextNl === -1 ? len : nextNl + 1;
    let nextNonBlankStart = -1;
    let nextNonBlankLine = '';

    while (scanPos < len) {
      const scanNl = text.indexOf('\n', scanPos);
      const scanEnd = scanNl === -1 ? len : scanNl;
      const candidate = text.slice(scanPos, scanEnd);
      if (candidate.trim().length > 0) {
        nextNonBlankStart = scanPos;
        nextNonBlankLine = candidate;
        break;
      }
      scanPos = scanNl === -1 ? len : scanNl + 1;
    }

    // Never split at trailing blank lines with no following non-blank content yet
    if (nextNonBlankStart === -1) {
      break;
    }

    // Only split if there was non-blank content before this blank line run
    if (prevNonBlankEnd > blockStart) {
      const nextIsListOrIndented =
        LIST_ITEM_RE.test(nextNonBlankLine) || INDENTED_CONTINUATION_RE.test(nextNonBlankLine);
      const nextIsBlockquote = BLOCKQUOTE_RE.test(nextNonBlankLine);

      const shouldKeepMerged =
        (currentBlockHasList && nextIsListOrIndented) ||
        (lastNonBlankWasBlockquote && nextIsBlockquote) ||
        (lastNonBlankWasIndented && INDENTED_CONTINUATION_RE.test(nextNonBlankLine));

      if (!shouldKeepMerged) {
        blocks.push(text.slice(blockStart, prevNonBlankEnd));
        blockStart = nextNonBlankStart;
        currentBlockHasList = false;
        lastNonBlankWasBlockquote = false;
        lastNonBlankWasIndented = false;
        prevNonBlankEnd = -1;
        pos = nextNonBlankStart;
        continue;
      }
    }

    pos = nextNonBlankStart;
  }

  if (blockStart < len) {
    blocks.push(text.slice(blockStart));
  }

  return blocks;
}
