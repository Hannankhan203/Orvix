/**
 * Comprehensive Test Suite for Orvix Client-Side Semantic Document Retrieval (RAG)
 * Tests:
 * 1. Intelligent document chunking across PDF pages, PPTX slides, DOCX sections, and raw text
 * 2. Overlap calculation and chunk metadata preservation
 * 3. Lightweight client-side embedding generation (dimension, determinism, L2 normalization)
 * 4. Cosine similarity calculations and semantic relevance ranking
 * 5. IndexedDB vector storage and retrieval (atomic save, query by docId and conversationId)
 * 6. Cross-document semantic search across multiple attached documents
 * 7. Top-k retrieval with relevance thresholds and multi-document attribution
 * 8. Integration with documentContextService.js (semantic RAG vs rule-based fallback)
 * 9. Preservation of existing rule-based structural intents (pages, slides, image OCR)
 * 10. Vector record cleanup on document deletion and conversation deletion
 */

import assert from 'node:assert';
import {
  chunkDocument,
  splitTextIntoSemanticWindows,
  normalizeChunkText
} from '../src/services/semanticChunkingService.js';
import {
  generateSemanticEmbedding,
  computeCosineSimilarity,
  generateChunkEmbeddingsAsync,
  stemToken,
  extractWeightedFeatures,
  EMBEDDING_DIMENSION
} from '../src/services/semanticEmbeddingService.js';
import {
  getConceptVocabularySize,
  getConceptClusterCount
} from '../src/services/semanticConceptModel.js';
import {
  storeDocumentChunks,
  getChunksForDocuments,
  getChunksForConversation,
  getAllIndexedChunks,
  deleteChunksForDocument,
  deleteChunksForDocuments,
  deleteChunksForConversation,
  clearAllChunks,
  getVectorStoreStats,
  resetVectorDBForTesting
} from '../src/services/semanticVectorStorage.js';
import {
  indexDocument,
  indexDocuments,
  searchSemanticChunks,
  formatSemanticResultsForContext
} from '../src/services/semanticRetrievalService.js';
import {
  prepareDocumentContext,
  retrieveSemanticDocumentContext
} from '../src/services/documentContextService.js';
import {
  deleteAttachmentRecord,
  deleteAttachmentRecords,
  deleteAttachmentsForConversation
} from '../src/services/attachmentStorageService.js';

let passedTests = 0;
let failedTests = 0;

function runTest(testName, fn) {
  try {
    fn();
    console.log(`  ✓ PASS: ${testName}`);
    passedTests++;
  } catch (err) {
    console.error(`  ✗ FAIL: ${testName}`);
    console.error(`    ${err.message}`);
    failedTests++;
  }
}

async function runTestAsync(testName, fn) {
  try {
    await fn();
    console.log(`  ✓ PASS: ${testName}`);
    passedTests++;
  } catch (err) {
    console.error(`  ✗ FAIL: ${testName}`);
    console.error(`    ${err.message}`);
    failedTests++;
  }
}

console.log('======================================================================');
console.log('Orvix Semantic Document Retrieval (RAG) Verification Suite');
console.log('Testing Intelligent Chunking, Embeddings, Vector Storage & Retrieval');
console.log('======================================================================\n');

async function main() {
  resetVectorDBForTesting();

  // --------------------------------------------------------------------------
  // Group 1: Intelligent Document Chunking
  // --------------------------------------------------------------------------
  console.log('--- 1. Intelligent Document Chunking & Metadata ---');

  runTest('1.1 Normalizes chunk text and removes control characters', () => {
    const raw = 'Hello \x00\x08World!\r\n\r\n\r\nThis   is  a\ttest.\n\n\n\nDone.';
    const normalized = normalizeChunkText(raw);
    assert.ok(!normalized.includes('\x00'));
    assert.ok(!normalized.includes('\r'));
    assert.ok(!normalized.includes('   '));
    assert.ok(normalized.includes('Hello World!\n\nThis is a test.\n\nDone.'));
  });

  runTest('1.2 Splits plain text into target-sized windows with overlap', () => {
    const paragraphA = 'Orvix is a lightweight privacy-first AI application designed to run smoothly on client devices.';
    const paragraphB = 'It includes client-side WebLLM support with browser models such as Qwen 2.5 and Llama 3.';
    const paragraphC = 'Document retrieval uses local vector indexing without requiring multi-gigabyte server downloads.';
    const fullText = `${paragraphA}\n\n${paragraphB}\n\n${paragraphC}`;

    const windows = splitTextIntoSemanticWindows(fullText, { targetSize: 120, overlap: 30 });
    assert.ok(windows.length >= 2, `Expected at least 2 windows, got ${windows.length}`);
    for (const win of windows) {
      assert.ok(win.text.length > 0);
      assert.ok(typeof win.startChar === 'number');
      assert.ok(typeof win.endChar === 'number');
      assert.ok(win.endChar > win.startChar);
    }
  });

  runTest('1.3 PDF chunking preserves page metadata and slide numbers', () => {
    const pdfDoc = {
      id: 'doc_pdf_1',
      originalName: 'quarterly_report.pdf',
      format: 'PDF',
      pageCount: 2,
      pages: [
        {
          pageNumber: 1,
          text: 'Executive Summary: Revenue grew by 24% in Q3 reaching $14.2 million. Growth was led by enterprise cloud services.'
        },
        {
          pageNumber: 2,
          text: 'Operating Expenses and Net Income: Total operating expenses were $8.1 million. Net profit margin expanded to 18%.'
        }
      ]
    };

    const chunks = chunkDocument(pdfDoc, { conversationId: 'chat_123' });
    assert.strictEqual(chunks.length, 2);
    assert.strictEqual(chunks[0].pageNumber, 1);
    assert.strictEqual(chunks[0].sourceType, 'page');
    assert.strictEqual(chunks[0].docName, 'quarterly_report.pdf');
    assert.strictEqual(chunks[1].pageNumber, 2);
    assert.strictEqual(chunks[1].conversationId, 'chat_123');
    assert.ok(chunks[0].id.includes('doc_pdf_1'));
  });

  runTest('1.4 PPTX chunking preserves slide titles and speaker notes', () => {
    const pptxDoc = {
      id: 'doc_pptx_1',
      originalName: 'ai_architecture.pptx',
      format: 'PPTX',
      slideCount: 2,
      slides: [
        {
          slideNumber: 1,
          title: 'Client-Side RAG Overview',
          text: 'Vector embeddings are computed in JavaScript using subword feature hashing.',
          notes: 'Remind team that zero server roundtrips are needed for embedding generation.'
        },
        {
          slideNumber: 2,
          title: 'IndexedDB Storage Engine',
          text: 'Chunks and float vectors are persisted locally in browser IndexedDB.',
          notes: 'Explain storage quota handling and fail-safe fallback.'
        }
      ]
    };

    const chunks = chunkDocument(pptxDoc);
    assert.strictEqual(chunks.length, 2);
    assert.strictEqual(chunks[0].slideNumber, 1);
    assert.strictEqual(chunks[0].slideTitle, 'Client-Side RAG Overview');
    assert.ok(chunks[0].text.includes('Client-Side RAG Overview'));
    assert.ok(chunks[0].text.includes('[Speaker Notes]:') || chunks[0].text.includes('Speaker Notes'));
    assert.strictEqual(chunks[1].slideNumber, 2);
  });

  runTest('1.5 Structured DOCX/Markdown chunking preserves section headings', () => {
    const docx = {
      id: 'doc_docx_1',
      originalName: 'terms_of_service.docx',
      format: 'DOCX',
      sections: [
        { heading: '1. User Privacy & Data Protection', level: 1, content: 'We do not sell user data. All chats are private.' },
        { heading: '2. Refund Policy', level: 1, content: 'Subscriptions may be refunded within 14 days of purchase upon request.' }
      ]
    };

    const chunks = chunkDocument(docx);
    assert.strictEqual(chunks.length, 2);
    assert.strictEqual(chunks[0].sectionHeading, '1. User Privacy & Data Protection');
    assert.strictEqual(chunks[1].sectionHeading, '2. Refund Policy');
    assert.ok(chunks[1].text.includes('Refund Policy'));
  });

  // --------------------------------------------------------------------------
  // Group 2: Lightweight Semantic Embedding & Cosine Similarity
  // --------------------------------------------------------------------------
  console.log('\n--- 2. Lightweight Client-Side Embeddings & Cosine Similarity ---');

  runTest('2.1 Embeddings have exact expected dimension and unit L2 norm', () => {
    const text = 'Artificial Intelligence and machine learning in web applications.';
    const vec = generateSemanticEmbedding(text);

    assert.strictEqual(vec.length, EMBEDDING_DIMENSION);
    assert.ok(vec instanceof Float32Array);

    let sumSq = 0;
    for (let i = 0; i < vec.length; i++) sumSq += vec[i] * vec[i];
    const norm = Math.sqrt(sumSq);
    assert.ok(Math.abs(norm - 1.0) < 1e-4, `Expected unit norm ~1.0, got ${norm}`);
  });

  runTest('2.2 Embedding generation is completely deterministic', () => {
    const text = 'Cloud Firestore atomic quota transactions in Vercel serverless functions.';
    const vec1 = generateSemanticEmbedding(text);
    const vec2 = generateSemanticEmbedding(text);

    for (let i = 0; i < EMBEDDING_DIMENSION; i++) {
      assert.strictEqual(vec1[i], vec2[i]);
    }
  });

  runTest('2.3 Cosine similarity correctly ranks conceptually relevant text higher than irrelevant text', () => {
    const query = 'What is the refund policy and return guarantee?';
    const relevantDoc = 'Refund Policy: Customers are entitled to a full refund within 14 days of purchase.';
    const irrelevantDoc = 'How to configure Webpack and Vite plugins for React TypeScript bundling.';

    const qVec = generateSemanticEmbedding(query);
    const relVec = generateSemanticEmbedding(relevantDoc);
    const irrelVec = generateSemanticEmbedding(irrelevantDoc);

    const relSim = computeCosineSimilarity(qVec, relVec);
    const irrelSim = computeCosineSimilarity(qVec, irrelVec);

    assert.ok(relSim > irrelSim, `Expected relevant similarity (${relSim}) > irrelevant (${irrelSim})`);
    assert.ok(relSim > 0.35, `Expected substantial semantic similarity for relevant match, got ${relSim}`);
    assert.ok(irrelSim < 0.20, `Expected low similarity for irrelevant text, got ${irrelSim}`);
  });

  runTest('2.4 Subword n-grams and stemming normalize morphological variants', () => {
    const wordA = stemToken('investments');
    const wordB = stemToken('investing');
    assert.ok(wordA.startsWith('invest'));
    assert.ok(wordB.startsWith('invest'));

    const features = extractWeightedFeatures('The CEO discussed quarterly revenue projections.');
    const hasRevenueNgram = features.some((f) => f.token.includes('reven'));
    assert.ok(hasRevenueNgram, 'Expected character n-gram feature for subword matching');
  });

  await runTestAsync('2.5 generateChunkEmbeddingsAsync yields and attaches embeddings without blocking', async () => {
    const mockChunks = [
      { id: 'c1', text: 'First chunk of document' },
      { id: 'c2', text: 'Second chunk of document' },
      { id: 'c3', text: 'Third chunk of document' }
    ];

    let progressCalls = 0;
    const enriched = await generateChunkEmbeddingsAsync(mockChunks, {
      batchSize: 2,
      onProgress: () => progressCalls++
    });

    assert.strictEqual(enriched.length, 3);
    assert.ok(Array.isArray(enriched[0].embedding));
    assert.strictEqual(enriched[0].embedding.length, EMBEDDING_DIMENSION);
    assert.strictEqual(progressCalls, 3);
  });

  // --------------------------------------------------------------------------
  // Group 3: Vector Storage & Persistence (IndexedDB + Memory Fallback)
  // --------------------------------------------------------------------------
  console.log('\n--- 3. IndexedDB Vector Storage & Management ---');

  await runTestAsync('3.1 Stores and retrieves document chunks with embeddings', async () => {
    await clearAllChunks();

    const chunks = [
      { id: 'doc1_c0', docId: 'doc1', text: 'Revenue figures for 2024', embedding: Array.from(generateSemanticEmbedding('Revenue figures for 2024')) },
      { id: 'doc1_c1', docId: 'doc1', text: 'Expense figures for 2024', embedding: Array.from(generateSemanticEmbedding('Expense figures for 2024')) }
    ];

    const stored = await storeDocumentChunks('doc1', chunks, 'conv_1');
    assert.strictEqual(stored, true);

    const retrieved = await getChunksForDocuments(['doc1']);
    assert.strictEqual(retrieved.length, 2);
    assert.strictEqual(retrieved[0].docId, 'doc1');
    assert.strictEqual(retrieved[0].conversationId, 'conv_1');
  });

  await runTestAsync('3.2 Retrieves chunks filtered by conversation ID', async () => {
    const convChunks = await getChunksForConversation('conv_1');
    assert.strictEqual(convChunks.length, 2);

    const emptyChunks = await getChunksForConversation('non_existent_conv');
    assert.strictEqual(emptyChunks.length, 0);
  });

  await runTestAsync('3.3 getVectorStoreStats returns accurate metrics', async () => {
    const stats = await getVectorStoreStats();
    assert.strictEqual(stats.chunkCount, 2);
    assert.strictEqual(stats.docCount, 1);
    assert.ok(stats.memoryEstimatedKB >= 0);
  });

  await runTestAsync('3.4 deleteChunksForDocument removes document vectors atomically', async () => {
    const count = await deleteChunksForDocument('doc1');
    assert.strictEqual(count, 2);

    const remaining = await getChunksForDocuments(['doc1']);
    assert.strictEqual(remaining.length, 0);
  });

  // --------------------------------------------------------------------------
  // Group 4: Cross-Document Semantic Retrieval & Top-K Ranking
  // --------------------------------------------------------------------------
  console.log('\n--- 4. Semantic Search & Cross-Document Retrieval ---');

  await runTestAsync('4.1 Multi-document indexing and cross-document semantic query', async () => {
    await clearAllChunks();

    const docA = {
      id: 'doc_finance',
      originalName: 'Financial_Statements.pdf',
      format: 'PDF',
      pages: [
        { pageNumber: 1, text: 'Balance sheet: Cash reserves stood at $50 million as of December 31.' },
        { pageNumber: 2, text: 'Income statement: Gross revenue for the fiscal year reached $120 million.' }
      ]
    };

    const docB = {
      id: 'doc_tech',
      originalName: 'Engineering_Handbook.docx',
      format: 'DOCX',
      sections: [
        { heading: 'Database Architecture', level: 1, content: 'We deploy PostgreSQL Cloud SQL with replication and failover.' },
        { heading: 'Security Policy', level: 1, content: 'All API keys and secrets must reside in environment variables.' }
      ]
    };

    const resA = await indexDocument(docA, 'conv_multi');
    const resB = await indexDocument(docB, 'conv_multi');

    assert.strictEqual(resA.success, true);
    assert.strictEqual(resB.success, true);
    assert.strictEqual(resA.chunkCount, 2);
    assert.strictEqual(resB.chunkCount, 2);

    // Query 1: Finance question -> Should retrieve docA chunks as top results
    const financeResults = await searchSemanticChunks({
      query: 'What was the gross revenue and cash reserve balance?',
      docIds: ['doc_finance', 'doc_tech'],
      topK: 2
    });

    assert.ok(financeResults.length > 0);
    assert.strictEqual(financeResults[0].docId, 'doc_finance');
    assert.ok(financeResults[0].text.includes('revenue') || financeResults[0].text.includes('Cash reserves'));
    assert.ok(financeResults[0].score >= 0.25);

    // Query 2: Tech question -> Should retrieve docB chunks as top results
    const techResults = await searchSemanticChunks({
      query: 'Where are API keys and database credentials stored?',
      docIds: ['doc_finance', 'doc_tech'],
      topK: 2
    });

    assert.ok(techResults.length > 0);
    assert.strictEqual(techResults[0].docId, 'doc_tech');
    assert.ok(techResults[0].text.includes('API keys') || techResults[0].text.includes('Database Architecture'));
  });

  runTest('4.2 formatSemanticResultsForContext produces clear attributions', () => {
    const mockResults = [
      {
        chunkId: 'c1',
        docName: 'Financial_Statements.pdf',
        format: 'PDF',
        pageNumber: 2,
        score: 0.88,
        text: 'Gross revenue for the fiscal year reached $120 million.'
      }
    ];

    const formatted = formatSemanticResultsForContext(mockResults, 'What was the gross revenue?');
    assert.ok(formatted.includes('Financial_Statements.pdf'));
    assert.ok(formatted.includes('Page 2'));
    assert.ok(formatted.includes('Relevance: 88%'));
    assert.ok(formatted.includes('Gross revenue'));
  });

  // --------------------------------------------------------------------------
  // Group 5: Integration with documentContextService.js & Fallback
  // --------------------------------------------------------------------------
  console.log('\n--- 5. documentContextService.js Semantic Integration & Fallback ---');

  await runTestAsync('5.1 retrieveSemanticDocumentContext produces semantic RAG context on content questions', async () => {
    const doc = {
      id: 'doc_contract',
      originalName: 'vendor_agreement.pdf',
      format: 'PDF',
      pages: [
        { pageNumber: 1, text: 'This Agreement is entered into by and between Acme Corp and Beta LLC.' },
        { pageNumber: 2, text: 'Termination Clause: Either party may terminate with 30 days written notice.' }
      ]
    };

    const result = await retrieveSemanticDocumentContext('What is the termination clause and notice period?', [doc]);
    assert.strictEqual(result.retrievalMethod, 'semantic_rag');
    assert.ok(result.semanticChunks.length > 0);
    assert.ok(result.formattedContext.includes('RELEVANT SEMANTIC DOCUMENT EXCERPTS'));
    assert.ok(result.formattedContext.includes('Termination Clause'));
    assert.ok(result.formattedContext.includes('30 days written notice'));
  });

  await runTestAsync('5.2 Preserves rule-based structural intents directly without vector interference', async () => {
    const doc = {
      id: 'doc_manual',
      originalName: 'operations_manual.pdf',
      format: 'PDF',
      pageCount: 5,
      pages: [
        { pageNumber: 1, text: 'Chapter 1: Introduction' },
        { pageNumber: 2, text: 'Chapter 2: Safety Protocols and Emergency Exits' },
        { pageNumber: 3, text: 'Chapter 3: Maintenance Schedule' },
        { pageNumber: 4, text: 'Chapter 4: Contact Directory' },
        { pageNumber: 5, text: 'Chapter 5: Index' }
      ]
    };

    // User asks explicitly for "page 2"
    const pageResult = await retrieveSemanticDocumentContext('Explain page 2', [doc]);
    assert.strictEqual(pageResult.retrievalMethod, 'rule_based_intent');
    assert.strictEqual(pageResult.scope, 'page');
    assert.ok(pageResult.formattedContext.includes('Page 2 of 5'));
    assert.ok(pageResult.formattedContext.includes('Safety Protocols'));

    // User asks explicitly for "slides 3 to 5"
    const pptxDoc = {
      id: 'doc_deck',
      originalName: 'presentation.pptx',
      format: 'PPTX',
      slideCount: 5,
      slides: [
        { slideNumber: 3, title: 'Roadmap', text: 'Q1 Launch' },
        { slideNumber: 4, title: 'Budget', text: 'Allocations' }
      ]
    };
    const slideResult = await retrieveSemanticDocumentContext('Explain slides 3 to 4', [pptxDoc]);
    assert.strictEqual(slideResult.retrievalMethod, 'rule_based_intent');
    assert.strictEqual(slideResult.scope, 'slide_range');
  });

  await runTestAsync('5.3 Seamlessly falls back to rule-based retrieval when no semantic matches exist', async () => {
    const doc = {
      id: 'doc_empty',
      originalName: 'empty_doc.txt',
      format: 'TXT',
      text: 'Short notes about gardening and flowers.'
    };

    // Question completely unrelated with zero matches above minScore
    const result = await retrieveSemanticDocumentContext('quantum chromodynamics gluon interaction tensor', [doc], {
      minScore: 0.95 // impossibly high threshold to trigger fallback
    });

    assert.strictEqual(result.retrievalMethod, 'rule_based_fallback');
    assert.ok(result.formattedContext.includes('empty_doc.txt'));
  });

  // --------------------------------------------------------------------------
  // Group 6: Deletion & Chat Cleanup Lifecycle
  // --------------------------------------------------------------------------
  console.log('\n--- 6. Deletion, Replacement, and Chat Cleanup Lifecycle ---');

  await runTestAsync('6.1 deleteAttachmentRecord cleans up associated vector chunks', async () => {
    await clearAllChunks();
    const doc = {
      id: 'attachment_to_delete',
      originalName: 'delete_me.txt',
      format: 'TXT',
      text: 'This document will be deleted from storage.'
    };

    await indexDocument(doc);
    let chunks = await getChunksForDocuments(['attachment_to_delete']);
    assert.strictEqual(chunks.length, 1);

    await deleteAttachmentRecord('attachment_to_delete');
    chunks = await getChunksForDocuments(['attachment_to_delete']);
    assert.strictEqual(chunks.length, 0);
  });

  await runTestAsync('6.2 deleteAttachmentRecords cleans up batch of document vectors', async () => {
    await clearAllChunks();
    const doc1 = { id: 'batch_1', originalName: '1.txt', format: 'TXT', text: 'Doc 1' };
    const doc2 = { id: 'batch_2', originalName: '2.txt', format: 'TXT', text: 'Doc 2' };

    await indexDocument(doc1);
    await indexDocument(doc2);

    await deleteAttachmentRecords(['batch_1', 'batch_2']);
    const chunks = await getChunksForDocuments(['batch_1', 'batch_2']);
    assert.strictEqual(chunks.length, 0);
  });

  await runTestAsync('6.3 deleteAttachmentsForConversation cleans up conversation vector index', async () => {
    await clearAllChunks();
    const doc = {
      id: 'conv_doc_1',
      originalName: 'chat_doc.pdf',
      format: 'PDF',
      text: 'Content inside chat conversation 999'
    };

    await indexDocument(doc, 'chat_999');
    let chunks = await getChunksForConversation('chat_999');
    assert.strictEqual(chunks.length, 1);

    await deleteAttachmentsForConversation('chat_999');
    chunks = await getChunksForConversation('chat_999');
    assert.strictEqual(chunks.length, 0);
  });

  await runTestAsync('6.4 Re-indexing replaces old vectors without duplication', async () => {
    await clearAllChunks();
    const docV1 = { id: 'doc_versioned', originalName: 'doc.txt', format: 'TXT', text: 'Version 1 text content' };
    await indexDocument(docV1);

    let chunks = await getChunksForDocuments(['doc_versioned']);
    assert.strictEqual(chunks.length, 1);
    assert.strictEqual(chunks[0].text, 'Version 1 text content');

    // Replace with version 2
    const docV2 = { id: 'doc_versioned', originalName: 'doc.txt', format: 'TXT', text: 'Version 2 updated content' };
    await indexDocument(docV2);

    chunks = await getChunksForDocuments(['doc_versioned']);
    assert.strictEqual(chunks.length, 1);
    assert.strictEqual(chunks[0].text, 'Version 2 updated content');
  });

  // --------------------------------------------------------------------------
  // Group 7: Conceptual Similarity (Synonyms, Paraphrases & Different Vocabulary)
  // --------------------------------------------------------------------------
  console.log('\n--- 7. Conceptual Similarity (Synonyms, Paraphrases & Different Vocabulary) ---');

  runTest('7.1 Semantic concept ontology model is properly initialized', () => {
    const vocabSize = getConceptVocabularySize();
    const clusterCount = getConceptClusterCount();
    assert.ok(vocabSize >= 150, `Expected at least 150 concept vocabulary words, got ${vocabSize}`);
    assert.ok(clusterCount >= 10, `Expected at least 10 concept clusters, got ${clusterCount}`);
  });

  runTest('7.2 Embeddings exhibit strong cosine similarity for differently worded synonymous queries', () => {
    const synonymPairs = [
      {
        query: 'How much money did the firm make?',
        passage: 'Total net revenue and operating profit reached ten million.',
        label: 'Earnings / Net Profit vs Money Made by Firm'
      },
      {
        query: 'Can I get my cash back?',
        passage: 'Customers are entitled to a full reimbursement within 30 days.',
        label: 'Cash Back vs Reimbursement'
      },
      {
        query: 'How do I contact customer support?',
        passage: 'For client assistance and helpdesk inquiries, email our team.',
        label: 'Customer Support vs Client Assistance / Helpdesk'
      },
      {
        query: 'The physician prescribed medicine.',
        passage: 'The doctor gave pharmaceutical treatments to the patient.',
        label: 'Physician / Medicine vs Doctor / Pharmaceutical'
      },
      {
        query: 'Cancel my subscription plan',
        passage: 'Terminate the recurring membership agreement.',
        label: 'Cancel Subscription vs Terminate Membership'
      }
    ];

    const irrelevantText = 'How to configure Webpack and Vite plugins for React TypeScript bundling.';
    const irrelVec = generateSemanticEmbedding(irrelevantText);

    for (const pair of synonymPairs) {
      const qVec = generateSemanticEmbedding(pair.query);
      const passVec = generateSemanticEmbedding(pair.passage);

      const relSim = computeCosineSimilarity(qVec, passVec);
      const irrelSim = computeCosineSimilarity(qVec, irrelVec);

      assert.ok(
        relSim > irrelSim,
        `[${pair.label}] Expected relevant similarity (${relSim.toFixed(3)}) > irrelevant (${irrelSim.toFixed(3)})`
      );
      assert.ok(
        relSim >= 0.25,
        `[${pair.label}] Expected strong conceptual similarity >= 0.25, got ${relSim.toFixed(3)}`
      );
      assert.ok(
        irrelSim < 0.20,
        `[${pair.label}] Expected irrelevant text similarity < 0.20, got ${irrelSim.toFixed(3)}`
      );
    }
  });

  await runTestAsync('7.3 searchSemanticChunks retrieves documents using completely different vocabulary', async () => {
    await clearAllChunks();

    const supportDoc = {
      id: 'doc_support',
      originalName: 'support_guide.txt',
      format: 'TXT',
      text: 'Our client assistance team offers 24/7 helpdesk guidance and resolves billing disputes for all patrons.'
    };

    const techDoc = {
      id: 'doc_tech_build',
      originalName: 'build_guide.txt',
      format: 'TXT',
      text: 'Configure the rollup bundling pipeline, tree shaking, and code splitting for client web performance.'
    };

    await indexDocument(supportDoc);
    await indexDocument(techDoc);

    // Query uses different vocabulary: "help customer with invoice problem"
    // Document uses: "client assistance", "helpdesk", "billing disputes", "patrons"
    const results = await searchSemanticChunks({
      query: 'Who can help customer with invoice problem?',
      docIds: ['doc_support', 'doc_tech_build'],
      topK: 3,
      minScore: 0.15
    });

    assert.ok(results.length >= 1, `Expected at least 1 retrieval match, got ${results.length}`);
    assert.strictEqual(results[0].docId, 'doc_support');
    assert.ok(results[0].score >= 0.25, `Expected score >= 0.25, got ${results[0].score}`);
    assert.ok(results[0].text.includes('client assistance'));
  });

  await runTestAsync('7.4 Multi-domain concept retrieval accurately discriminates between domains', async () => {
    await clearAllChunks();

    const medicalDoc = {
      id: 'doc_medical',
      originalName: 'clinical_notes.txt',
      format: 'TXT',
      text: 'The clinician provided therapeutic care and prescribed antibiotic treatments to recover health.'
    };

    const financeDoc = {
      id: 'doc_finance_report',
      originalName: 'financials.txt',
      format: 'TXT',
      text: 'The corporation announced record revenue, high EBITDA profit margins, and quarterly dividend payouts.'
    };

    const legalDoc = {
      id: 'doc_legal_terms',
      originalName: 'terms.txt',
      format: 'TXT',
      text: 'The contract provisions mandate strict compliance with regulatory guidelines and confidential privacy rules.'
    };

    await indexDocument(medicalDoc);
    await indexDocument(financeDoc);
    await indexDocument(legalDoc);

    const docIds = ['doc_medical', 'doc_finance_report', 'doc_legal_terms'];

    // 1. Medical domain query with alternate terms
    const medResults = await searchSemanticChunks({
      query: 'doctor pharmaceutical drugs',
      docIds,
      topK: 1
    });
    assert.strictEqual(medResults[0]?.docId, 'doc_medical');

    // 2. Finance domain query with alternate terms
    const finResults = await searchSemanticChunks({
      query: 'how much money earnings did company gain',
      docIds,
      topK: 1
    });
    assert.strictEqual(finResults[0]?.docId, 'doc_finance_report');

    // 3. Legal domain query with alternate terms
    const legalResults = await searchSemanticChunks({
      query: 'agreement policies and legal statutes',
      docIds,
      topK: 1
    });
    assert.strictEqual(legalResults[0]?.docId, 'doc_legal_terms');
  });

  // --------------------------------------------------------------------------
  // Group 8: ORVIX-AUD-038 Incremental In-Memory Document Indexing
  // --------------------------------------------------------------------------
  console.log('\n--- 8. ORVIX-AUD-038: Incremental In-Memory Document Indexing ---');

  await runTestAsync('8.1 Indexes new inMemoryDocs even when candidateChunks already exist for prior documents', async () => {
    await clearAllChunks();

    const docA = {
      id: 'doc_existing_a',
      originalName: 'solar_guide.txt',
      format: 'TXT',
      text: 'Solar photovoltaic panels convert sunlight into electricity using silicon cells.'
    };
    const docB = {
      id: 'doc_new_b',
      originalName: 'ocean_currents.txt',
      format: 'TXT',
      text: 'Thermohaline circulation drives deep ocean currents based on temperature and salinity gradients.'
    };

    // Index only docA initially
    const initRes = await indexDocument(docA, 'conv_aud038');
    assert.strictEqual(initRes.success, true);

    // Search with docIds and inMemoryDocs containing BOTH docA (already indexed) and docB (new)
    const results = await searchSemanticChunks({
      query: 'What drives deep ocean currents and salinity gradients?',
      docIds: ['doc_existing_a', 'doc_new_b'],
      conversationId: 'conv_aud038',
      inMemoryDocs: [docA, docB],
      topK: 3
    });

    assert.ok(results.length >= 1, 'Expected docB to be indexed and retrieved');
    assert.strictEqual(results[0].docId, 'doc_new_b');
    assert.ok(results[0].text.includes('Thermohaline circulation'));

    // Verify both documents are now persisted in vector store without duplicate chunks
    const storedA = await getChunksForDocuments(['doc_existing_a']);
    const storedB = await getChunksForDocuments(['doc_new_b']);
    assert.strictEqual(storedA.length, 1);
    assert.strictEqual(storedB.length, 1);
  });

  await runTestAsync('8.2 Prevents duplicate indexing and skips ineligible documents in inMemoryDocs', async () => {
    await clearAllChunks();

    const doc1 = {
      id: 'doc_dup_1',
      originalName: 'alpha.txt',
      format: 'TXT',
      text: 'Kubernetes orchestrates containerized workloads across clusters.'
    };
    const doc2 = {
      id: 'doc_dup_2',
      originalName: 'beta.txt',
      format: 'TXT',
      text: 'GraphQL provides a typed query language for APIs.'
    };
    const docEncrypted = {
      id: 'doc_encrypted_skip',
      originalName: 'secret.docx',
      format: 'DOCX',
      status: 'encrypted',
      text: 'Encrypted document placeholder text'
    };

    await indexDocument(doc1, 'conv_aud038_dup');

    // Pass duplicate doc2 entries + already-indexed doc1 + ineligible encrypted doc
    const results = await searchSemanticChunks({
      query: 'typed query language for APIs',
      docIds: ['doc_dup_1', 'doc_dup_2', 'doc_encrypted_skip'],
      conversationId: 'conv_aud038_dup',
      inMemoryDocs: [doc1, doc2, doc2, docEncrypted],
      topK: 5
    });

    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].docId, 'doc_dup_2');

    const allStored = await getChunksForConversation('conv_aud038_dup');
    assert.strictEqual(allStored.length, 2, 'Should store exactly 1 chunk each for doc1 and doc2, none for encrypted doc');
    assert.strictEqual(allStored.some((c) => c.docId === 'doc_encrypted_skip'), false);
  });

  // --------------------------------------------------------------------------
  // Summary
  // --------------------------------------------------------------------------
  console.log('\n======================================================================');
  console.log(`Semantic RAG Test Summary: ${passedTests} passed, ${failedTests} failed.`);
  console.log('======================================================================');

  if (failedTests > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
