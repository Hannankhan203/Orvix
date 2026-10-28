/**
 * Phase 4D — Groq Provider Hardening Verification Suite
 *
 * End-to-end behavioral and unit verification of Groq model compatibility,
 * chat vs. audio-transcription task separation, SSE mid-stream error handling,
 * malformed error frame resilience, bounded retry & fallback semantics,
 * client cancellation, and provider isolation against a live ephemeral server.ts
 * instance wired to a controlled local mock Groq upstream server.
 *
 * Run with: node scripts/testPhase4D.js
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';

import {
  PROVIDER_DEFAULT_MODELS,
  GROQ_CHAT_MODELS,
  GROQ_FALLBACK_CHAT_MODELS,
  GROQ_TRANSCRIPTION_MODELS,
  DEFAULT_GROQ_TRANSCRIPTION_MODEL,
  RETIRED_GROQ_MODELS,
  checkModelCompatibilityForProvider,
  sanitizeModelForProvider,
  validateServerModelForProvider,
  validateGroqTranscriptionModel
} from '../src/services/providerModelSanitizer.js';

import {
  parseRouterError,
  sendAIMessage,
  streamAIMessage
} from '../src/services/aiRouter.js';

import {
  formatGroqMessages,
  sendGroqMessage,
  streamGroqMessage
} from '../src/services/groqService.js';

import {
  transcribeAudioBlob,
  createMinimalWavBlob
} from '../src/services/transcriptionService.js';

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
 * Starts a local mock Groq API server that handles:
 *  - POST /openai/v1/chat/completions
 *  - POST /openai/v1/audio/transcriptions
 */
function startMockGroqUpstream() {
  const state = {
    chatCalls: [],
    transcriptionCalls: [],
    chatHandler: null,
    transcriptionHandler: null,
    reset() {
      this.chatCalls = [];
      this.transcriptionCalls = [];
      this.chatHandler = null;
      this.transcriptionHandler = null;
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

        if (parsedBody.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write(
            `data: ${JSON.stringify({
              id: 'chatcmpl-default',
              model: parsedBody.model || 'openai/gpt-oss-120b',
              choices: [
                {
                  index: 0,
                  delta: { content: 'Default mock Groq response' },
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
            id: 'chatcmpl-default',
            model: parsedBody.model || 'openai/gpt-oss-120b',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'Default mock Groq response' },
                finish_reason: 'stop'
              }
            ]
          })
        );
        return;
      }

      if (req.method === 'POST' && url.endsWith('/audio/transcriptions')) {
        const rawText = rawBuffer.toString('latin1');
        const modelMatch = rawText.match(/name="model"\r\n\r\n([^\r\n]+)/);
        const formatMatch = rawText.match(/name="response_format"\r\n\r\n([^\r\n]+)/);
        const langMatch = rawText.match(/name="language"\r\n\r\n([^\r\n]+)/);
        const fileMatch = rawText.match(/name="file"; filename="([^"]+)"/);

        const callRecord = {
          url,
          headers: req.headers,
          model: modelMatch ? modelMatch[1].trim() : null,
          responseFormat: formatMatch ? formatMatch[1].trim() : null,
          language: langMatch ? langMatch[1].trim() : null,
          filename: fileMatch ? fileMatch[1].trim() : null,
          byteLength: rawBuffer.length,
          timestamp: Date.now()
        };
        state.transcriptionCalls.push(callRecord);

        if (typeof state.transcriptionHandler === 'function') {
          await state.transcriptionHandler(req, res, callRecord);
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            text: 'Transcribed audio from Groq Whisper.',
            language: callRecord.language || 'en',
            duration: 2.45
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
      const baseUrl = `http://127.0.0.1:${addr.port}/openai/v1`;
      resolve({
        state,
        baseUrl,
        close: () => new Promise((r) => server.close(() => r()))
      });
    });
    server.on('error', reject);
  });
}

/**
 * Starts an ephemeral server.ts process on an available local port wired to mockGroqBaseUrl.
 */
async function startTestServer(port, mockGroqBaseUrl) {
  const childEnv = {
    ...process.env,
    PORT: String(port),
    NODE_ENV: 'production',
    ORVIX_GROQ_BASE_URL: mockGroqBaseUrl,
    GROQ_API_KEY: 'gsk_test_phase4d_valid_key',
    VITE_GROQ_API_KEY: '',
    GEMINI_API_KEY: '',
    VITE_GEMINI_API_KEY: '',
    OPENROUTER_API_KEY: 'sk-or-v1-test-fallback-key',
    CLOUDFLARE_API_TOKEN: '',
    CLOUDFLARE_ACCOUNT_ID: ''
  };
  delete childEnv.TESTING;

  const child = spawn('npx', ['tsx', 'server.ts'], {
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const baseUrl = `http://127.0.0.1:${port}`;
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
              try {
                child.kill('SIGKILL');
              } catch (_) {}
              setTimeout(() => resolve(), 150);
            })
        };
      }
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 150));
  }

  child.kill('SIGKILL');
  throw new Error('Timed out waiting for ephemeral server.ts to start');
}

/**
 * Re-roots relative `/api/...` fetch calls to the ephemeral test server URL
 * so `sendAIMessage`, `streamAIMessage`, `sendGroqMessage`, `streamGroqMessage`,
 * and `transcribeAudioBlob` hit the live test server.
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

async function main() {
  console.log('\n================================================================');
  console.log('🧪 PHASE 4D — GROQ PROVIDER HARDENING VERIFICATION SUITE');
  console.log('================================================================\n');

  const mockGroq = await startMockGroqUpstream();
  const testPort = 3940 + Math.floor(Math.random() * 200);
  const testServer = await startTestServer(testPort, mockGroq.baseUrl);
  const restoreFetch = installRelativeFetchInterceptor(testServer.baseUrl);

  try {
    // =========================================================================
    // 1. GROQ CHAT MODEL VALIDATION, DEFAULT SELECTION & RETIRED REJECTION
    // =========================================================================
    console.log('--- 1. Groq Chat Model Validation & Default Selection ---');

    await runTest('1.1 Default Groq chat model is openai/gpt-oss-120b and active chat models are accepted', () => {
      assert.equal(PROVIDER_DEFAULT_MODELS.groq, 'openai/gpt-oss-120b');
      assert.deepEqual(GROQ_FALLBACK_CHAT_MODELS, ['openai/gpt-oss-120b', 'llama-3.1-8b-instant']);

      for (const activeModel of GROQ_CHAT_MODELS) {
        const check = checkModelCompatibilityForProvider('groq', activeModel);
        assert.equal(check.compatible, true, `Expected ${activeModel} to be compatible`);
        assert.equal(check.normalizedModel, activeModel);
        assert.equal(sanitizeModelForProvider('groq', activeModel), activeModel);
      }

      assert.equal(sanitizeModelForProvider('groq', null), null);
      assert.equal(sanitizeModelForProvider('groq', ''), null);
      assert.equal(sanitizeModelForProvider('groq', 'GPT OSS 120B'), null);
      // Legacy Llama 3.3 chat references normalize cleanly to openai/gpt-oss-120b
      assert.equal(sanitizeModelForProvider('groq', 'llama-3.3-70b-versatile'), 'openai/gpt-oss-120b');
    });

    await runTest('1.2 Retired Groq models and Whisper audio models are rejected for Groq chat', async () => {
      for (const retiredModel of RETIRED_GROQ_MODELS) {
        const check = checkModelCompatibilityForProvider('groq', retiredModel);
        assert.equal(check.compatible, false, `Expected retired model ${retiredModel} to be rejected`);
        const serverCheck = validateServerModelForProvider('groq', retiredModel);
        assert.equal(serverCheck.valid, false, `Expected server validator to reject ${retiredModel}`);
        assert.equal(serverCheck.code, 400);
        assert.equal(serverCheck.status, 'INVALID_MODEL');
      }

      for (const whisperModel of GROQ_TRANSCRIPTION_MODELS) {
        const check = checkModelCompatibilityForProvider('groq', whisperModel);
        assert.equal(check.compatible, false, `Expected Whisper model ${whisperModel} to be rejected in chat`);
        assert.match(check.reason || '', /audio transcription model/i);

        // Also verify live /api/chat endpoint rejects Whisper model IDs with HTTP 400
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider: 'groq',
            model: whisperModel,
            prompt: 'Hello Groq'
          })
        });
        assert.equal(res.status, 400);
        const body = await res.json();
        assert.equal(body.status, 'INVALID_MODEL');
        assert.equal(body.retryable, false);
      }
    });

    // =========================================================================
    // 2. AUDIO TRANSCRIPTION MODEL COMPATIBILITY & API VERIFICATION
    // =========================================================================
    console.log('\n--- 2. Audio Transcription Model Compatibility & Endpoint Verification ---');

    await runTest('2.1 validateGroqTranscriptionModel accepts Whisper models and rejects chat models', () => {
      assert.equal(DEFAULT_GROQ_TRANSCRIPTION_MODEL, 'whisper-large-v3-turbo');

      const defaultCheck = validateGroqTranscriptionModel('');
      assert.equal(defaultCheck.valid, true);
      assert.equal(defaultCheck.model, 'whisper-large-v3-turbo');

      for (const validWhisper of ['whisper-large-v3-turbo', 'whisper-large-v3']) {
        const res = validateGroqTranscriptionModel(validWhisper);
        assert.equal(res.valid, true);
        assert.equal(res.model, validWhisper);
      }

      for (const invalidChatModel of ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'llama-3.1-8b-instant', 'gemini-2.5-flash']) {
        const res = validateGroqTranscriptionModel(invalidChatModel);
        assert.equal(res.valid, false, `Expected chat model ${invalidChatModel} to be rejected for transcription`);
        assert.equal(res.code, 'INVALID_TRANSCRIPTION_MODEL');
      }
    });

    await runTest('2.2 Live /api/transcribe rejects chat-completion models (including llama-3.3-70b-versatile) with HTTP 400', async () => {
      mockGroq.state.reset();
      const wavBlob = createMinimalWavBlob();

      for (const badModel of ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b']) {
        await assert.rejects(
          async () => {
            await transcribeAudioBlob({
              audioBlob: wavBlob,
              model: badModel,
              language: 'en-US'
            });
          },
          (err) => {
            assert.equal(err.statusCode, 400);
            assert.equal(err.code, 'INVALID_TRANSCRIPTION_MODEL');
            assert.equal(err.retryable, false);
            assert.equal(err.fallbackAvailable, false);
            return true;
          }
        );
      }

      assert.equal(mockGroq.state.transcriptionCalls.length, 0, 'Must not dispatch invalid model to Groq upstream');
      assert.equal(mockGroq.state.chatCalls.length, 0, 'Must never call Groq chat completions from /api/transcribe');
    });

    await runTest('2.3 Live /api/transcribe sends valid audio to Groq Whisper and parses verbose_json response', async () => {
      mockGroq.state.reset();
      mockGroq.state.transcriptionHandler = async (_req, res, callRecord) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            task: 'transcribe',
            language: callRecord.language || 'en',
            duration: 3.72,
            text: '  Async await functions in JavaScript and React.  '
          })
        );
      };

      const wavBlob = createMinimalWavBlob();
      const result = await transcribeAudioBlob({
        audioBlob: wavBlob,
        language: 'en-US',
        prompt: 'programming dictation'
      });

      assert.equal(result.success, true);
      assert.equal(result.text, 'Async await functions in JavaScript and React.');
      assert.equal(result.model, 'whisper-large-v3-turbo');
      assert.equal(result.provider, 'groq');
      assert.equal(result.duration, 3.72);
      assert.equal(mockGroq.state.transcriptionCalls.length, 1);
      assert.equal(mockGroq.state.transcriptionCalls[0].model, 'whisper-large-v3-turbo');
      assert.equal(mockGroq.state.transcriptionCalls[0].responseFormat, 'verbose_json');
      assert.equal(mockGroq.state.transcriptionCalls[0].language, 'en');
      assert.equal(mockGroq.state.chatCalls.length, 0);
    });

    await runTest('2.4 Live /api/transcribe handles 401/403/429 and unsupported formats clearly without substituting chat completions', async () => {
      const wavBlob = createMinimalWavBlob();

      // 401 Unauthorized from Groq Whisper
      mockGroq.state.reset();
      mockGroq.state.transcriptionHandler = async (_req, res) => {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid API Key', type: 'invalid_request_error', code: 'invalid_api_key' } }));
      };

      await assert.rejects(
        async () => {
          await transcribeAudioBlob({ audioBlob: wavBlob, language: 'en-US' });
        },
        (err) => {
          assert.equal(err.statusCode, 401);
          assert.equal(err.code, 'UNAUTHENTICATED');
          assert.equal(err.retryable, false);
          assert.equal(err.fallbackAvailable, false);
          return true;
        }
      );
      assert.equal(mockGroq.state.chatCalls.length, 0);

      // 429 Rate Limit from Groq Whisper
      mockGroq.state.reset();
      mockGroq.state.transcriptionHandler = async (_req, res) => {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Rate limit exceeded for whisper-large-v3-turbo', type: 'rate_limit_error' } }));
      };

      await assert.rejects(
        async () => {
          await transcribeAudioBlob({ audioBlob: wavBlob, language: 'en-US' });
        },
        (err) => {
          assert.equal(err.statusCode, 429);
          assert.equal(err.code, 'RATE_LIMIT_EXCEEDED');
          assert.equal(err.retryable, true);
          assert.equal(err.fallbackAvailable, true);
          return true;
        }
      );
      assert.equal(mockGroq.state.chatCalls.length, 0);

      // Transcript-only refinement never calls Groq chat completions or Whisper
      mockGroq.state.reset();
      const refinedOnly = await transcribeAudioBlob({
        audioBlob: null,
        transcript: 'hello world period how are you question mark',
        language: 'en-US'
      });
      assert.equal(refinedOnly.success, true);
      assert.equal(refinedOnly.provider, 'local');
      assert.equal(mockGroq.state.transcriptionCalls.length, 0);
      assert.equal(mockGroq.state.chatCalls.length, 0, 'Must never call Groq chat completions for transcription');

      // Unsupported file format rejected with HTTP 400 AUDIO_UPLOAD_ERROR
      const badFormData = new FormData();
      badFormData.append('file', new Blob(['not audio'], { type: 'text/plain' }), 'notes.txt');
      const badFormatRes = await fetch('/api/transcribe', {
        method: 'POST',
        body: badFormData
      });
      assert.equal(badFormatRes.status, 400);
      const badFormatBody = await badFormatRes.json();
      assert.equal(badFormatBody.code, 'AUDIO_UPLOAD_ERROR');
    });

    // =========================================================================
    // 3. GROQ SSE ERROR FRAMES BEFORE & AFTER TEXT CHUNKS
    // =========================================================================
    console.log('\n--- 3. Groq SSE Error Frames Before & After Text Chunks ---');

    await runTest('3.1 SSE error frame AFTER valid text chunks preserves partial text and emits terminal error (no false done)', async () => {
      mockGroq.state.reset();
      mockGroq.state.chatHandler = async (_req, res) => {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive'
        });
        res.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl-stream-1',
            model: 'openai/gpt-oss-120b',
            choices: [{ index: 0, delta: { content: 'First valid chunk. ' }, finish_reason: null }]
          })}\n\n`
        );
        res.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl-stream-1',
            model: 'openai/gpt-oss-120b',
            choices: [{ index: 0, delta: { content: 'Second valid chunk.' }, finish_reason: null }]
          })}\n\n`
        );
        // Inject upstream Groq SSE error frame mid-stream followed by [DONE]
        res.write(
          `data: ${JSON.stringify({
            error: {
              message: 'Rate limit reached mid-stream for model openai/gpt-oss-120b',
              type: 'rate_limit_exceeded',
              code: 429
            }
          })}\n\n`
        );
        res.write('data: [DONE]\n\n');
        res.end();
      };

      const receivedChunks = [];
      let latestAccumulated = '';

      await assert.rejects(
        async () => {
          await streamAIMessage({
            prompt: 'Stream a response that fails mid-way',
            provider: 'groq',
            model: 'openai/gpt-oss-120b',
            onChunk: (delta, acc) => {
              receivedChunks.push(delta);
              latestAccumulated = acc;
            }
          });
        },
        (err) => {
          assert.equal(err.provider, 'groq');
          assert.equal(err.code, 429);
          assert.equal(err.status, 'rate_limit_exceeded');
          assert.equal(err.retryable, false, 'Mid-stream error after partial text must not auto-retry');
          assert.equal(err.canFallback, true);
          assert.equal(err.partial, true);
          assert.equal(err.partialText, 'First valid chunk. Second valid chunk.');
          assert.match(err.message, /Rate limit|quota exceeded/i);
          return true;
        }
      );

      assert.deepEqual(receivedChunks, ['First valid chunk. ', 'Second valid chunk.']);
      assert.equal(latestAccumulated, 'First valid chunk. Second valid chunk.');
      assert.equal(mockGroq.state.chatCalls.length, 1, 'Router must not retry after partial stream chunks were emitted');
    });

    await runTest('3.2 SSE event: error frame BEFORE any text chunk propagates terminal error and does not emit done', async () => {
      mockGroq.state.reset();
      mockGroq.state.chatHandler = async (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('event: error\n');
        res.write(
          `data: ${JSON.stringify({
            error: {
              message: 'Upstream Groq engine overloaded before first token',
              type: 'server_error',
              code: 503
            }
          })}\n\n`
        );
        res.end();
      };

      const chunks = [];
      await assert.rejects(
        async () => {
          await streamAIMessage({
            prompt: 'Fail before first token',
            provider: 'groq',
            onChunk: (c) => chunks.push(c)
          });
        },
        (err) => {
          assert.equal(err.provider, 'groq');
          assert.equal(err.code, 503);
          assert.equal(err.status, 'server_error');
          assert.equal(err.retryable, false);
          assert.equal(err.canFallback, true);
          assert.equal(err.partial, false);
          assert.match(err.message, /overloaded before first token/i);
          return true;
        }
      );
      assert.equal(chunks.length, 0);
    });

    // =========================================================================
    // 4. MALFORMED UPSTREAM ERROR FRAMES
    // =========================================================================
    console.log('\n--- 4. Malformed Upstream SSE Error Frame Resilience ---');

    await runTest('4.1 Malformed non-JSON event: error frame and truncated JSON error frame do not crash parser or emit false done', async () => {
      // Case A: Non-JSON payload under `event: error`
      mockGroq.state.reset();
      mockGroq.state.chatHandler = async (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(
          `data: ${JSON.stringify({
            choices: [{ index: 0, delta: { content: 'Partial output before crash.' } }]
          })}\n\n`
        );
        res.write('event: error\n');
        res.write('data: <html><body>502 Bad Gateway from upstream proxy</body></html>\n\n');
        res.end();
      };

      await assert.rejects(
        async () => {
          await streamAIMessage({
            prompt: 'Test HTML error frame',
            provider: 'groq'
          });
        },
        (err) => {
          assert.equal(err.provider, 'groq');
          assert.equal(err.partial, true);
          assert.equal(err.partialText, 'Partial output before crash.');
          assert.match(err.message, /502 Bad Gateway/i);
          return true;
        }
      );

      // Case B: Truncated JSON error frame in trailing buffer without final newline
      mockGroq.state.reset();
      mockGroq.state.chatHandler = async (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(
          `data: ${JSON.stringify({
            choices: [{ index: 0, delta: { content: 'Chunk 1.' } }]
          })}\n\n`
        );
        // Trailing buffer with no trailing newline and truncated JSON containing "error":
        res.write('data: {"error": {"message": "Truncated upstream stream failure", "code": 500');
        res.end();
      };

      await assert.rejects(
        async () => {
          await streamGroqMessage({
            prompt: 'Test trailing malformed error buffer'
          });
        },
        (err) => {
          assert.equal(err.provider, 'groq');
          assert.equal(err.partial, true);
          assert.equal(err.partialText, 'Chunk 1.');
          assert.match(err.message, /Truncated upstream stream failure/i);
          return true;
        }
      );
    });

    // =========================================================================
    // 5. NON-RETRYABLE VS RETRYABLE GROQ FAILURES
    // =========================================================================
    console.log('\n--- 5. Non-Retryable vs Retryable Groq Failures ---');

    await runTest('5.1 Non-retryable 401, 403, and 400 Groq failures stop immediately after 1 attempt', async () => {
      for (const statusCode of [401, 403, 400]) {
        mockGroq.state.reset();
        mockGroq.state.chatHandler = async (_req, res) => {
          res.writeHead(statusCode, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: {
                message: `Simulated Groq HTTP ${statusCode} failure`,
                type: 'invalid_request_error',
                code: statusCode
              }
            })
          );
        };

        await assert.rejects(
          async () => {
            await sendAIMessage({
              prompt: `Trigger ${statusCode}`,
              provider: 'groq',
              model: 'openai/gpt-oss-120b'
            });
          },
          (err) => {
            assert.equal(err.provider, 'groq');
            assert.equal(err.code, statusCode);
            assert.equal(err.retryable, false, `HTTP ${statusCode} must be non-retryable`);
            return true;
          }
        );

        assert.equal(
          mockGroq.state.chatCalls.length,
          1,
          `Expected exactly 1 upstream attempt for non-retryable HTTP ${statusCode}`
        );
      }
    });

    await runTest('5.2 Retryable transient Groq failure (HTTP 429) retries once and succeeds on attempt 2', async () => {
      mockGroq.state.reset();
      let callCount = 0;
      mockGroq.state.chatHandler = async (_req, res, callRecord) => {
        callCount++;
        if (callCount === 1) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: {
                message: 'Rate limit reached, please retry shortly',
                type: 'rate_limit_exceeded'
              }
            })
          );
          return;
        }
        if (callRecord.body.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write(
            `data: ${JSON.stringify({
              id: 'chatcmpl-retry-ok',
              model: callRecord.body.model,
              choices: [{ index: 0, delta: { content: 'Recovered on second attempt!' }, finish_reason: 'stop' }]
            })}\n\ndata: [DONE]\n\n`
          );
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-retry-ok',
            model: callRecord.body.model,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'Recovered on second attempt!' },
                finish_reason: 'stop'
              }
            ]
          })
        );
      };

      const result = await sendAIMessage({
        prompt: 'Test transient 429 recovery',
        provider: 'groq',
        model: 'openai/gpt-oss-120b'
      });

      assert.equal(result.text, 'Recovered on second attempt!');
      assert.equal(result.provider, 'groq');
      assert.equal(mockGroq.state.chatCalls.length, 2, 'Expected 1 initial call + 1 bounded retry');
    });

    await runTest('5.3 Persistent retryable Groq failure (HTTP 503) stops at bounded retry limit (2 attempts max)', async () => {
      mockGroq.state.reset();
      mockGroq.state.chatHandler = async (_req, res) => {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              message: 'Groq service temporarily unavailable',
              type: 'service_unavailable'
            }
          })
        );
      };

      await assert.rejects(
        async () => {
          await sendAIMessage({
            prompt: 'Test bounded 503 retry exhaustion',
            provider: 'groq',
            model: 'openai/gpt-oss-120b'
          });
        },
        (err) => {
          assert.equal(err.provider, 'groq');
          assert.equal(err.code, 503);
          assert.equal(err.status, 'UNAVAILABLE');
          return true;
        }
      );

      assert.equal(mockGroq.state.chatCalls.length, 2, 'Expected bounded retry limit of 2 total attempts');
    });

    // =========================================================================
    // 6. CANCELLATION DURING STREAMING AND RETRY/BACKOFF
    // =========================================================================
    console.log('\n--- 6. Client Cancellation During Streaming & Retry/Backoff ---');

    await runTest('6.1 Aborting during retry backoff prevents any second upstream Groq attempt', async () => {
      mockGroq.state.reset();
      const abortController = new AbortController();

      mockGroq.state.chatHandler = async (_req, res) => {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: { message: 'Rate limit exceeded', type: 'rate_limit_exceeded' }
          })
        );
        // Abort shortly after the first attempt returns 429 (while router is in backoff sleep)
        setTimeout(() => abortController.abort(), 60);
      };

      await assert.rejects(
        async () => {
          await sendAIMessage({
            prompt: 'Abort during retry backoff',
            provider: 'groq',
            signal: abortController.signal
          });
        },
        (err) => {
          assert.equal(err.name, 'AbortError');
          return true;
        }
      );

      await new Promise((r) => setTimeout(r, 300));
      assert.equal(mockGroq.state.chatCalls.length, 1, 'No second attempt should be made after AbortSignal fires');
    });

    await runTest('6.2 Aborting mid-stream stops client consumption and prevents further fallback attempts', async () => {
      mockGroq.state.reset();
      const abortController = new AbortController();

      mockGroq.state.chatHandler = async (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(
          `data: ${JSON.stringify({
            choices: [{ index: 0, delta: { content: 'Initial token ' } }]
          })}\n\n`
        );
        setTimeout(() => {
          try {
            res.write(
              `data: ${JSON.stringify({
                choices: [{ index: 0, delta: { content: 'Token after abort' } }]
              })}\n\n`
            );
            res.end();
          } catch (_) {}
        }, 250);
      };

      const received = [];
      await assert.rejects(
        async () => {
          await streamAIMessage({
            prompt: 'Abort mid-stream',
            provider: 'groq',
            signal: abortController.signal,
            onChunk: (delta) => {
              received.push(delta);
              abortController.abort();
            }
          });
        },
        (err) => {
          assert.equal(err.name, 'AbortError');
          return true;
        }
      );

      assert.deepEqual(received, ['Initial token ']);
      assert.equal(mockGroq.state.chatCalls.length, 1);
    });

    // =========================================================================
    // 7. FALLBACK BEHAVIOR ON MODEL 404 & EXHAUSTION SEMANTICS
    // =========================================================================
    console.log('\n--- 7. Groq Model Fallback on HTTP 404 & Exhaustion Semantics ---');

    await runTest('7.1 HTTP 404 on primary Groq model advances to fallback model llama-3.1-8b-instant without repeating failed model', async () => {
      mockGroq.state.reset();
      mockGroq.state.chatHandler = async (_req, res, callRecord) => {
        if (callRecord.body.model === 'openai/gpt-oss-120b') {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: {
                message: 'The model `openai/gpt-oss-120b` does not exist or you do not have access to it.',
                type: 'invalid_request_error',
                code: 'model_not_found'
              }
            })
          );
          return;
        }

        if (callRecord.body.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write(
            `data: ${JSON.stringify({
              id: 'chatcmpl-fallback-ok',
              model: callRecord.body.model,
              choices: [
                {
                  index: 0,
                  delta: { content: 'Answered by fallback model llama-3.1-8b-instant' },
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
            id: 'chatcmpl-fallback-ok',
            model: callRecord.body.model,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'Answered by fallback model llama-3.1-8b-instant' },
                finish_reason: 'stop'
              }
            ]
          })
        );
      };

      const res = await sendAIMessage({
        prompt: 'Test 404 fallback advancement',
        provider: 'groq',
        model: 'openai/gpt-oss-120b'
      });

      assert.equal(res.text, 'Answered by fallback model llama-3.1-8b-instant');
      assert.equal(res.modelUsed, 'llama-3.1-8b-instant');
      assert.equal(mockGroq.state.chatCalls.length, 2);
      assert.equal(mockGroq.state.chatCalls[0].body.model, 'openai/gpt-oss-120b');
      assert.equal(mockGroq.state.chatCalls[1].body.model, 'llama-3.1-8b-instant');

      // Also verify non-streaming sendGroqMessage 404 fallback advancement
      mockGroq.state.chatCalls = [];
      const nonStreamRes = await sendGroqMessage({
        prompt: 'Test non-streaming 404 fallback advancement',
        model: 'openai/gpt-oss-120b'
      });
      assert.equal(nonStreamRes.text, 'Answered by fallback model llama-3.1-8b-instant');
      assert.equal(nonStreamRes.modelUsed, 'llama-3.1-8b-instant');
      assert.equal(mockGroq.state.chatCalls.length, 2);
    });

    await runTest('7.2 When all Groq fallback models return 404, server returns serverRetriesExhausted: true and router does not re-attempt', async () => {
      mockGroq.state.reset();
      mockGroq.state.chatHandler = async (_req, res, callRecord) => {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              message: `Model ${callRecord.body.model} not found`,
              type: 'invalid_request_error',
              code: 'model_not_found'
            }
          })
        );
      };

      await assert.rejects(
        async () => {
          await sendAIMessage({
            prompt: 'All Groq models 404',
            provider: 'groq',
            model: 'openai/gpt-oss-120b'
          });
        },
        (err) => {
          assert.equal(err.provider, 'groq');
          assert.equal(err.code, 404);
          assert.equal(err.status, 'NOT_FOUND');
          assert.equal(err.retryable, false);
          assert.equal(err.canFallback, true);
          return true;
        }
      );

      // Server tried openai/gpt-oss-120b -> llama-3.1-8b-instant (2 distinct models) and router did NOT repeat
      assert.equal(mockGroq.state.chatCalls.length, 2);
      assert.deepEqual(
        mockGroq.state.chatCalls.map((c) => c.body.model),
        ['openai/gpt-oss-120b', 'llama-3.1-8b-instant']
      );
    });

    // =========================================================================
    // 8. PROVIDER ISOLATION & PHASE 4B ERROR-CONTRACT INVARIANTS
    // =========================================================================
    console.log('\n--- 8. Provider Isolation & Error-Contract Invariants ---');

    await runTest('8.1 Non-Groq provider default models, compatibility rules, and Phase 4B error contracts remain intact', () => {
      assert.equal(PROVIDER_DEFAULT_MODELS.gemini, 'gemini-3.8-flash');
      assert.equal(PROVIDER_DEFAULT_MODELS.openrouter, 'openrouter/free');
      assert.equal(PROVIDER_DEFAULT_MODELS.cloudflare, '@cf/meta/llama-3.1-8b-instruct');
      assert.equal(PROVIDER_DEFAULT_MODELS.webllm, 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC');

      assert.equal(checkModelCompatibilityForProvider('gemini', 'gemini-2.5-pro').compatible, true);
      assert.equal(checkModelCompatibilityForProvider('openrouter', 'meta-llama/llama-3.3-70b-instruct:free').compatible, true);
      assert.equal(checkModelCompatibilityForProvider('cloudflare', '@cf/meta/llama-3.1-8b-instruct').compatible, true);
      assert.equal(checkModelCompatibilityForProvider('webllm', 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC').compatible, true);

      // Cross-provider isolation checks
      assert.equal(checkModelCompatibilityForProvider('groq', 'gemini-2.5-flash').compatible, false);
      assert.equal(checkModelCompatibilityForProvider('groq', 'openrouter/free').compatible, false);
      assert.equal(checkModelCompatibilityForProvider('groq', '@cf/meta/llama-3.1-8b-instruct').compatible, false);
      assert.equal(checkModelCompatibilityForProvider('groq', 'qwen2.5:1.5b').compatible, false);
      assert.equal(checkModelCompatibilityForProvider('groq', 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC').compatible, false);

      // FormatGroqMessages & sanitizer fallback invariants
      const formatted = formatGroqMessages(
        [{ sender: 'user', content: 'Hello' }, { sender: 'ai', content: 'Hi there!' }],
        'Explain closures',
        12,
        'coding'
      );
      assert.equal(formatted[0].role, 'system');
      assert.equal(formatted[1].role, 'user');
      assert.equal(formatted[2].role, 'assistant');
      assert.equal(formatted[3].role, 'user');

      const sanitizedWhisperInChat = sanitizeModelForProvider('groq', 'whisper-large-v3-turbo') || PROVIDER_DEFAULT_MODELS.groq;
      assert.equal(sanitizedWhisperInChat, 'openai/gpt-oss-120b');

      const exhaustedErr = parseRouterError(
        {
          error: 'All Groq fallback models exhausted',
          status: 'NOT_FOUND',
          retryable: true,
          serverRetriesExhausted: true,
          canFallback: true
        },
        404,
        'groq'
      );
      assert.equal(exhaustedErr.retryable, false);
      assert.equal(exhaustedErr.serverRetriesExhausted, true);
      assert.equal(exhaustedErr.canFallback, true);
    });
  } finally {
    restoreFetch();
    await testServer.stop();
    await mockGroq.close();
  }

  console.log('\n================================================================');
  console.log(`📊 PHASE 4D TEST SUMMARY: ${passed} passed, ${failed} failed`);
  console.log('================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('Unhandled error in Phase 4D test suite:', err);
  process.exit(1);
});
