/**
 * Phase 4B — Focused Regression Suite:
 * Shared Provider Configuration, Model Sanitization, Router Retry & Continuation Safety,
 * Obsolete Client Fallback Removal, 6-Action Offline Guards, and Server Upstream Cancellation/Timeouts.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  sanitizeModelForProvider,
  sanitizeStoredDisplayModel,
  validateServerModelForProvider,
  normalizeProviderConfigPayload,
  getProviderConfigAvailability,
  filterAvailableFallbackProviders,
  evaluateOfflineProviderGuard
} from '../src/services/providerModelSanitizer.js';
import {
  streamAIMessage,
  fetchProviderConfig,
  resetCachedProviderConfig,
  isProviderConfigured,
  PROVIDER_OPTIONS
} from '../src/services/aiRouter.js';
import {
  saveAttachmentBlob,
  MAX_VISION_IMAGE_BYTES,
  MAX_CHAT_REQUEST_BYTES
} from '../src/services/attachmentStorageService.js';
import {
  normalizeAssistantMessage,
  addAlternativeToAssistantMessage,
  createAlternativeRecord
} from '../src/services/alternativeResponseService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Minimal IndexedDB shim in Node so saveAttachmentBlob + hydrateAttachmentsWithImageBytes work end-to-end
const idbStores = new Map();
if (typeof globalThis.indexedDB === 'undefined') {
  globalThis.indexedDB = {
    open(dbName) {
      const req = { result: null, error: null, onupgradeneeded: null, onsuccess: null, onerror: null };
      queueMicrotask(() => {
        if (!idbStores.has(dbName)) idbStores.set(dbName, new Map());
        const storeMap = idbStores.get(dbName);
        const db = {
          objectStoreNames: { contains: (n) => storeMap.has(n) },
          createObjectStore(n) {
            if (!storeMap.has(n)) storeMap.set(n, new Map());
            return {
              createIndex() {}
            };
          },
          transaction(n) {
            const storeKey = Array.isArray(n) ? n[0] : n;
            if (!storeMap.has(storeKey)) storeMap.set(storeKey, new Map());
            const map = storeMap.get(storeKey);
            const tx = { oncomplete: null, onerror: null, onabort: null, error: null };
            return {
              objectStore() {
                return {
                  put(val) {
                    const r = { onsuccess: null, onerror: null };
                    setTimeout(() => {
                      map.set(val.id, val);
                      r.onsuccess?.({ target: r });
                      tx.oncomplete?.();
                    }, 0);
                    return r;
                  },
                  get(key) {
                    const r = { result: map.get(key), onsuccess: null, onerror: null };
                    setTimeout(() => {
                      r.result = map.get(key);
                      r.onsuccess?.({ target: r });
                      tx.oncomplete?.();
                    }, 0);
                    return r;
                  },
                  delete(key) {
                    const r = { onsuccess: null, onerror: null };
                    setTimeout(() => {
                      map.delete(key);
                      r.onsuccess?.({ target: r });
                      tx.oncomplete?.();
                    }, 0);
                    return r;
                  },
                  getAll() {
                    const r = { result: [], onsuccess: null, onerror: null };
                    setTimeout(() => {
                      r.result = Array.from(map.values());
                      r.onsuccess?.({ target: r });
                      tx.oncomplete?.();
                    }, 0);
                    return r;
                  }
                };
              }
            };
          },
          close() {}
        };
        req.result = db;
        req.onupgradeneeded?.({ target: req });
        req.onsuccess?.({ target: req });
      });
      return req;
    }
  };
}

const VALID_PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

/**
 * Starts an ephemeral Express instance from real `server.ts` on an OS-assigned port
 * with isolated environment variables via `tsx`.
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

  const tsxBin = path.join(ROOT_DIR, 'node_modules', '.bin', 'tsx');
  const child = spawn(tsxBin, ['-e', runnerCode], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      TESTING: '1',
      ...envOverrides
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stderrBuf = '';
  child.stderr.on('data', (d) => {
    stderrBuf += d.toString();
  });

  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Timed out starting ephemeral server.ts. Stderr: ${stderrBuf}`));
    }, 15_000);

    let stdoutBuf = '';
    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString();
      const match = stdoutBuf.match(/EPHEMERAL_PORT=(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(Number(match[1]));
      }
    });

    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Ephemeral server exited early (${code}). Stderr: ${stderrBuf}`));
    });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    port,
    baseUrl,
    async close() {
      if (child.exitCode !== null) return;
      await new Promise((resolve) => {
        const killTimer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve(undefined);
        }, 2000);
        child.once('exit', () => {
          clearTimeout(killTimer);
          resolve(undefined);
        });
        child.kill('SIGTERM');
      });
    }
  };
}

/**
 * Starts a lightweight local HTTP server for mocking `/api/chat` or upstream provider endpoints.
 */
async function startLocalMockServer() {
  /** @type {Array<{ url: string, method: string, body: any, headers: Record<string, any> }>} */
  const requests = [];
  let handler = null;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let parsed = null;
      try {
        parsed = raw ? JSON.parse(raw) : null;
      } catch (_) {
        parsed = raw;
      }
      const idx = requests.length;
      requests.push({
        url: req.url || '',
        method: req.method || 'GET',
        body: parsed,
        headers: req.headers
      });
      if (typeof handler === 'function') {
        await handler(req, res, parsed, idx);
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    setHandler(fn) {
      handler = fn;
    },
    reset() {
      requests.length = 0;
    },
    async close() {
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    }
  };
}

/**
 * Temporarily routes relative `fetch('/api/...')` calls in Node to `baseUrl`.
 */
async function withRelativeFetchBase(baseUrl, fn) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    if (typeof input === 'string' && input.startsWith('/')) {
      return originalFetch(`${baseUrl}${input}`, init);
    }
    return originalFetch(input, init);
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

let passed = 0;
let failed = 0;

async function runTest(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed++;
    console.error(`  [FAIL] ${name}`);
    console.error('        ', err?.stack || err);
  }
}

console.log('\n=== Phase 4B Regression Suite ===\n');

// ---------------------------------------------------------------------------
// Shared ephemeral unconfigured server for Tests 1, 2, and 4
// ---------------------------------------------------------------------------
const unconfiguredServer = await startEphemeralAppServer({
  GEMINI_API_KEY: '',
  GROQ_API_KEY: '',
  OPENROUTER_API_KEY: '',
  CLOUDFLARE_ACCOUNT_ID: '',
  CLOUDFLARE_API_TOKEN: '',
  ORVIX_ENABLE_DEMO_MODE: 'false'
});

try {
  // -------------------------------------------------------------------------
  // 1. Unconfigured cloud provider error & explicit opt-in demo mode
  // -------------------------------------------------------------------------
  await runTest(
    '1. Unconfigured cloud providers return structured HTTP 503 PROVIDER_NOT_CONFIGURED (never silent HTTP 200 demo output unless ORVIX_ENABLE_DEMO_MODE=true)',
    async () => {
      for (const provider of ['gemini', 'groq', 'openrouter', 'cloudflare']) {
        for (const streamFlag of [true, false]) {
          const res = await fetch(`${unconfiguredServer.baseUrl}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              provider,
              stream: streamFlag,
              prompt: 'Hello Orvix'
            })
          });

          assert.strictEqual(
            res.status,
            503,
            `Expected HTTP 503 for unconfigured ${provider} (stream=${streamFlag}), got ${res.status}`
          );
          const payload = await res.json();
          assert.strictEqual(payload.status, 'PROVIDER_NOT_CONFIGURED');
          assert.strictEqual(payload.errorCode, 'PROVIDER_NOT_CONFIGURED');
          assert.strictEqual(payload.provider, provider);
          assert.strictEqual(payload.retryable, false);
          assert.strictEqual(payload.canFallback, true);
          assert.ok(Array.isArray(payload.suggestedProviders));
          assert.ok(payload.suggestedProviders.includes('webllm'));
          assert.ok(
            !payload.suggestedProviders.includes('groq'),
            'Unconfigured cloud providers must not be suggested as fallbacks'
          );
          assert.ok(
            payload.error.includes('not configured on this server'),
            `Expected clear configuration message, got: ${payload.error}`
          );
        }
      }

      // Verify streamAIMessage surfaces PROVIDER_NOT_CONFIGURED cleanly without retrying
      await withRelativeFetchBase(unconfiguredServer.baseUrl, async () => {
        await assert.rejects(
          () =>
            streamAIMessage({
              provider: 'groq',
              prompt: 'Test unconfigured Groq'
            }),
          (err) => {
            assert.strictEqual(err.code, 503);
            assert.strictEqual(err.errorCode, 'PROVIDER_NOT_CONFIGURED');
            assert.strictEqual(err.retryable, false);
            return true;
          }
        );
      });

      // Verify explicit ORVIX_ENABLE_DEMO_MODE=true still works when intentionally opted in
      const demoServer = await startEphemeralAppServer({
        GEMINI_API_KEY: '',
        GROQ_API_KEY: '',
        OPENROUTER_API_KEY: '',
        CLOUDFLARE_ACCOUNT_ID: '',
        CLOUDFLARE_API_TOKEN: '',
        ORVIX_ENABLE_DEMO_MODE: 'true'
      });
      try {
        const demoRes = await fetch(`${demoServer.baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider: 'groq',
            stream: false,
            prompt: 'Hello in explicit demo mode'
          })
        });
        assert.strictEqual(demoRes.status, 200);
        const demoJson = await demoRes.json();
        assert.strictEqual(demoJson.isDemo, true);
        assert.ok(String(demoJson.modelUsed).includes('(demo)'));
      } finally {
        await demoServer.close();
      }
    }
  );

  // -------------------------------------------------------------------------
  // 2. /api/config shape, secret safety, and graceful client degradation
  // -------------------------------------------------------------------------
  await runTest(
    '2. /api/config exposes boolean availability only (zero secrets) and client degrades gracefully when unreachable',
    async () => {
      const secretLookingServer = await startEphemeralAppServer({
        GEMINI_API_KEY: 'AIzaSyTestSecretKeyValueDoNotLeak99999',
        GROQ_API_KEY: '',
        OPENROUTER_API_KEY: 'your_openrouter_api_key_here',
        CLOUDFLARE_ACCOUNT_ID: 'cf_secret_acct_12345',
        CLOUDFLARE_API_TOKEN: 'cf_secret_tok_67890',
        ORVIX_ENABLE_DEMO_MODE: 'false'
      });

      try {
        const cfgRes = await fetch(`${secretLookingServer.baseUrl}/api/config`);
        assert.strictEqual(cfgRes.status, 200);
        const rawText = await cfgRes.text();
        assert.ok(!rawText.includes('AIzaSyTestSecretKeyValueDoNotLeak99999'));
        assert.ok(!rawText.includes('cf_secret_acct_12345'));
        assert.ok(!rawText.includes('cf_secret_tok_67890'));
        assert.ok(!rawText.includes('your_openrouter_api_key_here'));

        const cfg = JSON.parse(rawText);
        assert.strictEqual(cfg.geminiConfigured, true);
        assert.strictEqual(cfg.groqConfigured, false);
        assert.strictEqual(cfg.openrouterConfigured, false, 'Placeholder key must report false');
        assert.strictEqual(cfg.cloudflareConfigured, true);
        assert.strictEqual(cfg.webllmSupported, true);
        assert.strictEqual(cfg.demoModeEnabled, false);

        for (const [k, v] of Object.entries(cfg)) {
          if (k === 'whisperProvider') {
            assert.ok(v === null || v === 'groq' || v === 'gemini');
          } else {
            assert.strictEqual(typeof v, 'boolean', `Field ${k} must be boolean, got ${typeof v}`);
          }
        }

        // Verify client fetchProviderConfig + availability helpers
        resetCachedProviderConfig();
        await withRelativeFetchBase(secretLookingServer.baseUrl, async () => {
          const snapshot = await fetchProviderConfig({ forceRefresh: true });
          assert.strictEqual(snapshot.status, 'ready');
          assert.strictEqual(isProviderConfigured('gemini', snapshot), true);
          assert.strictEqual(isProviderConfigured('groq', snapshot), false);
          assert.strictEqual(getProviderConfigAvailability('groq', snapshot).state, 'unconfigured');
          assert.strictEqual(getProviderConfigAvailability('gemini', snapshot).state, 'configured');

          const fallbacksFromGroq = filterAvailableFallbackProviders(
            PROVIDER_OPTIONS,
            'groq',
            snapshot
          ).map((p) => p.id);
          assert.ok(fallbacksFromGroq.includes('gemini'));
          assert.ok(fallbacksFromGroq.includes('cloudflare'));
          assert.ok(fallbacksFromGroq.includes('webllm'));
          assert.ok(
            !fallbacksFromGroq.includes('openrouter'),
            'Unconfigured OpenRouter must be omitted from error fallback suggestions'
          );
        });
      } finally {
        await secretLookingServer.close();
      }

      // Verify graceful degradation when /api/config fails (offline / 500)
      resetCachedProviderConfig();
      await withRelativeFetchBase('http://127.0.0.1:1', async () => {
        const failedSnapshot = await fetchProviderConfig({ forceRefresh: true });
        assert.strictEqual(failedSnapshot.status, 'unavailable');
        assert.strictEqual(
          getProviderConfigAvailability('groq', failedSnapshot).state,
          'unknown',
          'Unreachable /api/config must report unknown, never falsely unconfigured'
        );
        assert.strictEqual(isProviderConfigured('groq', failedSnapshot), false);
        assert.strictEqual(isProviderConfigured('webllm', failedSnapshot), true);
      });
    }
  );

  // -------------------------------------------------------------------------
  // 3. Client model sanitization
  // -------------------------------------------------------------------------
  await runTest(
    '3. Client model sanitization strips (demo), Document Analyzer, UI labels, and cross-provider models while preserving valid IDs',
    async () => {
      // (demo) suffixes -> null
      assert.strictEqual(sanitizeModelForProvider('gemini', 'gemini-3.1-flash-lite (demo)'), null);
      assert.strictEqual(sanitizeModelForProvider('groq', 'openai/gpt-oss-120b (demo)'), null);
      assert.strictEqual(sanitizeModelForProvider('openrouter', 'openrouter/free (demo)'), null);
      assert.strictEqual(
        sanitizeModelForProvider('cloudflare', '@cf/meta/llama-3.1-8b-instruct (demo)'),
        null
      );

      // Synthetic analyzer labels -> null on outgoing requests
      assert.strictEqual(sanitizeModelForProvider('gemini', 'Document Analyzer'), null);
      assert.strictEqual(sanitizeModelForProvider('webllm', 'Document Analyzer (Local)'), null);
      // Display-only record helper preserves Document Analyzer badge for stored UI display
      assert.strictEqual(
        sanitizeStoredDisplayModel('gemini', 'Document Analyzer'),
        'Document Analyzer'
      );

      // Human-readable UI labels -> null
      assert.strictEqual(sanitizeModelForProvider('gemini', 'Gemini 3.8 Flash'), null);
      assert.strictEqual(sanitizeModelForProvider('groq', 'GPT OSS 120B'), null);
      assert.strictEqual(
        sanitizeModelForProvider('cloudflare', 'Cloudflare Workers AI — Llama 3.1 8B'),
        null
      );

      // Cross-provider mismatches -> null
      assert.strictEqual(sanitizeModelForProvider('gemini', 'openai/gpt-oss-120b'), null);
      assert.strictEqual(sanitizeModelForProvider('gemini', '@cf/meta/llama-3.1-8b-instruct'), null);
      assert.strictEqual(sanitizeModelForProvider('groq', 'gemini-2.5-flash'), null);
      assert.strictEqual(sanitizeModelForProvider('groq', 'openrouter/free'), null);
      assert.strictEqual(sanitizeModelForProvider('openrouter', 'gemini-2.5-flash'), null);
      assert.strictEqual(sanitizeModelForProvider('openrouter', '@cf/meta/llama-3.1-8b-instruct'), null);
      assert.strictEqual(sanitizeModelForProvider('cloudflare', 'openai/gpt-oss-120b'), null);
      assert.strictEqual(sanitizeModelForProvider('webllm', 'qwen2.5:1.5b'), null);

      // Valid provider models preserved (and retired Llama 3.3 migrated on Groq)
      assert.strictEqual(sanitizeModelForProvider('gemini', 'gemini-2.5-flash'), 'gemini-2.5-flash');
      assert.strictEqual(sanitizeModelForProvider('groq', 'openai/gpt-oss-120b'), 'openai/gpt-oss-120b');
      assert.strictEqual(sanitizeModelForProvider('groq', 'llama-3.1-8b-instant'), 'llama-3.1-8b-instant');
      assert.strictEqual(
        sanitizeModelForProvider('groq', 'llama-3.3-70b-versatile'),
        'openai/gpt-oss-120b',
        'Retired Groq Llama 3.3 model should migrate to active Groq default'
      );
      assert.strictEqual(sanitizeModelForProvider('openrouter', 'openrouter/free'), 'openrouter/free');
      assert.strictEqual(
        sanitizeModelForProvider('cloudflare', '@cf/meta/llama-3.1-8b-instruct'),
        '@cf/meta/llama-3.1-8b-instruct'
      );
      assert.strictEqual(
        sanitizeModelForProvider('webllm', 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC'),
        'Qwen2.5-1.5B-Instruct-q4f16_1-MLC'
      );

      // Verify streamAIMessage actually strips dirty model IDs on outgoing /api/chat JSON body
      const mockChat = await startLocalMockServer();
      mockChat.setHandler((_req, res, body) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(
          `data: ${JSON.stringify({
            type: 'done',
            text: 'Sanitized OK',
            modelUsed: 'gemini-3.1-flash-lite-preview',
            provider: body.provider
          })}\n\n`
        );
        res.write('data: [DONE]\n\n');
        res.end();
      });

      try {
        await withRelativeFetchBase(mockChat.baseUrl, async () => {
          await streamAIMessage({
            provider: 'gemini',
            model: 'gemini-3.1-flash-lite (demo)',
            prompt: 'Regenerate test'
          });
          await streamAIMessage({
            provider: 'gemini',
            model: 'openai/gpt-oss-120b',
            prompt: 'Cross provider test'
          });
        });
        assert.strictEqual(mockChat.requests.length, 2);
        assert.strictEqual(mockChat.requests[0].body.model, null);
        assert.strictEqual(mockChat.requests[1].body.model, null);
      } finally {
        await mockChat.close();
      }
    }
  );

  // -------------------------------------------------------------------------
  // 4. Server-side invalid model rejection
  // -------------------------------------------------------------------------
  await runTest(
    '4. Server /api/chat rejects invalid, (demo), synthetic, and cross-provider model IDs with HTTP 400 INVALID_MODEL',
    async () => {
      const invalidCases = [
        { provider: 'gemini', model: 'openai/gpt-oss-120b' },
        { provider: 'gemini', model: 'gemini-3.1-flash-lite (demo)' },
        { provider: 'gemini', model: 'Document Analyzer' },
        { provider: 'groq', model: 'gemini-2.5-flash' },
        { provider: 'openrouter', model: '@cf/meta/llama-3.1-8b-instruct' },
        { provider: 'cloudflare', model: 'openrouter/free' },
        { provider: 'gemini', model: 'bad model with spaces' }
      ];

      for (const tc of invalidCases) {
        const res = await fetch(`${unconfiguredServer.baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider: tc.provider,
            model: tc.model,
            stream: false,
            prompt: 'Validate server model guard'
          })
        });
        assert.strictEqual(
          res.status,
          400,
          `Expected HTTP 400 for (${tc.provider}, ${tc.model}), got ${res.status}`
        );
        const data = await res.json();
        assert.strictEqual(data.status, 'INVALID_MODEL');
        assert.strictEqual(data.errorCode, 'INVALID_MODEL');
        assert.strictEqual(data.retryable, false);
      }

      // Direct unit check on validateServerModelForProvider for null/valid inputs
      assert.deepStrictEqual(validateServerModelForProvider('gemini', null), {
        valid: true,
        model: null
      });
      assert.deepStrictEqual(validateServerModelForProvider('gemini', 'gemini-2.5-flash'), {
        valid: true,
        model: 'gemini-2.5-flash'
      });
    }
  );
} finally {
  await unconfiguredServer.close();
}

// ---------------------------------------------------------------------------
// 5. Non-retryable 503 respected by aiRouter
// ---------------------------------------------------------------------------
await runTest(
  '5. Shared router does NOT retry HTTP 503 when retryable=false or serverRetriesExhausted=true',
  async () => {
    const mockServer = await startLocalMockServer();
    try {
      // 5A: Stopped cloud 503 with retryable: false
      mockServer.setHandler((_req, res) => {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: 'Groq service is unavailable.',
            status: 'UNAVAILABLE',
            provider: 'groq',
            retryable: false,
            canFallback: false
          })
        );
      });

      await withRelativeFetchBase(mockServer.baseUrl, async () => {
        await assert.rejects(
          () => streamAIMessage({ provider: 'groq', prompt: 'Hello cloud' }),
          (err) => {
            assert.strictEqual(err.code, 503);
            assert.strictEqual(err.retryable, false);
            return true;
          }
        );
      });
      assert.strictEqual(
        mockServer.requests.length,
        1,
        'Stopped provider 503 with retryable: false must execute exactly 1 request'
      );

      // 5B: Gemini 503 where server already exhausted its internal retry loop
      mockServer.reset();
      mockServer.setHandler((_req, res) => {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: 'Google Gemini is currently experiencing high demand.',
            status: 'UNAVAILABLE',
            provider: 'gemini',
            retryable: true,
            serverRetriesExhausted: true
          })
        );
      });

      await withRelativeFetchBase(mockServer.baseUrl, async () => {
        await assert.rejects(
          () => streamAIMessage({ provider: 'gemini', prompt: 'Hello Gemini' }),
          (err) => err.code === 503
        );
      });
      assert.strictEqual(
        mockServer.requests.length,
        1,
        'Server-exhausted 503 must not be retried a second time on the client'
      );
    } finally {
      await mockServer.close();
    }
  }
);

// ---------------------------------------------------------------------------
// 6. Transient retryable error bounded retry & cancellation guard
// ---------------------------------------------------------------------------
await runTest(
  '6. Shared router performs bounded 1-retry for genuine retryable=true errors and aborts retry immediately on cancellation',
  async () => {
    const mockServer = await startLocalMockServer();
    try {
      // 6A: Attempt 1 returns 503 retryable: true -> Attempt 2 succeeds
      mockServer.setHandler((_req, res, _body, idx) => {
        if (idx === 0) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: 'Upstream temporarily overloaded',
              status: 'UNAVAILABLE',
              provider: 'groq',
              retryable: true
            })
          );
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(
          `data: ${JSON.stringify({
            type: 'start',
            modelUsed: 'openai/gpt-oss-120b',
            provider: 'groq'
          })}\n\n`
        );
        res.write(`data: ${JSON.stringify({ type: 'chunk', text: 'Recovered on retry!' })}\n\n`);
        res.write(
          `data: ${JSON.stringify({
            type: 'done',
            text: 'Recovered on retry!',
            modelUsed: 'openai/gpt-oss-120b',
            provider: 'groq'
          })}\n\n`
        );
        res.write('data: [DONE]\n\n');
        res.end();
      });

      const result = await withRelativeFetchBase(mockServer.baseUrl, () =>
        streamAIMessage({ provider: 'groq', prompt: 'Transient test' })
      );
      assert.strictEqual(mockServer.requests.length, 2);
      assert.strictEqual(result.text, 'Recovered on retry!');

      // 6B: Cancelled during backoff after Attempt 1 -> Attempt 2 never fires
      mockServer.reset();
      const abortCtrl = new AbortController();
      mockServer.setHandler((_req, res) => {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: 'Upstream temporarily overloaded',
            status: 'UNAVAILABLE',
            provider: 'groq',
            retryable: true
          })
        );
        setTimeout(() => abortCtrl.abort(), 40);
      });

      await withRelativeFetchBase(mockServer.baseUrl, async () => {
        await assert.rejects(
          () =>
            streamAIMessage({
              provider: 'groq',
              prompt: 'Cancel during retry backoff',
              signal: abortCtrl.signal
            }),
          (err) => err.name === 'AbortError'
        );
      });
      await sleep(100);
      assert.strictEqual(
        mockServer.requests.length,
        1,
        'Cancelled request must never dispatch a retry attempt'
      );
    } finally {
      await mockServer.close();
    }
  }
);

// ---------------------------------------------------------------------------
// 7. Attachment preservation on stream continuation — Document / OCR
// ---------------------------------------------------------------------------
await runTest(
  '7. Stream continuation preserves document/OCR extraction metadata at top-level without duplicating in history',
  async () => {
    const mockServer = await startLocalMockServer();
    try {
      mockServer.setHandler((_req, res, _body, idx) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (idx === 0) {
          // Close stream early WITHOUT sending 'done' or '[DONE]'
          res.write(
            `data: ${JSON.stringify({
              type: 'start',
              modelUsed: 'openai/gpt-oss-120b',
              provider: 'groq'
            })}\n\n`
          );
          res.write(`data: ${JSON.stringify({ type: 'chunk', text: 'Part 1: Revenue is ' })}\n\n`);
          res.end();
          return;
        }
        res.write(`data: ${JSON.stringify({ type: 'chunk', text: '$4.8M per Q3 report.' })}\n\n`);
        res.write(
          `data: ${JSON.stringify({
            type: 'done',
            text: '$4.8M per Q3 report.',
            modelUsed: 'openai/gpt-oss-120b',
            provider: 'groq'
          })}\n\n`
        );
        res.write('data: [DONE]\n\n');
        res.end();
      });

      const docAttachment = {
        id: 'att-q3-doc',
        name: 'q3_report.pdf',
        originalName: 'q3_report.pdf',
        type: 'application/pdf',
        size: 18400,
        isImage: false,
        extraction: {
          status: 'ready',
          success: true,
          format: 'PDF',
          text: 'Q3 Financial Summary: Total Revenue reached $4.8M.',
          totalCharacters: 50,
          totalWords: 8
        }
      };

      const finalRes = await withRelativeFetchBase(mockServer.baseUrl, () =>
        streamAIMessage({
          provider: 'groq',
          prompt: 'Summarize Q3 revenue from q3_report.pdf',
          history: [{ sender: 'user', content: 'Earlier turn' }],
          attachments: [docAttachment]
        })
      );

      assert.strictEqual(mockServer.requests.length, 2, 'Expected initial stream + 1 continuation');
      const continuationReq = mockServer.requests[1].body;
      assert.strictEqual(continuationReq.isContinuation, true);
      assert.ok(Array.isArray(continuationReq.attachments));
      assert.strictEqual(continuationReq.attachments.length, 1);
      assert.strictEqual(
        continuationReq.attachments[0].extraction?.text,
        'Q3 Financial Summary: Total Revenue reached $4.8M.'
      );
      assert.strictEqual(continuationReq.attachments[0].base64, undefined);

      // Verify history entries do not duplicate attachment payloads
      for (const hMsg of continuationReq.history) {
        assert.strictEqual(hMsg.attachments, undefined);
      }

      assert.strictEqual(finalRes.text, 'Part 1: Revenue is $4.8M per Q3 report.');
    } finally {
      await mockServer.close();
    }
  }
);

// ---------------------------------------------------------------------------
// 8. Attachment preservation on stream continuation — Gemini Vision Image
// ---------------------------------------------------------------------------
await runTest(
  '8. Stream continuation for Gemini vision preserves canonical image base64 within payload limits without duplication',
  async () => {
    const imgId = 'att-phase4b-vision-cont';
    await saveAttachmentBlob(imgId, new Blob([VALID_PNG_BYTES], { type: 'image/png' }), {
      name: 'diagram.png',
      type: 'image/png',
      size: VALID_PNG_BYTES.length,
      isImage: true
    });

    const mockServer = await startLocalMockServer();
    try {
      mockServer.setHandler((_req, res, _body, idx) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (idx === 0) {
          res.write(
            `data: ${JSON.stringify({
              type: 'start',
              modelUsed: 'gemini-3.1-flash-lite-preview',
              provider: 'gemini'
            })}\n\n`
          );
          res.write(`data: ${JSON.stringify({ type: 'chunk', text: 'Diagram shows ' })}\n\n`);
          res.end();
          return;
        }
        res.write(`data: ${JSON.stringify({ type: 'chunk', text: 'three connected services.' })}\n\n`);
        res.write(
          `data: ${JSON.stringify({
            type: 'done',
            text: 'three connected services.',
            modelUsed: 'gemini-3.1-flash-lite-preview',
            provider: 'gemini'
          })}\n\n`
        );
        res.write('data: [DONE]\n\n');
        res.end();
      });

      // Pass a stored-style attachment (without base64) to prove continuation hydrates/preserves from IndexedDB
      const storedStyleImageAtt = {
        id: imgId,
        name: 'diagram.png',
        originalName: 'diagram.png',
        type: 'image/png',
        size: VALID_PNG_BYTES.length,
        isImage: true,
        extraction: {
          status: 'NO_TEXT_DETECTED',
          isImage: true,
          hasText: false,
          text: ''
        }
      };

      const finalRes = await withRelativeFetchBase(mockServer.baseUrl, () =>
        streamAIMessage({
          provider: 'gemini',
          prompt: 'Describe diagram.png in detail',
          attachments: [storedStyleImageAtt]
        })
      );

      assert.strictEqual(mockServer.requests.length, 2);
      const contBody = mockServer.requests[1].body;
      const contRawBytes = Buffer.byteLength(JSON.stringify(contBody), 'utf8');
      assert.ok(contRawBytes <= MAX_CHAT_REQUEST_BYTES);

      assert.strictEqual(contBody.isContinuation, true);
      assert.strictEqual(contBody.attachments.length, 1);
      const contImg = contBody.attachments[0];
      assert.strictEqual(contImg.mimeType, 'image/png');
      assert.strictEqual(contImg.dataUrl, undefined, 'Must not duplicate base64 into dataUrl');
      const decodedBytes = Buffer.from(contImg.base64, 'base64');
      assert.ok(decodedBytes.length <= MAX_VISION_IMAGE_BYTES);
      assert.deepStrictEqual(decodedBytes, VALID_PNG_BYTES);

      for (const hMsg of contBody.history) {
        assert.strictEqual(hMsg.attachments, undefined);
      }
      assert.strictEqual(finalRes.text, 'Diagram shows three connected services.');
    } finally {
      await mockServer.close();
    }
  }
);

// ---------------------------------------------------------------------------
// 9. Obsolete client fallback removal
// ---------------------------------------------------------------------------
await runTest(
  '9. Obsolete direct client fallback path and duplicate standalone provider services are removed from aiRouter',
  async () => {
    const routerSrc = fs.readFileSync(
      path.join(ROOT_DIR, 'src/services/aiRouter.js'),
      'utf8'
    );
    assert.ok(!routerSrc.includes('geminiService'));
    assert.ok(!routerSrc.includes('groqService'));
    assert.ok(!routerSrc.includes('openrouterService'));
    assert.strictEqual(fs.existsSync(path.join(ROOT_DIR, 'src/services/geminiService.js')), false);
    assert.strictEqual(fs.existsSync(path.join(ROOT_DIR, 'src/services/groqService.js')), false);
    assert.strictEqual(fs.existsSync(path.join(ROOT_DIR, 'src/services/openrouterService.js')), false);

    const outboundUrls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      outboundUrls.push(String(input));
      throw new TypeError('Failed to fetch');
    };
    try {
      await assert.rejects(
        () =>
          streamAIMessage({
            provider: 'gemini',
            prompt: 'Should fail cleanly',
            retryBaseDelayMs: 5
          }),
        (err) => {
          assert.strictEqual(err.isNetworkError, true);
          return true;
        }
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.deepStrictEqual(
      outboundUrls,
      ['/api/chat', '/api/chat'],
      'Failed /api/chat fetch must perform at most 1 bounded retry to /api/chat and NEVER fall back to direct browser provider endpoints'
    );
  }
);

// ---------------------------------------------------------------------------
// 10. Offline guards across all 6 chat actions
// ---------------------------------------------------------------------------
await runTest(
  '10. Offline guards block cloud providers across all 6 chat actions before mutating state while permitting WebLLM',
  async () => {
    // 10A: Unit verification across all providers online vs offline
    for (const cloudProv of ['gemini', 'groq', 'openrouter', 'cloudflare']) {
      const offlineRes = evaluateOfflineProviderGuard({ provider: cloudProv, isOnline: false });
      assert.strictEqual(offlineRes.allowed, false);
      assert.strictEqual(offlineRes.code, 'OFFLINE_CLOUD_PROVIDER');
      assert.ok(offlineRes.message.includes('requires an internet connection'));

      const onlineRes = evaluateOfflineProviderGuard({ provider: cloudProv, isOnline: true });
      assert.strictEqual(onlineRes.allowed, true);
    }

    for (const localProv of ['webllm']) {
      const offlineLocal = evaluateOfflineProviderGuard({ provider: localProv, isOnline: false });
      assert.strictEqual(offlineLocal.allowed, true);
    }

    // 10B: State preservation simulation mirroring all 6 ChatPage actions when offline
    const initialUser = { id: 'u-1', sender: 'user', content: 'Original question' };
    const initialAssistant = normalizeAssistantMessage(
      {
        id: 'a-1',
        sender: 'assistant',
        parentMessageId: 'u-1',
        provider: 'gemini',
        modelUsed: 'gemini-3.1-flash-lite-preview',
        content: 'Existing preserved answer'
      },
      initialUser
    );
    const downstreamUser = { id: 'u-2', sender: 'user', content: 'Follow-up question' };
    const downstreamFailed = {
      id: 'a-2-err',
      sender: 'assistant',
      isError: true,
      provider: 'groq',
      failedProvider: 'groq',
      failedPrompt: 'Follow-up question',
      content: 'Previous error card'
    };

    let messages = [initialUser, initialAssistant, downstreamUser, downstreamFailed];
    let editingMessageId = 'u-1';
    let isLoading = false;
    let persistenceError = null;
    let networkCalls = 0;

    const guardOffline = (targetProvider, isOnline) => {
      const g = evaluateOfflineProviderGuard({ provider: targetProvider, isOnline });
      if (!g.allowed) {
        persistenceError = g.message;
        return false;
      }
      return true;
    };

    const snapshotBefore = structuredClone(messages);

    // 1) handleSubmit offline with cloud provider
    if (guardOffline('gemini', false)) {
      isLoading = true;
      networkCalls++;
    }
    assert.strictEqual(isLoading, false);
    assert.deepStrictEqual(messages, snapshotBefore);
    assert.ok(persistenceError.includes('Google Gemini'));

    // 2) handleRetry offline with cloud provider -> failed card preserved
    if (guardOffline(downstreamFailed.failedProvider, false)) {
      messages = messages.filter((m) => m.id !== downstreamFailed.id);
      networkCalls++;
    }
    assert.deepStrictEqual(messages, snapshotBefore);

    // 3) handleSwitchProviderAndRetry offline to cloud provider -> failed card preserved
    if (guardOffline('openrouter', false)) {
      messages = messages.filter((m) => m.id !== downstreamFailed.id);
      networkCalls++;
    }
    assert.deepStrictEqual(messages, snapshotBefore);

    // 4) handleRegenerate offline on cloud response -> existing response text preserved
    if (guardOffline(initialAssistant.provider, false)) {
      messages = messages.map((m) => (m.id === 'a-1' ? { ...m, content: '', isStreaming: true } : m));
      networkCalls++;
    }
    assert.strictEqual(messages[1].content, 'Existing preserved answer');

    // 5) handleGenerateAlternative offline with cloud provider -> no empty streaming alternative added
    if (guardOffline('cloudflare', false)) {
      messages = messages.map((m) =>
        m.id === 'a-1'
          ? addAlternativeToAssistantMessage(
              m,
              createAlternativeRecord({ provider: 'cloudflare', content: '', isStreaming: true })
            )
          : m
      );
      networkCalls++;
    }
    assert.strictEqual(messages[1].alternatives.length, 1);

    // 6) handleEditResend offline with cloud provider -> inline editor stays open & downstream messages are NOT truncated
    if (guardOffline('gemini', false)) {
      editingMessageId = null;
      messages = messages.slice(0, 1);
      networkCalls++;
    }
    assert.strictEqual(editingMessageId, 'u-1');
    assert.strictEqual(messages.length, 4, 'Downstream messages must NOT be truncated when offline');
    assert.strictEqual(networkCalls, 0);

    // Verify all 6 handlers in src/pages/ChatPage.jsx invoke guardOfflineProviderAction before setLoadingAndSubmitting(true)
    const chatPageSrc = fs.readFileSync(
      path.join(ROOT_DIR, 'src/pages/ChatPage.jsx'),
      'utf8'
    );
    const handlerNames = [
      'const handleSubmit =',
      'const handleRetry =',
      'const handleSwitchProviderAndRetry =',
      'const handleRegenerate =',
      'const handleGenerateAlternative =',
      'const handleEditResend ='
    ];
    for (const hName of handlerNames) {
      const startIdx = chatPageSrc.indexOf(hName);
      assert.ok(startIdx !== -1, `Expected ${hName} in ChatPage.jsx`);
      const nextChunk = chatPageSrc.slice(startIdx, startIdx + 4500);
      const guardPos = nextChunk.indexOf('guardOfflineProviderAction(');
      const loadingPos = nextChunk.indexOf('setLoadingAndSubmitting(true)');
      assert.ok(guardPos !== -1, `${hName} must call guardOfflineProviderAction`);
      assert.ok(loadingPos !== -1, `${hName} must call setLoadingAndSubmitting(true)`);
      assert.ok(
        guardPos < loadingPos,
        `${hName} must check guardOfflineProviderAction BEFORE setLoadingAndSubmitting(true)`
      );
    }
  }
);

// ---------------------------------------------------------------------------
// 11. Server upstream cancellation on client disconnect
// ---------------------------------------------------------------------------
await runTest(
  '11. Client abort/disconnect on /api/chat immediately aborts server outbound upstream request and skips secondary fallback',
  async () => {
    let upstreamOpenedResolve;
    const upstreamOpened = new Promise((r) => {
      upstreamOpenedResolve = r;
    });
    let upstreamClosedResolve;
    const upstreamClosed = new Promise((r) => {
      upstreamClosedResolve = r;
    });

    const mockUpstream = await startLocalMockServer();
    mockUpstream.setHandler((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(
        `data: ${JSON.stringify({
          model: 'openai/gpt-oss-120b',
          choices: [{ delta: { content: 'First token ' } }]
        })}\n\n`
      );
      upstreamOpenedResolve();
      req.on('close', () => {
        upstreamClosedResolve();
      });
      // Keep upstream open until aborted by server.ts
    });

    const appServer = await startEphemeralAppServer({
      ORVIX_GROQ_BASE_URL: mockUpstream.baseUrl,
      GROQ_API_KEY: 'gsk_mock_test_key_valid_12345',
      ORVIX_UPSTREAM_HEADERS_TIMEOUT_MS: '5000'
    });

    try {
      const clientAbort = new AbortController();
      const fetchPromise = fetch(`${appServer.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'groq',
          model: 'openai/gpt-oss-120b',
          stream: true,
          prompt: 'Stream until client disconnects'
        }),
        signal: clientAbort.signal
      }).catch((err) => err);

      await upstreamOpened;
      // Read first SSE chunk then abort client connection
      clientAbort.abort();
      await fetchPromise;

      const closedFast = await Promise.race([
        upstreamClosed.then(() => true),
        sleep(1500).then(() => false)
      ]);
      assert.strictEqual(
        closedFast,
        true,
        'Server outbound upstream connection must close promptly when client disconnects'
      );

      await sleep(100);
      assert.strictEqual(
        mockUpstream.requests.length,
        1,
        'Disconnected request must NOT trigger secondary stream=false fallback request'
      );
    } finally {
      await appServer.close();
      await mockUpstream.close();
    }
  }
);

// ---------------------------------------------------------------------------
// 12. Server upstream header timeout (without cutting off active SSE streams)
// ---------------------------------------------------------------------------
await runTest(
  '12. Stalled upstream before headers returns HTTP 504 DEADLINE_EXCEEDED, while active SSE streams continue past header timeout',
  async () => {
    let mode = 'stall_headers';
    let stalledReqClosed = false;

    const mockUpstream = await startLocalMockServer();
    mockUpstream.setHandler(async (req, res) => {
      if (mode === 'stall_headers') {
        req.on('close', () => {
          stalledReqClosed = true;
        });
        // Intentionally never write headers
        return;
      }

      // Active stream mode: send headers right away, then stream slower than 250ms header timeout
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(
        `data: ${JSON.stringify({
          model: 'openai/gpt-oss-120b',
          choices: [{ delta: { content: 'Chunk A ' } }]
        })}\n\n`
      );
      await sleep(180);
      res.write(
        `data: ${JSON.stringify({
          model: 'openai/gpt-oss-120b',
          choices: [{ delta: { content: 'Chunk B ' } }]
        })}\n\n`
      );
      await sleep(180);
      res.write(
        `data: ${JSON.stringify({
          model: 'openai/gpt-oss-120b',
          choices: [{ delta: { content: 'Chunk C' } }]
        })}\n\n`
      );
      res.write('data: [DONE]\n\n');
      res.end();
    });

    const appServer = await startEphemeralAppServer({
      ORVIX_GROQ_BASE_URL: mockUpstream.baseUrl,
      GROQ_API_KEY: 'gsk_mock_test_key_valid_12345',
      ORVIX_UPSTREAM_HEADERS_TIMEOUT_MS: '250'
    });

    try {
      // 12A: Stalled upstream before headers -> 504 DEADLINE_EXCEEDED
      const stallRes = await fetch(`${appServer.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'groq',
          model: 'openai/gpt-oss-120b',
          stream: true,
          prompt: 'Trigger header timeout'
        })
      });

      assert.strictEqual(stallRes.status, 504, `Expected HTTP 504, got ${stallRes.status}`);
      const stallData = await stallRes.json();
      assert.strictEqual(stallData.status, 'DEADLINE_EXCEEDED');
      assert.strictEqual(stallData.retryable, true, 'Upstream header timeout sets retryable=true');
      await sleep(80);
      assert.strictEqual(stalledReqClosed, true, 'Timed-out upstream socket must be aborted');
      assert.strictEqual(
        mockUpstream.requests.length,
        1,
        'Header timeout must not trigger secondary non-streaming request'
      );

      // 12B: Active SSE stream (~360ms total > 250ms header timeout) completes cleanly once headers arrive
      mode = 'active_stream';
      mockUpstream.reset();
      const streamResult = await withRelativeFetchBase(appServer.baseUrl, () =>
        streamAIMessage({
          provider: 'groq',
          model: 'openai/gpt-oss-120b',
          prompt: 'Long active stream after fast headers'
        })
      );
      assert.strictEqual(streamResult.text, 'Chunk A Chunk B Chunk C');
      assert.strictEqual(mockUpstream.requests.length, 1);
    } finally {
      await appServer.close();
      await mockUpstream.close();
    }
  }
);

console.log(`\n=== Phase 4B Complete: ${passed} Passed, ${failed} Failed ===\n`);

if (failed > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
