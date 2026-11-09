/**
 * Orvix Client-Side Semantic Retrieval (RAG) Service
 * Coordinates document chunking, lightweight vector embedding, IndexedDB storage,
 * and cosine-similarity top-k semantic search across single and multiple documents.
 */

import { chunkDocument } from './semanticChunkingService.js';
import {
  generateSemanticEmbedding,
  generateChunkEmbeddingsAsync,
  computeCosineSimilarity
} from './semanticEmbeddingService.js';
import {
  storeDocumentChunks,
  getChunksForDocuments,
  getChunksForConversation,
  getAllIndexedChunks,
  deleteChunksForDocument,
  deleteChunksForDocuments,
  deleteChunksForConversation
} from './semanticVectorStorage.js';

const DEFAULT_TOP_K = 5;
const DEFAULT_MIN_SIMILARITY = 0.15; // Minimum cosine similarity for semantic relevance

/**
 * Indexes a single extracted document into the vector store.
 * Chunks the document according to its format (pages/slides/sections/windows),
 * generates unit-normalized embeddings, and stores them in IndexedDB.
 *
 * @param {Object} doc - Document object from documentExtractor / browserDocumentExtractor
 * @param {string} [conversationId] - Associated conversation ID
 * @param {Object} [options]
 * @param {boolean} [options.replaceExisting=true] - Delete prior chunks for this doc first
 * @param {(progress: number) => void} [options.onProgress]
 * @returns {Promise<{ docId: string, chunkCount: number, success: boolean }>}
 */
export async function indexDocument(doc, conversationId = null, options = {}) {
  if (!doc) return { docId: null, chunkCount: 0, success: false };

  const docId = doc.id || doc.fileId;
  if (!docId) return { docId: null, chunkCount: 0, success: false };

  // If document was an unreadable image or error, skip indexing
  if (doc.status === 'error' || doc.status === 'NO_TEXT_DETECTED' || doc.status === 'empty') {
    return { docId, chunkCount: 0, success: false };
  }

  try {
    if (options.replaceExisting !== false) {
      await deleteChunksForDocument(docId);
    }

    const rawChunks = chunkDocument(doc, { conversationId });
    if (rawChunks.length === 0) {
      return { docId, chunkCount: 0, success: true };
    }

    const enrichedChunks = await generateChunkEmbeddingsAsync(rawChunks, {
      batchSize: options.batchSize || 16,
      onProgress: options.onProgress
    });

    const stored = await storeDocumentChunks(docId, enrichedChunks, conversationId);
    return {
      docId,
      chunkCount: enrichedChunks.length,
      success: stored
    };
  } catch (err) {
    console.warn(`[Semantic RAG] Failed to index document ${docId}:`, err);
    return { docId, chunkCount: 0, success: false };
  }
}

/**
 * Indexes multiple documents in batch.
 *
 * @param {Array<Object>} docs
 * @param {string} [conversationId]
 * @param {Object} [options]
 * @returns {Promise<Array<{ docId: string, chunkCount: number, success: boolean }>>}
 */
export async function indexDocuments(docs = [], conversationId = null, options = {}) {
  if (!Array.isArray(docs) || docs.length === 0) return [];
  const results = [];
  for (const doc of docs) {
    const res = await indexDocument(doc, conversationId, options);
    results.push(res);
  }
  return results;
}

/**
 * Searches the vector index using cosine similarity for the most relevant chunks.
 * Supports cross-document search, filtering by document IDs or conversation ID,
 * and multi-document attribution.
 *
 * @param {Object} params
 * @param {string} params.query - User question or query text
 * @param {Array<string>} [params.docIds] - Target document IDs to search within
 * @param {string} [params.conversationId] - Target conversation ID to search within
 * @param {Array<Object>} [params.inMemoryDocs] - Fallback documents to index on-the-fly if not in store
 * @param {number} [params.topK=5] - Maximum number of top chunks to return
 * @param {number} [params.minScore=0.15] - Minimum cosine similarity threshold
 * @param {boolean} [params.ensureMultiDocDiversity=true] - Balance top chunks across multiple docs
 * @returns {Promise<Array<{
 *   chunkId: string,
 *   docId: string,
 *   docName: string,
 *   format: string,
 *   score: number,
 *   text: string,
 *   pageNumber?: number,
 *   slideNumber?: number,
 *   slideTitle?: string,
 *   sectionHeading?: string,
 *   sourceType: string
 * }>>}
 */
export async function searchSemanticChunks({
  query,
  docIds = [],
  conversationId = null,
  inMemoryDocs = [],
  topK = DEFAULT_TOP_K,
  minScore = DEFAULT_MIN_SIMILARITY,
  ensureMultiDocDiversity = true
}) {
  if (!query || typeof query !== 'string' || !query.trim()) {
    return [];
  }

  // 1. Generate unit-normalized query vector
  const queryEmbedding = generateSemanticEmbedding(query);

  // 2. Load candidate chunks from vector storage
  let candidateChunks = [];
  const targetDocIds = Array.isArray(docIds) ? docIds.filter(Boolean) : [];

  if (targetDocIds.length > 0) {
    candidateChunks = await getChunksForDocuments(targetDocIds);
  } else if (conversationId) {
    candidateChunks = await getChunksForConversation(conversationId);
  } else {
    candidateChunks = await getAllIndexedChunks();
  }

  // If candidate chunks are missing but inMemoryDocs are provided, index them on-the-fly
  if (candidateChunks.length === 0 && Array.isArray(inMemoryDocs) && inMemoryDocs.length > 0) {
    for (const doc of inMemoryDocs) {
      const docId = doc.id || doc.fileId;
      if (!docId) continue;
      const chunks = chunkDocument(doc, { conversationId });
      const enriched = await generateChunkEmbeddingsAsync(chunks);
      await storeDocumentChunks(docId, enriched, conversationId);
      candidateChunks.push(...enriched);
    }
  }

  if (candidateChunks.length === 0) {
    return [];
  }

  // 3. Compute cosine similarity for each chunk
  const scored = [];
  for (let i = 0; i < candidateChunks.length; i++) {
    const chunk = candidateChunks[i];
    if (!chunk.embedding || !chunk.text) continue;

    const sim = computeCosineSimilarity(queryEmbedding, chunk.embedding);
    if (sim >= minScore) {
      scored.push({
        chunkId: chunk.id,
        docId: chunk.docId,
        docName: chunk.docName || 'Document',
        format: chunk.format || 'FILE',
        score: Math.round(sim * 1000) / 1000,
        text: chunk.text,
        pageNumber: chunk.pageNumber || null,
        slideNumber: chunk.slideNumber || null,
        slideTitle: chunk.slideTitle || null,
        sectionHeading: chunk.sectionHeading || null,
        sourceType: chunk.sourceType || 'text',
        chunkIndex: chunk.chunkIndex
      });
    }
  }

  // 4. Sort descending by similarity score
  scored.sort((a, b) => b.score - a.score);

  // 5. Cross-document diversity handling (if multiple docs searched)
  if (ensureMultiDocDiversity && targetDocIds.length > 1 && scored.length > topK) {
    const selected = [];
    const docCounts = new Map();
    const maxPerDoc = Math.max(2, Math.ceil(topK / targetDocIds.length));

    // First pass: select highest scores while respecting maxPerDoc
    for (const item of scored) {
      const currentCount = docCounts.get(item.docId) || 0;
      if (currentCount < maxPerDoc) {
        selected.push(item);
        docCounts.set(item.docId, currentCount + 1);
        if (selected.length >= topK) break;
      }
    }

    // If we didn't fill topK, fill with next best remaining
    if (selected.length < topK) {
      const selectedIds = new Set(selected.map((s) => s.chunkId));
      for (const item of scored) {
        if (!selectedIds.has(item.chunkId)) {
          selected.push(item);
          if (selected.length >= topK) break;
        }
      }
    }

    return selected.slice(0, topK);
  }

  return scored.slice(0, topK);
}

/**
 * Formats retrieved semantic chunks into an attribution-clear context block.
 *
 * @param {Array<Object>} semanticResults
 * @param {string} query
 * @returns {string} Formatted context snippet
 */
export function formatSemanticResultsForContext(semanticResults = [], query = '') {
  if (!Array.isArray(semanticResults) || semanticResults.length === 0) {
    return '';
  }

  const lines = [
    `=== RELEVANT SEMANTIC DOCUMENT EXCERPTS (Retrieved for: "${query}") ===`,
    `Notice: The following high-priority passages were semantically retrieved from the attached document(s) based on direct conceptual and factual relevance to the user's question:\n`
  ];

  for (let i = 0; i < semanticResults.length; i++) {
    const item = semanticResults[i];
    const scorePct = Math.round(item.score * 100);

    let locationTag = '';
    if (item.pageNumber) locationTag = ` | Page ${item.pageNumber}`;
    else if (item.slideNumber) locationTag = ` | Slide ${item.slideNumber}${item.slideTitle ? `: "${item.slideTitle}"` : ''}`;
    else if (item.sectionHeading) locationTag = ` | Section: "${item.sectionHeading}"`;

    lines.push(
      `--- [Excerpt ${i + 1} of ${semanticResults.length}] Source: "${item.docName}" (${item.format}${locationTag}) | Relevance: ${scorePct}% ---`,
      item.text.trim(),
      ''
    );
  }

  lines.push('=== END OF RELEVANT SEMANTIC EXCERPTS ===');
  return lines.join('\n');
}

export {
  deleteChunksForDocument,
  deleteChunksForDocuments,
  deleteChunksForConversation
};
