/**
 * Automated Verification & Benchmark Suite: Conversation Message Ordering Performance
 *
 * Verifies all behavioral invariants and memoization/performance guarantees:
 * 1. Deterministic message ordering across repeated and shuffled inputs.
 * 2. Parent/child and interactionId message relationships remain intact.
 * 3. Alternative responses (addition, switching, nested parent relationship edits) remain positioned accurately.
 * 4. Out-of-order responses are ordered accurately beneath their parent prompts.
 * 5. Streaming updates (on both ordered and out-of-order conversations) never produce stale message lists
 *    and skip full ordering recalculations when topology is unchanged.
 * 6. New, edited, replaced, and deleted messages are reflected immediately.
 * 7. Unchanged message inputs (same reference, shallow copies, and MessageList re-renders) do not trigger
 *    unnecessary recalculation.
 * 8. Empirical before-vs-after benchmarks across 10, 100, 500, and 1,000+ message conversations.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import esbuild from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  orderConversationMessages,
  createConversationOrderMemo,
  ensureConversationAlternatives,
  normalizeAssistantMessage,
  addAlternativeToAssistantMessage,
  switchActiveAlternativeInMessage,
  updateActiveAlternativeInMessage,
  createAlternativeRecord
} from '../src/services/alternativeResponseService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

import * as jsxRuntime from 'react/jsx-runtime';

globalThis.__TEST_REACT__ = React;
globalThis.__TEST_JSX_RUNTIME__ = jsxRuntime;

async function loadMessageListComponent() {
  const buildResult = await esbuild.build({
    entryPoints: [path.join(ROOT_DIR, 'src/components/chat/MessageList.jsx')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    plugins: [
      {
        name: 'stub-message-list-children',
        setup(build) {
          build.onResolve({ filter: /^react$/ }, (args) => ({
            path: args.path,
            namespace: 'react-bridge'
          }));
          build.onResolve({ filter: /^react\/jsx-runtime$/ }, (args) => ({
            path: args.path,
            namespace: 'jsx-bridge'
          }));
          build.onResolve({ filter: /^\.\/ChatMessage\.jsx$/ }, (args) => ({
            path: args.path,
            namespace: 'child-stub'
          }));
          build.onResolve({ filter: /^\.\/TypingIndicator\.jsx$/ }, (args) => ({
            path: args.path,
            namespace: 'typing-stub'
          }));
          build.onLoad({ filter: /.*/, namespace: 'react-bridge' }, () => ({
            contents: `
              const R = globalThis.__TEST_REACT__;
              export default R;
              export const { useRef, useMemo, memo, createElement } = R;
            `,
            loader: 'js'
          }));
          build.onLoad({ filter: /.*/, namespace: 'jsx-bridge' }, () => ({
            contents: `
              const J = globalThis.__TEST_JSX_RUNTIME__;
              export const { jsx, jsxs, Fragment } = J;
            `,
            loader: 'js'
          }));
          build.onLoad({ filter: /.*/, namespace: 'child-stub' }, () => ({
            contents: `
              import React from 'react';
              export default React.memo(function StubChatMessage({ message }) {
                return React.createElement(
                  'div',
                  { 'data-msg-id': message.id, 'data-sender': message.sender },
                  message.content
                );
              });
            `,
            loader: 'js'
          }));
          build.onLoad({ filter: /.*/, namespace: 'typing-stub' }, () => ({
            contents: `
              import React from 'react';
              export default function StubTypingIndicator() {
                return React.createElement('div', { 'data-typing': 'true' }, 'Typing...');
              }
            `,
            loader: 'js'
          }));
        }
      }
    ]
  });

  const code = buildResult.outputFiles[0].text;
  const mod = await import(
    `data:text/javascript;base64,${Buffer.from(code, 'utf8').toString('base64')}`
  );
  return mod.default;
}

/**
 * Exact baseline (pre-optimization) reference implementation of ensureConversationAlternatives +
 * orderConversationMessages used strictly for head-to-head parity and benchmark comparison.
 */
function legacyEnsureConversationAlternatives(messages = []) {
  if (!Array.isArray(messages)) return [];

  const userById = new Map();
  for (const m of messages) {
    if (m?.sender === 'user' && m.id) {
      userById.set(m.id, m);
    }
  }

  let lastUserMessage = null;
  let hasChanges = false;

  const next = messages.map((msg) => {
    if (!msg) return msg;
    if (msg.sender === 'user') {
      lastUserMessage = msg;
      return msg;
    }

    if (msg.sender === 'assistant') {
      const linkedUser =
        (msg.parentMessageId && userById.get(msg.parentMessageId)) ||
        (msg.interactionId &&
          Array.from(userById.values()).find((u) => u.interactionId === msg.interactionId)) ||
        lastUserMessage;
      const normalized = normalizeAssistantMessage(msg, linkedUser);
      if (normalized !== msg) {
        hasChanges = true;
      }
      return normalized;
    }

    return msg;
  });

  return hasChanges ? next : messages;
}

function legacyOrderConversationMessages(messages = []) {
  if (!Array.isArray(messages) || messages.length <= 1) {
    return Array.isArray(messages) ? [...messages] : [];
  }

  const normalized = legacyEnsureConversationAlternatives(messages);

  let isAlreadyOrdered = true;
  let activeParentUser = null;
  let lastUserTime = -Infinity;

  for (let i = 0; i < normalized.length; i++) {
    const m = normalized[i];
    if (!m) continue;
    if (m.sender === 'user') {
      const uTime = typeof m.createdAtMs === 'number' ? m.createdAtMs : (m.createdAt || null);
      if (uTime !== null && uTime < lastUserTime) {
        isAlreadyOrdered = false;
        break;
      }
      if (uTime !== null) {
        lastUserTime = uTime;
      }
      activeParentUser = m;
    } else if (m.sender === 'assistant') {
      if (!activeParentUser) {
        isAlreadyOrdered = false;
        break;
      }
      const pId = m.parentMessageId;
      if (pId && pId !== activeParentUser.id) {
        isAlreadyOrdered = false;
        break;
      }
    }
  }

  if (isAlreadyOrdered) {
    return normalized;
  }

  const userOrder = [];
  const userMap = new Map();
  const assistantBuckets = new Map();
  const leadingOrphans = [];
  const trailingOrphans = [];

  for (let i = 0; i < normalized.length; i++) {
    const m = normalized[i];
    if (!m) continue;
    if (m.sender === 'user') {
      if (!userMap.has(m.id)) {
        userOrder.push(m);
        userMap.set(m.id, m);
        assistantBuckets.set(m.id, []);
      } else {
        const idx = userOrder.findIndex((u) => u.id === m.id);
        if (idx >= 0) userOrder[idx] = m;
        userMap.set(m.id, m);
      }
    }
  }

  if (userOrder.length === 0) {
    return normalized;
  }

  let runningUser = null;
  for (let i = 0; i < normalized.length; i++) {
    const m = normalized[i];
    if (!m) continue;
    if (m.sender === 'user') {
      runningUser = m;
      continue;
    }
    if (m.sender === 'assistant') {
      let parentId = m.parentMessageId;
      if (!parentId && m.interactionId) {
        const found = userOrder.find(
          (u) => u.interactionId === m.interactionId || u.id === m.interactionId
        );
        if (found) parentId = found.id;
      }
      if (!parentId && runningUser) {
        parentId = runningUser.id;
      }
      if (parentId && assistantBuckets.has(parentId)) {
        const bucket = assistantBuckets.get(parentId);
        const existingIdx = bucket.findIndex((a) => a.id === m.id);
        if (existingIdx >= 0) {
          bucket[existingIdx] = m;
        } else {
          bucket.push(m);
        }
      } else if (!runningUser) {
        leadingOrphans.push(m);
      } else {
        trailingOrphans.push(m);
      }
    } else if (!runningUser) {
      leadingOrphans.push(m);
    } else {
      trailingOrphans.push(m);
    }
  }

  userOrder.sort((a, b) => {
    const timeA = typeof a.createdAtMs === 'number' ? a.createdAtMs : (a.createdAt || null);
    const timeB = typeof b.createdAtMs === 'number' ? b.createdAtMs : (b.createdAt || null);
    if (timeA !== null && timeB !== null && timeA !== timeB) {
      return timeA - timeB;
    }
    return 0;
  });

  const result = [...leadingOrphans];
  for (const userMsg of userOrder) {
    result.push(userMsg);
    const assistants = assistantBuckets.get(userMsg.id) || [];
    assistants.sort((a, b) => {
      const timeA = typeof a.createdAtMs === 'number' ? a.createdAtMs : (a.createdAt || 0);
      const timeB = typeof b.createdAtMs === 'number' ? b.createdAtMs : (b.createdAt || 0);
      return timeA - timeB;
    });
    for (const asst of assistants) {
      result.push(asst);
    }
  }
  for (const orphan of trailingOrphans) {
    result.push(orphan);
  }
  return result;
}

function buildConversation(totalMessages, { disordered = false } = {}) {
  const pairs = Math.floor(totalMessages / 2);
  const messages = [];
  const delayedAssistants = [];

  for (let i = 0; i < pairs; i++) {
    const userMsg = {
      id: `user-${i}`,
      interactionId: `ix-${i}`,
      sender: 'user',
      content: `User question #${i}`,
      createdAt: 1000 + i * 100,
      createdAtMs: 1000 + i * 100
    };
    const asstMsg = normalizeAssistantMessage(
      {
        id: `asst-${i}`,
        interactionId: `ix-${i}`,
        parentMessageId: userMsg.id,
        sender: 'assistant',
        provider: 'gemini',
        modelUsed: 'gemini-3.8-flash',
        content: `Initial response #${i}`,
        createdAt: 1050 + i * 100,
        createdAtMs: 1050 + i * 100,
        isStreaming: i === pairs - 1
      },
      userMsg
    );

    messages.push(userMsg);
    if (disordered && i % 4 === 0) {
      delayedAssistants.push(asstMsg);
    } else {
      messages.push(asstMsg);
    }
  }

  return messages.concat(delayedAssistants);
}

const MessageList = await loadMessageListComponent();

let passed = 0;
let failed = 0;

function runTest(name, fn) {
  try {
    fn();
    console.log(`  ✅ PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ FAIL: ${name}`);
    console.error(`     ${err.stack || err.message}`);
    failed++;
  }
}

console.log('================================================================');
console.log('🧪 Conversation Message Ordering Performance & Parity Suite');
console.log('================================================================\n');

// 1. Deterministic ordering & exact parity with legacy reference across shuffled inputs
runTest('1. Ordering remains deterministic and matches baseline across shuffled inputs', () => {
  const base = buildConversation(40, { disordered: true });
  const expectedIds = legacyOrderConversationMessages(base).map((m) => m.id);

  // Deterministic pseudo-random shuffles
  let seed = 42;
  const nextRand = () => {
    seed = (seed * 1664525 + 1013904223) % 0x100000000;
    return seed / 0x100000000;
  };

  const memo = createConversationOrderMemo();

  for (let trial = 0; trial < 10; trial++) {
    const shuffled = [...base];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(nextRand() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const orderedDirect = orderConversationMessages(shuffled);
    const orderedMemo = memo(shuffled);
    assert.deepEqual(orderedDirect.map((m) => m.id), expectedIds);
    assert.deepEqual(orderedMemo.map((m) => m.id), expectedIds);
  }
});

// 2. Parent/child & interactionId relationships
runTest('2. Parent/child and interactionId relationships remain strictly preserved', () => {
  const u1 = { id: 'u1', interactionId: 'ix-1', sender: 'user', content: 'Q1', createdAtMs: 100 };
  const u2 = { id: 'u2', interactionId: 'ix-2', sender: 'user', content: 'Q2', createdAtMs: 200 };
  // Assistant linked ONLY via interactionId (no parentMessageId yet)
  const a1ViaIx = {
    id: 'a1',
    interactionId: 'ix-1',
    sender: 'assistant',
    content: 'Answer 1 via interactionId',
    createdAtMs: 300
  };
  const a2 = {
    id: 'a2',
    interactionId: 'ix-2',
    parentMessageId: 'u2',
    sender: 'assistant',
    content: 'Answer 2',
    createdAtMs: 220
  };

  const memo = createConversationOrderMemo();
  const ordered = memo([u1, u2, a2, a1ViaIx]);
  assert.deepEqual(ordered.map((m) => m.id), ['u1', 'a1', 'u2', 'a2']);
  assert.equal(ordered[1].parentMessageId, 'u1');
  assert.equal(ordered[1].interactionId, 'ix-1');
  assert.equal(ordered[1].alternatives[0].parentMessageId, 'u1');
});

// 3. Alternative responses & nested relationship updates
runTest('3. Alternative responses (add, switch, and nested relationship edits) remain accurate', () => {
  let fullOrderCount = 0;
  const memo = createConversationOrderMemo({ onFullOrder: () => { fullOrderCount++; } });

  const conv = orderConversationMessages(buildConversation(20));
  const initial = memo(conv);
  assert.equal(fullOrderCount, 1);

  // Add an alternative to assistant message at index 5
  const targetAsst = initial[5];
  const newAlt = createAlternativeRecord({
    parentMessageId: targetAsst.parentMessageId,
    provider: 'groq',
    modelUsed: 'openai/gpt-oss-120b',
    content: 'Groq alternative content'
  });
  const withAddedAlt = initial.map((m, idx) =>
    idx === 5 ? addAlternativeToAssistantMessage(m, newAlt) : m
  );

  const orderedAfterAdd = memo(withAddedAlt);
  assert.equal(orderedAfterAdd[5].content, 'Groq alternative content');
  assert.equal(orderedAfterAdd[5].alternatives.length, 2);
  assert.equal(fullOrderCount, 1, 'Adding an alternative in-place should reuse slot topology');

  // Switch active alternative back to #0
  const firstAltId = orderedAfterAdd[5].alternatives[0].id;
  const withSwitchedAlt = orderedAfterAdd.map((m, idx) =>
    idx === 5 ? switchActiveAlternativeInMessage(m, firstAltId) : m
  );
  const orderedAfterSwitch = memo(withSwitchedAlt);
  assert.equal(orderedAfterSwitch[5].activeAlternativeId, firstAltId);
  assert.equal(orderedAfterSwitch[5].content, 'Initial response #2');
  assert.equal(fullOrderCount, 1, 'Switching active alternative should reuse slot topology');

  // Mutate a nested alternative with a missing/mismatched parentMessageId -> must NOT be ignored!
  const withCorruptedNestedAlt = orderedAfterSwitch.map((m, idx) =>
    idx === 5
      ? {
          ...m,
          alternatives: [{ ...m.alternatives[0], parentMessageId: null }]
        }
      : m
  );
  const orderedAfterNestedChange = memo(withCorruptedNestedAlt);
  assert.equal(
    fullOrderCount,
    2,
    'Nested alternative parentMessageId change must trigger full verification instead of being ignored'
  );
  assert.equal(orderedAfterNestedChange.length, 20);
});

// 4. Out-of-order responses
runTest('4. Out-of-order responses arriving mid-conversation are placed beneath their parent prompt', () => {
  let fullOrderCount = 0;
  const memo = createConversationOrderMemo({ onFullOrder: () => { fullOrderCount++; } });

  const u1 = { id: 'u1', interactionId: 'ix1', sender: 'user', content: 'Slow Q1', createdAtMs: 100 };
  const u2 = { id: 'u2', interactionId: 'ix2', sender: 'user', content: 'Fast Q2', createdAtMs: 200 };
  const a2 = normalizeAssistantMessage(
    { id: 'a2', interactionId: 'ix2', parentMessageId: 'u2', sender: 'assistant', content: 'Fast A2', createdAtMs: 210 },
    u2
  );

  const step1 = memo([u1, u2, a2]);
  assert.deepEqual(step1.map((m) => m.id), ['u1', 'u2', 'a2']);
  assert.equal(fullOrderCount, 1);

  // Slow response a1 arrives at the tail of the raw array
  const a1 = normalizeAssistantMessage(
    { id: 'a1', interactionId: 'ix1', parentMessageId: 'u1', sender: 'assistant', content: 'Slow A1', createdAtMs: 500 },
    u1
  );
  const step2 = memo([...step1, a1]);
  assert.deepEqual(step2.map((m) => m.id), ['u1', 'a1', 'u2', 'a2']);
  assert.equal(fullOrderCount, 2);
});

// 5. Streaming updates on BOTH ordered and out-of-order conversations never produce stale lists
runTest('5. Streaming updates reflect every token immediately without redundant full re-ordering', () => {
  // 5A: Streaming on canonically ordered 200-message conversation
  let orderedFullCount = 0;
  const orderedMemo = createConversationOrderMemo({ onFullOrder: () => { orderedFullCount++; } });
  let state = orderedMemo(buildConversation(200));
  assert.equal(orderedFullCount, 1);

  const streamingId = state[state.length - 1].id;
  for (let chunk = 1; chunk <= 50; chunk++) {
    const expectedText = `Streamed token #${chunk}`;
    const next = state.map((m) =>
      m.id === streamingId
        ? updateActiveAlternativeInMessage(m, { content: expectedText, isStreaming: chunk < 50 })
        : m
    );
    state = orderedMemo(next);
    assert.equal(state[state.length - 1].content, expectedText, 'Streaming text must never be stale');
    assert.equal(state[state.length - 1].isStreaming, chunk < 50);
    // Unchanged earlier message references must remain strictly identical
    assert.equal(state[0], next[0]);
  }
  assert.equal(orderedFullCount, 1, '50 streaming frames must trigger 0 additional full order passes');

  // 5B: Streaming on an out-of-order raw array ([u1, u2, a2, a1_streaming])
  let disorderedFullCount = 0;
  const disorderedMemo = createConversationOrderMemo({ onFullOrder: () => { disorderedFullCount++; } });
  const u1 = { id: 'u1', interactionId: 'ix1', sender: 'user', content: 'Q1', createdAtMs: 100 };
  const u2 = { id: 'u2', interactionId: 'ix2', sender: 'user', content: 'Q2', createdAtMs: 200 };
  const a2 = normalizeAssistantMessage(
    { id: 'a2', interactionId: 'ix2', parentMessageId: 'u2', sender: 'assistant', content: 'A2', createdAtMs: 210 },
    u2
  );
  let a1Stream = normalizeAssistantMessage(
    { id: 'a1', interactionId: 'ix1', parentMessageId: 'u1', sender: 'assistant', content: '', isStreaming: true, createdAtMs: 220 },
    u1
  );

  let rawDisordered = [u1, u2, a2, a1Stream];
  let orderedDisordered = disorderedMemo(rawDisordered);
  assert.deepEqual(orderedDisordered.map((m) => m.id), ['u1', 'a1', 'u2', 'a2']);
  assert.equal(disorderedFullCount, 1);

  for (let chunk = 1; chunk <= 20; chunk++) {
    a1Stream = updateActiveAlternativeInMessage(a1Stream, {
      content: `Disordered chunk ${chunk}`,
      isStreaming: chunk < 20
    });
    rawDisordered = [u1, u2, a2, a1Stream];
    orderedDisordered = disorderedMemo(rawDisordered);
    assert.deepEqual(orderedDisordered.map((m) => m.id), ['u1', 'a1', 'u2', 'a2']);
    assert.equal(orderedDisordered[1].content, `Disordered chunk ${chunk}`);
    assert.equal(orderedDisordered[3], a2);
  }
  assert.equal(
    disorderedFullCount,
    1,
    'Streaming an out-of-order response must patch target slot without full bucket re-sorting'
  );
});

// 6. New, edited, and deleted messages are reflected immediately
runTest('6. Adding, editing, truncating, and deleting messages update ordering immediately', () => {
  const memo = createConversationOrderMemo();
  const initial = memo(buildConversation(10));
  assert.equal(initial.length, 10);

  // Add a new turn
  const newU = { id: 'user-new', interactionId: 'ix-new', sender: 'user', content: 'New prompt', createdAtMs: 9000 };
  const newA = normalizeAssistantMessage(
    { id: 'asst-new', interactionId: 'ix-new', parentMessageId: 'user-new', sender: 'assistant', content: 'New answer', createdAtMs: 9050 },
    newU
  );
  const added = memo([...initial, newU, newA]);
  assert.equal(added.length, 12);
  assert.equal(added[10].id, 'user-new');
  assert.equal(added[11].id, 'asst-new');

  // Edit user message in place
  const edited = memo(
    added.map((m) => (m.id === 'user-0' ? { ...m, content: 'Edited user question #0' } : m))
  );
  assert.equal(edited[0].content, 'Edited user question #0');

  // Delete / truncate messages (simulating handleRestorePrompt or handleEditResend branch truncation)
  const truncated = memo(edited.slice(0, 6));
  assert.equal(truncated.length, 6);
  assert.deepEqual(
    truncated.map((m) => m.id),
    ['user-0', 'asst-0', 'user-1', 'asst-1', 'user-2', 'asst-2']
  );
});

// 7. Unchanged message inputs do not trigger unnecessary recalculation + MessageList SSR verification
runTest('7. Unchanged message inputs and shallow copies preserve reference identity without recalculating', () => {
  let fullOrderCount = 0;
  const memo = createConversationOrderMemo({ onFullOrder: () => { fullOrderCount++; } });

  const conv = orderConversationMessages(buildConversation(100));
  const out1 = memo(conv);
  assert.equal(fullOrderCount, 1);

  // Exact same array reference
  const out2 = memo(conv);
  assert.equal(out2, out1);
  assert.equal(fullOrderCount, 1);

  // Shallow array copy with identical message object references
  const shallowCopy = [...conv];
  const out3 = memo(shallowCopy);
  assert.equal(out3, out1, 'Shallow copy with unchanged message objects must preserve exact output reference');
  assert.equal(fullOrderCount, 1);

  // Empty and single-element reference stability
  const empty = [];
  assert.equal(orderConversationMessages(empty), empty);
  const single = [{ id: 'u-only', sender: 'user', content: 'Solo' }];
  assert.equal(orderConversationMessages(single), single);

  // Verify MessageList component renders ordered messages & typing indicator accurately
  const html = renderToStaticMarkup(
    React.createElement(MessageList, {
      messages: [conv[2], conv[0], conv[1], conv[3]], // disordered subset: u1, u0, a0, a1
      isLoading: true
    })
  );
  const posU0 = html.indexOf('data-msg-id="user-0"');
  const posA0 = html.indexOf('data-msg-id="asst-0"');
  const posU1 = html.indexOf('data-msg-id="user-1"');
  const posA1 = html.indexOf('data-msg-id="asst-1"');
  assert.ok(posU0 >= 0 && posU0 < posA0 && posA0 < posU1 && posU1 < posA1);
});

// ============================================================================
// Empirical Before-vs-After Benchmarks
// ============================================================================
console.log('\n----------------------------------------------------------------');
console.log('📊 Empirical Benchmark: Legacy vs Optimized Message Ordering');
console.log('----------------------------------------------------------------');

const SIZES = [10, 100, 500, 1000];
const STREAM_FRAMES = 200;
const RERENDER_ITERATIONS = 1000;

for (const size of SIZES) {
  const orderedSeed = orderConversationMessages(buildConversation(size, { disordered: false }));
  const disorderedSeed = buildConversation(size, { disordered: true });

  // Pre-build 200 streaming frame snapshots so array/message construction time is excluded from timing!
  const orderedFrames = [];
  let curOrd = orderedSeed;
  const lastOrdId = curOrd[curOrd.length - 1].id;
  for (let f = 0; f < STREAM_FRAMES; f++) {
    curOrd = curOrd.map((m) =>
      m.id === lastOrdId
        ? updateActiveAlternativeInMessage(m, { content: `Token ${f}`, isStreaming: f < STREAM_FRAMES - 1 })
        : m
    );
    orderedFrames.push(curOrd);
  }

  const disorderedFrames = [];
  let curDis = disorderedSeed;
  const lastDisId = curDis[curDis.length - 1].id;
  for (let f = 0; f < STREAM_FRAMES; f++) {
    curDis = curDis.map((m) =>
      m.id === lastDisId
        ? updateActiveAlternativeInMessage(m, { content: `Token ${f}`, isStreaming: f < STREAM_FRAMES - 1 })
        : m
    );
    disorderedFrames.push(curDis);
  }

  const shallowCopies = Array.from({ length: RERENDER_ITERATIONS }, () => [...orderedSeed]);

  // JIT Warmup
  const warmPageMemo = createConversationOrderMemo();
  const warmListMemo = createConversationOrderMemo();
  for (let w = 0; w < 30; w++) {
    legacyOrderConversationMessages(orderedFrames[w % orderedFrames.length]);
    orderConversationMessages(orderedFrames[w % orderedFrames.length]);
    warmListMemo(warmPageMemo(orderedFrames[w % orderedFrames.length]));
  }

  // Benchmark A: 200 Streaming Updates (ChatPage.updateMessagesState + MessageList.useMemo) on Ordered Chat
  const tLegStream0 = performance.now();
  for (let f = 0; f < STREAM_FRAMES; f++) {
    const s = legacyOrderConversationMessages(orderedFrames[f]);
    legacyOrderConversationMessages(s);
  }
  const legacyOrderedStreamMs = performance.now() - tLegStream0;

  const pageMemoA = createConversationOrderMemo();
  const listMemoA = createConversationOrderMemo();
  pageMemoA(orderedSeed);
  listMemoA(orderedSeed);
  const tOptStream0 = performance.now();
  for (let f = 0; f < STREAM_FRAMES; f++) {
    const s = pageMemoA(orderedFrames[f]);
    listMemoA(s);
  }
  const optOrderedStreamMs = performance.now() - tOptStream0;

  // Benchmark B: 200 Streaming Updates on Out-of-Order Chat (MessageList receiving disordered raw frames)
  const tLegDis0 = performance.now();
  for (let f = 0; f < STREAM_FRAMES; f++) {
    legacyOrderConversationMessages(disorderedFrames[f]);
  }
  const legacyDisorderedStreamMs = performance.now() - tLegDis0;

  const listMemoB = createConversationOrderMemo();
  listMemoB(disorderedSeed);
  const tOptDis0 = performance.now();
  for (let f = 0; f < STREAM_FRAMES; f++) {
    listMemoB(disorderedFrames[f]);
  }
  const optDisorderedStreamMs = performance.now() - tOptDis0;

  // Benchmark C: 1,000 Unchanged Input Calls (Same Reference & Shallow Array Copy)
  const tLegSame0 = performance.now();
  for (let r = 0; r < RERENDER_ITERATIONS; r++) {
    legacyOrderConversationMessages(shallowCopies[r]);
  }
  const legacyShallowUnchangedMs = performance.now() - tLegSame0;

  const listMemoC = createConversationOrderMemo();
  listMemoC(orderedSeed);
  const tOptShallow0 = performance.now();
  for (let r = 0; r < RERENDER_ITERATIONS; r++) {
    listMemoC(shallowCopies[r]);
  }
  const optShallowUnchangedMs = performance.now() - tOptShallow0;

  const tOptSameRef0 = performance.now();
  for (let r = 0; r < RERENDER_ITERATIONS; r++) {
    listMemoC(orderedSeed);
  }
  const optSameRefMs = performance.now() - tOptSameRef0;

  console.log(
    `[${size} msgs] ` +
      `Ordered Stream (${STREAM_FRAMES} frames): ${legacyOrderedStreamMs.toFixed(2)}ms -> ${optOrderedStreamMs.toFixed(2)}ms (${(legacyOrderedStreamMs / Math.max(optOrderedStreamMs, 0.001)).toFixed(1)}x) | ` +
      `Disordered Stream (${STREAM_FRAMES} frames): ${legacyDisorderedStreamMs.toFixed(2)}ms -> ${optDisorderedStreamMs.toFixed(2)}ms (${(legacyDisorderedStreamMs / Math.max(optDisorderedStreamMs, 0.001)).toFixed(1)}x) | ` +
      `Unchanged Copy (${RERENDER_ITERATIONS}x): ${legacyShallowUnchangedMs.toFixed(2)}ms -> ${optShallowUnchangedMs.toFixed(2)}ms | ` +
      `Same Ref (${RERENDER_ITERATIONS}x): ${optSameRefMs.toFixed(3)}ms`
  );
}

console.log('\n================================================================');
console.log(`📊 Suite Results: ${passed} passed, ${failed} failed`);
console.log('================================================================\n');

if (failed > 0) {
  process.exit(1);
}
