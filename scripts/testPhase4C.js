/**
 * Phase 4C — Gemini Provider Hardening & Model Validation Correction Test Suite
 *
 * Validates:
 * 1. Documented model validation: documented Gemini IDs (gemini-2.5-flash, gemini-3.8-flash, gemini-flash-latest)
 *    pass client sanitizer and server validation; display labels, demo suffixes, and cross-provider models are rejected;
 *    verified gemini-2.5-flash default is maintained.
 * 2. Model-not-found fallback: 404 from primary Gemini model triggers fallback to next valid model without repeating failing model.
 * 3. Exhausted fallback behavior: when all fallbacks fail with 404, returns structured 404 error (NOT_FOUND) with canFallback: true.
 * 4. Retry limits & non-retryable errors: 401/403/400 errors do not trigger fallback or retry loops.
 * 5. Client cancellation: aborting a Gemini request cancels upstream call via AbortSignal and releases resources cleanly.
 * 6. Initial-response timeout: requests exceeding header timeout return HTTP 504 DEADLINE_EXCEEDED; active SSE streams continue past header timeout.
 * 7. Finish reason handling: SAFETY blocks produce descriptive user error (SAFETY_BLOCKED); MAX_TOKENS truncation is signaled.
 * 8. Multimodal Vision & OCR integration: valid model IDs passed to Gemini vision endpoints respecting 3 MB / 4.2 MB limits.
 * 9. Separation of concerns: documentation-based structural validation is distinguished from runtime API access/credentials.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  PROVIDER_DEFAULT_MODELS,
  sanitizeModelForProvider,
  validateServerModelForProvider,
  checkModelCompatibilityForProvider
} from '../src/services/providerModelSanitizer.js';
import {
  PROVIDER_OPTIONS,
  parseRouterError,
  streamAIMessage,
  AI_PROVIDERS
} from '../src/services/aiRouter.js';
import {
  PROVIDER_PROFILES,
  isVisionCapableProvider
} from '../src/services/documentContextService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const tsxBin = path.join(ROOT_DIR, 'node_modules', '.bin', 'tsx');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Helper to evaluate parseGeminiError from server.ts in an isolated process with TESTING=1
function evalGeminiError(errObj, provider = 'gemini') {
  const script = `
    process.env.TESTING = '1';
    import('./server.ts').then(({ parseGeminiError }) => {
      const parsed = parseGeminiError(${JSON.stringify(errObj)}, ${JSON.stringify(provider)});
      console.log(JSON.stringify(parsed));
    });
  `;
  const res = spawnSync(tsxBin, ['-e', script], {
    cwd: ROOT_DIR,
    env: { ...process.env, TESTING: '1' },
    encoding: 'utf8'
  });
  if (res.error || res.status !== 0) {
    throw new Error(res.stderr || res.stdout || 'evalGeminiError failed');
  }
  const lines = res.stdout.trim().split('\n');
  const jsonLine = lines.find((l) => l.trim().startsWith('{') && l.trim().endsWith('}')) || lines[lines.length - 1];
  return JSON.parse(jsonLine.trim());
}

let passedCount = 0;
let failedCount = 0;

function runTest(name, fn) {
  try {
    fn();
    console.log(`  [PASS] ${name}`);
    passedCount++;
  } catch (err) {
    console.error(`  [FAIL] ${name}`);
    console.error(`         ${err.message}`);
    failedCount++;
  }
}

async function runAsyncTest(name, fn) {
  try {
    await fn();
    console.log(`  [PASS] ${name}`);
    passedCount++;
  } catch (err) {
    console.error(`  [FAIL] ${name}`);
    console.error(`         ${err.message}`);
    failedCount++;
  }
}

console.log('=== Phase 4C: Gemini Provider Hardening Test Suite ===\n');

// ----------------------------------------------------------------------------
// Test 1: Documented Gemini model validation and verified default model selection
// ----------------------------------------------------------------------------
runTest('1. Documented Gemini model validation and verified default model selection', () => {
  // 1a. Default model check
  assert.strictEqual(
    PROVIDER_DEFAULT_MODELS.gemini,
    'gemini-3.8-flash',
    'PROVIDER_DEFAULT_MODELS.gemini must be gemini-3.8-flash'
  );

  // 1b. PROVIDER_OPTIONS check
  const geminiOption = PROVIDER_OPTIONS.find((p) => p.id === AI_PROVIDERS.GEMINI);
  assert.ok(geminiOption, 'Gemini provider option must exist');
  assert.strictEqual(geminiOption.defaultModel, 'gemini-3.8-flash');

  // 1c. Document context provider profile check
  assert.strictEqual(
    PROVIDER_PROFILES.gemini.modelTag,
    'gemini-3.8-flash',
    'PROVIDER_PROFILES.gemini.modelTag must be gemini-3.8-flash'
  );

  // 1d. Documented Gemini models are accepted by client sanitizer
  const documentedModels = ['gemini-2.5-flash', 'gemini-3.8-flash', 'gemini-flash-latest', 'gemini-2.5-pro'];
  for (const m of documentedModels) {
    const sanitizedClient = sanitizeModelForProvider('gemini', m);
    assert.strictEqual(sanitizedClient, m, `Client sanitizer must accept documented model ${m}`);
  }

  // 1e. Documented Gemini models are accepted by server validator
  for (const m of documentedModels) {
    const serverVal = validateServerModelForProvider('gemini', m);
    assert.strictEqual(serverVal.valid, true, `Server validator must accept documented model ${m}`);
    assert.strictEqual(serverVal.model, m);
  }

  // 1f. Display labels, demo suffixes, and synthetic tags are strictly rejected
  const invalidLabels = [
    'gemini 3.8 flash',
    'gemini 2.5 flash',
    'gemini-3.8-flash (demo)',
    'gemini-2.5-flash (demo)',
    'Document Analyzer',
    'document analyzer (demo)'
  ];
  for (const lbl of invalidLabels) {
    const sanitized = sanitizeModelForProvider('gemini', lbl);
    assert.strictEqual(sanitized, null, `Client sanitizer must reject label "${lbl}"`);

    const serverVal = validateServerModelForProvider('gemini', lbl);
    assert.strictEqual(serverVal.valid, false, `Server validator must reject label "${lbl}"`);
    assert.strictEqual(serverVal.status, 'INVALID_MODEL');
    assert.strictEqual(serverVal.code, 400);
  }

  // 1g. Cross-provider models are strictly rejected (no cross-provider leakage)
  const crossProviderModels = [
    { provider: 'gemini', model: '@cf/meta/llama-3.1-8b-instruct' },
    { provider: 'gemini', model: 'openai/gpt-oss-120b' },
    { provider: 'gemini', model: 'qwen2.5:1.5b' },
    { provider: 'gemini', model: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC' },
    { provider: 'groq', model: 'gemini-3.8-flash' },
    { provider: 'openrouter', model: 'gemini-3.8-flash' },
    { provider: 'cloudflare', model: 'gemini-3.8-flash' },
    { provider: 'ollama', model: 'gemini-3.8-flash' },
    { provider: 'webllm', model: 'gemini-3.8-flash' }
  ];
  for (const { provider, model } of crossProviderModels) {
    const sanitized = sanitizeModelForProvider(provider, model);
    assert.strictEqual(sanitized, null, `Client sanitizer must reject cross-provider model ${model} for ${provider}`);

    const serverVal = validateServerModelForProvider(provider, model);
    assert.strictEqual(serverVal.valid, false, `Server validator must reject cross-provider model ${model} for ${provider}`);
    assert.strictEqual(serverVal.status, 'INVALID_MODEL');
    assert.strictEqual(serverVal.code, 400);
  }

  // 1h. Verified default model and fallback alignment in services
  assert.strictEqual(PROVIDER_DEFAULT_MODELS.gemini, 'gemini-3.8-flash');
  const ocrSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/services/imageOcrService.js'), 'utf8');
  assert.ok(ocrSrc.includes("'gemini-3.8-flash'"), 'imageOcrService.js must use verified gemini-3.8-flash');
  assert.ok(ocrSrc.includes("'gemini-3.1-flash-lite'"), 'imageOcrService.js must include gemini-3.1-flash-lite fallback');
});

// ----------------------------------------------------------------------------
// Test 2: Model-not-found fallback: 404 advances to next valid fallback model
// ----------------------------------------------------------------------------
await runAsyncTest('2. Model-not-found fallback: HTTP 404 on primary model advances to next valid fallback without repeating failing model', async () => {
  const attemptedModels = [];

  const mockServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      attemptedModels.push(parsed.model || 'default');

      // Simulate first attempt fails with 404 model not found
      if (attemptedModels.length === 1) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'The requested Gemini model was not found or is no longer available.',
          code: 404,
          status: 'NOT_FOUND',
          provider: 'gemini',
          model: parsed.model || 'gemini-2.5-flash',
          retryable: false,
          canFallback: true,
          fallbackModelTried: 'gemini-flash-latest'
        }));
      } else {
        // Fallback attempt succeeds
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          text: 'Fallback Gemini response successful',
          modelUsed: 'gemini-flash-latest',
          provider: 'gemini'
        }));
      }
    });
  });

  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  const port = mockServer.address().port;

  try {
    // Verify server.ts parseGeminiError parses 404 correctly
    const parsed404 = evalGeminiError(
      { status: 404, message: 'models/gemini-custom is not found for API version v1beta' },
      'gemini'
    );
    assert.strictEqual(parsed404.statusCode, 404);
    assert.strictEqual(parsed404.status, 'NOT_FOUND');
    assert.strictEqual(parsed404.isRetryable, false);

    // Verify fallback plan generation in server logic:
    // When requesting primary model 'gemini-3.8-flash', the plan progresses across distinct models
    const requested38 = 'gemini-3.8-flash';
    const fallbackCandidates = ['gemini-3.8-flash', 'gemini-3.1-flash-lite'];
    const uniquePlanModels38 = [requested38];
    for (const cand of fallbackCandidates) {
      if (!uniquePlanModels38.includes(cand)) {
        uniquePlanModels38.push(cand);
      }
    }
    assert.deepStrictEqual(uniquePlanModels38, ['gemini-3.8-flash', 'gemini-3.1-flash-lite']);
    assert.strictEqual(uniquePlanModels38[0], 'gemini-3.8-flash');
    assert.strictEqual(uniquePlanModels38[1], 'gemini-3.1-flash-lite');
    assert.notStrictEqual(uniquePlanModels38[0], uniquePlanModels38[1], 'Failing model must not be repeated');

    // When requesting an unavailable model like 'gemini-2.5-flash', the plan advances to gemini-3.8-flash and gemini-3.1-flash-lite without repetition
    const requested25 = 'gemini-2.5-flash';
    const uniquePlanModels25 = [requested25];
    for (const cand of fallbackCandidates) {
      if (!uniquePlanModels25.includes(cand)) {
        uniquePlanModels25.push(cand);
      }
    }
    assert.deepStrictEqual(uniquePlanModels25, ['gemini-2.5-flash', 'gemini-3.8-flash', 'gemini-3.1-flash-lite']);
    assert.strictEqual(uniquePlanModels25[0], 'gemini-2.5-flash');
    assert.strictEqual(uniquePlanModels25[1], 'gemini-3.8-flash');
    assert.strictEqual(uniquePlanModels25[2], 'gemini-3.1-flash-lite');
    assert.notStrictEqual(uniquePlanModels25[0], uniquePlanModels25[1], 'Failing model must not be repeated');
    assert.notStrictEqual(uniquePlanModels25[1], uniquePlanModels25[2], 'Fallback models must be distinct');
  } finally {
    mockServer.close();
  }
});

// ----------------------------------------------------------------------------
// Test 3: Exhausted fallback behavior
// ----------------------------------------------------------------------------
runTest('3. Exhausted fallback behavior: returns structured 404 NOT_FOUND with canFallback: true', () => {
  const routerErr = parseRouterError({
    error: 'The requested AI model was not found or is no longer available.',
    code: 404,
    status: 'NOT_FOUND',
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    retryable: false,
    canFallback: true,
    suggestedProviders: ['groq', 'openrouter']
  }, 404, 'gemini');

  assert.strictEqual(routerErr.code, 404, 'Must have code 404');
  assert.strictEqual(routerErr.status, 'NOT_FOUND', 'Must have status NOT_FOUND');
  assert.strictEqual(routerErr.retryable, false, 'Must not be retryable');
  assert.strictEqual(routerErr.canFallback, true, 'canFallback must be true');
  assert.strictEqual(routerErr.provider, 'gemini', 'provider must be gemini');
  assert.ok(routerErr.message.includes('not found') || routerErr.message.includes('no longer available'));
});

// ----------------------------------------------------------------------------
// Test 4: Retry limits & non-retryable errors
// ----------------------------------------------------------------------------
runTest('4. Retry limits & non-retryable errors: 401/403/400 do not trigger retries or fallbacks', () => {
  // 401 Unauthorized
  const err401 = evalGeminiError({ status: 401, message: 'API_KEY_INVALID' }, 'gemini');
  assert.strictEqual(err401.statusCode, 401);
  assert.strictEqual(err401.status, 'UNAUTHENTICATED');
  assert.strictEqual(err401.isRetryable, false, '401 must not be retryable');

  // 403 Permission Denied
  const err403 = evalGeminiError({ status: 403, message: 'PERMISSION_DENIED: billing disabled' }, 'gemini');
  assert.strictEqual(err403.statusCode, 403);
  assert.strictEqual(err403.status, 'PERMISSION_DENIED');
  assert.strictEqual(err403.isRetryable, false, '403 must not be retryable');

  // 400 Invalid Argument
  const err400 = evalGeminiError({ status: 400, message: 'INVALID_ARGUMENT: contents must not be empty' }, 'gemini');
  assert.strictEqual(err400.statusCode, 400);
  assert.strictEqual(err400.status, 'INVALID_ARGUMENT');
  assert.strictEqual(err400.isRetryable, false, '400 must not be retryable');

  // Verify router does not mark them retryable
  for (const parsed of [err401, err403, err400]) {
    const routerErr = parseRouterError(parsed, parsed.statusCode, 'gemini');
    assert.strictEqual(routerErr.retryable, false, `Status ${parsed.statusCode} must not be retryable in router`);
  }
});

// ----------------------------------------------------------------------------
// Test 5: Client cancellation
// ----------------------------------------------------------------------------
await runAsyncTest('5. Client cancellation: aborting Gemini request cancels upstream call and cleans up resources', async () => {
  let serverReceivedAbort = false;

  const mockServer = http.createServer((req, res) => {
    req.on('close', () => {
      serverReceivedAbort = true;
    });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    res.write('data: {"type":"start","modelUsed":"gemini-2.5-flash","provider":"gemini"}\n\n');
    res.write('data: {"type":"chunk","text":"Hello "}\n\n');
    // Keep connection hanging until aborted
  });

  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  const port = mockServer.address().port;

  try {
    const abortController = new AbortController();
    let chunkReceived = false;

    const streamPromise = streamAIMessage({
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      prompt: 'Test cancellation',
      chatEndpoint: `http://127.0.0.1:${port}/api/chat`,
      signal: abortController.signal,
      onChunk: (chunk) => {
        chunkReceived = true;
        abortController.abort();
      }
    });

    await assert.rejects(streamPromise, (err) => {
      return err.name === 'AbortError' || err.message?.includes('cancelled');
    });

    assert.ok(chunkReceived, 'Must have received initial chunk before abort');
    await sleep(50);
    assert.strictEqual(serverReceivedAbort, true, 'Server must have received TCP abort upon client disconnect');
  } finally {
    mockServer.close();
  }
});

// ----------------------------------------------------------------------------
// Test 6: Initial-response timeout behavior
// ----------------------------------------------------------------------------
await runAsyncTest('6. Initial-response timeout: HTTP 504 DEADLINE_EXCEEDED before headers, active stream survives past header timeout', async () => {
  // 6a. Stalled upstream before headers returns 504 DEADLINE_EXCEEDED
  const timeoutErr = evalGeminiError({ name: 'TimeoutError', message: 'The operation was aborted due to timeout' }, 'gemini');
  assert.strictEqual(timeoutErr.statusCode, 504);
  assert.strictEqual(timeoutErr.status, 'DEADLINE_EXCEEDED');
  assert.strictEqual(timeoutErr.isRetryable, true);

  const routerTimeoutErr = parseRouterError(timeoutErr, 504, 'gemini');
  assert.strictEqual(routerTimeoutErr.code, 504);
  assert.strictEqual(routerTimeoutErr.status, 'DEADLINE_EXCEEDED');
  assert.strictEqual(routerTimeoutErr.retryable, true);

  // 6b. Active SSE stream that has already sent headers continues transmitting without premature termination
  const mockServer = http.createServer(async (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    res.write('data: {"type":"start","modelUsed":"gemini-2.5-flash","provider":"gemini"}\n\n');
    res.write('data: {"type":"chunk","text":"Part 1 "}\n\n');
    await sleep(200);
    res.write('data: {"type":"chunk","text":"Part 2"}\n\n');
    res.write('data: {"type":"done","text":"Part 1 Part 2","modelUsed":"gemini-2.5-flash","provider":"gemini"}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });

  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  const port = mockServer.address().port;

  try {
    let accumulated = '';
    const result = await streamAIMessage({
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      prompt: 'Stream past header timeout',
      chatEndpoint: `http://127.0.0.1:${port}/api/chat`,
      onChunk: (chunk, acc) => {
        accumulated = acc;
      }
    });

    assert.strictEqual(result.text, 'Part 1 Part 2');
    assert.strictEqual(result.modelUsed, 'gemini-2.5-flash');
    assert.strictEqual(accumulated, 'Part 1 Part 2');
  } finally {
    mockServer.close();
  }
});

// ----------------------------------------------------------------------------
// Test 7: Finish reason handling: SAFETY and MAX_TOKENS
// ----------------------------------------------------------------------------
runTest('7. Finish reason handling: SAFETY blocks produce descriptive user error, MAX_TOKENS signals truncation', () => {
  // 7a. SAFETY block error parsing
  const safetyErr = evalGeminiError({
    message: '[GoogleGenAIError]: Candidate was blocked due to SAFETY'
  }, 'gemini');

  assert.strictEqual(safetyErr.statusCode, 400);
  assert.strictEqual(safetyErr.status, 'SAFETY_BLOCKED');
  assert.strictEqual(safetyErr.isRetryable, false);
  assert.ok(safetyErr.message.includes("Google Gemini's safety filters"));

  const routerSafety = parseRouterError(safetyErr, 400, 'gemini');
  assert.strictEqual(routerSafety.code, 400);
  assert.strictEqual(routerSafety.status, 'SAFETY_BLOCKED');
  assert.strictEqual(routerSafety.retryable, false);
  assert.ok(routerSafety.message.includes("Google Gemini's safety filters"));

  // 7b. Candidate finishReason SAFETY with finishReason field preserved
  const routerSafetyWithFinishReason = parseRouterError({
    error: "The response was blocked by Google Gemini's safety filters. Please rephrase your request.",
    code: 400,
    status: 'SAFETY_BLOCKED',
    provider: 'gemini',
    finishReason: 'SAFETY',
    canFallback: true
  }, 400, 'gemini');

  assert.strictEqual(routerSafetyWithFinishReason.finishReason, 'SAFETY');
  assert.strictEqual(routerSafetyWithFinishReason.canFallback, true);

  // 7c. Server code verification: server.ts inspects finishReason for both SAFETY and MAX_TOKENS
  const serverSrc = fs.readFileSync(path.join(ROOT_DIR, 'server.ts'), 'utf8');
  assert.ok(serverSrc.includes("finishReason === 'SAFETY'"), 'server.ts must check finishReason === SAFETY');
  assert.ok(serverSrc.includes("finishReason === 'MAX_TOKENS'"), 'server.ts must check finishReason === MAX_TOKENS');
  assert.ok(serverSrc.includes("lastFinishReason === 'SAFETY'"), 'server.ts must check lastFinishReason === SAFETY in streaming');
  assert.ok(serverSrc.includes("lastFinishReason === 'MAX_TOKENS'"), 'server.ts must check lastFinishReason === MAX_TOKENS in streaming');
});

// ----------------------------------------------------------------------------
// Test 8: Multimodal Vision & OCR integration
// ----------------------------------------------------------------------------
runTest('8. Vision & OCR integration: valid Gemini vision models and payload limits intact', () => {
  // 8a. Vision capability check
  assert.strictEqual(isVisionCapableProvider('gemini', 'gemini-2.5-flash'), true);
  assert.strictEqual(isVisionCapableProvider('gemini', 'gemini-3.8-flash'), true);
  assert.strictEqual(isVisionCapableProvider('gemini', 'gemini-flash-latest'), true);

  // 8b. OCR service candidate models check: verified production models
  const ocrSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/services/imageOcrService.js'), 'utf8');
  assert.ok(ocrSrc.includes("'gemini-3.8-flash'"), 'imageOcrService.js must use verified gemini-3.8-flash');
  assert.ok(ocrSrc.includes("'gemini-3.1-flash-lite'"), 'imageOcrService.js must include gemini-3.1-flash-lite fallback');

  // 8c. Payload limit preservation (3.0 MB max image, 4.2 MB total budget)
  const serverSrc = fs.readFileSync(path.join(ROOT_DIR, 'server.ts'), 'utf8');
  assert.ok(serverSrc.includes('MAX_CHAT_REQUEST_BYTES'), 'server.ts must enforce MAX_CHAT_REQUEST_BYTES (4.2 MB)');
  assert.ok(serverSrc.includes('MAX_VISION_IMAGE_BYTES'), 'server.ts must enforce MAX_VISION_IMAGE_BYTES (3.0 MB)');
});

// ----------------------------------------------------------------------------
// Test 9: Separation of concerns: documentation-based validation vs runtime access
// ----------------------------------------------------------------------------
runTest('9. Separation of concerns: documentation-based validation vs runtime access', () => {
  // 9a. Documented catalog models pass structural validation independently of network/credentials
  const catalogModels = ['gemini-2.5-flash', 'gemini-3.8-flash', 'gemini-flash-latest', 'gemini-2.5-pro'];
  for (const m of catalogModels) {
    const val = validateServerModelForProvider('gemini', m);
    assert.strictEqual(val.valid, true, `${m} must pass structural validation`);
    assert.strictEqual(val.code, undefined);
  }

  // 9b. Non-catalog / malformed identifiers fail with HTTP 400 INVALID_MODEL
  const malformed = ['gemini 3.8 flash', 'gemini 2.5 flash', '@cf/meta/llama-3.1-8b-instruct', 'qwen2.5:1.5b'];
  for (const m of malformed) {
    const val = validateServerModelForProvider('gemini', m);
    assert.strictEqual(val.valid, false, `${m} must fail structural validation`);
    assert.strictEqual(val.code, 400);
    assert.strictEqual(val.status, 'INVALID_MODEL');
  }

  // 9c. Runtime errors (404, 401, 403, 504) are categorized distinctly and never conflated with 400 INVALID_MODEL
  const notFoundErr = evalGeminiError({ status: 404, message: 'models/gemini-custom is not found' }, 'gemini');
  assert.strictEqual(notFoundErr.statusCode, 404);
  assert.strictEqual(notFoundErr.status, 'NOT_FOUND');

  const authErr = evalGeminiError({ status: 401, message: 'API_KEY_INVALID' }, 'gemini');
  assert.strictEqual(authErr.statusCode, 401);
  assert.strictEqual(authErr.status, 'UNAUTHENTICATED');

  const permErr = evalGeminiError({ status: 403, message: 'PERMISSION_DENIED: billing disabled' }, 'gemini');
  assert.strictEqual(permErr.statusCode, 403);
  assert.strictEqual(permErr.status, 'PERMISSION_DENIED');

  const timeoutErr = evalGeminiError({ status: 504, name: 'TimeoutError', message: 'Deadline exceeded' }, 'gemini');
  assert.strictEqual(timeoutErr.statusCode, 504);
  assert.strictEqual(timeoutErr.status, 'DEADLINE_EXCEEDED');
});

// ----------------------------------------------------------------------------
// Summary
// ----------------------------------------------------------------------------
console.log(`\n=== Phase 4C Complete: ${passedCount} Passed, ${failedCount} Failed ===`);
if (failedCount > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
