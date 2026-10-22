/**
 * Conversation Export Utility
 * Handles browser-side generation and downloading of current conversations
 * in Markdown (.md) and Plain Text (.txt) formats.
 *
 * Rules:
 * - Only exports the currently active conversation.
 * - Exports messages in strict chronological order.
 * - Strips sensitive metadata (API keys, hidden prompts, credentials).
 * - Sanitizes filenames to be safe across all operating systems.
 * - Purely client-side via Blob and URL.createObjectURL; never uploads data externally.
 */

import { formatResponseTime } from './formatResponseTime.js';

/**
 * Sanitizes a conversation title into a safe, cross-platform filename.
 * Strips invalid filesystem characters: \ / : * ? " < > | and ASCII control characters.
 * Also handles Windows reserved device names and path length boundaries.
 *
 * @param {string} title - The conversation title
 * @param {string} [fallback='orvix-conversation'] - Default name if title is empty or invalid
 * @returns {string} Clean, safe filename string without extension
 */
export function sanitizeFilename(title, fallback = 'orvix-conversation') {
  if (!title || typeof title !== 'string') {
    return fallback;
  }

  // Remove illegal characters: / \ ? * : | " < > and ASCII control characters (0-31)
  let clean = title
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
    // Replace multiple spaces or tabs with single space
    .replace(/\s+/g, ' ')
    .trim();

  // Strip trailing periods and spaces (invalid on Windows and common file systems)
  clean = clean.replace(/[. ]+$/, '');

  // Guard against Windows reserved device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(clean)) {
    clean = `${clean}-conversation`;
  }

  // Truncate to 60 characters to avoid path length limits
  if (clean.length > 60) {
    clean = clean.substring(0, 60).trim().replace(/[. ]+$/, '');
  }

  return clean || fallback;
}

/**
 * Converts Markdown content into human-readable plain text without HTML or UI artifacts.
 * Preserves code block indentation and content with clear visual framing, while stripping
 * formatting asterisks and raw tags.
 *
 * @param {string} markdown - The markdown content
 * @returns {string} Readable plain text
 */
export function markdownToPlainText(markdown) {
  if (!markdown || typeof markdown !== 'string') return '';

  let text = markdown;

  // 1. Normalize line endings
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // 2. Protect fenced code blocks cleanly with distinct tokens (no underscores)
  const codeBlocks = [];
  text = text.replace(/```([a-zA-Z0-9_ -]*)\r?\n([\s\S]*?)```/g, (_, lang, code) => {
    const placeholder = `§§CB${codeBlocks.length}§§`;
    codeBlocks.push({ lang: (lang || '').trim(), code: (code || '').trim() });
    return placeholder;
  });

  // 3. Protect inline code (no underscores)
  const inlineCodes = [];
  text = text.replace(/`([^`\n]+)`/g, (_, code) => {
    const placeholder = `§§IC${inlineCodes.length}§§`;
    inlineCodes.push(code);
    return placeholder;
  });

  // 4. Convert markdown links: [Label](URL) -> Label (URL), or just URL if label is identical
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
    if (label.trim() === url.trim()) return url.trim();
    return `${label.trim()} (${url.trim()})`;
  });

  // 5. Remove images: ![alt](url) -> [Image: alt] or empty if no alt
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt) => (alt ? `[Image: ${alt.trim()}]` : ''));

  // 6. Strip raw HTML tags
  text = text.replace(/<[^>]+>/g, '');

  // 7. Strip heading markers: # Title -> Title
  text = text.replace(/^#{1,6}\s+(.+)$/gm, '$1');

  // 8. Strip blockquotes markers: > quote -> quote
  text = text.replace(/^>\s*(.+)$/gm, '$1');

  // 9. Clean table formatting: remove |---|---| divider rows
  text = text.replace(/^\|?\s*[-:]+[-| :]*\s*\|?$/gm, '');

  // 10. Strip bold, italics, strikethrough formatting
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
  text = text.replace(/__([^_]+)__/g, '$1');
  text = text.replace(/\*([^*]+)\*/g, '$1');
  text = text.replace(/_([^_]+)_/g, '$1');
  text = text.replace(/~~([^~]+)~~/g, '$1');

  // 11. Restore inline code cleanly without backticks
  text = text.replace(/§§IC(\d+)§§/g, (_, idx) => inlineCodes[Number(idx)] || '');

  // 12. Restore code blocks with clear framing
  text = text.replace(/§§CB(\d+)§§/g, (_, idx) => {
    const item = codeBlocks[Number(idx)];
    if (!item) return '';
    const header = item.lang ? `--- Code (${item.lang}) ---` : '--- Code ---';
    return `\n${header}\n${item.code}\n-------------------\n`;
  });

  // 13. Fix excessive blank lines
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}

/**
 * Formats a conversation into a Markdown (.md) document.
 *
 * @param {string} title - Conversation title
 * @param {Array<Object>} messages - Array of message objects in chronological order
 * @param {Object} [options]
 * @param {string} [options.exportedAt] - Formatted timestamp
 * @param {string} [options.username] - Optional active username
 * @returns {string} Formatted markdown text
 */
export function formatConversationMarkdown(title, messages = [], options = {}) {
  const exportDate = options.exportedAt || new Date().toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  });

  const displayTitle = (title || 'Conversation').trim();
  const userName = (options.username || '').trim();

  const lines = [
    `# ${displayTitle}`,
    '',
    `_Exported from Orvix on ${exportDate}_`,
    '',
    '---'
  ];

  const validMessages = messages.filter(
    (m) => !m.isError && typeof m.content === 'string' && m.content.trim().length > 0
  );

  validMessages.forEach((msg) => {
    const isUser = msg.sender === 'user';
    const roleName = isUser
      ? (userName ? `User (${userName})` : 'User')
      : 'Orvix (Assistant)';

    const metaParts = [];
    if (msg.timestamp) {
      metaParts.push(msg.timestamp);
    }
    if (!isUser && msg.modelUsed) {
      metaParts.push(msg.modelUsed);
    }
    if (!isUser && typeof msg.responseTimeMs === 'number' && msg.responseTimeMs > 0) {
      const formatted = formatResponseTime(msg.responseTimeMs);
      if (formatted) {
        metaParts.push(`Response time: ${formatted}`);
      }
    }

    const metaLine = metaParts.length > 0 ? `_${metaParts.join(' • ')}_` : '';

    lines.push('');
    lines.push(`### ${roleName}`);
    if (metaLine) {
      lines.push(metaLine);
    }
    lines.push('');
    lines.push(msg.content.trim());
    lines.push('');
    lines.push('---');
  });

  return lines.join('\n');
}

/**
 * Formats a conversation into a Plain Text (.txt) document.
 *
 * @param {string} title - Conversation title
 * @param {Array<Object>} messages - Array of message objects in chronological order
 * @param {Object} [options]
 * @param {string} [options.exportedAt] - Formatted timestamp
 * @param {string} [options.username] - Optional active username
 * @returns {string} Formatted plain text
 */
export function formatConversationPlainText(title, messages = [], options = {}) {
  const exportDate = options.exportedAt || new Date().toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  });

  const displayTitle = (title || 'Conversation').trim();
  const userName = (options.username || '').trim();
  const divider = '='.repeat(64);
  const messageDivider = '-'.repeat(64);

  const lines = [
    divider,
    `CONVERSATION: ${displayTitle}`,
    `Exported from Orvix on: ${exportDate}`,
    divider,
    ''
  ];

  const validMessages = messages.filter(
    (m) => !m.isError && typeof m.content === 'string' && m.content.trim().length > 0
  );

  validMessages.forEach((msg, idx) => {
    const isUser = msg.sender === 'user';
    const roleName = isUser
      ? (userName ? `USER (${userName.toUpperCase()})` : 'USER')
      : 'ORVIX (ASSISTANT)';

    const metaParts = [];
    if (msg.timestamp) {
      metaParts.push(msg.timestamp);
    }
    if (!isUser && msg.modelUsed) {
      metaParts.push(`Model: ${msg.modelUsed}`);
    }
    if (!isUser && typeof msg.responseTimeMs === 'number' && msg.responseTimeMs > 0) {
      const formatted = formatResponseTime(msg.responseTimeMs);
      if (formatted) {
        metaParts.push(`Response time: ${formatted}`);
      }
    }

    const header = metaParts.length > 0
      ? `[${roleName}] - ${metaParts.join(' | ')}`
      : `[${roleName}]`;

    lines.push(header);
    lines.push(messageDivider);
    lines.push(markdownToPlainText(msg.content));
    lines.push('');

    if (idx < validMessages.length - 1) {
      lines.push('');
    }
  });

  return lines.join('\n');
}

/**
 * Initiates browser-side download of a text blob without uploading to any server.
 *
 * @param {string} content - Text file content
 * @param {string} filename - Filename with extension
 * @param {string} mimeType - MIME type (e.g. 'text/markdown' or 'text/plain')
 */
export function downloadClientFile(content, filename, mimeType) {
  if (typeof window === 'undefined' || !window.Blob) {
    throw new Error('File download is not supported in this environment.');
  }

  const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = url;
  link.setAttribute('download', filename);
  link.style.display = 'none';

  document.body.appendChild(link);
  link.click();

  // Cleanup object URL after download trigger
  setTimeout(() => {
    try {
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (_) {}
  }, 1000);
}

/**
 * Exports the active conversation as a Markdown (.md) file.
 *
 * @param {Object} params
 * @param {string} params.title - Conversation title
 * @param {Array<Object>} params.messages - Conversation messages
 * @param {string} [params.username] - Optional username
 * @returns {{ success: boolean, filename?: string, messageCount?: number, error?: string }}
 */
export function exportAsMarkdown({ title, messages = [], username = null }) {
  const validMessages = (messages || []).filter(
    (m) => !m.isError && typeof m.content === 'string' && m.content.trim().length > 0
  );

  if (validMessages.length === 0) {
    return {
      success: false,
      error: 'This conversation has no messages to export.'
    };
  }

  try {
    const safeTitle = sanitizeFilename(title);
    const filename = `${safeTitle}.md`;
    const markdownContent = formatConversationMarkdown(title, validMessages, { username });

    downloadClientFile(markdownContent, filename, 'text/markdown');

    return {
      success: true,
      filename,
      messageCount: validMessages.length
    };
  } catch (err) {
    console.error('Failed to export conversation as Markdown:', err);
    return {
      success: false,
      error: err?.message || 'Failed to generate Markdown file for download.'
    };
  }
}

/**
 * Exports the active conversation as a Plain Text (.txt) file.
 *
 * @param {Object} params
 * @param {string} params.title - Conversation title
 * @param {Array<Object>} params.messages - Conversation messages
 * @param {string} [params.username] - Optional username
 * @returns {{ success: boolean, filename?: string, messageCount?: number, error?: string }}
 */
export function exportAsPlainText({ title, messages = [], username = null }) {
  const validMessages = (messages || []).filter(
    (m) => !m.isError && typeof m.content === 'string' && m.content.trim().length > 0
  );

  if (validMessages.length === 0) {
    return {
      success: false,
      error: 'This conversation has no messages to export.'
    };
  }

  try {
    const safeTitle = sanitizeFilename(title);
    const filename = `${safeTitle}.txt`;
    const textContent = formatConversationPlainText(title, validMessages, { username });

    downloadClientFile(textContent, filename, 'text/plain');

    return {
      success: true,
      filename,
      messageCount: validMessages.length
    };
  } catch (err) {
    console.error('Failed to export conversation as Plain Text:', err);
    return {
      success: false,
      error: err?.message || 'Failed to generate Plain Text file for download.'
    };
  }
}
