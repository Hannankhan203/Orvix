/**
 * scripts/testCompressionAuditFixes.js
 *
 * Focused regression suite verifying fixes for the two Smart Compression audit findings:
 * 1. Multi-instance SIGNED_DECODE_URL_SECRET configuration, startup fail-closed validation,
 *    cross-instance HMAC verification, alias compatibility, and zero secret exposure.
 * 2. Non-image unsupported_format classification and accurate MIME/extension detection
 *    in src/services/documentContextService.js (preventing document<->image misclassification).
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';

process.env.TESTING = '1';
process.env.FIREBASE_PROJECT_ID = 'orvix-audit-fixes-test';

const {
  isSignedDecodeProductionMode,
  resolveConfiguredSignedDecodeUrlSecret,
  validateSignedDecodeUrlSecretValue,
  setForceProductionSignedUrlSecretCheckForTesting
} = await import('../server/serverConfig.ts');

const {
  getSignedDecodeUrlSecret,
  validateSignedDecodeUrlConfiguration,
  resetDevSignedDecodeUrlSecretForTesting,
  fileRegistry,
  resetDirectUploadTicketsForTesting
} = await import('../server/uploadSubsystem.ts');

const {
  setTestPublicKey,
  clearTestPublicKeys,
  resetFirebaseAuthForTesting
} = await import('../server/firebaseAuthHelper.ts');

const {
  setSupabaseServerClientForTesting,
  resetSupabaseClientForTesting
} = await import('../server/supabaseClient.ts');

const {
  resetQuotaForTesting
} = await import('../server/uploadQuotaService.ts');

const {
  encodeOrvixStorageEnvelope,
  ORVIX_ENVELOPE_ENCODING_ID
} = await import('../src/services/storageEnvelopeService.js');

const {
  extractDocumentContent
} = await import('../src/services/documentExtractor.js');

const {
  extractBrowserDocument
} = await import('../src/services/browserDocumentExtractor.js');

const {
  isImageAttachment,
  resolveAttachmentFormatLabel,
  prepareDocumentContext,
  generateSimulatedDocumentResponse
} = await import('../src/services/documentContextService.js');

const { app } = await import('../server.ts');

let passed = 0;
let failed = 0;

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`  ✅ PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ FAIL: ${name}`);
    console.error(`     ${err?.stack || err?.message || err}`);
    failed++;
  }
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => resolve(addr.port));
    });
    srv.on('error', reject);
  });
}

function buildCleanSpawnEnv(overrides = {}) {
  const env = { ...process.env };
  delete env.TESTING;
  delete env.VERCEL;
  delete env.AWS_LAMBDA_FUNCTION_NAME;
  delete env.LAMBDA_TASK_ROOT;
  delete env.SERVERLESS;
  delete env.ORVIX_SIGNED_URL_SECRET;
  delete env.SIGNED_DECODE_URL_SECRET;
  delete env.SESSION_SECRET;
  return { ...env, ...overrides };
}

function runSubprocessCheck(args, envOverrides, timeoutMs = 15000) {
  return spawnSync('./node_modules/.bin/tsx', args, {
    cwd: process.cwd(),
    env: buildCleanSpawnEnv(envOverrides),
    encoding: 'utf8',
    timeout: timeoutMs
  });
}

const TEST_PROJECT_ID = 'orvix-audit-fixes-test';
const TEST_KID = 'audit-fixes-kid-1';

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

function createSignedFirebaseToken(uid) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: TEST_KID })).toString('base64url');
  const nowSec = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    aud: TEST_PROJECT_ID,
    iss: `https://securetoken.google.com/${TEST_PROJECT_ID}`,
    sub: uid,
    user_id: uid,
    auth_time: nowSec,
    iat: nowSec,
    exp: nowSec + 3600
  })).toString('base64url');
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url');
  return `${header}.${payload}.${sig}`;
}

function createMockSupabase(objectsMap) {
  const storageApi = {
    from(bucket) {
      return {
        async createBucket() {
          return { data: { name: bucket }, error: null };
        },
        async getBucket() {
          return { data: { id: bucket, name: bucket, public: false }, error: null };
        },
        async upload(storagePath, body) {
          const buf = Buffer.isBuffer(body) ? Buffer.from(body) : Buffer.from(body);
          objectsMap.set(storagePath, { buffer: buf, contentType: 'application/octet-stream' });
          return { data: { path: storagePath }, error: null };
        },
        async download(storagePath) {
          const entry = objectsMap.get(storagePath);
          if (!entry) return { data: null, error: { message: 'Object not found', statusCode: '404' } };
          return { data: new Blob([entry.buffer], { type: entry.contentType }), error: null };
        },
        async createSignedUploadUrl(storagePath) {
          return {
            data: { signedUrl: `https://mock.supabase.local/upload/${storagePath}`, token: 'tok', path: storagePath },
            error: null
          };
        },
        async createSignedUrl(storagePath, expiresIn) {
          return {
            data: { signedUrl: `https://mock.supabase.local/object/sign/${bucket}/${storagePath}?expiresIn=${expiresIn}` },
            error: null
          };
        },
        async remove(paths) {
          for (const p of paths || []) objectsMap.delete(p);
          return { data: [], error: null };
        },
        async list(prefix = '') {
          const normalized = prefix ? (prefix.endsWith('/') ? prefix : `${prefix}/`) : '';
          const names = new Map();
          for (const k of objectsMap.keys()) {
            if (!normalized || k.startsWith(normalized)) {
              const rest = normalized ? k.slice(normalized.length) : k;
              const seg = rest.split('/')[0];
              if (seg) names.set(seg, { name: seg, id: rest.includes('/') ? null : seg });
            }
          }
          return { data: Array.from(names.values()), error: null };
        }
      };
    }
  };
  return { storage: storageApi };
}

console.log('===============================================================');
console.log('ORVIX SMART COMPRESSION AUDIT FIXES VERIFICATION SUITE');
console.log('===============================================================\n');

console.log('--- PART 1: Multi-Instance SIGNED_DECODE_URL_SECRET Configuration ---');

await runTest('1.1 Secret validator rejects missing, placeholder, short, and low-entropy values without leaking them', async () => {
  assert.equal(validateSignedDecodeUrlSecretValue('').valid, false);
  assert.equal(validateSignedDecodeUrlSecretValue('   ').valid, false);
  assert.equal(validateSignedDecodeUrlSecretValue('changeme').reason, 'placeholder');
  assert.equal(validateSignedDecodeUrlSecretValue('your_production_signed_url_secret_here').reason, 'placeholder');
  assert.equal(validateSignedDecodeUrlSecretValue('secret').reason, 'placeholder');

  const shortSecret = 'short-secret-value-12345';
  const shortRes = validateSignedDecodeUrlSecretValue(shortSecret);
  assert.equal(shortRes.valid, false);
  assert.equal(shortRes.reason, 'too_short');
  assert.equal(shortRes.detail.includes(shortSecret), false, 'Validation detail must never contain secret');

  const lowEntropy = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const entropyRes = validateSignedDecodeUrlSecretValue(lowEntropy);
  assert.equal(entropyRes.valid, false);
  assert.equal(entropyRes.reason, 'low_entropy');
  assert.equal(entropyRes.detail.includes(lowEntropy), false);

  const quoted = '  "valid-shared-secret-key-0123456789abcdef"  ';
  const validRes = validateSignedDecodeUrlSecretValue(quoted);
  assert.equal(validRes.valid, true);
  assert.equal(validRes.secret, 'valid-shared-secret-key-0123456789abcdef');
});

await runTest('1.2 Forced production check fails closed on missing/invalid secret and accepts primary + alias secrets', async () => {
  const prev = {
    ORVIX_SIGNED_URL_SECRET: process.env.ORVIX_SIGNED_URL_SECRET,
    SIGNED_DECODE_URL_SECRET: process.env.SIGNED_DECODE_URL_SECRET,
    SESSION_SECRET: process.env.SESSION_SECRET
  };

  try {
    delete process.env.ORVIX_SIGNED_URL_SECRET;
    delete process.env.SIGNED_DECODE_URL_SECRET;
    delete process.env.SESSION_SECRET;
    resetDevSignedDecodeUrlSecretForTesting();
    setForceProductionSignedUrlSecretCheckForTesting(true);
    assert.equal(isSignedDecodeProductionMode(), true);

    assert.throws(
      () => validateSignedDecodeUrlConfiguration(),
      (err) => err?.code === 'SIGNED_URL_SECRET_INVALID' && err.message.includes('ORVIX_SIGNED_URL_SECRET')
    );

    const leakedCandidate = 'too-short-secret-value-99';
    process.env.ORVIX_SIGNED_URL_SECRET = leakedCandidate;
    assert.throws(
      () => getSignedDecodeUrlSecret(),
      (err) =>
        err?.code === 'SIGNED_URL_SECRET_INVALID' &&
        !err.message.includes(leakedCandidate) &&
        err.message.includes('ORVIX_SIGNED_URL_SECRET')
    );

    // Primary env var
    delete process.env.ORVIX_SIGNED_URL_SECRET;
    process.env.SESSION_SECRET = 'legacy-session-secret-0123456789abcdef';
    assert.equal(getSignedDecodeUrlSecret(), 'legacy-session-secret-0123456789abcdef');
    assert.equal(resolveConfiguredSignedDecodeUrlSecret().sourceKey, 'SESSION_SECRET');

    process.env.SIGNED_DECODE_URL_SECRET = 'alias-decode-secret-0123456789abcdef';
    assert.equal(getSignedDecodeUrlSecret(), 'alias-decode-secret-0123456789abcdef');
    assert.equal(resolveConfiguredSignedDecodeUrlSecret().sourceKey, 'SIGNED_DECODE_URL_SECRET');

    process.env.ORVIX_SIGNED_URL_SECRET = 'primary-orvix-secret-0123456789abcdef';
    assert.equal(getSignedDecodeUrlSecret(), 'primary-orvix-secret-0123456789abcdef');
    assert.equal(resolveConfiguredSignedDecodeUrlSecret().sourceKey, 'ORVIX_SIGNED_URL_SECRET');
  } finally {
    setForceProductionSignedUrlSecretCheckForTesting(null);
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

await runTest('1.3 Real standalone NODE_ENV=production startup fails safely when secret is missing or invalid', async () => {
  const missingPort = await getFreePort();
  const missingRes = runSubprocessCheck(['server.ts'], {
    NODE_ENV: 'production',
    PORT: String(missingPort)
  });
  assert.notEqual(missingRes.status, 0, 'Production startup without secret must exit non-zero');
  const missingOutput = `${missingRes.stdout}\n${missingRes.stderr}`;
  assert.ok(
    missingOutput.includes('ORVIX_SIGNED_URL_SECRET'),
    `Expected missing secret error mentioning ORVIX_SIGNED_URL_SECRET, got: ${missingOutput}`
  );
  assert.equal(missingOutput.includes('Orvix server running'), false, 'Server must not bind port on missing secret');

  const shortSecret = 'bad-short-secret-123';
  const shortPort = await getFreePort();
  const shortRes = runSubprocessCheck(['server.ts'], {
    NODE_ENV: 'production',
    PORT: String(shortPort),
    ORVIX_SIGNED_URL_SECRET: shortSecret
  });
  assert.notEqual(shortRes.status, 0, 'Production startup with short secret must exit non-zero');
  const shortOutput = `${shortRes.stdout}\n${shortRes.stderr}`;
  assert.equal(shortOutput.includes(shortSecret), false, 'Startup error logs must NEVER expose configured secret');

  const placeholderSecret = 'your_production_signed_url_secret_here';
  const phPort = await getFreePort();
  const phRes = runSubprocessCheck(['server.ts'], {
    NODE_ENV: 'production',
    PORT: String(phPort),
    ORVIX_SIGNED_URL_SECRET: placeholderSecret
  });
  assert.notEqual(phRes.status, 0, 'Production startup with placeholder secret must exit non-zero');
  assert.equal(`${phRes.stdout}\n${phRes.stderr}`.includes(placeholderSecret), false);
});

await runTest('1.4 Real Vercel serverless cold start fails safely without secret and succeeds with valid secret', async () => {
  const failRes = runSubprocessCheck(
    ['-e', "import('./api/upload.ts').then(() => { console.log('SHOULD_NOT_BOOT'); })"],
    { VERCEL: '1', NODE_ENV: 'production' }
  );
  assert.notEqual(failRes.status, 0, 'Serverless cold start without secret must fail safely');
  assert.equal(`${failRes.stdout}\n${failRes.stderr}`.includes('SHOULD_NOT_BOOT'), false);

  const validSecret = 'serverless-shared-secret-0123456789abcdef';
  const okRes = runSubprocessCheck(
    ['-e', "import('./api/upload.ts').then(() => { console.log('UPLOAD_BOOT_OK'); })"],
    { VERCEL: '1', NODE_ENV: 'production', ORVIX_SIGNED_URL_SECRET: validSecret }
  );
  assert.equal(okRes.status, 0, `Serverless cold start with valid secret should succeed: ${okRes.stderr}`);
  assert.ok(okRes.stdout.includes('UPLOAD_BOOT_OK'));
});

await runTest('1.5 Two live NODE_ENV=production server instances start cleanly with shared secret & cross-instance HMAC verification succeeds while mismatched secret rejects', async () => {
  const sharedSecret = 'multi-instance-prod-secret-0123456789abcdef-shared';
  const otherSecret = 'different-instance-secret-fedcba9876543210-other';
  const portA = await getFreePort();
  const portB = await getFreePort();

  const spawnProdServer = (port, secret) =>
    spawn('./node_modules/.bin/tsx', ['server.ts'], {
      cwd: process.cwd(),
      env: buildCleanSpawnEnv({
        NODE_ENV: 'production',
        PORT: String(port),
        ORVIX_SIGNED_URL_SECRET: secret
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    });

  const childA = spawnProdServer(portA, sharedSecret);
  const childB = spawnProdServer(portB, sharedSecret);

  const waitHealthy = async (port, child) => {
    const deadline = Date.now() + 15000;
    let logs = '';
    child.stdout.on('data', (d) => { logs += d.toString(); });
    child.stderr.on('data', (d) => { logs += d.toString(); });
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`Child exited early (${child.exitCode}): ${logs}`);
      }
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (res.ok) return;
      } catch (_) {}
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Timed out waiting for server on port ${port}: ${logs}`);
  };

  try {
    await Promise.all([waitHealthy(portA, childA), waitHealthy(portB, childB)]);

    // Cross-process signing & verification with shared Supabase storage payload across separate Node processes
    const originalText = 'Quarterly financial archive line.\n'.repeat(80);
    const envelope = await encodeOrvixStorageEnvelope(Buffer.from(originalText, 'utf8'), {
      extension: '.txt',
      mimeType: 'text/plain'
    });
    assert.equal(envelope.compressed, true);
    const envelopeB64 = Buffer.from(envelope.envelopeBytes).toString('base64');

    const signScript = `(async () => {
      const crypto = await import('node:crypto');
      const http = await import('node:http');
      process.env.TESTING = '1';
      process.env.FIREBASE_PROJECT_ID = '${TEST_PROJECT_ID}';
      const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
      });
      const { setTestPublicKey } = await import('./server/firebaseAuthHelper.ts');
      const { fileRegistry } = await import('./server/uploadSubsystem.ts');
      const { app } = await import('./server.ts');
      setTestPublicKey('${TEST_KID}', publicKey);
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: '${TEST_KID}' })).toString('base64url');
      const now = Math.floor(Date.now() / 1000);
      const payload = Buffer.from(JSON.stringify({
        aud: '${TEST_PROJECT_ID}', iss: 'https://securetoken.google.com/${TEST_PROJECT_ID}',
        sub: 'alice-uid', user_id: 'alice-uid', auth_time: now, iat: now, exp: now + 3600
      })).toString('base64url');
      const sig = crypto.sign('RSA-SHA256', Buffer.from(header + '.' + payload), privateKey).toString('base64url');
      const token = header + '.' + payload + '.' + sig;
      const attId = '11111111-1111-4111-8111-111111111111';
      fileRegistry.set(attId, {
        id: attId,
        userId: 'alice-uid',
        conversationId: 'chat-multi-1',
        originalName: 'notes.txt',
        diskFilename: attId + '.txt',
        mimeType: 'text/plain',
        sizeBytes: ${Buffer.byteLength(originalText)},
        storedSizeBytes: ${envelope.envelopeBytes.length},
        storageEncoding: '${ORVIX_ENVELOPE_ENCODING_ID}',
        storageProvider: 'supabase',
        storagePath: 'alice-uid/chat-multi-1/' + attId + '.txt',
        createdAt: new Date().toISOString(),
        expiresAt: Date.now() + 3600_000
      });
      const srv = http.createServer(app);
      await new Promise((r) => srv.listen(0, '127.0.0.1', r));
      const base = 'http://127.0.0.1:' + srv.address().port;
      const res = await fetch(base + '/api/upload/' + attId + '/signed-url?chatId=chat-multi-1&download=true', {
        headers: { Authorization: 'Bearer ' + token }
      });
      const json = await res.json();
      srv.close();
      console.log(JSON.stringify({ status: res.status, signedUrl: json.signedUrl, decodingProxy: json.decodingProxy }));
    })().catch((err) => { console.error(err); process.exit(1); });`;

    const signOut = runSubprocessCheck(['-e', signScript], {
      ORVIX_SIGNED_URL_SECRET: sharedSecret
    });
    assert.equal(signOut.status, 0, `Instance A signing failed: ${signOut.stderr}`);
    const signedPayload = JSON.parse(signOut.stdout.trim().split('\n').pop());
    assert.equal(signedPayload.status, 200);
    assert.equal(signedPayload.decodingProxy, true);
    assert.equal(signedPayload.signedUrl.includes(sharedSecret), false, 'Signed URL must never expose secret');

    const parsedSignedUrl = new URL(signedPayload.signedUrl);
    const signedPathAndQuery = `${parsedSignedUrl.pathname}${parsedSignedUrl.search}`;

    const verifyScript = (secretForInstance) => `(async () => {
      const http = await import('node:http');
      process.env.TESTING = '1';
      process.env.FIREBASE_PROJECT_ID = '${TEST_PROJECT_ID}';
      process.env.SUPABASE_URL = 'https://mock.supabase.local';
      process.env.SUPABASE_SECRET_KEY = 'mock-secret-key-for-test';
      const { setSupabaseServerClientForTesting } = await import('./server/supabaseClient.ts');
      const { fileRegistry } = await import('./server/uploadSubsystem.ts');
      const { app } = await import('./server.ts');
      const attId = '11111111-1111-4111-8111-111111111111';
      const storagePath = 'alice-uid/chat-multi-1/' + attId + '.txt';
      const buf = Buffer.from('${envelopeB64}', 'base64');
      fileRegistry.clear(); // Simulate cold instance with no local registry
      setSupabaseServerClientForTesting({
        storage: {
          from() {
            return {
              async list(prefix = '') {
                if (prefix.includes('chat-multi-1')) {
                  return { data: [{ name: attId + '.txt', id: attId }], error: null };
                }
                return { data: [], error: null };
              },
              async download(p) {
                if (p === storagePath || p.endsWith(attId + '.txt')) {
                  return { data: new Blob([buf], { type: 'application/octet-stream' }), error: null };
                }
                return { data: null, error: { message: 'Not found', statusCode: '404' } };
              }
            };
          }
        }
      });
      const srv = http.createServer(app);
      await new Promise((r) => srv.listen(0, '127.0.0.1', r));
      const base = 'http://127.0.0.1:' + srv.address().port;
      const res = await fetch(base + ${JSON.stringify(signedPathAndQuery)});
      const text = await res.text();
      srv.close();
      console.log(JSON.stringify({ status: res.status, text, ct: res.headers.get('content-type') }));
    })().catch((err) => { console.error(err); process.exit(1); });`;

    // Instance B with SAME secret succeeds!
    const verifySameOut = runSubprocessCheck(['-e', verifyScript(sharedSecret)], {
      ORVIX_SIGNED_URL_SECRET: sharedSecret
    });
    assert.equal(verifySameOut.status, 0, `Instance B verify failed: ${verifySameOut.stderr}`);
    const verifySame = JSON.parse(verifySameOut.stdout.trim().split('\n').pop());
    assert.equal(verifySame.status, 200, 'Instance B with shared secret must accept & decode signed URL from Instance A');
    assert.equal(verifySame.text, originalText, 'Instance B must return exact original decoded contents');
    assert.ok(verifySame.ct.includes('text/plain'));

    // Instance C with DIFFERENT secret rejects!
    const verifyOtherOut = runSubprocessCheck(['-e', verifyScript(otherSecret)], {
      ORVIX_SIGNED_URL_SECRET: otherSecret
    });
    assert.equal(verifyOtherOut.status, 0, `Instance C check errored: ${verifyOtherOut.stderr}`);
    const verifyOther = JSON.parse(verifyOtherOut.stdout.trim().split('\n').pop());
    assert.equal(verifyOther.status, 403, 'Instance C with mismatched secret must reject with 403');
    assert.equal(verifyOther.text.includes(otherSecret), false);
    assert.equal(verifyOther.text.includes(sharedSecret), false);
  } finally {
    try { childA.kill('SIGKILL'); } catch (_) {}
    try { childB.kill('SIGKILL'); } catch (_) {}
  }
});

await runTest('1.6 Ownership, expiry, and tampered signature checks remain enforced with configured secret', async () => {
  const prevSecret = process.env.ORVIX_SIGNED_URL_SECRET;
  process.env.ORVIX_SIGNED_URL_SECRET = 'inprocess-regression-secret-0123456789abcdef';
  process.env.SUPABASE_URL = 'https://mock.supabase.local';
  process.env.SUPABASE_SECRET_KEY = 'mock-secret-key-for-test';

  resetFirebaseAuthForTesting();
  resetQuotaForTesting();
  resetDirectUploadTicketsForTesting();
  fileRegistry.clear();
  setTestPublicKey(TEST_KID, publicKey);

  const mockObjects = new Map();
  setSupabaseServerClientForTesting(createMockSupabase(mockObjects));

  const srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${srv.address().port}`;

  try {
    const aliceToken = createSignedFirebaseToken('alice-owner');
    const bobToken = createSignedFirebaseToken('bob-intruder');
    const attId = '22222222-2222-4222-8222-222222222222';
    const raw = Buffer.from('Confidential record\n'.repeat(60), 'utf8');
    const env = await encodeOrvixStorageEnvelope(raw, { extension: '.txt', mimeType: 'text/plain' });
    const storagePath = `alice-owner/chat-sec-1/${attId}.txt`;
    mockObjects.set(storagePath, { buffer: Buffer.from(env.envelopeBytes), contentType: 'application/octet-stream' });

    fileRegistry.set(attId, {
      id: attId,
      userId: 'alice-owner',
      conversationId: 'chat-sec-1',
      originalName: 'secret.txt',
      diskFilename: `${attId}.txt`,
      mimeType: 'text/plain',
      sizeBytes: raw.length,
      storedSizeBytes: env.envelopeBytes.length,
      storageEncoding: ORVIX_ENVELOPE_ENCODING_ID,
      storageProvider: 'supabase',
      storagePath,
      createdAt: new Date().toISOString(),
      expiresAt: Date.now() + 3600_000
    });

    const signRes = await fetch(`${baseUrl}/api/upload/${attId}/signed-url?chatId=chat-sec-1`, {
      headers: { Authorization: `Bearer ${aliceToken}` }
    });
    const signJson = await signRes.json();
    assert.equal(signRes.status, 200);
    const localSignedUrl = signJson.signedUrl.replace(/^https?:\/\/[^/]+/, baseUrl);

    // Owner succeeds
    const okRes = await fetch(localSignedUrl);
    assert.equal(okRes.status, 200);
    assert.equal(await okRes.text(), raw.toString('utf8'));

    // Cross-user rejected
    const bobRes = await fetch(localSignedUrl, { headers: { Authorization: `Bearer ${bobToken}` } });
    assert.equal(bobRes.status, 403);

    // Tampered sig rejected
    const badSigUrl = localSignedUrl.replace(/sig=[^&]+/, 'sig=tamperedSigValue');
    const badSigRes = await fetch(badSigUrl);
    assert.equal(badSigRes.status, 403);
    assert.equal((await badSigRes.json()).code, 'INVALID_SIGNED_URL');

    // Expired timestamp rejected (sig won't match tampered exp or expired)
    const expUrl = localSignedUrl.replace(/exp=\d+/, 'exp=1000');
    const expRes = await fetch(expUrl);
    assert.equal(expRes.status, 403);
  } finally {
    srv.close();
    fileRegistry.clear();
    clearTestPublicKeys();
    resetSupabaseClientForTesting();
    if (prevSecret === undefined) delete process.env.ORVIX_SIGNED_URL_SECRET;
    else process.env.ORVIX_SIGNED_URL_SECRET = prevSecret;
  }
});

console.log('\n--- PART 2: Non-image error/corrupted/unsupported_format & MIME/Extension Detection ---');

await runTest('2.1 Server and browser extractors for malformed DOC, PPT, XLS, XLSX produce CORRUPTED and unsupported EXE produces UNSUPPORTED FORMAT (never SCANNED/IMAGE-ONLY)', async () => {
  const serverCases = [
    { name: 'legacy.doc', ext: '.doc', mime: 'application/msword', buf: Buffer.from('D0CF11E0A1B11AE1', 'hex'), expectedFmt: 'DOC', expectedStatus: 'corrupted', expectedHeader: 'STATUS: CORRUPTED' },
    { name: 'slides.ppt', ext: '.ppt', mime: 'application/vnd.ms-powerpoint', buf: Buffer.from('D0CF11E0A1B11AE1', 'hex'), expectedFmt: 'PPT', expectedStatus: 'corrupted', expectedHeader: 'STATUS: CORRUPTED' },
    { name: 'ledger.xls', ext: '.xls', mime: 'application/vnd.ms-excel', buf: Buffer.from('D0CF11E0A1B11AE1', 'hex'), expectedFmt: 'XLS', expectedStatus: 'corrupted', expectedHeader: 'STATUS: CORRUPTED' },
    { name: 'budget.xlsx', ext: '.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buf: Buffer.from('PK\x03\x04dummy', 'utf8'), expectedFmt: 'XLSX', expectedStatus: 'corrupted', expectedHeader: 'STATUS: CORRUPTED' },
    { name: 'tool.exe', ext: '.exe', mime: 'application/x-msdownload', buf: Buffer.from([0x4d, 0x5a, 0x90, 0x00]), expectedFmt: 'EXE', expectedStatus: 'unsupported_format', expectedHeader: 'STATUS: UNSUPPORTED FORMAT' }
  ];

  for (const c of serverCases) {
    const extRes = await extractDocumentContent(c.buf, c.name, c.ext, c.mime, `id-${c.expectedFmt}`);
    assert.equal(extRes.status, c.expectedStatus);
    assert.equal(isImageAttachment(extRes), false, `${c.name} must not be classified as an image`);

    const prep = prepareDocumentContext(`Summarize ${c.name}`, [extRes], { provider: 'gemini' });
    assert.equal(prep.hasErrorsOrWarnings, true);
    assert.ok(prep.directAnswer, `${c.name} single-doc ${c.expectedStatus} must provide directAnswer`);
    assert.ok(
      prep.formattedContext.includes(c.expectedHeader),
      `${c.name} context must emit ${c.expectedHeader}, got:\n${prep.formattedContext}`
    );
    assert.ok(prep.formattedContext.includes(`(${c.expectedFmt})`), `${c.name} format label must be ${c.expectedFmt}`);
    assert.equal(
      prep.formattedContext.includes('SCANNED/IMAGE-ONLY'),
      false,
      `${c.name} must NOT be labeled SCANNED/IMAGE-ONLY`
    );
    assert.equal(
      prep.formattedContext.includes('Optical Character Recognition (OCR) would be required'),
      false,
      `${c.name} must NOT blame missing OCR layer`
    );
    assert.equal(
      prep.formattedContext.includes('STATUS: EMPTY'),
      false,
      `${c.name} must NOT be labeled EMPTY`
    );

    const sim = generateSimulatedDocumentResponse(`Summarize ${c.name}`, prep);
    assert.equal(sim, prep.directAnswer);
  }

  // Browser extractor parity check using File-like polyfill
  const makeBrowserFile = (name, type, buf) => ({
    name,
    type,
    size: buf.length,
    async arrayBuffer() { return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength); },
    async text() { return buf.toString('utf8'); }
  });

  for (const c of serverCases) {
    const browserRes = await extractBrowserDocument(makeBrowserFile(c.name, c.mime, c.buf), `b-${c.expectedFmt}`);
    assert.equal(browserRes.status, c.expectedStatus);
    assert.equal(isImageAttachment(browserRes), false);
    const prep = prepareDocumentContext(`Analyze ${c.name}`, [browserRes], { provider: 'webllm' });
    assert.ok(prep.formattedContext.includes(c.expectedHeader));
    assert.equal(prep.formattedContext.includes('SCANNED/IMAGE-ONLY'), false);
    assert.ok(prep.directAnswer && !prep.directAnswer.includes('scanned, image-only'));
  }
});

await runTest('2.2 Multi-document mix preserves readable docs while accurately labeling corrupted/unsupported docs', async () => {
  const txtDoc = await extractDocumentContent(
    Buffer.from('Revenue grew 18% YoY in Q4 2026.', 'utf8'),
    'summary.txt',
    '.txt',
    'text/plain',
    'txt-mix-1'
  );
  const xlsDoc = await extractDocumentContent(
    Buffer.from('D0CF11E0A1B11AE1', 'hex'),
    'model.xls',
    '.xls',
    'application/vnd.ms-excel',
    'xls-mix-2'
  );

  const prep = prepareDocumentContext('Compare both attached files', [txtDoc, xlsDoc], { provider: 'groq' });
  assert.equal(prep.directAnswer, undefined, 'Multi-doc context with one readable doc must not short-circuit directAnswer');
  assert.equal(prep.hasErrorsOrWarnings, true);
  assert.ok(prep.formattedContext.includes('Revenue grew 18% YoY in Q4 2026.'));
  assert.ok(prep.formattedContext.includes('STATUS: CORRUPTED'));
  assert.equal(prep.formattedContext.includes('SCANNED/IMAGE-ONLY'), false);
});

await runTest('2.3 Accurate MIME and extension detection prevents document<->image misclassification', async () => {
  // Valid document formats must NEVER be classified as images (even with tricky filenames or stale isImage flags)
  const docFixtures = [
    { originalName: 'contract.pdf', mimeType: 'application/pdf' },
    { originalName: 'contract.pdf', mimeType: 'application/pdf; charset=binary', isImage: true },
    { originalName: 'memo.doc', mimeType: 'application/msword' },
    { originalName: 'diagram.jpg.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
    { originalName: 'deck.ppt', mimeType: 'application/vnd.ms-powerpoint' },
    { originalName: 'deck.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
    { originalName: 'sheet.xls', mimeType: 'application/vnd.ms-excel' },
    { originalName: 'sheet.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
    { originalName: 'notes.md', mimeType: 'text/markdown; charset=utf-8' },
    { originalName: 'readme.txt', mimeType: 'text/plain', isImage: 'false' },
    { originalName: 'data.csv', mimeType: 'text/csv' },
    { originalName: 'config.json', mimeType: 'application/json' },
    { originalName: 'feed.xml', mimeType: 'application/xml' },
    { originalName: 'noext', mimeType: 'application/msword', format: '' }
  ];

  for (const doc of docFixtures) {
    assert.equal(isImageAttachment(doc), false, `Document ${JSON.stringify(doc)} misclassified as image`);
  }

  // Valid image formats must ALWAYS be classified as images
  const imageFixtures = [
    { originalName: 'photo.jpg', mimeType: 'image/jpeg' },
    { originalName: 'photo.png', mimeType: 'image/png; charset=binary' },
    { originalName: 'anim.gif', mimeType: 'image/gif' },
    { originalName: 'pic.webp', mimeType: 'application/octet-stream' },
    { originalName: 'scan.tiff', mimeType: 'image/tiff' },
    { originalName: 'live.heic', mimeType: 'image/heic' },
    { originalName: 'photo.png?alt=media', mimeType: '' },
    { originalName: 'unnamed', mimeType: 'image/webp', format: '' },
    { originalName: 'raw_blob', mimeType: '', isImage: true }
  ];

  for (const img of imageFixtures) {
    assert.equal(isImageAttachment(img), true, `Image ${JSON.stringify(img)} misclassified as document`);
  }

  // HEIC image with unsupported_format still enters dedicated image OCR unsupported branch
  const heicPrep = prepareDocumentContext('Read image', [{
    originalName: 'photo.heic',
    mimeType: 'image/heic',
    format: 'HEIC',
    status: 'unsupported_format',
    success: false,
    isImage: true,
    error: 'HEIC/HEIF format cannot be processed for OCR offline.'
  }], { provider: 'groq' });
  assert.ok(heicPrep.formattedContext.includes('[OCR Status]: UNSUPPORTED FORMAT'));

  // Format label resolution preserves accurate MIME & extension when doc.format is absent/UNKNOWN
  assert.equal(
    resolveAttachmentFormatLabel({ originalName: 'unnamed', mimeType: 'application/vnd.ms-excel' }),
    'XLS'
  );
  assert.equal(
    resolveAttachmentFormatLabel({ originalName: 'notes.markdown', mimeType: '', format: 'UNKNOWN' }),
    'MD'
  );
  assert.equal(
    resolveAttachmentFormatLabel({ originalName: 'archive.xlsx', mimeType: 'application/octet-stream' }),
    'XLSX'
  );
});

console.log(`\n===============================================================`);
console.log(`AUDIT FIXES SUMMARY: ${passed} Passed, ${failed} Failed`);
console.log(`===============================================================`);
process.exit(failed > 0 ? 1 : 0);
