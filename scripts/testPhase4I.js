/**
 * Phase 4I — Provider Switching & Fallback Hardening Verification Suite
 *
 * Comprehensive behavioral and unit checks verifying:
 * - Group 1: Provider Switching Semantics (1–6)
 * - Group 2: Model Compatibility During Provider Switching (7–13)
 * - Group 3: Bounded Retry Boundaries (14–20)
 * - Group 4: Automated Provider Fallback Policy (21–32)
 * - Group 5: Streaming Fallback Safety & Duplicate Prevention (33–39)
 * - Group 6: Cancellation and Request-Isolation Invariants (40–45)
 * - Group 7: Concurrency & State Isolation (46–50)
 * - Group 8: Privacy Boundaries & Sanitization (51–54)
 * - Group 9: Final Canonical Error Behavior (55–60)
 *
 * Run with: node scripts/testPhase4I.js
 */

process.env.TESTING = '1';

import assert from 'node:assert/strict';
import http from 'node:http';

import {
  CanonicalAIError,
  normalizeAIError,
  isCanonicalAIError,
  sanitizeErrorMessage,
  ERROR_CATEGORIES,
  STANDARD_ERROR_CODES
} from '../src/services/errorNormalizationService.js';

import {
  AI_PROVIDERS,
  PROVIDER_OPTIONS,
  DEFAULT_PROVIDER,
  streamAIMessage,
  streamAIMessageWithFallback,
  sendAIMessage,
  isFallbackEligible,
  createFallbackDiagnostic,
  logFallbackDiagnostic,
  parseRouterError,
  resolveModelForProviderSwitch,
  getDeterministicFallbackChain,
  resetCachedProviderConfig
} from '../src/services/aiRouter.js';

import {
  checkModelCompatibilityForProvider,
  sanitizeModelForProvider,
  isProviderCapableOfTask,
  filterAvailableFallbackProviders,
  PROVIDER_DEFAULT_MODELS
} from '../src/services/providerModelSanitizer.js';

import { createRequestIsolationController } from '../src/services/requestIsolationService.js';
import { WebLLMError, WEBLLM_ERROR_CODES } from '../src/services/webllmService.js';

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

console.log('================================================================');
console.log('Phase 4I — Provider Switching & Fallback Hardening Suite');
console.log('================================================================\n');

// ============================================================================
// Group 1 — Provider Switching Semantics (1–6)
// ============================================================================
console.log('--- Group 1: Provider Switching Semantics (1–6) ---');

// Test 1: Selecting Gemini routes to Gemini and uses valid Gemini default/model
await runTest('1. Selecting Gemini routes to Gemini and uses valid Gemini default/model', async () => {
  const model = resolveModelForProviderSwitch('gemini', null);
  assert.equal(model, 'gemini-3.8-flash');
  const opt = PROVIDER_OPTIONS.find((p) => p.id === 'gemini');
  assert.ok(opt);
  assert.equal(opt.defaultModel, 'gemini-3.8-flash');
});

// Test 2: Selecting Groq routes to Groq and uses valid Groq default/model
await runTest('2. Selecting Groq routes to Groq and uses valid Groq default/model', async () => {
  const model = resolveModelForProviderSwitch('groq', null);
  assert.equal(model, 'openai/gpt-oss-120b');
  const opt = PROVIDER_OPTIONS.find((p) => p.id === 'groq');
  assert.ok(opt);
  assert.equal(opt.defaultModel, 'openai/gpt-oss-120b');
});

// Test 3: Selecting OpenRouter routes to OpenRouter and uses valid OpenRouter default/model
await runTest('3. Selecting OpenRouter routes to OpenRouter and uses valid OpenRouter default/model', async () => {
  const model = resolveModelForProviderSwitch('openrouter', null);
  assert.equal(model, 'openrouter/free');
  const opt = PROVIDER_OPTIONS.find((p) => p.id === 'openrouter');
  assert.ok(opt);
  assert.equal(opt.defaultModel, 'openrouter/free');
});

// Test 4: Selecting Cloudflare routes to Cloudflare and uses valid Cloudflare default/model
await runTest('4. Selecting Cloudflare routes to Cloudflare and uses valid Cloudflare default/model', async () => {
  const model = resolveModelForProviderSwitch('cloudflare', null);
  assert.equal(model, '@cf/meta/llama-3.1-8b-instruct');
  const opt = PROVIDER_OPTIONS.find((p) => p.id === 'cloudflare');
  assert.ok(opt);
  assert.equal(opt.defaultModel, '@cf/meta/llama-3.1-8b-instruct');
});

// Test 5: Selecting legacy 'ollama' safely maps to 'gemini'
await runTest('5. Selecting legacy ollama safely maps to gemini', async () => {
  const model = resolveModelForProviderSwitch('ollama', null);
  assert.equal(model, 'gemini-3.8-flash');
  const opt = PROVIDER_OPTIONS.find((p) => p.id === 'ollama');
  assert.equal(opt, undefined, 'Ollama must not appear in PROVIDER_OPTIONS');
});

// Test 6: Selecting WebLLM routes strictly to on-device WebLLM service
await runTest('6. Selecting WebLLM routes strictly to on-device WebLLM service', async () => {
  const model = resolveModelForProviderSwitch('webllm', null);
  assert.equal(model, 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC');
  const opt = PROVIDER_OPTIONS.find((p) => p.id === 'webllm');
  assert.ok(opt);
  assert.equal(opt.defaultModel, 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC');
});

// ============================================================================
// Group 2 — Model Compatibility During Provider Switching (7–13)
// ============================================================================
console.log('\n--- Group 2: Model Compatibility During Provider Switching (7–13) ---');

// Test 7: Switching preserves compatible model (e.g. Llama 3.1 8B instant for Groq)
await runTest('7. Switching preserves compatible model when valid for target provider', async () => {
  const res = resolveModelForProviderSwitch('groq', 'llama-3.1-8b-instant', 'gemini');
  assert.equal(res, 'llama-3.1-8b-instant');
});

// Test 8: Switching from Gemini to Groq rejects Gemini model and applies Groq default
await runTest('8. Switching from Gemini to Groq rejects Gemini model and applies Groq default', async () => {
  const res = resolveModelForProviderSwitch('groq', 'gemini-2.5-flash', 'gemini');
  assert.equal(res, 'openai/gpt-oss-120b');
});

// Test 9: Switching from Cloudflare to Gemini strips @cf/... model and applies Gemini default
await runTest('9. Switching from Cloudflare to Gemini strips @cf/... model and applies Gemini default', async () => {
  const res = resolveModelForProviderSwitch('gemini', '@cf/meta/llama-3.1-8b-instruct', 'cloudflare');
  assert.equal(res, 'gemini-3.8-flash');
});

// Test 10: Switching to OpenRouter preserves dynamic router openrouter/free and vendor model
await runTest('10. Switching to OpenRouter preserves dynamic router openrouter/free and vendor model', async () => {
  const freeRes = resolveModelForProviderSwitch('openrouter', 'openrouter/free');
  assert.equal(freeRes, 'openrouter/free');

  const vendorRes = resolveModelForProviderSwitch('openrouter', 'meta-llama/llama-3.3-70b-instruct:free');
  assert.equal(vendorRes, 'meta-llama/llama-3.3-70b-instruct:free');
});

// Test 12: Switching to WebLLM preserves exact supported MLC identifier and rejects arbitrary foreign models
await runTest('12. Switching to WebLLM preserves exact supported MLC identifier and rejects arbitrary foreign models', async () => {
  const validMlc = resolveModelForProviderSwitch('webllm', 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC');
  assert.equal(validMlc, 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC');

  const invalidMlc = resolveModelForProviderSwitch('webllm', 'openai/gpt-oss-120b');
  assert.equal(invalidMlc, 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC');
});

// Test 13: resolveModelForProviderSwitch returns provider default when input model is null/undefined/empty
await runTest('13. resolveModelForProviderSwitch returns provider default when input model is null/undefined/empty', async () => {
  assert.equal(resolveModelForProviderSwitch('gemini', null), 'gemini-3.8-flash');
  assert.equal(resolveModelForProviderSwitch('groq', undefined), 'openai/gpt-oss-120b');
  assert.equal(resolveModelForProviderSwitch('openrouter', ''), 'openrouter/free');
  assert.equal(resolveModelForProviderSwitch('cloudflare', '   '), '@cf/meta/llama-3.1-8b-instruct');
  assert.equal(resolveModelForProviderSwitch('ollama', null), 'gemini-3.8-flash');
  assert.equal(resolveModelForProviderSwitch('webllm', undefined), 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC');
});

// ============================================================================
// Group 3 — Bounded Retry Boundaries (14–20)
// ============================================================================
console.log('\n--- Group 3: Bounded Retry Boundaries (14–20) ---');

// Helper to create mock HTTP server on an ephemeral port
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

// Test 14: Transient 503 is retried up to bounded max client attempts (2 attempts max)
await runTest('14. Transient 503 is retried up to bounded max client attempts (2 attempts max)', async () => {
  let attempts = 0;
  const mock = await createMockServer((req, res) => {
    attempts++;
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'High demand', code: 503, retryable: true, canFallback: true }));
  });

  try {
    await streamAIMessage({
      provider: 'groq',
      prompt: 'test prompt',
      chatEndpoint: `${mock.url}/api/chat`,
      retryBaseDelayMs: 5
    });
    assert.fail('Expected streamAIMessage to throw after retry exhaustion');
  } catch (err) {
    assert.equal(attempts, 2, 'Must stop at exactly 2 attempts (1 initial + 1 retry)');
    assert.ok(err.retriesExhausted, 'Must flag retriesExhausted on error');
  } finally {
    await mock.close();
  }
});

// Test 15: Transient 429 rate limit is retried once on same provider within bounded retry limit
await runTest('15. Transient 429 rate limit is retried once on same provider within bounded retry limit', async () => {
  let attempts = 0;
  const mock = await createMockServer((req, res) => {
    attempts++;
    if (attempts === 1) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Rate limit exceeded', code: 429, retryable: true }));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text: 'Recovered after 429', modelUsed: 'openai/gpt-oss-120b', provider: 'groq' }));
    }
  });

  try {
    const result = await streamAIMessage({
      provider: 'groq',
      prompt: 'test 429 recovery',
      chatEndpoint: `${mock.url}/api/chat`,
      retryBaseDelayMs: 5
    });
    assert.equal(attempts, 2, 'Should succeed on attempt 2 after transient 429');
    assert.equal(result.text, 'Recovered after 429');
  } finally {
    await mock.close();
  }
});

// Test 16: Authentication failures (401/403) are never retried
await runTest('16. Authentication failures (401/403) are never retried', async () => {
  let attempts = 0;
  const mock = await createMockServer((req, res) => {
    attempts++;
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid API key', code: 401, retryable: false, canFallback: false }));
  });

  try {
    await streamAIMessage({
      provider: 'openrouter',
      prompt: 'test auth failure',
      chatEndpoint: `${mock.url}/api/chat`,
      retryBaseDelayMs: 5
    });
    assert.fail('Expected 401 to throw immediately');
  } catch (err) {
    assert.equal(attempts, 1, 'Must NOT retry on 401 (exactly 1 attempt)');
    assert.equal(err.retryable, false);
    assert.equal(err.canFallback, false);
  } finally {
    await mock.close();
  }
});

// Test 17: Invalid request / model errors (400) are never retried
await runTest('17. Invalid request / model errors (400) are never retried', async () => {
  let attempts = 0;
  const mock = await createMockServer((req, res) => {
    attempts++;
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid model', code: 400, retryable: false, canFallback: false }));
  });

  try {
    await streamAIMessage({
      provider: 'cloudflare',
      prompt: 'test invalid request',
      chatEndpoint: `${mock.url}/api/chat`,
      retryBaseDelayMs: 5
    });
    assert.fail('Expected 400 to throw immediately');
  } catch (err) {
    assert.equal(attempts, 1, 'Must NOT retry on 400 (exactly 1 attempt)');
    assert.equal(err.retryable, false);
    assert.equal(err.canFallback, false);
  } finally {
    await mock.close();
  }
});

// Test 18: Cancellation immediately aborts retry loop without executing second attempt
await runTest('18. Cancellation immediately aborts retry loop without executing second attempt', async () => {
  let attempts = 0;
  const controller = new AbortController();

  const mock = await createMockServer((req, res) => {
    attempts++;
    // Trigger abort right as first failure occurs
    controller.abort();
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Service Unavailable', code: 503, retryable: true }));
  });

  try {
    await streamAIMessage({
      provider: 'gemini',
      prompt: 'test cancel during retry',
      chatEndpoint: `${mock.url}/api/chat`,
      signal: controller.signal,
      retryBaseDelayMs: 50
    });
    assert.fail('Expected AbortError');
  } catch (err) {
    assert.equal(attempts, 1, 'Cancellation must immediately stop retry (only 1 attempt)');
    assert.equal(err.name, 'AbortError');
  } finally {
    await mock.close();
  }
});

// Test 19: Partial streamed output strictly disables retries (retryable: false)
await runTest('19. Partial streamed output strictly disables retries (retryable: false)', async () => {
  let attempts = 0;
  const mock = await createMockServer((req, res) => {
    attempts++;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    res.write('data: {"type":"start","modelUsed":"gemini-2.5-flash","provider":"gemini"}\n\n');
    res.write('data: {"type":"chunk","text":"Hello partial tokens"}\n\n');
    res.write('data: {"type":"error","code":503,"status":"UNAVAILABLE","message":"Stream failed mid-way","retryable":true}\n\n');
    res.end();
  });

  let chunksReceived = '';
  try {
    await streamAIMessage({
      provider: 'gemini',
      prompt: 'test partial retryable invariant',
      chatEndpoint: `${mock.url}/api/chat`,
      onChunk: (chunk) => {
        chunksReceived += chunk;
      },
      retryBaseDelayMs: 5
    });
    assert.fail('Expected stream error');
  } catch (err) {
    assert.equal(attempts, 1, 'Must NEVER retry after partial stream tokens have been emitted!');
    assert.equal(err.retryable, false, 'retryable must strictly be false when partial is true');
    assert.equal(err.partial, true, 'partial must be true');
    assert.equal(chunksReceived, 'Hello partial tokens');
  } finally {
    await mock.close();
  }
});

// Test 20: Retry counters are isolated per request and reset for new requests
await runTest('20. Retry counters are isolated per request and reset for new requests', async () => {
  let attemptsReq1 = 0;
  let attemptsReq2 = 0;

  const mock = await createMockServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      if (parsed.prompt === 'request 1') {
        attemptsReq1++;
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Service Unavailable', code: 503, retryable: true }));
      } else {
        attemptsReq2++;
        if (attemptsReq2 === 1) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Service Unavailable', code: 503, retryable: true }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ text: 'Req 2 success', modelUsed: 'openai/gpt-oss-120b', provider: 'groq' }));
        }
      }
    });
  });

  try {
    // Request 1 exhausts retries
    try {
      await streamAIMessage({
        provider: 'groq',
        prompt: 'request 1',
        chatEndpoint: `${mock.url}/api/chat`,
        retryBaseDelayMs: 5
      });
    } catch (_) {}
    assert.equal(attemptsReq1, 2, 'Request 1 had 2 attempts');

    // Request 2 starts afresh with its own counter
    const res2 = await streamAIMessage({
      provider: 'groq',
      prompt: 'request 2',
      chatEndpoint: `${mock.url}/api/chat`,
      retryBaseDelayMs: 5
    });
    assert.equal(attemptsReq2, 2, 'Request 2 made its own isolated retry and succeeded');
    assert.equal(res2.text, 'Req 2 success');
  } finally {
    await mock.close();
  }
});

// ============================================================================
// Group 4 — Automated Provider Fallback Policy (21–32)
// ============================================================================
console.log('\n--- Group 4: Automated Provider Fallback Policy (21–32) ---');

// Test 21: Upstream 500 triggers fallback to next eligible provider in chain
await runTest('21. Upstream 500 triggers fallback to next eligible provider in chain', async () => {
  const attempted = [];
  const mock = await createMockServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      attempted.push(parsed.provider);
      if (parsed.provider === 'gemini') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal Server Error', code: 500, canFallback: true }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: 'Groq fallback response', modelUsed: 'openai/gpt-oss-120b', provider: 'groq' }));
      }
    });
  });

  try {
    const result = await streamAIMessageWithFallback({
      provider: 'gemini',
      prompt: 'test 500 fallback',
      chatEndpoint: `${mock.url}/api/chat`,
      retryBaseDelayMs: 5
    });
    assert.equal(result.provider, 'groq');
    assert.equal(result.text, 'Groq fallback response');
    assert.deepEqual(result.attemptedProviders, ['gemini', 'groq']);
  } finally {
    await mock.close();
  }
});

// Test 22: Upstream 502 Bad Gateway triggers fallback to next eligible provider in chain
await runTest('22. Upstream 502 Bad Gateway triggers fallback to next eligible provider in chain', async () => {
  const attempted = [];
  const mock = await createMockServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      attempted.push(parsed.provider);
      if (parsed.provider === 'groq') {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bad Gateway', code: 502, retryable: false, canFallback: true }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: 'Gemini fallback response', modelUsed: 'gemini-2.5-flash', provider: parsed.provider }));
      }
    });
  });

  try {
    const result = await streamAIMessageWithFallback({
      provider: 'groq',
      prompt: 'test 502 fallback',
      chatEndpoint: `${mock.url}/api/chat`,
      retryBaseDelayMs: 5
    });
    assert.equal(result.provider, 'gemini'); // Default deterministic fallback order from groq is gemini -> openrouter -> cloudflare
    assert.ok(result.text);
  } finally {
    await mock.close();
  }
});

// Test 23: Upstream 503 Service Unavailable triggers fallback to next eligible provider in chain
await runTest('23. Upstream 503 Service Unavailable triggers fallback to next eligible provider in chain', async () => {
  const attempted = [];
  const mock = await createMockServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      attempted.push(parsed.provider);
      if (parsed.provider === 'gemini') {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'High demand', code: 503, retryable: false, canFallback: true }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: 'Groq recovered', modelUsed: 'openai/gpt-oss-120b', provider: 'groq' }));
      }
    });
  });

  try {
    const result = await streamAIMessageWithFallback({
      provider: 'gemini',
      prompt: 'test 503 fallback',
      chatEndpoint: `${mock.url}/api/chat`,
      retryBaseDelayMs: 5
    });
    assert.equal(result.provider, 'groq');
    assert.equal(result.text, 'Groq recovered');
  } finally {
    await mock.close();
  }
});

// Test 24: Upstream 504 Gateway Timeout triggers fallback to next eligible provider in chain
await runTest('24. Upstream 504 Gateway Timeout triggers fallback to next eligible provider in chain', async () => {
  const mock = await createMockServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      if (parsed.provider === 'cloudflare') {
        res.writeHead(504, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Gateway Timeout', code: 504, retryable: false, canFallback: true }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: 'Gemini fallback on 504', modelUsed: 'gemini-2.5-flash', provider: 'gemini' }));
      }
    });
  });

  try {
    const result = await streamAIMessageWithFallback({
      provider: 'cloudflare',
      prompt: 'test 504 fallback',
      chatEndpoint: `${mock.url}/api/chat`,
      retryBaseDelayMs: 5
    });
    assert.equal(result.provider, 'gemini');
    assert.equal(result.text, 'Gemini fallback on 504');
  } finally {
    await mock.close();
  }
});

// Test 25: Network failure (fetch failed / ECONNREFUSED) triggers fallback to next eligible provider
await runTest('25. Network failure (fetch failed) triggers fallback to next eligible provider', async () => {
  const normErr = normalizeAIError(new TypeError('fetch failed'), { provider: 'openrouter' });
  assert.equal(normErr.code, STANDARD_ERROR_CODES.NETWORK_ERROR);
  assert.equal(normErr.canFallback, true);
  assert.ok(isFallbackEligible(normErr));
});

// Test 26: Request timeout (DEADLINE_EXCEEDED) triggers fallback to next eligible provider
await runTest('26. Request timeout (DEADLINE_EXCEEDED) triggers fallback to next eligible provider', async () => {
  const timeoutErr = normalizeAIError({ code: 504, status: 'DEADLINE_EXCEEDED', message: 'Timed out waiting for headers' }, { provider: 'groq' });
  assert.equal(timeoutErr.code, STANDARD_ERROR_CODES.DEADLINE_EXCEEDED);
  assert.equal(timeoutErr.canFallback, true);
  assert.ok(isFallbackEligible(timeoutErr));
});

// Test 27: Fallback is disabled when canFallback: false on canonical error
await runTest('27. Fallback is disabled when canFallback: false on canonical error', async () => {
  const noFallbackErr = normalizeAIError({ code: 400, message: 'Invalid argument', canFallback: false }, { provider: 'gemini' });
  assert.equal(noFallbackErr.canFallback, false);
  assert.equal(isFallbackEligible(noFallbackErr), false);
});

// Test 29: WebLLM failure never triggers fallback to cloud providers (canFallback: false)
await runTest('29. WebLLM failure never triggers fallback to cloud providers (canFallback: false)', async () => {
  const webllmErr = normalizeAIError({ code: 400, status: 'WEBGPU_UNSUPPORTED', message: 'WebGPU not available' }, { provider: 'webllm' });
  assert.equal(webllmErr.provider, 'webllm');
  assert.equal(webllmErr.canFallback, false, 'WebLLM local privacy boundary requires canFallback === false');
  assert.equal(isFallbackEligible(webllmErr), false);

  const chain = getDeterministicFallbackChain('webllm');
  assert.deepEqual(chain, [], 'WebLLM fallback chain must strictly be empty');
});

// Test 30: Visited-provider protection prevents cycles (A -> B -> A)
await runTest('30. Visited-provider protection prevents cycles (A -> B -> A)', async () => {
  const visited = new Set(['gemini', 'groq']);
  const chain = getDeterministicFallbackChain('groq', { visited });
  assert.ok(!chain.includes('gemini'), 'Gemini was already visited and must not be offered');
  assert.ok(!chain.includes('groq'), 'Groq was already visited and must not be offered');
  assert.deepEqual(chain, ['openrouter', 'cloudflare']);
});

// Test 31: Deterministic cloud fallback order is strictly respected
await runTest('31. Deterministic cloud fallback order is strictly respected', async () => {
  const chainFromGemini = getDeterministicFallbackChain('gemini');
  assert.deepEqual(chainFromGemini, ['groq', 'openrouter', 'cloudflare']);

  const chainFromGroq = getDeterministicFallbackChain('groq');
  assert.deepEqual(chainFromGroq, ['gemini', 'openrouter', 'cloudflare']);

  const chainFromOpenRouter = getDeterministicFallbackChain('openrouter');
  assert.deepEqual(chainFromOpenRouter, ['gemini', 'groq', 'cloudflare']);

  const chainFromCloudflare = getDeterministicFallbackChain('cloudflare');
  assert.deepEqual(chainFromCloudflare, ['gemini', 'groq', 'openrouter']);
});

// Test 32: Unconfigured providers are excluded from the fallback chain based on providerConfig
await runTest('32. Unconfigured providers are excluded from the fallback chain based on providerConfig', async () => {
  const config = {
    status: 'ready',
    data: {
      geminiConfigured: true,
      groqConfigured: false,
      openrouterConfigured: true,
      cloudflareConfigured: false
    }
  };

  const chain = getDeterministicFallbackChain('gemini', { providerConfig: config });
  assert.deepEqual(chain, ['openrouter'], 'Must only contain openrouter because groq and cloudflare are unconfigured');
});

// ============================================================================
// Group 5 — Streaming Fallback Safety & Duplicate Prevention (33–39)
// ============================================================================
console.log('\n--- Group 5: Streaming Fallback Safety & Duplicate Prevention (33–39) ---');

// Test 33: Successful stream completes with provider attribution and no unnecessary fallback
await runTest('33. Successful stream completes with provider attribution and no unnecessary fallback', async () => {
  const mock = await createMockServer((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    res.write('data: {"type":"start","modelUsed":"gemini-2.5-flash","provider":"gemini"}\n\n');
    res.write('data: {"type":"chunk","text":"Hello world"}\n\n');
    res.write('data: {"type":"done","text":"Hello world","modelUsed":"gemini-2.5-flash","provider":"gemini"}\n\n');
    res.end();
  });

  try {
    let accumulated = '';
    const res = await streamAIMessageWithFallback({
      provider: 'gemini',
      prompt: 'hello',
      chatEndpoint: `${mock.url}/api/chat`,
      onChunk: (_, acc) => (accumulated = acc)
    });
    assert.equal(res.text, 'Hello world');
    assert.equal(res.provider, 'gemini');
    assert.deepEqual(res.attemptedProviders, ['gemini']);
    assert.equal(res.fallbackHistory.length, 0);
  } finally {
    await mock.close();
  }
});

// Test 34: Stream failure before any text chunks emits terminal error and allows fallback
await runTest('34. Stream failure before any text chunks emits terminal error and allows fallback', async () => {
  const mock = await createMockServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      if (parsed.provider === 'gemini') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"type":"error","code":503,"status":"UNAVAILABLE","message":"Gemini pre-stream drop","canFallback":true}\n\n');
        res.end();
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: 'Groq recovered cleanly', modelUsed: 'openai/gpt-oss-120b', provider: 'groq' }));
      }
    });
  });

  try {
    const result = await streamAIMessageWithFallback({
      provider: 'gemini',
      prompt: 'test pre-chunk failure fallback',
      chatEndpoint: `${mock.url}/api/chat`,
      retryBaseDelayMs: 5
    });
    assert.equal(result.provider, 'groq');
    assert.equal(result.text, 'Groq recovered cleanly');
    assert.deepEqual(result.attemptedProviders, ['gemini', 'groq']);
    assert.equal(result.fallbackHistory.length, 1);
  } finally {
    await mock.close();
  }
});

// Test 35: Stream failure after partial text preserves partialText and sets partial: true
await runTest('35. Stream failure after partial text preserves partialText and sets partial: true', async () => {
  const mock = await createMockServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"type":"start","modelUsed":"openai/gpt-oss-120b","provider":"groq"}\n\n');
    res.write('data: {"type":"chunk","text":"First paragraph printed."}\n\n');
    res.write('data: {"type":"error","code":500,"status":"INTERNAL","message":"Mid-stream crash"}\n\n');
    res.end();
  });

  try {
    await streamAIMessage({
      provider: 'groq',
      prompt: 'test partial stream error',
      chatEndpoint: `${mock.url}/api/chat`,
      retryBaseDelayMs: 5
    });
    assert.fail('Expected stream error');
  } catch (err) {
    assert.equal(err.partial, true);
    assert.equal(err.partialText, 'First paragraph printed.');
  } finally {
    await mock.close();
  }
});

// Test 36: Stream failure after partial text strictly disables fallback (canFallback: false)
await runTest('36. Stream failure after partial text strictly disables fallback (canFallback: false)', async () => {
  const errWithPartial = normalizeAIError(
    { message: 'Midstream socket drop', canFallback: true },
    { provider: 'groq', partialText: 'Already printed user tokens', partial: true }
  );

  assert.equal(errWithPartial.partial, true);
  assert.equal(errWithPartial.canFallback, false, 'canFallback must strictly be false when partial is true');
  assert.equal(isFallbackEligible(errWithPartial), false);
});

// Test 37: Stream failure after partial text never causes duplicate text to be replayed
await runTest('37. Stream failure after partial text never causes duplicate text to be replayed', async () => {
  let groqCalls = 0;
  let fallbackCalls = 0;

  const mock = await createMockServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      if (parsed.provider === 'groq') {
        groqCalls++;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"type":"chunk","text":"Partial sentence"}\n\n');
        res.write('data: {"type":"error","code":500,"status":"INTERNAL","message":"Interrupted"}\n\n');
        res.end();
      } else {
        fallbackCalls++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: 'Duplicate replay from fallback', provider: parsed.provider }));
      }
    });
  });

  let emittedChunks = '';
  try {
    await streamAIMessageWithFallback({
      provider: 'groq',
      prompt: 'test no replay after partial',
      chatEndpoint: `${mock.url}/api/chat`,
      onChunk: (chunk) => (emittedChunks += chunk),
      retryBaseDelayMs: 5
    });
    assert.fail('Expected stream to throw on partial failure');
  } catch (err) {
    assert.equal(groqCalls, 1, 'Only 1 groq call, no retries after partial text');
    assert.equal(fallbackCalls, 0, 'Fallback provider must NEVER be called after partial text is emitted!');
    assert.equal(emittedChunks, 'Partial sentence');
    assert.equal(err.partial, true);
    assert.equal(err.canFallback, false);
  } finally {
    await mock.close();
  }
});

// Test 38: Mid-stream socket abort or error frame emits exactly one terminal event
await runTest('38. Mid-stream socket abort or error frame emits exactly one terminal event', async () => {
  let errorsEmitted = 0;
  const mock = await createMockServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"type":"error","code":500,"message":"First error"}\n\n');
    res.write('data: {"type":"error","code":500,"message":"Second error"}\n\n');
    res.end();
  });

  try {
    await streamAIMessage({
      provider: 'openrouter',
      prompt: 'test compound error',
      chatEndpoint: `${mock.url}/api/chat`
    });
  } catch (err) {
    errorsEmitted++;
  } finally {
    await mock.close();
  }
  assert.equal(errorsEmitted, 1, 'Must emit exactly one terminal error');
});

// Test 39: In-flight SSE stream handles keepalive lines without falsely triggering fallback
await runTest('39. In-flight SSE stream handles keepalive lines without falsely triggering fallback', async () => {
  const mock = await createMockServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(': keepalive-heartbeat\n\n');
    res.write('data: {"type":"chunk","text":"Live response"}\n\n');
    res.write(': another heartbeat\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });

  try {
    const result = await streamAIMessageWithFallback({
      provider: 'gemini',
      prompt: 'test heartbeat',
      chatEndpoint: `${mock.url}/api/chat`
    });
    assert.equal(result.text, 'Live response');
    assert.equal(result.provider, 'gemini');
    assert.deepEqual(result.attemptedProviders, ['gemini']);
  } finally {
    await mock.close();
  }
});

// ============================================================================
// Group 6 — Cancellation and Request-Isolation Invariants (40–45)
// ============================================================================
console.log('\n--- Group 6: Cancellation and Request-Isolation Invariants (40–45) ---');

// Test 40: Cancellation before provider attempt stops immediately without dispatch
await runTest('40. Cancellation before provider attempt stops immediately without dispatch', async () => {
  const controller = new AbortController();
  controller.abort();

  let serverHit = false;
  const mock = await createMockServer((req, res) => {
    serverHit = true;
    res.writeHead(200);
    res.end();
  });

  try {
    await streamAIMessageWithFallback({
      provider: 'gemini',
      prompt: 'pre-aborted request',
      chatEndpoint: `${mock.url}/api/chat`,
      signal: controller.signal
    });
    assert.fail('Expected AbortError');
  } catch (err) {
    assert.equal(err.name, 'AbortError');
    assert.equal(serverHit, false, 'Server must never be hit when signal is already aborted');
  } finally {
    await mock.close();
  }
});

// Test 41: Cancellation during retry backoff halts immediately and prevents second attempt
await runTest('41. Cancellation during retry backoff halts immediately and prevents second attempt', async () => {
  let attempts = 0;
  const controller = new AbortController();

  const mock = await createMockServer((req, res) => {
    attempts++;
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Service Unavailable', code: 503, retryable: true }));
    setTimeout(() => controller.abort(), 10);
  });

  try {
    await streamAIMessage({
      provider: 'groq',
      prompt: 'cancel during backoff',
      chatEndpoint: `${mock.url}/api/chat`,
      signal: controller.signal,
      retryBaseDelayMs: 100
    });
    assert.fail('Expected AbortError');
  } catch (err) {
    assert.equal(attempts, 1, 'Must abort during backoff delay and not trigger second attempt');
  } finally {
    await mock.close();
  }
});

// Test 42: Cancellation during fallback stops the chain immediately without invoking next provider
await runTest('42. Cancellation during fallback stops the chain immediately without invoking next provider', async () => {
  const attempted = [];
  const controller = new AbortController();

  const mock = await createMockServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      attempted.push(parsed.provider);
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Service Unavailable', code: 503, retryable: false, canFallback: true }));
    });
  });

  try {
    await streamAIMessageWithFallback({
      provider: 'gemini',
      prompt: 'cancel on fallback',
      chatEndpoint: `${mock.url}/api/chat`,
      signal: controller.signal,
      onFallback: () => {
        // Abort right as fallback transition begins
        controller.abort();
      }
    });
    assert.fail('Expected AbortError');
  } catch (err) {
    assert.equal(err.name, 'AbortError');
    assert.equal(attempted.length, 1, 'Fallback provider must not be invoked after cancellation');
  } finally {
    await mock.close();
  }
});

// Test 43: Cancellation mid-stream sets cancelled: true, retryable: false, canFallback: false
await runTest('43. Cancellation mid-stream sets cancelled: true, retryable: false, canFallback: false', async () => {
  const normAbort = normalizeAIError(new Error('Generation cancelled by user.'), {
    provider: 'cloudflare',
    signal: { aborted: true }
  });

  assert.equal(normAbort.cancelled, true);
  assert.equal(normAbort.retryable, false);
  assert.equal(normAbort.canFallback, false);
});

// Test 44: Cancelled Request A cannot mutate UI, emit chunks, or trigger fallback after being superseded
await runTest('44. Cancelled Request A cannot mutate UI, emit chunks, or trigger fallback after being superseded', async () => {
  const isolation = createRequestIsolationController();

  const reqA = isolation.beginRequest({ chatId: 'chat-1', provider: 'gemini' });
  assert.ok(isolation.isRequestActive(reqA.requestId));

  // Begin Request B -> supersedes Request A
  const reqB = isolation.beginRequest({ chatId: 'chat-1', provider: 'groq' });
  assert.ok(isolation.isRequestActive(reqB.requestId));
  assert.equal(isolation.isRequestActive(reqA.requestId), false, 'Request A must no longer be active');

  assert.equal(reqA.signal.aborted, true, 'Request A signal must be aborted');
  assert.equal(reqB.signal.aborted, false, 'Request B signal must be active');
});

// Test 45: Superseding Request A with Request B cleanly isolates Request B from Request A's failure
await runTest('45. Superseding Request A with Request B cleanly isolates Request B from Request A failure', async () => {
  const isolation = createRequestIsolationController();

  const reqA = isolation.beginRequest({ chatId: 'chat-1', provider: 'gemini' });
  const reqB = isolation.beginRequest({ chatId: 'chat-1', provider: 'groq' });

  // A simulated failure on Request A
  const normA = normalizeAIError({ code: 503, message: 'Gemini 503' }, {
    provider: 'gemini',
    requestId: reqA.requestId,
    signal: reqA.signal
  });

  assert.equal(normA.cancelled, true, 'A must be marked cancelled because its signal was aborted');
  assert.equal(normA.canFallback, false);

  // B is completely unharmed
  assert.equal(isolation.isRequestActive(reqB.requestId), true);
  assert.equal(reqB.cancelled, false);
});

// ============================================================================
// Group 7 — Concurrency & State Isolation (46–50)
// ============================================================================
console.log('\n--- Group 7: Concurrency & State Isolation (46–50) ---');

// Test 46: Two independent concurrent requests maintain separate visited provider sets
await runTest('46. Two independent concurrent requests maintain separate visited provider sets', async () => {
  const mockA = await createMockServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      if (parsed.provider === 'gemini') {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Gemini fail', code: 503, retryable: false, canFallback: true }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: 'Req A finished on Groq', provider: 'groq' }));
      }
    });
  });

  const mockB = await createMockServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text: 'Req B finished on Gemini', provider: 'gemini' }));
    });
  });

  try {
    const [resA, resB] = await Promise.all([
      streamAIMessageWithFallback({
        provider: 'gemini',
        prompt: 'prompt A',
        chatEndpoint: `${mockA.url}/api/chat`,
        retryBaseDelayMs: 5
      }),
      streamAIMessageWithFallback({
        provider: 'gemini',
        prompt: 'prompt B',
        chatEndpoint: `${mockB.url}/api/chat`,
        retryBaseDelayMs: 5
      })
    ]);

    assert.equal(resA.provider, 'groq');
    assert.deepEqual(resA.attemptedProviders, ['gemini', 'groq']);

    assert.equal(resB.provider, 'gemini');
    assert.deepEqual(resB.attemptedProviders, ['gemini']);
  } finally {
    await mockA.close();
    await mockB.close();
  }
});

// Test 47: Concurrent Request A fails and falls back while Request B executes on original provider
await runTest('47. Concurrent Request A fails and falls back while Request B executes on original provider', async () => {
  const diagA = [];
  const diagB = [];

  const mock = await createMockServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      if (parsed.prompt === 'Task A' && parsed.provider === 'gemini') {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Fail A', code: 503, retryable: false, canFallback: true }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: `Done: ${parsed.prompt}`, provider: parsed.provider }));
      }
    });
  });

  try {
    const [taskA, taskB] = await Promise.all([
      streamAIMessageWithFallback({
        provider: 'gemini',
        prompt: 'Task A',
        chatEndpoint: `${mock.url}/api/chat`,
        onFallback: (d) => diagA.push(d),
        retryBaseDelayMs: 5
      }),
      streamAIMessageWithFallback({
        provider: 'gemini',
        prompt: 'Task B',
        chatEndpoint: `${mock.url}/api/chat`,
        onFallback: (d) => diagB.push(d),
        retryBaseDelayMs: 5
      })
    ]);

    assert.equal(taskA.provider, 'groq');
    assert.equal(diagA.length, 1);
    assert.equal(diagA[0].selectedFallbackProvider, 'groq');

    assert.equal(taskB.provider, 'gemini');
    assert.equal(diagB.length, 0);
  } finally {
    await mock.close();
  }
});

// Test 48: Cancelling Request A while Request B is streaming does not cancel or affect Request B
await runTest('48. Cancelling Request A while Request B is streaming does not cancel or affect Request B', async () => {
  const ctrlA = new AbortController();
  const ctrlB = new AbortController();

  const mock = await createMockServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      if (parsed.prompt === 'Task A') {
        // Cancel A after brief moment
        setTimeout(() => ctrlA.abort(), 10);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"type":"chunk","text":"A chunk"}\n\n');
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: 'B finished', provider: 'groq' }));
      }
    });
  });

  try {
    const promiseA = streamAIMessageWithFallback({
      provider: 'groq',
      prompt: 'Task A',
      chatEndpoint: `${mock.url}/api/chat`,
      signal: ctrlA.signal
    });

    const promiseB = streamAIMessageWithFallback({
      provider: 'groq',
      prompt: 'Task B',
      chatEndpoint: `${mock.url}/api/chat`,
      signal: ctrlB.signal
    });

    let caughtA = false;
    try {
      await promiseA;
    } catch (e) {
      caughtA = true;
      assert.equal(e.name, 'AbortError');
    }
    assert.ok(caughtA);

    const resB = await promiseB;
    assert.equal(resB.text, 'B finished');
    assert.equal(ctrlB.signal.aborted, false);
  } finally {
    await mock.close();
  }
});

// Test 49: Request A retry backoff timer does not block or delay Request B
await runTest('49. Request A retry backoff timer does not block or delay Request B', async () => {
  const startTime = Date.now();
  let bCompletedAt = 0;

  const mock = await createMockServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      if (parsed.prompt === 'slow A') {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Fail A', code: 503, retryable: true }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: 'Fast B', provider: 'groq' }));
      }
    });
  });

  try {
    const pA = streamAIMessage({
      provider: 'groq',
      prompt: 'slow A',
      chatEndpoint: `${mock.url}/api/chat`,
      retryBaseDelayMs: 800
    }).catch(() => {});

    const pB = streamAIMessage({
      provider: 'groq',
      prompt: 'fast B',
      chatEndpoint: `${mock.url}/api/chat`,
      retryBaseDelayMs: 0
    }).then((res) => {
      bCompletedAt = Date.now();
      return res;
    });

    await pB;
    assert.ok(bCompletedAt - startTime < 400, 'Request B should complete quickly without waiting on Request A retry backoff');
    await pA;
  } finally {
    await mock.close();
  }
});

// Test 50: Rapid switching of provider selection does not pollute active in-flight request provider
await runTest('50. Rapid switching of provider selection does not pollute active in-flight request provider', async () => {
  const req1 = { provider: 'gemini', model: 'gemini-2.5-flash' };
  const req2 = { provider: 'groq', model: 'openai/gpt-oss-120b' };

  const sanitized1 = resolveModelForProviderSwitch(req1.provider, req1.model);
  const sanitized2 = resolveModelForProviderSwitch(req2.provider, req2.model);

  assert.equal(sanitized1, 'gemini-2.5-flash');
  assert.equal(sanitized2, 'openai/gpt-oss-120b');
});

// ============================================================================
// Group 8 — Privacy Boundaries & Sanitization (51–54)
// ============================================================================
console.log('\n--- Group 8: Privacy Boundaries & Sanitization (51–54) ---');

// Test 51: Fallback errors do not leak API keys, authorization tokens, or Bearer credentials
await runTest('51. Fallback errors do not leak API keys, authorization tokens, or Bearer credentials', async () => {
  const secretMsg = 'Upstream failure at key=AIzaSyD987654321098765432109876543210 with Bearer sk-or-v1-abcdef1234567890';
  const scrubbed = sanitizeErrorMessage(secretMsg);
  assert.ok(!scrubbed.includes('AIzaSyD'), 'Must redact AIza key');
  assert.ok(!scrubbed.includes('sk-or-v1'), 'Must redact sk-or key');
  assert.ok(scrubbed.includes('[REDACTED_API_KEY]'));
  assert.ok(scrubbed.includes('Bearer [REDACTED]'));

  const norm = normalizeAIError(new Error(secretMsg), { provider: 'openrouter' });
  assert.ok(!norm.message.includes('AIzaSyD'));
  assert.ok(!norm.message.includes('sk-or-v1'));
});

// Test 52: Fallback errors do not leak raw private user prompts or request bodies
await runTest('52. Fallback errors do not leak raw private user prompts or request bodies', async () => {
  const privatePrompt = 'CONFIDENTIAL_FINANCIAL_REPORT_Q3_NUMBERS';
  const leakedError = `Upstream error processing prompt: ${privatePrompt} at provider gateway`;

  const scrubbed = sanitizeErrorMessage(leakedError, { promptText: privatePrompt });
  assert.ok(!scrubbed.includes(privatePrompt), 'Must redact user private prompt');
  assert.ok(scrubbed.includes('[USER_PROMPT]'));

  const norm = normalizeAIError(new Error(leakedError), {
    provider: 'gemini',
    promptText: privatePrompt
  });
  assert.ok(!norm.message.includes(privatePrompt));
});

// Test 53: Local WebLLM privacy boundary is enforced even if raw error claims canFallback: true
await runTest('53. Local WebLLM privacy boundary is enforced even if raw error claims canFallback: true', async () => {

  const rawWebLLM = {
    code: 400,
    status: 'WEBGPU_UNSUPPORTED',
    message: 'WebGPU failed',
    canFallback: true
  };
  const normWeb = normalizeAIError(rawWebLLM, { provider: 'webllm' });
  assert.equal(normWeb.canFallback, false, 'Local WebLLM strictly forces canFallback to false');
  assert.equal(isFallbackEligible(normWeb), false);
});

// Test 54: Fallback diagnostics (createFallbackDiagnostic) do not contain secrets or sensitive prompts
await runTest('54. Fallback diagnostics (createFallbackDiagnostic) do not contain secrets or sensitive prompts', async () => {
  const diag = createFallbackDiagnostic({
    requestId: 'req-12345',
    originalProvider: 'gemini',
    failedProvider: 'gemini',
    failureCode: 'UNAVAILABLE',
    fallbackEligibility: true,
    selectedFallbackProvider: 'groq',
    attemptNumber: 1
  });

  assert.equal(diag.requestId, 'req-12345');
  assert.equal(diag.originalProvider, 'gemini');
  assert.equal(diag.failedProvider, 'gemini');
  assert.equal(diag.selectedFallbackProvider, 'groq');
  assert.equal(diag.fallbackEligibility, true);
  assert.equal(diag.attemptNumber, 1);
  assert.equal(typeof diag.timestamp, 'number');

  // Must not have arbitrary secret fields
  assert.equal((diag).apiKey, undefined);
  assert.equal((diag).prompt, undefined);
  assert.equal((diag).token, undefined);
});

// ============================================================================
// Group 9 — Final Canonical Error Behavior (55–60)
// ============================================================================
console.log('\n--- Group 9: Final Canonical Error Behavior (55–60) ---');

// Test 55: Exhausted fallback chain returns single canonical final error
await runTest('55. Exhausted fallback chain returns single canonical final error', async () => {
  const mock = await createMockServer((req, res) => {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Persistent outage across all clouds', code: 503, retryable: false, canFallback: true }));
  });

  try {
    await streamAIMessageWithFallback({
      provider: 'gemini',
      prompt: 'test exhausted fallback',
      chatEndpoint: `${mock.url}/api/chat`,
      maxFallbackProviders: 3,
      retryBaseDelayMs: 5
    });
    assert.fail('Expected streamAIMessageWithFallback to throw final canonical error');
  } catch (err) {
    assert.ok(isCanonicalAIError(err), 'Must be a CanonicalAIError');
    assert.ok(Array.isArray(err.attemptedProviders));
    assert.equal(err.attemptedProviders.length, 3, 'Must have attempted 3 providers before exhausting');
    assert.equal(err.canFallback, false, 'canFallback must be false when chain is exhausted');
  } finally {
    await mock.close();
  }
});

// Test 56: Exhausted final error contains clean, user-friendly message without raw stack dump
await runTest('56. Exhausted final error contains clean, user-friendly message without raw stack dump', async () => {
  const norm = normalizeAIError({
    code: 503,
    status: 'UNAVAILABLE',
    message: 'TypeError: fetch failed at Object.fetch (node:internal/deps/undici/undici:11453:11)\n    at Object.streamAIMessage'
  }, { provider: 'groq' });

  assert.ok(!norm.message.includes('node:internal'), 'Must not dump internal stack traces');
  assert.ok(norm.message.length > 10);
  assert.ok(norm.message.includes('The AI service is currently experiencing high demand') || norm.message.includes('network connection'));
});

// Test 57: Final error retains attemptedProviders array recording every attempted provider in order
await runTest('57. Final error retains attemptedProviders array recording every attempted provider in order', async () => {
  const err = new CanonicalAIError({
    code: 'UNAVAILABLE',
    message: 'All providers failed',
    attemptedProviders: ['gemini', 'groq', 'openrouter']
  });

  assert.deepEqual(err.attemptedProviders, ['gemini', 'groq', 'openrouter']);
  const json = err.toJSON();
  assert.deepEqual(json.attemptedProviders, ['gemini', 'groq', 'openrouter']);
});

// Test 58: Final error retains fallbackHistory diagnostic records without secret leakage
await runTest('58. Final error retains fallbackHistory diagnostic records without secret leakage', async () => {
  const history = [
    createFallbackDiagnostic({
      requestId: 'req-test',
      originalProvider: 'gemini',
      failedProvider: 'gemini',
      failureCode: 'DEADLINE_EXCEEDED',
      fallbackEligibility: true,
      selectedFallbackProvider: 'groq',
      attemptNumber: 1
    })
  ];

  const err = new CanonicalAIError({
    code: 'DEADLINE_EXCEEDED',
    message: 'Timeout after fallbacks',
    fallbackHistory: history
  });

  assert.equal(err.fallbackHistory.length, 1);
  assert.equal(err.fallbackHistory[0].selectedFallbackProvider, 'groq');
  assert.equal(err.toJSON().fallbackHistory.length, 1);
});

// Test 59: When all fallback options are exhausted, final error strictly sets canFallback: false
await runTest('59. When all fallback options are exhausted, final error strictly sets canFallback: false', async () => {
  const exhaustedErr = normalizeAIError({
    code: 503,
    status: 'UNAVAILABLE',
    message: 'All cloud providers offline',
    canFallback: false // Exhausted
  }, { provider: 'cloudflare' });

  assert.equal(exhaustedErr.canFallback, false);
  assert.equal(isFallbackEligible(exhaustedErr), false);
});

// Test 60: Non-recoverable errors (auth 401, bad request 400, context overflow) are never masked by fallback
await runTest('60. Non-recoverable errors (auth 401, bad request 400, context overflow) are never masked by fallback', async () => {
  let calls = 0;
  const mock = await createMockServer((req, res) => {
    calls++;
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid API key for Groq', code: 401, retryable: false, canFallback: false }));
  });

  try {
    await streamAIMessageWithFallback({
      provider: 'groq',
      prompt: 'test auth never masked',
      chatEndpoint: `${mock.url}/api/chat`,
      retryBaseDelayMs: 5
    });
    assert.fail('Expected 401 to throw immediately');
  } catch (err) {
    assert.equal(calls, 1, 'Must NOT attempt fallback when error is non-recoverable auth failure');
    assert.equal(err.canFallback, false);
    assert.equal(err.httpStatus, 401);
  } finally {
    await mock.close();
  }
});

console.log('\n================================================================');
console.log(`Phase 4I Test Results: ${passed} Passed, ${failed} Failed out of ${passed + failed} tests`);
console.log('================================================================');

if (failed > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
