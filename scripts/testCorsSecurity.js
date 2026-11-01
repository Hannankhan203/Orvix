/**
 * ORVIX-003: CORS Configuration & Origin Validation Verification Suite
 *
 * Verifies that:
 * 1. Same-origin requests continue to work smoothly.
 * 2. Development origins (localhost, 127.0.0.1) are authorized.
 * 3. Configured origins via environment variables are respected.
 * 4. Untrusted arbitrary origins (e.g. https://attacker.example) are rejected with 403 on preflight and API endpoints.
 * 5. Wildcard Access-Control-Allow-Origin: * is NEVER emitted on API routes.
 * 6. Validated origins are reflected with Vary: Origin (never blind reflection).
 * 7. isAllowedOrigin unit tests cover edge cases (port numbers, domain spoofing).
 *
 * Run with: node scripts/testCorsSecurity.js
 */

import assert from 'node:assert/strict';

// Set TESTING flag to prevent server.ts from starting a second background server instance on import
process.env.TESTING = 'true';
const { isAllowedOrigin } = await import('../server.ts');

console.log('=== ORVIX-003: CORS Security Verification Suite ===\n');

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

const BASE_URL = 'http://localhost:3000';

// ===========================================================================
// Test Group 1: isAllowedOrigin Unit Tests
// ===========================================================================

await runTest('Unit: Undefined origin (same-origin / server-to-server) is allowed', () => {
  const mockReq = { headers: { host: 'localhost:3000' } };
  assert.strictEqual(isAllowedOrigin(undefined, mockReq), true);
  assert.strictEqual(isAllowedOrigin('', mockReq), true);
});

await runTest('Unit: Exact Host header match is allowed (same-origin)', () => {
  const mockReq = { headers: { host: 'my-orvix-app.example.com' } };
  assert.strictEqual(isAllowedOrigin('https://my-orvix-app.example.com', mockReq), true);
});

await runTest('Unit: Localhost and loopback origins are allowed', () => {
  const mockReq = { headers: { host: 'localhost:3000' } };
  assert.strictEqual(isAllowedOrigin('http://localhost:3000', mockReq), true);
  assert.strictEqual(isAllowedOrigin('http://localhost:5173', mockReq), true);
  assert.strictEqual(isAllowedOrigin('http://127.0.0.1:3000', mockReq), true);
  assert.strictEqual(isAllowedOrigin('http://127.0.0.1:8080', mockReq), true);
});

await runTest('Unit: Cloud Run (*.run.app) and Vercel (*.vercel.app) domains are allowed', () => {
  const mockReq = { headers: { host: 'ais-dev-app.asia-east1.run.app' } };
  assert.strictEqual(isAllowedOrigin('https://ais-dev-app.asia-east1.run.app', mockReq), true);
  assert.strictEqual(isAllowedOrigin('https://orvix-preview.vercel.app', mockReq), true);
});

await runTest('Unit: Domain spoofing attempts are strictly rejected', () => {
  const mockReq = { headers: { host: 'localhost:3000' } };
  // Similar prefix but not actual subdomain
  assert.strictEqual(isAllowedOrigin('https://attacker-vercel.app', mockReq), false);
  assert.strictEqual(isAllowedOrigin('https://fake-run.app', mockReq), false);
  assert.strictEqual(isAllowedOrigin('https://attacker.example', mockReq), false);
  assert.strictEqual(isAllowedOrigin('https://evil.com', mockReq), false);
  assert.strictEqual(isAllowedOrigin('not-a-valid-url', mockReq), false);
});

await runTest('Unit: Configured ALLOWED_ORIGINS environment variable is respected', () => {
  const prev = process.env.ALLOWED_ORIGINS;
  try {
    process.env.ALLOWED_ORIGINS = 'https://custom-portal.mycompany.org,https://internal.tools';
    const mockReq = { headers: { host: 'api.mycompany.org' } };
    assert.strictEqual(isAllowedOrigin('https://custom-portal.mycompany.org', mockReq), true);
    assert.strictEqual(isAllowedOrigin('https://internal.tools', mockReq), true);
    assert.strictEqual(isAllowedOrigin('https://untrusted.org', mockReq), false);
  } finally {
    process.env.ALLOWED_ORIGINS = prev;
  }
});

// ===========================================================================
// Test Group 2: Live HTTP Endpoint CORS Behavior
// ===========================================================================

await runTest('Live HTTP: Same-origin request to /api/health succeeds without CORS restrictions', async () => {
  const res = await fetch(`${BASE_URL}/api/health`);
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.status, 'ok');
});

await runTest('Live HTTP: OPTIONS preflight from allowed origin returns 204 with specific origin and Vary header', async () => {
  const res = await fetch(`${BASE_URL}/api/chat`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://localhost:3000',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'Content-Type'
    }
  });

  assert.strictEqual(res.status, 204);
  assert.strictEqual(res.headers.get('Access-Control-Allow-Origin'), 'http://localhost:3000');
  assert.notStrictEqual(res.headers.get('Access-Control-Allow-Origin'), '*', 'Must never return wildcard *');
  assert.ok(res.headers.get('Vary')?.includes('Origin'), 'Must include Vary: Origin');
  assert.ok(res.headers.get('Access-Control-Allow-Methods')?.includes('POST'));
});

await runTest('Live HTTP: OPTIONS preflight from untrusted origin is blocked with 403 Forbidden', async () => {
  const res = await fetch(`${BASE_URL}/api/chat`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://attacker.example',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'Content-Type'
    }
  });

  assert.strictEqual(res.status, 403, 'Preflight from untrusted origin must be rejected with 403');
  assert.strictEqual(res.headers.get('Access-Control-Allow-Origin'), null, 'Must NOT set Access-Control-Allow-Origin on rejected origin');
});

await runTest('Live HTTP: Cross-origin POST /api/chat from untrusted origin is blocked with 403 Forbidden', async () => {
  const res = await fetch(`${BASE_URL}/api/chat`, {
    method: 'POST',
    headers: {
      Origin: 'https://attacker.example',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ prompt: 'Unauthorized attempt', provider: 'gemini' })
  });

  assert.strictEqual(res.status, 403);
  const data = await res.json();
  assert.strictEqual(data.status, 'FORBIDDEN');
  assert.ok(data.error.includes('CORS'));
  assert.strictEqual(res.headers.get('Access-Control-Allow-Origin'), null);
});

await runTest('Live HTTP: Cross-origin POST /api/upload from untrusted origin is blocked with 403 Forbidden', async () => {
  const res = await fetch(`${BASE_URL}/api/upload`, {
    method: 'POST',
    headers: {
      Origin: 'https://attacker.example'
    }
  });

  assert.strictEqual(res.status, 403);
  const data = await res.json();
  assert.strictEqual(data.status, 'FORBIDDEN');
  assert.strictEqual(res.headers.get('Access-Control-Allow-Origin'), null);
});

await runTest('Live HTTP: Cross-origin POST /api/transcribe from untrusted origin is blocked with 403 Forbidden', async () => {
  const res = await fetch(`${BASE_URL}/api/transcribe`, {
    method: 'POST',
    headers: {
      Origin: 'https://attacker.example'
    }
  });

  assert.strictEqual(res.status, 403);
  const data = await res.json();
  assert.strictEqual(data.status, 'FORBIDDEN');
  assert.strictEqual(res.headers.get('Access-Control-Allow-Origin'), null);
});

await runTest('Live HTTP: Cross-origin GET /api/config from untrusted origin is blocked with 403 Forbidden', async () => {
  const res = await fetch(`${BASE_URL}/api/config`, {
    method: 'GET',
    headers: {
      Origin: 'https://attacker.example'
    }
  });

  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.headers.get('Access-Control-Allow-Origin'), null);
});

await runTest('Live HTTP: GET /api/config from allowed origin returns specific origin without wildcard', async () => {
  const res = await fetch(`${BASE_URL}/api/config`, {
    method: 'GET',
    headers: {
      Origin: 'http://localhost:3000'
    }
  });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('Access-Control-Allow-Origin'), 'http://localhost:3000');
  assert.notStrictEqual(res.headers.get('Access-Control-Allow-Origin'), '*');
});

console.log(`\n=== CORS Verification Results: ${passed} Passed, ${failed} Failed ===`);
if (failed > 0) process.exit(1);
