/**
 * Orvix Browser-Side Document Extraction Service
 * Provides client-side text and metadata extraction for supported documents
 * (TXT, MD, CSV, TSV, JSON, XML, DOCX, text-based PDF, PPTX) without server round-trips.
 *
 * Uses native browser APIs and dynamically imports heavy parsing libraries
 * (unpdf, mammoth, jszip) so the initial application bundle remains lean.
 * Returns the exact DocumentExtractionResult schema expected by documentContextService.js.
 */

// Safety limits matching server-side extraction
const MAX_EXTRACTED_CHARACTERS = 500_000;
const MAX_PREVIEW_LENGTH = 350;

/**
 * Counts words in a string
 * @param {string} text
 * @returns {number}
 */
export function countWords(text) {
  if (!text) return 0;
  const matches = text.trim().match(/\S+/g);
  return matches ? matches.length : 0;
}

/**
 * Generates a clean preview snippet
 * @param {string} text
 * @returns {string}
 */
export function generateSummaryPreview(text) {
  if (!text) return '';
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= MAX_PREVIEW_LENGTH) return clean;
  return clean.slice(0, MAX_PREVIEW_LENGTH).trim() + '...';
}

/**
 * Truncates text safely if it exceeds the maximum character threshold
 * @param {string} text
 * @param {number} [limit=MAX_EXTRACTED_CHARACTERS]
 * @returns {{ text: string, isTruncated: boolean }}
 */
export function truncateSafely(text, limit = MAX_EXTRACTED_CHARACTERS) {
  if (!text || text.length <= limit) {
    return { text: text || '', isTruncated: false };
  }
  return {
    text: text.slice(0, limit) + '\n\n[... Remaining content truncated for performance ...]',
    isTruncated: true
  };
}

/**
 * Decodes standard XML and HTML character entities
 * @param {string} str
 * @returns {string}
 */
export function decodeXmlEntities(str) {
  if (!str || typeof str !== 'string') return '';
  return str.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/gi, (match) => {
    const lower = match.toLowerCase();
    if (lower === '&amp;') return '&';
    if (lower === '&lt;') return '<';
    if (lower === '&gt;') return '>';
    if (lower === '&quot;') return '"';
    if (lower === '&apos;') return "'";
    if (lower.startsWith('&#x')) {
      const code = parseInt(lower.slice(3, -1), 16);
      return !isNaN(code) && code > 0 ? String.fromCodePoint(code) : match;
    }
    if (lower.startsWith('&#')) {
      const code = parseInt(lower.slice(2, -1), 10);
      return !isNaN(code) && code > 0 ? String.fromCodePoint(code) : match;
    }
    return match;
  });
}

/**
 * Parses markdown or text headings into structured sections,
 * properly ignoring code block comments (#) inside backtick fences.
 * @param {string} markdownText
 * @returns {Array<{ heading: string, level: number, content: string, charCount: number }>}
 */
export function extractSectionsFromMarkdown(markdownText) {
  const sections = [];
  const lines = (markdownText || '').split('\n');

  let currentHeading = 'Introduction';
  let currentLevel = 1;
  let currentContentLines = [];
  let inCodeBlock = false;

  const headingRegex = /^(#{1,6})\s+(.*)$/;

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      currentContentLines.push(line);
      continue;
    }

    if (!inCodeBlock) {
      const match = line.match(headingRegex);
      if (match) {
        if (currentContentLines.length > 0 || currentHeading !== 'Introduction') {
          const content = currentContentLines.join('\n').trim();
          sections.push({
            heading: currentHeading,
            level: currentLevel,
            content,
            charCount: content.length
          });
          currentContentLines = [];
        }
        currentLevel = match[1].length;
        currentHeading = match[2].trim();
        continue;
      }
    }
    currentContentLines.push(line);
  }

  if (currentContentLines.length > 0) {
    const content = currentContentLines.join('\n').trim();
    sections.push({
      heading: currentHeading,
      level: currentLevel,
      content,
      charCount: content.length
    });
  }

  return sections.filter((s) => s.content.length > 0 || s.heading !== 'Introduction');
}

/**
 * Robust CSV/TSV parser supporting quotes, escaped quotes (""),
 * and embedded newlines within quoted fields without corrupting row boundaries.
 * @param {string} rawText
 * @param {string} delimiter
 * @returns {Object}
 */
export function parseDelimitedText(rawText, delimiter) {
  if (!rawText || !rawText.trim()) {
    return {
      headers: [],
      rowCount: 0,
      columnCount: 0,
      previewRows: [],
      markdownTable: ''
    };
  }

  const rows = [];
  let currentRow = [];
  let currentCell = '';
  let insideQuotes = false;
  const len = rawText.length;

  for (let i = 0; i < len; i++) {
    const char = rawText[i];

    if (char === '"') {
      if (insideQuotes && i + 1 < len && rawText[i + 1] === '"') {
        currentCell += '"';
        i++; // Skip escaped quote
      } else {
        insideQuotes = !insideQuotes;
      }
    } else if (char === delimiter && !insideQuotes) {
      currentRow.push(currentCell.trim());
      currentCell = '';
    } else if ((char === '\r' || char === '\n') && !insideQuotes) {
      // Row delimiter outside quotes
      currentRow.push(currentCell.trim());
      currentCell = '';
      if (currentRow.some((c) => c.length > 0)) {
        rows.push(currentRow);
      }
      currentRow = [];
      // Handle \r\n
      if (char === '\r' && i + 1 < len && rawText[i + 1] === '\n') {
        i++;
      }
    } else {
      currentCell += char;
    }
  }

  // Flush last pending cell/row
  if (currentCell.length > 0 || currentRow.length > 0) {
    currentRow.push(currentCell.trim());
    if (currentRow.some((c) => c.length > 0)) {
      rows.push(currentRow);
    }
  }

  if (rows.length === 0) {
    return {
      headers: [],
      rowCount: 0,
      columnCount: 0,
      previewRows: [],
      markdownTable: ''
    };
  }

  const headers = rows[0];
  const dataRows = rows.slice(1);
  const maxCols = Math.max(...rows.map((r) => r.length));

  // Build markdown table representation
  const colWidths = new Array(maxCols).fill(3);
  for (const row of rows) {
    for (let c = 0; c < maxCols; c++) {
      const cellClean = (row[c] || '').replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|');
      colWidths[c] = Math.max(colWidths[c], Math.min(cellClean.length, 40));
    }
  }

  const headerRow = '| ' + Array.from({ length: maxCols }, (_, i) => {
    const h = (headers[i] || `Col ${i + 1}`).replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|');
    return h.padEnd(colWidths[i] || 3);
  }).join(' | ') + ' |';

  const dividerRow = '| ' + colWidths.map((w) => '-'.repeat(w)).join(' | ') + ' |';

  const previewData = dataRows.slice(0, 10).map((row) => {
    return '| ' + Array.from({ length: maxCols }, (_, i) => {
      const c = (row[i] || '').replace(/[\r\n]+/g, '<br>').replace(/\|/g, '\\|');
      return c.padEnd(colWidths[i] || 3);
    }).join(' | ') + ' |';
  });

  const markdownTable = [headerRow, dividerRow, ...previewData].join('\n');

  return {
    headers,
    rowCount: dataRows.length,
    columnCount: maxCols,
    previewRows: dataRows.slice(0, 10),
    markdownTable
  };
}

/**
 * Extracts plain text, log, and markdown documents
 */
function extractPlainTextDocument(text, ext) {
  let cleanText = text || '';
  if (cleanText.charCodeAt(0) === 0xfeff) {
    cleanText = cleanText.slice(1);
  }
  cleanText = cleanText.trim();

  if (!cleanText) {
    return {
      status: 'empty',
      success: false,
      text: '',
      warning: ext === '.log' ? 'The log file is empty.' : 'The text file is empty.'
    };
  }

  const isMarkdown = ext === '.md' || ext === '.markdown';
  const sections = isMarkdown ? extractSectionsFromMarkdown(cleanText) : undefined;

  return {
    status: 'ready',
    success: true,
    text: cleanText,
    sections,
    sectionCount: sections ? sections.length : undefined
  };
}

/**
 * Extracts and formats delimited text (CSV / TSV)
 */
function extractDelimitedDocument(text, ext) {
  let cleanText = text || '';
  if (cleanText.charCodeAt(0) === 0xfeff) {
    cleanText = cleanText.slice(1);
  }
  cleanText = cleanText.trim();

  if (!cleanText) {
    return {
      status: 'empty',
      success: false,
      text: '',
      warning: 'The tabular data file is empty.'
    };
  }

  const delimiter = ext === '.tsv' ? '\t' : ',';
  const tableData = parseDelimitedText(cleanText, delimiter);

  return {
    status: 'ready',
    success: true,
    text: tableData.markdownTable || cleanText,
    rowCount: tableData.rowCount,
    columnCount: tableData.columnCount,
    table: tableData
  };
}

/**
 * Extracts and formats JSON documents
 */
function extractJsonDocument(text) {
  let cleanText = text || '';
  if (cleanText.charCodeAt(0) === 0xfeff) {
    cleanText = cleanText.slice(1);
  }
  cleanText = cleanText.trim();

  if (!cleanText) {
    return {
      status: 'empty',
      success: false,
      text: '',
      warning: 'The JSON file is empty.'
    };
  }

  try {
    const parsed = JSON.parse(cleanText);
    const prettyJson = JSON.stringify(parsed, null, 2);

    let summaryStructure = '';
    if (Array.isArray(parsed)) {
      summaryStructure = `JSON Array containing ${parsed.length} items.`;
    } else if (typeof parsed === 'object' && parsed !== null) {
      const keys = Object.keys(parsed);
      summaryStructure = `JSON Object with ${keys.length} top-level fields: ${keys.slice(0, 10).join(', ')}${keys.length > 10 ? '...' : ''}`;
    }

    const fullContent = summaryStructure
      ? `${summaryStructure}\n\n\`\`\`json\n${prettyJson}\n\`\`\``
      : `\`\`\`json\n${prettyJson}\n\`\`\``;

    return {
      status: 'ready',
      success: true,
      text: fullContent
    };
  } catch (err) {
    return {
      status: 'corrupted',
      success: false,
      text: cleanText,
      warning: `JSON syntax error: ${err?.message || 'Invalid JSON format'}. Raw content retained.`
    };
  }
}

/**
 * Extracts XML documents with entity decoding and readable block structure
 */
function extractXmlDocument(text) {
  let cleanText = text || '';
  if (cleanText.charCodeAt(0) === 0xfeff) {
    cleanText = cleanText.slice(1);
  }
  cleanText = cleanText.trim();

  if (!cleanText) {
    return {
      status: 'empty',
      success: false,
      text: '',
      warning: 'The XML file is empty.'
    };
  }

  try {
    const unwrappedCdata = cleanText.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1');

    let structured = unwrappedCdata
      .replace(/<\/(?:p|div|section|article|item|entry|row|record|message|h[1-6]|li|title)>/gi, '\n')
      .replace(/<(?:br|hr)\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ');

    const decoded = decodeXmlEntities(structured);
    const cleanLines = decoded
      .split('\n')
      .map((l) => l.replace(/[ \t]+/g, ' ').trim())
      .filter((l) => l.length > 0);

    const bodyText = cleanLines.join('\n\n');

    if (!bodyText) {
      return {
        status: 'empty',
        success: false,
        text: '',
        warning: 'The XML file contains tags but no readable text content.'
      };
    }

    return {
      status: 'ready',
      success: true,
      text: `\`\`\`xml\n${cleanText.slice(0, 100_000)}\n\`\`\`\n\n### Extracted Text Content\n${bodyText}`
    };
  } catch (err) {
    return {
      status: 'corrupted',
      success: false,
      text: cleanText,
      warning: `XML parsing notice: ${err?.message || 'Non-standard XML'}. Raw content retained.`
    };
  }
}

/**
 * Browser-side PDF extraction using lazy-loaded unpdf
 * Retains page-by-page text and accurately detects scanned or image-only PDFs without text layers.
 * @param {ArrayBuffer} arrayBuffer
 */
async function extractPdfDocument(arrayBuffer) {
  try {
    const { extractText } = await import('unpdf');
    const uint8Array = new Uint8Array(arrayBuffer);
    const res = await extractText(uint8Array, { mergePages: false });

    const rawPages = Array.isArray(res.text) ? res.text : [String(res.text || '')];
    const totalPages = res.totalPages || rawPages.length;

    const pages = [];
    const combinedTextParts = [];
    let nonWhitespaceChars = 0;

    for (let i = 0; i < rawPages.length; i++) {
      const pageText = (rawPages[i] || '').trim();
      pages.push({
        pageNumber: i + 1,
        text: pageText,
        charCount: pageText.length
      });
      nonWhitespaceChars += pageText.replace(/\s+/g, '').length;
      if (pageText) {
        combinedTextParts.push(`--- Page ${i + 1} ---\n${pageText}`);
      }
    }

    const fullAggregatedText = combinedTextParts.join('\n\n');

    // Detect scanned or image-only PDFs (no extractable text layer)
    if (nonWhitespaceChars < 10) {
      return {
        status: 'scanned_or_image_only',
        success: false,
        isScanned: true,
        pageCount: totalPages,
        pages,
        text: '',
        totalCharacters: 0,
        totalWords: 0,
        warning:
          'No readable text could be extracted from this PDF. This document appears to be scanned, image-only, or contains rasterized pages without a text layer. Optical Character Recognition (OCR) is required.'
      };
    }

    return {
      status: 'ready',
      success: true,
      pageCount: totalPages,
      pages,
      text: fullAggregatedText,
      isScanned: false
    };
  } catch (err) {
    const msg = String(err?.message || err || '').toLowerCase();
    if (msg.includes('password') || msg.includes('encrypted') || msg.includes('passwordexception')) {
      return {
        status: 'encrypted',
        success: false,
        text: '',
        error: 'This PDF document is encrypted or password-protected and cannot be read without a password.'
      };
    }
    return {
      status: 'corrupted',
      success: false,
      text: '',
      error: `Failed to parse PDF document: ${err?.message || 'Invalid or corrupted PDF structure.'}`
    };
  }
}

/**
 * Converts Mammoth HTML output into clean, structured Markdown,
 * preserving tables as aligned Markdown tables, headings, lists, blockquotes, and text.
 * @param {string} html
 * @returns {string}
 */
export function convertMammothHtmlToMarkdown(html) {
  if (!html || typeof html !== 'string') return '';

  // 1. Process HTML tables into standard aligned Markdown tables
  let res = html.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (_, tableContent) => {
    const rows = [];
    const trRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    let trMatch;
    while ((trMatch = trRegex.exec(tableContent)) !== null) {
      const rowContent = trMatch[1];
      const cells = [];
      const cellRegex = /<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/gi;
      let cellMatch;
      while ((cellMatch = cellRegex.exec(rowContent)) !== null) {
        const cellText = cellMatch[1]
          .replace(/<br\s*\/?>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .replace(/\|/g, '\\|');
        cells.push(cellText);
      }
      if (cells.length > 0 && cells.some((c) => c.length > 0)) {
        rows.push(cells);
      }
    }

    if (rows.length === 0) return '';

    const maxCols = Math.max(...rows.map((r) => r.length));
    const colWidths = new Array(maxCols).fill(3);
    for (const r of rows) {
      for (let c = 0; c < maxCols; c++) {
        colWidths[c] = Math.max(colWidths[c], Math.min((r[c] || '').length, 40));
      }
    }

    const header = rows[0];
    const dataRows = rows.slice(1);
    const headerLine =
      '| ' +
      Array.from({ length: maxCols }, (_, i) => (header[i] || `Col ${i + 1}`).padEnd(colWidths[i])).join(' | ') +
      ' |';
    const dividerLine = '| ' + colWidths.map((w) => '-'.repeat(w)).join(' | ') + ' |';
    const rowLines = dataRows.map(
      (r) => '| ' + Array.from({ length: maxCols }, (_, i) => (r[i] || '').padEnd(colWidths[i])).join(' | ') + ' |'
    );

    return '\n\n' + [headerLine, dividerLine, ...rowLines].join('\n') + '\n\n';
  });

  // 2. Headings (h1 - h6)
  res = res.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, content) => {
    const text = content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return '\n\n' + '#'.repeat(Number(level)) + ' ' + text + '\n\n';
  });

  // 3. Lists (ul/ol)
  res = res.replace(/<ul\b[^>]*>([\s\S]*?)<\/ul>/gi, (_, content) => {
    const items = [];
    const liRegex = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
    let liMatch;
    while ((liMatch = liRegex.exec(content)) !== null) {
      const text = liMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (text) items.push('- ' + text);
    }
    return '\n\n' + items.join('\n') + '\n\n';
  });

  res = res.replace(/<ol\b[^>]*>([\s\S]*?)<\/ol>/gi, (_, content) => {
    const items = [];
    const liRegex = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
    let liMatch;
    let idx = 1;
    while ((liMatch = liRegex.exec(content)) !== null) {
      const text = liMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (text) items.push(`${idx++}. ` + text);
    }
    return '\n\n' + items.join('\n') + '\n\n';
  });

  // 4. Blockquotes
  res = res.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, content) => {
    const lines = content.replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, '$1\n').replace(/<[^>]+>/g, ' ').trim().split('\n');
    return '\n\n' + lines.map((l) => '> ' + l.trim()).join('\n') + '\n\n';
  });

  // 5. Code & Pre
  res = res.replace(/<pre\b[^>]*><code\b[^>]*>([\s\S]*?)<\/code><\/pre>/gi, '\n\n```\n$1\n```\n\n');
  res = res.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');

  // 6. Inline text styling
  res = res.replace(/<strong\b[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**');
  res = res.replace(/<b\b[^>]*>([\s\S]*?)<\/b>/gi, '**$1**');
  res = res.replace(/<em\b[^>]*>([\s\S]*?)<\/em>/gi, '*$1*');
  res = res.replace(/<i\b[^>]*>([\s\S]*?)<\/i>/gi, '*$1*');

  // 7. Links
  res = res.replace(/<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');

  // 8. Paragraphs & line breaks
  res = res.replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, (_, content) => {
    const clean = content.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim();
    return clean ? '\n\n' + clean + '\n\n' : '';
  });

  // 9. Strip any leftover tags, decode entities, and normalize multiple blank lines
  res = res.replace(/<[^>]+>/g, '');
  res = decodeXmlEntities(res);
  res = res.replace(/\n{3,}/g, '\n\n').trim();
  return res;
}

/**
 * Extracts text boxes from Word document XML (DrawingML wps:txbx / w:txbxContent, VML v:textbox, and a:txBody)
 * Filters out duplicate fallback representations within mc:AlternateContent.
 * @param {string} xml
 * @returns {Array<string>}
 */
export function extractDocxTextBoxes(xml) {
  if (!xml) return [];
  // Strip mc:Fallback when mc:Choice is present to avoid duplicating text
  let cleanXml = xml;
  if (cleanXml.includes('<mc:Choice') && cleanXml.includes('<mc:Fallback')) {
    cleanXml = cleanXml.replace(/<mc:Fallback\b[^>]*>([\s\S]*?)<\/mc:Fallback>/gi, '');
  }

  const boxes = [];
  const txbxRegex =
    /<(?:w:txbxContent|v:textbox|wps:txbx|a:txBody)\b[^>]*>([\s\S]*?)<\/(?:w:txbxContent|v:textbox|wps:txbx|a:txBody)>/gi;
  let match;
  while ((match = txbxRegex.exec(cleanXml)) !== null) {
    const boxXml = match[1];
    const boxParagraphs = [];

    // Extract table rows if a table exists inside the text box
    const tblRegex = /<w:tbl\b[^>]*>([\s\S]*?)<\/w:tbl>/gi;
    let tblMatch;
    while ((tblMatch = tblRegex.exec(boxXml)) !== null) {
      const tableXml = tblMatch[1];
      const trRegex = /<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/gi;
      let trMatch;
      const tableRows = [];
      while ((trMatch = trRegex.exec(tableXml)) !== null) {
        const tcRegex = /<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/gi;
        let tcMatch;
        const cells = [];
        while ((tcMatch = tcRegex.exec(trMatch[1])) !== null) {
          const tRegex = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gi;
          const tokens = [];
          let tMatch;
          while ((tMatch = tRegex.exec(tcMatch[1])) !== null) {
            tokens.push(tMatch[1]);
          }
          cells.push(decodeXmlEntities(tokens.join('')).trim());
        }
        if (cells.length > 0 && cells.some((c) => c.length > 0)) {
          tableRows.push(cells);
        }
      }
      if (tableRows.length > 0) {
        const maxCols = Math.max(...tableRows.map((r) => r.length));
        const colWidths = new Array(maxCols).fill(3);
        for (const r of tableRows) {
          for (let c = 0; c < maxCols; c++) {
            colWidths[c] = Math.max(colWidths[c], Math.min((r[c] || '').length, 40));
          }
        }
        const header = tableRows[0];
        const dataRows = tableRows.slice(1);
        const headerLine =
          '| ' +
          Array.from({ length: maxCols }, (_, i) => (header[i] || `Col ${i + 1}`).padEnd(colWidths[i])).join(' | ') +
          ' |';
        const dividerLine = '| ' + colWidths.map((w) => '-'.repeat(w)).join(' | ') + ' |';
        const rowLines = dataRows.map(
          (r) => '| ' + Array.from({ length: maxCols }, (_, i) => (r[i] || '').padEnd(colWidths[i])).join(' | ') + ' |'
        );
        boxParagraphs.push([headerLine, dividerLine, ...rowLines].join('\n'));
      }
    }

    const pRegex = /<(?:w:p|a:p)\b[^>]*>([\s\S]*?)<\/(?:w:p|a:p)>/gi;
    let pMatch;
    while ((pMatch = pRegex.exec(boxXml)) !== null) {
      let pXml = pMatch[1];
      pXml = pXml.replace(/<(?:w:tab|a:tab)\s*\/?>/gi, ' ');
      pXml = pXml.replace(/<(?:w:br|a:br)\s*\/?>/gi, '\n');
      const tRegex = /<(?:w:t|a:t)\b[^>]*>([\s\S]*?)<\/(?:w:t|a:t)>/gi;
      const textTokens = [];
      let tMatch;
      while ((tMatch = tRegex.exec(pXml)) !== null) {
        textTokens.push(tMatch[1]);
      }
      const pText = decodeXmlEntities(textTokens.join('')).trim();
      if (pText) boxParagraphs.push(pText);
    }
    if (boxParagraphs.length > 0) {
      boxes.push(boxParagraphs.join('\n'));
    }
  }
  return boxes;
}

/**
 * Browser-side DOCX extraction using lazy-loaded mammoth with text box preservation
 * Preserves headings, lists, tables and their cells in readable Markdown, paragraphs, and text boxes (w:txbxContent)
 * @param {ArrayBuffer} arrayBuffer
 */
async function extractDocxDocument(arrayBuffer) {
  try {
    const jszipModule = await import('jszip');
    const JSZip = jszipModule.default || jszipModule;

    // 1. Verify docx package integrity as a valid ZIP archive containing word/document.xml
    let zip;
    try {
      zip = await JSZip.loadAsync(arrayBuffer);
    } catch (zipErr) {
      return {
        status: 'corrupted',
        success: false,
        text: '',
        error: `Failed to parse DOCX document: ${zipErr?.message || 'Invalid or corrupted Word document package.'}`
      };
    }

    if (!zip.files['word/document.xml']) {
      return {
        status: 'corrupted',
        success: false,
        text: '',
        error: 'Failed to parse DOCX document: Missing word/document.xml in archive.'
      };
    }

    const mammothModule = await import('mammoth');
    const mammoth = mammothModule.default || mammothModule;

    let markdown = '';

    const mammothInput = {
      arrayBuffer,
      ...(typeof Buffer !== 'undefined'
        ? { buffer: Buffer.isBuffer(arrayBuffer) ? arrayBuffer : Buffer.from(arrayBuffer) }
        : {})
    };

    // 2. Primary path: convert to HTML first to preserve table structures with cell alignments
    try {
      const htmlResult = await mammoth.convertToHtml(mammothInput);
      const rawHtml = htmlResult?.value || '';
      if (rawHtml.trim()) {
        markdown = convertMammothHtmlToMarkdown(rawHtml);
      }
    } catch (_) {}

    // 3. Secondary fallback: convert to Markdown directly
    if (!markdown) {
      try {
        const res = await mammoth.convertToMarkdown(mammothInput);
        markdown = (res?.value || '').trim();
      } catch (_) {}
    }

    // 4. Tertiary fallback: extract raw text
    if (!markdown) {
      try {
        const raw = await mammoth.extractRawText(mammothInput);
        markdown = (raw?.value || '').trim();
      } catch (_) {}
    }

    // 5. Inspect docx package via existing JSZip instance for DrawingML / VML text boxes that Mammoth does not capture
    let textBoxes = [];
    try {
      const docXmlFiles = Object.keys(zip.files).filter((fname) =>
        /^word\/(?:document|header\d+|footer\d+)\.xml$/.test(fname)
      );
      for (const xmlPath of docXmlFiles) {
        const xml = await zip.files[xmlPath].async('text');
        const extractedBoxes = extractDocxTextBoxes(xml);
        for (const box of extractedBoxes) {
          if (box && !markdown.includes(box) && !textBoxes.some((existing) => existing === box || existing.includes(box))) {
            textBoxes.push(box);
          }
        }
      }
    } catch (_) {}

    let combinedText = markdown;
    if (textBoxes.length > 0) {
      const calloutText = textBoxes.map((b, i) => `### Text Box ${i + 1}\n${b}`).join('\n\n');
      combinedText = combinedText ? `${combinedText}\n\n${calloutText}` : calloutText;
    }

    combinedText = combinedText.trim();
    if (!combinedText) {
      return {
        status: 'empty',
        success: false,
        text: '',
        warning: 'This Word document contains no readable text content.'
      };
    }

    const sections = extractSectionsFromMarkdown(combinedText);

    return {
      status: 'ready',
      success: true,
      text: combinedText,
      sections,
      sectionCount: sections.length
    };
  } catch (err) {
    return {
      status: 'corrupted',
      success: false,
      text: '',
      error: `Failed to parse DOCX document: ${err?.message || 'Invalid or corrupted Word document structure.'}`
    };
  }
}

/**
 * Formats a PPTX DrawingML table (<a:tbl>) into a readable Markdown table
 * Preserves multi-paragraph cells with <br> and escapes pipe characters.
 * @param {string} tblXml
 * @returns {string}
 */
export function extractTableFromPptxXml(tblXml) {
  const rows = [];
  const trRegex = /<a:tr\b[^>]*>([\s\S]*?)<\/a:tr>/gi;
  let trMatch;
  while ((trMatch = trRegex.exec(tblXml)) !== null) {
    const trContent = trMatch[1];
    const tcRegex = /<a:tc\b[^>]*>([\s\S]*?)<\/a:tc>/gi;
    let tcMatch;
    const cells = [];
    while ((tcMatch = tcRegex.exec(trContent)) !== null) {
      const tcContent = tcMatch[1];
      const pRegex = /<a:p\b[^>]*>([\s\S]*?)<\/a:p>/gi;
      let pMatch;
      const cellParagraphs = [];
      while ((pMatch = pRegex.exec(tcContent)) !== null) {
        let pXml = pMatch[1].replace(/<a:br\s*\/?>/gi, '\n').replace(/<a:tab\s*\/?>/gi, ' ');
        const tRegex = /<a:t\b[^>]*>([\s\S]*?)<\/a:t>/gi;
        let tMatch;
        const cellTokens = [];
        while ((tMatch = tRegex.exec(pXml)) !== null) {
          cellTokens.push(tMatch[1]);
        }
        const pText = decodeXmlEntities(cellTokens.join('')).trim();
        if (pText) cellParagraphs.push(pText);
      }
      const cellValue = cellParagraphs.join('<br>').replace(/\|/g, '\\|');
      cells.push(cellValue);
    }
    if (cells.length > 0 && cells.some((c) => c.length > 0)) {
      rows.push(cells);
    }
  }

  if (rows.length === 0) return '';

  const maxCols = Math.max(...rows.map((r) => r.length));
  const colWidths = new Array(maxCols).fill(3);
  for (const r of rows) {
    for (let c = 0; c < maxCols; c++) {
      const val = (r[c] || '').replace(/[\r\n]+/g, ' ');
      colWidths[c] = Math.max(colWidths[c], Math.min(val.length, 40));
    }
  }

  const header = rows[0];
  const dataRows = rows.slice(1);
  const headerLine =
    '| ' +
    Array.from({ length: maxCols }, (_, i) => {
      return ((header[i] || `Col ${i + 1}`).replace(/[\r\n]+/g, ' ')).padEnd(colWidths[i] || 3);
    }).join(' | ') +
    ' |';

  const dividerLine = '| ' + colWidths.map((w) => '-'.repeat(w)).join(' | ') + ' |';

  const rowLines = dataRows.map((r) => {
    return (
      '| ' +
      Array.from({ length: maxCols }, (_, i) => {
        return ((r[i] || '').replace(/[\r\n]+/g, ' ')).padEnd(colWidths[i] || 3);
      }).join(' | ') +
      ' |'
    );
  });

  return [headerLine, dividerLine, ...rowLines].join('\n');
}

/**
 * Browser-side PPTX extraction using lazy-loaded jszip
 * Extracts slide-by-slide text, tables (p:graphicFrame), grouped shapes (p:grpSp), and speaker notes
 * in natural reading order with slide title retention.
 * @param {ArrayBuffer} arrayBuffer
 */
async function extractPptxDocument(arrayBuffer) {
  try {
    const jszipModule = await import('jszip');
    const JSZip = jszipModule.default || jszipModule;
    const zip = await JSZip.loadAsync(arrayBuffer);

    const slideFiles = Object.keys(zip.files).filter((fname) =>
      /^ppt\/slides\/slide\d+\.xml$/.test(fname)
    );

    if (slideFiles.length === 0) {
      return {
        status: 'empty',
        success: false,
        slideCount: 0,
        slides: [],
        text: '',
        warning: 'No presentation slides were found in this PPTX file.'
      };
    }

    // Sort slides numerically: slide1, slide2, slide3...
    slideFiles.sort((a, b) => {
      const numA = parseInt(a.match(/slide(\d+)\.xml/)?.[1] || '0', 10);
      const numB = parseInt(b.match(/slide(\d+)\.xml/)?.[1] || '0', 10);
      return numA - numB;
    });

    const slides = [];
    const aggregatedSlideTexts = [];

    for (let i = 0; i < slideFiles.length; i++) {
      const slidePath = slideFiles[i];
      const slideNum = i + 1;
      const slideXml = await zip.files[slidePath].async('text');

      // 1. Locate slide title if present in a title placeholder shape
      let slideTitle = undefined;
      const titleShapeRegex = /<p:sp\b[^>]*>[\s\S]*?<p:ph\b[^>]*\btype=["'](?:title|ctrTitle)["'][\s\S]*?<\/p:sp>/gi;
      const titleShapeMatch = titleShapeRegex.exec(slideXml);
      if (titleShapeMatch) {
        const titleParas = [];
        const pRegex = /<a:p\b[^>]*>([\s\S]*?)<\/a:p>/gi;
        let pMatch;
        while ((pMatch = pRegex.exec(titleShapeMatch[0])) !== null) {
          let pXml = pMatch[1].replace(/<a:br\s*\/?>/gi, '\n').replace(/<a:tab\s*\/?>/gi, ' ');
          const tRegex = /<a:t\b[^>]*>([\s\S]*?)<\/a:t>/gi;
          const tokens = [];
          let tMatch;
          while ((tMatch = tRegex.exec(pXml)) !== null) {
            tokens.push(tMatch[1]);
          }
          const text = decodeXmlEntities(tokens.join('')).trim();
          if (text) titleParas.push(text);
        }
        if (titleParas.length > 0) {
          slideTitle = titleParas.join(' ');
        }
      }

      // 2. Iterate through slide elements in document order (<p:graphicFrame>, <p:sp>, <p:grpSp>)
      const slideElements = [];
      const elementRegex = /<(p:graphicFrame|p:sp|p:grpSp)\b[^>]*>([\s\S]*?)<\/\1>/gi;
      let elemMatch;
      while ((elemMatch = elementRegex.exec(slideXml)) !== null) {
        const tag = elemMatch[1];
        const content = elemMatch[2];

        // Case A: Table inside <p:graphicFrame> (or directly <a:tbl>)
        if (tag === 'p:graphicFrame') {
          const tblMatch = /<a:tbl\b[^>]*>([\s\S]*?)<\/a:tbl>/i.exec(content);
          if (tblMatch) {
            const mdTable = extractTableFromPptxXml(tblMatch[1]);
            if (mdTable) {
              slideElements.push(mdTable);
            }
          } else {
            const pRegex = /<a:p\b[^>]*>([\s\S]*?)<\/a:p>/gi;
            let pMatch;
            const extraParas = [];
            while ((pMatch = pRegex.exec(content)) !== null) {
              let pXml = pMatch[1].replace(/<a:br\s*\/?>/gi, '\n').replace(/<a:tab\s*\/?>/gi, ' ');
              const tRegex = /<a:t\b[^>]*>([\s\S]*?)<\/a:t>/gi;
              const tokens = [];
              let tMatch;
              while ((tMatch = tRegex.exec(pXml)) !== null) {
                tokens.push(tMatch[1]);
              }
              const pText = decodeXmlEntities(tokens.join('')).trim();
              if (pText) extraParas.push(pText);
            }
            if (extraParas.length > 0) {
              slideElements.push(extraParas.join('\n'));
            }
          }
          continue;
        }

        // Case B: Grouped shapes <p:grpSp>
        if (tag === 'p:grpSp') {
          // Extract tables if any exist inside the group
          const tblRegex = /<a:tbl\b[^>]*>([\s\S]*?)<\/a:tbl>/gi;
          let tblMatch;
          while ((tblMatch = tblRegex.exec(content)) !== null) {
            const mdTable = extractTableFromPptxXml(tblMatch[1]);
            if (mdTable) {
              slideElements.push(mdTable);
            }
          }
          // Extract child shapes inside grouped shape
          const childSpRegex = /<p:sp\b[^>]*>([\s\S]*?)<\/p:sp>/gi;
          let childSpMatch;
          const groupParas = [];
          while ((childSpMatch = childSpRegex.exec(content)) !== null) {
            const pRegex = /<a:p\b[^>]*>([\s\S]*?)<\/a:p>/gi;
            let pMatch;
            while ((pMatch = pRegex.exec(childSpMatch[1])) !== null) {
              let pXml = pMatch[1].replace(/<a:br\s*\/?>/gi, '\n').replace(/<a:tab\s*\/?>/gi, ' ');
              const tRegex = /<a:t\b[^>]*>([\s\S]*?)<\/a:t>/gi;
              const tokens = [];
              let tMatch;
              while ((tMatch = tRegex.exec(pXml)) !== null) {
                tokens.push(tMatch[1]);
              }
              const pText = decodeXmlEntities(tokens.join('')).trim();
              if (pText) groupParas.push(pText);
            }
          }
          if (groupParas.length > 0) {
            slideElements.push(groupParas.join('\n'));
          }
          continue;
        }

        // Case C: Standard shape <p:sp>
        const isTitleShape = /<p:ph\b[^>]*\btype=["'](?:title|ctrTitle)["']/i.test(content);
        const pRegex = /<a:p\b[^>]*>([\s\S]*?)<\/a:p>/gi;
        let pMatch;
        const shapeParas = [];
        while ((pMatch = pRegex.exec(content)) !== null) {
          let pXml = pMatch[1].replace(/<a:br\s*\/?>/gi, '\n').replace(/<a:tab\s*\/?>/gi, ' ');
          const tRegex = /<a:t\b[^>]*>([\s\S]*?)<\/a:t>/gi;
          const tokens = [];
          let tMatch;
          while ((tMatch = tRegex.exec(pXml)) !== null) {
            tokens.push(tMatch[1]);
          }
          const pText = decodeXmlEntities(tokens.join('')).trim();
          if (pText) {
            if (isTitleShape && pText === slideTitle) {
              // Avoid duplicating the exact title line in body elements
            } else {
              shapeParas.push(pText);
            }
          }
        }
        if (shapeParas.length > 0) {
          slideElements.push(shapeParas.join('\n'));
        }
      }

      // 3. Check corresponding speaker notes slide
      let notesText = undefined;
      const notesPath = `ppt/notesSlides/notesSlide${slideNum}.xml`;
      if (zip.files[notesPath]) {
        try {
          const notesXml = await zip.files[notesPath].async('text');
          const noteParagraphs = [];
          const tRegex = /<a:t\b[^>]*>([\s\S]*?)<\/a:t>/gi;
          let tMatch;
          while ((tMatch = tRegex.exec(notesXml)) !== null) {
            const token = decodeXmlEntities(tMatch[1]).trim();
            if (token && !token.startsWith('Slide ') && !/^\d+$/.test(token)) {
              noteParagraphs.push(token);
            }
          }
          if (noteParagraphs.length > 0) {
            notesText = noteParagraphs.join(' ').trim();
          }
        } catch (_) {}
      }

      const slideBody = slideElements.join('\n\n').trim();
      const effectiveText = slideTitle
        ? (slideBody ? `${slideTitle}\n\n${slideBody}` : slideTitle)
        : (slideBody || '');

      slides.push({
        slideNumber: slideNum,
        title: slideTitle,
        text: effectiveText,
        notes: notesText,
        charCount: effectiveText.length
      });

      const titleHeader = slideTitle ? `: ${slideTitle}` : '';
      let slideFormatted = `--- Slide ${slideNum}${titleHeader} ---\n${effectiveText || '[Empty slide]'}`;
      if (notesText) {
        slideFormatted += `\n[Speaker Notes]: ${notesText}`;
      }
      aggregatedSlideTexts.push(slideFormatted);
    }

    const fullText = aggregatedSlideTexts.join('\n\n');
    const totalContentChars = slides.reduce((acc, s) => acc + s.charCount, 0);

    if (totalContentChars === 0) {
      return {
        status: 'empty',
        success: false,
        slideCount: slides.length,
        slides,
        text: fullText,
        warning: 'The presentation was read successfully, but all slides are empty or contain only graphics.'
      };
    }

    return {
      status: 'ready',
      success: true,
      slideCount: slides.length,
      slides,
      text: fullText
    };
  } catch (err) {
    return {
      status: 'corrupted',
      success: false,
      text: '',
      error: `Failed to parse PPTX presentation: ${err?.message || 'Invalid or corrupted PowerPoint package.'}`
    };
  }
}

/**
 * Checks if a given extension or MIME type is supported for browser-side text extraction.
 * @param {string} [extension='']
 * @param {string} [mimeType='']
 * @returns {boolean}
 */
export function isBrowserExtractable(extension = '', mimeType = '') {
  const ext = (extension || '').replace(/^\./, '').toLowerCase();
  const mime = (mimeType || '').toLowerCase();

  const supportedExts = ['txt', 'log', 'md', 'markdown', 'csv', 'tsv', 'json', 'xml', 'docx', 'pdf', 'pptx'];
  if (supportedExts.includes(ext)) return true;

  if (
    mime === 'application/pdf' ||
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
    mime === 'text/plain' ||
    mime === 'text/x-log' ||
    mime === 'text/markdown' ||
    mime === 'text/csv' ||
    mime === 'text/tab-separated-values' ||
    mime === 'application/json' ||
    mime === 'application/xml' ||
    mime === 'text/xml'
  ) {
    return true;
  }

  return false;
}

/**
 * Main Browser-Side Document Extraction Entrypoint.
 * Reads a browser File or Blob, parses its contents client-side, and returns
 * a normalized DocumentExtractionResult structure compatible with documentContextService.js.
 *
 * @param {File|Blob} file - The file or blob to extract
 * @param {Object} [metadata={}] - Optional metadata overrides (name, originalName, id, fileId)
 * @returns {Promise<Object>} DocumentExtractionResult
 */
export async function extractBrowserDocument(file, metadata = {}) {
  const originalName =
    metadata.originalName ||
    metadata.name ||
    file?.name ||
    'document';

  const ext = (
    originalName.includes('.') ? originalName.slice(originalName.lastIndexOf('.')) : ''
  ).toLowerCase();

  const mimeType =
    metadata.mimeType ||
    metadata.type ||
    file?.type ||
    'application/octet-stream';

  const fileId =
    metadata.id ||
    metadata.fileId ||
    `browser-doc-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

  const sizeBytes = file?.size || 0;
  const nowIso = new Date().toISOString();

  const formatName =
    ext === '.pdf'
      ? 'PDF'
      : ext === '.docx'
        ? 'DOCX'
        : ext === '.pptx'
          ? 'PPTX'
          : ext === '.txt'
            ? 'TXT'
            : ext === '.md' || ext === '.markdown'
              ? 'MD'
              : ext === '.csv'
                ? 'CSV'
                : ext === '.tsv'
                  ? 'TSV'
                  : ext === '.json'
                    ? 'JSON'
                    : ext === '.xml'
                      ? 'XML'
                      : ext.replace('.', '').toUpperCase() || 'UNKNOWN';

  // Check for image files (images require server OCR)
  const isImage =
    mimeType.startsWith('image/') ||
    ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.heic', '.heif'].includes(ext);

  if (isImage) {
    return {
      fileId,
      filename: originalName,
      originalName,
      format: formatName || 'IMAGE',
      mimeType,
      sizeBytes,
      status: 'unsupported_offline',
      success: false,
      text: '',
      isImage: true,
      hasText: false,
      totalCharacters: 0,
      totalWords: 0,
      warning:
        'Image text recognition (OCR) is not supported offline. Connect to the internet to process image text, or attach a text document (PDF, DOCX, PPTX, TXT, MD, CSV, JSON, XML).',
      error: 'Image text extraction is not available offline.',
      extractedAt: nowIso
    };
  }

  // Handle empty files
  if (sizeBytes === 0) {
    return {
      fileId,
      filename: originalName,
      originalName,
      format: formatName,
      mimeType,
      sizeBytes: 0,
      status: 'empty',
      success: false,
      text: '',
      totalCharacters: 0,
      totalWords: 0,
      warning: 'File is empty (0 bytes).',
      extractedAt: nowIso
    };
  }

  // Handle legacy binary Office formats
  if (ext === '.ppt') {
    return {
      fileId,
      filename: originalName,
      originalName,
      format: 'PPT',
      mimeType,
      sizeBytes,
      status: 'unsupported_format',
      success: false,
      text: '',
      totalCharacters: 0,
      totalWords: 0,
      warning:
        'Legacy binary PowerPoint (.ppt) format cannot be parsed directly in the browser. Please convert the presentation to modern PowerPoint (.pptx) format and re-attach.',
      extractedAt: nowIso
    };
  }

  if (ext === '.doc') {
    return {
      fileId,
      filename: originalName,
      originalName,
      format: 'DOC',
      mimeType,
      sizeBytes,
      status: 'unsupported_format',
      success: false,
      text: '',
      totalCharacters: 0,
      totalWords: 0,
      warning:
        'Legacy binary Word (.doc) format cannot be parsed directly in the browser. Please save the document as modern Word (.docx) format and re-attach.',
      extractedAt: nowIso
    };
  }

  if (ext === '.xls' || ext === '.xlsx') {
    return {
      fileId,
      filename: originalName,
      originalName,
      format: ext.replace('.', '').toUpperCase(),
      mimeType,
      sizeBytes,
      status: 'unsupported_format',
      success: false,
      text: '',
      totalCharacters: 0,
      totalWords: 0,
      warning:
        'Excel spreadsheets (.xls, .xlsx) are not supported for offline extraction. Please export or save table data as CSV or TSV and re-attach.',
      extractedAt: nowIso
    };
  }

  let partialResult = {};

  try {
    switch (ext) {
      case '.pdf': {
        const arrayBuffer = await file.arrayBuffer();
        partialResult = await extractPdfDocument(arrayBuffer);
        break;
      }

      case '.docx': {
        const arrayBuffer = await file.arrayBuffer();
        partialResult = await extractDocxDocument(arrayBuffer);
        break;
      }

      case '.pptx': {
        const arrayBuffer = await file.arrayBuffer();
        partialResult = await extractPptxDocument(arrayBuffer);
        break;
      }

      case '.txt':
      case '.text':
      case '.log':
      case '.md':
      case '.markdown': {
        const text = await file.text();
        partialResult = extractPlainTextDocument(text, ext);
        break;
      }

      case '.csv':
      case '.tsv': {
        const text = await file.text();
        partialResult = extractDelimitedDocument(text, ext);
        break;
      }

      case '.json': {
        const text = await file.text();
        partialResult = extractJsonDocument(text);
        break;
      }

      case '.xml': {
        const text = await file.text();
        partialResult = extractXmlDocument(text);
        break;
      }

      default: {
        // Fallback: If it's a text-based MIME type, attempt reading as text
        if (mimeType.startsWith('text/')) {
          const text = await file.text();
          partialResult = extractPlainTextDocument(text, '.txt');
        } else {
          partialResult = {
            status: 'unsupported_format',
            success: false,
            text: '',
            error: `Browser-side extraction is not supported for extension '${ext}'. Supported formats: PDF, DOCX, PPTX, TXT, MD, CSV, TSV, JSON, XML.`
          };
        }
        break;
      }
    }
  } catch (err) {
    partialResult = {
      status: 'error',
      success: false,
      text: '',
      error: `Browser document extraction error: ${err?.message || 'Failed to parse file.'}`
    };
  }

  const rawText = partialResult.text || '';
  const { text: safeText, isTruncated } = truncateSafely(rawText, MAX_EXTRACTED_CHARACTERS);

  const totalCharacters = safeText.length;
  const totalWords = countWords(safeText);
  const summaryText = generateSummaryPreview(safeText);

  return {
    fileId,
    filename: originalName,
    originalName,
    format: formatName,
    mimeType,
    sizeBytes,
    status: partialResult.status || (partialResult.success ? 'ready' : 'error'),
    success: Boolean(partialResult.success),
    text: safeText,
    summaryText,
    totalCharacters,
    totalWords,
    pageCount: partialResult.pageCount,
    pages: partialResult.pages,
    slideCount: partialResult.slideCount,
    slides: partialResult.slides,
    sectionCount: partialResult.sectionCount,
    sections: partialResult.sections,
    rowCount: partialResult.rowCount,
    columnCount: partialResult.columnCount,
    table: partialResult.table,
    isScanned: Boolean(partialResult.isScanned),
    isTruncated: Boolean(isTruncated || partialResult.isTruncated),
    warning: partialResult.warning,
    error: partialResult.error,
    extractedAt: nowIso
  };
}
