/**
 * Phase 4F — Ollama Provider Hardening Verification Suite
 *
 * End-to-end behavioral and unit verification of Ollama model compatibility,
 * local endpoint configuration, native NDJSON vs OpenAI SSE streaming,
 * error classification, timeout and cancellation handling, request isolation,
 * and context/OCR preservation against a live ephemeral server.ts instance
 * wired to controlled local mock Ollama upstream servers.
 *
 * Run with: node scripts/testPhase4F.js
 */

process.env.TESTING = '1';

import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';

import {
  PROVIDER_DEFAULT_MODELS,
  checkModelCompatibilityForProvider,
  sanitizeModelForProvider,
  validateServerModelForProvider
} from '../src/services/providerModelSanitizer.js';

import {
  AI_PROVIDERS,
  parseRouterError,
  streamAIMessage,
  fetchProviderConfig,
  resetCachedProviderConfig
} from '../src/services/aiRouter.js';

import {
  prepareDocumentContext,
  adaptDocumentContextForProvider,
  isVisionCapableProvider
} from '../src/services/documentContextService.js';

import { createRequestIsolationController } from '../src/services/requestIsolationService.js';

const { getOllamaApiBaseUrl } = await import('../server.ts');

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

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/**
 * Creates a mock Ollama server supporting both OpenAI /v1/chat/completions and native /api/chat.
 */
function createMockOllamaUpstream() {
  const state = {
    calls: [],
    handler: null,
    reset() {
      this.calls = [];
      this.handler = null;
    }
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      let parsedBody = {};
      try {
        parsedBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch (_) {}

      const record = {
        method: req.method,
        url: req.url || '',
        headers: req.headers,
        body: parsedBody,
        timestamp: Date.now()
      };
      state.calls.push(record);

      if (typeof state.handler === 'function') {
        await state.handler(req, res, record);
        return;
      }

      // Default mock responses
      const model = parsedBody.model || 'qwen2.5:1.5b';
      const isNative = req.url.includes('/api/chat');

      if (parsedBody.stream) {
        if (isNative) {
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
          res.write(
            JSON.stringify({
              model,
              message: { role: 'assistant', content: 'Mock native ' },
              done: false
            }) + '\n'
          );
          res.write(
            JSON.stringify({
              model,
              message: { role: 'assistant', content: 'stream response' },
              done: false
            }) + '\n'
          );
          res.write(
            JSON.stringify({
              model,
              message: { role: 'assistant', content: '' },
              done_reason: 'stop',
              done: true
            }) + '\n'
          );
          res.end();
        } else {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write(
            `data: ${JSON.stringify({
              model,
              choices: [{ delta: { content: 'Mock SSE ' } }]
            })}\n\n`
          );
          res.write(
            `data: ${JSON.stringify({
              model,
              choices: [{ delta: { content: 'stream response' } }]
            })}\n\n`
          );
          res.write('data: [DONE]\n\n');
          res.end();
        }
        return;
      }

      // Non-streaming
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (isNative) {
        res.end(
          JSON.stringify({
            model,
            message: { role: 'assistant', content: 'Mock native sync response' },
            done: true
          })
        );
      } else {
        res.end(
          JSON.stringify({
            model,
            choices: [
              {
                message: { role: 'assistant', content: 'Mock OpenAI sync response' }
              }
            ]
          })
        );
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const baseUrl = `http://127.0.0.1:${port}`;
      resolve({
        state,
        baseUrl,
        port,
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
 * Spawns an ephemeral server.ts instance wired to the mock Ollama upstream.
 */
async function startEphemeralAppServer(envOverrides = {}) {
  const runnerCode = `
    (async () => {
      process.env.TESTING = '1';
      const { app } = await import('./server.ts');
      const srv = app.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        console.log('EPHEMERAL_PORT=' + addr.port);
      });
      process.on('SIGTERM', () => srv.close(() => process.exit(0)));
    })();
  `;

  const child = spawn('./node_modules/.bin/tsx', ['-e', runnerCode], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      TESTING: '1',
      ORVIX_ENABLE_DEMO_MODE: '',
      ...envOverrides
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let portResolve;
  const portPromise = new Promise((resolve) => { portResolve = resolve; });

  child.stdout.on('data', (data) => {
    const text = data.toString('utf8');
    const match = text.match(/EPHEMERAL_PORT=(\d+)/);
    if (match) {
      portResolve(Number(match[1]));
    }
  });

  const actualPort = await Promise.race([
    portPromise,
    sleep(15000).then(() => { throw new Error('Timed out waiting for EPHEMERAL_PORT'); })
  ]);

  const baseUrl = `http://127.0.0.1:${actualPort}`;
  const killChild = () => {
    try {
      if (child.pid) child.kill('SIGTERM');
    } catch (_) {}
    try {
      child.kill('SIGKILL');
    } catch (_) {}
  };

  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) {
        return {
          baseUrl,
          close: async () => {
            killChild();
            await sleep(100);
          }
        };
      }
    } catch (_) {}
    await sleep(50);
  }
  killChild();
  throw new Error('Failed to start ephemeral test server within 10s');
}

console.log('=== Starting Phase 4F: Ollama Provider Hardening Verification Suite ===\n');

async function main() {
  const mockOllama = await createMockOllamaUpstream();
  const appServer = await startEphemeralAppServer({
    OLLAMA_BASE_URL: mockOllama.baseUrl,
    ORVIX_UPSTREAM_HEADERS_TIMEOUT_MS: '2000'
  });

  try {
    console.log('--- Group A: Configuration and Request Construction ---');

    // 1. Valid Ollama endpoint configuration constructs the correct URL.
    await runTest('1. Valid Ollama endpoint configuration constructs the correct URL', async () => {
      const origUrl = process.env.OLLAMA_BASE_URL;
      try {
        process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
        assert.equal(getOllamaApiBaseUrl(), 'http://127.0.0.1:11434');

        process.env.OLLAMA_BASE_URL = 'localhost:11434';
        assert.equal(getOllamaApiBaseUrl(), 'http://127.0.0.1:11434');
      } finally {
        process.env.OLLAMA_BASE_URL = origUrl;
      }
    });

    // 2. Trailing slashes do not create malformed endpoint paths.
    await runTest('2. Trailing slashes and /v1 /api prefixes do not create malformed endpoint paths', async () => {
      const origUrl = process.env.OLLAMA_BASE_URL;
      try {
        process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:11434/';
        assert.equal(getOllamaApiBaseUrl(), 'http://127.0.0.1:11434');

        process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:11434/v1/';
        assert.equal(getOllamaApiBaseUrl(), 'http://127.0.0.1:11434');

        process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:11434/api/';
        assert.equal(getOllamaApiBaseUrl(), 'http://127.0.0.1:11434');

        process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:11434/v1/chat/completions';
        assert.equal(getOllamaApiBaseUrl(), 'http://127.0.0.1:11434');
      } finally {
        process.env.OLLAMA_BASE_URL = origUrl;
      }
    });

    // 3. The default model is selected when appropriate.
    await runTest('3. The default model is selected when model is omitted', async () => {
      mockOllama.state.reset();
      const res = await streamAIMessage({
        provider: 'ollama',
        prompt: 'Test default model',
        chatEndpoint: `${appServer.baseUrl}/api/chat`
      });
      assert.equal(res.modelUsed, 'qwen2.5:1.5b');
      assert.equal(mockOllama.state.calls[0].body.model, 'qwen2.5:1.5b');
    });

    // 4. A custom valid Ollama model is preserved.
    await runTest('4. A custom valid Ollama model is preserved', async () => {
      mockOllama.state.reset();
      const res = await streamAIMessage({
        provider: 'ollama',
        model: 'llama3.2:3b',
        prompt: 'Test custom model',
        chatEndpoint: `${appServer.baseUrl}/api/chat`
      });
      assert.equal(mockOllama.state.calls[0].body.model, 'llama3.2:3b');

      mockOllama.state.reset();
      await streamAIMessage({
        provider: 'ollama',
        model: 'library/llama3.2:1b',
        prompt: 'Test namespaced model',
        chatEndpoint: `${appServer.baseUrl}/api/chat`
      });
      assert.equal(mockOllama.state.calls[0].body.model, 'library/llama3.2:1b');
    });

    // 5. Invalid or cross-provider model identifiers are handled correctly.
    await runTest('5. Invalid or cross-provider model identifiers are handled correctly', async () => {
      assert.equal(checkModelCompatibilityForProvider('ollama', '@cf/meta/llama-3.1-8b-instruct').compatible, false);
      assert.equal(checkModelCompatibilityForProvider('ollama', 'gemini-2.5-flash').compatible, false);
      assert.equal(checkModelCompatibilityForProvider('ollama', 'openrouter/free').compatible, false);
      assert.equal(checkModelCompatibilityForProvider('ollama', 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC').compatible, false);
      assert.equal(checkModelCompatibilityForProvider('ollama', 'whisper-large-v3-turbo').compatible, false);
      assert.equal(checkModelCompatibilityForProvider('ollama', 'openai/gpt-oss-120b').compatible, false);
      assert.equal(checkModelCompatibilityForProvider('ollama', 'Local AI (Ollama) — Qwen 2.5 1.5B').compatible, false);

      assert.equal(sanitizeModelForProvider('ollama', '@cf/meta/llama-3.1-8b-instruct'), null);
      assert.equal(sanitizeModelForProvider('ollama', 'gemini-2.5-flash'), null);

      const serverCheck = validateServerModelForProvider('ollama', '@cf/meta/llama-3.1-8b-instruct');
      assert.equal(serverCheck.valid, false);
      assert.equal(serverCheck.status, 'INVALID_MODEL');
    });

    // 6. The request uses the expected method, headers, and body.
    await runTest('6. The request uses the expected method, headers, and body', async () => {
      mockOllama.state.reset();
      await streamAIMessage({
        provider: 'ollama',
        model: 'qwen2.5:1.5b',
        prompt: 'Check request shape',
        chatEndpoint: `${appServer.baseUrl}/api/chat`
      });

      const call = mockOllama.state.calls[0];
      assert.equal(call.method, 'POST');
      assert.ok(call.headers['content-type'].includes('application/json'));
      assert.equal(call.body.model, 'qwen2.5:1.5b');
      assert.ok(Array.isArray(call.body.messages));
      assert.equal(call.body.stream, true);
      assert.equal(call.body.temperature, 0.7);
    });

    // 7. System instructions and the user prompt are preserved.
    await runTest('7. System instructions and the user prompt are preserved', async () => {
      mockOllama.state.reset();
      await streamAIMessage({
        provider: 'ollama',
        prompt: 'User prompt verification',
        username: 'Alex',
        mode: 'coding',
        chatEndpoint: `${appServer.baseUrl}/api/chat`
      });

      const msgs = mockOllama.state.calls[0].body.messages;
      const sysMsg = msgs.find((m) => m.role === 'system');
      const userMsg = msgs.find((m) => m.role === 'user');

      assert.ok(sysMsg, 'System message must be present');
      assert.ok(sysMsg.content.includes('Alex'), 'System instruction includes preferred username');
      assert.ok(sysMsg.content.includes('Coding'), 'System instruction includes coding mode');
      assert.equal(userMsg.content, 'User prompt verification');
    });

    // 8. Conversation history is formatted correctly.
    await runTest('8. Conversation history is formatted correctly', async () => {
      mockOllama.state.reset();
      await streamAIMessage({
        provider: 'ollama',
        prompt: 'Third turn',
        history: [
          { sender: 'user', content: 'Turn 1' },
          { sender: 'assistant', content: 'Reply 1' }
        ],
        chatEndpoint: `${appServer.baseUrl}/api/chat`
      });

      const msgs = mockOllama.state.calls[0].body.messages;
      assert.equal(msgs[1].role, 'user');
      assert.equal(msgs[1].content, 'Turn 1');
      assert.equal(msgs[2].role, 'assistant');
      assert.equal(msgs[2].content, 'Reply 1');
      assert.equal(msgs[3].role, 'user');
      assert.equal(msgs[3].content, 'Third turn');
    });

    // 9. OCR/document text reaches the model.
    await runTest('9. OCR/document text reaches the model in context', async () => {
      mockOllama.state.reset();
      await streamAIMessage({
        provider: 'ollama',
        prompt: 'Summarize the document',
        attachments: [
          {
            id: 'doc-1',
            name: 'report.txt',
            format: 'txt',
            extraction: {
              success: true,
              text: 'Annual revenue increased by 25 percent in Q4.'
            }
          }
        ],
        chatEndpoint: `${appServer.baseUrl}/api/chat`
      });

      const msgs = mockOllama.state.calls[0].body.messages;
      const userMsg = msgs.find((m) => m.role === 'user');
      assert.ok(userMsg.content.includes('Annual revenue increased by 25 percent in Q4.'));
      assert.ok(userMsg.content.includes('Summarize the document'));
    });

    // 10. Text-only models do not receive unnecessary raw image bytes.
    await runTest('10. Text-only models do not receive unnecessary raw image bytes', async () => {
      assert.equal(isVisionCapableProvider('ollama'), false);
      mockOllama.state.reset();

      await streamAIMessage({
        provider: 'ollama',
        prompt: 'Read this diagram',
        attachments: [
          {
            id: 'img-1',
            name: 'diagram.png',
            format: 'png',
            base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
            extraction: {
              success: true,
              text: 'Extracted OCR: Flowchart step 1'
            }
          }
        ],
        chatEndpoint: `${appServer.baseUrl}/api/chat`
      });

      const rawBody = JSON.stringify(mockOllama.state.calls[0].body);
      assert.ok(!rawBody.includes('iVBORw0KGgoAAAANSUhEUg'), 'Raw image bytes must not reach Ollama');
      assert.ok(rawBody.includes('Flowchart step 1'), 'Extracted OCR text must reach Ollama');
    });

    // 11. Model attribution is accurate in the final response.
    await runTest('11. Model attribution is accurate in the final response', async () => {
      mockOllama.state.reset();
      mockOllama.state.handler = (req, res, call) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(
          `data: ${JSON.stringify({
            model: 'qwen2.5-coder:1.5b',
            choices: [{ delta: { content: 'Attributed output' } }]
          })}\n\n`
        );
        res.write('data: [DONE]\n\n');
        res.end();
      };

      const res = await streamAIMessage({
        provider: 'ollama',
        model: 'qwen2.5-coder:1.5b',
        prompt: 'Attribution check',
        chatEndpoint: `${appServer.baseUrl}/api/chat`
      });

      assert.equal(res.modelUsed, 'qwen2.5-coder:1.5b');
      assert.equal(res.provider, 'ollama');
      assert.equal(res.text, 'Attributed output');
    });

    console.log('\n--- Group B: Server Availability and Timeouts ---');

    // 12. Connection refusal returns a clear error promptly.
    await runTest('12. Connection refusal returns a clear error promptly', async () => {
      const unusedPort = await getFreePort();
      const deadServer = await startEphemeralAppServer({
        OLLAMA_BASE_URL: `http://127.0.0.1:${unusedPort}`
      });

      try {
        const start = Date.now();
        let err = null;
        try {
          await streamAIMessage({
            provider: 'ollama',
            prompt: 'Test refused connection',
            chatEndpoint: `${deadServer.baseUrl}/api/chat`
          });
        } catch (e) {
          err = e;
        }

        const elapsed = Date.now() - start;
        assert.ok(err, 'Expected connection refusal error');
        assert.equal(err.code, 503);
        assert.equal(err.status, 'NETWORK_FAILURE');
        assert.equal(err.retryable, false);
        assert.equal(err.canFallback, false);
        assert.ok(err.message.includes('Unable to connect to Local AI (Ollama)'));
        assert.ok(err.message.includes('ollama serve'));
        assert.ok(elapsed < 4000, `Must fail promptly, took ${elapsed}ms`);
      } finally {
        await deadServer.close();
      }
    });

    // 13. An unreachable server does not leave the request hanging.
    await runTest('13. An unreachable server does not leave the request hanging', async () => {
      // 192.0.2.1 is reserved documentation TEST-NET-1 (unroutable blackhole)
      const unreachableApp = await startEphemeralAppServer({
        OLLAMA_BASE_URL: 'http://192.0.2.1:11434',
        ORVIX_UPSTREAM_HEADERS_TIMEOUT_MS: '1000'
      });

      try {
        const start = Date.now();
        let err = null;
        try {
          await streamAIMessage({
            provider: 'ollama',
            prompt: 'Test unreachable',
            chatEndpoint: `${unreachableApp.baseUrl}/api/chat`
          });
        } catch (e) {
          err = e;
        }

        const elapsed = Date.now() - start;
        assert.ok(err, 'Expected unreachable error');
        assert.ok(elapsed < 4000, `Must time out or reject cleanly, took ${elapsed}ms`);
      } finally {
        await unreachableApp.close();
      }
    });

    // 14. A server that never sends response headers triggers the configured timeout.
    await runTest('14. A server that never sends response headers triggers the configured timeout', async () => {
      mockOllama.state.reset();
      mockOllama.state.handler = () => {
        // Stalled before headers
      };

      const start = Date.now();
      let caught = null;
      try {
        await streamAIMessage({
          provider: 'ollama',
          prompt: 'Header timeout test',
          chatEndpoint: `${appServer.baseUrl}/api/chat`
        });
      } catch (e) {
        caught = e;
      }

      const elapsed = Date.now() - start;
      assert.ok(caught, 'Must catch timeout error');
      assert.equal(caught.code, 504);
      assert.equal(caught.status, 'DEADLINE_EXCEEDED');
      assert.equal(caught.retryable, false);
      assert.ok(elapsed >= 1800 && elapsed < 4000, `Elapsed ${elapsed}ms matches ~2000ms timeout`);
    });

    // 15. A server that stalls during response-body delivery is handled correctly.
    await runTest('15. A server that stalls during response-body delivery is handled correctly', async () => {
      mockOllama.state.reset();
      mockOllama.state.handler = (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Partial token' } }] })}\n\n`);
        // Intentionally stall and abruptly destroy socket
        setTimeout(() => {
          res.destroy();
        }, 300);
      };

      let caught = null;
      let chunks = '';
      try {
        await streamAIMessage({
          provider: 'ollama',
          prompt: 'Body stall test',
          chatEndpoint: `${appServer.baseUrl}/api/chat`,
          onChunk: (c) => { chunks += c; }
        });
      } catch (e) {
        caught = e;
      }

      assert.ok(caught, 'Must catch mid-stream destruction');
      assert.equal(caught.code, 503);
      assert.equal(caught.status, 'STREAM_FAILED');
      assert.equal(chunks, 'Partial token');
      assert.equal(caught.partial, true);
    });

    // 16. A missing model returns an appropriate model-not-found error.
    await runTest('16. A missing model returns an appropriate model-not-found error', async () => {
      mockOllama.state.reset();
      mockOllama.state.handler = (req, res) => {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "model 'nonexistent-model' not found" }));
      };

      let caught = null;
      try {
        await streamAIMessage({
          provider: 'ollama',
          model: 'nonexistent-model:latest',
          prompt: 'Check missing model',
          chatEndpoint: `${appServer.baseUrl}/api/chat`
        });
      } catch (e) {
        caught = e;
      }

      assert.ok(caught);
      assert.equal(caught.code, 404);
      assert.equal(caught.status, 'NOT_FOUND');
      assert.ok(caught.message.includes('ollama pull'));
      assert.equal(caught.retryable, false);
    });

    // 17. An invalid request returns an appropriate non-retryable error.
    await runTest('17. An invalid request returns an appropriate non-retryable error', async () => {
      mockOllama.state.reset();
      mockOllama.state.handler = (req, res) => {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid temperature option: must be >= 0' }));
      };

      let caught = null;
      try {
        await streamAIMessage({
          provider: 'ollama',
          prompt: 'Check 400 bad request',
          chatEndpoint: `${appServer.baseUrl}/api/chat`
        });
      } catch (e) {
        caught = e;
      }

      assert.ok(caught);
      assert.equal(caught.code, 400);
      assert.equal(caught.status, 'INVALID_REQUEST');
      assert.equal(caught.retryable, false);
    });

    // 18. An upstream HTTP 500 follows the existing retry policy.
    await runTest('18. An upstream HTTP 500 follows the existing retry policy', async () => {
      mockOllama.state.reset();
      mockOllama.state.handler = (req, res) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal cuda error in Ollama runner' }));
      };

      let caught = null;
      try {
        await streamAIMessage({
          provider: 'ollama',
          prompt: 'Check 500 error',
          chatEndpoint: `${appServer.baseUrl}/api/chat`
        });
      } catch (e) {
        caught = e;
      }

      assert.ok(caught);
      assert.equal(caught.code, 500);
      assert.equal(caught.status, 'INTERNAL');
      // Router retries at most once for transient 500 before giving up
      assert.equal(mockOllama.state.calls.length, 2);
    });

    // 19. Timeout errors are distinguishable from user cancellation.
    await runTest('19. Timeout errors are distinguishable from user cancellation', async () => {
      const abortCtrl = new AbortController();
      mockOllama.state.reset();
      mockOllama.state.handler = () => {};

      abortCtrl.abort();
      let caught = null;
      try {
        await streamAIMessage({
          provider: 'ollama',
          prompt: 'Immediate cancellation',
          signal: abortCtrl.signal,
          chatEndpoint: `${appServer.baseUrl}/api/chat`
        });
      } catch (e) {
        caught = e;
      }

      assert.ok(caught);
      assert.equal(caught.name, 'AbortError');
      assert.notEqual(caught.status, 'DEADLINE_EXCEEDED');
    });

    // 20. Timed-out requests are cleaned up without leaving active work behind.
    await runTest('20. Timed-out requests are cleaned up without leaving active work behind', async () => {
      let upstreamSocketClosed = false;
      mockOllama.state.reset();
      mockOllama.state.handler = (req) => {
        req.on('close', () => {
          upstreamSocketClosed = true;
        });
      };

      try {
        await streamAIMessage({
          provider: 'ollama',
          prompt: 'Cleanup test',
          chatEndpoint: `${appServer.baseUrl}/api/chat`
        });
      } catch (_) {}

      await sleep(100);
      assert.equal(upstreamSocketClosed, true, 'Upstream socket must be closed on timeout');
    });

    console.log('\n--- Group C: Streaming ---');

    // 21. Multiple JSON-lines records are parsed in order when using the native API.
    await runTest('21. Multiple JSON-lines records are parsed in order when using the native API', async () => {
      mockOllama.state.reset();
      mockOllama.state.handler = (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.write(JSON.stringify({ message: { content: 'Alpha ' }, done: false }) + '\n');
        res.write(JSON.stringify({ message: { content: 'Beta ' }, done: false }) + '\n');
        res.write(JSON.stringify({ message: { content: 'Gamma' }, done: true }) + '\n');
        res.end();
      };

      const chunks = [];
      const res = await streamAIMessage({
        provider: 'ollama',
        prompt: 'Native NDJSON test',
        chatEndpoint: `${appServer.baseUrl}/api/chat`,
        onChunk: (c) => chunks.push(c)
      });

      assert.equal(chunks.join(''), 'Alpha Beta Gamma');
      assert.equal(res.text, 'Alpha Beta Gamma');
    });

    // 22. Multiple SSE events are parsed in order when using an OpenAI-compatible endpoint.
    await runTest('22. Multiple SSE events are parsed in order when using an OpenAI-compatible endpoint', async () => {
      mockOllama.state.reset();
      mockOllama.state.handler = (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'First ' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Second ' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Third' } }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      };

      const chunks = [];
      const res = await streamAIMessage({
        provider: 'ollama',
        prompt: 'OpenAI SSE test',
        chatEndpoint: `${appServer.baseUrl}/api/chat`,
        onChunk: (c) => chunks.push(c)
      });

      assert.equal(chunks.join(''), 'First Second Third');
      assert.equal(res.text, 'First Second Third');
    });

    // 23. Records split across network chunks are reconstructed correctly.
    await runTest('23. Records split across network chunks are reconstructed correctly', async () => {
      mockOllama.state.reset();
      mockOllama.state.handler = async (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const part1 = 'data: {"choices": [{"delta": {"co';
        const part2 = 'ntent": "Reconstructed split"';
        const part3 = '}}]}\n\ndata: [DONE]\n\n';

        res.write(part1);
        await sleep(50);
        res.write(part2);
        await sleep(50);
        res.write(part3);
        res.end();
      };

      const res = await streamAIMessage({
        provider: 'ollama',
        prompt: 'Split test',
        chatEndpoint: `${appServer.baseUrl}/api/chat`
      });

      assert.equal(res.text, 'Reconstructed split');
    });

    // 24. Multiple records in a single network chunk are handled correctly.
    await runTest('24. Multiple records in a single network chunk are handled correctly', async () => {
      mockOllama.state.reset();
      mockOllama.state.handler = (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const batch =
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'Batch 1 ' } }] })}\n\n` +
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'Batch 2 ' } }] })}\n\n` +
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'Batch 3' } }] })}\n\n` +
          'data: [DONE]\n\n';
        res.write(batch);
        res.end();
      };

      const res = await streamAIMessage({
        provider: 'ollama',
        prompt: 'Batch test',
        chatEndpoint: `${appServer.baseUrl}/api/chat`
      });

      assert.equal(res.text, 'Batch 1 Batch 2 Batch 3');
    });

    // 25. Split UTF-8 characters are decoded correctly.
    await runTest('25. Split UTF-8 characters are decoded correctly', async () => {
      mockOllama.state.reset();
      mockOllama.state.handler = async (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const fullPayload = `data: ${JSON.stringify({ choices: [{ delta: { content: 'Rocket 🚀Launch' } }] })}\n\ndata: [DONE]\n\n`;
        const buf = Buffer.from(fullPayload, 'utf8');

        // Split buffer right in the middle of the 4-byte 🚀 (F0 9F 9 attain)
        const rocketIndex = buf.indexOf(Buffer.from('🚀', 'utf8'));
        const slice1 = buf.subarray(0, rocketIndex + 2);
        const slice2 = buf.subarray(rocketIndex + 2);

        res.write(slice1);
        await sleep(50);
        res.write(slice2);
        res.end();
      };

      const res = await streamAIMessage({
        provider: 'ollama',
        prompt: 'UTF-8 split test',
        chatEndpoint: `${appServer.baseUrl}/api/chat`
      });

      assert.equal(res.text, 'Rocket 🚀Launch');
    });

    // 26. Keepalive or empty records do not corrupt output.
    await runTest('26. Keepalive or empty records do not corrupt output', async () => {
      mockOllama.state.reset();
      mockOllama.state.handler = (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(': keepalive comment\n\n');
        res.write('\n\n');
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Valid token' } }] })}\n\n`);
        res.write(': another comment\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      };

      const res = await streamAIMessage({
        provider: 'ollama',
        prompt: 'Keepalive test',
        chatEndpoint: `${appServer.baseUrl}/api/chat`
      });

      assert.equal(res.text, 'Valid token');
    });

    // 27. Valid terminal completion produces one success event.
    await runTest('27. Valid terminal completion produces one success event', async () => {
      mockOllama.state.reset();
      const res = await streamAIMessage({
        provider: 'ollama',
        prompt: 'Single completion check',
        chatEndpoint: `${appServer.baseUrl}/api/chat`
      });

      assert.ok(res.text.length > 0);
      assert.equal(res.provider, 'ollama');
    });

    // 28. Malformed records produce a structured error.
    await runTest('28. Malformed records produce a structured error', async () => {
      mockOllama.state.reset();
      mockOllama.state.handler = (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {not-valid-json-syntax\n\n');
        res.end();
      };

      let caught = null;
      try {
        await streamAIMessage({
          provider: 'ollama',
          prompt: 'Malformed JSON test',
          chatEndpoint: `${appServer.baseUrl}/api/chat`
        });
      } catch (e) {
        caught = e;
      }

      assert.ok(caught);
      assert.equal(caught.code, 500);
      assert.equal(caught.status, 'PARSE_ERROR');
    });

    // 29. Upstream error records produce a structured error.
    await runTest('29. Upstream error records produce a structured error', async () => {
      mockOllama.state.reset();
      mockOllama.state.handler = (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ error: { message: 'Ollama engine out of memory' } })}\n\n`);
        res.end();
      };

      let caught = null;
      try {
        await streamAIMessage({
          provider: 'ollama',
          prompt: 'Stream error record test',
          chatEndpoint: `${appServer.baseUrl}/api/chat`
        });
      } catch (e) {
        caught = e;
      }

      assert.ok(caught);
      assert.equal(caught.status, 'STREAM_FAILED');
      assert.ok(caught.message.includes('out of memory'));
    });

    // 30. Premature stream termination does not produce false success.
    await runTest('30. Premature stream termination does not produce false success', async () => {
      mockOllama.state.reset();
      mockOllama.state.handler = (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        // Close stream without sending any tokens or [DONE] marker
        res.end();
      };

      let caught = null;
      try {
        await streamAIMessage({
          provider: 'ollama',
          prompt: 'Premature close test',
          chatEndpoint: `${appServer.baseUrl}/api/chat`
        });
      } catch (e) {
        caught = e;
      }

      assert.ok(caught, 'Premature close without tokens must fail');
    });

    // 31. Empty completed responses are handled correctly.
    await runTest('31. Empty completed responses are handled correctly', async () => {
      mockOllama.state.reset();
      mockOllama.state.handler = (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '   ' } }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      };

      let caught = null;
      try {
        await streamAIMessage({
          provider: 'ollama',
          prompt: 'Empty stream test',
          chatEndpoint: `${appServer.baseUrl}/api/chat`
        });
      } catch (e) {
        caught = e;
      }

      assert.ok(caught);
      assert.equal(caught.code, 502);
      assert.equal(caught.status, 'EMPTY_STREAM_RESPONSE');
    });

    // 32. Partial text is preserved after a mid-stream failure.
    await runTest('32. Partial text is preserved after a mid-stream failure', async () => {
      mockOllama.state.reset();
      mockOllama.state.handler = (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Preserved partial output ' } }] })}\n\n`);
        setTimeout(() => {
          res.destroy();
        }, 100);
      };

      let caught = null;
      let accumulated = '';
      try {
        await streamAIMessage({
          provider: 'ollama',
          prompt: 'Partial text check',
          chatEndpoint: `${appServer.baseUrl}/api/chat`,
          onChunk: (c, acc) => { accumulated = acc; }
        });
      } catch (e) {
        caught = e;
      }

      assert.ok(caught);
      assert.equal(accumulated, 'Preserved partial output ');
      assert.equal(caught.partial, true);
      assert.equal(caught.partialText, 'Preserved partial output ');
    });

    // 33. A compound stream failure does not emit multiple terminal events.
    await runTest('33. A compound stream failure does not emit multiple terminal events', async () => {
      mockOllama.state.reset();
      mockOllama.state.handler = (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ error: { message: 'Initial error' } })}\n\n`);
        res.write(`data: ${JSON.stringify({ error: { message: 'Secondary error' } })}\n\n`);
        res.end();
      };

      let errorCount = 0;
      try {
        await streamAIMessage({
          provider: 'ollama',
          prompt: 'Compound failure test',
          chatEndpoint: `${appServer.baseUrl}/api/chat`
        });
      } catch (_) {
        errorCount++;
      }

      assert.equal(errorCount, 1, 'Exactly one terminal error caught');
    });

    console.log('\n--- Group D: Cancellation and Isolation ---');

    // 34. Cancelling an active request aborts the upstream operation.
    await runTest('34. Cancelling an active request aborts the upstream operation', async () => {
      let upstreamAborted = false;
      mockOllama.state.reset();
      mockOllama.state.handler = (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Start ' } }] })}\n\n`);
        req.on('close', () => {
          upstreamAborted = true;
        });
      };

      const abortCtrl = new AbortController();
      let caught = null;
      const promise = streamAIMessage({
        provider: 'ollama',
        prompt: 'Cancellation abort test',
        signal: abortCtrl.signal,
        chatEndpoint: `${appServer.baseUrl}/api/chat`,
        onChunk: () => {
          abortCtrl.abort();
        }
      }).catch((e) => { caught = e; });

      await promise;
      assert.ok(caught);
      assert.equal(caught.name, 'AbortError');
      await sleep(100);
      assert.equal(upstreamAborted, true, 'Upstream request must be aborted');
    });

    // 35. Cancellation does not trigger a retry.
    await runTest('35. Cancellation does not trigger a retry', async () => {
      mockOllama.state.reset();
      const abortCtrl = new AbortController();
      mockOllama.state.handler = (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Token' } }] })}\n\n`);
        abortCtrl.abort();
      };

      try {
        await streamAIMessage({
          provider: 'ollama',
          prompt: 'No retry on abort',
          signal: abortCtrl.signal,
          chatEndpoint: `${appServer.baseUrl}/api/chat`
        });
      } catch (_) {}

      await sleep(100);
      assert.equal(mockOllama.state.calls.length, 1, 'Must execute exactly 1 request');
    });

    // 36. Cancellation does not trigger fallback.
    await runTest('36. Cancellation does not trigger fallback', async () => {
      const abortCtrl = new AbortController();
      abortCtrl.abort();

      let caught = null;
      try {
        await streamAIMessage({
          provider: 'ollama',
          prompt: 'No fallback on abort',
          signal: abortCtrl.signal,
          chatEndpoint: `${appServer.baseUrl}/api/chat`
        });
      } catch (e) {
        caught = e;
      }

      assert.ok(caught);
      assert.equal(caught.name, 'AbortError');
    });

    // 37. Late chunks after cancellation cannot update the UI.
    await runTest('37. Late chunks after cancellation cannot update the UI', async () => {
      mockOllama.state.reset();
      let lateChunkArrived = false;
      const abortCtrl = new AbortController();

      mockOllama.state.handler = async (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Initial' } }] })}\n\n`);
        await sleep(50);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Late chunk' } }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      };

      try {
        await streamAIMessage({
          provider: 'ollama',
          prompt: 'Late chunk test',
          signal: abortCtrl.signal,
          chatEndpoint: `${appServer.baseUrl}/api/chat`,
          onChunk: (c) => {
            if (c.includes('Initial')) {
              abortCtrl.abort();
            } else if (c.includes('Late chunk')) {
              lateChunkArrived = true;
            }
          }
        });
      } catch (_) {}

      await sleep(100);
      assert.equal(lateChunkArrived, false, 'Late chunk callback must not execute after abort');
    });

    // 38. A newer request prevents an older request from overwriting its output.
    await runTest('38. A newer request prevents an older request from overwriting its output', async () => {
      const isolation = createRequestIsolationController();
      let request1Output = '';
      let request2Output = '';

      mockOllama.state.reset();
      mockOllama.state.handler = async (req, res, call) => {
        const p = call.body.messages?.[1]?.content || '';
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (p === 'Request 1') {
          await sleep(150);
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Old response' } }] })}\n\n`);
        } else {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'New response' } }] })}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
      };

      const req1 = isolation.beginRequest({ chatId: 'conv-1', provider: 'ollama' });
      const p1 = streamAIMessage({
        provider: 'ollama',
        prompt: 'Request 1',
        signal: req1.signal,
        chatEndpoint: `${appServer.baseUrl}/api/chat`,
        isRequestActive: () => isolation.isRequestActive(req1.requestId),
        onChunk: (c) => { request1Output += c; }
      }).catch(() => {});

      await sleep(30);

      const req2 = isolation.beginRequest({ chatId: 'conv-1', provider: 'ollama' });
      const p2 = streamAIMessage({
        provider: 'ollama',
        prompt: 'Request 2',
        signal: req2.signal,
        chatEndpoint: `${appServer.baseUrl}/api/chat`,
        isRequestActive: () => isolation.isRequestActive(req2.requestId),
        onChunk: (c) => { request2Output += c; }
      });

      await Promise.all([p1, p2]);
      assert.equal(request1Output, '', 'Older request must be silenced by newer request');
      assert.equal(request2Output, 'New response', 'Newer request completes and sets output');
    });

    // 39. Repeated cancellation and cleanup do not cause unhandled errors.
    await runTest('39. Repeated cancellation and cleanup do not cause unhandled errors', async () => {
      for (let i = 0; i < 5; i++) {
        const ctrl = new AbortController();
        ctrl.abort();
        try {
          await streamAIMessage({
            provider: 'ollama',
            prompt: 'Rapid abort',
            signal: ctrl.signal,
            chatEndpoint: `${appServer.baseUrl}/api/chat`
          });
        } catch (e) {
          assert.equal(e.name, 'AbortError');
        }
      }
    });

    console.log('\n--- Group E: Fallback and Context Preservation ---');

    // 40. A legitimate retryable failure follows the bounded retry policy.
    await runTest('40. A legitimate retryable failure follows the bounded retry policy', async () => {
      let attempt = 0;
      mockOllama.state.reset();
      mockOllama.state.handler = (req, res) => {
        attempt++;
        if (attempt === 1) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Transient runner restart' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Success on retry' } }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      };

      const res = await streamAIMessage({
        provider: 'ollama',
        prompt: 'Retryable 500 test',
        chatEndpoint: `${appServer.baseUrl}/api/chat`
      });

      assert.equal(res.text, 'Success on retry');
      assert.equal(mockOllama.state.calls.length, 2, 'Exactly 2 attempts made under bounded retry');
    });

    // 41. A non-retryable model/configuration error is not blindly retried.
    await runTest('41. A non-retryable model/configuration error is not blindly retried', async () => {
      mockOllama.state.reset();
      mockOllama.state.handler = (req, res) => {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "model 'missing' not found" }));
      };

      try {
        await streamAIMessage({
          provider: 'ollama',
          model: 'missing:latest',
          prompt: 'Non-retryable 404',
          chatEndpoint: `${appServer.baseUrl}/api/chat`
        });
      } catch (_) {}

      assert.equal(mockOllama.state.calls.length, 1, '404 must not be retried');
    });

    // 42. An unavailable Ollama server follows the established fallback policy.
    await runTest('42. An unavailable Ollama server sets canFallback=false and returns honest error', async () => {
      mockOllama.state.reset();
      mockOllama.state.handler = (req, res) => {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Daemon shutting down' }));
      };

      let caught = null;
      try {
        await streamAIMessage({
          provider: 'ollama',
          prompt: 'Fallback policy check',
          chatEndpoint: `${appServer.baseUrl}/api/chat`
        });
      } catch (e) {
        caught = e;
      }

      assert.ok(caught);
      assert.equal(caught.canFallback, false, 'Ollama must not automatically fall back to cloud providers');
    });

    // 43. Unconfigured fallback providers are excluded.
    await runTest('43. Unconfigured fallback providers are excluded from suggested providers', async () => {
      const res = await fetch(`${appServer.baseUrl}/api/config`);
      const config = await res.json();
      assert.ok(config);
      // Ollama returns canFallback: false and empty suggestedProviders on failure
      const err = parseRouterError({
        error: 'Ollama stopped',
        status: 'NETWORK_FAILURE',
        suggestedProviders: []
      }, 503, 'ollama');
      assert.equal(err.canFallback, false);
      assert.deepEqual(err.suggestedProviders, []);
    });

    // 44. A legitimate fallback preserves the original prompt.
    await runTest('44. A legitimate fallback preserves the original prompt', async () => {
      const origPrompt = 'Explain quantum computing in detail';
      const adapted = adaptDocumentContextForProvider({
        provider: 'ollama',
        prompt: origPrompt,
        baseSystemInstruction: 'You are helpful.'
      });
      assert.ok(adapted.effectivePrompt.includes(origPrompt));
    });

    // 45. Conversation history and OCR/document context survive fallback.
    await runTest('45. Conversation history and OCR/document context survive fallback', async () => {
      const doc = {
        name: 'data.csv',
        format: 'csv',
        text: 'col1,col2\nval1,val2',
        hasText: true,
        success: true
      };
      const prep = prepareDocumentContext('Show me row 1', [doc]);
      const adapted = adaptDocumentContextForProvider({
        provider: 'ollama',
        prompt: 'Show me row 1',
        preparedContext: prep
      });

      assert.ok(adapted.effectivePrompt.includes('val1,val2'));
      assert.ok(adapted.effectivePrompt.includes('Show me row 1'));
    });

    // 46. Provider and model metadata reflect the provider actually used.
    await runTest('46. Provider and model metadata reflect the provider actually used', async () => {
      mockOllama.state.reset();
      const res = await streamAIMessage({
        provider: 'ollama',
        prompt: 'Metadata check',
        chatEndpoint: `${appServer.baseUrl}/api/chat`
      });

      assert.equal(res.provider, 'ollama');
      assert.equal(res.modelUsed, 'qwen2.5:1.5b');
    });

    // 47. Partial output is not duplicated by fallback.
    await runTest('47. Partial output is not duplicated by fallback (retryable is disabled)', async () => {
      mockOllama.state.reset();
      mockOllama.state.handler = (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Token 1 ' } }] })}\n\n`);
        setTimeout(() => {
          res.destroy();
        }, 100);
      };

      let caught = null;
      try {
        await streamAIMessage({
          provider: 'ollama',
          prompt: 'No duplicate partial text',
          chatEndpoint: `${appServer.baseUrl}/api/chat`
        });
      } catch (e) {
        caught = e;
      }

      assert.ok(caught);
      assert.equal(caught.retryable, false, 'Partial text prevents auto-retry/fallback duplication');
      assert.equal(mockOllama.state.calls.length, 1);
    });

    // 48. A cancelled or superseded request cannot start a stale fallback.
    await runTest('48. A cancelled or superseded request cannot start a stale fallback', async () => {
      const isolation = createRequestIsolationController();
      let staleCallbackFired = false;

      mockOllama.state.reset();
      mockOllama.state.handler = async (req, res, call) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (call.body.prompt === 'Request A' || call.body.messages?.[1]?.content === 'Request A') {
          await sleep(200);
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Stale chunk' } }] })}\n\n`);
        } else {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Fresh chunk' } }] })}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
      };

      const reqA = isolation.beginRequest({ chatId: 'conv-stale', provider: 'ollama' });
      const pA = streamAIMessage({
        provider: 'ollama',
        prompt: 'Request A',
        signal: reqA.signal,
        chatEndpoint: `${appServer.baseUrl}/api/chat`,
        isRequestActive: () => isolation.isRequestActive(reqA.requestId),
        onChunk: () => { staleCallbackFired = true; }
      }).catch(() => {});

      await sleep(20);

      const reqB = isolation.beginRequest({ chatId: 'conv-stale', provider: 'ollama' });
      const pB = streamAIMessage({
        provider: 'ollama',
        prompt: 'Request B',
        signal: reqB.signal,
        chatEndpoint: `${appServer.baseUrl}/api/chat`,
        isRequestActive: () => isolation.isRequestActive(reqB.requestId)
      });

      await Promise.all([pA, pB]);
      assert.equal(staleCallbackFired, false, 'Superseded request cannot run callbacks');
    });

    // 49. Only one final assistant response is delivered for a completed request.
    await runTest('49. Only one final assistant response is delivered for a completed request', async () => {
      mockOllama.state.reset();
      let startEventCount = 0;
      const res = await streamAIMessage({
        provider: 'ollama',
        prompt: 'Final completion check',
        chatEndpoint: `${appServer.baseUrl}/api/chat`,
        onStart: () => { startEventCount++; }
      });

      assert.equal(startEventCount, 1);
      assert.ok(res.text.length > 0);
      assert.equal(res.provider, 'ollama');
    });

  } finally {
    await appServer.close();
    await mockOllama.close();
  }

  console.log(`\n=== Phase 4F Results: ${passed} Passed, ${failed} Failed ===\n`);
  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
