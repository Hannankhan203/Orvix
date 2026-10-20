/**
 * Orvix Document Context & Relevance Retrieval Utility
 * Formats attached documents for AI requests across Gemini, Groq, and OpenRouter.
 * Implements chunking and relevance retrieval for long documents, preserving page/slide citations.
 */

// Safe character budget for document context across providers
export const MAX_DOC_CONTEXT_CHARS = 75000;
export const CHUNK_SIZE_CHARS = 1800;

/**
 * Splits text into logical chunks, preserving page/slide headers where present.
 *
 * @param {string} text - Full document text
 * @returns {Array<{ index: number, header: string, content: string }>}
 */
export function chunkDocumentText(text) {
  if (!text) return [];

  // If text has page markers "--- Page X of Y ---", split on page markers
  if (text.includes('--- Page ')) {
    const pageParts = text.split(/(?=--- Page \d+ of \d+ ---)/g);
    return pageParts
      .map((part, idx) => {
        const lines = part.trim().split('\n');
        const header = lines[0] || `Section ${idx + 1}`;
        const content = lines.slice(1).join('\n').trim();
        return { index: idx, header, content: part.trim() };
      })
      .filter((c) => c.content.length > 0);
  }

  // If text has slide markers "--- Slide X of Y ---", split on slide markers
  if (text.includes('--- Slide ')) {
    const slideParts = text.split(/(?=--- Slide \d+ of \d+ ---)/g);
    return slideParts
      .map((part, idx) => {
        const lines = part.trim().split('\n');
        const header = lines[0] || `Slide ${idx + 1}`;
        return { index: idx, header, content: part.trim() };
      })
      .filter((c) => c.content.length > 0);
  }

  // Otherwise split by paragraphs or headings, respecting chunk size
  const paragraphs = text.split(/\n\s*\n/);
  const chunks = [];
  let currentChunk = '';
  let chunkIdx = 0;

  for (const para of paragraphs) {
    if ((currentChunk + '\n\n' + para).length > CHUNK_SIZE_CHARS && currentChunk.length > 0) {
      chunks.push({
        index: chunkIdx++,
        header: `Section ${chunkIdx}`,
        content: currentChunk.trim()
      });
      currentChunk = para;
    } else {
      currentChunk = currentChunk ? `${currentChunk}\n\n${para}` : para;
    }
  }

  if (currentChunk.trim()) {
    chunks.push({
      index: chunkIdx++,
      header: `Section ${chunkIdx}`,
      content: currentChunk.trim()
    });
  }

  return chunks;
}

/**
 * Scores a chunk's relevance to the user's prompt.
 *
 * @param {string} query - The user's query prompt
 * @param {{ header: string, content: string, index: number }} chunk
 * @param {number} totalChunks
 * @returns {number} Score
 */
export function scoreChunkRelevance(query, chunk, totalChunks) {
  const queryLower = (query || '').toLowerCase().trim();
  if (!queryLower) return 1;

  let score = 0;
  const chunkTextLower = chunk.content.toLowerCase();
  const headerLower = chunk.header.toLowerCase();

  // 1. Direct page or slide query matching (e.g. "page 5", "page 12", "slide 3")
  const pageMatch = queryLower.match(/\bpage\s*(\d+)\b/i);
  if (pageMatch) {
    const targetPage = parseInt(pageMatch[1], 10);
    if (headerLower.includes(`page ${targetPage} `) || headerLower.includes(`page ${targetPage}\n`)) {
      score += 100;
    }
  }

  const slideMatch = queryLower.match(/\bslide\s*(\d+)\b/i);
  if (slideMatch) {
    const targetSlide = parseInt(slideMatch[1], 10);
    if (headerLower.includes(`slide ${targetSlide} `) || headerLower.includes(`slide ${targetSlide}\n`)) {
      score += 100;
    }
  }

  // 2. Overview / summary queries favor the beginning and end of documents
  const isSummaryQuery =
    queryLower.includes('summar') ||
    queryLower.includes('overview') ||
    queryLower.includes('main point') ||
    queryLower.includes('what is this') ||
    queryLower.includes('key takeaway') ||
    queryLower.includes('explain this');

  if (isSummaryQuery) {
    if (chunk.index === 0) score += 30; // First page/slide or intro
    if (chunk.index === 1) score += 15;
    if (chunk.index === totalChunks - 1) score += 20; // Conclusion / final page
  }

  // 3. Keyword / term frequency scoring
  const queryTerms = queryLower
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !['the', 'and', 'for', 'with', 'this', 'that', 'what', 'how', 'can', 'you'].includes(w));

  for (const term of queryTerms) {
    // Term in header
    if (headerLower.includes(term)) {
      score += 10;
    }

    // Term occurrences in content
    let idx = 0;
    let count = 0;
    while ((idx = chunkTextLower.indexOf(term, idx)) !== -1) {
      count++;
      idx += term.length;
      if (count >= 5) break;
    }
    score += count * 2;
  }

  return score;
}

/**
 * Builds formatted document context for inclusion in AI requests.
 * Uses full text when within budget, or smart retrieval for large documents.
 *
 * @param {Array<Object>} documents - Array of document objects { name, type, text, size, pageCount, slideCount, rowCount }
 * @param {string} userPrompt - Current query prompt
 * @returns {{ documentContextText: string, totalDocuments: number, isRetrieved: boolean, summaryList: string[] }}
 */
export function buildDocumentContext(documents = [], userPrompt = '') {
  if (!Array.isArray(documents) || documents.length === 0) {
    return {
      documentContextText: '',
      totalDocuments: 0,
      isRetrieved: false,
      summaryList: []
    };
  }

  const validDocs = documents.filter((d) => d && typeof d.text === 'string' && d.text.trim().length > 0);
  if (validDocs.length === 0) {
    return {
      documentContextText: '',
      totalDocuments: 0,
      isRetrieved: false,
      summaryList: []
    };
  }

  const summaryList = validDocs.map((doc) => {
    const metaParts = [];
    if (doc.type) metaParts.push(doc.type.toUpperCase());
    if (doc.pageCount) metaParts.push(`${doc.pageCount} pages`);
    if (doc.slideCount) metaParts.push(`${doc.slideCount} slides`);
    if (doc.rowCount) metaParts.push(`${doc.rowCount} rows`);
    if (doc.wordCount) metaParts.push(`~${doc.wordCount} words`);
    return `• "${doc.name}" (${metaParts.join(', ')})`;
  });

  // Calculate total characters across all attached documents
  const totalChars = validDocs.reduce((acc, d) => acc + d.text.length, 0);

  // If within budget, include full documents directly
  if (totalChars <= MAX_DOC_CONTEXT_CHARS) {
    const docBlocks = validDocs.map((doc) => {
      const headerMeta = [
        doc.type ? `Type: ${doc.type.toUpperCase()}` : '',
        doc.pageCount ? `Pages: ${doc.pageCount}` : '',
        doc.slideCount ? `Slides: ${doc.slideCount}` : '',
        doc.rowCount ? `Rows: ${doc.rowCount}` : ''
      ].filter(Boolean).join(' | ');

      return `=== START OF DOCUMENT: "${doc.name}" ${headerMeta ? `(${headerMeta})` : ''} ===\n${doc.text.trim()}\n=== END OF DOCUMENT: "${doc.name}" ===`;
    });

    const fullContext = `[ATTACHED DOCUMENTS CONTEXT]
The user has attached ${validDocs.length} document${validDocs.length > 1 ? 's' : ''} to this conversation:
${summaryList.join('\n')}

${docBlocks.join('\n\n')}

[DOCUMENT USAGE INSTRUCTIONS]
1. Use the content from the attached document(s) above as your primary evidence to answer questions, explain concepts, extract data, or generate summaries.
2. When citing facts or answering questions, reference the specific document name and page/slide/row number where applicable (e.g. 'According to page 3 of report.pdf...').
3. If multiple documents are attached, clearly distinguish which document you are drawing information from.
4. If the user's question cannot be answered from the provided documents, state clearly: "This information is not found in the uploaded document(s)." Do not fabricate or invent unstated details.`;

    return {
      documentContextText: fullContext,
      totalDocuments: validDocs.length,
      isRetrieved: false,
      summaryList
    };
  }

  // Large document retrieval: budget per document
  const budgetPerDoc = Math.floor(MAX_DOC_CONTEXT_CHARS / validDocs.length);
  const retrievedDocBlocks = [];

  for (const doc of validDocs) {
    if (doc.text.length <= budgetPerDoc) {
      retrievedDocBlocks.push(
        `=== START OF DOCUMENT: "${doc.name}" (Full text, ${doc.wordCount || ''} words) ===\n${doc.text.trim()}\n=== END OF DOCUMENT: "${doc.name}" ===`
      );
      continue;
    }

    const chunks = chunkDocumentText(doc.text);
    const scoredChunks = chunks.map((chunk) => ({
      ...chunk,
      score: scoreChunkRelevance(userPrompt, chunk, chunks.length)
    }));

    // Sort by relevance score descending
    scoredChunks.sort((a, b) => b.score - a.score);

    // Pick top chunks up to budget
    let currentChars = 0;
    const selectedChunks = [];

    // Always include first chunk if not already top
    const firstChunk = scoredChunks.find((c) => c.index === 0);
    if (firstChunk) {
      selectedChunks.push(firstChunk);
      currentChars += firstChunk.content.length;
    }

    for (const sc of scoredChunks) {
      if (selectedChunks.some((s) => s.index === sc.index)) continue;
      if (currentChars + sc.content.length > budgetPerDoc) break;
      selectedChunks.push(sc);
      currentChars += sc.content.length;
    }

    // Re-sort selected chunks chronologically by index for coherent reading order
    selectedChunks.sort((a, b) => a.index - b.index);

    const chunkTexts = selectedChunks.map((c) => c.content).join('\n\n...\n\n');
    retrievedDocBlocks.push(
      `=== START OF DOCUMENT: "${doc.name}" (Retrieved relevant sections matching query) ===\n${chunkTexts}\n=== END OF DOCUMENT: "${doc.name}" ===`
    );
  }

  const retrievedContext = `[ATTACHED DOCUMENTS CONTEXT - RELEVANT EXCERPTS]
The user has attached ${validDocs.length} document${validDocs.length > 1 ? 's' : ''} to this conversation:
${summaryList.join('\n')}

[Notice: Due to the comprehensive size of the document(s), the most relevant sections have been indexed and retrieved for this query.]

${retrievedDocBlocks.join('\n\n')}

[DOCUMENT USAGE INSTRUCTIONS]
1. Use the content from the attached document excerpts above to answer questions and cite evidence accurately.
2. Reference the specific document name and page/slide number where applicable.
3. If the user's question asks for information not found in these excerpts, state clearly that the specific detail was not located in the uploaded material.`;

  return {
    documentContextText: retrievedContext,
    totalDocuments: validDocs.length,
    isRetrieved: true,
    summaryList
  };
}
