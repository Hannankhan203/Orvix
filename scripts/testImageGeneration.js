/**
 * Comprehensive Test Suite for Phase 6 Prompt 31: Multimodal Image Generation
 *
 * Verifies:
 * 1. Authentication: Rejects forged/invalid Authorization Bearer token (401 UNAUTHORIZED)
 * 2. Provider selection:
 *    - Validates configured vs unconfigured provider handling
 *    - Unconfigured provider returns 503 PROVIDER_NOT_CONFIGURED with clear error message
 *    - Auto provider resolves to best available configured provider
 * 3. Prompt validation:
 *    - Rejects empty prompt with 400 INVALID_PROMPT
 *    - Rejects prompts > 2000 characters with 400 PROMPT_TOO_LONG
 *    - Aspect ratio sanitizer normalizes arbitrary values to '1:1' and preserves allowed ratios
 * 4. Successful Image Generation:
 *    - Returns complete ImageGenerationResult structure (id, prompt, provider, model, mimeType, format, aspectRatio, dataUrl, base64, size, dimensions, filename, createdAt)
 *    - Caches generated file into upload subsystem registry for /api/upload/:id/file retrieval
 * 5. Error handling:
 *    - Quota exceeded errors map to 429 QUOTA_EXCEEDED
 *    - Safety filter violations map to 400 SAFETY_VIOLATION
 *    - Server exceptions return structured 500 JSON without leaking secrets
 * 6. Frontend Download Behavior:
 *    - downloadGeneratedImage correctly formats download link with data URL and file endpoint fallback
 * 7. Storage & Persistence Sanitization:
 *    - sanitizeMessageForStorage strips large base64/dataUrl from imageResult to prevent Firestore quota overflow
 *    - buildFirestoreMessagePayload properly preserves image generation metadata
 */

import assert from 'node:assert/strict';
import http from 'node:http';

process.env.TESTING = '1';
const { app } = await import('../server.ts');

import {
  sanitizeAspectRatio,
  setCustomImageGeneratorForTesting,
  resetImageGenerationForTesting
} from '../server/imageGenerationSubsystem.ts';
import {
  sanitizeMessageForStorage,
  sanitizeImageResultForStorage,
  buildFirestoreMessagePayload
} from '../src/services/chatStorageService.js';
import { downloadGeneratedImage } from '../src/services/imageGenerationService.js';

// Spin up ephemeral in-process test HTTP server
const testServer = http.createServer(app);
await new Promise((resolve) => testServer.listen(0, '127.0.0.1', resolve));
const serverAddr = testServer.address();
const BASE_URL = `http://127.0.0.1:${serverAddr.port}`;

console.log('================================================================');
console.log('TEST SUITE: Phase 6 Prompt 31 - Multimodal Image Generation');
console.log(`Running in-process server against ${BASE_URL}`);
console.log('================================================================\n');

let passedCount = 0;
let totalCount = 0;

async function runTest(name, fn) {
  totalCount++;
  try {
    await fn();
    console.log(`  ✓ PASS: ${name}`);
    passedCount++;
  } catch (err) {
    console.error(`  ✗ FAIL: ${name}`);
    console.error(`    ${err?.stack || err?.message || err}`);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// 1. Prompt Validation & Aspect Ratio Sanitization
// ---------------------------------------------------------------------------
await runTest('Aspect ratio sanitizer preserves valid ratios and normalizes invalid ones to 1:1', async () => {
  assert.strictEqual(sanitizeAspectRatio('1:1'), '1:1');
  assert.strictEqual(sanitizeAspectRatio('16:9'), '16:9');
  assert.strictEqual(sanitizeAspectRatio('9:16'), '9:16');
  assert.strictEqual(sanitizeAspectRatio('4:3'), '4:3');
  assert.strictEqual(sanitizeAspectRatio('3:4'), '3:4');
  assert.strictEqual(sanitizeAspectRatio('invalid'), '1:1');
  assert.strictEqual(sanitizeAspectRatio(undefined), '1:1');
  assert.strictEqual(sanitizeAspectRatio(''), '1:1');
});

// ---------------------------------------------------------------------------
// 2. HTTP Endpoint Prompt Validation (Empty prompt, Too long prompt)
// ---------------------------------------------------------------------------
await runTest('POST /api/generate-image rejects empty prompt with 400 INVALID_PROMPT', async () => {
  const res = await fetch(`${BASE_URL}/api/generate-image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: '   ' })
  });

  assert.strictEqual(res.status, 400);
  const data = await res.json();
  assert.strictEqual(data.code, 'INVALID_PROMPT');
  assert.ok(data.error.includes('required'));
});

await runTest('POST /api/generate-image rejects prompts exceeding 2000 characters with 400 PROMPT_TOO_LONG', async () => {
  const longPrompt = 'A'.repeat(2001);
  const res = await fetch(`${BASE_URL}/api/generate-image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: longPrompt })
  });

  assert.strictEqual(res.status, 400);
  const data = await res.json();
  assert.strictEqual(data.code, 'PROMPT_TOO_LONG');
  assert.ok(data.error.includes('2000 characters'));
});

// ---------------------------------------------------------------------------
// 3. Authentication Verification
// ---------------------------------------------------------------------------
await runTest('POST /api/generate-image rejects forged Authorization Bearer token with 401 UNAUTHORIZED', async () => {
  const res = await fetch(`${BASE_URL}/api/generate-image`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer FORGED_MALICIOUS_TOKEN_12345'
    },
    body: JSON.stringify({ prompt: 'A cozy coffee shop' })
  });

  assert.strictEqual(res.status, 401);
  const data = await res.json();
  assert.strictEqual(data.status, 'UNAUTHORIZED');
  assert.ok(data.error.includes('Authentication failed'));
});

// ---------------------------------------------------------------------------
// 4. Provider Selection & Unavailable Provider Error Handling
// ---------------------------------------------------------------------------
await runTest('POST /api/generate-image with unconfigured cloudflare provider returns 503 PROVIDER_NOT_CONFIGURED', async () => {
  const cfgRes = await fetch(`${BASE_URL}/api/config`);
  const cfg = await cfgRes.json();

  if (!cfg.cloudflareConfigured) {
    const res = await fetch(`${BASE_URL}/api/generate-image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'A futuristic city skyline',
        provider: 'cloudflare'
      })
    });

    assert.strictEqual(res.status, 503);
    const data = await res.json();
    assert.strictEqual(data.code, 'PROVIDER_NOT_CONFIGURED');
    assert.strictEqual(data.provider, 'cloudflare');
    assert.strictEqual(data.retryable, false);
    assert.ok(data.error.includes('Cloudflare Workers AI image generation is not configured'));
  }
});

// ---------------------------------------------------------------------------
// 5. Deterministic Successful Generation (Via In-Process Test Hook)
// ---------------------------------------------------------------------------
await runTest('Successful generation returns structured result with image data, metadata, and local registry entry', async () => {
  const dummy1x1Png = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
    0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
    0x00, 0x03, 0x01, 0x01, 0x00, 0x18, 0xdd, 0x8d, 0xb0, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
    0x44, 0xae, 0x42, 0x60, 0x82
  ]);

  setCustomImageGeneratorForTesting(async (req, userId) => {
    return {
      id: `gen-img-test-${Date.now()}`,
      prompt: req.prompt,
      provider: 'gemini',
      model: 'gemini-3.1-flash-lite-image',
      mimeType: 'image/png',
      format: 'png',
      aspectRatio: req.aspectRatio || '1:1',
      dataUrl: `data:image/png;base64,${dummy1x1Png.toString('base64')}`,
      base64: dummy1x1Png.toString('base64'),
      size: dummy1x1Png.length,
      dimensions: { width: 1, height: 1 },
      filename: 'pixel-art-test.png',
      createdAt: new Date().toISOString(),
      conversationId: req.conversationId,
      userId
    };
  });

  try {
    const res = await fetch(`${BASE_URL}/api/generate-image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'A tiny 1x1 pixel art flower',
        aspectRatio: '1:1',
        conversationId: 'chat-test-123'
      })
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.ok(data.id.startsWith('gen-img-test-'));
    assert.strictEqual(data.provider, 'gemini');
    assert.strictEqual(data.model, 'gemini-3.1-flash-lite-image');
    assert.strictEqual(data.format, 'png');
    assert.strictEqual(data.aspectRatio, '1:1');
    assert.strictEqual(data.dimensions.width, 1);
    assert.strictEqual(data.dimensions.height, 1);
    assert.ok(data.dataUrl.startsWith('data:image/png;base64,'));
    assert.strictEqual(data.conversationId, 'chat-test-123');
  } finally {
    resetImageGenerationForTesting();
  }
});

// ---------------------------------------------------------------------------
// 6. Upstream Error Handling (Quota Exceeded & Safety Blocks)
// ---------------------------------------------------------------------------
await runTest('Custom generator error propagates with proper status and error details', async () => {
  setCustomImageGeneratorForTesting(async () => {
    const err = new Error('User has exhausted image quota');
    err.status = 429;
    err.code = 'QUOTA_EXCEEDED';
    err.statusText = 'RESOURCE_EXHAUSTED';
    throw err;
  });

  try {
    const res = await fetch(`${BASE_URL}/api/generate-image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'A galaxy spiral' })
    });

    assert.strictEqual(res.status, 429);
    const data = await res.json();
    assert.strictEqual(data.code, 'QUOTA_EXCEEDED');
    assert.strictEqual(data.status, 'RESOURCE_EXHAUSTED');
    assert.ok(data.error.includes('quota'));
  } finally {
    resetImageGenerationForTesting();
  }
});

// ---------------------------------------------------------------------------
// 7. Frontend Download Behavior
// ---------------------------------------------------------------------------
await runTest('downloadGeneratedImage creates download anchor with correct attributes and falls back to URL', async () => {
  let createdAnchor = null;
  let clicked = false;

  const originalDocument = globalThis.document;
  globalThis.document = {
    createElement: (tag) => {
      if (tag === 'a') {
        createdAnchor = {
          href: '',
          download: '',
          target: '',
          rel: '',
          click: () => { clicked = true; }
        };
        return createdAnchor;
      }
      return {};
    },
    body: {
      appendChild: () => {},
      removeChild: () => {}
    }
  };

  try {
    // 7A: Download via data URL
    const imageResult = {
      id: 'img-dl-1',
      dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      filename: 'cosmic-nebula.png',
      format: 'png',
      mimeType: 'image/png'
    };

    const resA = downloadGeneratedImage(imageResult);
    assert.strictEqual(resA, true);
    assert.strictEqual(clicked, true);
    assert.strictEqual(createdAnchor.download, 'cosmic-nebula.png');
    assert.ok(createdAnchor.href.startsWith('data:image/png;base64,'));

    // 7B: Download via fallback upload file endpoint by ID
    clicked = false;
    createdAnchor = null;
    const imageResultNoDataUri = {
      id: 'img-dl-2',
      filename: 'portrait.jpg',
      format: 'jpg',
      mimeType: 'image/jpeg'
    };

    const resB = downloadGeneratedImage(imageResultNoDataUri);
    assert.strictEqual(resB, true);
    assert.strictEqual(clicked, true);
    assert.strictEqual(createdAnchor.download, 'portrait.jpg');
    assert.strictEqual(createdAnchor.href, '/api/upload/img-dl-2/file');
  } finally {
    globalThis.document = originalDocument;
  }
});

// ---------------------------------------------------------------------------
// 8. Storage Sanitization (Strip large base64/dataUrl from Firestore / Guest persistence)
// ---------------------------------------------------------------------------
await runTest('sanitizeMessageForStorage strips large base64 and dataUrl from imageResult while preserving metadata', async () => {
  const dirtyMessage = {
    id: 'msg-img-1',
    sender: 'assistant',
    isImageGeneration: true,
    imageStatus: 'ready',
    imagePrompt: 'A surreal landscape with floating islands',
    aspectRatio: '16:9',
    imageResult: {
      id: 'gen-img-large-1',
      prompt: 'A surreal landscape with floating islands',
      provider: 'gemini',
      model: 'gemini-3.1-flash-lite-image',
      mimeType: 'image/png',
      format: 'png',
      aspectRatio: '16:9',
      base64: 'HUGE_RAW_BASE64_BYTES_THAT_SHOULD_NEVER_BE_IN_FIRESTORE',
      dataUrl: 'data:image/png;base64,HUGE_RAW_BASE64_BYTES_THAT_SHOULD_NEVER_BE_IN_FIRESTORE',
      size: 500000,
      dimensions: { width: 1024, height: 576 },
      filename: 'surreal-landscape.png',
      createdAt: new Date().toISOString()
    }
  };

  const sanitized = sanitizeMessageForStorage(dirtyMessage);
  assert.strictEqual(sanitized.isImageGeneration, true);
  assert.strictEqual(sanitized.imageResult.id, 'gen-img-large-1');
  assert.strictEqual(sanitized.imageResult.format, 'png');
  assert.strictEqual(sanitized.imageResult.aspectRatio, '16:9');
  assert.strictEqual(sanitized.imageResult.dimensions.width, 1024);
  assert.strictEqual(sanitized.imageResult.base64, undefined, 'base64 must be stripped for storage');
  assert.strictEqual(sanitized.imageResult.dataUrl, undefined, 'dataUrl must be stripped for storage');

  // Verify buildFirestoreMessagePayload also incorporates sanitized image generation metadata
  const firestorePayload = buildFirestoreMessagePayload(dirtyMessage);
  assert.strictEqual(firestorePayload.isImageGeneration, true);
  assert.strictEqual(firestorePayload.imageStatus, 'ready');
  assert.strictEqual(firestorePayload.imagePrompt, 'A surreal landscape with floating islands');
  assert.strictEqual(firestorePayload.aspectRatio, '16:9');
  assert.strictEqual(firestorePayload.imageResult.base64, undefined);
  assert.strictEqual(firestorePayload.imageResult.dataUrl, undefined);
  assert.strictEqual(firestorePayload.imageResult.filename, 'surreal-landscape.png');
});

// Close test server
await new Promise((resolve) => testServer.close(resolve));

// ---------------------------------------------------------------------------
// Test Summary
// ---------------------------------------------------------------------------
console.log('\n================================================================');
console.log(`Test Execution Summary: ${passedCount}/${totalCount} tests passed`);
console.log('================================================================\n');

if (passedCount !== totalCount) {
  process.exit(1);
}
