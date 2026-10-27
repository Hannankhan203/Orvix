import fs from 'fs';
import path from 'path';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import { extractText as extractPdfText } from 'unpdf';
import { extractImageText, rawImageDataToBmp } from './imageOcrService.js';

// Configurable safety boundaries to prevent memory exhaustion and runaway processing
const MAX_EXTRACTED_CHARACTERS = 500_000; // ~100k words
const MAX_PREVIEW_LENGTH = 350;
const MAX_SCANNED_PDF_PAGES_TO_OCR = 10;
const MIN_IMAGE_OCR_DIMENSION = 30; // Ignore tiny decorative noise icons


/**
 * Counts words in a string
 * @param {string} text
 * @returns {number}
 */
function countWords(text) {
  if (!text) return 0;
  const matches = text.trim().match(/\S+/g);
  return matches ? matches.length : 0;
}

/**
 * Generates a clean preview snippet
 * @param {string} text
 * @returns {string}
 */
function generateSummaryPreview(text) {
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
function truncateSafely(text, limit = MAX_EXTRACTED_CHARACTERS) {
  if (!text || text.length <= limit) {
    return { text, isTruncated: false };
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
function extractSectionsFromMarkdown(markdownText) {
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
function parseDelimitedText(rawText, delimiter) {
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
    return h.padEnd(colWidths[i]);
  }).join(' | ') + ' |';

  const dividerRow = '| ' + colWidths.map((w) => '-'.repeat(w)).join(' | ') + ' |';

  const previewData = dataRows.slice(0, 10).map((row) => {
    return '| ' + Array.from({ length: maxCols }, (_, i) => {
      const c = (row[i] || '').replace(/[\r\n]+/g, '<br>').replace(/\|/g, '\\|');
      return c.padEnd(colWidths[i]);
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
 * Executes OCR on scanned or image-only PDF pages using extracted raster images.
 * Respects page limits, preserves page numbers/boundaries, and distinguishes:
 * - Successful OCR with extracted text ('ready')
 * - Successful OCR with no readable text detected ('NO_TEXT_DETECTED')
 * - OCR engine failure ('ocr_failed')
 * - Unsupported rendering / no extractable raster images ('unsupported_rendering')
 *
 * @param {Buffer} buffer - PDF file bytes
 * @param {number} totalPages - Total page count from PDF metadata
 * @param {Array<Object>} initialPages - Initial page structure
 * @param {Object} [options={}] - Execution options (maxPages, apiKey, offline)
 * @returns {Promise<Object>}
 */
async function ocrScannedPdfPages(buffer, totalPages, initialPages = [], options = {}) {
  let proxy = null;
  try {
    const { getDocumentProxy, extractImages } = await import('unpdf');
    const uint8Array = new Uint8Array(buffer);

    try {
      proxy = await getDocumentProxy(uint8Array);
    } catch (proxyErr) {
      return {
        status: 'ocr_failed',
        success: false,
        isScanned: true,
        hasText: false,
        pageCount: totalPages,
        pages: initialPages,
        text: '',
        totalCharacters: 0,
        totalWords: 0,
        error: `Could not parse PDF for OCR: ${proxyErr?.message || proxyErr}`
      };
    }

    const docPages = totalPages || proxy.numPages || 1;
    const maxPagesToProcess = Math.min(docPages, options.maxPages || MAX_SCANNED_PDF_PAGES_TO_OCR);
    const updatedPages = initialPages.length >= docPages
      ? initialPages.map((p) => ({ ...p, text: '', charCount: 0 }))
      : Array.from({ length: docPages }, (_, i) => ({ pageNumber: i + 1, text: '', charCount: 0 }));

    const ocrTextParts = [];
    let totalOcrCharacters = 0;
    let totalOcrWords = 0;
    let imagesFoundCount = 0;
    let ocrEngineUsed = null;
    let lastOcrError = null;

    for (let pageNum = 1; pageNum <= maxPagesToProcess; pageNum++) {
      let pageImages = [];
      try {
        pageImages = await extractImages(proxy, pageNum);
      } catch (imgErr) {
        console.warn(`[Scanned PDF OCR] Could not extract images from page ${pageNum}:`, imgErr?.message || imgErr);
        continue;
      }

      if (!Array.isArray(pageImages) || pageImages.length === 0) {
        continue;
      }

      // Filter out tiny icons/speckles (< 30px) that cannot be scanned document pages
      const candidateImages = pageImages.filter(
        (img) => img && img.width >= MIN_IMAGE_OCR_DIMENSION && img.height >= MIN_IMAGE_OCR_DIMENSION && img.data
      );

      if (candidateImages.length === 0) {
        continue;
      }

      imagesFoundCount += candidateImages.length;

      // Sort candidate images descending by pixel area (primary full-page scans first)
      candidateImages.sort((a, b) => (b.width * b.height) - (a.width * a.height));

      const pageTextParts = [];

      for (let imgIdx = 0; imgIdx < candidateImages.length; imgIdx++) {
        const img = candidateImages[imgIdx];
        const bmpBuffer = rawImageDataToBmp(img.width, img.height, img.channels, img.data);
        if (!bmpBuffer) continue;

        try {
          const ocrResult = await extractImageText(
            bmpBuffer,
            `scanned_page_${pageNum}_img_${imgIdx + 1}.bmp`,
            '.bmp',
            'image/bmp',
            `page-${pageNum}-${imgIdx}`,
            { width: img.width, height: img.height },
            options.apiKey || null,
            { offline: Boolean(options.offline) }
          );

          if (ocrResult?.ocrEngine) {
            ocrEngineUsed = ocrResult.ocrEngine;
          }

          if (ocrResult?.status === 'ready' && ocrResult?.text) {
            pageTextParts.push(ocrResult.text.trim());
          } else if (ocrResult?.status === 'error') {
            lastOcrError = ocrResult.error || ocrResult.message;
          }
        } catch (ocrErr) {
          console.warn(`[Scanned PDF OCR] Error OCRing page ${pageNum} image ${imgIdx + 1}:`, ocrErr?.message || ocrErr);
          lastOcrError = ocrErr?.message || String(ocrErr);
        }
      }

      const combinedPageOcrText = pageTextParts.filter(Boolean).join('\n\n');
      if (combinedPageOcrText) {
        updatedPages[pageNum - 1] = {
          pageNumber: pageNum,
          text: combinedPageOcrText,
          charCount: combinedPageOcrText.length
        };
        ocrTextParts.push(`--- Page ${pageNum} ---\n${combinedPageOcrText}`);
        totalOcrCharacters += combinedPageOcrText.length;
        totalOcrWords += countWords(combinedPageOcrText);
      }
    }

    const isTruncatedPages = docPages > maxPagesToProcess;

    // Outcome 1: Readable text was extracted by OCR
    if (totalOcrCharacters > 0) {
      const fullText = ocrTextParts.join('\n\n');
      return {
        status: 'ready',
        success: true,
        isScanned: true,
        hasText: true,
        pageCount: docPages,
        pages: updatedPages,
        text: fullText,
        totalCharacters: totalOcrCharacters,
        totalWords: totalOcrWords,
        ocrEngine: ocrEngineUsed || 'tesseract-local',
        isTruncated: isTruncatedPages,
        warning: isTruncatedPages
          ? `Scanned document contains ${docPages} pages. For performance, OCR processed the first ${maxPagesToProcess} pages.`
          : undefined
      };
    }

    // Outcome 2: Images were extracted and OCR ran, but no readable text was detected
    if (imagesFoundCount > 0 && !lastOcrError) {
      return {
        status: 'NO_TEXT_DETECTED',
        success: true,
        isScanned: true,
        hasText: false,
        pageCount: docPages,
        pages: updatedPages,
        text: '',
        totalCharacters: 0,
        totalWords: 0,
        ocrEngine: ocrEngineUsed || 'tesseract-local',
        message: 'No readable text detected in this scanned PDF.',
        warning: 'Optical Character Recognition (OCR) inspected the scanned pages, but no readable text was detected.'
      };
    }

    // Outcome 3: OCR failed due to an engine error
    if (lastOcrError) {
      return {
        status: 'ocr_failed',
        success: false,
        isScanned: true,
        hasText: false,
        pageCount: docPages,
        pages: updatedPages,
        text: '',
        totalCharacters: 0,
        totalWords: 0,
        error: `Optical Character Recognition (OCR) failed on this scanned PDF: ${lastOcrError}`
      };
    }

    // Outcome 4: No extractable raster images found
    return {
      status: 'unsupported_rendering',
      success: false,
      isScanned: true,
      hasText: false,
      pageCount: docPages,
      pages: updatedPages,
      text: '',
      totalCharacters: 0,
      totalWords: 0,
      error: 'No readable text layer was found, and page images could not be extracted for OCR processing.',
      warning: 'This PDF appears to be scanned or rasterized, but embedded page images could not be rendered or extracted.'
    };
  } finally {
    if (proxy?.loadingTask?.destroy) {
      try {
        await proxy.loadingTask.destroy();
      } catch (_) {}
    }
  }
}

/**
 * Determines whether extracted PDF text consists solely of mobile scanner watermarks or sparse headers.
 * Mobile scanning apps (CamScanner, Adobe Scan, etc.) embed a watermark footer (e.g. "Scanned with CamScanner")
 * in the text layer while the page content is completely rasterized.
 * @param {string} text
 * @param {number} totalPages
 * @returns {boolean}
 */
export function isScannerWatermarkOrSparseText(text, totalPages = 1) {
  if (!text) return true;
  const clean = text.replace(/--- Page \d+ ---/g, '').trim();
  const nonWs = clean.replace(/\s+/g, '');
  if (nonWs.length < 10) return true;

  // Detect mobile scanner watermarks
  const watermarkRegex = /^(?:scanned\s+(?:by|with|using)\s+)?camscanner(?:\s+free\s+version)?$/i;
  const altScannerRegex = /^(?:scanned\s+(?:by|with|using)\s+)?(?:adobe\s*scan|microsoft\s*lens|genius\s*scan|tapscanner|fast\s*scanner)$/i;

  const lines = clean.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length > 0 && lines.every((l) => watermarkRegex.test(l) || altScannerRegex.test(l))) {
    return true;
  }

  // If text is very short (< 60 non-whitespace characters total across document) and contains scanner watermark
  if (nonWs.length < 60 && /(?:camscanner|adobe\s*scan|microsoft\s*lens|genius\s*scan|tapscanner)/i.test(clean)) {
    return true;
  }

  return false;
}

/**
 * Core Extractor for PDF documents
 * Retains page-by-page text, detects scanned/image-only PDFs and invokes OCR when necessary
 * @param {Buffer} buffer
 * @param {Object} [options={}]
 * @returns {Promise<Object>}
 */
async function extractPdfDocument(buffer, options = {}) {
  try {
    const res = await extractPdfText(new Uint8Array(buffer), { mergePages: false });
    const rawPages = Array.isArray(res.text) ? res.text : [String(res.text || '')];
    const totalPages = res.totalPages || rawPages.length;

    const pages = [];
    let combinedTextParts = [];
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

    // 1. If native text extraction extracted meaningful text (>= 10 non-whitespace chars AND not merely a scanner watermark), preserve existing behavior!
    if (nonWhitespaceChars >= 10 && !isScannerWatermarkOrSparseText(fullAggregatedText, totalPages)) {
      return {
        status: 'ready',
        success: true,
        pageCount: totalPages,
        pages,
        text: fullAggregatedText,
        isScanned: false
      };
    }

    // 2. Insufficient native text or scanned watermark: PDF is scanned or image-only!
    // Attempt OCR on pages using unpdf raster image extraction and imageOcrService
    return await ocrScannedPdfPages(buffer, totalPages, pages, options);
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
 * Core Extractor for DOCX documents using Mammoth with HTML table transformation and text box enhancement.
 * Preserves headings, lists, tables and their cells in readable Markdown, paragraphs, text boxes (w:txbxContent), and Unicode punctuation.
 * @param {Buffer} buffer
 * @returns {Promise<Object>}
 */
async function extractDocxDocument(buffer) {
  try {
    // 1. Verify docx package integrity as a valid ZIP archive containing word/document.xml
    let zip;
    try {
      zip = await JSZip.loadAsync(buffer);
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

    let markdown = '';

    // 2. Primary path: convert to HTML first to preserve table structures with cell alignments
    try {
      const htmlResult = await mammoth.convertToHtml({ buffer });
      const rawHtml = htmlResult?.value || '';
      if (rawHtml.trim()) {
        markdown = convertMammothHtmlToMarkdown(rawHtml);
      }
    } catch (_) {}

    // 3. Secondary fallback: convert to Markdown directly
    if (!markdown) {
      try {
        const result = await mammoth.convertToMarkdown({ buffer });
        markdown = (result?.value || '').trim();
      } catch (_) {}
    }

    // 4. Tertiary fallback: extract raw text
    if (!markdown) {
      try {
        const raw = await mammoth.extractRawText({ buffer });
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
          // Avoid duplicating text if already captured by Mammoth or previous boxes
          if (box && !markdown.includes(box) && !textBoxes.some((existing) => existing === box || existing.includes(box))) {
            textBoxes.push(box);
          }
        }
      }
    } catch (_) {}

    // Combine markdown content and distinct text box callouts
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
      return ((header[i] || `Col ${i + 1}`).replace(/[\r\n]+/g, ' ')).padEnd(colWidths[i]);
    }).join(' | ') +
    ' |';

  const dividerLine = '| ' + colWidths.map((w) => '-'.repeat(w)).join(' | ') + ' |';

  const rowLines = dataRows.map((r) => {
    return (
      '| ' +
      Array.from({ length: maxCols }, (_, i) => {
        return ((r[i] || '').replace(/[\r\n]+/g, ' ')).padEnd(colWidths[i]);
      }).join(' | ') +
      ' |'
    );
  });

  return [headerLine, dividerLine, ...rowLines].join('\n');
}

/**
 * Core Extractor for Modern PowerPoint (.pptx) documents
 * Retains exact slide-by-slide text, tables (in p:graphicFrame), grouped shapes (in p:grpSp), and speaker notes
 * @param {Buffer} buffer
 * @returns {Promise<Object>}
 */
async function extractPptxDocument(buffer) {
  try {
    const zip = await JSZip.loadAsync(buffer);
    const slideFiles = Object.keys(zip.files).filter((fname) => /^ppt\/slides\/slide\d+\.xml$/.test(fname));

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

    // Sort slides in natural numerical order: slide1, slide2, slide3...
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
            // Also check if graphicFrame contains text runs or diagram shapes
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
          // Extract shapes inside grouped shape in order
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

      // 3. Check corresponding speaker notes slide: ppt/notesSlides/notesSlide{N}.xml
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

      // Assemble slide body components in clean reading order
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
 * Handles Legacy Binary PowerPoint (.ppt) files
 * Adheres strictly to Requirement 7:
 * "For legacy .ppt files, use a compatible parser or a clearly documented conversion approach only if available.
 *  Do not silently treat binary PowerPoint files as plain text."
 * @returns {Object}
 */
function handleLegacyPptDocument() {
  return {
    status: 'unsupported_format',
    success: false,
    text: '',
    totalCharacters: 0,
    totalWords: 0,
    warning:
      'Legacy binary PowerPoint (.ppt) format cannot be parsed directly. Please convert or save the presentation as modern PowerPoint (.pptx) format and re-upload.',
    error:
      'Legacy binary PowerPoint (.ppt) format is not supported for text extraction. Please use modern .pptx format.'
  };
}

/**
 * Core Extractor for Plain Text, Markdown, Log, and Code formats
 * Preserves line breaks, Unicode characters, and encoding
 * @param {Buffer} buffer
 * @param {string} ext
 * @returns {Object}
 */
function extractPlainTextDocument(buffer, ext) {
  let text = '';
  // Check for UTF-16 BOM
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    text = buffer.toString('utf16le');
  } else if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const evenLen = buffer.length - (buffer.length % 2);
    const copy = Buffer.from(buffer.subarray(0, evenLen));
    text = copy.swap16().toString('utf16le');
  } else {
    text = buffer.toString('utf-8');
  }

  // Strip leading UTF-8 BOM if present
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }

  text = text.trim();
  if (!text) {
    return {
      status: 'empty',
      success: false,
      text: '',
      warning: ext === '.log' ? 'The log file is empty.' : 'The text file is empty.'
    };
  }

  if (ext === '.md' || ext === '.markdown') {
    const sections = extractSectionsFromMarkdown(text);
    return {
      status: 'ready',
      success: true,
      text,
      sections,
      sectionCount: sections.length
    };
  }

  return {
    status: 'ready',
    success: true,
    text
  };
}

/**
 * Core Extractor for CSV and TSV tabular data
 * @param {Buffer} buffer
 * @param {string} ext
 * @returns {Object}
 */
function extractDelimitedDocument(buffer, ext) {
  let rawText = buffer.toString('utf-8');
  if (rawText.charCodeAt(0) === 0xfeff) {
    rawText = rawText.slice(1);
  }
  rawText = rawText.trim();

  if (!rawText) {
    return {
      status: 'empty',
      success: false,
      text: '',
      warning: 'The tabular data file is empty.'
    };
  }

  const delimiter = ext === '.tsv' ? '\t' : ',';
  const tableData = parseDelimitedText(rawText, delimiter);

  return {
    status: 'ready',
    success: true,
    text: tableData.markdownTable || rawText,
    rowCount: tableData.rowCount,
    columnCount: tableData.columnCount,
    table: tableData
  };
}

/**
 * Core Extractor for JSON documents
 * Strips UTF-8 BOM if present, preserves all nested keys, values, arrays, strings, and Unicode characters
 * @param {Buffer} buffer
 * @returns {Object}
 */
function extractJsonDocument(buffer) {
  let raw = buffer.toString('utf-8').trim();
  if (raw.charCodeAt(0) === 0xfeff) {
    raw = raw.slice(1).trim();
  }

  if (!raw) {
    return {
      status: 'empty',
      success: false,
      text: '',
      warning: 'The JSON file is empty.'
    };
  }

  try {
    const parsed = JSON.parse(raw);
    const formatted = JSON.stringify(parsed, null, 2);
    return {
      status: 'ready',
      success: true,
      text: formatted
    };
  } catch (err) {
    return {
      status: 'corrupted',
      success: false,
      text: '',
      error: `Invalid JSON syntax: ${err?.message || 'Malformed JSON.'}`
    };
  }
}

/**
 * Core Extractor for XML documents
 * Preserves readable element text and meaningful paragraph/block structure
 * with decoded XML entities without merging unrelated paragraphs.
 * @param {Buffer} buffer
 * @returns {Object}
 */
function extractXmlDocument(buffer) {
  let raw = buffer.toString('utf-8').trim();
  if (raw.charCodeAt(0) === 0xfeff) {
    raw = raw.slice(1).trim();
  }

  if (!raw) {
    return {
      status: 'empty',
      success: false,
      text: '',
      warning: 'The XML file is empty.'
    };
  }

  // Preserve CDATA content before tag stripping
  const unwrappedCdata = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1');

  // Insert line breaks at block-level closing tags to retain natural paragraphs/sections
  const structured = unwrappedCdata
    .replace(/<\/(?:p|div|section|article|item|entry|row|record|message|h[1-6]|li|title)>/gi, '\n')
    .replace(/<(?:br|hr)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  // Decode XML entities and clean up whitespace per line
  const decoded = decodeXmlEntities(structured);
  const cleanLines = decoded
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter((l) => l.length > 0);

  const cleanText = cleanLines.join('\n\n');

  if (!cleanText) {
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
    text: `\`\`\`xml\n${raw.slice(0, 100_000)}\n\`\`\`\n\n### Extracted Text Content\n${cleanText}`
  };
}

/**
 * Primary dispatch function to extract readable text and structure from uploaded documents.
 *
 * @param {string} filePath Full path to the file on disk
 * @param {string} originalName User's original file name
 * @param {string} ext File extension in lowercase (e.g. '.pdf')
 * @param {string} mimeType Client MIME type
 * @param {string} fileId System-generated UUID
 * @returns {Promise<Object>}
 */
export async function extractDocumentContent(
  filePathOrBuffer,
  originalName,
  ext,
  mimeType,
  fileId,
  options = {}
) {
  const isBuf = Buffer.isBuffer(filePathOrBuffer);
  const displayFilename = isBuf
    ? originalName || 'document'
    : path.basename(typeof filePathOrBuffer === 'string' ? filePathOrBuffer : 'document');
  const normalizedExt = (ext || (isBuf ? '' : path.extname(String(filePathOrBuffer || '')))).toLowerCase();
  const formatName = normalizedExt.replace('.', '').toUpperCase();
  const nowIso = new Date().toISOString();

  let buffer;
  let fileSizeBytes = 0;

  if (isBuf) {
    buffer = filePathOrBuffer;
    fileSizeBytes = buffer.length;
  } else {
    const filePath = String(filePathOrBuffer || '');
    let fileStats;
    try {
      fileStats = await fs.promises.stat(filePath);
      fileSizeBytes = fileStats.size;
    } catch (err) {
      return {
        fileId,
        filename: displayFilename,
        originalName,
        format: formatName,
        mimeType,
        sizeBytes: 0,
        status: 'error',
        success: false,
        text: '',
        totalCharacters: 0,
        totalWords: 0,
        error: `File access error: ${err?.message || 'File not found on server.'}`,
        extractedAt: nowIso
      };
    }

    if (fileSizeBytes === 0) {
      return {
        fileId,
        filename: displayFilename,
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

    try {
      buffer = await fs.promises.readFile(filePath);
    } catch (err) {
      return {
        fileId,
        filename: displayFilename,
        originalName,
        format: formatName,
        mimeType,
        sizeBytes: fileSizeBytes,
        status: 'error',
        success: false,
        text: '',
        totalCharacters: 0,
        totalWords: 0,
        error: `Failed to read file from disk: ${err?.message}`,
        extractedAt: nowIso
      };
    }
  }

  if (fileSizeBytes === 0) {
    return {
      fileId,
      filename: displayFilename,
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

  let partialResult = {};

  try {
    switch (normalizedExt) {
      case '.pdf':
        partialResult = await extractPdfDocument(buffer, options);
        break;

      case '.docx':
        partialResult = await extractDocxDocument(buffer);
        break;

      case '.pptx':
        partialResult = await extractPptxDocument(buffer);
        break;

      case '.ppt':
        partialResult = handleLegacyPptDocument();
        break;

      case '.txt':
      case '.log':
      case '.md':
      case '.markdown':
        partialResult = extractPlainTextDocument(buffer, normalizedExt);
        break;

      case '.csv':
      case '.tsv':
        partialResult = extractDelimitedDocument(buffer, normalizedExt);
        break;

      case '.json':
        partialResult = extractJsonDocument(buffer);
        break;

      case '.xml':
        partialResult = extractXmlDocument(buffer);
        break;

      default:
        partialResult = {
          status: 'unsupported_format',
          success: false,
          text: '',
          error: `Extraction is not supported for extension '${normalizedExt}'.`
        };
        break;
    }
  } catch (err) {
    partialResult = {
      status: 'error',
      success: false,
      text: '',
      error: `Unexpected extraction exception: ${err?.message || 'Internal parsing error.'}`
    };
  }

  // Apply safety truncation limits
  const rawText = partialResult.text || '';
  const { text: safeText, isTruncated } = truncateSafely(rawText, MAX_EXTRACTED_CHARACTERS);

  const totalCharacters = safeText.length;
  const totalWords = countWords(safeText);
  const summaryText = generateSummaryPreview(safeText);

  return {
    fileId,
    filename: displayFilename,
    originalName,
    format: formatName,
    mimeType,
    sizeBytes: fileSizeBytes,
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
    isScanned: partialResult.isScanned,
    hasText: partialResult.hasText !== undefined ? partialResult.hasText : (totalCharacters > 0),
    ocrEngine: partialResult.ocrEngine,
    message: partialResult.message,
    isTruncated: isTruncated || partialResult.isTruncated,
    warning: partialResult.warning,
    error: partialResult.error,
    extractedAt: nowIso
  };
}
