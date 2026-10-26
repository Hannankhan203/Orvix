/**
 * Orvix Express Backend Integration Verification Script (Phase 2 Step 4)
 *
 * Tests:
 * 1. Express database summary and diagnostics routes (/api/db/status, /api/db/summary)
 * 2. Strict ID format validators (validateUserId, validateConversationId)
 * 3. User-data boundary enforcement (verifies that untrusted client-supplied userIds
 *    cannot read or modify private data, returning AUTH_PENDING_PHASE_3)
 * 4. Verifies existing health and configuration routes remain completely intact
 *
 * Usage:
 *   npm run test:backend
 *   # or: npx tsx scripts/testBackendIntegration.ts
 */

process.env.TESTING = 'true';
import dotenv from 'dotenv';
dotenv.config();

import { app } from '../server.ts';
import {
  validateUserId,
  validateConversationId,
  getBackendMongoSummary
} from '../src/services/backendMongoService.ts';

// Lightweight in-memory HTTP caller for Express app testing
async function simulateRequest(method: string, path: string, body?: any): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const req: any = {
      method,
      url: path,
      originalUrl: path,
      path,
      headers: { 'content-type': 'application/json' },
      body: body || {},
      query: {},
      params: {},
      setTimeout: () => {},
      socket: { setTimeout: () => {} }
    };

    let statusCode = 200;
    let headers: Record<string, string> = {};
    let responseBody = '';

    const res: any = {
      statusCode: 200,
      setHeader: (key: string, val: string) => {
        headers[key.toLowerCase()] = val;
      },
      status: (code: number) => {
        statusCode = code;
        return res;
      },
      json: (obj: any) => {
        statusCode = statusCode || 200;
        resolve({ status: statusCode, data: obj });
      },
      send: (bodyContent: any) => {
        statusCode = statusCode || 200;
        resolve({ status: statusCode, data: bodyContent });
      },
      sendStatus: (code: number) => {
        statusCode = code;
        resolve({ status: statusCode, data: null });
      },
      end: () => {
        resolve({ status: statusCode, data: responseBody });
      },
      setTimeout: () => {},
      socket: { setTimeout: () => {} },
      on: () => {}
    };

    try {
      app(req, res);
    } catch (err) {
      reject(err);
    }
  });
}

async function run() {
  console.log('====================================================');
  console.log('  Orvix Backend MongoDB Integration Test Suite      ');
  console.log('====================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(name: string, condition: boolean, extra?: string) {
    if (condition) {
      console.log(`  ✓ ${name}`);
      passed++;
    } else {
      console.error(`  ❌ ${name}${extra ? ` - ${extra}` : ''}`);
      failed++;
    }
  }

  // ---------------------------------------------------------------------------
  // 1. Validator Tests
  // ---------------------------------------------------------------------------
  console.log('--- [1/4] Testing Backend ID Validators ---');
  const validUser = validateUserId('user-abc-123_test.xyz');
  assert('validateUserId accepts valid user ID format', validUser.valid && validUser.cleanId === 'user-abc-123_test.xyz');

  const invalidUserChar = validateUserId('user<script>alert(1)</script>');
  assert('validateUserId rejects injection/special characters', !invalidUserChar.valid);

  const emptyUser = validateUserId('');
  assert('validateUserId rejects empty string', !emptyUser.valid);

  const validChat = validateConversationId('chat-2026-xyz');
  assert('validateConversationId accepts valid chat ID format', validChat.valid && validChat.cleanId === 'chat-2026-xyz');

  const invalidChat = validateConversationId('ab');
  assert('validateConversationId rejects too-short chat ID', !invalidChat.valid);

  // ---------------------------------------------------------------------------
  // 2. Diagnostics & Readiness API
  // ---------------------------------------------------------------------------
  console.log('\n--- [2/4] Testing Diagnostics & Readiness Endpoints ---');
  const summaryRes = await simulateRequest('GET', '/api/db/summary');
  assert('GET /api/db/summary returns HTTP 200', summaryRes.status === 200);
  assert('Summary specifies database as Orvix', summaryRes.data?.database === 'Orvix');
  assert('Summary declares enforced auth boundary', summaryRes.data?.authBoundary?.status === 'enforced');

  const statusRes = await simulateRequest('GET', '/api/db/status');
  assert('GET /api/db/status returns HTTP 200', statusRes.status === 200);
  assert('Status endpoint returns collection readiness metadata', typeof statusRes.data?.readiness === 'object');

  // ---------------------------------------------------------------------------
  // 3. User Data Boundary Protection (IDOR Prevention & requireAuth Enforcement)
  // ---------------------------------------------------------------------------
  console.log('\n--- [3/4] Testing User-Data Protection Boundary ---');
  const unauthUsers = await simulateRequest('GET', '/api/users/target-victim-id');
  assert('GET /api/users/:id without token returns HTTP 401', unauthUsers.status === 401);
  assert('Response specifies AUTH_TOKEN_MISSING', unauthUsers.data?.code === 'AUTH_TOKEN_MISSING');

  const unauthChats = await simulateRequest('GET', '/api/conversations/target-victim-chat');
  assert('GET /api/conversations/:id without token returns HTTP 401', unauthChats.status === 401);
  assert('Response specifies AUTH_TOKEN_MISSING', unauthChats.data?.code === 'AUTH_TOKEN_MISSING');

  const unauthSettings = await simulateRequest('POST', '/api/user-settings/target-victim-id', { theme: 'light' });
  assert('POST /api/user-settings/:id without token returns HTTP 401', unauthSettings.status === 401);
  assert('Response specifies AUTH_TOKEN_MISSING', unauthSettings.data?.code === 'AUTH_TOKEN_MISSING');

  // ---------------------------------------------------------------------------
  // 4. Existing Routes Integrity
  // ---------------------------------------------------------------------------
  console.log('\n--- [4/4] Verifying Existing API Endpoints ---');
  const healthRes = await simulateRequest('GET', '/api/health');
  assert('GET /api/health returns HTTP 200', healthRes.status === 200 && healthRes.data?.status === 'ok');

  const configRes = await simulateRequest('GET', '/api/config');
  assert('GET /api/config returns HTTP 200', configRes.status === 200 && configRes.data?.mongodbDatabase === 'Orvix');

  console.log('\n====================================================');
  console.log(`  Tests completed: ${passed} passed, ${failed} failed`);
  console.log('====================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
