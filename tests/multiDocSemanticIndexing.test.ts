import test from 'node:test';
import assert from 'node:assert';
import {
  indexDocument,
  searchSemanticChunks
} from '../src/services/semanticRetrievalService.js';
import {
  getChunksForConversation,
  getChunksForDocuments,
  resetVectorDBForTesting
} from '../src/services/semanticVectorStorage.js';

test('ORVIX-LOW-05 regression: document uploaded in first turn is indexed and searchable', async () => {
  resetVectorDBForTesting();
  const conversationId = 'conv-multidoc-1';
  const doc1 = {
    id: 'doc-turn-1',
    originalName: 'report-q1.pdf',
    format: 'PDF',
    status: 'ready',
    success: true,
    text: 'Q1 revenue reached 4.5 million dollars driven by cloud software subscriptions.'
  };

  const indexRes = await indexDocument(doc1, conversationId);
  assert.equal(indexRes.success, true);
  assert.ok(indexRes.chunkCount > 0);

  const results = await searchSemanticChunks({
    query: 'What was Q1 revenue?',
    conversationId,
    inMemoryDocs: [doc1]
  });

  assert.ok(results.length > 0);
  assert.equal(results[0].docId, 'doc-turn-1');
  assert.ok(results[0].text.includes('4.5 million dollars'));
});

test('ORVIX-LOW-05 regression: second document uploaded in a later turn is indexed and searchable while turn 1 chunks remain', async () => {
  resetVectorDBForTesting();
  const conversationId = 'conv-multidoc-2';

  const doc1 = {
    id: 'doc-turn-1',
    originalName: 'report-q1.pdf',
    format: 'PDF',
    status: 'ready',
    success: true,
    text: 'Q1 revenue reached 4.5 million dollars driven by cloud software subscriptions.'
  };

  // Index doc1 in turn 1
  await indexDocument(doc1, conversationId);

  const doc2 = {
    id: 'doc-turn-2',
    originalName: 'report-q2.pdf',
    format: 'PDF',
    status: 'ready',
    success: true,
    text: 'Q2 revenue expanded to 6.2 million dollars driven by enterprise expansion.'
  };

  // Upload and search in turn 2 (doc1 already exists in vector store)
  const results = await searchSemanticChunks({
    query: 'Compare Q1 and Q2 revenue growth.',
    conversationId,
    inMemoryDocs: [doc1, doc2],
    topK: 6
  });

  assert.ok(results.length >= 2, 'Expected chunks from both document 1 and document 2');
  const docIdsFound = new Set(results.map((r) => r.docId));
  assert.ok(docIdsFound.has('doc-turn-1'), 'Turn 1 document should remain indexed and searchable');
  assert.ok(docIdsFound.has('doc-turn-2'), 'Turn 2 document should be indexed on-the-fly and searchable');
});

test('ORVIX-LOW-05 regression: semantic retrieval returns relevant chunks across both documents with diversity', async () => {
  resetVectorDBForTesting();
  const conversationId = 'conv-multidoc-3';

  const doc1 = {
    id: 'doc-a',
    originalName: 'security-policy.txt',
    format: 'TXT',
    status: 'ready',
    success: true,
    text: 'All employees must enable two-factor authentication and rotate passwords every 90 days.'
  };

  const doc2 = {
    id: 'doc-b',
    originalName: 'benefits-guide.txt',
    format: 'TXT',
    status: 'ready',
    success: true,
    text: 'Health insurance premiums are fully covered for full-time employees.'
  };

  await indexDocument(doc1, conversationId);
  await indexDocument(doc2, conversationId);

  const results = await searchSemanticChunks({
    query: 'Tell me about passwords and health insurance benefits.',
    conversationId,
    inMemoryDocs: [doc1, doc2],
    topK: 4,
    ensureMultiDocDiversity: true
  });

  assert.ok(results.length >= 2);
  const docIds = new Set(results.map((r) => r.docId));
  assert.ok(docIds.has('doc-a'));
  assert.ok(docIds.has('doc-b'));
});

test('ORVIX-LOW-05 regression: adding a document does not overwrite or discard previously indexed chunks', async () => {
  resetVectorDBForTesting();
  const conversationId = 'conv-multidoc-4';

  const doc1 = {
    id: 'doc-first',
    originalName: 'first.txt',
    format: 'TXT',
    status: 'ready',
    success: true,
    text: 'This is the first document content about logistics.'
  };

  await indexDocument(doc1, conversationId);
  const chunksAfterFirst = (await getChunksForConversation(conversationId)) as any[];
  assert.equal(chunksAfterFirst.length, 1);

  const doc2 = {
    id: 'doc-second',
    originalName: 'second.txt',
    format: 'TXT',
    status: 'ready',
    success: true,
    text: 'This is the second document content about supply chain.'
  };

  await indexDocument(doc2, conversationId);
  const chunksAfterSecond = (await getChunksForConversation(conversationId)) as any[];
  assert.equal(chunksAfterSecond.length, 2);

  const storedDocIds = new Set(chunksAfterSecond.map((c: any) => c.docId));
  assert.ok(storedDocIds.has('doc-first'));
  assert.ok(storedDocIds.has('doc-second'));
});

test('ORVIX-LOW-05 regression: re-uploading the same document does not create duplicate chunks', async () => {
  resetVectorDBForTesting();
  const conversationId = 'conv-multidoc-5';

  const doc = {
    id: 'doc-same',
    originalName: 'manual.txt',
    format: 'TXT',
    status: 'ready',
    success: true,
    text: 'Operating instructions for machinery and safety guidelines.'
  };

  await indexDocument(doc, conversationId);
  await indexDocument(doc, conversationId); // Re-upload same doc

  const chunks = (await getChunksForConversation(conversationId)) as any[];
  const docChunks = chunks.filter((c: any) => c.docId === 'doc-same');
  assert.equal(docChunks.length, 1, 'Re-uploading unchanged document should replace/deduplicate cleanly without duplicate chunks');
});

test('ORVIX-LOW-05 regression: documents from other chats or users are never included', async () => {
  resetVectorDBForTesting();
  const chatA = 'chat-alpha';
  const chatB = 'chat-beta';
  const userA = 'user-alice';
  const userB = 'user-bob';

  const docA = {
    id: 'doc-private-a',
    originalName: 'alice-secrets.txt',
    format: 'TXT',
    status: 'ready',
    success: true,
    userId: userA,
    conversationId: chatA,
    text: 'Alice private financial portfolio statement.'
  };

  const docB = {
    id: 'doc-private-b',
    originalName: 'bob-secrets.txt',
    format: 'TXT',
    status: 'ready',
    success: true,
    userId: userB,
    conversationId: chatB,
    text: 'Bob private engineering blueprints.'
  };

  await indexDocument(docA, chatA, { userId: userA });
  await indexDocument(docB, chatB, { userId: userB });

  // Search within Chat A as User A
  const resultsA = await searchSemanticChunks({
    query: 'portfolio blueprints',
    conversationId: chatA,
    userId: userA,
    inMemoryDocs: [docA, docB]
  });

  assert.equal(resultsA.length, 1);
  assert.equal(resultsA[0].docId, 'doc-private-a');
});

test('ORVIX-LOW-05 regression: failed or empty document extraction does not corrupt existing indexes', async () => {
  resetVectorDBForTesting();
  const conversationId = 'conv-multidoc-6';

  const validDoc = {
    id: 'doc-valid',
    originalName: 'valid.txt',
    format: 'TXT',
    status: 'ready',
    success: true,
    text: 'Project timeline and deliverables overview.'
  };

  await indexDocument(validDoc, conversationId);
  const initialChunks = (await getChunksForConversation(conversationId)) as any[];
  assert.equal(initialChunks.length, 1);

  const emptyDoc = {
    id: 'doc-empty',
    originalName: 'empty.txt',
    format: 'TXT',
    status: 'empty',
    success: false,
    text: ''
  };

  const failedIndex = await indexDocument(emptyDoc, conversationId);
  assert.equal(failedIndex.success, false);
  assert.equal(failedIndex.chunkCount, 0);

  const postChunks = (await getChunksForConversation(conversationId)) as any[];
  assert.equal(postChunks.length, 1, 'Valid index must not be corrupted or discarded by failed/empty document indexing');
  assert.equal(postChunks[0].docId, 'doc-valid');
});

test('ORVIX-LOW-05 regression: multiple concurrent document uploads do not cause indexing races or lost chunks', async () => {
  resetVectorDBForTesting();
  const conversationId = 'conv-multidoc-concurrent';

  const docs = [
    { id: 'doc-c1', originalName: 'c1.txt', format: 'TXT', status: 'ready', success: true, text: 'First concurrent document content about alpha.' },
    { id: 'doc-c2', originalName: 'c2.txt', format: 'TXT', status: 'ready', success: true, text: 'Second concurrent document content about beta.' },
    { id: 'doc-c3', originalName: 'c3.txt', format: 'TXT', status: 'ready', success: true, text: 'Third concurrent document content about gamma.' }
  ];

  // Index concurrently
  const promises = docs.map((d) => indexDocument(d, conversationId));
  const results = await Promise.all(promises);

  for (const res of results) {
    assert.equal(res.success, true);
  }

  const stored = await getChunksForConversation(conversationId);
  assert.equal(stored.length, 3, 'All 3 concurrently uploaded documents should be indexed without lost chunks');
});
