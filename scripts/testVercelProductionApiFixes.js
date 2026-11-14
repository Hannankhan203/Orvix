/**
 * Targeted Regression Suite: Vercel Production API Cold-Start, Query Preservation & Upload Quota Flow
 *
 * Verifies:
 * 1. /api/config, /api/health, /api/chat, and /api/transcribe boot & respond cleanly in
 *    Vercel production mode (VERCEL=1, NODE_ENV=production) even without ORVIX_SIGNED_URL_SECRET,
 *    while enforcing strict CORS rules.
 * 2. /api/upload still fails closed when ORVIX_SIGNED_URL_SECRET is missing in Vercel production,
 *    and boots cleanly when configured.
 * 3. CJS bundling (esbuild --format=cjs) does not crash on unguarded import.meta.url calls.
 * 4. Vercel rewrite query parameters (?__subpath=...&chatId=...&uid=...&exp=...&sig=...&dl=1)
 *    are preserved across /api/upload/quota, /api/upload/:id/signed-url, /api/upload/:id/file,
 *    and DELETE /api/upload/:id.
 * 5. Full upload quota retrieval + multipart upload + signed URL + file download + delete flow
 *    works end-to-end through the api/upload.ts Vercel handler.
 * 6. Firebase Project ID fallback from FIREBASE_SERVICE_ACCOUNT and PEM \\n normalization.
 *
 * Run with: node scripts/testVercelProductionApiFixes.js
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

let passed = 0;
let failed = 0;

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`  ✅ PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ FAIL: ${name}`);
    console.error(`     ${err?.stack || err}`);
    failed++;
  }
}

function runNodeInline(code, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
    timeout: 20000
  });
}

console.log('=== Vercel Production API & Upload Quota Regression Suite ===\n');

// ---------------------------------------------------------------------------
// 1. Non-upload Vercel endpoints must boot cleanly without ORVIX_SIGNED_URL_SECRET
// ---------------------------------------------------------------------------
await runTest('Vercel production: /api/config & /api/health boot and return 200 without ORVIX_SIGNED_URL_SECRET', async () => {
  const cleanEnv = {
    VERCEL: '1',
    NODE_ENV: 'production',
    SUPABASE_URL: 'https://example-project.supabase.co',
    SUPABASE_SECRET_KEY: 'sb_secret_test_key_12345'
  };
  const unsetEnv = {
    TESTING: '',
    ORVIX_SIGNED_URL_SECRET: '',
    SIGNED_DECODE_URL_SECRET: '',
    SESSION_SECRET: ''
  };

  const res = runNodeInline(
    `
    import http from 'node:http';
    import assert from 'node:assert/strict';
    delete process.env.TESTING;
    delete process.env.ORVIX_SIGNED_URL_SECRET;
    delete process.env.SIGNED_DECODE_URL_SECRET;
    delete process.env.SESSION_SECRET;
    const { default: configHandler } = await import('./api/config.ts');
    const { default: healthHandler } = await import('./api/health.ts');
    await import('./api/chat.ts');
    await import('./api/transcribe.ts');

    const srv = http.createServer((req, res) => {
      if (req.url?.startsWith('/api/health')) return healthHandler(req, res);
      return configHandler(req, res);
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;

    const cfgRes = await fetch(\`http://127.0.0.1:\${port}/api/config\`);
    assert.strictEqual(cfgRes.status, 200);
    assert.ok(cfgRes.headers.get('cache-control')?.includes('no-store'));
    const cfg = await cfgRes.json();
    assert.strictEqual(cfg.supabaseConfigured, true);
    assert.strictEqual(cfg.webllmSupported, true);

    const corsBlockRes = await fetch(\`http://127.0.0.1:\${port}/api/config\`, {
      headers: { Origin: 'https://evil-attacker.example' }
    });
    assert.strictEqual(corsBlockRes.status, 403);

    const hRes = await fetch(\`http://127.0.0.1:\${port}/api/health\`);
    assert.strictEqual(hRes.status, 200);
    const hData = await hRes.json();
    assert.strictEqual(hData.status, 'ok');

    srv.close();
    console.log('NON_UPLOAD_VERCEL_OK');
    `,
    { ...unsetEnv, ...cleanEnv }
  );

  assert.strictEqual(
    res.status,
    0,
    `Expected exit 0, got ${res.status}. stdout=${res.stdout} stderr=${res.stderr}`
  );
  assert.ok(res.stdout.includes('NON_UPLOAD_VERCEL_OK'));
});

// ---------------------------------------------------------------------------
// 2. /api/upload preserves fail-closed signed-URL secret enforcement in production
// ---------------------------------------------------------------------------
await runTest('Vercel production: /api/upload still fails closed without ORVIX_SIGNED_URL_SECRET and succeeds with valid secret', async () => {
  const failRes = runNodeInline(
    `
    delete process.env.TESTING;
    delete process.env.ORVIX_SIGNED_URL_SECRET;
    delete process.env.SIGNED_DECODE_URL_SECRET;
    delete process.env.SESSION_SECRET;
    await import('./api/upload.ts');
    `,
    { VERCEL: '1', NODE_ENV: 'production' }
  );
  assert.notStrictEqual(failRes.status, 0, 'api/upload.ts must fail closed without ORVIX_SIGNED_URL_SECRET');
  assert.ok(
    (failRes.stderr || failRes.stdout).includes('ORVIX_SIGNED_URL_SECRET'),
    `Expected ORVIX_SIGNED_URL_SECRET error, got: ${failRes.stderr}`
  );

  const okRes = runNodeInline(
    `
    delete process.env.TESTING;
    await import('./api/upload.ts');
    console.log('UPLOAD_VERCEL_BOOT_OK');
    `,
    {
      VERCEL: '1',
      NODE_ENV: 'production',
      ORVIX_SIGNED_URL_SECRET: 'orvix-prod-signed-url-secret-value-at-least-32-chars'
    }
  );
  assert.strictEqual(okRes.status, 0, `Expected exit 0, got ${okRes.status}. stderr=${okRes.stderr}`);
  assert.ok(okRes.stdout.includes('UPLOAD_VERCEL_BOOT_OK'));
});

// ---------------------------------------------------------------------------
// 3. CJS bundling compatibility (import.meta.url guarded)
// ---------------------------------------------------------------------------
await runTest('esbuild --format=cjs bundle of all 5 Vercel api/*.ts entrypoints runs without import.meta.url ERR_INVALID_ARG_TYPE', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orvix-cjs-test-'));
  const esbuildBin = path.resolve(process.cwd(), 'node_modules', '.bin', 'esbuild');

  try {
    for (const entry of ['api/config.ts', 'api/health.ts', 'api/chat.ts', 'api/transcribe.ts', 'api/upload.ts']) {
      const outFile = path.join(tmpDir, path.basename(entry, '.ts') + '.cjs');
      const build = spawnSync(
        esbuildBin,
        [entry, '--bundle', '--platform=node', '--format=cjs', '--packages=external', `--outfile=${outFile}`],
        { cwd: process.cwd(), encoding: 'utf8' }
      );
      assert.strictEqual(build.status, 0, `esbuild failed for ${entry}: ${build.stderr}`);

      const run = spawnSync(
        process.execPath,
        ['-e', `const m = require(${JSON.stringify(outFile)}); if (typeof m.default !== 'function') process.exit(2);`],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            NODE_PATH: path.resolve(process.cwd(), 'node_modules'),
            VERCEL: '1',
            NODE_ENV: 'production',
            ORVIX_SIGNED_URL_SECRET: 'orvix-cjs-bundle-secret-verification-32chars'
          },
          encoding: 'utf8'
        }
      );
      assert.strictEqual(
        run.status,
        0,
        `CJS execution failed for ${entry}: exit=${run.status} stderr=${run.stderr}`
      );
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. Full Vercel /api/upload rewrite & quota + file upload + signed-url + file retrieval flow
// ---------------------------------------------------------------------------
await runTest('Vercel api/upload handler preserves query params across ?__subpath rewrites and completes quota + upload + download + delete', async () => {
  process.env.TESTING = '1';
  process.env.FIREBASE_PROJECT_ID = 'orvix-vercel-test-project';
  process.env.ORVIX_SIGNED_URL_SECRET = 'orvix-test-signed-url-secret-at-least-32-characters';

  const { default: uploadHandler } = await import('../api/upload.ts');
  const {
    setTestPublicKey,
    clearTestPublicKeys,
    resetFirebaseAuthForTesting
  } = await import('../server/firebaseAuthHelper.ts');
  const {
    createSimulatedFirestoreInstance,
    setFirestoreForTesting,
    resetFirestoreForTesting
  } = await import('../server/uploadQuotaService.ts');
  const {
    setSupabaseServerClientForTesting,
    resetSupabaseClientForTesting
  } = await import('../server/supabaseClient.ts');

  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const kid = 'vercel-test-kid-1';
  setTestPublicKey(kid, publicKeyPem);

  const mockStorageObjects = new Map();
  const mockSupabaseClient = {
    storage: {
      getBucket: async (name) => ({ data: { name, id: name }, error: null }),
      from: () => ({
        upload: async (storagePath, buffer) => {
          mockStorageObjects.set(storagePath, Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer));
          return { data: { path: storagePath }, error: null };
        },
        download: async (storagePath) => {
          const buf = mockStorageObjects.get(storagePath);
          if (!buf) return { data: null, error: { message: 'Object not found', statusCode: '404' } };
          return { data: new Blob([buf]), error: null };
        },
        createSignedUrl: async (storagePath, expiresIn) => ({
          data: { signedUrl: `https://mock.supabase.co/storage/v1/object/sign/orvix-attachments/${storagePath}?token=mock&exp=${expiresIn}` },
          error: null
        }),
        createSignedUploadUrl: async (storagePath) => ({
          data: {
            signedUrl: `https://mock.supabase.co/storage/v1/object/upload/sign/orvix-attachments/${storagePath}?token=mock_upload_token`,
            token: 'mock_upload_token',
            path: storagePath
          },
          error: null
        }),
        remove: async (paths) => {
          for (const p of paths) mockStorageObjects.delete(p);
          return { data: paths, error: null };
        },
        list: async (prefix = '') => {
          const items = [];
          const normalizedPrefix = prefix ? prefix.replace(/\/+$/, '') + '/' : '';
          for (const key of mockStorageObjects.keys()) {
            if (!normalizedPrefix || key.startsWith(normalizedPrefix)) {
              const name = normalizedPrefix ? key.slice(normalizedPrefix.length) : key;
              if (name && !name.includes('/')) {
                items.push({ name, id: key });
              }
            }
          }
          return { data: items, error: null };
        }
      })
    }
  };

  setFirestoreForTesting(createSimulatedFirestoreInstance());
  setSupabaseServerClientForTesting(mockSupabaseClient);

  const signToken = (uid) => {
    const now = Math.floor(Date.now() / 1000);
    const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid })).toString('base64url');
    const p = Buffer.from(
      JSON.stringify({
        aud: 'orvix-vercel-test-project',
        iss: 'https://securetoken.google.com/orvix-vercel-test-project',
        sub: uid,
        user_id: uid,
        exp: now + 3600,
        iat: now
      })
    ).toString('base64url');
    const s = crypto.createSign('RSA-SHA256').update(`${h}.${p}`).sign(privateKey, 'base64url');
    return `${h}.${p}.${s}`;
  };

  const token = signToken('vercel_user_1');

  // Simulate Vercel rewrite: /api/upload/:subpath* -> /api/upload?__subpath=:subpath*
  const server = http.createServer((req, res) => {
    const urlObj = new URL(req.url || '/', 'http://127.0.0.1');
    if (urlObj.pathname.startsWith('/api/upload/')) {
      const sub = urlObj.pathname.slice('/api/upload/'.length);
      urlObj.searchParams.set('__subpath', sub);
      req.url = `/api/upload?${urlObj.searchParams.toString()}`;
    }
    return uploadHandler(req, res);
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    // A. Unauthenticated /api/upload/quota must return 401 (never 500)
    const unauthQuota = await fetch(`${baseUrl}/api/upload/quota`);
    assert.strictEqual(unauthQuota.status, 401);

    // B. Authenticated /api/upload/quota returns 200 with remaining=5
    const quota1 = await fetch(`${baseUrl}/api/upload/quota`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.strictEqual(quota1.status, 200);
    assert.strictEqual(quota1.headers.get('x-ratelimit-limit'), '5');
    assert.strictEqual(quota1.headers.get('x-ratelimit-remaining'), '5');
    const quotaJson1 = await quota1.json();
    assert.strictEqual(quotaJson1.remaining, 5);
    assert.strictEqual(quotaJson1.committed, 0);

    // C. Multipart file upload via POST /api/upload (compressible .json triggers Orvix envelope + signed decode URL)
    const form = new FormData();
    const contentText = JSON.stringify({ message: 'Vercel production upload verification payload '.repeat(100) });
    form.append('files', new Blob([contentText], { type: 'application/json' }), 'vercel-test.json');
    form.append('conversationId', 'chat-vercel-test');

    const upRes = await fetch(`${baseUrl}/api/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form
    });
    assert.strictEqual(upRes.status, 200, `Upload failed: ${await upRes.clone().text()}`);
    assert.strictEqual(upRes.headers.get('x-ratelimit-remaining'), '4');
    const upJson = await upRes.json();
    assert.strictEqual(upJson.success, true);
    const fileId = upJson.attachments?.[0]?.id || upJson.attachment?.id;
    assert.ok(fileId, 'Expected uploaded file ID');

    // D. Quota status after upload reflects committed=1, remaining=4
    const quota2 = await fetch(`${baseUrl}/api/upload/quota`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.strictEqual(quota2.status, 200);
    const quotaJson2 = await quota2.json();
    assert.strictEqual(quotaJson2.committed, 1);
    assert.strictEqual(quotaJson2.remaining, 4);

    // E. Signed URL endpoint through Vercel rewrite must preserve ?chatId=...&download=true
    const signedRes = await fetch(
      `${baseUrl}/api/upload/${fileId}/signed-url?chatId=chat-vercel-test&download=true`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    assert.strictEqual(signedRes.status, 200, `Signed URL failed: ${await signedRes.clone().text()}`);
    const signedJson = await signedRes.json();
    assert.ok(signedJson.signedUrl, 'Expected signedUrl in response');

    // F. File retrieval endpoint through Vercel rewrite must preserve ?chatId=...&dl=1 (and ?uid=...&exp=...&sig=... when wrapped)
    const parsedSignedUrl = new URL(signedJson.signedUrl);
    if (parsedSignedUrl.pathname.startsWith('/api/upload/')) {
      const signedFileFetch = await fetch(`${baseUrl}${parsedSignedUrl.pathname}${parsedSignedUrl.search}`);
      assert.strictEqual(signedFileFetch.status, 200, `Signed file fetch failed: ${signedFileFetch.status}`);
      assert.strictEqual(await signedFileFetch.text(), contentText);
    } else {
      assert.ok(
        signedJson.signedUrl.includes(`chat-vercel-test/${fileId}`),
        `Expected Supabase signed URL for uploaded object, got ${signedJson.signedUrl}`
      );
    }

    const fileFetch = await fetch(
      `${baseUrl}/api/upload/${fileId}/file?chatId=chat-vercel-test&dl=1`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    assert.strictEqual(fileFetch.status, 200, `Authenticated file fetch failed: ${fileFetch.status}`);
    assert.ok(
      fileFetch.headers.get('content-disposition')?.includes('attachment'),
      'Expected dl=1 query parameter to trigger Content-Disposition: attachment'
    );
    const downloadedText = await fileFetch.text();
    assert.strictEqual(downloadedText, contentText);

    // G. Direct-upload flow (direct/signed-url -> PUT -> direct/complete & direct/cancel) through Vercel rewrite
    const directPayload = Buffer.from('Vercel direct upload verification content 1234567890');
    const directSignRes = await fetch(`${baseUrl}/api/upload/direct/signed-url`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        chatId: 'chat-vercel-direct',
        fileName: 'direct-test.txt',
        fileSize: directPayload.length,
        mimeType: 'text/plain'
      })
    });
    assert.strictEqual(directSignRes.status, 200, `Direct signed-url failed: ${await directSignRes.clone().text()}`);
    assert.strictEqual(directSignRes.headers.get('x-ratelimit-remaining'), '3');
    const directSignJson = await directSignRes.json();
    assert.ok(directSignJson.attachmentId && directSignJson.storagePath);

    // Simulate client PUT to Supabase Storage
    mockStorageObjects.set(directSignJson.storagePath, directPayload);

    const directCompleteRes = await fetch(`${baseUrl}/api/upload/direct/complete`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        attachmentId: directSignJson.attachmentId,
        chatId: 'chat-vercel-direct',
        storagePath: directSignJson.storagePath
      })
    });
    assert.strictEqual(directCompleteRes.status, 200, `Direct complete failed: ${await directCompleteRes.clone().text()}`);
    assert.strictEqual(directCompleteRes.headers.get('x-ratelimit-remaining'), '3');

    // Also verify direct/cancel releases reserved quota slot across rewrite
    const cancelSignRes = await fetch(`${baseUrl}/api/upload/direct/signed-url`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        chatId: 'chat-vercel-direct',
        fileName: 'cancel-test.txt',
        fileSize: directPayload.length,
        mimeType: 'text/plain'
      })
    });
    assert.strictEqual(cancelSignRes.status, 200);
    assert.strictEqual(cancelSignRes.headers.get('x-ratelimit-remaining'), '2');
    const cancelSignJson = await cancelSignRes.json();

    const directCancelRes = await fetch(`${baseUrl}/api/upload/direct/cancel`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        attachmentId: cancelSignJson.attachmentId,
        chatId: 'chat-vercel-direct'
      })
    });
    assert.strictEqual(directCancelRes.status, 200);
    assert.strictEqual(directCancelRes.headers.get('x-ratelimit-remaining'), '3');

    // H. Delete endpoint through Vercel rewrite must preserve ?chatId=...
    const delRes = await fetch(`${baseUrl}/api/upload/${fileId}?chatId=chat-vercel-test`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.strictEqual(delRes.status, 200);
  } finally {
    server.close();
    clearTestPublicKeys();
    resetFirebaseAuthForTesting();
    resetFirestoreForTesting();
    resetSupabaseClientForTesting();
  }
});

// ---------------------------------------------------------------------------
// 5. Firebase Project ID fallback & PEM newline normalization
// ---------------------------------------------------------------------------
await runTest('getConfiguredFirebaseProjectId extracts project_id from FIREBASE_SERVICE_ACCOUNT and parseServiceAccountCredential normalizes \\\\n PEM newlines', async () => {
  const {
    getConfiguredFirebaseProjectId,
    resetFirebaseAuthForTesting
  } = await import('../server/firebaseAuthHelper.ts');
  const { parseServiceAccountCredential } = await import('../server/uploadQuotaService.ts');

  resetFirebaseAuthForTesting();
  const origPid = process.env.FIREBASE_PROJECT_ID;
  const origVitePid = process.env.VITE_FIREBASE_PROJECT_ID;
  const origNextPid = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  const origSa = process.env.FIREBASE_SERVICE_ACCOUNT;
  const origSaKey = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;

  try {
    delete process.env.FIREBASE_PROJECT_ID;
    delete process.env.VITE_FIREBASE_PROJECT_ID;
    delete process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
    delete process.env.FIREBASE_SERVICE_ACCOUNT_KEY;

    const sampleSa = {
      type: 'service_account',
      project_id: 'derived-vercel-project-999',
      private_key: '-----BEGIN PRIVATE KEY-----\\r\\nABC\\nDEF\\r\\n-----END PRIVATE KEY-----\\n',
      client_email: 'sa@derived-vercel-project-999.iam.gserviceaccount.com'
    };

    const jsonStr = JSON.stringify(sampleSa);
    const b64Str = Buffer.from(jsonStr, 'utf8').toString('base64');

    process.env.FIREBASE_SERVICE_ACCOUNT = jsonStr;
    assert.strictEqual(getConfiguredFirebaseProjectId(), 'derived-vercel-project-999');

    process.env.FIREBASE_SERVICE_ACCOUNT = `'${jsonStr}'`;
    assert.strictEqual(getConfiguredFirebaseProjectId(), 'derived-vercel-project-999');

    process.env.FIREBASE_SERVICE_ACCOUNT = b64Str;
    assert.strictEqual(getConfiguredFirebaseProjectId(), 'derived-vercel-project-999');

    process.env.FIREBASE_SERVICE_ACCOUNT = `"${b64Str}"`;
    assert.strictEqual(getConfiguredFirebaseProjectId(), 'derived-vercel-project-999');

    const parsed = parseServiceAccountCredential(jsonStr, 'FIREBASE_SERVICE_ACCOUNT');
    assert.ok(parsed.private_key.includes('\n'), 'Escaped \\\\r\\\\n and \\\\n in private_key must normalize to real newlines');
    assert.ok(!parsed.private_key.includes('\\n'), 'Literal \\\\n sequences should be unescaped');
    assert.ok(!parsed.private_key.includes('\\r'), 'Literal \\\\r sequences should be unescaped');
  } finally {
    if (origPid !== undefined) process.env.FIREBASE_PROJECT_ID = origPid;
    else delete process.env.FIREBASE_PROJECT_ID;
    if (origVitePid !== undefined) process.env.VITE_FIREBASE_PROJECT_ID = origVitePid;
    else delete process.env.VITE_FIREBASE_PROJECT_ID;
    if (origNextPid !== undefined) process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = origNextPid;
    else delete process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
    if (origSa !== undefined) process.env.FIREBASE_SERVICE_ACCOUNT = origSa;
    else delete process.env.FIREBASE_SERVICE_ACCOUNT;
    if (origSaKey !== undefined) process.env.FIREBASE_SERVICE_ACCOUNT_KEY = origSaKey;
    else delete process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  }
});

console.log(`\nRESULTS: ${passed} Passed, ${failed} Failed\n`);
if (failed > 0) {
  process.exit(1);
}
