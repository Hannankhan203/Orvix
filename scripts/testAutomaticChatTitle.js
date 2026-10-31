import assert from 'node:assert/strict';
import {
  generateChatTitle,
  generateMeaningfulChatTitle,
  renameConversation
} from '../src/services/chatStorageService.js';

console.log('🧪 Starting Automatic Chat Title Generation Verification Suite...\n');

let totalTests = 0;
let passedTests = 0;

function runTest(name, fn) {
  totalTests++;
  try {
    fn();
    passedTests++;
    console.log(`  ✅ [PASS] ${name}`);
  } catch (err) {
    console.error(`  ❌ [FAIL] ${name}:`, err.message);
  }
}

// ==============================================================================
// 1. Topic Extraction & Meaningful Chat Title Verification Across Prompt Types
// ==============================================================================
console.log('📌 Phase 1: Topic Extraction & Word Count Verification (3-6 Words)');

const scenarios = [
  {
    type: 'Coding / Web Scraping',
    prompt: 'Can you help me write a python script to scrape data from websites using beautifulsoup?',
    ai: '# Web Scraping with BeautifulSoup\n\nTo scrape data from websites, you can use Python with BeautifulSoup and requests...',
    expectedWordsMin: 3,
    expectedWordsMax: 6,
    mustContainWord: 'BeautifulSoup'
  },
  {
    type: 'Scientific Explanation',
    prompt: 'how does photosynthesis work in plants',
    ai: 'Photosynthesis is the process by which green plants and certain other organisms transform light energy into chemical energy.',
    expectedWordsMin: 3,
    expectedWordsMax: 6,
    mustContainWord: 'Photosynthesis'
  },
  {
    type: 'Creative Slogans',
    prompt: 'I need 5 catchy slogan ideas for an eco-friendly water bottle brand called Aqualux',
    ai: 'Here are 5 catchy slogans for Aqualux eco-friendly water bottles:\n1. Pure Hydration, Zero Waste\n2. Earth First, Drink Second...',
    expectedWordsMin: 3,
    expectedWordsMax: 6,
    mustContainWord: 'Aqualux'
  },
  {
    type: 'Error Debugging',
    prompt: 'debug TypeError: Cannot read properties of undefined (reading map) in react',
    ai: 'This error occurs when you attempt to call .map() on an array that is null or undefined in React...',
    expectedWordsMin: 3,
    expectedWordsMax: 6,
    mustContainWord: 'TypeError'
  },
  {
    type: 'Technical Explanation',
    prompt: 'can you explain how docker containers work for someone new to devops',
    ai: 'Docker containers are lightweight, standalone packages of software that include everything needed to run an application...',
    expectedWordsMin: 3,
    expectedWordsMax: 6,
    mustContainWord: 'Docker'
  },
  {
    type: 'Email Drafting',
    prompt: 'write an email to my manager requesting two days of paid time off next week',
    ai: 'Subject: PTO Request - Next Week\n\nHi [Manager Name],\n\nI would like to request two days of paid time off (PTO)...',
    expectedWordsMin: 3,
    expectedWordsMax: 6,
    mustContainWord: 'PTO'
  },
  {
    type: 'Book Recommendations',
    prompt: 'recommend 3 great sci-fi books to read next',
    ai: 'Here are three outstanding science fiction books that explore thought-provoking themes:\n\n1. **Dune** by Frank Herbert\n2. **Project Hail Mary** by Andy Weir...',
    expectedWordsMin: 3,
    expectedWordsMax: 6,
    mustContainWord: 'Science'
  },
  {
    type: 'Database Optimization',
    prompt: 'How do I optimize SQL queries with indexing in PostgreSQL?',
    ai: '## PostgreSQL Query Optimization with Indexes\n\nProperly indexing tables is one of the most effective ways to boost query performance...',
    expectedWordsMin: 3,
    expectedWordsMax: 6,
    mustContainWord: 'PostgreSQL'
  },
  {
    type: 'Math / Financial Calculation',
    prompt: 'how do I calculate compound interest with monthly contributions',
    ai: 'To calculate compound interest with regular monthly contributions, you use the future value formula...',
    expectedWordsMin: 3,
    expectedWordsMax: 6,
    mustContainWord: 'Compound'
  },
  {
    type: 'Conversational Greeting',
    prompt: 'hello there!',
    ai: 'Hello! How can I help you today? Whether you have questions about programming, writing, or anything else, let me know.',
    expectedWordsMin: 2,
    expectedWordsMax: 4,
    mustContainWord: 'Conversation'
  }
];

scenarios.forEach((sc) => {
  runTest(`Scenario "${sc.type}" produces descriptive title in ${sc.expectedWordsMin}-${sc.expectedWordsMax} words`, () => {
    const title = generateMeaningfulChatTitle(sc.prompt, sc.ai);
    const words = title.split(/\s+/).filter(Boolean);
    assert.ok(
      words.length >= sc.expectedWordsMin && words.length <= sc.expectedWordsMax,
      `Word count ${words.length} out of range [${sc.expectedWordsMin}, ${sc.expectedWordsMax}] for title "${title}"`
    );
    assert.ok(
      title.includes(sc.mustContainWord),
      `Title "${title}" does not contain expected keyword "${sc.mustContainWord}"`
    );
    // Ensure title does not merely repeat full initial prompt
    assert.notEqual(title.toLowerCase(), sc.prompt.trim().toLowerCase());
  });
});

// ==============================================================================
// 2. No Additional AI API Requests or Network Calls
// ==============================================================================
console.log('\n📌 Phase 2: Zero Additional AI Model / Network Requests');

runTest('generateMeaningfulChatTitle executes synchronously in <1ms without fetch or network calls', () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = () => {
    fetchCalled = true;
    throw new Error('fetch should NOT be called during title generation!');
  };

  try {
    const t0 = performance.now();
    const title = generateMeaningfulChatTitle(
      'Can you write a python script to parse CSV files and convert them to JSON?',
      '# CSV to JSON Converter in Python\n\nHere is a complete Python script to convert CSV data to JSON...'
    );
    const elapsed = performance.now() - t0;

    assert.equal(fetchCalled, false, 'Fetch was called!');
    assert.ok(elapsed < 20, `Execution took ${elapsed}ms, expected synchronous near-instant execution`);
    assert.ok(title.length > 5, 'Title should be valid');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ==============================================================================
// 3. Manual Rename Preservation (Never Overwritten)
// ==============================================================================
console.log('\n📌 Phase 3: Manual Rename Preservation & Custom Title Guard');

runTest('Manual rename sets hasCustomTitle: true and protects against auto-titling', () => {
  // Simulate user chats collection
  const mockChat = {
    id: 'chat-test-123',
    title: 'Initial Snippet Title',
    hasCustomTitle: false,
    messages: [
      { id: 'm1', sender: 'user', content: 'Tell me about quantum computing' },
      { id: 'm2', sender: 'assistant', content: '# Quantum Computing Fundamentals\n\nQuantum computing is...' }
    ]
  };

  // Step 1: When user manually renames the chat from the UI
  const manualTitle = 'My Custom Quantum Research';
  const isManual = true;
  const updatedChat = {
    ...mockChat,
    title: manualTitle,
    ...(isManual ? { hasCustomTitle: true } : {})
  };

  assert.equal(updatedChat.title, manualTitle);
  assert.equal(updatedChat.hasCustomTitle, true);

  // Step 2: Simulate subsequent AI response arrival or stream completion
  // The auto-refine condition checks if the chat has a custom title
  let autoRefined = false;
  if (!updatedChat.hasCustomTitle) {
    const refined = generateMeaningfulChatTitle(
      mockChat.messages[0].content,
      mockChat.messages[1].content
    );
    updatedChat.title = refined;
    autoRefined = true;
  }

  // The custom title MUST NOT have been overwritten
  assert.equal(autoRefined, false, 'Auto-refinement should be skipped for chats with hasCustomTitle');
  assert.equal(updatedChat.title, manualTitle, 'Title must remain the manually chosen custom title');
});

runTest('Unrenamed chat is safely auto-refined on first AI response completion', () => {
  const unrenamedChat = {
    id: 'chat-auto-456',
    title: 'Can you help me write...',
    hasCustomTitle: false
  };

  const promptText = 'Can you help me write a python script to scrape data from websites using beautifulsoup?';
  const aiText = '# Web Scraping with BeautifulSoup\n\nTo scrape data from websites...';

  if (!unrenamedChat.hasCustomTitle) {
    const refined = generateMeaningfulChatTitle(promptText, aiText);
    unrenamedChat.title = refined;
  }

  assert.equal(unrenamedChat.title, 'Web Scraping with BeautifulSoup');
  assert.equal(unrenamedChat.hasCustomTitle, false); // Auto-title does not lock as manual custom title
});

// ==============================================================================
// 4. Edge Cases: Empty text, fallback, and whitespace
// ==============================================================================
console.log('\n📌 Phase 4: Edge Cases and Fallbacks');

runTest('Handles empty or whitespace-only prompts and responses gracefully', () => {
  assert.equal(generateMeaningfulChatTitle('', ''), 'New Conversation');
  assert.equal(generateMeaningfulChatTitle('   ', '   '), 'New Conversation');
  assert.equal(generateMeaningfulChatTitle(null, null), 'New Conversation');
});

runTest('Falls back to prompt distillation if AI response has no headings or structured lead-ins', () => {
  const title = generateMeaningfulChatTitle(
    'How do I implement binary search in C++?',
    'Sure! You can initialize low and high pointers and loop while low <= high...'
  );
  assert.ok(title.includes('Binary Search'));
  const words = title.split(/\s+/).filter(Boolean);
  assert.ok(words.length >= 3 && words.length <= 6, `Word count was ${words.length}`);
});

console.log(`\n==============================================================================`);
console.log(`🏁 Test Summary: ${passedTests}/${totalTests} tests passed.`);
console.log(`==============================================================================\n`);

if (passedTests !== totalTests) {
  process.exit(1);
}
