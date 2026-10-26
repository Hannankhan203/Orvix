/**
 * Orvix AI Provider Authentication Regression Test Suite
 *
 * Verifies the fix for the regression where mounting `app.use('/api', mongoApiRouter)`
 * with an unscoped `router.use(requireAuth)` intercepted every `/api/*` route
 * mounted below it (`/api/chat`, `/api/upload/*`, `/api/transcribe`), causing
 * `streamAIMessage` in `src/services/aiRouter.js` to fail across ALL AI providers
 * with HTTP 401 ("Invalid or unauthorized API key. Please check your configuration.").
 *
 * Covers:
 * 1. Real HTTP requests to `/api/chat` across all server-routed providers
 *    (`gemini`, `groq`, `openrouter`, `cloudflare`, `ollama`) without Bearer tokens
 *    never return `AUTH_TOKEN_MISSING` or `AUTH_SERVICE_UNCONFIGURED`.
 * 2. End-to-end `streamAIMessage` (`src/services/aiRouter.js`) streaming over SSE
 *    against the Express server works without Firebase Bearer tokens (preserving
 *    both guest and signed-in AI chat flows).
 * 3. `/api/upload/config` and `/api/transcribe` (and Vercel serverless wrappers)
 *    are not blocked by `mongoApiRouter`'s `requireAuth`.
 * 4. Every MongoDB user-data route (`/api/users*`, `/api/conversations*`,
 *    `/api/messages*`, `/api/user-settings*`) STILL strictly enforces `requireAuth`
 *    and rejects unauthenticated requests with HTTP 401 `AUTH_TOKEN_MISSING`.
 *
 * Usage:
 *   npm run test:ai-regression
 */

process.env.TESTING = 'true';

import http from 'http';
import { app } from '../server.ts';
import chatServerlessHandler from '../api/chat.ts';
import uploadServerlessHandler from '../api/upload.ts';
import transcribeServerlessHandler from '../api/transcribe.ts';
// @ts-ignore - JS module
import { streamAIMessage } from '../src/services/aiRouter.js';

let passed = 0;
let failed = 0;

function assert(name: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

async function run() {
  console.log('==============================================================');
  console.log('  Orvix AI Provider Auth Regression Verification Suite        ');
  console.log('==============================================================\n');

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  // Save original env keys so we can safely restore after deterministic offline/demo sub-test
  const savedEnv = {
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    VITE_GEMINI_API_KEY: process.env.VITE_GEMINI_API_KEY,
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    VITE_GROQ_API_KEY: process.env.VITE_GROQ_API_KEY,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    VITE_OPENROUTER_API_KEY: process.env.VITE_OPENROUTER_API_KEY,
    CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
    CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN
  };

  const originalFetch = globalThis.fetch;

  try {
    // -------------------------------------------------------------------------
    // 1. Verify /api/chat is NEVER blocked by Firebase/Mongo requireAuth
    // -------------------------------------------------------------------------
    console.log('--- [1/4] Verifying /api/chat Pass-Through Across All Providers ---');

    const validationRes = await originalFetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'gemini' }) // missing prompt
    });
    const validationJson: any = await validationRes.json();
    assert(
      'POST /api/chat without Authorization header reaches /api/chat validation (HTTP 400, not 401)',
      validationRes.status === 400 && validationJson?.error === 'Prompt is required.',
      `got status=${validationRes.status} code=${validationJson?.code}`
    );

    // Temporarily clear provider keys in-memory ONLY to deterministically test server dispatch
    // for every provider without making external network calls or leaking credentials.
    process.env.GEMINI_API_KEY = '';
    process.env.VITE_GEMINI_API_KEY = '';
    process.env.GROQ_API_KEY = '';
    process.env.VITE_GROQ_API_KEY = '';
    process.env.OPENROUTER_API_KEY = '';
    process.env.VITE_OPENROUTER_API_KEY = '';
    process.env.CLOUDFLARE_ACCOUNT_ID = '';
    process.env.CLOUDFLARE_API_TOKEN = '';

    for (const provider of ['gemini', 'groq', 'openrouter', 'cloudflare']) {
      const res = await originalFetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream'
        },
        body: JSON.stringify({
          provider,
          prompt: 'Verify provider routing reaches /api/chat',
          stream: true
        })
      });
      const bodyText = await res.text();
      const hasMongoAuthError =
        bodyText.includes('AUTH_TOKEN_MISSING') ||
        bodyText.includes('AUTH_SERVICE_UNCONFIGURED') ||
        bodyText.includes('Missing Authorization header');

      assert(
        `POST /api/chat (${provider}) is not intercepted by MongoDB requireAuth`,
        !hasMongoAuthError && res.status !== 401,
        `got status=${res.status}`
      );
    }

    // -------------------------------------------------------------------------
    // 2. End-to-End streamAIMessage (src/services/aiRouter.js) SSE Streaming
    // -------------------------------------------------------------------------
    console.log('\n--- [2/4] Verifying streamAIMessage (aiRouter.js) SSE Flow ---');

    // Route relative `/api/...` fetch calls from aiRouter.js to our test server
    globalThis.fetch = ((input: any, init?: any) => {
      if (typeof input === 'string' && input.startsWith('/')) {
        return originalFetch(`${baseUrl}${input}`, init);
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    const streamedChunks: string[] = [];
    const streamResult = await streamAIMessage({
      provider: 'gemini',
      mode: 'general',
      prompt: 'Hello Orvix!',
      history: [],
      onStart: undefined,
      onChunk: (delta: string) => {
        streamedChunks.push(delta);
      },
      signal: undefined
    });

    assert(
      'streamAIMessage streams SSE chunks without throwing 401 Unauthorized',
      typeof streamResult?.text === 'string' && streamResult.text.length > 0 && streamedChunks.length > 0,
      `got textLen=${streamResult?.text?.length ?? 0} chunks=${streamedChunks.length}`
    );

    // Restore original environment variables immediately after deterministic routing check
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }

    // -------------------------------------------------------------------------
    // 3. Verify /api/upload, /api/transcribe & Serverless Wrappers Pass Through
    // -------------------------------------------------------------------------
    console.log('\n--- [3/4] Verifying /api/upload, /api/transcribe & Serverless Handlers ---');

    const uploadCfgRes = await originalFetch(`${baseUrl}/api/upload/config`);
    const uploadCfgJson: any = await uploadCfgRes.json();
    assert(
      'GET /api/upload/config returns HTTP 200 without Authorization header',
      uploadCfgRes.status === 200 && typeof uploadCfgJson?.maxFileSizeBytes === 'number',
      `got status=${uploadCfgRes.status}`
    );

    const transcribeRes = await originalFetch(`${baseUrl}/api/transcribe`, {
      method: 'POST'
    });
    const transcribeJson: any = await transcribeRes.json();
    assert(
      'POST /api/transcribe reaches transcription handler (HTTP 400 NO_AUDIO_DATA, not 401 AUTH_TOKEN_MISSING)',
      transcribeRes.status === 400 && transcribeJson?.code === 'NO_AUDIO_DATA',
      `got status=${transcribeRes.status} code=${transcribeJson?.code}`
    );

    // Verify Vercel serverless entrypoints (api/chat.ts, api/upload.ts, api/transcribe.ts)
    const serverlessServer = http.createServer((req: any, res: any) => {
      if (req.url?.startsWith('/api/upload')) return uploadServerlessHandler(req, res);
      if (req.url?.startsWith('/api/transcribe')) return transcribeServerlessHandler(req, res);
      return chatServerlessHandler(req, res);
    });
    await new Promise<void>((resolve) => serverlessServer.listen(0, '127.0.0.1', () => resolve()));
    const slAddr = serverlessServer.address() as { port: number };
    const slBase = `http://127.0.0.1:${slAddr.port}`;

    try {
      const slChat = await originalFetch(`${slBase}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'gemini' })
      });
      assert(
        'Serverless api/chat.ts reaches /api/chat handler (HTTP 400 validation, not 401)',
        slChat.status === 400
      );

      const slUpload = await originalFetch(`${slBase}/api/upload/config`);
      assert('Serverless api/upload.ts GET /api/upload/config returns HTTP 200', slUpload.status === 200);
    } finally {
      await new Promise<void>((resolve) => serverlessServer.close(() => resolve()));
    }

    // -------------------------------------------------------------------------
    // 4. Verify MongoDB User-Data Endpoints Still Strictly Enforce requireAuth
    // -------------------------------------------------------------------------
    console.log('\n--- [4/4] Verifying Strict Auth Boundary on All MongoDB User-Data Routes ---');

    const protectedEndpoints: Array<{ method: string; path: string }> = [
      { method: 'GET', path: '/api/users/me' },
      { method: 'PUT', path: '/api/users/me' },
      { method: 'POST', path: '/api/users' },
      { method: 'GET', path: '/api/users/some-user-id' },
      { method: 'GET', path: '/api/conversations' },
      { method: 'POST', path: '/api/conversations' },
      { method: 'GET', path: '/api/conversations/conv-12345' },
      { method: 'PATCH', path: '/api/conversations/conv-12345' },
      { method: 'DELETE', path: '/api/conversations/conv-12345' },
      { method: 'GET', path: '/api/messages?conversationId=conv-12345' },
      { method: 'POST', path: '/api/messages' },
      { method: 'DELETE', path: '/api/messages?conversationId=conv-12345&messageIds=msg-1' },
      { method: 'GET', path: '/api/messages/msg-12345' },
      { method: 'PATCH', path: '/api/messages/msg-12345' },
      { method: 'DELETE', path: '/api/messages/msg-12345' },
      { method: 'GET', path: '/api/user-settings' },
      { method: 'GET', path: '/api/user-settings/me' },
      { method: 'POST', path: '/api/user-settings/me' },
      { method: 'GET', path: '/api/user-settings/some-user-id' }
    ];

    for (const ep of protectedEndpoints) {
      const res = await originalFetch(`${baseUrl}${ep.path}`, {
        method: ep.method,
        headers: { 'Content-Type': 'application/json' },
        body: ep.method === 'GET' || ep.method === 'DELETE' ? undefined : JSON.stringify({})
      });
      const json: any = await res.json();
      assert(
        `${ep.method} ${ep.path} without token returns HTTP 401 AUTH_TOKEN_MISSING`,
        res.status === 401 && json?.code === 'AUTH_TOKEN_MISSING',
        `got status=${res.status} code=${json?.code}`
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  console.log('\n==============================================================');
  console.log(`  AI Auth Regression Suite: ${passed} passed, ${failed} failed`);
  console.log('==============================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('Fatal error in AI provider auth regression test:', err);
  process.exit(1);
});
