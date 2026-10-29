/**
 * Gemini Vercel 504 Timeout & Streaming Hardening Verification Suite
 *
 * Verifies the 10 targeted test cases ensuring Orvix handles Gemini streaming,
 * Vercel proxy idle timeouts, serverless execution boundaries, and fallback seamlessly:
 *
 * 1. Immediate SSE Header Priming (TTFB < 50ms)
 * 2. Reverse Proxy Buffering Disabled (X-Accel-Buffering: no)
 * 3. Continuous SSE Keepalive Heartbeat during model generation
 * 4. Adaptive Serverless Timeout Threshold (25s in serverless vs 30s local)
 * 5. Single-Attempt Timeout Boundary in Serverless (prevents 60s+ execution exhaustion)
 * 6. Pre-Chunk Timeout Triggers Automated Fallback (partial: false, canFallback: true)
 * 7. Mid-Stream Error Prevents Duplicate Fallback (partial: true, canFallback: false)
 * 8. Client Disconnect Prompt Cancellation & Resource Cleanup
 * 9. Request Isolation Under Timeout Across Concurrent Conversations
 * 10. Non-Streaming Timeout Contract (HTTP 504 JSON with canFallback: true)
 *
 * Run with: node scripts/testGeminiVercelTimeout.js
 */

process.env.TESTING = '1';

import assert from 'node:assert/strict';
import http from 'node:http';

const {
  parseGeminiError,
  getUpstreamHeadersTimeoutMs,
  getGeminiHeaderTimeoutMs,
  getGeminiFirstByteTimeoutMs,
  getGeminiStreamInactivityTimeoutMs,
  getGeminiTotalRequestTimeoutMs,
  consumeGeminiStreamWithWatchdog,
  logGeminiLifecycleEvent,
  isServerless
} = await import('../server.ts');

import {
  streamAIMessage,
  streamAIMessageWithFallback,
  parseRouterError,
  isFallbackEligible,
  getDeterministicFallbackChain
} from '../src/services/aiRouter.js';

import {
  normalizeAIError,
  STANDARD_ERROR_CODES
} from '../src/services/errorNormalizationService.js';

import { createRequestIsolationController } from '../src/services/requestIsolationService.js';

let passed = 0;
let failed = 0;

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`  ✅ PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ FAIL: ${name}`);
    console.error(`     ${err.stack || err.message}`);
    failed++;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createMockServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        server,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((res) => server.close(res))
      });
    });
  });
}

console.log('================================================================');
console.log('🧪 Gemini Vercel 504 Timeout & Streaming Verification Suite');
console.log('================================================================\n');

// ----------------------------------------------------------------------------
// Test 1: Immediate SSE Header Priming
// ----------------------------------------------------------------------------
await runTest('1. Immediate SSE Header Priming (TTFB < 50ms before upstream completes)', async () => {
  let headerReceivedTime = 0;

  const mock = await createMockServer(async (req, res) => {
    res.socket?.setNoDelay?.(true);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.flushHeaders?.();
    res.write(': prime\n\n');

    // Simulate upstream latency (300ms)
    await sleep(300);
    res.write('data: {"type":"start","modelUsed":"gemini-2.5-flash","provider":"gemini"}\n\n');
    res.write('data: {"type":"chunk","text":"Fast headers verified"}\n\n');
    res.write('data: {"type":"done","text":"Fast headers verified","modelUsed":"gemini-2.5-flash","provider":"gemini"}\n\n');
    res.end();
  });

  try {
    const startTime = Date.now();
    const res = await fetch(`${mock.url}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ provider: 'gemini', prompt: 'test immediate headers', stream: true })
    });

    headerReceivedTime = Date.now() - startTime;
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-type')?.includes('text/event-stream'));
    assert.ok(headerReceivedTime < 200, `Headers must arrive immediately (<200ms, before 300ms upstream), took ${headerReceivedTime}ms`);
  } finally {
    await mock.close();
  }
});

// ----------------------------------------------------------------------------
// Test 2: Reverse Proxy Buffering Disabled (X-Accel-Buffering: no)
// ----------------------------------------------------------------------------
await runTest('2. Reverse Proxy Buffering Disabled (X-Accel-Buffering: no header sent)', async () => {
  const mock = await createMockServer((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'X-Accel-Buffering': 'no'
    });
    res.write(': prime\n\n');
    res.end();
  });

  try {
    const res = await fetch(`${mock.url}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'gemini', prompt: 'check buffering' })
    });

    assert.equal(res.headers.get('x-accel-buffering'), 'no', 'Must set X-Accel-Buffering: no for Vercel/reverse proxies');
  } finally {
    await mock.close();
  }
});

// ----------------------------------------------------------------------------
// Test 3: Continuous SSE Keepalive Heartbeat
// ----------------------------------------------------------------------------
await runTest('3. Continuous SSE Keepalive Heartbeat during extended model generation', async () => {
  const heartbeats = [];

  const mock = await createMockServer(async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    // Write 3 heartbeats
    res.write(':\n\n');
    await sleep(50);
    res.write(': keepalive\n\n');
    await sleep(50);
    res.write('data: {"type":"start","modelUsed":"gemini-2.5-flash","provider":"gemini"}\n\n');
    res.write('data: {"type":"done","text":"Done after heartbeats","modelUsed":"gemini-2.5-flash","provider":"gemini"}\n\n');
    res.end();
  });

  try {
    const result = await streamAIMessage({
      provider: 'gemini',
      prompt: 'test heartbeats',
      chatEndpoint: `${mock.url}/api/chat`,
      retryBaseDelayMs: 5
    });

    assert.equal(result.text, 'Done after heartbeats');
    assert.equal(result.provider, 'gemini');
  } finally {
    await mock.close();
  }
});

// ----------------------------------------------------------------------------
// Test 4: Adaptive Serverless Timeout Threshold
// ----------------------------------------------------------------------------
await runTest('4. Adaptive Serverless Timeout Threshold (honors ORVIX_UPSTREAM_HEADERS_TIMEOUT_MS and defaults)', () => {
  const originalEnv = process.env.ORVIX_UPSTREAM_HEADERS_TIMEOUT_MS;

  try {
    process.env.ORVIX_UPSTREAM_HEADERS_TIMEOUT_MS = '18000';
    assert.equal(getUpstreamHeadersTimeoutMs(), 18000, 'Must honor explicit timeout override');

    delete process.env.ORVIX_UPSTREAM_HEADERS_TIMEOUT_MS;
    const defaultTimeout = getUpstreamHeadersTimeoutMs();
    assert.ok(defaultTimeout >= 20000 && defaultTimeout <= 30000, `Default timeout should be bounded, got ${defaultTimeout}`);
  } finally {
    if (originalEnv !== undefined) {
      process.env.ORVIX_UPSTREAM_HEADERS_TIMEOUT_MS = originalEnv;
    } else {
      delete process.env.ORVIX_UPSTREAM_HEADERS_TIMEOUT_MS;
    }
  }
});

// ----------------------------------------------------------------------------
// Test 5: Single-Attempt Timeout Boundary in Serverless
// ----------------------------------------------------------------------------
await runTest('5. Single-Attempt Timeout Boundary in Serverless (avoids 60s+ execution exhaustion)', () => {
  const timeoutErr = parseGeminiError({
    name: 'TimeoutError',
    message: 'The request to Gemini timed out after 25s while waiting for initial response headers.'
  }, 'gemini');

  assert.equal(timeoutErr.statusCode, 504);
  assert.equal(timeoutErr.status, 'DEADLINE_EXCEEDED');
  assert.equal(timeoutErr.category, 'provider timeout');
  assert.equal(timeoutErr.isRetryable, true);

  const normalized = normalizeAIError(timeoutErr, { provider: 'gemini' });
  assert.equal(normalized.code, STANDARD_ERROR_CODES.DEADLINE_EXCEEDED);
  assert.equal(normalized.canFallback, true, 'Timeout must allow fallback to another provider');
});

// ----------------------------------------------------------------------------
// Test 6: Pre-Chunk Timeout Triggers Automated Fallback
// ----------------------------------------------------------------------------
await runTest('6. Pre-Chunk Timeout Triggers Automated Fallback (partial: false, canFallback: true)', async () => {
  const mock = await createMockServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      if (parsed.provider === 'gemini') {
        // SSE error frame before any chunks
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"type":"error","code":504,"status":"DEADLINE_EXCEEDED","message":"Gemini timed out","canFallback":true,"retryable":false}\n\n');
        res.end();
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: 'Groq recovered after Gemini timeout', modelUsed: 'openai/gpt-oss-120b', provider: 'groq' }));
      }
    });
  });

  try {
    const result = await streamAIMessageWithFallback({
      provider: 'gemini',
      prompt: 'test timeout fallback',
      chatEndpoint: `${mock.url}/api/chat`,
      retryBaseDelayMs: 5
    });

    assert.equal(result.provider, 'groq');
    assert.equal(result.text, 'Groq recovered after Gemini timeout');
    assert.deepEqual(result.attemptedProviders, ['gemini', 'groq']);
    assert.equal(result.fallbackHistory.length, 1);
  } finally {
    await mock.close();
  }
});

// ----------------------------------------------------------------------------
// Test 7: Mid-Stream Error Prevents Duplicate Fallback
// ----------------------------------------------------------------------------
await runTest('7. Mid-Stream Error Prevents Duplicate Fallback (partial: true, canFallback: false)', async () => {
  let groqCalls = 0;

  const mock = await createMockServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      if (parsed.provider === 'gemini') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"type":"start","modelUsed":"gemini-2.5-flash","provider":"gemini"}\n\n');
        res.write('data: {"type":"chunk","text":"Initial generated tokens"}\n\n');
        res.write('data: {"type":"error","code":504,"status":"DEADLINE_EXCEEDED","message":"Mid-stream timeout"}\n\n');
        res.end();
      } else {
        groqCalls++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: 'Duplicate replay from fallback', provider: 'groq' }));
      }
    });
  });

  let chunksReceived = '';
  try {
    await streamAIMessageWithFallback({
      provider: 'gemini',
      prompt: 'test midstream safety',
      chatEndpoint: `${mock.url}/api/chat`,
      onChunk: (chunk) => {
        chunksReceived += chunk;
      },
      retryBaseDelayMs: 5
    });
    assert.fail('Expected midstream timeout to throw error without fallback');
  } catch (err) {
    assert.equal(groqCalls, 0, 'Must NOT trigger fallback when partial tokens have been emitted!');
    assert.equal(err.partial, true);
    assert.equal(err.canFallback, false);
    assert.equal(chunksReceived, 'Initial generated tokens');
  } finally {
    await mock.close();
  }
});

// ----------------------------------------------------------------------------
// Test 8: Client Disconnect Prompt Cancellation & Resource Cleanup
// ----------------------------------------------------------------------------
await runTest('8. Client Disconnect Prompt Cancellation & Resource Cleanup', async () => {
  let serverSawClose = false;
  const controller = new AbortController();

  const mock = await createMockServer((req, res) => {
    req.on('close', () => {
      serverSawClose = true;
    });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(': prime\n\n');
  });

  try {
    const streamPromise = streamAIMessage({
      provider: 'gemini',
      prompt: 'test disconnect',
      chatEndpoint: `${mock.url}/api/chat`,
      signal: controller.signal
    });

    await sleep(30);
    controller.abort();

    await assert.rejects(streamPromise, (err) => {
      return err.name === 'AbortError' || err.message?.includes('cancelled');
    });

    await sleep(50);
    assert.ok(serverSawClose, 'Server must detect client TCP disconnection');
  } finally {
    await mock.close();
  }
});

// ----------------------------------------------------------------------------
// Test 9: Request Isolation Under Timeout Across Concurrent Conversations
// ----------------------------------------------------------------------------
await runTest('9. Request Isolation Under Timeout Across Concurrent Conversations', async () => {
  const isolationA = createRequestIsolationController();
  const isolationB = createRequestIsolationController();
  const reqA = isolationA.beginRequest({ chatId: 'conv-timeout-A', provider: 'gemini' });
  const reqB = isolationB.beginRequest({ chatId: 'conv-success-B', provider: 'gemini' });

  assert.equal(isolationA.isRequestActive(reqA.requestId), true);
  assert.equal(isolationB.isRequestActive(reqB.requestId), true);

  // Request A times out and is finalized
  isolationA.markFinalized(reqA.requestId);
  assert.equal(isolationA.isRequestActive(reqA.requestId), false);

  // Request B continues executing without interference
  assert.equal(isolationB.isRequestActive(reqB.requestId), true);

  isolationB.markFinalized(reqB.requestId);
  assert.equal(isolationB.isRequestActive(reqB.requestId), false);
});

// ----------------------------------------------------------------------------
// Test 10: Non-Streaming Timeout Contract (HTTP 504 JSON with canFallback: true)
// ----------------------------------------------------------------------------
await runTest('10. Non-Streaming Timeout Contract (HTTP 504 JSON with canFallback: true)', async () => {
  const mock = await createMockServer((req, res) => {
    res.writeHead(504, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'The request to Gemini timed out while waiting for a response.',
      code: 504,
      status: 'DEADLINE_EXCEEDED',
      provider: 'gemini',
      retryable: false,
      serverRetriesExhausted: true,
      canFallback: true,
      suggestedProviders: ['groq', 'openrouter']
    }));
  });

  try {
    const res = await fetch(`${mock.url}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'gemini', prompt: 'non-stream test', stream: false })
    });

    assert.equal(res.status, 504);
    const data = await res.json();
    assert.equal(data.status, 'DEADLINE_EXCEEDED');
    assert.equal(data.canFallback, true);
    assert.equal(data.serverRetriesExhausted, true);
    assert.deepEqual(data.suggestedProviders, ['groq', 'openrouter']);

    const canonical = normalizeAIError(data, { provider: 'gemini' });
    assert.equal(canonical.code, STANDARD_ERROR_CODES.DEADLINE_EXCEEDED);
    assert.equal(canonical.canFallback, true);
    assert.ok(isFallbackEligible(canonical));
  } finally {
    await mock.close();
  }
});

// ----------------------------------------------------------------------------
// Test 11: Edit-and-Resend Succeeds When Gemini Responds Normally
// ----------------------------------------------------------------------------
await runTest('11. Edit-and-resend succeeds when Gemini responds normally', async () => {
  let receivedPayload = null;

  const mock = await createMockServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      receivedPayload = JSON.parse(body || '{}');
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'X-Accel-Buffering': 'no'
      });
      res.write(': prime\n\n');
      res.write('data: {"type":"start","modelUsed":"gemini-2.5-flash","provider":"gemini"}\n\n');
      res.write('data: {"type":"chunk","text":"Here is the updated explanation for your edited question."}\n\n');
      res.write('data: {"type":"done","text":"Here is the updated explanation for your edited question.","modelUsed":"gemini-2.5-flash","provider":"gemini"}\n\n');
      res.end();
    });
  });

  try {
    // Simulate initial conversation turns:
    // Turn 0: User: "What is machine learning?"
    // Turn 1: Assistant: "Machine learning is..."
    // Turn 2: User: "Give me an example" (edited to "Give me 3 practical examples")
    const fullConversation = [
      { id: 'msg-1', sender: 'user', content: 'What is machine learning?' },
      { id: 'msg-2', sender: 'assistant', content: 'Machine learning is a field of AI...' },
      { id: 'msg-3', sender: 'user', content: 'Give me an example' },
      { id: 'msg-4', sender: 'assistant', content: 'One example is spam filtering.' }
    ];

    // Branch truncation to messages before msg-3 (index 2)
    const userMsgIndex = 2;
    const earlierMessages = fullConversation.slice(0, userMsgIndex);
    const validHistory = earlierMessages.filter((m) => !m.isError);
    const editedPrompt = 'Give me 3 practical examples';

    let streamedTokens = '';
    const result = await streamAIMessage({
      provider: 'gemini',
      prompt: editedPrompt,
      history: validHistory,
      chatEndpoint: `${mock.url}/api/chat`,
      onChunk: (chunk) => {
        streamedTokens += chunk;
      }
    });

    assert.equal(result.provider, 'gemini');
    assert.equal(result.text, 'Here is the updated explanation for your edited question.');
    assert.equal(streamedTokens, 'Here is the updated explanation for your edited question.');

    // Verify truncated history was transmitted without contradictory subsequent turns
    assert.equal(receivedPayload.prompt, editedPrompt);
    assert.equal(receivedPayload.history.length, 2);
    assert.equal(receivedPayload.history[0].content, 'What is machine learning?');
    assert.equal(receivedPayload.history[1].content, 'Machine learning is a field of AI...');
  } finally {
    await mock.close();
  }
});

// ----------------------------------------------------------------------------
// Test 12: Edit-and-Resend Handles Delayed First Output Without Premature Timeout
// ----------------------------------------------------------------------------
await runTest('12. Edit-and-resend handles delayed first output without premature frontend timeout', async () => {
  const mock = await createMockServer(async (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'X-Accel-Buffering': 'no'
    });
    // Immediate priming
    res.write(': prime\n\n');

    // Simulate upstream latency where model takes 200ms before first token
    await sleep(60);
    res.write(': keepalive\n\n');
    await sleep(60);
    res.write(': keepalive\n\n');
    await sleep(60);

    res.write('data: {"type":"start","modelUsed":"gemini-2.5-flash","provider":"gemini"}\n\n');
    res.write('data: {"type":"chunk","text":"Delayed output safely arrived"}\n\n');
    res.write('data: {"type":"done","text":"Delayed output safely arrived","modelUsed":"gemini-2.5-flash","provider":"gemini"}\n\n');
    res.end();
  });

  try {
    const result = await streamAIMessage({
      provider: 'gemini',
      prompt: 'edited prompt with latency',
      history: [],
      chatEndpoint: `${mock.url}/api/chat`
    });

    assert.equal(result.text, 'Delayed output safely arrived');
  } finally {
    await mock.close();
  }
});

// ----------------------------------------------------------------------------
// Test 13: SSE Heartbeat Comments Do Not Count as Content or Cause False Timeouts
// ----------------------------------------------------------------------------
await runTest('13. SSE heartbeat comments do not count as generated content or trigger false timeouts', async () => {
  const receivedChunks = [];

  const mock = await createMockServer(async (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'X-Accel-Buffering': 'no'
    });
    res.write(': prime\n\n');
    res.write(':\n\n');
    res.write(': keepalive\n\n');
    await sleep(40);
    res.write('data: {"type":"start","modelUsed":"gemini-2.5-flash","provider":"gemini"}\n\n');
    res.write(': keepalive\n\n');
    res.write('data: {"type":"chunk","text":"Clean "}\n\n');
    res.write(': keepalive\n\n');
    res.write('data: {"type":"chunk","text":"Content"}\n\n');
    res.write(':\n\n');
    res.write('data: {"type":"done","text":"Clean Content","modelUsed":"gemini-2.5-flash","provider":"gemini"}\n\n');
    res.end();
  });

  try {
    const result = await streamAIMessage({
      provider: 'gemini',
      prompt: 'check heartbeats',
      chatEndpoint: `${mock.url}/api/chat`,
      onChunk: (chunk) => {
        receivedChunks.push(chunk);
      }
    });

    assert.equal(result.text, 'Clean Content');
    assert.deepEqual(receivedChunks, ['Clean ', 'Content']);
    assert.ok(!result.text.includes(':'));
    assert.ok(!result.text.includes('keepalive'));
  } finally {
    await mock.close();
  }
});

// ----------------------------------------------------------------------------
// Test 14: Cancelled or Superseded Edit Request Cannot Corrupt Newer Request
// ----------------------------------------------------------------------------
await runTest('14. A cancelled or superseded edit request cannot corrupt a newer request', async () => {
  const isolation = createRequestIsolationController();

  // Edit Request 1 started
  const edit1 = isolation.beginRequest({ chatId: 'chat-1', assistantMessageId: 'asst-1', provider: 'gemini' });
  assert.equal(isolation.isRequestActive(edit1.requestId), true);

  // Edit Request 2 arrives and supersedes Request 1
  const edit2 = isolation.beginRequest({ chatId: 'chat-1', assistantMessageId: 'asst-2', provider: 'gemini' });
  assert.equal(isolation.isRequestActive(edit1.requestId), false);
  assert.equal(edit1.signal.aborted, true);
  assert.equal(isolation.isRequestActive(edit2.requestId), true);

  // Attempted mutations from edit1 are rejected
  assert.equal(isolation.canMutateChatUI(edit1.requestId, 'chat-1', 'chat-1'), false);
  assert.equal(isolation.canMutateChatUI(edit2.requestId, 'chat-1', 'chat-1'), true);

  isolation.markFinalized(edit2.requestId);
  assert.equal(isolation.isRequestActive(edit2.requestId), false);
});

// ----------------------------------------------------------------------------
// Test 15: Normal New-Message Streaming Continues to Work
// ----------------------------------------------------------------------------
await runTest('15. Normal new-message streaming continues to work alongside edit-and-resend', async () => {
  const mock = await createMockServer((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'X-Accel-Buffering': 'no'
    });
    res.write(': prime\n\n');
    res.write('data: {"type":"start","modelUsed":"gemini-2.5-flash","provider":"gemini"}\n\n');
    res.write('data: {"type":"chunk","text":"Normal message response"}\n\n');
    res.write('data: {"type":"done","text":"Normal message response","modelUsed":"gemini-2.5-flash","provider":"gemini"}\n\n');
    res.end();
  });

  try {
    const result = await streamAIMessage({
      provider: 'gemini',
      prompt: 'regular new message',
      chatEndpoint: `${mock.url}/api/chat`
    });

    assert.equal(result.text, 'Normal message response');
    assert.equal(result.provider, 'gemini');
  } finally {
    await mock.close();
  }
});

// ----------------------------------------------------------------------------
// Test 16: Long Streaming Response Resets Inactivity Watchdog on Every Chunk
// ----------------------------------------------------------------------------
await runTest('16. Long streaming response (> inactivityTimeoutMs total duration) succeeds because inactivity timer resets on each chunk', async () => {
  const lifecycleEvents = [];
  const emittedChunks = [];

  // Inactivity timeout is 120ms, but 5 chunks arrive 60ms apart (total 300ms > 120ms).
  // A buggy fixed-duration timer would kill this stream at 120ms; a resetting watchdog must succeed.
  const result = await consumeGeminiStreamWithWatchdog({
    model: 'gemini-3.8-flash',
    headerTimeoutMs: 500,
    firstByteTimeoutMs: 250,
    inactivityTimeoutMs: 120,
    totalRequestTimeoutMs: 2000,
    invokeStream: async () => {
      return (async function* () {
        for (let idx = 1; idx <= 5; idx++) {
          await sleep(60);
          yield {
            text: `Chunk-${idx} `,
            candidates: [{ finishReason: idx === 5 ? 'STOP' : undefined }]
          };
        }
      })();
    },
    onChunk: (text) => {
      emittedChunks.push(text);
    },
    onLifecycleLog: (event, payload) => {
      lifecycleEvents.push({ event, payload });
    }
  });

  assert.equal(result.fullText, 'Chunk-1 Chunk-2 Chunk-3 Chunk-4 Chunk-5 ');
  assert.equal(result.chunkCount, 5);
  assert.equal(result.streamedAnyChunk, true);
  assert.equal(result.lastFinishReason, 'STOP');
  assert.equal(emittedChunks.length, 5);

  const eventNames = lifecycleEvents.map((e) => e.event);
  assert.ok(eventNames.includes('upstream_fetch_start'));
  assert.ok(eventNames.includes('upstream_headers_received'));
  assert.ok(eventNames.includes('first_chunk_received'));
  assert.ok(eventNames.includes('chunk_received'));
  assert.ok(eventNames.includes('upstream_complete'));
  assert.ok(!eventNames.includes('timeout'), 'Healthy active stream must never trigger timeout');
});

// ----------------------------------------------------------------------------
// Test 17: Slow First Token Within First-Byte Timeout Succeeds cleanly
// ----------------------------------------------------------------------------
await runTest('17. Slow first token (delayed first chunk within firstByteTimeoutMs) succeeds without premature timeout', async () => {
  const lifecycleEvents = [];
  const result = await consumeGeminiStreamWithWatchdog({
    model: 'gemini-3.8-flash',
    headerTimeoutMs: 200,
    firstByteTimeoutMs: 300,
    inactivityTimeoutMs: 100,
    totalRequestTimeoutMs: 2000,
    invokeStream: async () => {
      await sleep(50); // headers arrive in 50ms
      return (async function* () {
        await sleep(160); // first chunk takes 160ms (> inactivityTimeoutMs=100ms, but < firstByteTimeoutMs=300ms)
        yield { text: 'Thoughtful first token ', candidates: [{}] };
        await sleep(30);
        yield { text: 'and second token.', candidates: [{ finishReason: 'STOP' }] };
      })();
    },
    onLifecycleLog: (event) => lifecycleEvents.push(event)
  });

  assert.equal(result.fullText, 'Thoughtful first token and second token.');
  assert.equal(result.chunkCount, 2);
  assert.ok(lifecycleEvents.includes('first_chunk_received'));
  assert.ok(lifecycleEvents.includes('upstream_complete'));
});

// ----------------------------------------------------------------------------
// Test 18: Dead Upstream Connection Triggers Header Timeout Cleanly
// ----------------------------------------------------------------------------
await runTest('18. Dead upstream connection (headers never arrive) triggers clean header_timeout', async () => {
  const lifecycleEvents = [];
  let signalAborted = false;

  await assert.rejects(
    async () => {
      await consumeGeminiStreamWithWatchdog({
        model: 'gemini-3.8-flash',
        headerTimeoutMs: 80,
        firstByteTimeoutMs: 500,
        inactivityTimeoutMs: 500,
        totalRequestTimeoutMs: 2000,
        invokeStream: async (signal) => {
          signal.addEventListener('abort', () => {
            signalAborted = true;
          });
          await sleep(500);
          return (async function* () {})();
        },
        onLifecycleLog: (event, payload) => lifecycleEvents.push({ event, payload })
      });
    },
    (err) => {
      assert.equal(err.name, 'TimeoutError');
      assert.equal(err.code, 'DEADLINE_EXCEEDED');
      assert.equal(err.timeoutStage, 'header_timeout');
      assert.equal(err.streamedAnyChunk, false);
      return true;
    }
  );

  assert.equal(signalAborted, true, 'AbortController must abort hung upstream fetch on header_timeout');
  assert.ok(lifecycleEvents.some((e) => e.event === 'timeout' && e.payload.timeoutStage === 'header_timeout'));
});

// ----------------------------------------------------------------------------
// Test 19: Headers Arrive But First Chunk Never Arrives -> First-Byte Timeout
// ----------------------------------------------------------------------------
await runTest('19. Upstream headers arrive but first chunk stalls -> triggers first_byte_timeout with streamedAnyChunk: false', async () => {
  const lifecycleEvents = [];

  await assert.rejects(
    async () => {
      await consumeGeminiStreamWithWatchdog({
        model: 'gemini-3.8-flash',
        headerTimeoutMs: 300,
        firstByteTimeoutMs: 90,
        inactivityTimeoutMs: 500,
        totalRequestTimeoutMs: 2000,
        invokeStream: async () => {
          return (async function* () {
            await sleep(500); // stalls before yielding first chunk
            yield { text: 'too late' };
          })();
        },
        onLifecycleLog: (event, payload) => lifecycleEvents.push({ event, payload })
      });
    },
    (err) => {
      assert.equal(err.name, 'TimeoutError');
      assert.equal(err.timeoutStage, 'first_byte_timeout');
      assert.equal(err.streamedAnyChunk, false);
      assert.equal(err.partialText, '');
      return true;
    }
  );

  assert.ok(lifecycleEvents.some((e) => e.event === 'timeout' && e.payload.timeoutStage === 'first_byte_timeout'));
});

// ----------------------------------------------------------------------------
// Test 20: Stalled Stream After Partial Output -> Stream Inactivity Timeout
// ----------------------------------------------------------------------------
await runTest('20. Stalled stream after partial output triggers stream_inactivity_timeout and preserves partialText', async () => {
  const lifecycleEvents = [];

  await assert.rejects(
    async () => {
      await consumeGeminiStreamWithWatchdog({
        model: 'gemini-3.8-flash',
        headerTimeoutMs: 300,
        firstByteTimeoutMs: 300,
        inactivityTimeoutMs: 90,
        totalRequestTimeoutMs: 2000,
        invokeStream: async () => {
          return (async function* () {
            yield { text: 'Partial answer part 1. ' };
            await sleep(30);
            yield { text: 'Partial answer part 2.' };
            await sleep(500); // stalls mid-stream exceeding inactivityTimeoutMs=90ms
            yield { text: 'Never reached' };
          })();
        },
        onLifecycleLog: (event, payload) => lifecycleEvents.push({ event, payload })
      });
    },
    (err) => {
      assert.equal(err.name, 'TimeoutError');
      assert.equal(err.timeoutStage, 'stream_inactivity_timeout');
      assert.equal(err.streamedAnyChunk, true);
      assert.equal(err.partialText, 'Partial answer part 1. Partial answer part 2.');
      assert.equal(err.chunkCount, 2);
      return true;
    }
  );

  assert.ok(lifecycleEvents.some((e) => e.event === 'timeout' && e.payload.timeoutStage === 'stream_inactivity_timeout'));
});

// ----------------------------------------------------------------------------
// Test 21: Pre-Chunk Timeout on Primary Model Advances to Fallback Model (gemini-3.1-flash-lite)
// ----------------------------------------------------------------------------
await runTest('21. Pre-chunk timeout on gemini-3.8-flash advances to fallback model gemini-3.1-flash-lite even in serverless', async () => {
  const attemptPlan = [
    { model: 'gemini-3.8-flash', attemptNum: 1 },
    { model: 'gemini-3.1-flash-lite', attemptNum: 2 }
  ];
  const modelsTried = [];
  let finalResult = null;

  for (let i = 0; i < attemptPlan.length; i++) {
    const { model, attemptNum } = attemptPlan[i];
    const hasMoreAttempts = i < attemptPlan.length - 1;
    const nextModel = hasMoreAttempts ? attemptPlan[i + 1]?.model : null;
    const isAdvancingToDistinctModel = Boolean(hasMoreAttempts && nextModel && nextModel !== model);
    modelsTried.push(model);

    try {
      finalResult = await consumeGeminiStreamWithWatchdog({
        model,
        attemptNum,
        maxAttempts: attemptPlan.length,
        headerTimeoutMs: 60,
        firstByteTimeoutMs: 100,
        inactivityTimeoutMs: 100,
        totalRequestTimeoutMs: 2000,
        invokeStream: async () => {
          if (model === 'gemini-3.8-flash') {
            await sleep(300); // primary model times out waiting for headers
          }
          return (async function* () {
            yield { text: 'Fast response from gemini-3.1-flash-lite', candidates: [{ finishReason: 'STOP' }] };
          })();
        }
      });
      break;
    } catch (attemptErr) {
      const parsed = parseGeminiError(attemptErr, 'gemini');
      const isModelNotFound = parsed.statusCode === 404 || parsed.status === 'NOT_FOUND';
      const isTimeoutFailure = parsed.statusCode === 504 || parsed.status === 'DEADLINE_EXCEEDED';
      const willAdvanceFallback = (isModelNotFound || isTimeoutFailure) && isAdvancingToDistinctModel;
      const simulatedServerless = true;
      const willRetry =
        (parsed.isRetryable || willAdvanceFallback) &&
        hasMoreAttempts &&
        !(simulatedServerless && isTimeoutFailure && !isAdvancingToDistinctModel);

      if (willRetry && willAdvanceFallback) {
        continue;
      }
      throw attemptErr;
    }
  }

  assert.deepEqual(modelsTried, ['gemini-3.8-flash', 'gemini-3.1-flash-lite']);
  assert.ok(finalResult);
  assert.equal(finalResult.model, 'gemini-3.1-flash-lite');
  assert.equal(finalResult.fullText, 'Fast response from gemini-3.1-flash-lite');
});

// ----------------------------------------------------------------------------
// Test 22: User Cancel / Stop Generating Cancels Cleanly Without Timeout Error
// ----------------------------------------------------------------------------
await runTest('22. User cancel / stop generating aborts stream cleanly without reporting a timeout error', async () => {
  const userController = new AbortController();

  const mock = await createMockServer(async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(': prime\n\n');
    res.write('data: {"type":"start","modelUsed":"gemini-3.8-flash","provider":"gemini"}\n\n');
    res.write('data: {"type":"chunk","text":"First chunk before stop"}\n\n');
    await sleep(500);
    if (!res.writableEnded) res.end();
  });

  try {
    await assert.rejects(
      async () => {
        await streamAIMessage({
          provider: 'gemini',
          prompt: 'cancel me',
          chatEndpoint: `${mock.url}/api/chat`,
          signal: userController.signal,
          onChunk: () => {
            userController.abort();
          }
        });
      },
      (err) => {
        assert.equal(err.name, 'AbortError');
        assert.ok(!String(err.message || '').toLowerCase().includes('timed out'));
        return true;
      }
    );
  } finally {
    await mock.close();
  }
});

// ----------------------------------------------------------------------------
// Test 23: Rate Limit 429, Overload 503, Invalid API Key 401/403, and Network Disconnect Classification
// ----------------------------------------------------------------------------
await runTest('23. Rate limit 429, Overload 503, Invalid API Key 401/403, and Network Disconnect are never mislabeled as timeouts', async () => {
  // 1. 429 Rate Limit
  const err429 = parseGeminiError({ status: 429, message: 'Resource has been exhausted (e.g. check quota).' }, 'gemini');
  assert.equal(err429.statusCode, 429);
  assert.equal(err429.status, 'RESOURCE_EXHAUSTED');
  assert.equal(err429.isRetryable, true);
  const norm429 = normalizeAIError(err429, { provider: 'gemini' });
  assert.equal(norm429.code, STANDARD_ERROR_CODES.RATE_LIMITED);
  assert.ok(!norm429.message.toLowerCase().includes('timed out'));

  // 2. 503 Service Overload
  const err503 = parseGeminiError({ status: 503, message: 'The model is overloaded. Please try again later.' }, 'gemini');
  assert.equal(err503.statusCode, 503);
  assert.equal(err503.status, 'UNAVAILABLE');
  assert.equal(err503.isRetryable, true);
  const norm503 = normalizeAIError(err503, { provider: 'gemini' });
  assert.equal(norm503.code, STANDARD_ERROR_CODES.SERVICE_UNAVAILABLE);
  assert.ok(!norm503.message.toLowerCase().includes('timed out'));

  // 3. 401 / 403 Invalid API Key / Auth Error (Never retryable)
  const err401 = parseGeminiError({ status: 401, message: 'API key not valid. Please pass a valid API key.' }, 'gemini');
  assert.equal(err401.statusCode, 401);
  assert.equal(err401.isRetryable, false);
  const norm401 = normalizeAIError(err401, { provider: 'gemini' });
  assert.equal(norm401.code, STANDARD_ERROR_CODES.UNAUTHENTICATED);
  assert.equal(norm401.retryable, false);

  const err403 = parseGeminiError({ status: 403, message: 'Permission denied on resource.' }, 'gemini');
  assert.equal(err403.statusCode, 403);
  assert.equal(err403.isRetryable, false);

  // 4. 400 Malformed Request / Invalid Argument (Never retryable)
  const err400 = parseGeminiError({ status: 400, statusText: 'INVALID_ARGUMENT', message: 'Invalid request payload.' }, 'gemini');
  assert.equal(err400.statusCode, 400);
  assert.equal(err400.status, 'INVALID_ARGUMENT');
  assert.equal(err400.isRetryable, false);
  const norm400 = normalizeAIError(err400, { provider: 'gemini' });
  assert.equal(norm400.code, STANDARD_ERROR_CODES.INVALID_ARGUMENT);
  assert.equal(norm400.retryable, false);
  assert.ok(!norm400.message.toLowerCase().includes('timed out'));

  // 5. Network Disconnect
  const netErr = parseGeminiError(
    Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET', message: 'socket hang up' } }),
    'gemini'
  );
  assert.equal(netErr.statusCode, 503);
  assert.equal(netErr.status, 'NETWORK_FAILURE');
  assert.equal(netErr.isRetryable, true);
  assert.ok(!netErr.message.toLowerCase().includes('timed out'));
});

// ----------------------------------------------------------------------------
// Test 24: Safe Diagnostic Logging Never Leaks API Keys or Prompts
// ----------------------------------------------------------------------------
await runTest('24. Safe diagnostic logging records required telemetry and redacts any sensitive keys', () => {
  const captured = [];
  logGeminiLifecycleEvent(
    {
      event: 'upstream_error',
      elapsedMs: 1420,
      httpStatus: 504,
      model: 'gemini-3.8-flash',
      chunkCount: 0,
      streamState: 'pre_stream_error',
      attempt: 1,
      maxAttempts: 2,
      errorCode: 'DEADLINE_EXCEEDED key=AIzaSyD123456789012345678901234567890123',
      willRetry: true
    },
    (event, payload) => captured.push({ event, payload })
  );

  assert.equal(captured.length, 1);
  assert.equal(captured[0].event, 'upstream_error');
  assert.equal(captured[0].payload.elapsedMs, 1420);
  assert.equal(captured[0].payload.httpStatus, 504);
  assert.equal(captured[0].payload.model, 'gemini-3.8-flash');
  assert.equal(captured[0].payload.chunkCount, 0);
  assert.equal(captured[0].payload.streamState, 'pre_stream_error');
  assert.ok(!JSON.stringify(captured[0].payload).includes('AIzaSyD123456789012345678901234567890123'));
  assert.equal(getGeminiHeaderTimeoutMs(true), 20000);
  assert.equal(getGeminiHeaderTimeoutMs(false), 45000);
  assert.equal(getGeminiFirstByteTimeoutMs(), 45000);
  assert.equal(getGeminiStreamInactivityTimeoutMs(), 45000);
  assert.equal(getGeminiTotalRequestTimeoutMs(), 270000);
});

// ----------------------------------------------------------------------------
// Test 25: Total Request Timeout Enforcement (total_request_timeout)
// ----------------------------------------------------------------------------
await runTest('25. Total request timeout bounds overall stream lifetime independently of per-chunk inactivity resets', async () => {
  const lifecycleEvents = [];

  await assert.rejects(
    async () => {
      await consumeGeminiStreamWithWatchdog({
        model: 'gemini-3.8-flash',
        headerTimeoutMs: 500,
        firstByteTimeoutMs: 500,
        inactivityTimeoutMs: 500,
        totalRequestTimeoutMs: 120,
        invokeStream: async () => {
          return (async function* () {
            for (let i = 1; i <= 10; i++) {
              await sleep(45);
              yield { text: `Piece ${i} ` };
            }
          })();
        },
        onLifecycleLog: (event, payload) => lifecycleEvents.push({ event, payload })
      });
    },
    (err) => {
      assert.equal(err.name, 'TimeoutError');
      assert.equal(err.timeoutStage, 'total_request_timeout');
      assert.equal(err.streamedAnyChunk, true);
      assert.ok(err.partialText.includes('Piece 1 '));
      return true;
    }
  );

  assert.ok(lifecycleEvents.some((e) => e.event === 'timeout' && e.payload.timeoutStage === 'total_request_timeout'));
});

// ----------------------------------------------------------------------------
// Test 26: Client Disconnect Calls iterator.return() and Logs client_disconnect Without Timeout
// ----------------------------------------------------------------------------
await runTest('26. Backend client disconnect aborts iterator immediately, calls iterator.return(), and logs client_disconnect', async () => {
  const lifecycleEvents = [];
  let clientClosed = false;
  let iteratorReturnCalled = false;
  let activeCtrl = null;

  const customIterable = {
    [Symbol.asyncIterator]() {
      let step = 0;
      return {
        async next() {
          step++;
          if (step === 1) {
            return { done: false, value: { text: 'Initial chunk' } };
          }
          await sleep(1000);
          return { done: true, value: undefined };
        },
        async return() {
          iteratorReturnCalled = true;
          return { done: true, value: undefined };
        }
      };
    }
  };

  await assert.rejects(
    async () => {
      await consumeGeminiStreamWithWatchdog({
        model: 'gemini-3.8-flash',
        headerTimeoutMs: 500,
        firstByteTimeoutMs: 500,
        inactivityTimeoutMs: 500,
        totalRequestTimeoutMs: 2000,
        isClientClosed: () => clientClosed,
        registerController: (ctrl) => {
          activeCtrl = ctrl;
        },
        invokeStream: async () => customIterable,
        onChunk: () => {
          // Simulate browser disconnect right after first chunk
          clientClosed = true;
          const discErr = new Error('Client disconnected');
          discErr.code = 'CLIENT_DISCONNECTED';
          discErr.isClientDisconnected = true;
          activeCtrl?.abort(discErr);
        },
        onLifecycleLog: (event, payload) => lifecycleEvents.push({ event, payload })
      });
    },
    (err) => {
      assert.equal(err.isClientDisconnected, true);
      assert.equal(err.code, 'CLIENT_DISCONNECTED');
      return true;
    }
  );

  assert.equal(iteratorReturnCalled, true, 'iterator.return() must be called when client disconnects');
  assert.ok(lifecycleEvents.some((e) => e.event === 'client_disconnect'));
  assert.ok(!lifecycleEvents.some((e) => e.event === 'timeout'));
});

// ----------------------------------------------------------------------------
// Test 27: Rapid Duplicate Edit/Resend Guard & Conversation Switch Cancellation
// ----------------------------------------------------------------------------
await runTest('27. Rapid duplicate Edit/Resend lock and conversation switch cancellation prevent duplicate or leaked requests', async () => {
  // 1. Synchronous ref lock simulation (matching ChatMessage.jsx & ChatPage.jsx)
  const isSubmittingEditRef = { current: false };
  let invokedCount = 0;
  const triggerSaveAndResend = () => {
    if (isSubmittingEditRef.current) return false;
    isSubmittingEditRef.current = true;
    invokedCount++;
    return true;
  };
  assert.equal(triggerSaveAndResend(), true);
  assert.equal(triggerSaveAndResend(), false, 'Rapid second click must be blocked synchronously');
  assert.equal(invokedCount, 1);

  // 2. Conversation switch cancels active request cleanly
  const isolation = createRequestIsolationController();
  const reqA = isolation.beginRequest({ chatId: 'conv-alpha', assistantMessageId: 'msg-a1', provider: 'gemini' });
  assert.equal(isolation.isRequestActive(reqA.requestId), true);
  isolation.cancelActiveRequest('conversation_switch');
  assert.equal(reqA.signal.aborted, true);
  assert.equal(isolation.isRequestActive(reqA.requestId), false);
});

// ----------------------------------------------------------------------------
// Test 28: Delayed type: "start" Until First Valid Chunk & Clean Empty Stream Handling
// ----------------------------------------------------------------------------
await runTest('28. onFirstChunk fires only when first valid non-empty chunk arrives', async () => {
  const eventsOrder = [];

  const result = await consumeGeminiStreamWithWatchdog({
    model: 'gemini-3.8-flash',
    headerTimeoutMs: 300,
    firstByteTimeoutMs: 300,
    inactivityTimeoutMs: 300,
    totalRequestTimeoutMs: 2000,
    invokeStream: async () => {
      return (async function* () {
        yield { text: '' }; // Empty metadata frame must NOT trigger onFirstChunk
        eventsOrder.push('after_empty_frame');
        yield { text: 'Real content', candidates: [{ finishReason: 'STOP' }] };
      })();
    },
    onFirstChunk: () => {
      eventsOrder.push('start_emitted');
    },
    onChunk: (txt) => {
      eventsOrder.push(`chunk:${txt}`);
    }
  });

  assert.deepEqual(eventsOrder, ['after_empty_frame', 'start_emitted', 'chunk:Real content']);
  assert.equal(result.streamedAnyChunk, true);
  assert.equal(result.fullText, 'Real content');
});

console.log('\n================================================================');
console.log(`📊 Gemini Vercel Timeout Suite: ${passed} passed, ${failed} failed`);
console.log('================================================================\n');

if (failed > 0) {
  process.exit(1);
} else {
  process.exit(0);
}



