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
 * Parses markdown or text headings into structured sections
 * @param {string} markdownText
 * @returns {Array<{ heading: string, level: number, content: string, charCount: number }>}
 */
export function extractSectionsFromMarkdown(markdownText) {
  const sections = [];
  const lines = (markdownText || '').split('\n');

  let currentHeading = 'Introduction';
  let currentLevel = 1;
  let currentContentLines = [];

  const headingRegex = /^(#{1,6})\s+(.*)$/;

  for (const line of lines) {
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
    } else {
      currentContentLines.push(line);
    }
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
 * Robust CSV/TSV parser supporting quotes and commas/tabs within quotes
 * @param {string} rawText
 * @param {string} delimiter
 * @returns {Object}
 */
export function parseDelimitedText(rawText, delimiter) {
  const rows = [];
  const lines = (rawText || '').split(/\r?\n/);

  for (const line of lines) {
    if (!line.trim()) continue;
    const cells = [];
    let insideQuotes = false;
    let currentCell = '';

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (insideQuotes && line[i + 1] === '"') {
          currentCell += '"';
          i++;
        } else {
          insideQuotes = !insideQuotes;
        }
      } else if (char === delimiter && !insideQuotes) {
        cells.push(currentCell.trim());
        currentCell = '';
      } else {
        currentCell += char;
      }
    }
    cells.push(currentCell.trim());
    rows.push(cells);
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

  const colWidths = new Array(maxCols).fill(3);
  for (const row of rows) {
    for (let c = 0; c < row.length; c++) {
      colWidths[c] = Math.max(colWidths[c], Math.min((row[c] || '').length, 40));
    }
  }

  const headerRow = '| ' + headers.map((h, i) => (h || `Col ${i + 1}`).padEnd(colWidths[i] || 3)).join(' | ') + ' |';
  const dividerRow = '| ' + colWidths.map((w) => '-'.repeat(w)).join(' | ') + ' |';
  const previewData = dataRows.slice(0, 10).map((row) => {
    return '| ' + row.map((cell, i) => (cell || '').padEnd(colWidths[i] || 3)).join(' | ') + ' |';
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
 * Extracts plain text and markdown documents
 */
function extractPlainTextDocument(text, ext) {
  const isMarkdown = ext === '.md' || ext === '.markdown';
  const sections = isMarkdown ? extractSectionsFromMarkdown(text) : undefined;

  return {
    status: 'ready',
    success: true,
    text,
    sections,
    sectionCount: sections ? sections.length : undefined
  };
}

/**
 * Extracts and formats delimited text (CSV / TSV)
 */
function extractDelimitedDocument(text, ext) {
  const delimiter = ext === '.tsv' ? '\t' : ',';
  const tableData = parseDelimitedText(text, delimiter);

  return {
    status: 'ready',
    success: true,
    text: tableData.markdownTable || text,
    table: tableData
  };
}

/**
 * Extracts and formats JSON documents
 */
function extractJsonDocument(text) {
  try {
    const parsed = JSON.parse(text);
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
      text: text,
      warning: `JSON syntax error: ${err?.message || 'Invalid JSON format'}. Raw content retained.`
    };
  }
}

/**
 * Extracts XML documents
 */
function extractXmlDocument(text) {
  try {
    let cleanText = text;
    if (typeof DOMParser !== 'undefined') {
      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(text, 'text/xml');
      const parseError = xmlDoc.getElementsByTagName('parsererror');
      if (parseError.length > 0) {
        return {
          status: 'corrupted',
          success: false,
          text,
          warning: 'XML contains malformed syntax. Raw content retained.'
        };
      }
      cleanText = xmlDoc.documentElement ? xmlDoc.documentElement.textContent || text : text;
    }

    return {
      status: 'ready',
      success: true,
      text: cleanText.trim() ? cleanText.trim() : text
    };
  } catch (err) {
    return {
      status: 'corrupted',
      success: false,
      text,
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
 * Browser-side DOCX extraction using lazy-loaded mammoth
 * Preserves headings, lists, tables, and paragraphs.
 * @param {ArrayBuffer} arrayBuffer
 */
async function extractDocxDocument(arrayBuffer) {
  try {
    const mammothModule = await import('mammoth');
    const mammoth = mammothModule.default || mammothModule;

    let markdown = '';
    try {
      const res = await mammoth.convertToMarkdown({ arrayBuffer });
      markdown = (res?.value || '').trim();
    } catch (_) {
      // Fallback to extractRawText if convertToMarkdown throws
    }

    if (!markdown) {
      const raw = await mammoth.extractRawText({ arrayBuffer });
      const rawText = (raw?.value || '').trim();
      if (!rawText) {
        return {
          status: 'empty',
          success: false,
          text: '',
          warning: 'This Word document contains no readable text content.'
        };
      }
      return {
        status: 'ready',
        success: true,
        text: rawText,
        sections: [{ heading: 'Content', level: 1, content: rawText, charCount: rawText.length }],
        sectionCount: 1
      };
    }

    const sections = extractSectionsFromMarkdown(markdown);

    return {
      status: 'ready',
      success: true,
      text: markdown,
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
 * Browser-side PPTX extraction using lazy-loaded jszip
 * Extracts slide-by-slide text and speaker notes in natural numerical order.
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

      let slideTitle = undefined;
      const paragraphs = [];

      // Detect slide title shape first
      const spRegex = /<p:sp\b[^>]*>([\s\S]*?)<\/p:sp>/gi;
      let spMatch;
      while ((spMatch = spRegex.exec(slideXml)) !== null) {
        const spXml = spMatch[1];
        const isTitleShape = /<p:ph\b[^>]*\btype=["'](?:title|ctrTitle)["']/i.test(spXml);
        if (isTitleShape && !slideTitle) {
          const tRegex = /<a:t\b[^>]*>([\s\S]*?)<\/a:t>/gi;
          const titleTokens = [];
          let tMatch;
          while ((tMatch = tRegex.exec(spXml)) !== null) {
            titleTokens.push(tMatch[1]);
          }
          const candidateTitle = titleTokens.join('').trim();
          if (candidateTitle) {
            slideTitle = candidateTitle;
          }
        }
      }

      // Extract all paragraphs across standard shapes, tables, group shapes, and text frames
      const pRegex = /<a:p\b[^>]*>([\s\S]*?)<\/a:p>/gi;
      let pMatch;
      while ((pMatch = pRegex.exec(slideXml)) !== null) {
        const pXml = pMatch[1];
        const tRegex = /<a:t\b[^>]*>([\s\S]*?)<\/a:t>/gi;
        const textTokens = [];
        let tMatch;
        while ((tMatch = tRegex.exec(pXml)) !== null) {
          textTokens.push(tMatch[1]);
        }
        const paragraphText = textTokens.join('').trim();
        if (paragraphText) {
          paragraphs.push(paragraphText);
        }
      }

      // Check corresponding speaker notes slide
      let notesText = undefined;
      const notesPath = `ppt/notesSlides/notesSlide${slideNum}.xml`;
      if (zip.files[notesPath]) {
        try {
          const notesXml = await zip.files[notesPath].async('text');
          const noteParagraphs = [];
          const tRegex = /<a:t\b[^>]*>([\s\S]*?)<\/a:t>/gi;
          let tMatch;
          while ((tMatch = tRegex.exec(notesXml)) !== null) {
            const token = tMatch[1].trim();
            if (token && !token.startsWith('Slide ') && !/^\d+$/.test(token)) {
              noteParagraphs.push(token);
            }
          }
          if (noteParagraphs.length > 0) {
            notesText = noteParagraphs.join(' ').trim();
          }
        } catch (_) {}
      }

      const slideBody = paragraphs.join('\n');
      slides.push({
        slideNumber: slideNum,
        title: slideTitle,
        text: slideBody,
        notes: notesText,
        charCount: slideBody.length
      });

      const titleHeader = slideTitle ? `: ${slideTitle}` : '';
      let slideFormatted = `--- Slide ${slideNum}${titleHeader} ---\n${slideBody || '[Empty slide]'}`;
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

  const supportedExts = ['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'xml', 'docx', 'pdf', 'pptx'];
  if (supportedExts.includes(ext)) return true;

  if (
    mime === 'application/pdf' ||
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
    mime === 'text/plain' ||
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
    table: partialResult.table,
    isScanned: Boolean(partialResult.isScanned),
    isTruncated: Boolean(isTruncated || partialResult.isTruncated),
    warning: partialResult.warning,
    error: partialResult.error,
    extractedAt: nowIso
  };
}
