/**
 * Orvix Document Context & Question Processing Service
 * Provides document intent parsing, page/slide selection, bounded retrieval,
 * format limitation explanations, and multi-document context construction.
 * Pure JavaScript module for React.js and Node.js compatibility.
 */

const MAX_PROMPT_CHARS_PER_DOC = 100_000; // ~20k words limit per document for safe LLM context

/**
 * Parses user prompt text to detect questions about uploaded documents,
 * specific pages, page ranges, PowerPoint slides, sections, or whole-file requests.
 * @param {string} prompt
 * @param {Array<Object>} [availableDocs=[]]
 * @returns {any}
 */
export function parseDocumentQueryIntent(prompt, availableDocs = []) {
  if (!prompt || typeof prompt !== 'string') {
    return { isDocumentQuery: false, targetScope: 'general_query' };
  }

  const cleanPrompt = prompt.trim();
  const lowerPrompt = cleanPrompt.toLowerCase();

  // Check if a specific filename was mentioned
  let targetFilename = undefined;
  for (const doc of availableDocs) {
    const docName = (doc.originalName || doc.filename || doc.name || '').toLowerCase();
    const baseDocName = docName.includes('.') ? docName.substring(0, docName.lastIndexOf('.')) : docName;
    if (docName && lowerPrompt.includes(docName)) {
      targetFilename = doc.originalName || doc.filename || doc.name;
      break;
    } else if (baseDocName.length >= 4 && lowerPrompt.includes(baseDocName)) {
      targetFilename = doc.originalName || doc.filename || doc.name;
      break;
    }
  }

  // 1. Detect slide range: e.g. "slides 3 to 7", "slides 2-5", "slides 1 through 4"
  const slideRangeMatch = lowerPrompt.match(/\bslides?\s*(?:#|\b)?\s*(\d+)\s*(?:to|-|through|–|—)\s*(\d+)\b/i);
  if (slideRangeMatch) {
    const start = parseInt(slideRangeMatch[1], 10);
    const end = parseInt(slideRangeMatch[2], 10);
    if (!isNaN(start) && !isNaN(end) && start > 0 && end >= start) {
      const slides = [];
      const safeEnd = Math.min(end, start + 50); // cap range at 50 slides
      for (let s = start; s <= safeEnd; s++) slides.push(s);
      return {
        isDocumentQuery: true,
        targetScope: 'slide_range',
        targetSlides: slides,
        targetFilename,
        cleanedQuestion: cleanPrompt
      };
    }
  }

  // 2. Detect single slide: e.g. "slide 4", "slide #2", "explain slide 5"
  const singleSlideMatch = lowerPrompt.match(/\bslides?\s*(?:#|\b)?\s*(\d+)\b/i);
  if (singleSlideMatch) {
    const slideNum = parseInt(singleSlideMatch[1], 10);
    if (!isNaN(slideNum) && slideNum > 0) {
      return {
        isDocumentQuery: true,
        targetScope: 'slide',
        targetSlides: [slideNum],
        targetFilename,
        cleanedQuestion: cleanPrompt
      };
    }
  }

  // 3. Detect page range: e.g. "pages 3 to 7", "pages 3-7", "pages 3 through 7", "pages 2 to 4"
  const pageRangeMatch = lowerPrompt.match(/\bpages?\s*(?:#|\b)?\s*(\d+)\s*(?:to|-|through|–|—)\s*(\d+)\b/i);
  if (pageRangeMatch) {
    const start = parseInt(pageRangeMatch[1], 10);
    const end = parseInt(pageRangeMatch[2], 10);
    if (!isNaN(start) && !isNaN(end) && start > 0 && end >= start) {
      const pages = [];
      const safeEnd = Math.min(end, start + 50); // cap range at 50 pages
      for (let p = start; p <= safeEnd; p++) pages.push(p);
      return {
        isDocumentQuery: true,
        targetScope: 'page_range',
        targetPages: pages,
        targetFilename,
        cleanedQuestion: cleanPrompt
      };
    }
  }

  // 4. Detect single page: e.g. "page 5", "page #5", "p. 5", "pg 5"
  const singlePageMatch =
    lowerPrompt.match(/\b(?:page|pg)\s*(?:#|\b)?\s*(\d+)\b/i) ||
    lowerPrompt.match(/\bp\.\s*(\d+)\b/i);
  if (singlePageMatch) {
    const pageNum = parseInt(singlePageMatch[1], 10);
    if (!isNaN(pageNum) && pageNum > 0) {
      return {
        isDocumentQuery: true,
        targetScope: 'page',
        targetPages: [pageNum],
        targetFilename,
        cleanedQuestion: cleanPrompt
      };
    }
  }

  // 5. Detect whole-file or full summary requests
  const wholeFileRegex =
    /(?:explain|summarize|review|analyze|describe|read|break down|overview|tell me about)\s+(?:this|the|all of the|our)?\s*(?:whole|entire|full|complete)\s*(?:file|document|doc|pdf|presentation|slideshow|deck|sheet|table|text)/i;
  const summarizeRegex =
    /(?:summarize|summary of|give me a summary of|overview of|explain|review|analyze|tell me about|what is in|what is)\s+(?:this|the|all of the)?\s*(?:whole|entire|full|complete)?\s*(?:file|document|doc|pdf|presentation|slideshow|deck|sheet|attachment|data)/i;
  const directWholePrompt =
    /^(?:summarize|summary|overview|explain this|explain file|explain document|summarize this|summarize document|summarize file|what is this (?:file|document|presentation)|tl;?dr)[.!?]?$/i;

  if (wholeFileRegex.test(lowerPrompt) || summarizeRegex.test(lowerPrompt) || directWholePrompt.test(lowerPrompt)) {
    return {
      isDocumentQuery: true,
      targetScope: 'whole_file',
      targetFilename,
      cleanedQuestion: cleanPrompt
    };
  }

  // 6. Detect general document queries (e.g. "What does the document say about X?", "In this file, what is...", "Using the uploaded document, answer...")
  const docReferenceRegex =
    /(?:document|file|uploaded|attachment|pdf|presentation|slides|docx|dataset|table|sheet)/i;
  if (docReferenceRegex.test(lowerPrompt) || availableDocs.length > 0) {
    return {
      isDocumentQuery: true,
      targetScope: 'general_query',
      targetFilename,
      cleanedQuestion: cleanPrompt
    };
  }

  return {
    isDocumentQuery: false,
    targetScope: 'general_query',
    cleanedQuestion: cleanPrompt
  };
}

/**
 * Processes one or more documents against a user's prompt intent,
 * applying page/slide extraction, format limitation notices, error explanations,
 * safe chunking for large files, and clean demarcations between multiple files.
 * @param {string} prompt
 * @param {Array<Object>} docs
 * @returns {any}
 */
export function prepareDocumentContext(prompt, docs) {
  if (!docs || docs.length === 0) {
    return {
      formattedContext: '',
      hasErrorsOrWarnings: false,
      unreadableDocNotes: [],
      targetedDocs: [],
      scope: 'none',
      isBoundedOrChunked: false
    };
  }

  const intent = parseDocumentQueryIntent(prompt, docs);

  // If a specific document filename was mentioned in the prompt, prioritize it; otherwise include all available
  let selectedDocs = docs;
  if (intent.targetFilename) {
    const matched = docs.filter(
      (d) =>
        (d.originalName || d.filename || d.name || '').toLowerCase() ===
        intent.targetFilename.toLowerCase()
    );
    if (matched.length > 0) {
      selectedDocs = matched;
    }
  }

  const unreadableDocNotes = [];
  const docBlocks = [];
  let directAnswer = undefined;
  let isBoundedOrChunked = false;
  let truncationNote = undefined;

  for (let docIdx = 0; docIdx < selectedDocs.length; docIdx++) {
    const doc = selectedDocs[docIdx];
    const docName = doc.originalName || doc.filename || doc.name || `Document_${docIdx + 1}`;
    const format = (doc.format || 'UNKNOWN').toUpperCase();

    // Check for extraction failure or non-readable content
    if (
      doc.status === 'scanned_or_image_only' ||
      doc.isScanned ||
      (doc.totalCharacters === 0 && !doc.success)
    ) {
      const issueExplanation =
        doc.warning ||
        `No readable text could be extracted from '${docName}'. This document appears to be scanned, image-only, or contains rasterized pages without an embedded text layer. Optical Character Recognition (OCR) would be required to extract text.`;
      unreadableDocNotes.push(issueExplanation);

      // If this was the only or primary document requested, provide direct answer
      if (selectedDocs.length === 1) {
        directAnswer = issueExplanation;
      }
      docBlocks.push(`[DOCUMENT ${docIdx + 1}: "${docName}" (${format}) - STATUS: UNREADABLE (SCANNED/IMAGE-ONLY)]\n${issueExplanation}`);
      continue;
    }

    if (doc.status === 'encrypted') {
      const issue = `The document '${docName}' is encrypted or password-protected and cannot be read without a password.`;
      unreadableDocNotes.push(issue);
      if (selectedDocs.length === 1) directAnswer = issue;
      docBlocks.push(`[DOCUMENT ${docIdx + 1}: "${docName}" (${format}) - STATUS: ENCRYPTED]\n${issue}`);
      continue;
    }

    if (doc.status === 'empty' || (doc.totalCharacters === 0 && doc.totalWords === 0)) {
      const issue = `The document '${docName}' is empty (contains 0 bytes or no readable text characters).`;
      unreadableDocNotes.push(issue);
      if (selectedDocs.length === 1) directAnswer = issue;
      docBlocks.push(`[DOCUMENT ${docIdx + 1}: "${docName}" (${format}) - STATUS: EMPTY]\n${issue}`);
      continue;
    }

    if (doc.status === 'error' && doc.error) {
      const issue = `The document '${docName}' could not be processed: ${doc.error}`;
      unreadableDocNotes.push(issue);
      if (selectedDocs.length === 1) directAnswer = issue;
      docBlocks.push(`[DOCUMENT ${docIdx + 1}: "${docName}" (${format}) - STATUS: ERROR]\n${issue}`);
      continue;
    }

    // Process based on intent scope:
    // Case 1: Specific Page or Page Range
    if (intent.targetScope === 'page' || intent.targetScope === 'page_range') {
      const requestedPages = intent.targetPages || [];

      // Check if document format has reliable physical pages (PDF)
      if (format === 'PDF' && Array.isArray(doc.pages) && doc.pages.length > 0) {
        const totalPages = doc.pageCount || doc.pages.length;
        const validPages = requestedPages.filter((p) => p >= 1 && p <= totalPages);
        const outOfBoundsPages = requestedPages.filter((p) => p < 1 || p > totalPages);

        if (validPages.length === 0) {
          const outOfBoundsMsg = `The uploaded PDF '${docName}' contains ${totalPages} page${totalPages === 1 ? '' : 's'}. Requested page ${requestedPages.join(', ')} does not exist in this document.`;
          if (selectedDocs.length === 1) {
            directAnswer = outOfBoundsMsg;
          }
          docBlocks.push(`[DOCUMENT ${docIdx + 1}: "${docName}" (PDF, ${totalPages} pages)]\n${outOfBoundsMsg}`);
          continue;
        }

        let pageContent = `=== DOCUMENT: "${docName}" (PDF, ${totalPages} pages total) ===\n`;
        if (outOfBoundsPages.length > 0) {
          pageContent += `[Note: Page(s) ${outOfBoundsPages.join(', ')} are out of bounds. Showing available pages ${validPages.join(', ')} of ${totalPages}]\n\n`;
        }

        for (const pNum of validPages) {
          const pageObj = doc.pages.find((p) => p.pageNumber === pNum);
          const pageText = pageObj ? pageObj.text.trim() : '';
          pageContent += `--- Page ${pNum} of ${totalPages} ---\n${pageText || '[This page is blank or contains no readable text]'}\n\n`;
        }

        docBlocks.push(pageContent.trim());
        continue;
      } else {
        // Document format does NOT have reliable physical page boundaries
        const formatLimitationNotice =
          `Notice regarding format limitations: '${docName}' is in ${format} format. Word documents (.docx), Markdown (.md), plain text (.txt), and tabular files do not have fixed physical page numbers because their pagination depends on layout, margins, and device rendering.\n` +
          `Instead, the complete structured content and available sections/headings for '${docName}' are provided below:`;

        let structuredContent = `=== DOCUMENT: "${docName}" (${format}) ===\n${formatLimitationNotice}\n\n`;

        if (Array.isArray(doc.sections) && doc.sections.length > 0) {
          for (const s of doc.sections) {
            structuredContent += `### ${'#'.repeat(Math.max(1, s.level - 1))} ${s.heading}\n${s.content}\n\n`;
          }
        } else {
          structuredContent += doc.text || '[Empty content]';
        }

        docBlocks.push(structuredContent.trim());
        continue;
      }
    }

    // Case 2: Specific Slide or Slide Range
    if (intent.targetScope === 'slide' || intent.targetScope === 'slide_range') {
      const requestedSlides = intent.targetSlides || [];

      if (format === 'PPTX' && Array.isArray(doc.slides) && doc.slides.length > 0) {
        const totalSlides = doc.slideCount || doc.slides.length;
        const validSlides = requestedSlides.filter((s) => s >= 1 && s <= totalSlides);
        const outOfBoundsSlides = requestedSlides.filter((s) => s < 1 || s > totalSlides);

        if (validSlides.length === 0) {
          const outOfBoundsMsg = `The presentation '${docName}' contains ${totalSlides} slide${totalSlides === 1 ? '' : 's'}. Requested slide ${requestedSlides.join(', ')} does not exist in this presentation.`;
          if (selectedDocs.length === 1) {
            directAnswer = outOfBoundsMsg;
          }
          docBlocks.push(`[DOCUMENT ${docIdx + 1}: "${docName}" (PPTX, ${totalSlides} slides)]\n${outOfBoundsMsg}`);
          continue;
        }

        let slideContent = `=== DOCUMENT: "${docName}" (PPTX Presentation, ${totalSlides} slides total) ===\n`;
        if (outOfBoundsSlides.length > 0) {
          slideContent += `[Note: Slide(s) ${outOfBoundsSlides.join(', ')} do not exist. Showing available slide(s) ${validSlides.join(', ')} of ${totalSlides}]\n\n`;
        }

        for (const sNum of validSlides) {
          const slideObj = doc.slides.find((s) => s.slideNumber === sNum);
          if (slideObj) {
            slideContent += `--- Slide ${sNum} of ${totalSlides}${slideObj.title ? `: ${slideObj.title}` : ''} ---\n`;
            slideContent += `${slideObj.text || '[Empty slide content]'}\n`;
            if (slideObj.notes) {
              slideContent += `[Speaker Notes]: ${slideObj.notes}\n`;
            }
            slideContent += '\n';
          }
        }

        docBlocks.push(slideContent.trim());
        continue;
      } else {
        // User asked for slides on a non-presentation document
        const limitationNotice =
          `Notice: '${docName}' is a ${format} file, not a presentation slideshow. It does not have slides. The document content is provided below:`;
        docBlocks.push(`=== DOCUMENT: "${docName}" (${format}) ===\n${limitationNotice}\n\n${doc.text || ''}`);
        continue;
      }
    }

    // Case 3: Whole File or General Document Query
    let docBody = '';
    const metaHeader = `=== DOCUMENT ${docIdx + 1} of ${selectedDocs.length}: "${docName}" ===\n` +
      `Format: ${format} | Total Characters: ${doc.totalCharacters.toLocaleString()} | Words: ${doc.totalWords.toLocaleString()}` +
      (doc.pageCount ? ` | Pages: ${doc.pageCount}` : '') +
      (doc.slideCount ? ` | Slides: ${doc.slideCount}` : '') +
      (doc.sectionCount ? ` | Sections: ${doc.sectionCount}` : '') +
      '\n';

    // Check size limit: If document exceeds MAX_PROMPT_CHARS_PER_DOC, implement safe bounded chunking / retrieval
    if (doc.totalCharacters > MAX_PROMPT_CHARS_PER_DOC) {
      isBoundedOrChunked = true;
      truncationNote =
        `Note: '${docName}' is an extensive document (${doc.totalCharacters.toLocaleString()} characters, ` +
        (doc.pageCount ? `${doc.pageCount} pages` : `${doc.sectionCount || 'multiple'} sections`) +
        `). To prevent context overflow while maintaining deep analysis, this view includes the structural overview and key extracted portions. You can ask for specific pages (e.g. 'Explain page 5' or 'Explain pages 3 to 7') or specific sections.`;

      // Safe bounded extraction: Table of Contents / Outline + Top Chunks
      let boundedText = `${truncationNote}\n\n### Document Structural Overview\n`;

      if (Array.isArray(doc.pages) && doc.pages.length > 0) {
        boundedText += `Total Pages: ${doc.pageCount || doc.pages.length}. Available page index: 1 through ${doc.pageCount || doc.pages.length}.\n\n`;
        const pagesToInclude = doc.pages.slice(0, 15);
        for (const p of pagesToInclude) {
          boundedText += `--- Page ${p.pageNumber} ---\n${p.text ? p.text.slice(0, 4000) : '[Blank]'}\n\n`;
        }
        boundedText += `\n[... Additional pages 16 through ${doc.pages.length} available upon request. Ask for any specific page number or range ...]\n`;
      } else if (Array.isArray(doc.sections) && doc.sections.length > 0) {
        boundedText += `Total Sections: ${doc.sections.length}.\nSection Headings: ${doc.sections.map((s) => s.heading).join(', ')}\n\n`;
        let accLength = 0;
        for (const s of doc.sections) {
          if (accLength > MAX_PROMPT_CHARS_PER_DOC - 10000) break;
          boundedText += `### ${s.heading}\n${s.content.slice(0, 6000)}\n\n`;
          accLength += s.content.length;
        }
      } else {
        boundedText += doc.text.slice(0, MAX_PROMPT_CHARS_PER_DOC) + '\n\n[... Remaining content bounded for context limits. Specify pages or sections for detailed analysis ...]';
      }

      docBody = metaHeader + '\n' + boundedText;
    } else {
      docBody = metaHeader + '\n' + (doc.text || '[No readable text]');
    }

    docBlocks.push(docBody);
  }

  const formattedContext = docBlocks.join('\n\n' + '='.repeat(60) + '\n\n');

  return {
    formattedContext,
    hasErrorsOrWarnings: unreadableDocNotes.length > 0,
    unreadableDocNotes,
    targetedDocs: selectedDocs,
    scope: intent.targetScope,
    isBoundedOrChunked,
    truncationNote,
    directAnswer
  };
}

/**
 * Builds high-fidelity simulated answers for document questions when running in demo/offline mode.
 * Grounded directly in the actual extracted pages, slides, sections, or table data.
 * @param {string} prompt
 * @param {Object} preparedContext
 * @returns {string}
 */
export function generateSimulatedDocumentResponse(prompt, preparedContext) {
  if (preparedContext.directAnswer) {
    return preparedContext.directAnswer;
  }

  const { targetedDocs, scope } = preparedContext;
  if (!targetedDocs || targetedDocs.length === 0) {
    return "No document is currently attached to this conversation. Please attach a document (PDF, Word, PowerPoint, TXT, CSV) to analyze it.";
  }

  const primaryDoc = targetedDocs[0];
  const docName = primaryDoc.originalName || primaryDoc.filename || 'Uploaded Document';
  const format = (primaryDoc.format || 'FILE').toUpperCase();

  // 1. Single Page Question
  if (scope === 'page') {
    const intent = parseDocumentQueryIntent(prompt, targetedDocs);
    const pNum = intent.targetPages?.[0] || 1;

    if (format === 'PDF' && primaryDoc.pages) {
      const pageObj = primaryDoc.pages.find((p) => p.pageNumber === pNum);
      if (!pageObj || !pageObj.text) {
        return `### Analysis of Page ${pNum} (${docName})\n\nPage ${pNum} of this document appears to be empty or contains no readable text characters.`;
      }

      const textSnippet = pageObj.text.slice(0, 1200);
      return `### Analysis of Page ${pNum} (${docName})

**Page Overview:** Page ${pNum} contains ${pageObj.charCount} characters (${countWordsInString(pageObj.text)} words).

#### Content Breakdown:
${formatExcerptIntoBullets(textSnippet)}

---
> **Excerpt from Page ${pNum}:**  
> "${textSnippet.slice(0, 300)}..."`;
    }
  }

  // 2. Page Range Question
  if (scope === 'page_range') {
    const intent = parseDocumentQueryIntent(prompt, targetedDocs);
    const pages = intent.targetPages || [];
    const minPage = Math.min(...pages);
    const maxPage = Math.max(...pages);

    if (format === 'PDF' && primaryDoc.pages) {
      const relevantPages = primaryDoc.pages.filter((p) => pages.includes(p.pageNumber));
      const breakdown = relevantPages
        .map((p) => `• **Page ${p.pageNumber}:** ${p.text ? p.text.replace(/\s+/g, ' ').slice(0, 180) + '...' : '[Blank / No text]'}`)
        .join('\n');

      return `### Analysis of Pages ${minPage} to ${maxPage} (${docName})

The requested range covers ${relevantPages.length} pages within **${docName}**:

#### Page-by-Page Summary:
${breakdown}

#### Key Takeaway:
These pages develop the topic consecutively across pages ${minPage} through ${maxPage}. Would you like a detailed breakdown of any specific page in this range?`;
    }
  }

  // 3. Single Slide Question
  if (scope === 'slide') {
    const intent = parseDocumentQueryIntent(prompt, targetedDocs);
    const sNum = intent.targetSlides?.[0] || 1;

    if (format === 'PPTX' && primaryDoc.slides) {
      const slideObj = primaryDoc.slides.find((s) => s.slideNumber === sNum);
      if (!slideObj) {
        return `Slide ${sNum} was not found in **${docName}**.`;
      }

      let answer = `### [Slide ${sNum}] ${slideObj.title || 'Slide ' + sNum} (${docName})\n\n`;
      answer += `**Slide Text Content:**\n`;
      if (slideObj.text) {
        answer += `${formatExcerptIntoBullets(slideObj.text)}\n\n`;
      } else {
        answer += `*[This slide contains graphical elements or no body text]*\n\n`;
      }

      if (slideObj.notes) {
        answer += `> **Speaker Notes:**  \n> ${slideObj.notes}\n\n`;
      }

      return answer.trim();
    }
  }

  // 4. Slide Range Question
  if (scope === 'slide_range') {
    const intent = parseDocumentQueryIntent(prompt, targetedDocs);
    const slides = intent.targetSlides || [];
    const minSlide = Math.min(...slides);
    const maxSlide = Math.max(...slides);

    if (format === 'PPTX' && primaryDoc.slides) {
      const relevantSlides = primaryDoc.slides.filter((s) => slides.includes(s.slideNumber));
      const breakdown = relevantSlides
        .map(
          (s) =>
            `• **Slide ${s.slideNumber}${s.title ? ` (${s.title})` : ''}:** ${
              s.text ? s.text.replace(/\s+/g, ' ').slice(0, 160) + '...' : '[No text / Visual only]'
            }`
        )
        .join('\n');

      return `### Overview of Slides ${minSlide} to ${maxSlide} (${docName})

Covering ${relevantSlides.length} slides from presentation **${docName}**:

#### Slide Sequence:
${breakdown}

You can ask to explore any individual slide or speaker notes in detail (e.g., "Explain slide ${minSlide}").`;
    }
  }

  // 5. Whole File / Summary
  const pageStr = primaryDoc.pageCount ? ` • ${primaryDoc.pageCount} Pages` : '';
  const slideStr = primaryDoc.slideCount ? ` • ${primaryDoc.slideCount} Slides` : '';
  const wordCount = primaryDoc.totalWords || countWordsInString(primaryDoc.text);

  let summaryBody = '';
  if (primaryDoc.sections && primaryDoc.sections.length > 0) {
    const topSections = primaryDoc.sections.slice(0, 6);
    summaryBody = topSections
      .map((s) => `• **${s.heading}:** ${s.content.replace(/\s+/g, ' ').slice(0, 150)}...`)
      .join('\n');
  } else if (primaryDoc.pages && primaryDoc.pages.length > 0) {
    const sampled = primaryDoc.pages.slice(0, 5);
    summaryBody = sampled
      .map((p) => `• **Page ${p.pageNumber}:** ${p.text ? p.text.replace(/\s+/g, ' ').slice(0, 140) + '...' : '[Blank]'}`)
      .join('\n');
  } else if (primaryDoc.slides && primaryDoc.slides.length > 0) {
    const sampled = primaryDoc.slides.slice(0, 5);
    summaryBody = sampled
      .map((s) => `• **Slide ${s.slideNumber}${s.title ? ` (${s.title})` : ''}:** ${s.text ? s.text.replace(/\s+/g, ' ').slice(0, 140) + '...' : '[Visuals]'}`)
      .join('\n');
  } else {
    summaryBody = `> "${primaryDoc.summaryText || primaryDoc.text.slice(0, 300)}..."`;
  }

  return `### Comprehensive Summary of "${docName}"

**Document Details:** ${format} Format • ${primaryDoc.totalCharacters.toLocaleString()} Characters • ~${wordCount.toLocaleString()} Words${pageStr}${slideStr}

#### Executive Summary:
${summaryBody}

---
💡 **Next Steps:** You can ask specific questions about this document, such as:
${primaryDoc.pageCount ? `• *"Explain page 1"* or *"Summarize pages 1 to 3"*\n` : ''}${primaryDoc.slideCount ? `• *"Explain slide 2"* or *"What are the speaker notes on slide 3?"*\n` : ''}• *"What are the key conclusions?"*
• *"Explain this whole file in simple terms"*`;
}

function countWordsInString(str) {
  if (!str) return 0;
  const matches = str.trim().match(/\S+/g);
  return matches ? matches.length : 0;
}

function formatExcerptIntoBullets(text) {
  if (!text) return '• No text content.';
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length <= 4) {
    return lines.map((l) => `• ${l}`).join('\n');
  }

  return lines.slice(0, 6).map((l) => `• ${l}`).join('\n');
}

/* ==========================================================================
   Shared Provider-Independent Context Adaptation Layer
   Adapts prepared document context to each provider's context limits,
   message schema, and prompt conventions without silent truncation.
   ========================================================================== */

export const PROVIDER_PROFILES = {
  gemini: {
    id: 'gemini',
    name: 'Google Gemini',
    modelTag: 'gemini-3.8-flash',
    maxDocChars: 120_000, // Massive 1M token context window
    supportsSystemInstruction: true,
    messageFormat: 'gemini',
    notes: 'Handles massive contexts, ideal for whole-document analysis'
  },
  groq: {
    id: 'groq',
    name: 'Groq',
    modelTag: 'openai/gpt-oss-120b',
    maxDocChars: 24_000, // Safe limit within 8k-16k token context window
    supportsSystemInstruction: true,
    messageFormat: 'openai',
    notes: 'Ultra-fast inference with bounded 8k-16k token context window'
  },
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    modelTag: 'openrouter/free',
    maxDocChars: 16_000, // Safe limit for free multi-model tier
    supportsSystemInstruction: true,
    messageFormat: 'openai',
    notes: 'Free multi-model gateway with conservative context boundaries'
  },
  cloudflare: {
    id: 'cloudflare',
    name: 'Cloudflare Workers AI',
    modelTag: '@cf/meta/llama-3.1-8b-instruct',
    maxDocChars: 16_000, // Safe limit within 8k token context window
    supportsSystemInstruction: true,
    messageFormat: 'cloudflare',
    notes: 'Serverless Llama 3.1 8B inference with 8k token context window'
  }
};

/**
 * Adapts document context to the selected AI provider's context limits,
 * message formatting schema, and grounding instructions.
 * @param {Object} params
 * @param {string} params.provider
 * @param {string} params.prompt
 * @param {string} [params.baseSystemInstruction='']
 * @param {Object} params.preparedContext
 * @param {number} [params.maxCharsOverride]
 * @returns {any}
 */
export function adaptDocumentContextForProvider({
  provider,
  prompt,
  baseSystemInstruction = '',
  preparedContext,
  maxCharsOverride
}) {
  const normProvider = (provider || 'gemini').toLowerCase();
  const profile =
    PROVIDER_PROFILES[normProvider] ||
    PROVIDER_PROFILES.gemini;

  const charBudget = maxCharsOverride || profile.maxDocChars;

  // Case 1: No documents attached or empty context -> ordinary text-only interaction
  if (!preparedContext || !preparedContext.formattedContext) {
    return {
      provider: normProvider,
      providerProfile: profile,
      effectiveSystemInstruction: baseSystemInstruction,
      effectivePrompt: prompt,
      formattedDocContext: '',
      isBoundedForProvider: false,
      providerLimitChars: charBudget
    };
  }

  let finalDocContext = preparedContext.formattedContext;
  let isBoundedForProvider = false;
  let providerNotice = undefined;

  // Case 2: Document context exceeds provider's context budget
  if (finalDocContext.length > charBudget) {
    isBoundedForProvider = true;
    providerNotice =
      `[Context Notice for ${profile.name}]: The attached document context (${finalDocContext.length.toLocaleString()} characters) ` +
      `exceeds ${profile.name}'s context budget (~${Math.round(charBudget / 4).toLocaleString()} tokens). ` +
      `To prevent context length errors or silent truncation, the content has been bounded to an executive outline, structural table of contents, and prioritized sections. ` +
      `For unrestricted whole-file processing, you may switch to Google Gemini (1M token context) or query specific pages/slides (e.g., 'Explain page 5' or 'Explain slide 4').`;

    // Construct bounded text prioritizing outline + targeted excerpts
    const headPortion = finalDocContext.slice(0, Math.floor(charBudget * 0.75));
    const tailSummary = `\n\n[... Additional sections bounded for ${profile.name} context window. Query specific pages, slides, or switch to Gemini for full text ...]`;
    finalDocContext = `${providerNotice}\n\n${headPortion}${tailSummary}`;
  }

  // Build provider-tailored system instructions
  const groundingInstructions = `

[ATTACHED DOCUMENT CONTEXT]
The user has attached the following extracted document content for this conversation:
${finalDocContext}

INSTRUCTIONS FOR DOCUMENT-BASED ANSWERS:
1. Ground your response directly in the provided document content above.
2. If the user asked about specific page(s) (e.g., "Explain page 5", "pages 3 to 7") or slide(s) (e.g., "slide 4"), focus on the requested pages/slides and explicitly cite the page/slide numbers in your answer.
3. If the document format lacks physical page numbers (Word .docx, Markdown, plain text), note the pagination limitation and answer using the provided section headings and content.
4. When multiple files are attached, clearly distinguish between the files and cite each filename.
5. Never invent or extrapolate facts not present in the document.
6. If the document context was noted as bounded due to provider context limits, summarize the provided outline and sections accurately without claiming to have analyzed sections that were not included.`;

  const effectiveSystemInstruction = baseSystemInstruction
    ? `${baseSystemInstruction}${groundingInstructions}`
    : groundingInstructions.trim();

  const effectivePrompt = `[Document Context Attached]\nUser Question: ${prompt}`;

  return {
    provider: normProvider,
    providerProfile: profile,
    effectiveSystemInstruction,
    effectivePrompt,
    formattedDocContext: finalDocContext,
    isBoundedForProvider,
    providerLimitChars: charBudget,
    providerNotice
  };
}

/**
 * Formats conversation history and system instructions into standard OpenAI-compatible messages array.
 * Reusable across Groq, OpenRouter, and Cloudflare Workers AI.
 * @param {Object} params
 * @param {string} [params.systemInstruction]
 * @param {Array} [params.history=[]]
 * @param {string} params.prompt
 * @param {number} [params.maxContextMessages=12]
 * @returns {Array<{ role: string, content: string }>}
 */
export function formatOpenAIMessages({
  systemInstruction,
  history = [],
  prompt,
  maxContextMessages = 12
}) {
  const messages = [];

  if (systemInstruction && systemInstruction.trim()) {
    messages.push({
      role: 'system',
      content: systemInstruction.trim()
    });
  }

  const recent = Array.isArray(history) ? history.slice(-maxContextMessages) : [];
  for (const msg of recent) {
    if (!msg?.content || !msg.content.trim()) continue;
    messages.push({
      role: msg.sender === 'user' ? 'user' : 'assistant',
      content: msg.content.trim()
    });
  }

  if (prompt && prompt.trim()) {
    messages.push({
      role: 'user',
      content: prompt.trim()
    });
  }

  return messages;
}
