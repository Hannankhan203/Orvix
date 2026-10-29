/**
 * Automated Verification Suite for Orvix AI Chat Message Alignment, Ordering, and Response Association
 *
 * Verifies Tests A through H:
 * - Test A: Basic message association (Question followed directly by its AI response)
 * - Test B: Multiple consecutive messages (Chronological turn-based ordering)
 * - Test C: Asynchronous out-of-order completion (Slow request finishing after faster subsequent request)
 * - Test D: Streaming updates (In-place token streaming maintaining strict association)
 * - Test E: Model switching & alternatives (Alternative responses stay pinned to parent prompt)
 * - Test F: Re-rendering & scrolling stability (Zero jumping, duplicate keys, or drift)
 * - Test G: Retry & Provider Switching after failure (In-place replacement under parent message)
 * - Test H: History restoration & export fidelity (Local storage, Firestore payloads, Markdown/TXT export)
 */

import assert from 'node:assert/strict';
import {
  orderConversationMessages,
  ensureConversationAlternatives,
  normalizeAssistantMessage,
  addAlternativeToAssistantMessage,
  createAlternativeRecord
} from '../src/services/alternativeResponseService.js';
import {
  formatConversationMarkdown,
  formatConversationPlainText,
  sanitizeFilename
} from '../src/utils/exportConversation.js';
import {
  sanitizeMessageForStorage
} from '../src/services/chatStorageService.js';

let passedCount = 0;
let failedCount = 0;

function runTest(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passedCount++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(err);
    failedCount++;
  }
}

console.log('\n=== RUNNING ORVIX AI MESSAGE ALIGNMENT & ORDERING SUITE ===\n');

// ----------------------------------------------------------------------------
// Test A: Basic Message Association
// ----------------------------------------------------------------------------
console.log('--- Test A: Basic Message Association ---');

runTest('A1: AI response contains parentMessageId and interactionId pointing to user prompt', () => {
  const userMsg = {
    id: 'user-msg-1',
    interactionId: 'interaction-1',
    sender: 'user',
    content: 'Write a JavaScript function that adds two numbers.',
    createdAtMs: 1000
  };

  const aiMsg = {
    id: 'ai-msg-1',
    interactionId: 'interaction-1',
    parentMessageId: 'user-msg-1',
    sender: 'assistant',
    content: '```javascript\nfunction add(a, b) {\n  return a + b;\n}\n```',
    createdAtMs: 1050
  };

  const ordered = orderConversationMessages([userMsg, aiMsg]);
  assert.equal(ordered.length, 2);
  assert.equal(ordered[0].id, 'user-msg-1');
  assert.equal(ordered[1].id, 'ai-msg-1');
  assert.equal(ordered[1].parentMessageId, 'user-msg-1');
  assert.equal(ordered[1].interactionId, 'interaction-1');
});

runTest('A2: Displaced AI response is restored directly beneath its parent user question', () => {
  // Simulating the original bug where userMsg was placed at top, other stuff in between,
  // and aiMsg was displaced at the end of the array
  const userMsg1 = {
    id: 'user-msg-js',
    interactionId: 'interaction-js',
    sender: 'user',
    content: 'Write a JavaScript function that adds two numbers.',
    createdAtMs: 1000
  };
  const userMsg2 = {
    id: 'user-msg-python',
    interactionId: 'interaction-py',
    sender: 'user',
    content: 'How do I sort a list in Python?',
    createdAtMs: 2000
  };
  const aiMsg2 = {
    id: 'ai-msg-python',
    interactionId: 'interaction-py',
    parentMessageId: 'user-msg-python',
    sender: 'assistant',
    content: 'Use sorted(list) or list.sort().',
    createdAtMs: 2100
  };
  const aiMsg1 = {
    id: 'ai-msg-js',
    interactionId: 'interaction-js',
    parentMessageId: 'user-msg-js',
    sender: 'assistant',
    content: 'function add(a, b) { return a + b; }',
    createdAtMs: 1200
  };

  // Buggy raw array order: user1, user2, ai2, ai1
  const rawArray = [userMsg1, userMsg2, aiMsg2, aiMsg1];
  const ordered = orderConversationMessages(rawArray);

  assert.deepEqual(
    ordered.map((m) => m.id),
    ['user-msg-js', 'ai-msg-js', 'user-msg-python', 'ai-msg-python'],
    'AI response for JavaScript must be placed directly beneath the JavaScript user question'
  );
});

// ----------------------------------------------------------------------------
// Test B: Multiple Consecutive Messages
// ----------------------------------------------------------------------------
console.log('\n--- Test B: Multiple Consecutive Messages ---');

runTest('B1: Multi-turn conversation preserves strict chronological question-and-answer pairs', () => {
  const messages = [
    { id: 'u1', interactionId: 'ix1', sender: 'user', content: 'Turn 1 User', createdAtMs: 100 },
    { id: 'a1', interactionId: 'ix1', parentMessageId: 'u1', sender: 'assistant', content: 'Turn 1 AI', createdAtMs: 150 },
    { id: 'u2', interactionId: 'ix2', sender: 'user', content: 'Turn 2 User', createdAtMs: 200 },
    { id: 'a2', interactionId: 'ix2', parentMessageId: 'u2', sender: 'assistant', content: 'Turn 2 AI', createdAtMs: 250 },
    { id: 'u3', interactionId: 'ix3', sender: 'user', content: 'Turn 3 User', createdAtMs: 300 },
    { id: 'a3', interactionId: 'ix3', parentMessageId: 'u3', sender: 'assistant', content: 'Turn 3 AI', createdAtMs: 350 }
  ];

  const ordered = orderConversationMessages(messages);
  assert.deepEqual(
    ordered.map((m) => m.id),
    ['u1', 'a1', 'u2', 'a2', 'u3', 'a3']
  );
});

runTest('B2: Consecutively submitted user messages (batch prompts) maintain correct respective responses', () => {
  const u1 = { id: 'u1', interactionId: 'ix1', sender: 'user', content: 'First question', createdAtMs: 100 };
  const u2 = { id: 'u2', interactionId: 'ix2', sender: 'user', content: 'Second quick question', createdAtMs: 110 };
  const a1 = { id: 'a1', interactionId: 'ix1', parentMessageId: 'u1', sender: 'assistant', content: 'First answer', createdAtMs: 200 };
  const a2 = { id: 'a2', interactionId: 'ix2', parentMessageId: 'u2', sender: 'assistant', content: 'Second answer', createdAtMs: 220 };

  // If user rapid-fired two messages before responses arrived
  const disordered = [u1, u2, a1, a2];
  const ordered = orderConversationMessages(disordered);

  assert.deepEqual(
    ordered.map((m) => m.id),
    ['u1', 'a1', 'u2', 'a2'],
    'Each AI response must be attached to its own user message even when users submit fast consecutive prompts'
  );
});

// ----------------------------------------------------------------------------
// Test C: Asynchronous Out-of-Order Completions
// ----------------------------------------------------------------------------
console.log('\n--- Test C: Asynchronous Out-of-Order Completions ---');

runTest('C1: Slow request 1 completing after faster request 2 maintains proper pairing', () => {
  const u1 = { id: 'u1', interactionId: 'ix1', sender: 'user', content: 'Complex analysis (slow)', createdAtMs: 1000 };
  const u2 = { id: 'u2', interactionId: 'ix2', sender: 'user', content: 'Quick greeting (fast)', createdAtMs: 1100 };
  const a2 = { id: 'a2', interactionId: 'ix2', parentMessageId: 'u2', sender: 'assistant', content: 'Hello!', createdAtMs: 1150 };
  const a1 = { id: 'a1', interactionId: 'ix1', parentMessageId: 'u1', sender: 'assistant', content: 'Full analysis result...', createdAtMs: 2500 };

  // Raw completion order where a2 was added first, and a1 was added later:
  const rawList = [u1, u2, a2, a1];
  const ordered = orderConversationMessages(rawList);

  assert.deepEqual(
    ordered.map((m) => m.id),
    ['u1', 'a1', 'u2', 'a2'],
    'Slow request a1 must be positioned directly after u1, ahead of u2 and a2'
  );
});

runTest('C2: Interleaved message array resolves correctly regardless of shuffle order', () => {
  const u1 = { id: 'u1', interactionId: 'ix1', sender: 'user', content: 'U1', createdAtMs: 100 };
  const a1 = { id: 'a1', interactionId: 'ix1', parentMessageId: 'u1', sender: 'assistant', content: 'A1', createdAtMs: 120 };
  const u2 = { id: 'u2', interactionId: 'ix2', sender: 'user', content: 'U2', createdAtMs: 200 };
  const a2 = { id: 'a2', interactionId: 'ix2', parentMessageId: 'u2', sender: 'assistant', content: 'A2', createdAtMs: 220 };
  const u3 = { id: 'u3', interactionId: 'ix3', sender: 'user', content: 'U3', createdAtMs: 300 };
  const a3 = { id: 'a3', interactionId: 'ix3', parentMessageId: 'u3', sender: 'assistant', content: 'A3', createdAtMs: 320 };

  // Severely shuffled array
  const shuffled = [a3, u2, a1, u3, a2, u1];
  const ordered = orderConversationMessages(shuffled);

  assert.deepEqual(
    ordered.map((m) => m.id),
    ['u1', 'a1', 'u2', 'a2', 'u3', 'a3']
  );
});

// ----------------------------------------------------------------------------
// Test D: Streaming Updates
// ----------------------------------------------------------------------------
console.log('\n--- Test D: Streaming Updates ---');

runTest('D1: Streaming partial chunks updates response content in place without shifting position', () => {
  const u1 = { id: 'u1', interactionId: 'ix1', sender: 'user', content: 'Stream test', createdAtMs: 100 };
  let currentMessages = [
    u1,
    {
      id: 'a1',
      interactionId: 'ix1',
      parentMessageId: 'u1',
      sender: 'assistant',
      content: '',
      isStreaming: true,
      createdAtMs: 110
    }
  ];

  const streamChunks = ['Here ', 'is ', 'the ', 'streamed ', 'code.'];
  for (const chunk of streamChunks) {
    currentMessages = currentMessages.map((m) =>
      m.id === 'a1' ? { ...m, content: m.content + chunk } : m
    );
    const ordered = orderConversationMessages(currentMessages);
    assert.equal(ordered.length, 2);
    assert.equal(ordered[0].id, 'u1');
    assert.equal(ordered[1].id, 'a1');
    assert.equal(ordered[1].parentMessageId, 'u1');
  }

  // Finalize stream
  currentMessages = currentMessages.map((m) =>
    m.id === 'a1' ? { ...m, isStreaming: false } : m
  );
  const finalOrdered = orderConversationMessages(currentMessages);
  assert.equal(finalOrdered[1].content, 'Here is the streamed code.');
  assert.equal(finalOrdered[1].isStreaming, false);
});

// ----------------------------------------------------------------------------
// Test E: Model Switching & Alternatives
// ----------------------------------------------------------------------------
console.log('\n--- Test E: Model Switching & Alternatives ---');

runTest('E1: Generating an alternative with another provider links to parent prompt and maintains position', () => {
  const u1 = { id: 'u1', interactionId: 'ix1', sender: 'user', content: 'Generate code', createdAtMs: 100 };
  const a1 = normalizeAssistantMessage({
    id: 'a1',
    interactionId: 'ix1',
    parentMessageId: 'u1',
    sender: 'assistant',
    provider: 'gemini',
    content: 'Gemini code version',
    createdAtMs: 110
  });

  const altRecord = createAlternativeRecord({
    parentMessageId: 'u1',
    provider: 'groq',
    content: 'Groq ultra-fast code version',
    modelUsed: 'llama-3.3-70b-versatile'
  });

  const updatedA1 = addAlternativeToAssistantMessage(a1, altRecord, true);
  assert.equal(updatedA1.provider, 'groq');
  assert.equal(updatedA1.content, 'Groq ultra-fast code version');
  assert.equal(updatedA1.parentMessageId, 'u1');
  assert.equal(updatedA1.alternatives.length, 2);

  const messages = [u1, updatedA1];
  const ordered = orderConversationMessages(messages);
  assert.deepEqual(ordered.map((m) => m.id), ['u1', 'a1']);
  assert.equal(ordered[1].alternatives[0].parentMessageId, 'u1');
  assert.equal(ordered[1].alternatives[1].parentMessageId, 'u1');
});

runTest('E2: ensureConversationAlternatives maintains correct parentMessageId via interactionId map', () => {
  const u1 = { id: 'u1', interactionId: 'ix1', sender: 'user', content: 'User Question', createdAtMs: 100 };
  const rawAssistant = {
    id: 'a1',
    interactionId: 'ix1',
    sender: 'assistant',
    content: 'Assistant Answer',
    createdAtMs: 120
  };

  const normalized = ensureConversationAlternatives([u1, rawAssistant]);
  assert.equal(normalized[1].parentMessageId, 'u1');
  assert.equal(normalized[1].interactionId, 'ix1');
  assert.ok(Array.isArray(normalized[1].alternatives));
  assert.equal(normalized[1].alternatives[0].parentMessageId, 'u1');
});

// ----------------------------------------------------------------------------
// Test F: Re-rendering & Scrolling Stability
// ----------------------------------------------------------------------------
console.log('\n--- Test F: Re-rendering & Scrolling Stability ---');

runTest('F1: orderConversationMessages is idempotent and preserves object references when already sorted', () => {
  const messages = [
    { id: 'u1', interactionId: 'ix1', sender: 'user', content: 'Q1', createdAtMs: 100 },
    { id: 'a1', interactionId: 'ix1', parentMessageId: 'u1', sender: 'assistant', content: 'A1', createdAtMs: 110 },
    { id: 'u2', interactionId: 'ix2', sender: 'user', content: 'Q2', createdAtMs: 200 },
    { id: 'a2', interactionId: 'ix2', parentMessageId: 'u2', sender: 'assistant', content: 'A2', createdAtMs: 210 }
  ];

  const pass1 = orderConversationMessages(messages);
  assert.equal(pass1.length, 4);
  assert.equal(pass1[0].id, 'u1');
  assert.equal(pass1[1].id, 'a1');

  // Fast path returns the exact same array reference if already in valid canonical order
  const pass2 = orderConversationMessages(pass1);
  assert.equal(pass2, pass1, 'Subsequent re-renders should return identical reference without re-allocating');
});

runTest('F2: React keys are unique and stable across re-renders', () => {
  const messages = [
    { id: 'u1', interactionId: 'ix1', sender: 'user', content: 'Q1', createdAtMs: 100 },
    { id: 'a1', interactionId: 'ix1', parentMessageId: 'u1', sender: 'assistant', content: 'A1', createdAtMs: 110 },
    { id: 'u2', interactionId: 'ix2', sender: 'user', content: 'Q2', createdAtMs: 200 },
    { id: 'a2', interactionId: 'ix2', parentMessageId: 'u2', sender: 'assistant', content: 'A2', createdAtMs: 210 }
  ];

  const ordered = orderConversationMessages(messages);
  const keys = ordered.map((m, idx) => m.id || `msg-${idx}`);
  const keySet = new Set(keys);
  assert.equal(keySet.size, ordered.length, 'All message keys must be strictly unique');
});

// ----------------------------------------------------------------------------
// Test G: Retry & Switch Provider After Failure
// ----------------------------------------------------------------------------
console.log('\n--- Test G: Retry & Switch Provider After Failure ---');

runTest('G1: Retrying a failed message replaces it in-place and preserves user-response pair', () => {
  const u1 = { id: 'u1', interactionId: 'ix1', sender: 'user', content: 'Question 1', createdAtMs: 100 };
  const a1 = { id: 'a1', interactionId: 'ix1', parentMessageId: 'u1', sender: 'assistant', content: 'Answer 1', createdAtMs: 110 };
  const u2 = { id: 'u2', interactionId: 'ix2', sender: 'user', content: 'Question 2 (failed)', createdAtMs: 200 };
  const a2Failed = {
    id: 'a2-fail',
    interactionId: 'ix2',
    parentMessageId: 'u2',
    sender: 'assistant',
    isError: true,
    content: 'Network error 503',
    createdAtMs: 210
  };
  const u3 = { id: 'u3', interactionId: 'ix3', sender: 'user', content: 'Question 3', createdAtMs: 300 };
  const a3 = { id: 'a3', interactionId: 'ix3', parentMessageId: 'u3', sender: 'assistant', content: 'Answer 3', createdAtMs: 310 };

  const currentMessages = [u1, a1, u2, a2Failed, u3, a3];

  // User clicks retry on a2Failed:
  // ChatPage logic replaces a2Failed with a new streaming assistant message with same interactionId & parentMessageId
  const newAssistantId = 'a2-retry';
  const retriedAssistant = {
    id: newAssistantId,
    interactionId: 'ix2',
    parentMessageId: 'u2',
    sender: 'assistant',
    content: 'Retried success answer!',
    createdAtMs: 215,
    isStreaming: false
  };

  const replaced = currentMessages.map((m) => (m.id === 'a2-fail' ? retriedAssistant : m));
  const ordered = orderConversationMessages(replaced);

  assert.deepEqual(
    ordered.map((m) => m.id),
    ['u1', 'a1', 'u2', 'a2-retry', 'u3', 'a3'],
    'Retried message must stay attached directly under u2, NOT pushed to the end after u3/a3'
  );
});

// ----------------------------------------------------------------------------
// Test H: History Restoration & Export Fidelity
// ----------------------------------------------------------------------------
console.log('\n--- Test H: History Restoration & Export Fidelity ---');

runTest('H1: Sanitizing and restoring messages for storage preserves association IDs', () => {
  const original = {
    id: 'a1',
    interactionId: 'ix-test',
    parentMessageId: 'u1',
    sender: 'assistant',
    content: 'Hello world',
    createdAtMs: 5000,
    alternatives: [
      { id: 'alt-1', parentMessageId: 'u1', content: 'Hello alt', sender: 'assistant' }
    ]
  };

  const sanitized = sanitizeMessageForStorage(original);
  assert.equal(sanitized.id, 'a1');
  assert.equal(sanitized.interactionId, 'ix-test');
  assert.equal(sanitized.parentMessageId, 'u1');
  assert.equal(sanitized.alternatives[0].parentMessageId, 'u1');
});

runTest('H2: Markdown export groups each assistant response directly beneath its user question', () => {
  const u1 = { id: 'u1', interactionId: 'ix1', sender: 'user', content: 'Write a JavaScript function that adds two numbers.', createdAtMs: 100 };
  const u2 = { id: 'u2', interactionId: 'ix2', sender: 'user', content: 'Write a Python function.', createdAtMs: 200 };
  const a2 = { id: 'a2', interactionId: 'ix2', parentMessageId: 'u2', sender: 'assistant', content: 'def add(a, b): return a + b', createdAtMs: 210 };
  const a1 = { id: 'a1', interactionId: 'ix1', parentMessageId: 'u1', sender: 'assistant', content: 'function add(a, b) { return a + b; }', createdAtMs: 110 };

  // Even if passed out of order:
  const markdown = formatConversationMarkdown('My Code Chat', [u1, u2, a2, a1]);

  const jsQuestionPos = markdown.indexOf('Write a JavaScript function that adds two numbers.');
  const jsAnswerPos = markdown.indexOf('function add(a, b) { return a + b; }');
  const pyQuestionPos = markdown.indexOf('Write a Python function.');
  const pyAnswerPos = markdown.indexOf('def add(a, b): return a + b');

  assert.ok(jsQuestionPos < jsAnswerPos, 'JS question must precede JS answer');
  assert.ok(jsAnswerPos < pyQuestionPos, 'JS answer must appear before Python question');
  assert.ok(pyQuestionPos < pyAnswerPos, 'Python question must precede Python answer');
});

runTest('H3: Plaintext export groups each assistant response directly beneath its user question', () => {
  const u1 = { id: 'u1', interactionId: 'ix1', sender: 'user', content: 'Explain closures.', createdAtMs: 100 };
  const a1 = { id: 'a1', interactionId: 'ix1', parentMessageId: 'u1', sender: 'assistant', content: 'A closure is an inner function...', createdAtMs: 110 };

  const plainText = formatConversationPlainText('Closures', [u1, a1]);
  assert.ok(plainText.includes('USER'));
  assert.ok(plainText.includes('Explain closures.'));
  assert.ok(plainText.includes('ORVIX (ASSISTANT)'));
  assert.ok(plainText.includes('A closure is an inner function...'));
  assert.ok(plainText.indexOf('Explain closures.') < plainText.indexOf('A closure is an inner function...'));
});

runTest('H4: Sanitize filename creates clean safe filenames across OS environments', () => {
  assert.equal(sanitizeFilename('Write: A "JavaScript" <Function>?'), 'Write A JavaScript Function');
  assert.equal(sanitizeFilename(''), 'orvix-conversation');
  assert.equal(sanitizeFilename('CON'), 'CON-conversation');
});

console.log(`\n======================================================`);
console.log(`RESULTS: ${passedCount} PASSED, ${failedCount} FAILED`);
console.log(`======================================================\n`);

if (failedCount > 0) {
  process.exit(1);
}
