/**
 * Orvix Intelligent Document Chunking Service
 * Splits extracted documents (PDF, DOCX, PPTX, TXT, MD, CSV, etc.) into structured,
 * overlapping semantic chunks enriched with source metadata (page, slide, section).
 */

const DEFAULT_CHUNK_SIZE = 700; // Target chunk character size (~120-150 words)
const DEFAULT_CHUNK_OVERLAP = 140; // Overlap characters (~25-30 words)
const MIN_CHUNK_SIZE = 100; // Don't create tiny orphaned chunks

/**
 * Normalizes text by removing non-printable characters and excessive whitespace.
 * @param {string} text
 * @returns {string}
 */
export function normalizeChunkText(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Splits plain text using a hierarchy of natural semantic boundaries:
 * paragraphs (\n\n) -> sentences ([.!?]\s+) -> line breaks (\n) -> words (\s+)
 *
 * @param {string} text
 * @param {Object} [options]
 * @param {number} [options.targetSize=700]
 * @param {number} [options.overlap=140]
 * @returns {Array<{ text: string, startChar: number, endChar: number }>}
 */
export function splitTextIntoSemanticWindows(text, options = {}) {
  const targetSize = options.targetSize || DEFAULT_CHUNK_SIZE;
  const overlap = Math.min(options.overlap || DEFAULT_CHUNK_OVERLAP, Math.floor(targetSize / 2));
  const normalized = normalizeChunkText(text);

  if (!normalized) return [];
  if (normalized.length <= targetSize) {
    return [{ text: normalized, startChar: 0, endChar: normalized.length }];
  }

  // Split into paragraphs first
  const paragraphs = normalized.split(/\n\n+/);
  const rawSegments = [];

  for (const para of paragraphs) {
    const trimmedPara = para.trim();
    if (!trimmedPara) continue;

    if (trimmedPara.length <= targetSize) {
      rawSegments.push(trimmedPara);
    } else {
      // Split large paragraph into sentences
      const sentences = trimmedPara.match(/[^.!?]+(?:[.!?]+["']?|$)/g) || [trimmedPara];
      for (const sent of sentences) {
        const trimmedSent = sent.trim();
        if (!trimmedSent) continue;

        if (trimmedSent.length <= targetSize) {
          rawSegments.push(trimmedSent);
        } else {
          // Fall back to word-level splitting for very long run-on sentences
          const words = trimmedSent.split(/\s+/);
          let currentWordChunk = '';
          for (const word of words) {
            if ((currentWordChunk + ' ' + word).trim().length <= targetSize) {
              currentWordChunk = (currentWordChunk + ' ' + word).trim();
            } else {
              if (currentWordChunk) rawSegments.push(currentWordChunk);
              currentWordChunk = word;
            }
          }
          if (currentWordChunk) rawSegments.push(currentWordChunk);
        }
      }
    }
  }

  // Group raw segments into target-sized chunks with overlap
  const windows = [];
  let currentWindow = '';
  let currentStart = 0;

  for (let i = 0; i < rawSegments.length; i++) {
    const segment = rawSegments[i];
    const candidate = currentWindow ? currentWindow + '\n\n' + segment : segment;

    if (candidate.length <= targetSize) {
      currentWindow = candidate;
    } else {
      if (currentWindow.length >= MIN_CHUNK_SIZE) {
        windows.push({
          text: currentWindow,
          startChar: currentStart,
          endChar: currentStart + currentWindow.length
        });
      }

      // Calculate overlap: look back at trailing text from the current window
      let overlapText = '';
      if (overlap > 0 && currentWindow.length > overlap) {
        const trailing = currentWindow.slice(-overlap);
        // Clean cut at word boundary
        const spaceIdx = trailing.indexOf(' ');
        overlapText = spaceIdx !== -1 ? trailing.slice(spaceIdx + 1).trim() : trailing.trim();
      }

      currentStart += currentWindow.length - overlapText.length;
      currentWindow = overlapText ? overlapText + '\n\n' + segment : segment;
    }
  }

  if (currentWindow && currentWindow.trim().length >= MIN_CHUNK_SIZE) {
    windows.push({
      text: currentWindow.trim(),
      startChar: currentStart,
      endChar: currentStart + currentWindow.trim().length
    });
  } else if (currentWindow && windows.length === 0) {
    // If the text was smaller than MIN_CHUNK_SIZE but non-empty
    windows.push({
      text: currentWindow.trim(),
      startChar: 0,
      endChar: currentWindow.trim().length
    });
  }

  return windows;
}

/**
 * Chunks an extracted document object into structured semantic chunks with rich metadata.
 * Supports PDF (pages), PPTX (slides), DOCX/MD (sections), and generic text files.
 *
 * @param {Object} doc - Document object from documentExtractor / browserDocumentExtractor
 * @param {Object} [options]
 * @param {string} [options.conversationId]
 * @param {number} [options.targetSize=700]
 * @param {number} [options.overlap=140]
 * @returns {Array<Object>} Array of Chunk records
 */
export function chunkDocument(doc, options = {}) {
  if (!doc) return [];

  const docId = doc.id || doc.fileId || `doc_${Date.now()}`;
  const docName = doc.originalName || doc.filename || doc.name || 'document';
  const format = (doc.format || 'FILE').toUpperCase();
  const conversationId = options.conversationId || doc.conversationId || null;
  const targetSize = options.targetSize || DEFAULT_CHUNK_SIZE;
  const overlap = options.overlap || DEFAULT_CHUNK_OVERLAP;

  const chunks = [];
  let globalChunkIndex = 0;

  // 1. Structured PDF chunking by page
  if (format === 'PDF' && Array.isArray(doc.pages) && doc.pages.length > 0) {
    for (const page of doc.pages) {
      const pageText = normalizeChunkText(page.text || '');
      if (!pageText) continue;

      const pageNum = page.pageNumber || 1;
      const pageWindows = splitTextIntoSemanticWindows(pageText, { targetSize, overlap });

      for (let wIdx = 0; wIdx < pageWindows.length; wIdx++) {
        const win = pageWindows[wIdx];
        chunks.push({
          id: `${docId}_p${pageNum}_c${wIdx}`,
          docId,
          conversationId,
          docName,
          format,
          chunkIndex: globalChunkIndex++,
          pageNumber: pageNum,
          totalPages: doc.pageCount || doc.pages.length,
          text: win.text,
          tokenEstimate: Math.ceil(win.text.length / 4),
          charCount: win.text.length,
          startChar: win.startChar,
          endChar: win.endChar,
          sourceType: 'page'
        });
      }
    }

    if (chunks.length > 0) return chunks;
  }

  // 2. Structured PPT / PPTX chunking by slide
  if ((format === 'PPTX' || format === 'PPT') && Array.isArray(doc.slides) && doc.slides.length > 0) {
    for (const slide of doc.slides) {
      const slideTitle = slide.title ? slide.title.trim() : '';
      const slideBody = normalizeChunkText(slide.text || '');
      const notes = normalizeChunkText(slide.notes || '');

      let compositeText = '';
      if (slideTitle) compositeText += `[Slide Title]: ${slideTitle}\n`;
      if (slideBody) compositeText += slideBody;
      if (notes) compositeText += `\n[Speaker Notes]: ${notes}`;

      compositeText = compositeText.trim();
      if (!compositeText) continue;

      const slideNum = slide.slideNumber || 1;
      const slideWindows = splitTextIntoSemanticWindows(compositeText, { targetSize, overlap });

      for (let sIdx = 0; sIdx < slideWindows.length; sIdx++) {
        const win = slideWindows[sIdx];
        chunks.push({
          id: `${docId}_s${slideNum}_c${sIdx}`,
          docId,
          conversationId,
          docName,
          format,
          chunkIndex: globalChunkIndex++,
          slideNumber: slideNum,
          slideTitle: slideTitle || null,
          totalSlides: doc.slideCount || doc.slides.length,
          text: win.text,
          tokenEstimate: Math.ceil(win.text.length / 4),
          charCount: win.text.length,
          startChar: win.startChar,
          endChar: win.endChar,
          sourceType: 'slide'
        });
      }
    }

    if (chunks.length > 0) return chunks;
  }

  // 3. Structured Document chunking by sections (Markdown, DOCX, HTML)
  if (Array.isArray(doc.sections) && doc.sections.length > 0) {
    for (const section of doc.sections) {
      const heading = section.heading ? section.heading.trim() : '';
      const content = normalizeChunkText(section.content || '');
      if (!content && !heading) continue;

      const fullSectionText = heading ? `## ${heading}\n${content}` : content;
      const sectionWindows = splitTextIntoSemanticWindows(fullSectionText, { targetSize, overlap });

      for (let secIdx = 0; secIdx < sectionWindows.length; secIdx++) {
        const win = sectionWindows[secIdx];
        chunks.push({
          id: `${docId}_sec_${globalChunkIndex}`,
          docId,
          conversationId,
          docName,
          format,
          chunkIndex: globalChunkIndex++,
          sectionHeading: heading || null,
          sectionLevel: section.level || 1,
          text: win.text,
          tokenEstimate: Math.ceil(win.text.length / 4),
          charCount: win.text.length,
          startChar: win.startChar,
          endChar: win.endChar,
          sourceType: 'section'
        });
      }
    }

    if (chunks.length > 0) return chunks;
  }

  // 4. Fallback for raw text, OCR scans, CSV, or documents without internal pagination
  const rawText = normalizeChunkText(doc.text || doc.extractedText || doc.content || '');
  if (!rawText) return [];

  const textWindows = splitTextIntoSemanticWindows(rawText, { targetSize, overlap });
  for (let idx = 0; idx < textWindows.length; idx++) {
    const win = textWindows[idx];
    chunks.push({
      id: `${docId}_chunk_${idx}`,
      docId,
      conversationId,
      docName,
      format,
      chunkIndex: globalChunkIndex++,
      text: win.text,
      tokenEstimate: Math.ceil(win.text.length / 4),
      charCount: win.text.length,
      startChar: win.startChar,
      endChar: win.endChar,
      sourceType: 'text'
    });
  }

  return chunks;
}
