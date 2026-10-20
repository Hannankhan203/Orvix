/**
 * Orvix Table Alignment & Copy Utility
 * Provides column-aligned plain-text table formatting for clipboard copying.
 * Preserves rows, columns, headers, and cell contents with consistent spacing,
 * behaving like an invisible fixed-width grid across plain text and rich editors.
 */

// Consistent horizontal gap between columns (3 spaces)
export const COLUMN_GAP = '   ';

/**
 * Cleans formatting artifacts, markdown delimiters, and HTML tags from cell text,
 * flattening multiline content to a single clean string.
 *
 * @param {string|any} text - Raw cell content
 * @returns {string} Clean single-line cell text
 */
export function cleanCellTextForPlainText(text) {
  if (text === undefined || text === null) return '';
  let str = String(text);

  // 1. Flatten <br> or <br/> or <br /> to a single space
  str = str.replace(/<br\s*\/?>/gi, ' ');

  // 2. Replace non-breaking spaces, zero-width spaces, and tabs
  str = str.replace(/&nbsp;/gi, ' ').replace(/[\u00A0\u200B\uFEFF]/g, ' ').replace(/\t/g, ' ');

  // 3. Strip HTML tags like <span>, <strong>, <em>, <code>, <small>, <b>, <i>, etc.
  // Use HTML tag name start so mathematical comparisons (e.g. `< 0.2`) are strictly preserved
  str = str.replace(/<[a-zA-Z\/][^>]*>/g, '');

  // 4. Strip markdown images: ![alt](url) -> alt
  str = str.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');

  // 5. Strip markdown links: [text](url) -> text
  str = str.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  // 6. Strip bold and italics:
  // ***bold italic*** or ___bold italic___
  str = str.replace(/(\*{3}|_{3})(.*?)\1/g, '$2');
  // **bold** or __bold__
  str = str.replace(/(\*{2}|_{2})(.*?)\1/g, '$2');
  // *italic* or _italic_
  str = str.replace(/(\*|_)(.*?)\1/g, '$2');

  // 7. Strip strikethrough: ~~strikethrough~~
  str = str.replace(/~~(.*?)~~/g, '$1');

  // 8. Strip inline code backticks: `code` -> code
  str = str.replace(/`([^`]+)`/g, '$1');

  // 9. Restore escaped characters: \| -> |, \* -> *, \_ -> _, \\ -> \
  str = str
    .replace(/\\\|/g, '|')
    .replace(/\\\*/g, '*')
    .replace(/\\_/g, '_')
    .replace(/\\\\/g, '\\');

  // 10. Flatten newlines and control whitespace to spaces
  str = str.replace(/[\r\n]+/g, ' ');

  // 11. Collapse multiple consecutive spaces to a single space and trim
  return str.replace(/\s+/g, ' ').trim();
}

/**
 * Splits a markdown table row line into trimmed cell contents,
 * properly respecting escaped pipes (\|).
 *
 * @param {string} rowLine - Single line of markdown table
 * @returns {Array<string>} Array of cell strings
 */
export function splitMarkdownRow(rowLine) {
  if (!rowLine || typeof rowLine !== 'string') return [];
  let trimmed = rowLine.trim();
  if (!trimmed) return [];

  // Strip leading pipe delimiter if present
  if (trimmed.startsWith('|')) {
    trimmed = trimmed.slice(1);
  }

  // Strip trailing pipe delimiter if present and not escaped
  if (trimmed.endsWith('|') && !trimmed.endsWith('\\|')) {
    trimmed = trimmed.slice(0, -1);
  }

  const cells = [];
  let current = '';
  let isEscaped = false;

  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];
    if (isEscaped) {
      current += char;
      isEscaped = false;
    } else if (char === '\\') {
      isEscaped = true;
      current += char;
    } else if (char === '|') {
      cells.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current.trim());

  return cells;
}

/**
 * Checks if a line matches markdown table separator row syntax (e.g. |---|:---:|---:|).
 *
 * @param {string} line - Line to test
 * @returns {boolean}
 */
export function isTableSeparatorLine(line) {
  if (!line || typeof line !== 'string') return false;
  const trimmed = line.trim();
  if (!trimmed || !trimmed.includes('-')) return false;

  let inner = trimmed;
  if (inner.startsWith('|')) inner = inner.slice(1);
  if (inner.endsWith('|') && !inner.endsWith('\\|')) inner = inner.slice(0, -1);
  inner = inner.trim();
  if (!inner) return false;

  const parts = inner.split('|');
  return parts.length >= 1 && parts.every((p) => /^\s*:?-+:?\s*$/.test(p));
}

/**
 * Formats a 2D matrix of cell strings into a fixed-width aligned plain-text table.
 *
 * Requirements enforced:
 * 1. Calculate column widths FIRST across the entire table (headers + all data cells).
 * 2. NEVER calculate width per row. Every row must use identical column boundaries.
 * 3. Never allow a shorter cell to reduce the width of its column.
 * 4. Pad every shorter cell in column i with `padEnd(columnWidths[i], ' ')` + column gap.
 *
 * @param {Array<Array<string>>} matrix - Rows of cell strings
 * @returns {string} Aligned plain-text table
 */
export function formatMatrixToAlignedTable(matrix) {
  if (!Array.isArray(matrix) || matrix.length === 0) return '';

  // 1. Filter out empty or non-array rows
  const validRows = matrix.filter((row) => Array.isArray(row) && row.length > 0);
  if (validRows.length === 0) return '';

  // 2. Determine the maximum number of columns across all rows in the table
  let numCols = 0;
  for (const row of validRows) {
    if (row.length > numCols) {
      numCols = row.length;
    }
  }

  if (numCols === 0) return '';

  // 3. Clean and normalize all cell values in every row into single-line strings
  const normalizedRows = validRows.map((row) => {
    const cleanRow = [];
    for (let c = 0; c < numCols; c++) {
      const cellVal = row[c] !== undefined && row[c] !== null ? row[c] : '';
      cleanRow.push(cleanCellTextForPlainText(cellVal));
    }
    return cleanRow;
  });

  // 4. STEP 1: Calculate column widths FIRST for the ENTIRE table.
  // Store these widths in an array: columnWidths = [widthOfColumn1, widthOfColumn2, ...].
  // The widths are calculated ONCE for the entire table by inspecting the header and every data cell.
  const columnWidths = new Array(numCols).fill(0);
  for (let c = 0; c < numCols; c++) {
    let maxWidth = 0;
    for (const row of normalizedRows) {
      const cellText = row[c] || '';
      if (cellText.length > maxWidth) {
        maxWidth = cellText.length;
      }
    }
    // Minimum width 1 to prevent empty columns from collapsing
    columnWidths[c] = Math.max(maxWidth, 1);
  }

  // 5. STEP 2 & 3: Format every row using the exact same columnWidths array.
  // Pad every cell in column i except the last column using padEnd(columnWidths[i], ' ') + separator.
  const separator = COLUMN_GAP;

  const outputLines = normalizedRows.map((row) => {
    let rowText = '';
    for (let c = 0; c < numCols; c++) {
      const cellText = row[c] || '';
      if (c < numCols - 1) {
        rowText += cellText.padEnd(columnWidths[c], ' ') + separator;
      } else {
        // Last column: append trimmed value without trailing spaces
        rowText += cellText.trimEnd();
      }
    }
    return rowText;
  });

  return outputLines.join('\n');
}

/**
 * Extracts rows from an HTML table element and converts them to an aligned plain-text table.
 *
 * @param {HTMLTableElement} tableEl - Table DOM element
 * @returns {string} Aligned plain-text table
 */
export function tableElementToAlignedPlainText(tableEl) {
  if (!tableEl) return '';
  const rows = [];

  const trElements = tableEl.querySelectorAll('tr');
  trElements.forEach((tr) => {
    const cells = Array.from(tr.querySelectorAll('th, td')).map((cell) => {
      const text = cell.textContent !== undefined ? cell.textContent : (cell.innerText || '');
      return text ? text.trim() : '';
    });
    if (cells.length > 0 && !cells.every((c) => !c)) {
      rows.push(cells);
    }
  });

  return formatMatrixToAlignedTable(rows);
}

/**
 * Parses a contiguous block of markdown table lines into cell rows,
 * stripping separator rows, and returns the aligned plain-text table.
 *
 * @param {Array<string>} tableLines - Lines forming the markdown table
 * @returns {string} Aligned plain-text table
 */
export function formatMarkdownTableLines(tableLines) {
  if (!Array.isArray(tableLines) || tableLines.length === 0) return '';

  const matrix = [];

  for (const line of tableLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Skip delimiter line (e.g. |---|---:|---|)
    if (isTableSeparatorLine(trimmed)) continue;

    const cells = splitMarkdownRow(trimmed);
    if (cells.length > 0 && !cells.every((c) => !c)) {
      matrix.push(cells);
    }
  }

  return formatMatrixToAlignedTable(matrix);
}

/**
 * Replaces all Markdown tables in a response text with aligned plain-text tables,
 * preserving all non-table text and code blocks completely intact.
 *
 * @param {string} markdown - Complete response markdown
 * @returns {string} Text with all tables replaced with aligned plain-text tables
 */
export function formatMarkdownTablesInText(markdown) {
  if (!markdown || typeof markdown !== 'string') return '';

  // 1. Protect fenced code blocks (``` or ~~~) so code pipes are not mistaken for tables
  const codeBlocks = [];
  let text = markdown.replace(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g, (match) => {
    const placeholder = `§§CB_TABLE_ESCAPE_${codeBlocks.length}§§`;
    codeBlocks.push(match);
    return placeholder;
  });

  const lines = text.split('\n');
  const resultLines = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Check if this line and the next line form a valid markdown table header + separator
    const hasPipe = trimmed.includes('|');
    const isHeading = /^#{1,6}\s/.test(trimmed);

    if (
      hasPipe &&
      !isHeading &&
      i + 1 < lines.length &&
      isTableSeparatorLine(lines[i + 1])
    ) {
      const tableLines = [line, lines[i + 1]];
      i += 2;

      // Collect all following body rows belonging to this table
      while (i < lines.length) {
        const bodyLine = lines[i];
        const bodyTrimmed = bodyLine.trim();
        if (!bodyTrimmed || !bodyTrimmed.includes('|')) {
          break;
        }
        tableLines.push(bodyLine);
        i++;
      }

      const alignedTable = formatMarkdownTableLines(tableLines);
      if (alignedTable) {
        resultLines.push(alignedTable);
      }
    } else {
      resultLines.push(line);
      i++;
    }
  }

  text = resultLines.join('\n');

  // Restore protected code blocks
  text = text.replace(/§§CB_TABLE_ESCAPE_(\d+)§§/g, (_, idx) => {
    return codeBlocks[Number(idx)] || '';
  });

  return text;
}

/**
 * HTML entities escaper for preformatted HTML clipboard item
 */
export function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Copies plain text to the system clipboard with rock-solid compatibility
 * across modern browser clipboard APIs and iframe-restricted environments.
 *
 * @param {string} plainText - Plain text content
 * @param {string|null} [htmlText=null] - Optional HTML representation
 * @returns {Promise<boolean>} Whether copy succeeded
 */
export async function copyTextWithHtml(plainText, htmlText = null) {
  if (!plainText) return false;

  // 1. If explicit htmlText is provided, attempt rich ClipboardItem copy
  if (htmlText) {
    try {
      if (
        typeof navigator !== 'undefined' &&
        navigator?.clipboard &&
        typeof navigator.clipboard.write === 'function' &&
        typeof ClipboardItem !== 'undefined'
      ) {
        const items = {
          'text/plain': new Blob([plainText], { type: 'text/plain' }),
          'text/html': new Blob([htmlText], { type: 'text/html' })
        };
        await navigator.clipboard.write([new ClipboardItem(items)]);
        return true;
      }
    } catch (_) {
      // Continue to plain text copy
    }
  }

  // 2. Primary: navigator.clipboard.writeText (guarantees exact plain-text spacing without HTML pollution)
  try {
    if (typeof navigator !== 'undefined' && navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(plainText);
      return true;
    }
  } catch (_) {
    // Continue to next fallback
  }

  // 3. Fallback: document.execCommand('copy') via temporary textarea for iframes
  try {
    if (typeof document !== 'undefined') {
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
      return success;
    }
  } catch (_) {
    // Final error ignored
  }

  return false;
}
