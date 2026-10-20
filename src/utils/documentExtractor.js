/**
 * Orvix Document Extractor Utility
 * High-performance, client-side document parser supporting PDF, DOCX, PPTX, TXT, MD, CSV, and JSON.
 * Extracts structured text, preserves page and slide boundaries, formats tables,
 * and detects scanned / empty documents with clear user guidance.
 */

import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import mammoth from 'mammoth';
import JSZip from 'jszip';

// Configure pdfjs worker for browser environments
if (typeof window !== 'undefined' && pdfjsLib && pdfjsLib.GlobalWorkerOptions) {
  try {
    const version = pdfjsLib.version || '4.10.38';
    pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${version}/legacy/build/pdf.worker.min.mjs`;
  } catch (_) {}
}

export const SUPPORTED_EXTENSIONS = [
  '.pdf',
  '.docx',
  '.pptx',
  '.txt',
  '.md',
  '.csv',
  '.json'
];

export const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB

/**
 * Formats byte size into human-readable string (KB, MB)
 */
export function formatFileSize(bytes) {
  if (typeof bytes !== 'number' || isNaN(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Extracts file extension in lowercase including dot (e.g. '.pdf')
 */
export function getFileExtension(filename = '') {
  const idx = filename.lastIndexOf('.');
  return idx !== -1 ? filename.slice(idx).toLowerCase() : '';
}

/**
 * Identifies file category icon / badge label
 */
export function getFileTypeBadge(filename = '') {
  const ext = getFileExtension(filename);
  switch (ext) {
    case '.pdf':
      return { label: 'PDF', color: 'pdf', icon: 'file-text' };
    case '.docx':
      return { label: 'Word', color: 'docx', icon: 'file-text' };
    case '.pptx':
      return { label: 'Slides', color: 'pptx', icon: 'presentation' };
    case '.csv':
      return { label: 'CSV', color: 'csv', icon: 'table' };
    case '.json':
      return { label: 'JSON', color: 'json', icon: 'code' };
    case '.md':
      return { label: 'Markdown', color: 'md', icon: 'file-code' };
    case '.txt':
    default:
      return { label: 'Text', color: 'txt', icon: 'file' };
  }
}

/**
 * Validates a file before extraction.
 * Returns null if valid, or an error string if invalid.
 */
export function validateAttachmentFile(file) {
  if (!file) {
    return 'No file selected.';
  }

  if (file.size === 0) {
    return `File "${file.name}" is empty (0 bytes). Please upload a document with content.`;
  }

  if (file.size > MAX_FILE_SIZE_BYTES) {
    return `File "${file.name}" (${formatFileSize(file.size)}) exceeds the maximum allowed size of 20 MB.`;
  }

  const ext = getFileExtension(file.name);
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    return `Unsupported file format "${ext || 'unknown'}". Supported formats are PDF (.pdf), Word (.docx), PowerPoint (.pptx), Plain text (.txt), Markdown (.md), CSV (.csv), and JSON (.json).`;
  }

  return null;
}

/**
 * Parses and extracts text content from a PDF document.
 * Preserves page numbering and detects image-only / scanned PDFs.
 */
export async function extractPdfContent(arrayBuffer) {
  let pdf;
  try {
    const loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(arrayBuffer),
      useSystemFonts: true,
      isEvalSupported: false
    });
    pdf = await loadingTask.promise;
  } catch (err) {
    const msg = String(err?.message || '').toLowerCase();
    if (msg.includes('password') || err?.name === 'PasswordException') {
      throw new Error('This PDF is password-protected or encrypted. Please remove password protection before uploading.');
    }
    throw new Error(`Failed to load PDF document: ${err?.message || 'Corrupted or unreadable PDF file.'}`);
  }

  const numPages = pdf.numPages;
  if (numPages === 0) {
    throw new Error('PDF document contains zero pages.');
  }

  const pageEntries = [];
  let totalExtractedLength = 0;

  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    try {
      const page = await pdf.getPage(pageNum);
      const content = await page.getTextContent();
      const items = (content?.items || [])
        .map((item) => (typeof item?.str === 'string' ? item.str : ''))
        .filter(Boolean);

      const rawText = items.join(' ').replace(/\s+/g, ' ').trim();
      totalExtractedLength += rawText.length;
      pageEntries.push({
        pageNum,
        text: rawText
      });
    } catch (pageErr) {
      pageEntries.push({
        pageNum,
        text: `[Error reading page ${pageNum}: ${pageErr.message}]`
      });
    }
  }

  // Detect scanned PDFs with no extractable text layer
  if (totalExtractedLength < 30) {
    throw new Error(
      `This PDF appears to be a scanned document or image-only file with no extractable text layer (${numPages} page${numPages > 1 ? 's' : ''}, ${totalExtractedLength} characters found). Optical Character Recognition (OCR) is required to read this document.`
    );
  }

  // Format into clear page-bounded text
  const formattedSections = pageEntries.map((p) => {
    return `--- Page ${p.pageNum} of ${numPages} ---\n${p.text || '[Blank or image page]'}`;
  });

  const fullText = formattedSections.join('\n\n');
  const wordCount = fullText.split(/\s+/).filter(Boolean).length;

  return {
    type: 'pdf',
    pageCount: numPages,
    wordCount,
    charCount: fullText.length,
    text: fullText,
    pages: pageEntries
  };
}

/**
 * Parses and extracts text, headings, and tables from a DOCX document.
 */
export async function extractDocxContent(arrayBuffer) {
  try {
    // Attempt markdown conversion first to preserve headings, lists, and tables
    const mdResult = await mammoth.convertToMarkdown({ arrayBuffer });
    let text = (mdResult?.value || '').trim();

    // If markdown is empty or sparse, fallback to raw text extraction
    if (!text || text.length < 10) {
      const rawResult = await mammoth.extractRawText({ arrayBuffer });
      text = (rawResult?.value || '').trim();
    }

    if (!text) {
      throw new Error('The DOCX file does not contain extractable text content.');
    }

    const wordCount = text.split(/\s+/).filter(Boolean).length;
    return {
      type: 'docx',
      pageCount: null,
      wordCount,
      charCount: text.length,
      text
    };
  } catch (err) {
    throw new Error(`Failed to extract Word (.docx) document: ${err?.message || 'Invalid or corrupted file.'}`);
  }
}

/**
 * Parses and extracts text from a PowerPoint (.pptx) presentation.
 * Preserves slide order and slide numbering.
 */
export async function extractPptxContent(arrayBuffer) {
  try {
    const zip = await JSZip.loadAsync(arrayBuffer);
    const slideFiles = [];

    // Scan zip contents for ppt/slides/slide*.xml
    zip.forEach((relativePath, file) => {
      const match = relativePath.match(/^ppt\/slides\/slide(\d+)\.xml$/i);
      if (match && !file.dir) {
        slideFiles.push({
          num: parseInt(match[1], 10),
          file
        });
      }
    });

    if (slideFiles.length === 0) {
      throw new Error('No slide XML entries found in the PowerPoint presentation.');
    }

    // Sort strictly by slide number (slide1, slide2, ...)
    slideFiles.sort((a, b) => a.num - b.num);

    const slideEntries = [];
    let totalExtractedLength = 0;

    for (const item of slideFiles) {
      const xmlText = await item.file.async('text');
      // Extract all <a:t> text runs inside paragraphs <a:p>
      // Matches both <a:t>...</a:t> and <a:t xml:space="...">...</a:t>
      const textMatches = [];
      const tagRegex = /<a:t[^>]*>(.*?)<\/a:t>/gi;
      let m;
      while ((m = tagRegex.exec(xmlText)) !== null) {
        if (m[1]) {
          // Unescape common XML entities
          const clean = m[1]
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&apos;/g, "'")
            .trim();
          if (clean) textMatches.push(clean);
        }
      }

      const slideContent = textMatches.join(' ').replace(/\s+/g, ' ').trim();
      totalExtractedLength += slideContent.length;
      slideEntries.push({
        slideNum: item.num,
        text: slideContent
      });
    }

    if (totalExtractedLength === 0) {
      throw new Error('The PowerPoint presentation contains slides but no readable text content (may contain only images or shapes).');
    }

    const formattedSlides = slideEntries.map((s) => {
      return `--- Slide ${s.slideNum} of ${slideEntries.length} ---\n${s.text || '[Image / blank slide]'}`;
    });

    const fullText = formattedSlides.join('\n\n');
    const wordCount = fullText.split(/\s+/).filter(Boolean).length;

    return {
      type: 'pptx',
      slideCount: slideEntries.length,
      wordCount,
      charCount: fullText.length,
      text: fullText,
      slides: slideEntries
    };
  } catch (err) {
    throw new Error(`Failed to extract PowerPoint (.pptx) presentation: ${err?.message || 'Invalid or corrupted file.'}`);
  }
}

/**
 * Parses and extracts CSV file into structured table format for AI reasoning.
 */
export function extractCsvContent(text) {
  if (!text || !text.trim()) {
    throw new Error('CSV file is empty.');
  }

  // Parse CSV lines respecting quotes
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    throw new Error('CSV file contains no data rows.');
  }

  const parseRow = (line) => {
    const cells = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        cells.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    cells.push(current.trim());
    return cells;
  };

  const rows = lines.map(parseRow);
  const headers = rows[0] || [];
  const dataRows = rows.slice(1);

  // Format as structured Markdown table
  const colCount = headers.length;
  const headerLine = `| ${headers.join(' | ')} |`;
  const sepLine = `| ${headers.map(() => '---').join(' | ')} |`;
  const dataLines = dataRows.map((row) => {
    // Pad or trim row to match header count
    const cells = [];
    for (let c = 0; c < colCount; c++) {
      cells.push((row[c] || '').replace(/\|/g, '\\|'));
    }
    return `| ${cells.join(' | ')} |`;
  });

  const structuredTable = [headerLine, sepLine, ...dataLines].join('\n');
  const summary = `CSV Table (${dataRows.length} rows, ${colCount} columns: ${headers.join(', ')})`;
  const fullText = `${summary}\n\n${structuredTable}`;

  return {
    type: 'csv',
    rowCount: dataRows.length,
    colCount,
    headers,
    wordCount: fullText.split(/\s+/).filter(Boolean).length,
    charCount: fullText.length,
    text: fullText
  };
}

/**
 * Parses and extracts JSON file safely.
 */
export function extractJsonContent(text) {
  if (!text || !text.trim()) {
    throw new Error('JSON file is empty.');
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid JSON syntax: ${err.message}. Please verify the file contains well-formed JSON.`);
  }

  // Format JSON cleanly
  const formattedJson = JSON.stringify(parsed, null, 2);
  const isArray = Array.isArray(parsed);
  const countDesc = isArray
    ? `Array of ${parsed.length} items`
    : `Object with ${Object.keys(parsed).length} top-level keys (${Object.keys(parsed).slice(0, 8).join(', ')}${Object.keys(parsed).length > 8 ? '...' : ''})`;

  const fullText = `JSON Data (${countDesc}):\n\`\`\`json\n${formattedJson}\n\`\`\``;

  return {
    type: 'json',
    isArray,
    itemCount: isArray ? parsed.length : Object.keys(parsed).length,
    wordCount: fullText.split(/\s+/).filter(Boolean).length,
    charCount: fullText.length,
    text: fullText
  };
}

/**
 * Universal extraction entry point for any supported file.
 * Accepts a File object or an object { name, size, arrayBuffer or text }.
 *
 * @param {File|Blob|{ name: string, size: number, arrayBuffer: () => Promise<ArrayBuffer>, text?: () => Promise<string> }} file
 * @returns {Promise<{ id: string, name: string, size: number, type: string, text: string, wordCount: number, charCount: number, pageCount?: number, slideCount?: number, rowCount?: number }>}
 */
export async function extractDocumentContent(file) {
  const validationError = validateAttachmentFile(file);
  if (validationError) {
    throw new Error(validationError);
  }

  const ext = getFileExtension(file.name);
  const id = `doc-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  let result;

  if (ext === '.pdf') {
    const buffer = await file.arrayBuffer();
    result = await extractPdfContent(buffer);
  } else if (ext === '.docx') {
    const buffer = await file.arrayBuffer();
    result = await extractDocxContent(buffer);
  } else if (ext === '.pptx') {
    const buffer = await file.arrayBuffer();
    result = await extractPptxContent(buffer);
  } else if (ext === '.csv') {
    const text = typeof file.text === 'function' ? await file.text() : await readBlobAsText(file);
    result = extractCsvContent(text);
  } else if (ext === '.json') {
    const text = typeof file.text === 'function' ? await file.text() : await readBlobAsText(file);
    result = extractJsonContent(text);
  } else if (ext === '.txt' || ext === '.md') {
    const text = typeof file.text === 'function' ? await file.text() : await readBlobAsText(file);
    if (!text || !text.trim()) {
      throw new Error(`File "${file.name}" contains no readable text.`);
    }
    result = {
      type: ext.slice(1),
      wordCount: text.split(/\s+/).filter(Boolean).length,
      charCount: text.length,
      text: text.trim()
    };
  } else {
    throw new Error(`Unsupported document extension "${ext}".`);
  }

  return {
    id,
    name: file.name,
    size: file.size,
    type: result.type,
    text: result.text,
    wordCount: result.wordCount,
    charCount: result.charCount,
    pageCount: result.pageCount || null,
    slideCount: result.slideCount || null,
    rowCount: result.rowCount || null,
    extractedAt: new Date().toISOString()
  };
}

/**
 * Fallback helper to read text from blob in older browsers
 */
function readBlobAsText(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Failed to read file as text.'));
    reader.readAsText(blob, 'utf-8');
  });
}
