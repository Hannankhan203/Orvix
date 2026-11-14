/**
 * scripts/testAudit001And030.js
 *
 * Focused Regression Suite for:
 * - ORVIX-001: Server Credential Exposure (client-prefixed secret rejection & no /proc scan)
 * - ORVIX-SUPABASE-FINAL-001: Durable Upload Ticket Persistence (fail-closed production mode)
 * - ORVIX-AUD-030: Firestore Shared Chat Validation (full list & nested item validation)
 * - ORVIX-AUD-031: Test Runner Reliability (speech fixture & runner accuracy)
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

process.env.TESTING = '1';
process.env.FIREBASE_PROJECT_ID = 'orvix-audit-001-030-test';

const {
  resolveEnvCredential,
  getGroqApiKey,
  getOpenRouterApiKey,
  getGeminiApiKey,
  getSupabaseUrl,
  getCloudflareCredentials
} = await import('../server/serverConfig.ts');

const { extractImageTextWithGeminiVision } = await import('../src/services/imageOcrService.js');

const {
  createDurableUploadTicket,
  getDurableUploadTicket,
  claimDirectUploadTicketForCompletion,
  finalizeCompletedDirectUploadTicket,
  failAndCleanupDurableUploadTicket,
  cancelDurableUploadTicket,
  pruneExpiredDirectUploadTickets,
  resetDirectUploadTicketsForTesting,
  pendingDirectUploads
} = await import('../server/directUploadTicketService.ts');

const {
  setForceProductionModeForTesting,
  setFirestoreForTesting,
  resetFirestoreForTesting,
  getQuotaStatus
} = await import('../server/uploadQuotaService.ts');

const {
  setSupabaseServerClientForTesting,
  resetSupabaseClientForTesting
} = await import('../server/supabaseClient.ts');

const {
  setTestPublicKey,
  clearTestPublicKeys,
  resetFirebaseAuthForTesting
} = await import('../server/firebaseAuthHelper.ts');

const {
  buildValidatedSharedSnapshot
} = await import('../src/services/shareChatService.js');

const { app } = await import('../server.ts');

console.log('======================================================================');
console.log('ORVIX AUDIT REGRESSION SUITE (ORVIX-001 / SUPABASE-FINAL-001 / AUD-030 / AUD-031)');
console.log('======================================================================\n');

let passed = 0;
let failed = 0;

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`  PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL: ${name}`);
    console.error(`    ${err?.stack || err?.message || err}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// 1. ORVIX-001: Server Credential Exposure
// ---------------------------------------------------------------------------
await runTest('ORVIX-001: rejects VITE_*, NEXT_PUBLIC_*, REACT_APP_* secret variables and removes /proc scan', async () => {
  const serverConfigSrc = fs.readFileSync(path.join(ROOT_DIR, 'server/serverConfig.ts'), 'utf8');
  const ocrSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/services/imageOcrService.js'), 'utf8');

  assert.equal(serverConfigSrc.includes('/proc'), false, 'serverConfig.ts must not scan /proc/*/environ');
  assert.equal(serverConfigSrc.includes('VITE_GEMINI_API_KEY'), false, 'serverConfig.ts must not read VITE_GEMINI_API_KEY');
  assert.equal(serverConfigSrc.includes('VITE_GROQ_API_KEY'), false, 'serverConfig.ts must not read VITE_GROQ_API_KEY');
  assert.equal(serverConfigSrc.includes('VITE_OPENROUTER_API_KEY'), false, 'serverConfig.ts must not read VITE_OPENROUTER_API_KEY');
  assert.equal(serverConfigSrc.includes('NEXT_PUBLIC_GEMINI_API_KEY'), false);
  assert.equal(serverConfigSrc.includes('NEXT_PUBLIC_GROQ_API_KEY'), false);
  assert.equal(serverConfigSrc.includes('NEXT_PUBLIC_OPENROUTER_API_KEY'), false);
  assert.equal(serverConfigSrc.includes('REACT_APP_GEMINI_API_KEY'), false);
  assert.equal(serverConfigSrc.includes('REACT_APP_GROQ_API_KEY'), false);
  assert.equal(serverConfigSrc.includes('REACT_APP_OPENROUTER_API_KEY'), false);
  assert.equal(ocrSrc.includes('VITE_GEMINI_API_KEY'), false, 'imageOcrService.js must not read VITE_GEMINI_API_KEY');

  const keysToClear = [
    'GEMINI_API_KEY', 'ORVIX_GEMINI_API_KEY', 'GOOGLE_API_KEY',
    'VITE_GEMINI_API_KEY', 'NEXT_PUBLIC_GEMINI_API_KEY', 'REACT_APP_GEMINI_API_KEY',
    'GROQ_API_KEY', 'ORVIX_GROQ_API_KEY', 'GROQ_KEY', 'GROQ_API_TOKEN', 'GROQ_API_SECRET',
    'VITE_GROQ_API_KEY', 'NEXT_PUBLIC_GROQ_API_KEY', 'REACT_APP_GROQ_API_KEY',
    'OPENROUTER_API_KEY', 'ORVIX_OPENROUTER_API_KEY', 'OPEN_ROUTER_API_KEY', 'OPENROUTER_KEY', 'OPENROUTER_API_TOKEN', 'OPENROUTER_API_SECRET',
    'VITE_OPENROUTER_API_KEY', 'NEXT_PUBLIC_OPENROUTER_API_KEY', 'REACT_APP_OPENROUTER_API_KEY',
    'CLOUDFLARE_ACCOUNT_ID', 'ORVIX_CLOUDFLARE_ACCOUNT_ID', 'VITE_CLOUDFLARE_ACCOUNT_ID', 'NEXT_PUBLIC_CLOUDFLARE_ACCOUNT_ID',
    'CLOUDFLARE_API_TOKEN', 'ORVIX_CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_TOKEN', 'CLOUDFLARE_API_KEY', 'VITE_CLOUDFLARE_API_TOKEN', 'NEXT_PUBLIC_CLOUDFLARE_API_TOKEN',
    'SUPABASE_URL', 'ORVIX_SUPABASE_URL', 'VITE_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL'
  ];

  const backup = {};
  for (const k of keysToClear) {
    backup[k] = process.env[k];
    delete process.env[k];
  }

  try {
    process.env.VITE_GEMINI_API_KEY = 'leaked_vite_gemini_key';
    process.env.NEXT_PUBLIC_GEMINI_API_KEY = 'leaked_next_gemini_key';
    process.env.REACT_APP_GEMINI_API_KEY = 'leaked_react_gemini_key';

    process.env.VITE_GROQ_API_KEY = 'gsk_leaked_vite';
    process.env.NEXT_PUBLIC_GROQ_API_KEY = 'gsk_leaked_next';
    process.env.REACT_APP_GROQ_API_KEY = 'gsk_leaked_react';

    process.env.VITE_OPENROUTER_API_KEY = 'sk-or-leaked_vite';
    process.env.NEXT_PUBLIC_OPENROUTER_API_KEY = 'sk-or-leaked_next';
    process.env.REACT_APP_OPENROUTER_API_KEY = 'sk-or-leaked_react';

    process.env.VITE_CLOUDFLARE_ACCOUNT_ID = 'cf_vite_acct';
    process.env.NEXT_PUBLIC_CLOUDFLARE_API_TOKEN = 'cf_next_token';
    process.env.VITE_SUPABASE_URL = 'https://vite-leak.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://next-leak.supabase.co';

    assert.equal(getGeminiApiKey(), '');
    assert.equal(getGroqApiKey(), '');
    assert.equal(getOpenRouterApiKey(), '');
    assert.deepEqual(getCloudflareCredentials(), { accountId: '', apiToken: '' });
    assert.equal(getSupabaseUrl(), '');
    assert.equal(resolveEnvCredential('VITE_GEMINI_API_KEY', 'NEXT_PUBLIC_GROQ_API_KEY', 'REACT_APP_OPENROUTER_API_KEY'), '');

    // imageOcrService must also ignore VITE_GEMINI_API_KEY
    const ocrRes = await extractImageTextWithGeminiVision(Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'image/png', null, 'eng');
    assert.equal(ocrRes, null);

    // Server-side approved env vars must resolve cleanly and not leak via /api/config
    process.env.GEMINI_API_KEY = 'server_only_gemini_secret_abc123';
    process.env.ORVIX_GROQ_API_KEY = 'gsk_server_only_groq_secret_abc123';
    process.env.ORVIX_OPENROUTER_API_KEY = 'sk-or-server_only_secret_abc123';

    assert.equal(getGeminiApiKey(), 'server_only_gemini_secret_abc123');
    assert.equal(getGroqApiKey(), 'gsk_server_only_groq_secret_abc123');
    assert.equal(getOpenRouterApiKey(), 'sk-or-server_only_secret_abc123');

    const srv = http.createServer(app);
    await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
    try {
      const port = srv.address().port;
      const resp = await fetch(`http://127.0.0.1:${port}/api/config`);
      assert.equal(resp.status, 200);
      const bodyText = await resp.text();
      assert.equal(bodyText.includes('server_only_gemini_secret_abc123'), false);
      assert.equal(bodyText.includes('gsk_server_only_groq_secret_abc123'), false);
      assert.equal(bodyText.includes('sk-or-server_only_secret_abc123'), false);
      assert.equal(bodyText.includes('leaked_vite_gemini_key'), false);
    } finally {
      await new Promise((resolve) => srv.close(resolve));
    }
  } finally {
    for (const k of keysToClear) {
      if (backup[k] !== undefined) process.env[k] = backup[k];
      else delete process.env[k];
    }
  }
});

// ---------------------------------------------------------------------------
// 2. ORVIX-SUPABASE-FINAL-001: Durable Upload Ticket Persistence (Fail Closed)
// ---------------------------------------------------------------------------
await runTest('ORVIX-SUPABASE-FINAL-001: fails closed on production Firestore errors across all ticket operations', async () => {
  resetDirectUploadTicketsForTesting();
  resetFirestoreForTesting();

  const failingDb = {
    collection() {
      return {
        doc() {
          return {
            async set() { throw new Error('Simulated Firestore write failure'); },
            async get() { throw new Error('Simulated Firestore read failure'); },
            async delete() { throw new Error('Simulated Firestore delete failure'); }
          };
        },
        where() {
          return {
            async get() { throw new Error('Simulated Firestore query failure'); }
          };
        },
        async get() {
          throw new Error('Simulated Firestore query failure');
        }
      };
    },
    async runTransaction() {
      throw new Error('Simulated Firestore transaction failure');
    }
  };

  setForceProductionModeForTesting(true);
  setFirestoreForTesting(failingDb);

  const sampleTicket = {
    attachmentId: 'att_fail_closed_1',
    userId: 'user_prod_1',
    chatId: 'chat_prod_1',
    storagePath: 'user_prod_1/chat_prod_1/att_fail_closed_1.txt',
    bucket: 'orvix-attachments',
    fileName: 'doc.txt',
    extension: 'TXT',
    mimeType: 'text/plain',
    size: 100,
    quotaReservation: {
      reservationId: 'res_1',
      identityKey: 'auth_test',
      utcDay: '2026-11-14',
      expiresAt: Date.now() + 60_000,
      createdAt: Date.now()
    },
    expiresAt: Date.now() + 60_000,
    createdAt: Date.now()
  };

  try {
    // Even if in-memory cache somehow contains a stale entry, production must NEVER use it
    pendingDirectUploads.set(sampleTicket.attachmentId, { ...sampleTicket, status: 'pending' });

    await assert.rejects(() => createDurableUploadTicket(sampleTicket), /Simulated Firestore write failure/);
    await assert.rejects(() => getDurableUploadTicket(sampleTicket.attachmentId), /Simulated Firestore read failure/);

    const claimRes = await claimDirectUploadTicketForCompletion(
      sampleTicket.attachmentId,
      sampleTicket.userId,
      sampleTicket.chatId
    );
    assert.equal(claimRes.success, false);
    assert.equal(claimRes.status, 500);
    assert.equal(claimRes.code, 'TRANSACTION_ERROR');

    await assert.rejects(() => finalizeCompletedDirectUploadTicket(sampleTicket.attachmentId), /Simulated Firestore write failure/);
    await assert.rejects(() => failAndCleanupDurableUploadTicket(sampleTicket, 'TEST_ERR'), /Simulated Firestore write failure/);

    const cancelRes = await cancelDurableUploadTicket(sampleTicket.attachmentId, sampleTicket.userId);
    assert.equal(cancelRes.success, false);
    assert.equal(cancelRes.cancelled, false);
    assert.equal(cancelRes.status, 500);
    assert.equal(cancelRes.code, 'CANCEL_FAILED');

    await assert.rejects(() => pruneExpiredDirectUploadTickets(), /Simulated Firestore query failure/);
  } finally {
    pendingDirectUploads.clear();
    resetFirestoreForTesting();
    resetDirectUploadTicketsForTesting();
  }
});

await runTest('ORVIX-SUPABASE-FINAL-001: HTTP /direct/signed-url and /direct/cancel fail closed & release quota when Firestore ticket write fails in production', async () => {
  resetDirectUploadTicketsForTesting();
  resetFirestoreForTesting();
  resetFirebaseAuthForTesting();

  const TEST_KID = 'audit-001-ticket-kid';
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  setTestPublicKey(TEST_KID, publicKey);

  const uid = 'prod_ticket_fail_user_' + crypto.randomUUID().slice(0, 8);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: TEST_KID })).toString('base64url');
  const nowSec = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    aud: 'orvix-audit-001-030-test',
    iss: 'https://securetoken.google.com/orvix-audit-001-030-test',
    sub: uid,
    user_id: uid,
    auth_time: nowSec,
    iat: nowSec,
    exp: nowSec + 3600
  })).toString('base64url');
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url');
  const token = `${header}.${payload}.${sig}`;

  // Backing store works for uploadQuotas so quota reservation succeeds & can be verified released,
  // while uploadTickets throws to simulate Firestore ticket persistence outage.
  const store = new Map();
  const selectiveFailingDb = {
    collection(colName) {
      return {
        doc(docId) {
          const docPath = `${colName}/${docId}`;
          return {
            path: docPath,
            id: docId,
            async get() {
              if (colName === 'uploadTickets') throw new Error('uploadTickets read failed');
              const cur = store.get(docPath);
              return cur
                ? { exists: true, id: docId, data: () => JSON.parse(JSON.stringify(cur.data)) }
                : { exists: false, id: docId, data: () => undefined };
            },
            async set(data, opts = {}) {
              if (colName === 'uploadTickets') throw new Error('uploadTickets write failed');
              const cur = store.get(docPath);
              const next = opts?.merge && cur ? { ...cur.data, ...data } : data;
              store.set(docPath, { data: JSON.parse(JSON.stringify(next)), version: (cur?.version || 0) + 1 });
            },
            async delete() {
              store.delete(docPath);
            }
          };
        },
        where() {
          return {
            async get() { return { docs: [] }; }
          };
        }
      };
    },
    async runTransaction(fn) {
      const pending = new Map();
      const tx = {
        async get(ref) {
          const cur = store.get(ref.path);
          return cur
            ? { exists: true, id: ref.id, data: () => JSON.parse(JSON.stringify(cur.data)) }
            : { exists: false, id: ref.id, data: () => undefined };
        },
        set(ref, data, opts = {}) {
          const cur = store.get(ref.path);
          const next = opts?.merge && cur ? { ...cur.data, ...data } : data;
          pending.set(ref.path, JSON.parse(JSON.stringify(next)));
          return tx;
        }
      };
      const out = await fn(tx);
      for (const [p, v] of pending.entries()) {
        store.set(p, { data: v, version: (store.get(p)?.version || 0) + 1 });
      }
      return out;
    }
  };

  const mockSupabase = {
    storage: {
      from(bucket) {
        return {
          async createSignedUploadUrl(p) {
            return { data: { signedUrl: `https://mock.supabase.co/sign/${bucket}/${p}`, token: 't', path: p }, error: null };
          }
        };
      },
      async getBucket(name) { return { data: { name, public: false }, error: null }; }
    }
  };

  setForceProductionModeForTesting(true);
  setFirestoreForTesting(selectiveFailingDb);
  setSupabaseServerClientForTesting(mockSupabase);

  const srv = http.createServer(app);
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));

  try {
    const port = srv.address().port;
    const signResp = await fetch(`http://127.0.0.1:${port}/api/upload/direct/signed-url`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        chatId: 'chat_ticket_fail',
        fileName: 'report.txt',
        fileSize: 256
      })
    });
    assert.equal(signResp.status, 503);
    const signJson = await signResp.json();
    assert.equal(signJson.code, 'TICKET_PERSISTENCE_UNAVAILABLE');

    // Quota reservation MUST have been released so user isn't penalized for persistence outage
    const quotaIdentity = {
      type: 'auth',
      id: uid,
      key: 'auth_' + crypto.createHash('sha256').update(uid).digest('hex')
    };
    const quotaStatus = await getQuotaStatus(quotaIdentity);
    assert.equal(quotaStatus.activeReservations, 0, 'Reserved quota slot must be released on ticket persistence failure');
    assert.equal(quotaStatus.remaining, quotaStatus.limit);

    // /api/upload/direct/cancel must return HTTP 500 when Firestore fails in production (NOT 200)
    const cancelResp = await fetch(`http://127.0.0.1:${port}/api/upload/direct/cancel`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ attachmentId: 'att_does_not_matter' })
    });
    assert.equal(cancelResp.status, 500);
    const cancelJson = await cancelResp.json();
    assert.equal(cancelJson.code, 'CANCEL_FAILED');
  } finally {
    await new Promise((resolve) => srv.close(resolve));
    clearTestPublicKeys();
    resetFirebaseAuthForTesting();
    resetSupabaseClientForTesting();
    resetFirestoreForTesting();
    resetDirectUploadTicketsForTesting();
  }
});

// ---------------------------------------------------------------------------
// 3. ORVIX-AUD-030: Firestore Shared Chat Validation
// ---------------------------------------------------------------------------
function hasAll(obj, keys) {
  return keys.every((k) => Object.prototype.hasOwnProperty.call(obj, k));
}
function hasOnly(obj, keys) {
  const allowed = new Set(keys);
  return Object.keys(obj).every((k) => allowed.has(k));
}
function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);
}
function isValidChatModeRule(mode) {
  return ['general', 'coding', 'writing', 'learning'].includes(mode);
}
function isValidOptionalStringRule(val, maxLen) {
  return val === null || (typeof val === 'string' && val.length <= maxLen);
}
function isValidNonNegNumOrNullRule(val) {
  return val === null || (typeof val === 'number' && Number.isFinite(val) && val >= 0);
}
function isValidStringList10Rule(items, maxLen) {
  if (!Array.isArray(items) || items.length > 10) return false;
  for (let i = 0; i < 10; i++) {
    if (!(items.length <= i || (typeof items[i] === 'string' && items[i].length <= maxLen))) return false;
  }
  return true;
}
function isValidSharedExtractionRule(ext) {
  const allowed = [
    'status', 'type', 'format', 'text', 'charCount', 'wordCount',
    'totalWords', 'totalCharacters', 'lineCount', 'confidence',
    'hasText', 'truncated', 'warnings'
  ];
  return (
    isPlainObject(ext) &&
    hasOnly(ext, allowed) &&
    (!('status' in ext) || isValidOptionalStringRule(ext.status, 64)) &&
    (!('type' in ext) || isValidOptionalStringRule(ext.type, 64)) &&
    (!('format' in ext) || isValidOptionalStringRule(ext.format, 32)) &&
    (!('text' in ext) || isValidOptionalStringRule(ext.text, 50000)) &&
    (!('charCount' in ext) || isValidNonNegNumOrNullRule(ext.charCount)) &&
    (!('wordCount' in ext) || isValidNonNegNumOrNullRule(ext.wordCount)) &&
    (!('totalWords' in ext) || isValidNonNegNumOrNullRule(ext.totalWords)) &&
    (!('totalCharacters' in ext) || isValidNonNegNumOrNullRule(ext.totalCharacters)) &&
    (!('lineCount' in ext) || isValidNonNegNumOrNullRule(ext.lineCount)) &&
    (!('confidence' in ext) || isValidNonNegNumOrNullRule(ext.confidence)) &&
    (!('hasText' in ext) || ext.hasText === null || typeof ext.hasText === 'boolean') &&
    (!('truncated' in ext) || ext.truncated === null || typeof ext.truncated === 'boolean') &&
    (!('warnings' in ext) || ext.warnings === null || isValidStringList10Rule(ext.warnings, 200))
  );
}
function isValidSharedAttachmentItemRule(att) {
  const allowed = [
    'id', 'name', 'originalName', 'size', 'type',
    'extension', 'format', 'category', 'uploadedAt', 'extraction'
  ];
  return (
    isPlainObject(att) &&
    hasAll(att, ['id', 'name', 'size', 'type']) &&
    hasOnly(att, allowed) &&
    typeof att.id === 'string' && att.id.length > 0 && att.id.length <= 128 &&
    typeof att.name === 'string' && att.name.length > 0 && att.name.length <= 255 &&
    (!('originalName' in att) || isValidOptionalStringRule(att.originalName, 255)) &&
    typeof att.size === 'number' && Number.isFinite(att.size) && att.size >= 0 &&
    typeof att.type === 'string' && att.type.length > 0 && att.type.length <= 128 &&
    (!('extension' in att) || isValidOptionalStringRule(att.extension, 32)) &&
    (!('format' in att) || isValidOptionalStringRule(att.format, 32)) &&
    (!('category' in att) || isValidOptionalStringRule(att.category, 32)) &&
    (!('uploadedAt' in att) || isValidOptionalStringRule(att.uploadedAt, 64)) &&
    (!('extraction' in att) || att.extraction === null || isValidSharedExtractionRule(att.extraction))
  );
}
function isValidSharedAttachmentsListRule(atts) {
  if (!Array.isArray(atts) || atts.length > 20) return false;
  for (let i = 0; i < 20; i++) {
    if (!(atts.length <= i || isValidSharedAttachmentItemRule(atts[i]))) return false;
  }
  return true;
}
function isValidSharedAlternativeItemRule(alt) {
  const allowed = [
    'id', 'content', 'modelUsed', 'provider', 'mode',
    'responseTimeMs', 'createdAtMs', 'clientTimestamp',
    'timestamp', 'parentMessageId', 'sender'
  ];
  return (
    isPlainObject(alt) &&
    hasAll(alt, ['id', 'content']) &&
    hasOnly(alt, allowed) &&
    typeof alt.id === 'string' && alt.id.length > 0 && alt.id.length <= 128 &&
    typeof alt.content === 'string' && alt.content.length <= 100000 &&
    (!('modelUsed' in alt) || isValidOptionalStringRule(alt.modelUsed, 120)) &&
    (!('provider' in alt) || isValidOptionalStringRule(alt.provider, 64)) &&
    (!('mode' in alt) || alt.mode === null || isValidChatModeRule(alt.mode)) &&
    (!('responseTimeMs' in alt) || isValidNonNegNumOrNullRule(alt.responseTimeMs)) &&
    (!('createdAtMs' in alt) || isValidNonNegNumOrNullRule(alt.createdAtMs)) &&
    (!('clientTimestamp' in alt) || isValidOptionalStringRule(alt.clientTimestamp, 64)) &&
    (!('timestamp' in alt) || isValidOptionalStringRule(alt.timestamp, 64)) &&
    (!('parentMessageId' in alt) || isValidOptionalStringRule(alt.parentMessageId, 128)) &&
    (!('sender' in alt) || alt.sender === null || ['user', 'assistant'].includes(alt.sender))
  );
}
function isValidSharedAlternativesListRule(alts) {
  if (!Array.isArray(alts) || alts.length > 20) return false;
  for (let i = 0; i < 20; i++) {
    if (!(alts.length <= i || isValidSharedAlternativeItemRule(alts[i]))) return false;
  }
  return true;
}
function isValidSharedMessageItemRule(msg) {
  const allowed = [
    'id', 'sender', 'content', 'modelUsed', 'provider', 'mode',
    'responseTimeMs', 'parentMessageId', 'interactionId', 'activeAlternativeId',
    'alternatives', 'attachments', 'referencedAttachments',
    'createdAtMs', 'clientTimestamp', 'timestamp'
  ];
  return (
    isPlainObject(msg) &&
    hasAll(msg, ['id', 'sender', 'content']) &&
    hasOnly(msg, allowed) &&
    typeof msg.id === 'string' && msg.id.length > 0 && msg.id.length <= 128 &&
    ['user', 'assistant'].includes(msg.sender) &&
    typeof msg.content === 'string' && msg.content.length <= 100000 &&
    (msg.content.length > 0 ||
      (Array.isArray(msg.attachments) && msg.attachments.length > 0) ||
      (Array.isArray(msg.referencedAttachments) && msg.referencedAttachments.length > 0)) &&
    (!('modelUsed' in msg) || isValidOptionalStringRule(msg.modelUsed, 120)) &&
    (!('provider' in msg) || isValidOptionalStringRule(msg.provider, 64)) &&
    (!('mode' in msg) || msg.mode === null || isValidChatModeRule(msg.mode)) &&
    (!('responseTimeMs' in msg) || isValidNonNegNumOrNullRule(msg.responseTimeMs)) &&
    (!('parentMessageId' in msg) || isValidOptionalStringRule(msg.parentMessageId, 128)) &&
    (!('interactionId' in msg) || isValidOptionalStringRule(msg.interactionId, 128)) &&
    (!('activeAlternativeId' in msg) || isValidOptionalStringRule(msg.activeAlternativeId, 128)) &&
    (!('alternatives' in msg) || msg.alternatives === null || isValidSharedAlternativesListRule(msg.alternatives)) &&
    (!('attachments' in msg) || msg.attachments === null || isValidSharedAttachmentsListRule(msg.attachments)) &&
    (!('referencedAttachments' in msg) || msg.referencedAttachments === null || isValidSharedAttachmentsListRule(msg.referencedAttachments)) &&
    (!('createdAtMs' in msg) || isValidNonNegNumOrNullRule(msg.createdAtMs)) &&
    (!('clientTimestamp' in msg) || isValidOptionalStringRule(msg.clientTimestamp, 64)) &&
    (!('timestamp' in msg) || isValidOptionalStringRule(msg.timestamp, 64))
  );
}
function evaluateSharedChatCreateRule({ auth, shareId, data }) {
  const isNonAnonymous =
    auth !== null &&
    auth.token != null &&
    auth.token.isAnonymous !== true &&
    auth.token.firebase?.sign_in_provider !== 'anonymous';
  if (!isNonAnonymous) return false;
  if (typeof shareId !== 'string' || shareId.length < 12 || shareId.length > 128 || !/^[a-zA-Z0-9_-]+$/.test(shareId)) return false;
  if (!isPlainObject(data)) return false;
  const topKeys = ['id', 'title', 'mode', 'createdAt', 'messageCount', 'messages'];
  if (!hasAll(data, topKeys) || !hasOnly(data, topKeys)) return false;
  if (data.id !== shareId) return false;
  if (typeof data.title !== 'string' || data.title.length === 0 || data.title.length > 120) return false;
  if (!isValidChatModeRule(data.mode)) return false;
  if (!(data.createdAt instanceof Date)) return false;
  if (!Number.isInteger(data.messageCount) || data.messageCount < 1 || data.messageCount > 500) return false;
  if (!Array.isArray(data.messages) || data.messages.length < 1 || data.messages.length > 500) return false;
  if (data.messageCount !== data.messages.length) return false;
  for (let i = 0; i < data.messages.length; i++) {
    if (!isValidSharedMessageItemRule(data.messages[i])) return false;
  }
  return true;
}

await runTest('ORVIX-AUD-030: firestore.rules validates all messages and nested fields (not just first and last)', () => {
  const rulesSrc = fs.readFileSync(path.join(ROOT_DIR, 'firestore.rules'), 'utf8');

  // Structural verification of firestore.rules
  assert.ok(rulesSrc.includes('isValidSharedMessagesList(request.resource.data.messages)'));
  assert.equal(rulesSrc.includes('isValidSharedMessageItem(request.resource.data.messages[0])'), false);
  assert.equal(rulesSrc.includes('messages[request.resource.data.messages.size() - 1]'), false);
  assert.ok(rulesSrc.includes('function isValidSharedMessageGroup50(msgs, offset)'));
  assert.ok(rulesSrc.includes('function isValidSharedMessageChunk10(msgs, offset)'));
  assert.ok(rulesSrc.includes('function isValidSharedAttachmentsList(atts)'));
  assert.ok(rulesSrc.includes('function isValidSharedAlternativesList(alts)'));
  assert.ok(rulesSrc.includes('function isValidSharedExtraction(ext)'));
  assert.ok(rulesSrc.includes('allow get: if true;'));
  assert.ok(rulesSrc.includes('allow list: if false;'));
  assert.ok(rulesSrc.includes('allow update, delete: if false;'));

  const validAuth = { uid: 'user_123', token: { isAnonymous: false, firebase: { sign_in_provider: 'password' } } };
  const shareId = 'validShareId_0123456789';

  // Legitimate snapshot generated by buildValidatedSharedSnapshot (with nullable fields, attachments+extraction+warnings, alternatives, attachment-only prompt)
  const { documentData } = buildValidatedSharedSnapshot({
    shareId,
    chat: { id: 'chat_1', title: 'Valid Shared Snapshot', mode: 'coding' },
    messages: [
      {
        id: 'm1',
        sender: 'user',
        content: '',
        attachments: [
          {
            id: 'att_1',
            name: 'notes.pdf',
            size: 1024,
            type: 'application/pdf',
            extension: 'PDF',
            extraction: { status: 'ready', text: 'Parsed PDF text', totalWords: 3, warnings: ['Minor OCR skip'] }
          }
        ]
      },
      {
        id: 'm2',
        sender: 'assistant',
        content: 'Initial response',
        provider: 'gemini',
        modelUsed: 'gemini-2.5-flash',
        responseTimeMs: 420,
        parentMessageId: 'm1',
        interactionId: 'int_1',
        activeAlternativeId: 'alt_1',
        alternatives: [
          { id: 'alt_1', content: 'Initial response', provider: 'gemini', modelUsed: 'gemini-2.5-flash', responseTimeMs: 420 },
          { id: 'alt_2', content: 'Alternative answer', provider: 'groq', modelUsed: 'llama-3.3-70b', responseTimeMs: 300 }
        ]
      },
      { id: 'm3', sender: 'user', content: 'Thanks!' }
    ]
  });

  const firestorePayload = { ...documentData, createdAt: new Date() };
  assert.equal(evaluateSharedChatCreateRule({ auth: validAuth, shareId, data: firestorePayload }), true);

  // Anonymous or unauthenticated create must be denied
  assert.equal(evaluateSharedChatCreateRule({ auth: null, shareId, data: firestorePayload }), false);
  assert.equal(
    evaluateSharedChatCreateRule({
      auth: { uid: 'anon', token: { firebase: { sign_in_provider: 'anonymous' } } },
      shareId,
      data: firestorePayload
    }),
    false
  );

  // Middle message [1] injected with malicious extra field must be REJECTED
  const injectedMiddle = structuredClone(firestorePayload);
  injectedMiddle.messages[1].injectedHtml = '<script>alert(1)</script>';
  assert.equal(evaluateSharedChatCreateRule({ auth: validAuth, shareId, data: injectedMiddle }), false);

  // Middle message [1] with invalid sender must be REJECTED
  const badSenderMiddle = structuredClone(firestorePayload);
  badSenderMiddle.messages[1].sender = 'system';
  assert.equal(evaluateSharedChatCreateRule({ auth: validAuth, shareId, data: badSenderMiddle }), false);

  // Attachment with forbidden dataUrl / base64 must be REJECTED
  const badAttachment = structuredClone(firestorePayload);
  badAttachment.messages[0].attachments[0].dataUrl = 'data:text/html,<script>';
  assert.equal(evaluateSharedChatCreateRule({ auth: validAuth, shareId, data: badAttachment }), false);

  // Nested extraction extra field or >10 warnings must be REJECTED
  const badExtraction = structuredClone(firestorePayload);
  badExtraction.messages[0].attachments[0].extraction.diskPath = '/etc/passwd';
  assert.equal(evaluateSharedChatCreateRule({ auth: validAuth, shareId, data: badExtraction }), false);

  const tooManyWarnings = structuredClone(firestorePayload);
  tooManyWarnings.messages[0].attachments[0].extraction.warnings = Array.from({ length: 11 }, (_, i) => `w${i}`);
  assert.equal(evaluateSharedChatCreateRule({ auth: validAuth, shareId, data: tooManyWarnings }), false);

  // Alternative with forbidden extra key or >20 alternatives must be REJECTED
  const badAlt = structuredClone(firestorePayload);
  badAlt.messages[1].alternatives[1].evilField = true;
  assert.equal(evaluateSharedChatCreateRule({ auth: validAuth, shareId, data: badAlt }), false);

  const tooManyAlts = structuredClone(firestorePayload);
  tooManyAlts.messages[1].alternatives = Array.from({ length: 21 }, (_, i) => ({ id: `a_${i}`, content: 'x' }));
  assert.equal(evaluateSharedChatCreateRule({ auth: validAuth, shareId, data: tooManyAlts }), false);

  // Empty message content without attachments must be REJECTED
  const emptyMsg = structuredClone(firestorePayload);
  emptyMsg.messages[2].content = '';
  assert.equal(evaluateSharedChatCreateRule({ auth: validAuth, shareId, data: emptyMsg }), false);

  // messageCount mismatch must be REJECTED
  const countMismatch = structuredClone(firestorePayload);
  countMismatch.messageCount = 2;
  assert.equal(evaluateSharedChatCreateRule({ auth: validAuth, shareId, data: countMismatch }), false);
});

// ---------------------------------------------------------------------------
// 4. ORVIX-AUD-031: Test Runner & Speech Fixture Reliability
// ---------------------------------------------------------------------------
await runTest('ORVIX-AUD-031: speech PCM fixture is valid & runAllTests.js fails non-zero when a suite fails', () => {
  const pcmPath = path.join(ROOT_DIR, 'scripts/fixtures/test_speech_hello_orvix.pcm');
  assert.equal(fs.existsSync(pcmPath), true, 'test_speech_hello_orvix.pcm must exist');
  const buf = fs.readFileSync(pcmPath);
  assert.ok(buf.length >= 16000, `PCM fixture must be >= 16000 bytes, got ${buf.length}`);
  assert.equal(buf.length % 2, 0, '16-bit PCM byte length must be even');

  let sumSq = 0;
  const count = buf.length / 2;
  for (let i = 0; i < count; i++) {
    const sample = buf.readInt16LE(i * 2) / 32768;
    sumSq += sample * sample;
  }
  const rms = Math.sqrt(sumSq / count);
  assert.ok(rms > 0.01, `Speech fixture must be non-silent (rms=${rms})`);

  const runnerPath = path.join(ROOT_DIR, 'scripts/runAllTests.js');
  assert.equal(fs.existsSync(runnerPath), true, 'scripts/runAllTests.js must exist');

  // Verify --list includes core + previously omitted security/audit/share suites
  const listRes = spawnSync('node', [runnerPath, '--list'], { cwd: ROOT_DIR, encoding: 'utf8' });
  assert.equal(listRes.status, 0);
  assert.ok(listRes.stdout.includes('testProductionProviderDetection.js'));
  assert.ok(listRes.stdout.includes('testShareChatStage8.js'));
  assert.ok(listRes.stdout.includes('testAudit001And030.js'));
  assert.ok(listRes.stdout.includes('testUserSettingsFirestoreRulesSchema.js'));

  // Verify runner does NOT silently ignore failures
  const badSuiteRes = spawnSync(
    'node',
    [runnerPath, '--skip-lint', '--only', 'scripts/doesNotExistSuite.js'],
    { cwd: ROOT_DIR, encoding: 'utf8' }
  );
  assert.notEqual(badSuiteRes.status, 0, 'Runner must exit non-zero when a requested/missing suite fails');
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
