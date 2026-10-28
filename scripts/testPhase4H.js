/**
 * Phase 4H — Global Error Classification & Normalization Verification Suite
 *
 * 50 Comprehensive behavioral and unit checks verifying:
 * - Group A: Canonical Error Contract (1–10)
 * - Group B: Classification Accuracy (11–22)
 * - Group C: Provider-Specific Errors (23–32)
 * - Group D: Cancellation, Streaming, and Retry Metadata (33–42)
 * - Group E: Privacy, Messages, and Regression Safety (43–50)
 *
 * Run with: node scripts/testPhase4H.js
 */

process.env.TESTING = '1';

import assert from 'node:assert/strict';

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
  parseRouterError
} from '../src/services/aiRouter.js';

const { getConfiguredFallbackProviders } = await import('../server.ts');

import {
  WebLLMError,
  WEBLLM_ERROR_CODES,
  normalizeWebLLMError
} from '../src/services/webllmService.js';

import {
  createRequestIsolationController,
  cancelActiveChatRequest,
  runIsolatedPromptStream
} from '../src/services/requestIsolationService.js';

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

console.log('================================================================');
console.log('Phase 4H — Global Error Classification & Normalization Suite');
console.log('================================================================\n');

// ============================================================================
// Group A — Canonical Error Contract (1–10)
// ============================================================================
console.log('--- Group A: Canonical Error Contract (1–10) ---');

// Test 1: A structured provider error preserves its canonical code.
await runTest('1. A structured provider error preserves its canonical code', async () => {
  const structuredErr = {
    code: 'RATE_LIMITED',
    status: 'RATE_LIMITED',
    message: 'Rate limit reached',
    httpStatus: 429
  };
  const norm = normalizeAIError(structuredErr, { provider: 'groq' });
  assert.ok(isCanonicalAIError(norm));
  assert.equal(norm.code, STANDARD_ERROR_CODES.RATE_LIMITED);
  assert.equal(norm.status, STANDARD_ERROR_CODES.RATE_LIMITED);
});

// Test 2: Unknown errors become a safe structured error.
await runTest('2. Unknown errors become a safe structured error', async () => {
  const weirdInputs = [null, undefined, '', {}, new Error(''), { strangeField: 12345 }];
  for (const input of weirdInputs) {
    const norm = normalizeAIError(input);
    assert.ok(isCanonicalAIError(norm));
    assert.equal(typeof norm.code, 'string');
    assert.equal(typeof norm.message, 'string');
    assert.ok(norm.message.length > 0);
    assert.equal(typeof norm.httpStatus, 'number');
    assert.ok(norm.httpStatus >= 400 && norm.httpStatus <= 599);
  }
});

// Test 3: Provider attribution is preserved when known.
await runTest('3. Provider attribution is preserved when known', async () => {
  const providers = ['gemini', 'groq', 'openrouter', 'cloudflare', 'ollama', 'webllm'];
  for (const prov of providers) {
    const normFromCtx = normalizeAIError('Some failure', { provider: prov });
    assert.equal(normFromCtx.provider, prov);

    const normFromErr = normalizeAIError({ message: 'Failure', provider: prov });
    assert.equal(normFromErr.provider, prov);
  }
});

// Test 4: Model attribution is preserved when known.
await runTest('4. Model attribution is preserved when known', async () => {
  const norm = normalizeAIError('Model failure', {
    provider: 'gemini',
    model: 'gemini-2.5-flash'
  });
  assert.equal(norm.model, 'gemini-2.5-flash');

  const normFromPayload = normalizeAIError({
    message: 'Model failure',
    model: 'llama-3.1-8b-instant'
  });
  assert.equal(normFromPayload.model, 'llama-3.1-8b-instant');
});

// Test 5: HTTP status is retained when applicable.
await runTest('5. HTTP status is retained when applicable', async () => {
  const norm404 = normalizeAIError({ message: 'Not found', httpStatus: 404 });
  assert.equal(norm404.httpStatus, 404);

  const norm429 = normalizeAIError({ message: 'Rate limit', statusCode: 429 });
  assert.equal(norm429.httpStatus, 429);

  const norm502 = normalizeAIError({ message: 'Bad Gateway', code: 502 });
  assert.equal(norm502.httpStatus, 502);

  // Out-of-bounds or non-numeric defaults to 500
  const normInvalid = normalizeAIError({ message: 'Unknown status', httpStatus: 'abc' });
  assert.equal(normInvalid.httpStatus, 500);
});

// Test 6: Retryability metadata survives error wrapping.
await runTest('6. Retryability metadata survives error wrapping', async () => {
  const retryableErr = normalizeAIError({ message: 'Temporary failure', retryable: true });
  assert.strictEqual(retryableErr.retryable, true);

  const nonRetryableErr = normalizeAIError({ message: 'Fatal error', retryable: false });
  assert.strictEqual(nonRetryableErr.retryable, false);

  // Idempotent wrapping preserves retryable
  const rewrapped = normalizeAIError(retryableErr);
  assert.strictEqual(rewrapped.retryable, true);
});

// Test 7: Fallback eligibility survives error wrapping.
await runTest('7. Fallback eligibility survives error wrapping', async () => {
  const cloudErr = normalizeAIError({ message: 'Cloud 503', canFallback: true }, { provider: 'groq' });
  assert.strictEqual(cloudErr.canFallback, true);

  const noFallbackCloud = normalizeAIError({ message: 'Invalid prompt 400', canFallback: false }, { provider: 'gemini' });
  assert.strictEqual(noFallbackCloud.canFallback, false);
});

// Test 8: Cancellation metadata survives error wrapping.
await runTest('8. Cancellation metadata survives error wrapping', async () => {
  const abortErr = new Error('The operation was aborted');
  abortErr.name = 'AbortError';

  const norm = normalizeAIError(abortErr, { provider: 'gemini' });
  assert.strictEqual(norm.cancelled, true);
  assert.strictEqual(norm.retryable, false);
  assert.strictEqual(norm.canFallback, false);
  assert.equal(norm.code, STANDARD_ERROR_CODES.REQUEST_CANCELLED);
});

// Test 9: Partial-output metadata survives error wrapping.
await runTest('9. Partial-output metadata survives error wrapping', async () => {
  const partialErr = normalizeAIError('Stream cut off', {
    provider: 'cloudflare',
    partialText: 'Here is what was generated so far...',
    partial: true
  });
  assert.strictEqual(partialErr.partial, true);
  assert.equal(partialErr.partialText, 'Here is what was generated so far...');
  assert.strictEqual(partialErr.retryable, false);
});

// Test 10: Missing optional metadata does not cause normalization to fail.
await runTest('10. Missing optional metadata does not cause normalization to fail', async () => {
  const bareErr = normalizeAIError('Bare minimal string error');
  assert.ok(isCanonicalAIError(bareErr));
  assert.equal(bareErr.model, null);
  assert.equal(bareErr.requestId, null);
  assert.equal(bareErr.partialText, '');
  assert.equal(bareErr.partial, false);
  assert.equal(bareErr.cancelled, false);
  assert.equal(bareErr.timeout, false);
});

// ============================================================================
// Group B — Classification Accuracy (11–22)
// ============================================================================
console.log('\n--- Group B: Classification Accuracy (11–22) ---');

// Test 11: Missing credentials are classified correctly.
await runTest('11. Missing credentials are classified correctly', async () => {
  const norm = normalizeAIError('Gemini is not configured on the server (missing GEMINI_API_KEY)', {
    provider: 'gemini'
  });
  assert.equal(norm.code, STANDARD_ERROR_CODES.PROVIDER_NOT_CONFIGURED);
  assert.equal(norm.category, ERROR_CATEGORIES.CONFIGURATION_AND_VALIDATION);
  assert.equal(norm.httpStatus, 503);
  assert.strictEqual(norm.retryable, false);
});

// Test 12: Authentication and authorization failures are distinguished from model failures.
await runTest('12. Authentication and authorization failures are distinguished from model failures', async () => {
  const authErr = normalizeAIError({
    code: 401,
    status: 'UNAUTHENTICATED',
    message: 'Invalid API key provided'
  }, { provider: 'openrouter' });
  assert.equal(authErr.code, STANDARD_ERROR_CODES.UNAUTHENTICATED);
  assert.equal(authErr.category, ERROR_CATEGORIES.CONFIGURATION_AND_VALIDATION);
  assert.equal(authErr.httpStatus, 401);

  const permErr = normalizeAIError({
    code: 403,
    status: 'PERMISSION_DENIED',
    message: 'Permission denied on model'
  }, { provider: 'gemini' });
  assert.equal(permErr.code, STANDARD_ERROR_CODES.PERMISSION_DENIED);
  assert.equal(permErr.httpStatus, 403);
});

// Test 13: Unsupported models are classified correctly.
await runTest('13. Unsupported models are classified correctly', async () => {
  const invalidModelErr = normalizeAIError({
    status: 'INVALID_MODEL',
    message: 'The model identifier llama-3-70b is not valid for Gemini.'
  }, { provider: 'gemini' });
  assert.equal(invalidModelErr.code, STANDARD_ERROR_CODES.INVALID_MODEL);
  assert.equal(invalidModelErr.category, ERROR_CATEGORIES.CONFIGURATION_AND_VALIDATION);
  assert.equal(invalidModelErr.httpStatus, 400);
  assert.strictEqual(invalidModelErr.retryable, false);
});

// Test 14: Invalid request parameters are classified correctly.
await runTest('14. Invalid request parameters are classified correctly', async () => {
  const badParamErr = normalizeAIError({
    code: 400,
    status: 'INVALID_ARGUMENT',
    message: 'Temperature must be between 0.0 and 2.0'
  }, { provider: 'groq' });
  assert.equal(badParamErr.code, STANDARD_ERROR_CODES.INVALID_ARGUMENT);
  assert.equal(badParamErr.category, ERROR_CATEGORIES.CONFIGURATION_AND_VALIDATION);
  assert.equal(badParamErr.httpStatus, 400);
  assert.strictEqual(badParamErr.retryable, false);
});

// Test 15: Connection refusal is distinguished from a timeout.
await runTest('15. Connection refusal is distinguished from a timeout', async () => {
  const connRefused = normalizeAIError('connect ECONNREFUSED 127.0.0.1:11434', { provider: 'ollama' });
  assert.equal(connRefused.code, STANDARD_ERROR_CODES.CONNECTION_REFUSED);
  assert.equal(connRefused.category, ERROR_CATEGORIES.CONNECTIVITY_AND_TRANSPORT);
  assert.strictEqual(connRefused.timeout, false);

  const timedOut = normalizeAIError('Request timed out after 30000ms', { provider: 'ollama', isTimeout: true });
  assert.equal(timedOut.code, STANDARD_ERROR_CODES.DEADLINE_EXCEEDED);
  assert.equal(timedOut.category, ERROR_CATEGORIES.TIMEOUTS_AND_RESOURCE_LIMITS);
  assert.strictEqual(timedOut.timeout, true);
});

// Test 16: DNS/network failures are distinguished from application-level errors where possible.
await runTest('16. DNS/network failures are distinguished from application-level errors where possible', async () => {
  const dnsErr = normalizeAIError('getaddrinfo ENOTFOUND api.groq.com', { provider: 'groq' });
  assert.equal(dnsErr.code, STANDARD_ERROR_CODES.NETWORK_ERROR);
  assert.equal(dnsErr.category, ERROR_CATEGORIES.CONNECTIVITY_AND_TRANSPORT);
  assert.equal(dnsErr.httpStatus, 503);
});

// Test 17: Header timeout is classified correctly.
await runTest('17. Header timeout is classified correctly', async () => {
  const headerTimeout = normalizeAIError('The request to Google Gemini timed out after 30s while waiting for initial response headers.', {
    provider: 'gemini',
    isTimeout: true
  });
  assert.equal(headerTimeout.code, STANDARD_ERROR_CODES.DEADLINE_EXCEEDED);
  assert.equal(headerTimeout.category, ERROR_CATEGORIES.TIMEOUTS_AND_RESOURCE_LIMITS);
  assert.equal(headerTimeout.httpStatus, 504);
  assert.strictEqual(headerTimeout.timeout, true);
});

// Test 18: Body-stream timeout or interruption is classified correctly.
await runTest('18. Body-stream timeout or interruption is classified correctly', async () => {
  const streamInterrupt = normalizeAIError('Stream connection was closed before response data was received.', {
    provider: 'groq'
  });
  assert.equal(streamInterrupt.code, STANDARD_ERROR_CODES.STREAM_INTERRUPTED);
  assert.equal(streamInterrupt.category, ERROR_CATEGORIES.STREAMING_AND_GENERATION);
  assert.equal(streamInterrupt.httpStatus, 500);
});

// Test 19: Context-length errors are classified correctly.
await runTest('19. Context-length errors are classified correctly', async () => {
  const ctxLimit = normalizeAIError('This model supports at most 8192 tokens. Your prompt requested 9500 tokens.', {
    provider: 'groq',
    httpStatus: 400
  });
  assert.equal(ctxLimit.code, STANDARD_ERROR_CODES.CONTEXT_LENGTH_EXCEEDED);
  assert.equal(ctxLimit.category, ERROR_CATEGORIES.UPSTREAM_API_AND_MODEL);
  assert.equal(ctxLimit.httpStatus, 400);
  assert.strictEqual(ctxLimit.retryable, false);
  assert.strictEqual(ctxLimit.canFallback, false);
});

// Test 20: Rate-limit errors are classified correctly.
await runTest('20. Rate-limit errors are classified correctly', async () => {
  const rateLimit = normalizeAIError({
    code: 429,
    status: 'RESOURCE_EXHAUSTED',
    message: 'Rate limit reached. Please wait 10s.',
    retryAfterSeconds: 10
  }, { provider: 'openrouter' });
  assert.equal(rateLimit.code, STANDARD_ERROR_CODES.RATE_LIMITED);
  assert.equal(rateLimit.category, ERROR_CATEGORIES.TIMEOUTS_AND_RESOURCE_LIMITS);
  assert.equal(rateLimit.httpStatus, 429);
  assert.equal(rateLimit.retryAfterSeconds, 10);
});

// Test 21: Transient upstream server errors are classified consistently.
await runTest('21. Transient upstream server errors are classified consistently', async () => {
  const badGateway = normalizeAIError({ code: 502, status: 'BAD_GATEWAY' }, { provider: 'openrouter' });
  assert.equal(badGateway.code, STANDARD_ERROR_CODES.BAD_GATEWAY);
  assert.equal(badGateway.httpStatus, 502);

  const unavailable = normalizeAIError({ code: 503, status: 'UNAVAILABLE' }, { provider: 'gemini' });
  assert.equal(unavailable.code, STANDARD_ERROR_CODES.SERVICE_UNAVAILABLE);
  assert.equal(unavailable.httpStatus, 503);
});

// Test 22: Unknown upstream error payloads do not crash the classifier.
await runTest('22. Unknown upstream error payloads do not crash the classifier', async () => {
  const strangePayloads = [
    { randomNested: { deeper: [1, 2, 3] } },
    { error: { unexpectedStructure: true } },
    'random non-json string with { unclosed brackets',
    () => {},
    Symbol('err')
  ];
  for (const payload of strangePayloads) {
    const norm = normalizeAIError(payload);
    assert.ok(isCanonicalAIError(norm));
    assert.equal(typeof norm.message, 'string');
    assert.ok(norm.message.length > 0);
  }
});

// ============================================================================
// Group C — Provider-Specific Errors (23–32)
// ============================================================================
console.log('\n--- Group C: Provider-Specific Errors (23–32) ---');

// Test 23: Gemini errors preserve relevant structured details.
await runTest('23. Gemini errors preserve relevant structured details', async () => {
  const geminiSafety = normalizeAIError({
    status: 'SAFETY_BLOCKED',
    finishReason: 'SAFETY',
    message: 'Candidate was blocked due to SAFETY'
  }, { provider: 'gemini' });
  assert.equal(geminiSafety.code, STANDARD_ERROR_CODES.SAFETY_BLOCKED);
  assert.equal(geminiSafety.finishReason, 'SAFETY');
  assert.equal(geminiSafety.httpStatus, 400);
});

// Test 24: Groq errors preserve relevant structured details.
await runTest('24. Groq errors preserve relevant structured details', async () => {
  const groqDecommissioned = normalizeAIError({
    code: 404,
    status: 'NOT_FOUND',
    message: 'The model llama-3-70b-8192 has been decommissioned.'
  }, { provider: 'groq' });
  assert.equal(groqDecommissioned.code, STANDARD_ERROR_CODES.MODEL_NOT_FOUND);
  assert.equal(groqDecommissioned.httpStatus, 404);
  assert.strictEqual(groqDecommissioned.retryable, false);
});

// Test 25: OpenRouter gateway errors are classified correctly.
await runTest('25. OpenRouter gateway errors are classified correctly', async () => {
  const openRouter502 = normalizeAIError({
    code: 502,
    status: 'BAD_GATEWAY',
    message: 'Provider returned 502 Bad Gateway.'
  }, { provider: 'openrouter' });
  assert.equal(openRouter502.code, STANDARD_ERROR_CODES.BAD_GATEWAY);
  assert.equal(openRouter502.httpStatus, 502);
  assert.strictEqual(openRouter502.canFallback, true);
});

// Test 26: Cloudflare account, authentication, and model errors are distinguished correctly.
await runTest('26. Cloudflare account, authentication, and model errors are distinguished correctly', async () => {
  const cfAuth = normalizeAIError({
    code: 401,
    status: 'UNAUTHENTICATED',
    message: 'Invalid API Token for Cloudflare Workers AI'
  }, { provider: 'cloudflare' });
  assert.equal(cfAuth.code, STANDARD_ERROR_CODES.UNAUTHENTICATED);
  assert.equal(cfAuth.httpStatus, 401);

  const cfModel = normalizeAIError({
    code: 404,
    status: 'NOT_FOUND',
    message: 'Model @cf/nonexistent/model not found'
  }, { provider: 'cloudflare' });
  assert.equal(cfModel.code, STANDARD_ERROR_CODES.MODEL_NOT_FOUND);
  assert.equal(cfModel.httpStatus, 404);
});

// Test 27: Ollama connection failures are not mistaken for missing models.
await runTest('27. Ollama connection failures are not mistaken for missing models', async () => {
  const ollamaConn = normalizeAIError({
    code: 503,
    status: 'NETWORK_FAILURE',
    message: 'fetch failed (ECONNREFUSED)'
  }, { provider: 'ollama' });
  assert.equal(ollamaConn.code, STANDARD_ERROR_CODES.CONNECTION_REFUSED);
  assert.equal(ollamaConn.httpStatus, 503);
  assert.ok(ollamaConn.message.includes('ollama serve'));
  assert.notEqual(ollamaConn.code, STANDARD_ERROR_CODES.MODEL_NOT_FOUND);
});

// Test 28: Ollama model-not-found errors are classified correctly.
await runTest('28. Ollama model-not-found errors are classified correctly', async () => {
  const ollamaModelNotFound = normalizeAIError({
    code: 404,
    status: 'NOT_FOUND',
    message: 'model "qwen2.5:1.5b" not found, try pulling it first'
  }, { provider: 'ollama' });
  assert.equal(ollamaModelNotFound.code, STANDARD_ERROR_CODES.MODEL_NOT_FOUND);
  assert.equal(ollamaModelNotFound.httpStatus, 404);
  assert.ok(ollamaModelNotFound.message.includes('ollama pull'));
  assert.strictEqual(ollamaModelNotFound.canFallback, false);
});

// Test 29: WebLLM missing-WebGPU errors are classified correctly.
await runTest('29. WebLLM missing-WebGPU errors are classified correctly', async () => {
  const webGpuErr = new WebLLMError('Cannot find WebGPU', {
    code: WEBLLM_ERROR_CODES.WEBGPU_UNSUPPORTED,
    httpCode: 400
  });
  const norm = normalizeAIError(webGpuErr, { provider: 'webllm' });
  assert.equal(norm.code, STANDARD_ERROR_CODES.WEBGPU_UNSUPPORTED);
  assert.equal(norm.httpStatus, 400);
  assert.strictEqual(norm.canFallback, false);
});

// Test 30: WebLLM unsupported-model errors are not mistaken for download failures.
await runTest('30. WebLLM unsupported-model errors are not mistaken for download failures', async () => {
  const unsupportedModel = normalizeWebLLMError('Model llama-3.1-8b is not supported in catalog', {
    modelId: 'llama-3.1-8b'
  });
  const norm = normalizeAIError(unsupportedModel, { provider: 'webllm' });
  assert.equal(norm.code, STANDARD_ERROR_CODES.UNSUPPORTED_MODEL);
  assert.equal(norm.httpStatus, 400);
  assert.notEqual(norm.code, STANDARD_ERROR_CODES.OFFLINE_UNCACHED);
});

// Test 31: WebLLM device/runtime failures retain their meaningful classification.
await runTest('31. WebLLM device/runtime failures retain their meaningful classification', async () => {
  const devLost = new WebLLMError('Device was lost during inference', {
    code: WEBLLM_ERROR_CODES.DEVICE_LOST,
    httpCode: 507
  });
  const norm = normalizeAIError(devLost, { provider: 'webllm' });
  assert.equal(norm.code, STANDARD_ERROR_CODES.DEVICE_LOST);
  assert.equal(norm.httpStatus, 507);
  assert.strictEqual(norm.canFallback, false);
});

// Test 32: Malformed provider-specific streaming errors produce a structured failure.
await runTest('32. Malformed provider-specific streaming errors produce a structured failure', async () => {
  const malformedFrame = normalizeAIError({
    status: 'MALFORMED_STREAM_FRAME',
    message: 'Unexpected end of JSON stream frame'
  }, { provider: 'cloudflare' });
  assert.equal(malformedFrame.code, STANDARD_ERROR_CODES.MALFORMED_STREAM_FRAME);
  assert.equal(malformedFrame.category, ERROR_CATEGORIES.STREAMING_AND_GENERATION);
  assert.equal(malformedFrame.httpStatus, 500);
});

// ============================================================================
// Group D — Cancellation, Streaming, and Retry Metadata (33–42)
// ============================================================================
console.log('\n--- Group D: Cancellation, Streaming, and Retry Metadata (33–42) ---');

// Test 33: User cancellation is not classified as a network error.
await runTest('33. User cancellation is not classified as a network error', async () => {
  const userAbort = new Error('The operation was aborted');
  userAbort.name = 'AbortError';

  const norm = normalizeAIError(userAbort, { provider: 'groq' });
  assert.equal(norm.code, STANDARD_ERROR_CODES.REQUEST_CANCELLED);
  assert.notEqual(norm.code, STANDARD_ERROR_CODES.NETWORK_ERROR);
  assert.strictEqual(norm.cancelled, true);
  assert.strictEqual(norm.retryable, false);
  assert.strictEqual(norm.canFallback, false);
});

// Test 34: Timeout is not classified as user cancellation.
await runTest('34. Timeout is not classified as user cancellation', async () => {
  const timeoutErr = new Error('Operation timed out after 30000ms');
  timeoutErr.name = 'TimeoutError';

  const norm = normalizeAIError(timeoutErr, { provider: 'gemini', isTimeout: true });
  assert.equal(norm.code, STANDARD_ERROR_CODES.DEADLINE_EXCEEDED);
  assert.strictEqual(norm.timeout, true);
  assert.strictEqual(norm.cancelled, false);
});

// Test 35: Superseded requests retain cancellation/isolation semantics.
await runTest('35. Superseded requests retain cancellation/isolation semantics', async () => {
  const controller = createRequestIsolationController();
  const reqA = controller.beginRequest({
    chatId: 'chat-supersede',
    assistantMessageId: 'msg-a',
    provider: 'gemini'
  });
  const reqB = controller.beginRequest({
    chatId: 'chat-supersede',
    assistantMessageId: 'msg-b',
    provider: 'groq'
  });

  assert.strictEqual(controller.isRequestActive(reqA.requestId), false);
  assert.strictEqual(controller.isRequestActive(reqB.requestId), true);
});

// Test 36: Cancellation is never marked retryable.
await runTest('36. Cancellation is never marked retryable', async () => {
  const cancelledErr = normalizeAIError({
    name: 'AbortError',
    message: 'aborted',
    retryable: true // caller attempted to pass retryable: true
  }, { provider: 'gemini' });
  assert.strictEqual(cancelledErr.cancelled, true);
  assert.strictEqual(cancelledErr.retryable, false);
});

// Test 37: Cancellation is never made fallback-eligible by generic normalization.
await runTest('37. Cancellation is never made fallback-eligible by generic normalization', async () => {
  const cancelledErr = normalizeAIError({
    name: 'AbortError',
    message: 'aborted',
    canFallback: true
  }, { provider: 'openrouter' });
  assert.strictEqual(cancelledErr.canFallback, false);
});

// Test 38: Partial output is preserved when a stream fails.
await runTest('38. Partial output is preserved when a stream fails', async () => {
  const streamFailed = normalizeAIError({
    status: 'STREAM_FAILED',
    message: 'Network socket dropped mid-stream'
  }, {
    provider: 'cloudflare',
    partialText: 'Here is the intro and first section.',
    partial: true
  });
  assert.strictEqual(streamFailed.partial, true);
  assert.equal(streamFailed.partialText, 'Here is the intro and first section.');
});

// Test 39: Partial output prevents unsafe duplicate retries according to existing policy.
await runTest('39. Partial output prevents unsafe duplicate retries according to existing policy', async () => {
  const streamDrop = normalizeAIError({
    code: 503,
    status: 'UNAVAILABLE',
    message: 'Connection terminated mid-stream',
    retryable: true // provider reports 503 is retryable
  }, {
    provider: 'groq',
    partialText: 'Already printed tokens to the user UI.',
    partial: true
  });

  // Because tokens were already shown, retryable MUST be false to prevent duplication!
  assert.strictEqual(streamDrop.retryable, false);
});

// Test 40: Empty completed output is not reported as a valid nonempty answer.
await runTest('40. Empty completed output is not reported as a valid nonempty answer', async () => {
  const emptyNorm = normalizeAIError({
    status: 'EMPTY_RESPONSE',
    message: 'Received an empty completed response from the AI provider.'
  }, { provider: 'gemini' });
  assert.equal(emptyNorm.code, STANDARD_ERROR_CODES.UPSTREAM_SERVICE_ERROR);
  assert.strictEqual(emptyNorm.partial, false);
});

// Test 41: Multiple underlying failures produce only one terminal outcome.
await runTest('41. Multiple underlying failures produce only one terminal outcome', async () => {
  const controller = createRequestIsolationController();
  const entry = controller.beginRequest({
    chatId: 'chat-single-terminal',
    assistantMessageId: 'msg-term-1',
    provider: 'gemini'
  });

  let terminalEvents = 0;
  // First cancellation / finalization
  if (controller.markFinalized(entry.requestId)) {
    terminalEvents++;
  }
  // Second attempted finalization
  if (controller.markFinalized(entry.requestId)) {
    terminalEvents++;
  }

  assert.equal(terminalEvents, 1);
});

// Test 42: Error wrapping does not erase request identity or partial-output metadata.
await runTest('42. Error wrapping does not erase request identity or partial-output metadata', async () => {
  const initial = normalizeAIError('First drop', {
    provider: 'groq',
    requestId: 'req-42-id',
    partialText: 'Partial tokens',
    partial: true
  });
  assert.equal(initial.requestId, 'req-42-id');
  assert.equal(initial.partialText, 'Partial tokens');

  const rewrapped = normalizeAIError(initial);
  assert.equal(rewrapped.requestId, 'req-42-id');
  assert.equal(rewrapped.partialText, 'Partial tokens');
  assert.strictEqual(rewrapped.partial, true);
});

// ============================================================================
// Group E — Privacy, Messages, and Regression Safety (43–50)
// ============================================================================
console.log('\n--- Group E: Privacy, Messages, and Regression Safety (43–50) ---');

// Test 43: Error messages do not expose API keys or authorization headers.
await runTest('43. Error messages do not expose API keys or authorization headers', async () => {
  const leakedGemini = 'AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q';
  const leakedGroq = 'gsk_1234567890abcdef1234567890abcdef12345678';
  const leakedOpenRouter = 'sk-or-v1-abcdef0123456789abcdef0123456789abcdef';
  const leakedBearer = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.tokenBody.sig';

  const rawMessage = `Error with ${leakedGemini}, ${leakedGroq}, ${leakedOpenRouter}, and auth: ${leakedBearer}`;
  const sanitized = sanitizeErrorMessage(rawMessage);

  assert.ok(!sanitized.includes(leakedGemini));
  assert.ok(!sanitized.includes(leakedGroq));
  assert.ok(!sanitized.includes(leakedOpenRouter));
  assert.ok(!sanitized.includes('eyJhbGci'));
  assert.ok(sanitized.includes('[REDACTED_API_KEY]'));
  assert.ok(sanitized.includes('Bearer [REDACTED]'));
});

// Test 44: Error messages do not expose raw private prompts or request bodies.
await runTest('44. Error messages do not expose raw private prompts or request bodies', async () => {
  const privatePrompt = 'User private banking pin 9876 password xyz';
  const rawMsg = `Provider error processing prompt: "${privatePrompt}"`;
  const sanitized = sanitizeErrorMessage(rawMsg, { promptText: privatePrompt });

  assert.ok(!sanitized.includes(privatePrompt));
  assert.ok(sanitized.includes('[USER_PROMPT]'));
});

// Test 45: Ollama privacy restrictions survive normalization.
await runTest('45. Ollama privacy restrictions survive normalization', async () => {
  const testErrors = [
    { code: 503, status: 'UNAVAILABLE' },
    { code: 404, status: 'NOT_FOUND' },
    { code: 504, status: 'DEADLINE_EXCEEDED' },
    { code: 500, status: 'INTERNAL', canFallback: true }
  ];
  for (const err of testErrors) {
    const norm = normalizeAIError(err, { provider: 'ollama' });
    assert.strictEqual(norm.canFallback, false, `Ollama must never have canFallback: true (${norm.code})`);
  }
});

// Test 46: WebLLM privacy restrictions survive normalization.
await runTest('46. WebLLM privacy restrictions survive normalization', async () => {
  const testErrors = [
    { code: 400, status: 'WEBGPU_UNSUPPORTED' },
    { code: 507, status: 'DEVICE_LOST' },
    { code: 500, status: 'WORKER_CRASHED', canFallback: true }
  ];
  for (const err of testErrors) {
    const norm = normalizeAIError(err, { provider: 'webllm' });
    assert.strictEqual(norm.canFallback, false, `WebLLM must never have canFallback: true (${norm.code})`);
  }
});

// Test 47: Unconfigured providers are not incorrectly marked as available fallbacks.
await runTest('47. Unconfigured providers are not incorrectly marked as available fallbacks', async () => {
  const candidates = getConfiguredFallbackProviders('gemini');
  // Ollama and WebLLM are local, but unconfigured cloud providers with dummy keys must be excluded
  assert.ok(Array.isArray(candidates));
  assert.ok(!candidates.includes('gemini'));
});

// Test 48: User-facing messages provide accurate guidance for known failures.
await runTest('48. User-facing messages provide accurate guidance for known failures', async () => {
  const ollamaErr = normalizeAIError({ code: 503, message: 'fetch failed' }, { provider: 'ollama' });
  assert.ok(ollamaErr.message.includes('ollama serve'));

  const webGpuErr = normalizeAIError(new WebLLMError('No WebGPU', { code: WEBLLM_ERROR_CODES.WEBGPU_UNSUPPORTED }), { provider: 'webllm' });
  assert.ok(webGpuErr.message.includes('WebGPU'));

  const payloadErr = normalizeAIError({ code: 413, status: 'PAYLOAD_TOO_LARGE' }, { provider: 'gemini' });
  assert.ok(payloadErr.message.includes('3.0 MB'));
});

// Test 49: Existing UI consumers remain compatible with normalized error objects.
await runTest('49. Existing UI consumers remain compatible with normalized error objects', async () => {
  const norm = normalizeAIError({ code: 429, message: 'Quota exhausted' }, { provider: 'groq' });
  assert.ok(norm instanceof Error);
  assert.equal(norm.name, 'CanonicalAIError');
  assert.equal(typeof norm.message, 'string');
  assert.equal(typeof norm.status, 'string');
  assert.equal(typeof norm.code, 'string');
  assert.equal(typeof norm.httpStatus, 'number');
});

// Test 50: Existing provider, request-isolation, and cancellation behavior remains intact.
await runTest('50. Existing provider, request-isolation, and cancellation behavior remains intact', async () => {
  const parsed = parseRouterError(
    { error: 'High traffic surge', status: 'UNAVAILABLE' },
    503,
    'gemini'
  );
  assert.equal(parsed.code, 503);
  assert.equal(parsed.status, 'UNAVAILABLE');
  assert.strictEqual(parsed.retryable, true);
  assert.strictEqual(parsed.canFallback, true);
  assert.strictEqual(parsed.timeout, false);
  assert.strictEqual(parsed.cancelled, false);
  assert.strictEqual(parsed.partial, false);
});

console.log('\n================================================================');
console.log(`Phase 4H Test Results: ${passed} Passed, ${failed} Failed out of 50 tests`);
console.log('================================================================\n');

if (failed > 0) {
  process.exit(1);
}
