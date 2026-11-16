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

const NON_INDEXABLE_STATUSES = new Set([
  'error',
  'corrupted',
  'encrypted',
  'unsupported_format',
  'unsupported_offline',
  'unsupported_rendering',
  'ocr_failed',
  'scanned_or_image_only',
  'NO_TEXT_DETECTED',
  'empty'
]);

// Per-(user, conversation, doc) serialization queues and active in-flight tracking
const docLockTails = new Map();
const activeIndexingEntries = new Set();

function normalizeScopeId(val) {
  return typeof val === 'string' && val.trim() ? val.trim() : null;
}

function normalizeDocumentForIndexing(rawDoc) {
  if (!rawDoc || typeof rawDoc !== 'object') return null;
  if (rawDoc.extraction && typeof rawDoc.extraction === 'object') {
    const ext = rawDoc.extraction;
    return {
      ...ext,
      id: rawDoc.id || rawDoc.fileId || ext.id || ext.fileId,
      fileId: rawDoc.fileId || rawDoc.id || ext.fileId || ext.id,
      originalName: rawDoc.originalName || rawDoc.name || rawDoc.filename || ext.originalName || ext.name || ext.filename,
      name: rawDoc.name || rawDoc.originalName || ext.name || ext.originalName,
      format: ext.format || rawDoc.format || rawDoc.extension,
      status: ext.status || rawDoc.status,
      success: ext.success !== undefined ? ext.success : rawDoc.success,
      conversationId: rawDoc.conversationId || rawDoc.chatId || ext.conversationId || ext.chatId || null,
      chatId: rawDoc.chatId || rawDoc.conversationId || ext.chatId || ext.conversationId || null,
      userId: rawDoc.userId !== undefined ? rawDoc.userId : ext.userId
    };
  }
  return rawDoc;
}

/**
 * Checks whether a document has a valid ID, did not fail extraction,
 * and contains non-empty indexable text, pages, slides, or sections.
 *
 * @param {Object} rawDoc
 * @returns {boolean}
 */
export function isDocumentIndexable(rawDoc) {
  const doc = normalizeDocumentForIndexing(rawDoc);
  if (!doc || typeof doc !== 'object') return false;

  const docId = doc.id || doc.fileId;
  if (!docId || typeof docId !== 'string' || !docId.trim()) return false;
  if (doc.success === false) return false;
  if (doc.status && NON_INDEXABLE_STATUSES.has(doc.status)) return false;

  const hasPages =
    Array.isArray(doc.pages) &&
    doc.pages.some((p) => typeof p?.text === 'string' && p.text.trim().length > 0);
  const hasSlides =
    Array.isArray(doc.slides) &&
    doc.slides.some(
      (s) =>
        (typeof s?.text === 'string' && s.text.trim().length > 0) ||
        (typeof s?.notes === 'string' && s.notes.trim().length > 0) ||
        (typeof s?.title === 'string' && s.title.trim().length > 0)
    );
  const hasSections =
    Array.isArray(doc.sections) &&
    doc.sections.some(
      (sec) =>
        (typeof sec?.content === 'string' && sec.content.trim().length > 0) ||
        (typeof sec?.heading === 'string' && sec.heading.trim().length > 0)
    );
  const rawText = doc.text || doc.extractedText || doc.content || '';
  const hasRawText = typeof rawText === 'string' && rawText.trim().length > 0;

  return hasPages || hasSlides || hasSections || hasRawText;
}

function computeDocContentHash(doc) {
  const parts = [
    doc.originalName || doc.filename || doc.name || '',
    (doc.format || '').toUpperCase()
  ];
  if (Array.isArray(doc.pages) && doc.pages.length > 0) {
    for (const p of doc.pages) parts.push(`p${p.pageNumber || ''}:${p.text || ''}`);
  } else if (Array.isArray(doc.slides) && doc.slides.length > 0) {
    for (const s of doc.slides) parts.push(`s${s.slideNumber || ''}:${s.title || ''}|${s.text || ''}|${s.notes || ''}`);
  } else if (Array.isArray(doc.sections) && doc.sections.length > 0) {
    for (const sec of doc.sections) parts.push(`sec:${sec.heading || ''}|${sec.content || ''}`);
  } else {
    parts.push(doc.text || doc.extractedText || doc.content || '');
  }

  const serialized = parts.join('\n');
  let hash = 0x811c9dc5;
  for (let i = 0; i < serialized.length; i++) {
    hash ^= serialized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${(hash >>> 0).toString(16)}_${serialized.length}`;
}

function isValidStoredChunk(chunk) {
  if (!chunk || typeof chunk !== 'object') return false;
  if (typeof chunk.text !== 'string' || !chunk.text.trim()) return false;
  if (!chunk.embedding || typeof chunk.embedding.length !== 'number' || chunk.embedding.length === 0) {
    return false;
  }
  return true;
}

function areChunksCompleteForDoc(existingChunks, doc, expectedHash = null) {
  if (!Array.isArray(existingChunks) || existingChunks.length === 0) return false;
  for (const chunk of existingChunks) {
    if (!isValidStoredChunk(chunk)) return false;
  }
  const first = existingChunks[0];
  if (typeof first.expectedChunkCount === 'number' && existingChunks.length < first.expectedChunkCount) {
    return false;
  }
  if (expectedHash && first.contentHash && first.contentHash !== expectedHash) {
    return false;
  }
  return true;
}

function withDocLock(lockKey, taskFn) {
  const prev = docLockTails.get(lockKey) || Promise.resolve();
  const run = prev.catch(() => {}).then(taskFn);
  const settledTail = run.then(
    () => {
      if (docLockTails.get(lockKey) === settledTail) {
        docLockTails.delete(lockKey);
      }
    },
    () => {
      if (docLockTails.get(lockKey) === settledTail) {
        docLockTails.delete(lockKey);
      }
    }
  );
  docLockTails.set(lockKey, settledTail);
  return run;
}

async function waitForPendingIndexing({ docIds = [], conversationId = null }) {
  if (activeIndexingEntries.size === 0) return;
  const docIdSet = new Set(docIds.filter(Boolean));
  const pending = [];

  for (const entry of activeIndexingEntries) {
    const matchesDoc = entry.docId && docIdSet.has(entry.docId);
    const matchesConv = conversationId && entry.conversationId === conversationId;
    if (matchesDoc || matchesConv || (!conversationId && docIdSet.size === 0)) {
      pending.push(entry.promise);
    }
  }

  if (pending.length > 0) {
    await Promise.allSettled(pending);
  }
}

/**
 * Indexes a single extracted document into the vector store.
 * Chunks the document according to its format (pages/slides/sections/windows),
 * generates unit-normalized embeddings, and stores them in IndexedDB.
 *
 * @param {Object} rawDoc - Document object from documentExtractor / browserDocumentExtractor
 * @param {string} [conversationId] - Associated conversation ID
 * @param {Object} [options]
 * @param {boolean} [options.replaceExisting=true] - Delete prior chunks for this doc first
 * @param {boolean} [options.forceReindex=false] - Force re-indexing even if unchanged
 * @param {string|null} [options.userId] - Optional owner user ID for isolation
 * @param {(progress: number) => void} [options.onProgress]
 * @returns {Promise<{ docId: string|null, chunkCount: number, success: boolean }>}
 */
export async function indexDocument(rawDoc, conversationId = null, options = {}) {
  const doc = normalizeDocumentForIndexing(rawDoc);
  if (!doc) return { docId: null, chunkCount: 0, success: false };

  const docId = doc.id || doc.fileId || null;
  if (!docId || !isDocumentIndexable(doc)) {
    return { docId, chunkCount: 0, success: false };
  }

  const effectiveConversationId = normalizeScopeId(conversationId || doc.conversationId || doc.chatId);
  const explicitUserId =
    options?.userId !== undefined
      ? options.userId === null
        ? null
        : normalizeScopeId(options.userId)
      : doc.userId !== undefined
      ? doc.userId === null
        ? null
        : normalizeScopeId(doc.userId)
      : undefined;
  const lockKey = `${explicitUserId || ''}::${effectiveConversationId || ''}::${docId}`;

  const taskPromise = withDocLock(lockKey, async () => {
    try {
      const contentHash = computeDocContentHash(doc);
      const readScope = {
        conversationId: effectiveConversationId,
        ...(explicitUserId !== undefined ? { userId: explicitUserId } : {})
      };

      if (options.forceReindex !== true) {
        const existing = await getChunksForDocuments([docId], readScope);
        if (areChunksCompleteForDoc(existing, doc, contentHash)) {
          return {
            docId,
            chunkCount: existing.length,
            success: true
          };
        }
      }

      const storedUserId = explicitUserId !== undefined ? explicitUserId : null;
      const rawChunks = chunkDocument(doc, {
        conversationId: effectiveConversationId,
        userId: storedUserId
      });
      if (rawChunks.length === 0) {
        return { docId, chunkCount: 0, success: false };
      }

      const enrichedRaw = await generateChunkEmbeddingsAsync(rawChunks, {
        batchSize: options.batchSize || 16,
        onProgress: options.onProgress
      });
      const expectedChunkCount = enrichedRaw.length;
      const enrichedChunks = enrichedRaw.map((c) => ({
        ...c,
        expectedChunkCount,
        contentHash,
        userId: storedUserId
      }));

      if (options.replaceExisting !== false) {
        const deleteScope = {
          ...(effectiveConversationId ? { conversationId: effectiveConversationId } : {}),
          ...(explicitUserId !== undefined ? { userId: explicitUserId } : {})
        };
        await deleteChunksForDocument(docId, deleteScope);
      }

      const stored = await storeDocumentChunks(docId, enrichedChunks, effectiveConversationId, {
        userId: storedUserId,
        contentHash
      });

      return {
        docId,
        chunkCount: stored ? enrichedChunks.length : 0,
        success: stored
      };
    } catch (err) {
      console.warn(`[Semantic RAG] Failed to index document ${docId}:`, err);
      return { docId, chunkCount: 0, success: false };
    }
  });

  const entry = {
    docId,
    conversationId: effectiveConversationId,
    userId: explicitUserId,
    promise: taskPromise
  };
  activeIndexingEntries.add(entry);
  taskPromise.finally(() => {
    activeIndexingEntries.delete(entry);
  });

  return taskPromise;
}

/**
 * Indexes multiple documents in batch.
 *
 * @param {Array<Object>} docs
 * @param {string} [conversationId]
 * @param {Object} [options]
 * @returns {Promise<Array<{ docId: string|null, chunkCount: number, success: boolean }>>}
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
 * @param {string|null} [params.userId] - Optional user ID for strict cross-user isolation
 * @param {Array<Object>} [params.inMemoryDocs] - Fallback documents to index on-the-fly if missing/partial in store
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
  userId = undefined,
  inMemoryDocs = [],
  topK = DEFAULT_TOP_K,
  minScore = DEFAULT_MIN_SIMILARITY,
  ensureMultiDocDiversity = true
}) {
  if (!query || typeof query !== 'string' || !query.trim()) {
    return [];
  }

  const targetDocIds = Array.isArray(docIds) ? Array.from(new Set(docIds.filter(Boolean))) : [];
  const normalizedConversationId = normalizeScopeId(conversationId);
  const normalizedUserId =
    userId === undefined ? undefined : userId === null ? null : normalizeScopeId(userId);

  // Prepare eligible, isolated in-memory documents
  const eligibleInMemoryDocs = [];
  const seenMemoryDocIds = new Set();
  if (Array.isArray(inMemoryDocs) && inMemoryDocs.length > 0) {
    for (const rawDoc of inMemoryDocs) {
      const doc = normalizeDocumentForIndexing(rawDoc);
      if (!doc) continue;
      const docId = doc.id || doc.fileId;
      if (!docId || seenMemoryDocIds.has(docId)) continue;
      if (targetDocIds.length > 0 && !targetDocIds.includes(docId)) continue;

      const docConvId = normalizeScopeId(doc.conversationId || doc.chatId);
      if (normalizedConversationId && docConvId && docConvId !== normalizedConversationId) {
        continue;
      }

      const docUserId =
        doc.userId !== undefined ? (doc.userId === null ? null : normalizeScopeId(doc.userId)) : undefined;
      if (normalizedUserId !== undefined && docUserId !== undefined) {
        if ((normalizedUserId || null) !== (docUserId || null)) {
          continue;
        }
      }

      if (!isDocumentIndexable(doc)) continue;

      seenMemoryDocIds.add(docId);
      eligibleInMemoryDocs.push(doc);
    }
  }

  // Wait for any in-flight indexing affecting these docs or this conversation
  await waitForPendingIndexing({
    docIds: [...targetDocIds, ...eligibleInMemoryDocs.map((d) => d.id || d.fileId)],
    conversationId: normalizedConversationId
  });

  // 1. Generate unit-normalized query vector
  const queryEmbedding = generateSemanticEmbedding(query);

  // 2. Load candidate chunks from vector storage within strict chat/user isolation
  const storageScope = {
    ...(normalizedConversationId ? { conversationId: normalizedConversationId } : {}),
    ...(normalizedUserId !== undefined ? { userId: normalizedUserId } : {})
  };

  let candidateChunks = [];
  if (targetDocIds.length > 0) {
    candidateChunks = await getChunksForDocuments(targetDocIds, storageScope);
  } else if (normalizedConversationId) {
    candidateChunks = await getChunksForConversation(normalizedConversationId, storageScope);
  } else {
    candidateChunks = await getAllIndexedChunks(storageScope);
  }

  // Group currently stored chunks by docId so we only index missing or partially indexed inMemoryDocs
  const chunksByDocId = new Map();
  for (const chunk of candidateChunks) {
    if (!chunk?.docId) continue;
    if (!chunksByDocId.has(chunk.docId)) {
      chunksByDocId.set(chunk.docId, []);
    }
    chunksByDocId.get(chunk.docId).push(chunk);
  }

  if (eligibleInMemoryDocs.length > 0) {
    const docsToIndex = [];
    for (const doc of eligibleInMemoryDocs) {
      const docId = doc.id || doc.fileId;
      const existingDocChunks = chunksByDocId.get(docId) || [];
      const expectedHash = computeDocContentHash(doc);
      if (!areChunksCompleteForDoc(existingDocChunks, doc, expectedHash)) {
        docsToIndex.push(doc);
      }
    }

    if (docsToIndex.length > 0) {
      const indexResults = await Promise.allSettled(
        docsToIndex.map((doc) => {
          const docConvId = normalizedConversationId || normalizeScopeId(doc.conversationId || doc.chatId);
          const docUserId =
            normalizedUserId !== undefined
              ? normalizedUserId
              : doc.userId !== undefined
              ? doc.userId
              : undefined;
          return indexDocument(doc, docConvId, {
            replaceExisting: true,
            forceReindex: true,
            ...(docUserId !== undefined ? { userId: docUserId } : {})
          });
        })
      );

      const newlyIndexedDocIds = [];
      for (const settled of indexResults) {
        if (settled.status === 'fulfilled' && settled.value?.success && settled.value.docId) {
          newlyIndexedDocIds.push(settled.value.docId);
        }
      }

      if (newlyIndexedDocIds.length > 0) {
        const refreshedSet = new Set(newlyIndexedDocIds);
        const freshChunks = await getChunksForDocuments(newlyIndexedDocIds, storageScope);
        candidateChunks = candidateChunks.filter((c) => !c?.docId || !refreshedSet.has(c.docId));
        candidateChunks.push(...freshChunks);
      }
    }
  }

  if (candidateChunks.length === 0) {
    return [];
  }

  // Deduplicate chunks cleanly by chunk ID and (docName, chunkIndex, text)
  const seenChunkIds = new Set();
  const seenContentKeys = new Set();
  const dedupedChunks = [];

  for (const chunk of candidateChunks) {
    if (!isValidStoredChunk(chunk)) continue;
    if (chunk.id) {
      if (seenChunkIds.has(chunk.id)) continue;
      seenChunkIds.add(chunk.id);
    }
    const contentKey = `${chunk.docName || ''}::${chunk.chunkIndex ?? ''}::${chunk.text.trim()}`;
    if (seenContentKeys.has(contentKey)) continue;
    seenContentKeys.add(contentKey);
    dedupedChunks.push(chunk);
  }

  // 3. Compute cosine similarity for each chunk
  const scored = [];
  for (let i = 0; i < dedupedChunks.length; i++) {
    const chunk = dedupedChunks[i];
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

  // 5. Cross-document diversity handling (if multiple docs matched)
  const distinctScoredDocIds = new Set(scored.map((s) => s.docId).filter(Boolean));
  if (ensureMultiDocDiversity && distinctScoredDocIds.size > 1 && scored.length > topK) {
    const selected = [];
    const selectedIds = new Set();
    const docCounts = new Map();
    const diversityDocCount = Math.max(targetDocIds.length, distinctScoredDocIds.size);
    const maxPerDoc = Math.max(2, Math.ceil(topK / diversityDocCount));

    // Pass 1: Guarantee highest-scoring chunk per distinct matching document (up to topK)
    for (const item of scored) {
      if (!docCounts.has(item.docId)) {
        selected.push(item);
        selectedIds.add(item.chunkId);
        docCounts.set(item.docId, 1);
        if (selected.length >= topK) break;
      }
    }

    // Pass 2: Select additional highest scores while respecting maxPerDoc
    if (selected.length < topK) {
      for (const item of scored) {
        if (selectedIds.has(item.chunkId)) continue;
        const currentCount = docCounts.get(item.docId) || 0;
        if (currentCount < maxPerDoc) {
          selected.push(item);
          selectedIds.add(item.chunkId);
          docCounts.set(item.docId, currentCount + 1);
          if (selected.length >= topK) break;
        }
      }
    }

    // Pass 3: If we still haven't filled topK, fill with next best remaining
    if (selected.length < topK) {
      for (const item of scored) {
        if (!selectedIds.has(item.chunkId)) {
          selected.push(item);
          selectedIds.add(item.chunkId);
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
