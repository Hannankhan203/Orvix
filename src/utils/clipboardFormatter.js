/**
 * Clipboard Formatter Utility for Orvix
 * Provides dual-format clipboard generation (text/html and text/plain)
 * ensuring tables, code blocks, and mixed responses remain unambiguous,
 * properly attributed, and well-structured when pasted into messaging apps
 * (WhatsApp, Telegram) and rich-text editors (Google Docs, Word, Slack).
 */

/**
 * Escapes raw HTML characters to prevent XSS or malformed tags
 */
export function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Splits a Markdown table row into trimmed cell strings,
 * respecting escaped pipes (\|).
 */
export function splitRowIntoCells(rowStr) {
  if (!rowStr || typeof rowStr !== 'string') return [];
  const ESC_PIPE = '\u0000PIPE\u0000';
  const protectedStr = rowStr.replace(/\\\|/g, ESC_PIPE).trim();

  let parts = protectedStr.split('|');

  // Strip leading empty string if row started with |
  if (protectedStr.startsWith('|')) {
    parts.shift();
  }
  // Strip trailing empty string if row ended with |
  if (protectedStr.endsWith('|')) {
    parts.pop();
  }

  return parts.map((cell) => {
    return cell.replace(new RegExp(ESC_PIPE, 'g'), '|').trim();
  });
}

/**
 * Determines if a row is a Markdown table delimiter row (e.g. | --- | :---: | ---: |)
 */
export function isDelimiterRow(rowStr) {
  if (!rowStr || !rowStr.includes('-') || !rowStr.includes('|')) return false;
  const trimmed = rowStr.trim();
  if (!/^\|?[\s\-:|]+\|?$/.test(trimmed)) return false;
  const cells = splitRowIntoCells(trimmed);
  if (cells.length === 0) return false;
  return cells.every((c) => /^:?-+:?$/.test(c.trim()));
}

/**
 * Extracts column text alignment rules from a delimiter row
 */
export function getColumnAlignments(delimiterRowStr) {
  const cells = splitRowIntoCells(delimiterRowStr);
  return cells.map((cell) => {
    const trimmed = cell.trim();
    const starts = trimmed.startsWith(':');
    const ends = trimmed.endsWith(':');
    if (starts && ends) return 'center';
    if (ends) return 'right';
    return 'left';
  });
}

/**
 * Cleans markdown formatting characters from header text for plain-text labeling
 */
function cleanHeaderLabel(header) {
  if (!header) return '';
  return header
    .replace(/^[`*_\s]+|[`*_\s]+$/g, '')
    .trim();
}

/**
 * Formats parsed table data into an unambiguous plain-text record layout
 * designed specifically for messaging apps (e.g. WhatsApp) using proportional fonts.
 *
 * Each row is structured as:
 * • Header1: Value1
 *   Header2: Value2
 *   Header3: Value3
 */
export function formatTableAsPlainText(headers, rows) {
  const cleanHeaders = (headers || []).map((h, i) => cleanHeaderLabel(h) || `Field ${i + 1}`);

  if (!rows || rows.length === 0) {
    if (cleanHeaders.length === 0) return '';
    return cleanHeaders.map((h, i) => (i === 0 ? `• ${h}: -` : `  ${h}: -`)).join('\n');
  }

  const formattedRows = rows.map((row) => {
    // Single column table fallback
    if (cleanHeaders.length <= 1) {
      const val = row[0] !== undefined && row[0] !== '' ? row[0] : '-';
      return `• ${val}`;
    }

    // Multi-column table: explicitly labeled fields per row
    const fieldLines = cleanHeaders.map((header, colIdx) => {
      const rawVal = row[colIdx] !== undefined && row[colIdx] !== '' ? row[colIdx] : '-';
      // Normalize internal <br> breaks into indented sublines
      const cleanVal = String(rawVal).replace(/<br\s*\/?>/gi, '\n    ');

      if (colIdx === 0) {
        return `• ${header}: ${cleanVal}`;
      }
      return `  ${header}: ${cleanVal}`;
    });

    return fieldLines.join('\n');
  });

  return formattedRows.join('\n\n');
}

/**
 * Converts inline markdown (bold, italic, code, links) to safe HTML
 */
export function inlineMarkdownToHtml(text) {
  if (!text) return '';
  let out = String(text).replace(/<br\s*\/?>/gi, '\u0000BR\u0000');
  out = escapeHtml(out);
  out = out.replace(/\u0000BR\u0000/g, '<br>');

  // Bold
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>');

  // Italic
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  out = out.replace(/_([^_]+)_/g, '<em>$1</em>');

  // Inline Code
  out = out.replace(/`([^`]+)`/g, '<code style="background-color: #f1f5f9; padding: 2px 4px; border-radius: 4px; font-family: monospace; font-size: 0.9em;">$1</code>');

  // Links
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" style="color: #2563eb; text-decoration: underline;" target="_blank" rel="noopener noreferrer">$1</a>');

  return out;
}

/**
 * Formats parsed table data into a clean, fully-styled HTML table
 * for rich-text destinations (Google Docs, Word, Outlook, Slack).
 */
export function formatTableAsHtml(headers, rows, alignments = []) {
  const tableStyle = 'border-collapse: collapse; width: 100%; margin: 12px 0; font-family: -apple-system, BlinkMacSystemFont, \'Segoe UI\', Roboto, Helvetica, Arial, sans-serif; font-size: 14px; line-height: 1.5; color: #1e293b;';
  const thStyleBase = 'border: 1px solid #cbd5e1; padding: 8px 12px; font-weight: 600; color: #0f172a;';
  const tdStyleBase = 'border: 1px solid #e2e8f0; padding: 8px 12px; color: #334155;';

  const theadThs = headers.map((h, i) => {
    const align = alignments[i] || 'left';
    return `<th style="${thStyleBase} text-align: ${align};">${inlineMarkdownToHtml(h)}</th>`;
  }).join('');

  const theadHtml = `<thead style="background-color: #f1f5f9; border-bottom: 2px solid #cbd5e1;"><tr>${theadThs}</tr></thead>`;

  const tbodyRows = rows.map((row, rIdx) => {
    const bgColor = rIdx % 2 === 0 ? '#ffffff' : '#f8fafc';
    const tds = headers.map((_, i) => {
      const val = row[i] !== undefined && row[i] !== '' ? row[i] : '';
      const align = alignments[i] || 'left';
      return `<td style="${tdStyleBase} text-align: ${align};">${inlineMarkdownToHtml(val)}</td>`;
    }).join('');
    return `<tr style="background-color: ${bgColor}; border-bottom: 1px solid #e2e8f0;">${tds}</tr>`;
  }).join('');

  const tbodyHtml = `<tbody>${tbodyRows}</tbody>`;

  return `<table style="${tableStyle}">${theadHtml}${tbodyHtml}</table>`;
}

/**
 * Detects whether markdown content contains any Markdown table blocks
 */
export function hasMarkdownTable(markdown) {
  if (!markdown || typeof markdown !== 'string') return false;
  const lines = markdown.split(/\r?\n/);
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].includes('|') && isDelimiterRow(lines[i + 1])) {
      return true;
    }
  }
  return false;
}

/**
 * Parses a markdown document, protecting fenced code blocks, and replaces
 * table sections with plain-text or HTML equivalents while preserving
 * all other markdown/plain text and block structures.
 *
 * @param {string} markdown - Source message content
 * @returns {{ plainText: string, htmlText: string, containsTable: boolean }}
 */
export function formatMessageForClipboard(markdown) {
  if (!markdown || typeof markdown !== 'string') {
    return { plainText: '', htmlText: '', containsTable: false };
  }

  // Normalize line endings
  const normalized = markdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Step 1: Protect fenced code blocks cleanly
  const codeBlocks = [];
  const protectedText = normalized.replace(/```([a-zA-Z0-9_ -]*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const token = `\u0000FENCED_CODE_${codeBlocks.length}\u0000`;
    codeBlocks.push({ lang: (lang || '').trim(), code });
    return token;
  });

  const lines = protectedText.split('\n');
  const plainSegments = [];
  const htmlSegments = [];
  let containsTable = false;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Check if this line starts a table:
    // It must contain '|', not be a delimiter itself, followed by a delimiter line
    if (line.includes('|') && i + 1 < lines.length && isDelimiterRow(lines[i + 1])) {
      containsTable = true;
      const headers = splitRowIntoCells(line);
      const alignments = getColumnAlignments(lines[i + 1]);
      const rows = [];

      i += 2; // Move past header and delimiter line

      // Collect data rows
      while (i < lines.length && lines[i].trim() !== '' && lines[i].includes('|') && !isDelimiterRow(lines[i])) {
        const cells = splitRowIntoCells(lines[i]);
        rows.push(cells);
        i++;
      }

      // Convert table to both representations
      const tablePlain = formatTableAsPlainText(headers, rows);
      const tableHtml = formatTableAsHtml(headers, rows, alignments);

      plainSegments.push(tablePlain);
      htmlSegments.push(tableHtml);
      continue;
    }

    // Regular line / non-table content
    plainSegments.push(line);
    i++;
  }

  // Restore fenced code blocks into plain text
  let plainResult = plainSegments.join('\n');
  plainResult = plainResult.replace(/\u0000FENCED_CODE_(\d+)\u0000/g, (_, idx) => {
    const item = codeBlocks[Number(idx)];
    if (!item) return '';
    return `\`\`\`${item.lang}\n${item.code}\`\`\``;
  });

  // Step 2: Build HTML representation for full rich-text clipboard
  // If the document contains tables, we want full rich HTML
  const htmlResult = buildFullHtmlDocument(protectedText, codeBlocks);

  return {
    plainText: plainResult,
    htmlText: htmlResult,
    containsTable
  };
}

/**
 * Builds a styled, complete HTML fragment from markdown content
 * for rich-text clipboard destinations.
 */
function buildFullHtmlDocument(protectedText, codeBlocks) {
  const lines = protectedText.split('\n');
  const htmlParts = [];
  let inList = false;
  let listType = null; // 'ul' | 'ol'

  const closeListIfOpen = () => {
    if (inList) {
      htmlParts.push(listType === 'ol' ? '</ol>' : '</ul>');
      inList = false;
      listType = null;
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block placeholder
    const codeMatch = line.match(/^\u0000FENCED_CODE_(\d+)\u0000$/);
    if (codeMatch) {
      closeListIfOpen();
      const item = codeBlocks[Number(codeMatch[1])];
      if (item) {
        const preStyle = 'background-color: #0f172a; color: #f8fafc; padding: 12px 16px; border-radius: 8px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 13px; line-height: 1.5; overflow-x: auto; margin: 12px 0;';
        htmlParts.push(`<pre style="${preStyle}"><code>${escapeHtml(item.code)}</code></pre>`);
      }
      i++;
      continue;
    }

    // Table detection
    if (line.includes('|') && i + 1 < lines.length && isDelimiterRow(lines[i + 1])) {
      closeListIfOpen();
      const headers = splitRowIntoCells(line);
      const alignments = getColumnAlignments(lines[i + 1]);
      const rows = [];

      i += 2;
      while (i < lines.length && lines[i].trim() !== '' && lines[i].includes('|') && !isDelimiterRow(lines[i])) {
        rows.push(splitRowIntoCells(lines[i]));
        i++;
      }

      htmlParts.push(formatTableAsHtml(headers, rows, alignments));
      continue;
    }

    // Blank line
    if (!line.trim()) {
      closeListIfOpen();
      i++;
      continue;
    }

    // Headings (#, ##, ###)
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      closeListIfOpen();
      const level = headingMatch[1].length;
      const text = inlineMarkdownToHtml(headingMatch[2].trim());
      const fontSize = level === 1 ? '1.5em' : level === 2 ? '1.3em' : level === 3 ? '1.15em' : '1em';
      const weight = level <= 2 ? '700' : '600';
      htmlParts.push(`<h${level} style="font-size: ${fontSize}; font-weight: ${weight}; margin: 16px 0 8px; color: #0f172a;">${text}</h${level}>`);
      i++;
      continue;
    }

    // Blockquote
    const bqMatch = line.match(/^>\s*(.+)$/);
    if (bqMatch) {
      closeListIfOpen();
      const bqStyle = 'border-left: 3px solid #94a3b8; padding-left: 12px; margin: 8px 0; color: #475569; font-style: italic;';
      htmlParts.push(`<blockquote style="${bqStyle}">${inlineMarkdownToHtml(bqMatch[1])}</blockquote>`);
      i++;
      continue;
    }

    // Unordered List (- item, * item)
    const ulMatch = line.match(/^[-*]\s+(.+)$/);
    if (ulMatch) {
      if (!inList || listType !== 'ul') {
        closeListIfOpen();
        htmlParts.push('<ul style="margin: 8px 0; padding-left: 20px;">');
        inList = true;
        listType = 'ul';
      }
      htmlParts.push(`<li style="margin: 4px 0;">${inlineMarkdownToHtml(ulMatch[1])}</li>`);
      i++;
      continue;
    }

    // Ordered List (1. item)
    const olMatch = line.match(/^\d+\.\s+(.+)$/);
    if (olMatch) {
      if (!inList || listType !== 'ol') {
        closeListIfOpen();
        htmlParts.push('<ol style="margin: 8px 0; padding-left: 20px;">');
        inList = true;
        listType = 'ol';
      }
      htmlParts.push(`<li style="margin: 4px 0;">${inlineMarkdownToHtml(olMatch[1])}</li>`);
      i++;
      continue;
    }

    // Paragraph
    closeListIfOpen();
    const pStyle = 'margin: 8px 0; line-height: 1.6; color: #1e293b;';
    htmlParts.push(`<p style="${pStyle}">${inlineMarkdownToHtml(line)}</p>`);
    i++;
  }

  closeListIfOpen();

  const containerStyle = 'font-family: -apple-system, BlinkMacSystemFont, \'Segoe UI\', Roboto, Helvetica, Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #1e293b;';
  return `<div style="${containerStyle}">${htmlParts.join('\n')}</div>`;
}

/**
 * High-reliability clipboard writer.
 * Writes both `text/html` and `text/plain` using ClipboardItem where supported,
 * falling back gracefully to writeText and document.execCommand if restricted.
 *
 * @param {string} content - Markdown content of the message
 * @returns {Promise<boolean>} True if copying succeeded
 */
export async function copyFormattedMessage(content) {
  if (!content) return false;

  const { plainText, htmlText } = formatMessageForClipboard(content);

  // Strategy 1: Modern navigator.clipboard.write with ClipboardItem (both text/html and text/plain)
  if (
    typeof window !== 'undefined' &&
    navigator?.clipboard?.write &&
    typeof window.ClipboardItem !== 'undefined'
  ) {
    try {
      const htmlBlob = new Blob([htmlText], { type: 'text/html' });
      const textBlob = new Blob([plainText], { type: 'text/plain' });
      const item = new window.ClipboardItem({
        'text/html': htmlBlob,
        'text/plain': textBlob
      });
      await navigator.clipboard.write([item]);
      return true;
    } catch (writeErr) {
      console.warn('ClipboardItem write rejected, attempting writeText fallback:', writeErr);
      // Fall through to Strategy 2
    }
  }

  // Strategy 2: navigator.clipboard.writeText with optimized plain text
  if (typeof window !== 'undefined' && navigator?.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(plainText);
      return true;
    } catch (textErr) {
      console.warn('navigator.clipboard.writeText rejected, attempting execCommand fallback:', textErr);
      // Fall through to Strategy 3
    }
  }

  // Strategy 3: Hidden textarea fallback via document.execCommand('copy')
  try {
    const textarea = document.createElement('textarea');
    textarea.value = plainText;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '0';
    textarea.setAttribute('readonly', '');
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const success = document.execCommand('copy');
    document.body.removeChild(textarea);
    if (success) {
      return true;
    }
  } catch (fallbackErr) {
    console.warn('execCommand copy fallback failed:', fallbackErr);
  }

  return false;
}
