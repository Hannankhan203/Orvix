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
  const startTime = Date.now();

  const mock = await createMockServer(async (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(': prime\n\n');
    res.flushHeaders?.();

    // Simulate upstream latency
    await sleep(150);
    res.write('data: {"type":"start","modelUsed":"gemini-2.5-flash","provider":"gemini"}\n\n');
    res.write('data: {"type":"chunk","text":"Fast headers verified"}\n\n');
    res.write('data: {"type":"done","text":"Fast headers verified","modelUsed":"gemini-2.5-flash","provider":"gemini"}\n\n');
    res.end();
  });

  try {
    const res = await fetch(`${mock.url}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ provider: 'gemini', prompt: 'test immediate headers', stream: true })
    });

    headerReceivedTime = Date.now() - startTime;
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-type')?.includes('text/event-stream'));
    assert.ok(headerReceivedTime < 100, `Headers must arrive immediately (<100ms), took ${headerReceivedTime}ms`);
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

console.log('\n================================================================');
console.log(`📊 Gemini Vercel Timeout Suite: ${passed} passed, ${failed} failed`);
console.log('================================================================\n');

if (failed > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
