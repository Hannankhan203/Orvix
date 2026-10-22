import fs from 'fs';
import path from 'path';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import { extractText as extractPdfText } from 'unpdf';

// Configurable safety boundaries to prevent memory exhaustion and runaway processing
const MAX_EXTRACTED_CHARACTERS = 500_000; // ~100k words
const MAX_PREVIEW_LENGTH = 350;

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
 * Parses markdown or text headings into structured sections
 * @param {string} markdownText
 * @returns {Array<{ heading: string, level: number, content: string, charCount: number }>}
 */
function extractSectionsFromMarkdown(markdownText) {
  const sections = [];
  const lines = markdownText.split('\n');

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
function parseDelimitedText(rawText, delimiter) {
  const rows = [];
  const lines = rawText.split(/\r?\n/);

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

  // Build markdown table
  const colWidths = new Array(maxCols).fill(3);
  for (const row of rows) {
    for (let c = 0; c < row.length; c++) {
      colWidths[c] = Math.max(colWidths[c], Math.min((row[c] || '').length, 40));
    }
  }

  const headerRow = '| ' + headers.map((h, i) => (h || `Col ${i + 1}`).padEnd(colWidths[i])).join(' | ') + ' |';
  const dividerRow = '| ' + colWidths.map((w) => '-'.repeat(w)).join(' | ') + ' |';
  const previewData = dataRows.slice(0, 10).map((row) => {
    return '| ' + row.map((cell, i) => (cell || '').padEnd(colWidths[i])).join(' | ') + ' |';
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
 * Core Extractor for PDF documents
 * Retains page-by-page text, detects scanned/image-only PDFs and encryption
 * @param {Buffer} buffer
 * @returns {Promise<Object>}
 */
async function extractPdfDocument(buffer) {
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

    // Detect scanned or image-only PDFs
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
          'No readable text could be extracted from this PDF. This document appears to be scanned, image-only, or contains rasterized pages without a text layer. Optical Character Recognition (OCR) may be required.'
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
 * Core Extractor for DOCX documents using Mammoth
 * Preserves headings, lists, tables, and paragraphs
 * @param {Buffer} buffer
 * @returns {Promise<Object>}
 */
async function extractDocxDocument(buffer) {
  try {
    const result = await mammoth.convertToMarkdown({ buffer });
    const markdown = (result?.value || '').trim();

    if (!markdown) {
      // Fallback to raw text extraction if markdown is empty
      const raw = await mammoth.extractRawText({ buffer });
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
 * Core Extractor for Modern PowerPoint (.pptx) documents
 * Retains exact slide-by-slide text and speaker notes
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

      let slideTitle = undefined;
      const paragraphs = [];

      // Extract shapes and paragraphs
      // Title detection: <p:sp> with <p:ph type="title"/> or <p:ph type="ctrTitle"/>
      const spRegex = /<p:sp\b[^>]*>([\s\S]*?)<\/p:sp>/gi;
      let spMatch;
      while ((spMatch = spRegex.exec(slideXml)) !== null) {
        const spXml = spMatch[1];
        const isTitleShape = /<p:ph\b[^>]*\btype=["'](?:title|ctrTitle)["']/i.test(spXml);

        const pRegex = /<a:p\b[^>]*>([\s\S]*?)<\/a:p>/gi;
        let pMatch;
        while ((pMatch = pRegex.exec(spXml)) !== null) {
          const pXml = pMatch[1];
          const tRegex = /<a:t\b[^>]*>([\s\S]*?)<\/a:t>/gi;
          const textTokens = [];
          let tMatch;
          while ((tMatch = tRegex.exec(pXml)) !== null) {
            textTokens.push(tMatch[1]);
          }
          const paragraphText = textTokens.join('').trim();
          if (paragraphText) {
            if (isTitleShape && !slideTitle) {
              slideTitle = paragraphText;
            }
            paragraphs.push(paragraphText);
          }
        }
      }

      // Check corresponding speaker notes slide: ppt/notesSlides/notesSlide{N}.xml
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
 * Core Extractor for Plain Text, Markdown, and Code formats
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
    text = buffer.swap16().toString('utf16le');
  } else {
    text = buffer.toString('utf-8');
  }

  text = text.trim();
  if (!text) {
    return {
      status: 'empty',
      success: false,
      text: '',
      warning: 'The text file is empty.'
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
  const rawText = buffer.toString('utf-8').trim();
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
    table: tableData
  };
}

/**
 * Core Extractor for JSON documents
 * @param {Buffer} buffer
 * @returns {Object}
 */
function extractJsonDocument(buffer) {
  const raw = buffer.toString('utf-8').trim();
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
 * @param {Buffer} buffer
 * @returns {Object}
 */
function extractXmlDocument(buffer) {
  const raw = buffer.toString('utf-8').trim();
  if (!raw) {
    return {
      status: 'empty',
      success: false,
      text: '',
      warning: 'The XML file is empty.'
    };
  }

  // Strip tags for clean text content while retaining structure
  const textWithoutTags = raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    status: 'ready',
    success: true,
    text: `\`\`\`xml\n${raw.slice(0, 100_000)}\n\`\`\`\n\n### Extracted Text Content\n${textWithoutTags}`
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
export async function extractDocumentContent(filePathOrBuffer, originalName, ext, mimeType, fileId) {
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
        partialResult = await extractPdfDocument(buffer);
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
    table: partialResult.table,
    isScanned: partialResult.isScanned,
    isTruncated: isTruncated || partialResult.isTruncated,
    warning: partialResult.warning,
    error: partialResult.error,
    extractedAt: nowIso
  };
}
