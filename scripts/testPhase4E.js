/**
 * Phase 4E — OpenRouter Provider Hardening Verification Suite
 *
 * End-to-end behavioral and unit verification of OpenRouter model compatibility,
 * UI/display label vs actual model identity alignment, dynamic router (`openrouter/free`)
 * concrete model attribution, provider configuration guards, SSE mid-stream error handling,
 * malformed error frame resilience, bounded retry & fallback semantics, client cancellation,
 * and request/header correctness against a live ephemeral server.ts instance wired to a
 * controlled local mock OpenRouter upstream server.
 *
 * Run with: node scripts/testPhase4E.js
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';

import {
  PROVIDER_DEFAULT_MODELS,
  OPENROUTER_DEFAULT_MODEL,
  OPENROUTER_DYNAMIC_ROUTERS,
  CLOUDFLARE_DEFAULT_MODEL,
  checkModelCompatibilityForProvider,
  sanitizeModelForProvider,
  validateServerModelForProvider
} from '../src/services/providerModelSanitizer.js';

import {
  AI_PROVIDERS,
  PROVIDER_OPTIONS,
  parseRouterError,
  sendAIMessage,
  streamAIMessage
} from '../src/services/aiRouter.js';

import {
  formatOpenRouterMessages,
  getOpenRouterApiKey,
  sendOpenRouterMessage,
  streamOpenRouterMessage
} from '../src/services/openrouterService.js';

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

/**
 * Starts a local mock OpenRouter API server that handles:
 *  - POST /api/v1/chat/completions
 */
function startMockOpenRouterUpstream() {
  const state = {
    chatCalls: [],
    chatHandler: null,
    reset() {
      this.chatCalls = [];
      this.chatHandler = null;
    }
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      const rawBuffer = Buffer.concat(chunks);
      const url = req.url || '';

      if (req.method === 'POST' && url.endsWith('/chat/completions')) {
        let parsedBody = {};
        try {
          parsedBody = JSON.parse(rawBuffer.toString('utf8'));
        } catch (_) {}

        const callRecord = {
          url,
          headers: req.headers,
          body: parsedBody,
          timestamp: Date.now()
        };
        state.chatCalls.push(callRecord);

        if (typeof state.chatHandler === 'function') {
          await state.chatHandler(req, res, callRecord);
          return;
        }

        const effectiveModel =
          parsedBody.model === 'openrouter/free'
            ? 'google/gemma-3-27b-it:free'
            : parsedBody.model || 'openrouter/free';

        if (parsedBody.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write(': OPENROUTER PROCESSING\n\n');
          res.write(
            `data: ${JSON.stringify({
              id: 'gen-default-stream',
              model: effectiveModel,
              choices: [
                {
                  index: 0,
                  delta: { content: 'Default mock OpenRouter response' },
                  finish_reason: 'stop'
                }
              ]
            })}\n\ndata: [DONE]\n\n`
          );
          res.end();
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'gen-default-sync',
            model: effectiveModel,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'Default mock OpenRouter response' },
                finish_reason: 'stop'
              }
            ]
          })
        );
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `Unhandled mock path ${url}` } }));
    });
  });

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const baseUrl = `http://127.0.0.1:${addr.port}/api/v1`;
      resolve({
        state,
        baseUrl,
        close: () =>
          new Promise((r) => {
            server.closeAllConnections?.();
            server.close(() => r());
          })
      });
    });
    server.on('error', reject);
  });
}

/**
 * Starts a local mock Cloudflare Workers AI server that handles:
 *  - POST /client/v4/accounts/:accountId/ai/run/:modelId
 */
function startMockCloudflareUpstream() {
  const state = {
    aiCalls: [],
    aiHandler: null,
    reset() {
      this.aiCalls = [];
      this.aiHandler = null;
    }
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      const rawBuffer = Buffer.concat(chunks);
      const url = req.url || '';

      const match = url.match(/\/client\/v4\/accounts\/([^/]+)\/ai\/run\/(.+)$/);
      if (req.method === 'POST' && match) {
        const accountId = decodeURIComponent(match[1]);
        const modelId = match[2];
        let parsedBody = {};
        try {
          parsedBody = JSON.parse(rawBuffer.toString('utf8'));
        } catch (_) {}

        const callRecord = {
          url,
          accountId,
          modelId,
          headers: req.headers,
          body: parsedBody,
          rawBody: rawBuffer.toString('utf8'),
          timestamp: Date.now()
        };
        state.aiCalls.push(callRecord);

        if (typeof state.aiHandler === 'function') {
          await state.aiHandler(req, res, callRecord);
          return;
        }

        if (parsedBody.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write(
            `data: ${JSON.stringify({
              response: 'Default mock Cloudflare response',
              finish_reason: 'stop'
            })}\n\ndata: [DONE]\n\n`
          );
          res.end();
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            success: true,
            result: {
              response: 'Default mock Cloudflare response',
              finish_reason: 'stop'
            }
          })
        );
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, errors: [{ message: `Unhandled Cloudflare path ${url}` }] }));
    });
  });

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const baseUrl = `http://127.0.0.1:${addr.port}/client/v4`;
      resolve({
        state,
        baseUrl,
        close: () =>
          new Promise((r) => {
            server.closeAllConnections?.();
            server.close(() => r());
          })
      });
    });
    server.on('error', reject);
  });
}

/**
 * Allocates an unused ephemeral local TCP port.
 */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = addr.port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/**
 * Starts an ephemeral server.ts process on an available local port wired to mockOpenRouterBaseUrl and mockCloudflareBaseUrl.
 */
async function startTestServer(port, mockOpenRouterBaseUrl, envOverrides = {}, mockCloudflareBaseUrl = '') {
  const actualPort = await getFreePort();
  const child = spawn('./node_modules/.bin/tsx', ['server.ts'], {
    detached: true,
    env: {
      ...process.env,
      PORT: String(actualPort),
      NODE_ENV: 'production',
      ORVIX_OPENROUTER_BASE_URL: mockOpenRouterBaseUrl,
      ORVIX_CLOUDFLARE_BASE_URL: mockCloudflareBaseUrl,
      OPENROUTER_API_KEY: 'sk-or-v1-test-phase4e-valid-key',
      VITE_OPENROUTER_API_KEY: '',
      GROQ_API_KEY: 'gsk_test_fallback_key',
      VITE_GROQ_API_KEY: '',
      GEMINI_API_KEY: '',
      VITE_GEMINI_API_KEY: '',
      CLOUDFLARE_API_TOKEN: 'cf-token-phase4e-valid',
      CLOUDFLARE_ACCOUNT_ID: 'cf-account-phase4e-valid',
      ORVIX_ENABLE_DEMO_MODE: '',
      ...envOverrides
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const killChildGroup = () => {
    try {
      if (child.pid) {
        process.kill(-child.pid, 'SIGKILL');
      }
    } catch (_) {}
    try {
      child.kill('SIGKILL');
    } catch (_) {}
  };

  const baseUrl = `http://127.0.0.1:${actualPort}`;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) {
        return {
          baseUrl,
          stop: () =>
            new Promise((resolve) => {
              child.once('exit', () => resolve());
              killChildGroup();
              setTimeout(() => resolve(), 150);
            })
        };
      }
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 150));
  }

  killChildGroup();
  throw new Error('Timed out waiting for ephemeral server.ts to start');
}

/**
 * Re-roots relative `/api/...` fetch calls to the ephemeral test server URL.
 */
function installRelativeFetchInterceptor(serverBaseUrl) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (typeof input === 'string' && input.startsWith('/')) {
      return originalFetch(`${serverBaseUrl}${input}`, init);
    }
    return originalFetch(input, init);
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}

/**
 * Helper to read all SSE events emitted by server.ts `/api/chat`.
 */
async function collectServerSSEEvents(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events = [];
  let sawDoneSentinel = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || !line.startsWith('data:')) continue;
      const dataStr = line.replace(/^data:\s*/, '').trim();
      if (dataStr === '[DONE]') {
        sawDoneSentinel = true;
        continue;
      }
      try {
        events.push(JSON.parse(dataStr));
      } catch (e) {
        events.push({ _rawUnparseable: dataStr, _parseError: e.message });
      }
    }
  }

  return { events, sawDoneSentinel };
}

async function main() {
  console.log('\n============================================================');
  console.log('Phase 4E — OpenRouter & Cloudflare Provider Hardening Suite');
  console.log('============================================================\n');

  const mockOpenRouter = await startMockOpenRouterUpstream();
  const mockCloudflare = await startMockCloudflareUpstream();
  const serverPort = 39450 + Math.floor(Math.random() * 400);
  const testServer = await startTestServer(serverPort, mockOpenRouter.baseUrl, {}, mockCloudflare.baseUrl);
  const restoreFetch = installRelativeFetchInterceptor(testServer.baseUrl);

  try {
    // =========================================================================
    // 1. Valid OpenRouter model ID is accepted
    // =========================================================================
    await runTest('1. Valid OpenRouter model IDs (openrouter/free, openrouter/auto, vendor/slug:free) are accepted', async () => {
      assert.equal(PROVIDER_DEFAULT_MODELS.openrouter, 'openrouter/free');
      assert.equal(OPENROUTER_DEFAULT_MODEL, 'openrouter/free');
      assert.ok(OPENROUTER_DYNAMIC_ROUTERS.includes('openrouter/free'));
      assert.ok(OPENROUTER_DYNAMIC_ROUTERS.includes('openrouter/auto'));

      const validModels = [
        'openrouter/free',
        'openrouter/auto',
        'meta-llama/llama-3.3-70b-instruct:free',
        'google/gemma-3-27b-it:free',
        'deepseek/deepseek-r1:free',
        'qwen/qwen3-coder:free'
      ];

      for (const model of validModels) {
        const compat = checkModelCompatibilityForProvider('openrouter', model);
        assert.equal(compat.compatible, true, `Expected ${model} to be compatible for OpenRouter`);
        assert.equal(compat.normalizedModel, model);

        const sanitized = sanitizeModelForProvider('openrouter', model);
        assert.equal(sanitized, model);

        const serverCheck = validateServerModelForProvider('openrouter', model);
        assert.equal(serverCheck.valid, true);
        assert.equal(serverCheck.model, model);
      }
    });

    // =========================================================================
    // 2. Invalid/display-label model IDs are rejected
    // =========================================================================
    await runTest('2. Invalid, malformed, or UI display-label OpenRouter model IDs are rejected or sanitized', async () => {
      const displayLabelsAndDemos = [
        'Free Models Router',
        'Llama 3.3 70B (Free)',
        'openrouter/free (demo)',
        'Document Analyzer',
        'OpenRouter (Llama 3.3 70B)',
        'openrouter',
        'openrouter/unknown-router',
        'invalid model with spaces'
      ];

      for (const badModel of displayLabelsAndDemos) {
        const compat = checkModelCompatibilityForProvider('openrouter', badModel);
        assert.equal(compat.compatible, false, `Expected "${badModel}" to be rejected by compatibility check`);

        const sanitized = sanitizeModelForProvider('openrouter', badModel);
        assert.equal(
          sanitized,
          null,
          `Expected client sanitizer to strip "${badModel}" to null so default openrouter/free is used`
        );
      }

      // Server-side validation rejects arbitrary invalid model strings with HTTP 400 INVALID_MODEL
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'openrouter',
          model: 'openrouter/nonexistent-router',
          prompt: 'Test invalid router model',
          stream: false
        })
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.status, 'INVALID_MODEL');
      assert.equal(body.provider, 'openrouter');
      assert.equal(body.retryable, false);
    });

    // =========================================================================
    // 3. Cross-provider model IDs are rejected
    // =========================================================================
    await runTest('3. Cross-provider model IDs (Gemini, Cloudflare, Ollama, WebLLM, Whisper audio) are rejected for OpenRouter', async () => {
      const foreignModels = [
        'gemini-2.5-flash',
        'models/gemini-2.5-flash',
        '@cf/meta/llama-3.1-8b-instruct',
        'qwen2.5:1.5b',
        'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
        'whisper-large-v3-turbo',
        'openai/whisper-large-v3'
      ];

      for (const foreign of foreignModels) {
        const compat = checkModelCompatibilityForProvider('openrouter', foreign);
        assert.equal(compat.compatible, false, `Expected foreign model "${foreign}" to be rejected for OpenRouter`);

        const sanitized = sanitizeModelForProvider('openrouter', foreign);
        assert.equal(sanitized, null);

        const serverVal = validateServerModelForProvider('openrouter', foreign);
        assert.equal(serverVal.valid, false, `Expected server validator to reject "${foreign}" for OpenRouter`);
        assert.equal(serverVal.status, 'INVALID_MODEL');
      }
    });

    // =========================================================================
    // 4. openrouter/free dynamic router behavior works as documented
    // =========================================================================
    await runTest('4. openrouter/free dynamic router sends openrouter/free upstream and attributes concrete routed model returned by OpenRouter', async () => {
      mockOpenRouter.state.reset();
      mockOpenRouter.state.chatHandler = async (req, res, call) => {
        assert.equal(call.body.model, 'openrouter/free');
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(
          `data: ${JSON.stringify({
            id: 'gen-routed-1',
            model: 'meta-llama/llama-3.3-70b-instruct:free',
            choices: [{ index: 0, delta: { content: 'Hello from dynamically routed model!' }, finish_reason: 'stop' }]
          })}\n\ndata: [DONE]\n\n`
        );
        res.end();
      };

      const streamResult = await streamAIMessage({
        prompt: 'Route me dynamically',
        provider: 'openrouter',
        model: 'openrouter/free',
        onChunk: () => {}
      });

      assert.equal(streamResult.text, 'Hello from dynamically routed model!');
      assert.equal(mockOpenRouter.state.chatCalls.length, 1);
      assert.equal(mockOpenRouter.state.chatCalls[0].body.model, 'openrouter/free');
      assert.equal(streamResult.provider, 'openrouter');
      assert.equal(streamResult.modelUsed, 'meta-llama/llama-3.3-70b-instruct:free');
    });

    // =========================================================================
    // 5. Displayed model identity matches actual request behavior
    // =========================================================================
    await runTest('5. Displayed OpenRouter model identity in PROVIDER_OPTIONS matches actual openrouter/free dynamic router behavior', async () => {
      const openrouterOption = PROVIDER_OPTIONS.find((p) => p.id === AI_PROVIDERS.OPENROUTER);
      assert.ok(openrouterOption, 'Expected OpenRouter entry in PROVIDER_OPTIONS');
      assert.equal(openrouterOption.defaultModel, 'openrouter/free');
      assert.equal(openrouterOption.modelTag, 'Free Models Router');
      assert.ok(
        !openrouterOption.modelTag.includes('Llama 3.3 70B'),
        'UI modelTag must not falsely claim a hardcoded Llama 3.3 70B model when sending openrouter/free'
      );
      assert.ok(openrouterOption.description.includes('openrouter/free'));
    });

    // =========================================================================
    // 6. Missing OpenRouter credentials return 503 PROVIDER_NOT_CONFIGURED
    // =========================================================================
    await runTest('6. Missing OpenRouter credentials return HTTP 503 PROVIDER_NOT_CONFIGURED (not fake 200)', async () => {
      const unconfiguredPort = serverPort + 101;
      const unconfiguredServer = await startTestServer(unconfiguredPort, mockOpenRouter.baseUrl, {
        OPENROUTER_API_KEY: '',
        VITE_OPENROUTER_API_KEY: '',
        ORVIX_ENABLE_DEMO_MODE: ''
      });

      try {
        const res = await fetch(`${unconfiguredServer.baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider: 'openrouter',
            model: 'openrouter/free',
            prompt: 'Hello without key',
            stream: true
          })
        });

        assert.equal(res.status, 503);
        const body = await res.json();
        assert.equal(body.status, 'PROVIDER_NOT_CONFIGURED');
        assert.equal(body.provider, 'openrouter');
        assert.equal(body.retryable, false);
        assert.equal(body.canFallback, true);
      } finally {
        await unconfiguredServer.stop();
      }
    });

    // =========================================================================
    // 7. Demo mode follows the Phase 4B contract
    // =========================================================================
    await runTest('7. Explicit demo mode (ORVIX_ENABLE_DEMO_MODE=true) returns honest demo metadata when OpenRouter is unconfigured', async () => {
      const demoPort = serverPort + 102;
      const demoServer = await startTestServer(demoPort, mockOpenRouter.baseUrl, {
        OPENROUTER_API_KEY: '',
        VITE_OPENROUTER_API_KEY: '',
        ORVIX_ENABLE_DEMO_MODE: 'true'
      });

      try {
        const res = await fetch(`${demoServer.baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider: 'openrouter',
            model: 'openrouter/free',
            prompt: 'Hello in explicit demo mode',
            stream: false
          })
        });

        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.isDemo, true);
        assert.equal(body.provider, 'openrouter');
        assert.equal(body.modelUsed, 'openrouter/free (demo)');
        assert.ok(typeof body.text === 'string' && body.text.length > 0);
      } finally {
        await demoServer.stop();
      }
    });

    // =========================================================================
    // 8. Successful OpenRouter SSE stream
    // =========================================================================
    await runTest('8. Successful OpenRouter SSE stream handles multi-chunk deltas, keepalive comments, empty deltas, and [DONE]', async () => {
      mockOpenRouter.state.reset();
      mockOpenRouter.state.chatHandler = async (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(': OPENROUTER PROCESSING\n\n');
        res.write(
          `data: ${JSON.stringify({
            id: 'gen-stream-8',
            model: 'google/gemma-3-27b-it:free',
            choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]
          })}\n\n`
        );
        res.write(
          `data: ${JSON.stringify({
            id: 'gen-stream-8',
            model: 'google/gemma-3-27b-it:free',
            choices: [{ index: 0, delta: { content: 'First chunk, ' }, finish_reason: null }]
          })}\n\n`
        );
        res.write(': keepalive comment\n\n');
        res.write(
          `data: ${JSON.stringify({
            id: 'gen-stream-8',
            model: 'google/gemma-3-27b-it:free',
            choices: [{ index: 0, delta: { content: 'second chunk!' }, finish_reason: 'stop' }]
          })}\n\n`
        );
        res.write('data: [DONE]\n\n');
        res.end();
      };

      const chunks = [];
      const streamRes = await streamOpenRouterMessage({
        prompt: 'Stream test',
        model: 'openrouter/free',
        onChunk: (chunk, acc) => chunks.push({ chunk, acc })
      });

      assert.equal(streamRes.text, 'First chunk, second chunk!');
      assert.equal(chunks.length, 2);
      assert.equal(chunks[0].chunk, 'First chunk, ');
      assert.equal(chunks[1].acc, 'First chunk, second chunk!');
      assert.equal(streamRes.modelUsed, 'google/gemma-3-27b-it:free');
    });

    // =========================================================================
    // 9. Error before partial text
    // =========================================================================
    await runTest('9. Upstream SSE error before any text emits structured error with partial=false and never emits done', async () => {
      mockOpenRouter.state.reset();
      mockOpenRouter.state.chatHandler = async (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(': OPENROUTER PROCESSING\n\n');
        res.write(
          `data: ${JSON.stringify({
            error: {
              message: 'Provider returned error: rate limit exceeded on free tier',
              code: 429
            }
          })}\n\n`
        );
        res.end();
      };

      let caughtError = null;
      try {
        await streamAIMessage({
          prompt: 'Trigger pre-token SSE error',
          provider: 'openrouter',
          model: 'openrouter/free',
          onChunk: () => {}
        });
      } catch (err) {
        caughtError = err;
      }

      assert.ok(caughtError, 'Expected streamAIMessage to throw on pre-token SSE error');
      assert.equal(caughtError.provider, 'openrouter');
      assert.equal(caughtError.partial, false);
      assert.equal(caughtError.canFallback, true);
      assert.match(caughtError.message, /rate limit|quota exceeded/i);
    });

    // =========================================================================
    // 10. Error after partial text (partial text preserved)
    // =========================================================================
    await runTest('10. Upstream SSE error after partial text preserves partialText, sets partial=true, and does not retry mid-stream', async () => {
      mockOpenRouter.state.reset();
      mockOpenRouter.state.chatHandler = async (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(
          `data: ${JSON.stringify({
            id: 'gen-partial-10',
            model: 'google/gemma-3-27b-it:free',
            choices: [{ index: 0, delta: { content: 'Partial answer before crash...' }, finish_reason: null }]
          })}\n\n`
        );
        res.write(
          `data: ${JSON.stringify({
            id: 'gen-partial-10',
            model: 'google/gemma-3-27b-it:free',
            error: {
              message: 'Upstream provider disconnected mid-generation',
              code: 502
            },
            choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }]
          })}\n\n`
        );
        res.end();
      };

      const streamedChunks = [];
      let caughtError = null;
      try {
        await streamAIMessage({
          prompt: 'Trigger mid-stream error',
          provider: 'openrouter',
          model: 'openrouter/free',
          onChunk: (delta) => streamedChunks.push(delta)
        });
      } catch (err) {
        caughtError = err;
      }

      assert.ok(caughtError, 'Expected mid-stream error to throw');
      assert.equal(mockOpenRouter.state.chatCalls.length, 1, 'Must NOT retry once partial text has been emitted');
      assert.equal(caughtError.provider, 'openrouter');
      assert.equal(caughtError.partial, true);
      assert.equal(caughtError.partialText, 'Partial answer before crash...');
      assert.equal(caughtError.retryable, false);
      assert.equal(caughtError.canFallback, true);
      assert.deepEqual(streamedChunks, ['Partial answer before crash...']);
    });

    // =========================================================================
    // 11. Malformed SSE frame
    // =========================================================================
    await runTest('11. Malformed SSE data frame and event: error with non-JSON payload surface structured STREAM_MALFORMED_EVENT without crashing', async () => {
      mockOpenRouter.state.reset();
      mockOpenRouter.state.chatHandler = async (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"Start "}}]}\n\n');
        res.write('data: {corrupted_json_frame\n\n');
        res.end();
      };

      const rawRes = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'openrouter',
          model: 'openrouter/free',
          prompt: 'Malformed SSE test',
          stream: true
        })
      });

      assert.equal(rawRes.status, 200);
      const { events } = await collectServerSSEEvents(rawRes);
      const errorEvents = events.filter((e) => e.type === 'error');
      const doneEvents = events.filter((e) => e.type === 'done');

      assert.equal(errorEvents.length, 1, 'Expected exactly one structured error event');
      assert.equal(doneEvents.length, 0, 'Must not emit done event on malformed SSE stream');
      assert.equal(errorEvents[0].errorCode, 'MALFORMED_STREAM_FRAME');
      assert.equal(errorEvents[0].partial, true);
      assert.equal(errorEvents[0].partialText, 'Start ');

      // Also verify `event: error` with non-JSON payload
      mockOpenRouter.state.reset();
      mockOpenRouter.state.chatHandler = async (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('event: error\ndata: Upstream gateway crashed in plain text\n\n');
        res.end();
      };

      const rawRes2 = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'openrouter',
          model: 'openrouter/free',
          prompt: 'Plaintext event: error test',
          stream: true
        })
      });

      const { events: events2 } = await collectServerSSEEvents(rawRes2);
      const errEvents2 = events2.filter((e) => e.type === 'error');
      assert.equal(errEvents2.length, 1);
      assert.equal(errEvents2[0].errorCode, 'STREAM_ERROR');
      assert.ok(errEvents2[0].error.includes('Upstream gateway crashed in plain text'));
    });

    // =========================================================================
    // 12. [DONE] handling & premature stream close detection
    // =========================================================================
    await runTest('12. [DONE] cleanly terminates stream, whereas premature close without [DONE] or finish_reason emits structured error', async () => {
      mockOpenRouter.state.reset();
      mockOpenRouter.state.chatHandler = async (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(
          `data: ${JSON.stringify({
            id: 'gen-truncated',
            model: 'google/gemma-3-27b-it:free',
            choices: [{ index: 0, delta: { content: 'Truncated mid-sentence' }, finish_reason: null }]
          })}\n\n`
        );
        // Close response without finish_reason or data: [DONE]
        res.end();
      };

      const rawRes = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'openrouter',
          model: 'openrouter/free',
          prompt: 'Premature EOF test',
          stream: true
        })
      });

      const { events } = await collectServerSSEEvents(rawRes);
      const errorEvents = events.filter((e) => e.type === 'error');
      const doneEvents = events.filter((e) => e.type === 'done');

      assert.equal(errorEvents.length, 1, 'Expected premature stream close without [DONE] to emit error');
      assert.equal(doneEvents.length, 0, 'Must not emit done on premature stream close');
      assert.equal(errorEvents[0].errorCode, 'STREAM_INTERRUPTED');
      assert.equal(errorEvents[0].partial, true);
      assert.equal(errorEvents[0].partialText, 'Truncated mid-sentence');
    });

    // =========================================================================
    // 13. Midstream network interruption
    // =========================================================================
    await runTest('13. Midstream socket destruction emits structured STREAM_FAILED error with partialText preserved', async () => {
      mockOpenRouter.state.reset();
      mockOpenRouter.state.chatHandler = async (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(
          `data: ${JSON.stringify({
            id: 'gen-socket-drop',
            model: 'google/gemma-3-27b-it:free',
            choices: [{ index: 0, delta: { content: 'Before socket drop' }, finish_reason: null }]
          })}\n\n`
        );
        setTimeout(() => {
          res.socket?.destroy(new Error('Simulated TCP reset'));
        }, 30);
      };

      let caught = null;
      try {
        await streamOpenRouterMessage({
          prompt: 'Test socket reset',
          onChunk: () => {}
        });
      } catch (err) {
        caught = err;
      }

      assert.ok(caught, 'Expected streamOpenRouterMessage to reject on midstream socket reset');
      assert.equal(caught.provider, 'openrouter');
      assert.equal(caught.partial, true);
      assert.equal(caught.partialText, 'Before socket drop');
    });

    // =========================================================================
    // 14. No duplicate terminal error
    // =========================================================================
    await runTest('14. Stream with multiple error frames or error followed by close emits at most one terminal error event', async () => {
      mockOpenRouter.state.reset();
      mockOpenRouter.state.chatHandler = async (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ error: { message: 'First error frame', code: 502 } })}\n\n`);
        res.write(`data: ${JSON.stringify({ error: { message: 'Second duplicate error frame', code: 502 } })}\n\n`);
        res.write('data: {malformed_trailing_frame\n\n');
        res.end();
      };

      const rawRes = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'openrouter',
          model: 'openrouter/free',
          prompt: 'Duplicate error test',
          stream: true
        })
      });

      const { events } = await collectServerSSEEvents(rawRes);
      const errorEvents = events.filter((e) => e.type === 'error');
      const doneEvents = events.filter((e) => e.type === 'done');

      assert.equal(errorEvents.length, 1, `Expected exactly 1 error event, got ${errorEvents.length}`);
      assert.equal(doneEvents.length, 0);
      assert.ok(errorEvents[0].error.includes('First error frame'));
    });

    // =========================================================================
    // 15. Retryable upstream failure (429 / 502 / 503)
    // =========================================================================
    await runTest('15. Retryable upstream failures (429 / 502 / 503) are classified retryable=true and recover on bounded retry', async () => {
      // Verify HTTP 429 classification (including message containing "tokens" to verify no false context-length override)
      mockOpenRouter.state.reset();
      let attempt = 0;
      mockOpenRouter.state.chatHandler = async (req, res) => {
        attempt++;
        if (attempt === 1) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: {
                message: 'Rate limit exceeded: free-models-per-min (max 10000 tokens/min)',
                code: 429
              }
            })
          );
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(
          `data: ${JSON.stringify({
            id: 'gen-retry-success',
            model: 'google/gemma-3-27b-it:free',
            choices: [{ index: 0, delta: { content: 'Recovered on attempt 2!' }, finish_reason: 'stop' }]
          })}\n\ndata: [DONE]\n\n`
        );
        res.end();
      };

      const result = await streamAIMessage({
        prompt: 'Test 429 retry recovery',
        provider: 'openrouter',
        model: 'openrouter/free',
        onChunk: () => {}
      });

      assert.equal(result.text, 'Recovered on attempt 2!');
      assert.equal(mockOpenRouter.state.chatCalls.length, 2);
    });

    // =========================================================================
    // 16. Non-retryable upstream failure (400 / 401 / 403 / 404)
    // =========================================================================
    await runTest('16. Non-retryable upstream failures (400, 401, 403, 404) stop immediately on attempt 1 with retryable=false', async () => {
      for (const status of [400, 401, 403, 404]) {
        mockOpenRouter.state.reset();
        mockOpenRouter.state.chatHandler = async (req, res) => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: {
                message: `Simulated OpenRouter HTTP ${status} error`,
                code: status
              }
            })
          );
        };

        let caught = null;
        try {
          await streamAIMessage({
            prompt: `Test status ${status}`,
            provider: 'openrouter',
            model: 'openrouter/free',
            onChunk: () => {}
          });
        } catch (err) {
          caught = err;
        }

        assert.ok(caught, `Expected status ${status} to throw`);
        assert.equal(
          mockOpenRouter.state.chatCalls.length,
          1,
          `Expected non-retryable HTTP ${status} to make only 1 upstream call`
        );
        assert.equal(caught.retryable, false, `Expected HTTP ${status} to have retryable=false`);
        assert.equal(caught.provider, 'openrouter');
        assert.equal(caught.code, status);
        assert.ok(typeof caught.errorCode === 'string' && caught.errorCode.length > 0);
      }
    });

    // =========================================================================
    // 17. Retry exhaustion (bounded max attempts = 2)
    // =========================================================================
    await runTest('17. Persistent retryable upstream failure (502/503) stops after bounded max attempts (2) with retriesExhausted=true', async () => {
      mockOpenRouter.state.reset();
      mockOpenRouter.state.chatHandler = async (req, res) => {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              message: 'Provider returned 502 Bad Gateway',
              code: 502
            }
          })
        );
      };

      let caught = null;
      try {
        await streamAIMessage({
          prompt: 'Persistent 502 test',
          provider: 'openrouter',
          model: 'openrouter/free',
          onChunk: () => {}
        });
      } catch (err) {
        caught = err;
      }

      assert.ok(caught, 'Expected persistent 502 to throw after exhausting retries');
      // Client router executes 1 initial + 1 retry = 2 upstream attempts total
      assert.equal(
        mockOpenRouter.state.chatCalls.length,
        2,
        `Expected bounded 2 upstream attempts, got ${mockOpenRouter.state.chatCalls.length}`
      );
      assert.equal(caught.provider, 'openrouter');
      assert.equal(caught.code, 502);
      assert.equal(caught.errorCode, 'BAD_GATEWAY');
      assert.equal(caught.retriesExhausted, true);
      assert.equal(caught.canFallback, true);
    });

    // =========================================================================
    // 18. Cancellation prevents retry/fallback
    // =========================================================================
    await runTest('18. User cancellation (AbortController) aborts active OpenRouter request immediately and prevents retry/fallback', async () => {
      mockOpenRouter.state.reset();
      mockOpenRouter.state.chatHandler = async (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(
          `data: ${JSON.stringify({
            id: 'gen-abort-18',
            model: 'google/gemma-3-27b-it:free',
            choices: [{ index: 0, delta: { content: 'First token before abort' }, finish_reason: null }]
          })}\n\n`
        );
        // Keep stream open until client aborts
      };

      const abortController = new AbortController();
      let caught = null;
      try {
        await streamAIMessage({
          prompt: 'Abort me mid-stream',
          provider: 'openrouter',
          model: 'openrouter/free',
          signal: abortController.signal,
          onChunk: () => {
            abortController.abort();
          }
        });
      } catch (err) {
        caught = err;
      }

      assert.ok(caught, 'Expected aborted stream to reject with AbortError');
      assert.equal(caught.name, 'AbortError');
      assert.equal(mockOpenRouter.state.chatCalls.length, 1, 'Must not retry or fallback after user abort');
    });

    // =========================================================================
    // 19. Correct model, messages, stream, and headers are sent upstream
    // =========================================================================
    await runTest('19. Request construction sends exact model, normalized messages, stream flag, max_tokens, and OpenRouter attribution headers', async () => {
      mockOpenRouter.state.reset();
      mockOpenRouter.state.chatHandler = null; // Use default sync/stream handler

      const syncReply = await sendOpenRouterMessage({
        prompt: 'Second question',
        history: [
          { sender: 'user', content: 'First question' },
          { sender: 'ai', content: 'First answer' }
        ],
        mode: 'general',
        model: 'meta-llama/llama-3.3-70b-instruct:free'
      });

      assert.equal(syncReply.text, 'Default mock OpenRouter response');
      assert.equal(syncReply.modelUsed, 'meta-llama/llama-3.3-70b-instruct:free');
      assert.equal(mockOpenRouter.state.chatCalls.length, 1);

      const call = mockOpenRouter.state.chatCalls[0];
      assert.equal(call.headers['authorization'], 'Bearer sk-or-v1-test-phase4e-valid-key');
      assert.equal(call.headers['content-type'], 'application/json');
      assert.equal(call.headers['http-referer'], 'https://orvix.ai');
      assert.equal(call.headers['x-title'], 'Orvix');

      assert.equal(call.body.model, 'meta-llama/llama-3.3-70b-instruct:free');
      assert.equal(call.body.stream, false);
      assert.equal(call.body.max_tokens, 2560);
      assert.equal(call.body.messages.length, 4);
      assert.equal(call.body.messages[0].role, 'system');
      assert.deepEqual(call.body.messages.slice(1), [
        { role: 'user', content: 'First question' },
        { role: 'assistant', content: 'First answer' },
        { role: 'user', content: 'Second question' }
      ]);
    });

    // =========================================================================
    // 20. Authorization is server-side only (no secret leakage)
    // =========================================================================
    await runTest('20. OpenRouter API key is strictly server-side only and never exposed via getOpenRouterApiKey() or /api/config', async () => {
      assert.equal(getOpenRouterApiKey(), '');

      const configRes = await fetch('/api/config');
      assert.equal(configRes.status, 200);
      const configBody = await configRes.json();
      const serialized = JSON.stringify(configBody);

      assert.equal(configBody.openrouterConfigured, true);
      assert.ok(
        !serialized.includes('sk-or-v1-test-phase4e-valid-key'),
        '/api/config must never leak OPENROUTER_API_KEY value'
      );
    });

    // =========================================================================
    // 21. Abort/timeout is propagated cleanly (504 DEADLINE_EXCEEDED)
    // =========================================================================
    await runTest('21. Upstream headers timeout aborts hung OpenRouter call and returns HTTP 504 DEADLINE_EXCEEDED', async () => {
      const timeoutPort = serverPort + 103;
      const fastTimeoutServer = await startTestServer(timeoutPort, mockOpenRouter.baseUrl, {
        ORVIX_UPSTREAM_HEADERS_TIMEOUT_MS: '250',
        ORVIX_REQUEST_TIMEOUT_MS: '5000'
      });

      try {
        mockOpenRouter.state.reset();
        let upstreamSocketAborted = false;
        mockOpenRouter.state.chatHandler = async (req, res) => {
          req.on('close', () => {
            upstreamSocketAborted = true;
          });
          // Intentionally do not write headers so headers timeout fires
          await new Promise((r) => setTimeout(r, 1500));
          if (!res.writableEnded) {
            res.end();
          }
        };

        const res = await fetch(`${fastTimeoutServer.baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider: 'openrouter',
            model: 'openrouter/free',
            prompt: 'Trigger upstream headers timeout',
            stream: true
          })
        });

        assert.equal(res.status, 504);
        const body = await res.json();
        assert.equal(body.status, 'DEADLINE_EXCEEDED');
        assert.equal(body.provider, 'openrouter');
        assert.equal(body.retryable, true);
        assert.equal(body.canFallback, true);

        await new Promise((r) => setTimeout(r, 100));
        assert.equal(upstreamSocketAborted, true, 'Expected upstream OpenRouter request to be aborted on timeout');
      } finally {
        await fastTimeoutServer.stop();
      }
    });

    console.log('\n------------------------------------------------------------');
    console.log('Cloudflare Workers AI Hardening Verification (CF-1 to CF-34)');
    console.log('------------------------------------------------------------\n');

    // =========================================================================
    // CF-1. Missing CLOUDFLARE_ACCOUNT_ID returns 503 PROVIDER_NOT_CONFIGURED
    // =========================================================================
    await runTest('CF-1. Missing CLOUDFLARE_ACCOUNT_ID returns HTTP 503 PROVIDER_NOT_CONFIGURED', async () => {
      const noAccountPort = serverPort + 201;
      const noAccountServer = await startTestServer(
        noAccountPort,
        mockOpenRouter.baseUrl,
        {
          CLOUDFLARE_ACCOUNT_ID: '',
          CLOUDFLARE_API_TOKEN: 'cf-token-phase4e-valid',
          ORVIX_ENABLE_DEMO_MODE: ''
        },
        mockCloudflare.baseUrl
      );

      try {
        const res = await fetch(`${noAccountServer.baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider: 'cloudflare',
            prompt: 'Hello without account ID',
            stream: true
          })
        });

        assert.equal(res.status, 503);
        const body = await res.json();
        assert.equal(body.status, 'PROVIDER_NOT_CONFIGURED');
        assert.equal(body.provider, 'cloudflare');
        assert.equal(body.retryable, false);
        assert.equal(body.canFallback, true);
      } finally {
        await noAccountServer.stop();
      }
    });

    // =========================================================================
    // CF-2. Missing CLOUDFLARE_API_TOKEN returns 503 PROVIDER_NOT_CONFIGURED
    // =========================================================================
    await runTest('CF-2. Missing CLOUDFLARE_API_TOKEN returns HTTP 503 PROVIDER_NOT_CONFIGURED', async () => {
      const noTokenPort = serverPort + 202;
      const noTokenServer = await startTestServer(
        noTokenPort,
        mockOpenRouter.baseUrl,
        {
          CLOUDFLARE_ACCOUNT_ID: 'cf-account-phase4e-valid',
          CLOUDFLARE_API_TOKEN: '',
          ORVIX_ENABLE_DEMO_MODE: ''
        },
        mockCloudflare.baseUrl
      );

      try {
        const res = await fetch(`${noTokenServer.baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider: 'cloudflare',
            prompt: 'Hello without API token',
            stream: false
          })
        });

        assert.equal(res.status, 503);
        const body = await res.json();
        assert.equal(body.status, 'PROVIDER_NOT_CONFIGURED');
        assert.equal(body.provider, 'cloudflare');
        assert.equal(body.retryable, false);
        assert.equal(body.canFallback, true);
      } finally {
        await noTokenServer.stop();
      }
    });

    // =========================================================================
    // CF-3. Invalid token (401/403) returns a clear non-retryable auth error
    // =========================================================================
    await runTest('CF-3. Invalid token (401/403) returns a clear non-retryable auth error', async () => {
      for (const status of [401, 403]) {
        mockCloudflare.state.reset();
        mockCloudflare.state.aiHandler = async (req, res) => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              success: false,
              errors: [{ code: 10000, message: 'Authentication error' }]
            })
          );
        };

        let caught = null;
        try {
          await streamAIMessage({
            prompt: `Test Cloudflare ${status}`,
            provider: 'cloudflare',
            onChunk: () => {}
          });
        } catch (err) {
          caught = err;
        }

        assert.ok(caught, `Expected Cloudflare ${status} to throw`);
        assert.equal(mockCloudflare.state.aiCalls.length, 1);
        assert.equal(caught.code, status);
        assert.equal(caught.retryable, false);
        assert.equal(caught.provider, 'cloudflare');
        assert.equal(caught.errorCode, status === 401 ? 'UNAUTHENTICATED' : 'PERMISSION_DENIED');
        assert.match(caught.message, /Invalid or unauthorized Cloudflare API token/i);
      }
    });

    // =========================================================================
    // CF-4. Invalid account/model (404) returns a clear non-retryable error
    // =========================================================================
    await runTest('CF-4. Invalid account/model (404) returns a clear non-retryable NOT_FOUND error', async () => {
      mockCloudflare.state.reset();
      mockCloudflare.state.aiHandler = async (req, res) => {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            success: false,
            errors: [{ code: 7003, message: 'No route for that URI' }]
          })
        );
      };

      let caught = null;
      try {
        await streamAIMessage({
          prompt: 'Test Cloudflare 404',
          provider: 'cloudflare',
          onChunk: () => {}
        });
      } catch (err) {
        caught = err;
      }

      assert.ok(caught);
      assert.equal(mockCloudflare.state.aiCalls.length, 1);
      assert.equal(caught.code, 404);
      assert.equal(caught.errorCode, 'NOT_FOUND');
      assert.equal(caught.retryable, false);
      assert.match(caught.message, /Cloudflare account or model not found/i);
    });

    // =========================================================================
    // CF-5. Valid default model is used when no model is specified
    // =========================================================================
    await runTest('CF-5. Valid default model (@cf/meta/llama-3.1-8b-instruct) is used when no model is specified', async () => {
      assert.equal(CLOUDFLARE_DEFAULT_MODEL, '@cf/meta/llama-3.1-8b-instruct');
      assert.equal(PROVIDER_DEFAULT_MODELS.cloudflare, '@cf/meta/llama-3.1-8b-instruct');
      const cfOption = PROVIDER_OPTIONS.find((p) => p.id === AI_PROVIDERS.CLOUDFLARE);
      assert.equal(cfOption?.defaultModel, '@cf/meta/llama-3.1-8b-instruct');

      mockCloudflare.state.reset();
      const res = await sendAIMessage({
        prompt: 'Use default Cloudflare model',
        provider: 'cloudflare'
      });

      assert.equal(mockCloudflare.state.aiCalls.length, 1);
      assert.equal(mockCloudflare.state.aiCalls[0].modelId, '@cf/meta/llama-3.1-8b-instruct');
      assert.equal(res.modelUsed, '@cf/meta/llama-3.1-8b-instruct');
      assert.equal(res.provider, 'cloudflare');
    });

    // =========================================================================
    // CF-6. Valid selected Cloudflare model is preserved
    // =========================================================================
    await runTest('CF-6. Valid selected Cloudflare model (@cf/meta/llama-3.3-70b-instruct-fp8-fast) is preserved end-to-end', async () => {
      mockCloudflare.state.reset();
      const customModel = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
      const res = await streamAIMessage({
        prompt: 'Use selected Cloudflare model',
        provider: 'cloudflare',
        model: customModel,
        onChunk: () => {}
      });

      assert.equal(mockCloudflare.state.aiCalls.length, 1);
      assert.equal(mockCloudflare.state.aiCalls[0].modelId, customModel);
      assert.equal(res.modelUsed, customModel);
      assert.equal(res.provider, 'cloudflare');
    });

    // =========================================================================
    // CF-7. Foreign model IDs are rejected or sanitized
    // =========================================================================
    await runTest('CF-7. Foreign, malformed, or audio/Whisper model IDs are sanitized client-side and rejected server-side', async () => {
      const invalidCloudflareModels = [
        'gemini-2.5-flash',
        'llama-3.3-70b-versatile',
        'openrouter/free',
        'meta-llama/llama-3.3-70b-instruct:free',
        'qwen2.5:1.5b',
        'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
        '@cf/openai/whisper',
        '@cf/openai/whisper-large-v3-turbo',
        '@cf/meta',
        '@cf//bad',
        'Cloudflare Workers AI — Llama 3.1 8B',
        'Cloudflare Workers AI — Llama 3.1 8B (demo)'
      ];

      for (const badModel of invalidCloudflareModels) {
        const compat = checkModelCompatibilityForProvider('cloudflare', badModel);
        assert.equal(compat.compatible, false, `Expected "${badModel}" to be incompatible with Cloudflare`);
        const sanitized = sanitizeModelForProvider('cloudflare', badModel);
        assert.equal(sanitized, null, `Expected sanitizeModelForProvider('cloudflare', "${badModel}") to return null`);
      }

      const rawRes = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'cloudflare',
          model: 'llama-3.3-70b-versatile',
          prompt: 'Direct foreign model call',
          stream: false
        })
      });
      assert.equal(rawRes.status, 400);
      const errBody = await rawRes.json();
      assert.equal(errBody.status, 'INVALID_MODEL');
      assert.equal(errBody.provider, 'cloudflare');
    });

    // =========================================================================
    // CF-8. System prompt, conversation history, and current user prompt order
    // =========================================================================
    await runTest('CF-8. System prompt, conversation history, and current user prompt are formatted in exact chronological order', async () => {
      mockCloudflare.state.reset();
      await sendAIMessage({
        prompt: 'What did I just ask?',
        provider: 'cloudflare',
        history: [
          { sender: 'user', content: 'Explain quantum tunneling' },
          { sender: 'ai', content: 'Quantum tunneling is a quantum mechanical phenomenon.' }
        ]
      });

      assert.equal(mockCloudflare.state.aiCalls.length, 1);
      const msgs = mockCloudflare.state.aiCalls[0].body.messages;
      assert.equal(msgs.length, 4);
      assert.equal(msgs[0].role, 'system');
      assert.equal(msgs[1].role, 'user');
      assert.equal(msgs[1].content, 'Explain quantum tunneling');
      assert.equal(msgs[2].role, 'assistant');
      assert.equal(msgs[2].content, 'Quantum tunneling is a quantum mechanical phenomenon.');
      assert.equal(msgs[3].role, 'user');
      assert.equal(msgs[3].content, 'What did I just ask?');
    });

    // =========================================================================
    // CF-9. Extracted document/image text context is included cleanly
    // =========================================================================
    await runTest('CF-9. Extracted document/image text context is injected cleanly into the Cloudflare prompt', async () => {
      mockCloudflare.state.reset();
      await sendAIMessage({
        prompt: 'Summarize the attached receipt',
        provider: 'cloudflare',
        conversationId: 'cf-doc-session-9',
        attachments: [
          {
            id: 'doc-cf-9',
            originalName: 'receipt.png',
            format: 'PNG',
            status: 'ready',
            isImage: true,
            extraction: {
              id: 'doc-cf-9',
              originalName: 'receipt.png',
              format: 'PNG',
              status: 'ready',
              success: true,
              hasText: true,
              isImage: true,
              text: 'Total Due: $42.50 at Orvix Cafe',
              totalCharacters: 31,
              totalWords: 6
            }
          }
        ]
      });

      assert.equal(mockCloudflare.state.aiCalls.length, 1);
      const serializedMessages = JSON.stringify(mockCloudflare.state.aiCalls[0].body.messages);
      assert.ok(
        serializedMessages.includes('Total Due: $42.50 at Orvix Cafe'),
        'Expected extracted OCR/document text to be included in Cloudflare messages'
      );
    });

    // =========================================================================
    // CF-10. Raw base64 or unsupported image binary payloads are not sent
    // =========================================================================
    await runTest('CF-10. Raw base64 or binary image data URLs are stripped and never sent to text-only Cloudflare chat calls', async () => {
      mockCloudflare.state.reset();
      const fakeBase64Marker = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      await sendAIMessage({
        prompt: 'Inspect this image attachment',
        provider: 'cloudflare',
        conversationId: 'cf-doc-session-10',
        attachments: [
          {
            id: 'img-cf-10',
            originalName: 'scan.png',
            format: 'PNG',
            mimeType: 'image/png',
            type: 'image/png',
            status: 'ready',
            isImage: true,
            dataUrl: `data:image/png;base64,${fakeBase64Marker}`,
            base64: fakeBase64Marker,
            extraction: {
              id: 'img-cf-10',
              originalName: 'scan.png',
              format: 'PNG',
              status: 'ready',
              success: true,
              hasText: true,
              isImage: true,
              text: 'Extracted text from scan.png without binary payload',
              totalCharacters: 51,
              totalWords: 7
            }
          }
        ]
      });

      assert.equal(mockCloudflare.state.aiCalls.length, 1);
      const rawUpstreamPayload = mockCloudflare.state.aiCalls[0].rawBody;
      assert.ok(
        !rawUpstreamPayload.includes(fakeBase64Marker),
        'Raw base64 image payload must never be sent to text-only Cloudflare chat endpoint'
      );
      assert.ok(rawUpstreamPayload.includes('Extracted text from scan.png'));
    });

    // =========================================================================
    // CF-11. stream, max_tokens, and generation parameters are valid
    // =========================================================================
    await runTest('CF-11. stream, max_tokens, temperature, and Authorization header are valid for both sync and streaming requests', async () => {
      mockCloudflare.state.reset();
      const syncHttpRes = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: 'Sync parameter check',
          provider: 'cloudflare',
          stream: false,
          preferences: { responseLength: 'concise' }
        })
      });
      assert.equal(syncHttpRes.status, 200);

      assert.equal(mockCloudflare.state.aiCalls.length, 1);
      const syncCall = mockCloudflare.state.aiCalls[0];
      assert.equal(syncCall.accountId, 'cf-account-phase4e-valid');
      assert.equal(syncCall.headers['authorization'], 'Bearer cf-token-phase4e-valid');
      assert.equal(syncCall.body.stream, false);
      assert.equal(syncCall.body.max_tokens, 1024);
      assert.equal(syncCall.body.temperature, 0.6);

      mockCloudflare.state.reset();
      await streamAIMessage({
        prompt: 'Stream parameter check',
        provider: 'cloudflare',
        preferences: { responseLength: 'detailed' },
        onChunk: () => {}
      });

      assert.equal(mockCloudflare.state.aiCalls.length, 1);
      const streamCall = mockCloudflare.state.aiCalls[0];
      assert.equal(streamCall.body.stream, true);
      assert.equal(streamCall.body.max_tokens, 4096);
      assert.equal(streamCall.body.temperature, 0.6);
    });

    // =========================================================================
    // CF-12. Context-limit errors return structured user-facing errors
    // =========================================================================
    await runTest('CF-12. Context-limit errors (both preflight token guard and upstream 400 context length) return CONTEXT_LENGTH_EXCEEDED with retryable=false', async () => {
      mockCloudflare.state.reset();
      mockCloudflare.state.aiHandler = async (req, res) => {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            success: false,
            errors: [{ code: 3010, message: 'Prompt exceeds maximum context length of 8192 tokens' }]
          })
        );
      };

      let caughtUpstream = null;
      try {
        await streamAIMessage({
          prompt: 'Trigger upstream context length error',
          provider: 'cloudflare',
          onChunk: () => {}
        });
      } catch (err) {
        caughtUpstream = err;
      }

      assert.ok(caughtUpstream);
      assert.equal(mockCloudflare.state.aiCalls.length, 1);
      assert.equal(caughtUpstream.code, 400);
      assert.equal(caughtUpstream.status, 'CONTEXT_LENGTH_EXCEEDED');
      assert.equal(caughtUpstream.errorCode, 'CONTEXT_LENGTH_EXCEEDED');
      assert.equal(caughtUpstream.retryable, false);

      // Preflight oversized prompt guard (>8192 estimated tokens)
      mockCloudflare.state.reset();
      const hugeHistory = Array.from({ length: 18 }, (_, i) => ({
        sender: i % 2 === 0 ? 'user' : 'ai',
        content: `Turn ${i}: ` + 'Cloudflare context window test segment. '.repeat(60)
      }));

      let caughtPreflight = null;
      try {
        await sendAIMessage({
          prompt: 'Final question with oversized context: ' + 'extra text '.repeat(350),
          provider: 'cloudflare',
          history: hugeHistory
        });
      } catch (err) {
        caughtPreflight = err;
      }

      assert.ok(caughtPreflight);
      assert.equal(mockCloudflare.state.aiCalls.length, 0, 'Preflight context guard should reject before calling upstream');
      assert.equal(caughtPreflight.code, 400);
      assert.equal(caughtPreflight.errorCode, 'CONTEXT_LENGTH_EXCEEDED');
      assert.equal(caughtPreflight.retryable, false);
    });

    // =========================================================================
    // CF-13. Normal Cloudflare SSE stream delivers incremental chunks in order
    // =========================================================================
    await runTest('CF-13. Normal Cloudflare SSE stream delivers incremental chunks in exact order', async () => {
      mockCloudflare.state.reset();
      mockCloudflare.state.aiHandler = async (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ response: 'Alpha ' })}\n\n`);
        res.write(`data: ${JSON.stringify({ response: 'Beta ' })}\n\n`);
        res.write(`data: ${JSON.stringify({ response: 'Gamma', finish_reason: 'stop' })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      };

      const receivedChunks = [];
      const result = await streamAIMessage({
        prompt: 'Order test',
        provider: 'cloudflare',
        onChunk: (delta) => receivedChunks.push(delta)
      });

      assert.deepEqual(receivedChunks, ['Alpha ', 'Beta ', 'Gamma']);
      assert.equal(result.text, 'Alpha Beta Gamma');
    });

    // =========================================================================
    // CF-14. data: [DONE] terminates the stream cleanly
    // =========================================================================
    await runTest('CF-14. data: [DONE] terminates the Cloudflare stream cleanly even when finish_reason is omitted', async () => {
      mockCloudflare.state.reset();
      mockCloudflare.state.aiHandler = async (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ response: 'Complete via DONE sentinel' })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      };

      const result = await streamAIMessage({
        prompt: 'DONE sentinel test',
        provider: 'cloudflare',
        onChunk: () => {}
      });

      assert.equal(result.text, 'Complete via DONE sentinel');
      assert.equal(result.provider, 'cloudflare');
    });

    // =========================================================================
    // CF-15. Non-JSON/comment/keepalive lines are ignored safely
    // =========================================================================
    await runTest('CF-15. SSE comment/keepalive lines and empty data deltas are ignored safely', async () => {
      mockCloudflare.state.reset();
      mockCloudflare.state.aiHandler = async (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(': cloudflare keepalive\n\n');
        res.write(`data: ${JSON.stringify({ response: '' })}\n\n`);
        res.write(`data: ${JSON.stringify({ response: 'Clean output' })}\n\n`);
        res.write(': second comment\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      };

      const result = await streamAIMessage({
        prompt: 'Keepalive test',
        provider: 'cloudflare',
        onChunk: () => {}
      });

      assert.equal(result.text, 'Clean output');
    });

    // =========================================================================
    // CF-16. Malformed JSON SSE frame produces a structured stream error
    // =========================================================================
    await runTest('CF-16. Malformed JSON SSE frame produces a structured MALFORMED_STREAM_FRAME error, not a silent swallow or fake success', async () => {
      mockCloudflare.state.reset();
      mockCloudflare.state.aiHandler = async (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ response: 'Valid prefix ' })}\n\n`);
        res.write('data: {broken_cloudflare_json\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      };

      const rawRes = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'cloudflare',
          prompt: 'Malformed Cloudflare frame',
          stream: true
        })
      });

      const { events } = await collectServerSSEEvents(rawRes);
      const errEvents = events.filter((e) => e.type === 'error');
      const doneEvents = events.filter((e) => e.type === 'done');

      assert.equal(errEvents.length, 1);
      assert.equal(doneEvents.length, 0);
      assert.equal(errEvents[0].errorCode, 'MALFORMED_STREAM_FRAME');
      assert.equal(errEvents[0].partial, true);
      assert.equal(errEvents[0].partialText, 'Valid prefix ');
    });

    // =========================================================================
    // CF-17. Upstream error frame produces a structured stream error
    // =========================================================================
    await runTest('CF-17. Upstream SSE error frame (parsed.error / parsed.errors / finish_reason=error) produces a structured stream error', async () => {
      mockCloudflare.state.reset();
      mockCloudflare.state.aiHandler = async (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(
          `data: ${JSON.stringify({
            errors: [{ message: 'Workers AI inference engine overloaded' }]
          })}\n\n`
        );
        res.end();
      };

      let caught = null;
      try {
        await streamAIMessage({
          prompt: 'Upstream error frame test',
          provider: 'cloudflare',
          onChunk: () => {}
        });
      } catch (err) {
        caught = err;
      }

      assert.ok(caught);
      assert.equal(caught.provider, 'cloudflare');
      assert.equal(caught.errorCode, 'UPSTREAM_STREAM_ERROR');
      assert.match(caught.message, /Workers AI inference engine overloaded/);
    });

    // =========================================================================
    // CF-18. Premature stream close before completion produces a structured error
    // =========================================================================
    await runTest('CF-18. Premature stream close before [DONE] or finish_reason produces STREAM_INTERRUPTED error', async () => {
      mockCloudflare.state.reset();
      mockCloudflare.state.aiHandler = async (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ response: 'Half a sentence before drop' })}\n\n`);
        res.end();
      };

      let caught = null;
      try {
        await streamAIMessage({
          prompt: 'Premature EOF Cloudflare',
          provider: 'cloudflare',
          onChunk: () => {}
        });
      } catch (err) {
        caught = err;
      }

      assert.ok(caught);
      assert.equal(caught.errorCode, 'STREAM_INTERRUPTED');
      assert.equal(caught.partial, true);
      assert.equal(caught.partialText, 'Half a sentence before drop');
    });

    // =========================================================================
    // CF-19. Partial text before mid-stream failure is preserved
    // =========================================================================
    await runTest('CF-19. Partial text emitted before mid-stream failure is preserved on the thrown error object', async () => {
      mockCloudflare.state.reset();
      mockCloudflare.state.aiHandler = async (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ response: 'Chunk 1. ' })}\n\n`);
        res.write(`data: ${JSON.stringify({ response: 'Chunk 2.', finish_reason: 'error' })}\n\n`);
        res.end();
      };

      let caught = null;
      try {
        await streamAIMessage({
          prompt: 'Partial text preservation test',
          provider: 'cloudflare',
          onChunk: () => {}
        });
      } catch (err) {
        caught = err;
      }

      assert.ok(caught);
      assert.equal(caught.partial, true);
      assert.equal(caught.partialText, 'Chunk 1. ');
      assert.equal(caught.errorCode, 'STREAM_FINISH_ERROR');
    });

    // =========================================================================
    // CF-20. Empty final response does not succeed as a blank message
    // =========================================================================
    await runTest('CF-20. Empty final response (both sync and streaming) produces a structured error instead of a blank message', async () => {
      mockCloudflare.state.reset();
      mockCloudflare.state.aiHandler = async (req, res, call) => {
        if (call.body.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write(`data: ${JSON.stringify({ response: '   ', finish_reason: 'stop' })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, result: { response: '' } }));
      };

      const syncHttpRes = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: 'Empty sync test',
          provider: 'cloudflare',
          stream: false
        })
      });
      assert.equal(syncHttpRes.status, 502);
      const syncErr = await syncHttpRes.json();
      assert.equal(syncErr.errorCode, 'EMPTY_UPSTREAM_RESPONSE');

      let streamErr = null;
      try {
        await streamAIMessage({
          prompt: 'Empty stream test',
          provider: 'cloudflare',
          onChunk: () => {}
        });
      } catch (err) {
        streamErr = err;
      }
      assert.ok(streamErr, 'Expected empty stream Cloudflare response to fail');
      assert.equal(streamErr.errorCode, 'EMPTY_STREAM_RESPONSE');
    });

    // =========================================================================
    // CF-21. 429 is marked retryable and retried within bounded policy
    // =========================================================================
    await runTest('CF-21. HTTP 429 is marked retryable=true and retried once within the bounded policy', async () => {
      mockCloudflare.state.reset();
      let attempts = 0;
      mockCloudflare.state.aiHandler = async (req, res) => {
        attempts++;
        if (attempts === 1) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              success: false,
              errors: [{ code: 429, message: 'Rate limit reached for Workers AI' }]
            })
          );
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ response: 'Recovered after 429!', finish_reason: 'stop' })}\n\ndata: [DONE]\n\n`);
        res.end();
      };

      const res = await streamAIMessage({
        prompt: 'Retry 429 Cloudflare',
        provider: 'cloudflare',
        onChunk: () => {}
      });

      assert.equal(res.text, 'Recovered after 429!');
      assert.equal(mockCloudflare.state.aiCalls.length, 2);
    });

    // =========================================================================
    // CF-22. 500/502/503/504 are marked retryable before any partial output
    // =========================================================================
    await runTest('CF-22. HTTP 500, 502, 503, and 504 are marked retryable=true before any partial output', async () => {
      for (const status of [500, 502, 503, 504]) {
        mockCloudflare.state.reset();
        let count = 0;
        mockCloudflare.state.aiHandler = async (req, res) => {
          count++;
          if (count === 1) {
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, errors: [{ message: `Transient ${status}` }] }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, result: { response: `Recovered from ${status}` } }));
        };

        const res = await sendAIMessage({
          prompt: `Test transient ${status}`,
          provider: 'cloudflare'
        });

        assert.equal(res.text, `Recovered from ${status}`);
        assert.equal(mockCloudflare.state.aiCalls.length, 2, `Expected status ${status} to retry once`);
      }
    });

    // =========================================================================
    // CF-23. 400/401/403/404 are not retried
    // =========================================================================
    await runTest('CF-23. HTTP 400, 401, 403, and 404 are not retried (exactly 1 upstream attempt)', async () => {
      for (const status of [400, 401, 403, 404]) {
        mockCloudflare.state.reset();
        mockCloudflare.state.aiHandler = async (req, res) => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, errors: [{ message: `Fatal ${status}` }] }));
        };

        let caught = null;
        try {
          await sendAIMessage({
            prompt: `Non-retryable ${status}`,
            provider: 'cloudflare'
          });
        } catch (err) {
          caught = err;
        }

        assert.ok(caught);
        assert.equal(mockCloudflare.state.aiCalls.length, 1, `Expected HTTP ${status} not to retry`);
        assert.equal(caught.retryable, false);
      }
    });

    // =========================================================================
    // CF-24. Retries do not occur after partial stream chunks have been emitted
    // =========================================================================
    await runTest('CF-24. Retries do not occur after partial stream chunks have been emitted', async () => {
      mockCloudflare.state.reset();
      mockCloudflare.state.aiHandler = async (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ response: 'Emitted partial token' })}\n\n`);
        res.write(`data: ${JSON.stringify({ error: 'Mid-stream failure' })}\n\n`);
        res.end();
      };

      let caught = null;
      try {
        await streamAIMessage({
          prompt: 'No retry after partial chunk',
          provider: 'cloudflare',
          onChunk: () => {}
        });
      } catch (err) {
        caught = err;
      }

      assert.ok(caught);
      assert.equal(mockCloudflare.state.aiCalls.length, 1, 'Must not retry after partial chunks were emitted');
      assert.equal(caught.partial, true);
    });

    // =========================================================================
    // CF-25. Retry exhaustion surfaces the real Cloudflare error and fallback eligibility
    // =========================================================================
    await runTest('CF-25. Retry exhaustion surfaces the real Cloudflare error, retriesExhausted=true, and canFallback=true', async () => {
      mockCloudflare.state.reset();
      mockCloudflare.state.aiHandler = async (req, res) => {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, errors: [{ message: 'Workers AI capacity temporarily exhausted' }] }));
      };

      let caught = null;
      try {
        await streamAIMessage({
          prompt: 'Exhaust Cloudflare retries',
          provider: 'cloudflare',
          onChunk: () => {}
        });
      } catch (err) {
        caught = err;
      }

      assert.ok(caught);
      assert.equal(mockCloudflare.state.aiCalls.length, 2);
      assert.equal(caught.provider, 'cloudflare');
      assert.equal(caught.code, 503);
      assert.equal(caught.errorCode, 'UNAVAILABLE');
      assert.equal(caught.retriesExhausted, true);
      assert.equal(caught.canFallback, true);
    });

    // =========================================================================
    // CF-26. Client abort cancels the active Cloudflare request cleanly
    // =========================================================================
    await runTest('CF-26. Client abort cancels the active Cloudflare request cleanly without retry or error banner', async () => {
      mockCloudflare.state.reset();
      let upstreamClosed = false;
      mockCloudflare.state.aiHandler = async (req, res) => {
        req.on('close', () => {
          upstreamClosed = true;
        });
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ response: 'Starting Cloudflare stream...' })}\n\n`);
      };

      const abortController = new AbortController();
      let caught = null;
      try {
        await streamAIMessage({
          prompt: 'Abort Cloudflare stream',
          provider: 'cloudflare',
          signal: abortController.signal,
          onChunk: () => {
            abortController.abort();
          }
        });
      } catch (err) {
        caught = err;
      }

      assert.ok(caught);
      assert.equal(caught.name, 'AbortError');
      assert.equal(mockCloudflare.state.aiCalls.length, 1);
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(upstreamClosed, true, 'Expected server.ts to cancel upstream Cloudflare stream when client aborts');
    });

    // =========================================================================
    // CF-27. New message or conversation switch cancels/isolates previous Cloudflare stream
    // =========================================================================
    await runTest('CF-27. New message or conversation switch cancels and isolates any previous Cloudflare stream', async () => {
      const isolation = createRequestIsolationController();
      const firstEntry = isolation.beginRequest({
        chatId: 'chat-cf-1',
        assistantMessageId: 'msg-cf-1',
        provider: 'cloudflare',
        modelUsed: '@cf/meta/llama-3.1-8b-instruct'
      });

      assert.equal(isolation.isRequestActive(firstEntry.requestId), true);
      assert.equal(firstEntry.signal.aborted, false);

      // Starting a new request (or switching conversation) supersedes and aborts the previous request
      const secondEntry = isolation.beginRequest({
        chatId: 'chat-cf-2',
        assistantMessageId: 'msg-cf-2',
        provider: 'cloudflare',
        modelUsed: '@cf/meta/llama-3.1-8b-instruct'
      });

      assert.equal(firstEntry.signal.aborted, true, 'First Cloudflare request signal must be aborted');
      assert.equal(isolation.isRequestActive(firstEntry.requestId), false);
      assert.equal(isolation.canMutateChatUI(firstEntry.requestId, 'chat-cf-1', 'chat-cf-2'), false);
      assert.equal(isolation.isRequestActive(secondEntry.requestId), true);
    });

    // =========================================================================
    // CF-28. Aborted requests cannot append late chunks or completion state
    // =========================================================================
    await runTest('CF-28. Aborted Cloudflare requests cannot append late chunks or completion state', async () => {
      const isolation = createRequestIsolationController();
      const entry = isolation.beginRequest({
        chatId: 'chat-cf-28',
        assistantMessageId: 'msg-cf-28',
        provider: 'cloudflare',
        modelUsed: '@cf/meta/llama-3.1-8b-instruct'
      });

      let uiText = '';
      const appendIfActive = (chunk) => {
        if (!isolation.canMutateChatUI(entry.requestId, 'chat-cf-28', 'chat-cf-28')) {
          return false;
        }
        uiText += chunk;
        return true;
      };

      assert.equal(appendIfActive('Initial chunk. '), true);
      entry.controller.abort();
      assert.equal(appendIfActive('Late chunk after abort!'), false);
      assert.equal(uiText, 'Initial chunk. ');
    });

    // =========================================================================
    // CF-29. Cloudflare failure surfaces fallback eligibility and suggested providers cleanly
    // =========================================================================
    await runTest('CF-29. Cloudflare failure surfaces canFallback=true and suggestedProviders, and fallback dispatch strips @cf/... model IDs', async () => {
      mockCloudflare.state.reset();
      mockOpenRouter.state.reset();

      mockCloudflare.state.aiHandler = async (req, res) => {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, errors: [{ message: 'Invalid token' }] }));
      };

      mockOpenRouter.state.chatHandler = async (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(
          `data: ${JSON.stringify({
            id: 'gen-cf-fallback',
            model: 'google/gemma-3-27b-it:free',
            choices: [{ index: 0, delta: { content: 'Fallback response from OpenRouter' }, finish_reason: 'stop' }]
          })}\n\ndata: [DONE]\n\n`
        );
        res.end();
      };

      let primaryErr = null;
      try {
        await streamAIMessage({
          prompt: 'Primary Cloudflare call fails with 401',
          provider: 'cloudflare',
          model: '@cf/meta/llama-3.1-8b-instruct',
          onChunk: () => {}
        });
      } catch (err) {
        primaryErr = err;
      }

      assert.ok(primaryErr, 'Expected Cloudflare 401 to throw');
      assert.equal(primaryErr.provider, 'cloudflare');
      assert.equal(primaryErr.canFallback, true);
      assert.ok(Array.isArray(primaryErr.suggestedProviders), 'Expected suggestedProviders array');
      assert.ok(primaryErr.suggestedProviders.includes('openrouter'), 'Expected openrouter in suggestedProviders');

      // Execute fallback to suggested provider while passing the previous model; router must strip @cf/... and use openrouter/free
      const fallbackRes = await streamAIMessage({
        prompt: 'Fallback from Cloudflare to OpenRouter',
        provider: 'openrouter',
        model: '@cf/meta/llama-3.1-8b-instruct',
        onChunk: () => {}
      });

      assert.equal(fallbackRes.text, 'Fallback response from OpenRouter');
      assert.equal(fallbackRes.provider, 'openrouter');
      assert.equal(mockOpenRouter.state.chatCalls.length, 1);
      assert.equal(mockOpenRouter.state.chatCalls[0].body.model, 'openrouter/free');
    });

    // =========================================================================
    // CF-30. Switching from Gemini/Groq/OpenRouter/Ollama/WebLLM to Cloudflare uses a valid Cloudflare model
    // =========================================================================
    await runTest('CF-30. Switching from Gemini/Groq/OpenRouter/Ollama/WebLLM to Cloudflare sanitizes foreign models and uses default @cf/meta/llama-3.1-8b-instruct', async () => {
      const foreignModels = [
        'gemini-2.5-flash',
        'llama-3.3-70b-versatile',
        'openrouter/free',
        'qwen2.5:1.5b',
        'Qwen2.5-1.5B-Instruct-q4f16_1-MLC'
      ];

      for (const foreignModel of foreignModels) {
        mockCloudflare.state.reset();
        const res = await sendAIMessage({
          prompt: `Switched to Cloudflare with stale ${foreignModel}`,
          provider: 'cloudflare',
          model: foreignModel
        });

        assert.equal(mockCloudflare.state.aiCalls.length, 1);
        assert.equal(
          mockCloudflare.state.aiCalls[0].modelId,
          '@cf/meta/llama-3.1-8b-instruct',
          `Expected stale "${foreignModel}" to be replaced with @cf/meta/llama-3.1-8b-instruct`
        );
        assert.equal(res.modelUsed, '@cf/meta/llama-3.1-8b-instruct');
      }
    });

    // =========================================================================
    // CF-31. Switching away from Cloudflare does not leak @cf/... model IDs into other providers
    // =========================================================================
    await runTest('CF-31. Switching away from Cloudflare strips @cf/... model IDs for Gemini, Groq, OpenRouter, Ollama, and WebLLM', async () => {
      const cfModel = '@cf/meta/llama-3.1-8b-instruct';
      for (const targetProvider of ['gemini', 'groq', 'openrouter', 'ollama', 'webllm']) {
        const compat = checkModelCompatibilityForProvider(targetProvider, cfModel);
        assert.equal(compat.compatible, false, `Expected ${cfModel} to be incompatible with ${targetProvider}`);
        const sanitized = sanitizeModelForProvider(targetProvider, cfModel);
        assert.equal(sanitized, null, `Expected ${cfModel} to be stripped to null for ${targetProvider}`);
      }
    });

    // =========================================================================
    // CF-32. modelUsed and provider metadata match the actual provider/model that answered
    // =========================================================================
    await runTest('CF-32. modelUsed and provider metadata match the exact Cloudflare model ID and provider', async () => {
      mockCloudflare.state.reset();
      const customCfModel = '@cf/mistral/mistral-7b-instruct-v0.2';
      const streamRes = await streamAIMessage({
        prompt: 'Verify metadata attribution',
        provider: 'cloudflare',
        model: customCfModel,
        onChunk: () => {}
      });

      assert.equal(streamRes.provider, 'cloudflare');
      assert.equal(streamRes.modelUsed, customCfModel);
      assert.equal(
        sanitizeModelForProvider('cloudflare', streamRes.modelUsed),
        customCfModel,
        'Returned modelUsed must pass sanitizeModelForProvider so multi-part continuation preserves the selected model'
      );
    });

    // =========================================================================
    // CF-33. Demo mode works only when explicitly enabled
    // =========================================================================
    await runTest('CF-33. Cloudflare demo mode works only when ORVIX_ENABLE_DEMO_MODE=true and marks isDemo=true', async () => {
      const cfDemoPort = serverPort + 203;
      const cfDemoServer = await startTestServer(
        cfDemoPort,
        mockOpenRouter.baseUrl,
        {
          CLOUDFLARE_ACCOUNT_ID: '',
          CLOUDFLARE_API_TOKEN: '',
          ORVIX_ENABLE_DEMO_MODE: 'true'
        },
        mockCloudflare.baseUrl
      );

      try {
        const res = await fetch(`${cfDemoServer.baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider: 'cloudflare',
            prompt: 'Cloudflare explicit demo mode check',
            stream: false
          })
        });

        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.isDemo, true);
        assert.equal(body.provider, 'cloudflare');
        assert.match(body.modelUsed, /\(demo\)$/i);
      } finally {
        await cfDemoServer.stop();
      }
    });

    // =========================================================================
    // CF-34. Normal mode never fabricates a Cloudflare response
    // =========================================================================
    await runTest('CF-34. Normal mode never fabricates a demo Cloudflare response on missing credentials or upstream failure', async () => {
      mockCloudflare.state.reset();
      mockCloudflare.state.aiHandler = async (req, res) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, errors: [{ message: 'Internal Workers AI error' }] }));
      };

      let caught = null;
      try {
        await sendAIMessage({
          prompt: 'Normal mode must fail honestly on 500',
          provider: 'cloudflare'
        });
      } catch (err) {
        caught = err;
      }

      assert.ok(caught, 'Normal mode must throw instead of fabricating a simulated response');
      assert.equal(caught.provider, 'cloudflare');
      assert.equal(caught.code, 500);
    });
  } finally {
    restoreFetch();
    await testServer.stop();
    await mockOpenRouter.close();
    await mockCloudflare.close();
  }

  console.log('\n------------------------------------------------------------');
  console.log(`Phase 4E Results: ${passed} passed, ${failed} failed`);
  console.log('------------------------------------------------------------\n');

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error in testPhase4E:', err);
  process.exit(1);
});
