import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import http from 'node:http';
import dotenv from 'dotenv';
import { WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';

import {
  MAX_FIRESTORE_MESSAGE_BYTES,
  MAX_FIRESTORE_DOCUMENT_BYTES,
  MAX_ATTACHMENT_EXTRACTION_BYTES,
  getUtf8ByteLength,
  calculateFirestoreDocumentByteSize,
  calculateDocumentByteSize,
  enforceFirestoreMessageSizeLimit,
  enforceFirestoreDocumentSizeLimit,
  sanitizeExtractionForStorage,
  sanitizeMessageForStorage,
  buildFirestoreMessagePayload
} from '../src/services/chatStorageService.js';
import { VoiceStreamClient } from '../src/services/voiceStreamClient.js';
import {
  getGeminiApiKey,
  getGroqApiKey,
  getOpenRouterApiKey,
  getCloudflareCredentials,
  resolveEnvCredential,
  isConfiguredCredential,
  sanitizeCredentialValue,
  warnIfPublicPrefixedSecretsConfigured,
  resetPublicPrefixedSecretsWarningForTesting
} from '../server/serverConfig.ts';
// @ts-ignore - JS OCR service module
import {
  resolveImageOcrApiKey,
  extractImageTextWithGeminiVision
} from '../src/services/imageOcrService.js';
import { setupVoiceWebSocketServer, resetVoiceWebSocketStateForTesting } from '../server/voiceWebSocketSubsystem.ts';
import { resetFirebaseAuthForTesting, setTestFirebaseProjectId, setTestPublicKey } from '../server/firebaseAuthHelper.ts';

function buildSignedTestJwt(uid: string, projectId: string, privateKey: crypto.KeyObject, kid: string): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      sub: uid,
      user_id: uid,
      aud: projectId,
      iss: `https://securetoken.google.com/${projectId}`,
      iat: nowSec - 10,
      exp: nowSec + 3600
    })
  ).toString('base64url');
  const signature = crypto
    .createSign('RSA-SHA256')
    .update(`${header}.${payload}`)
    .sign(privateKey)
    .toString('base64url');
  return `${header}.${payload}.${signature}`;
}

test('ORVIX-M02 Firestore document size limit: enforces 100KB message limit and 900KB safety ceiling accounting for Firestore encoding', () => {
  assert.equal(MAX_FIRESTORE_MESSAGE_BYTES, 100000);
  assert.equal(MAX_FIRESTORE_DOCUMENT_BYTES, 900 * 1024);
  assert.equal(MAX_ATTACHMENT_EXTRACTION_BYTES, 64 * 1024);

  // 1. Single message truncation at 100 KB
  const shortText = 'Hello world';
  const enforcedShort = enforceFirestoreMessageSizeLimit(shortText);
  assert.equal(enforcedShort.truncated, false);
  assert.equal(enforcedShort.content, shortText);

  const bulkyText = 'A'.repeat(120_000);
  const enforcedBulky = enforceFirestoreMessageSizeLimit(bulkyText);
  assert.equal(enforcedBulky.truncated, true);
  assert.ok(getUtf8ByteLength(enforcedBulky.content) <= MAX_FIRESTORE_MESSAGE_BYTES);
  assert.match(enforcedBulky.content, /\[Notice: Message exceeded 100 KB Firestore storage limit and was truncated\.\]/);

  // 2. Attachment extraction truncation at 64 KB and page limit bounding
  const bulkyExtraction = {
    text: 'X'.repeat(90_000),
    pages: Array.from({ length: 30 }, (_, i) => ({ pageNumber: i + 1, text: `Page ${i + 1}` })),
    slides: Array.from({ length: 25 }, (_, i) => ({ slideNumber: i + 1 })),
    fileType: 'pdf',
    base64: 'unwanted-raw-data',
    previewUrl: 'blob:unwanted'
  };
  const sanitizedExtraction = sanitizeExtractionForStorage(bulkyExtraction);
  assert.equal(sanitizedExtraction.base64, undefined);
  assert.equal(sanitizedExtraction.previewUrl, undefined);
  assert.equal(sanitizedExtraction.wasTruncated, true);
  assert.ok(getUtf8ByteLength(sanitizedExtraction.text) <= MAX_ATTACHMENT_EXTRACTION_BYTES);
  assert.match(sanitizedExtraction.text, /\[Notice: Extracted text truncated for Firestore document limit\.\]/);
  assert.equal(sanitizedExtraction.pages.length, 15);
  assert.equal(sanitizedExtraction.slides.length, 15);

  // 3. Official Firestore document sizing calculation verification
  const sampleDoc = {
    id: 'test-doc-1',
    count: 42,
    active: true,
    empty: null,
    items: ['alpha', 'beta'],
    metadata: { created: 1234567890 }
  };
  const exactFsSize = calculateFirestoreDocumentByteSize(sampleDoc, 'users/user-12345/chats/chat-67890/messages/msg-abcde');
  assert.ok(exactFsSize > 0);
  // Numbers must be 8 bytes, booleans 1 byte, strings len + 1
  assert.ok(exactFsSize >= 150, 'Must include document path overhead and field sizes');

  // 4. Worst-case pathological payload: 25 cumulative alternatives of 90 KB each + 20 attachments
  const activeAlternativeId = 'alt-active-keep';
  const worstCaseMsg = {
    id: 'msg-m02-worst-case',
    sender: 'assistant',
    content: 'Initial answer',
    modelUsed: 'gemini-2.5-flash',
    activeAlternativeId,
    timestamp: '12:00 PM',
    alternatives: Array.from({ length: 25 }, (_, i) => ({
      id: i === 10 ? activeAlternativeId : `alt-${i}`,
      sender: 'assistant',
      content: `Alternative ${i} ` + 'B'.repeat(90_000),
      modelUsed: 'gemini-2.5-flash',
      createdAtMs: Date.now() + i
    })),
    attachments: Array.from({ length: 20 }, (_, i) => ({
      id: `att-${i}`,
      name: `document_${i}.pdf`,
      extraction: {
        text: 'E'.repeat(80_000),
        pages: Array.from({ length: 20 }, (_, p) => ({ pageNumber: p + 1 }))
      }
    }))
  };

  const payload = buildFirestoreMessagePayload(worstCaseMsg);
  const totalFsBytes = calculateFirestoreDocumentByteSize(payload);
  const totalJsonBytes = calculateDocumentByteSize(payload);

  // Must strictly obey safety ceiling (900 KiB) under Firestore's 1 MiB limit
  assert.ok(
    totalFsBytes <= MAX_FIRESTORE_DOCUMENT_BYTES,
    `Firestore encoded bytes (${totalFsBytes}) must not exceed MAX_FIRESTORE_DOCUMENT_BYTES (${MAX_FIRESTORE_DOCUMENT_BYTES})`
  );
  assert.ok(
    totalJsonBytes <= MAX_FIRESTORE_DOCUMENT_BYTES,
    `Total byte calculation (${totalJsonBytes}) must not exceed MAX_FIRESTORE_DOCUMENT_BYTES (${MAX_FIRESTORE_DOCUMENT_BYTES})`
  );

  // Essential metadata must be strictly preserved
  assert.equal(payload.id, 'msg-m02-worst-case');
  assert.equal(payload.sender, 'assistant');
  assert.equal(payload.modelUsed, 'gemini-2.5-flash');
  assert.equal(payload.activeAlternativeId, activeAlternativeId);

  // Active alternative must never be pruned away
  const foundActive = payload.alternatives.find((alt: any) => alt.id === activeAlternativeId);
  assert.ok(foundActive, 'Active alternative must be preserved even when pruning older alternatives');
  assert.equal(foundActive.id, activeAlternativeId);
});

test('ORVIX-M03 WebSocket authentication: rejects URL query tokens and accepts Authorization Bearer and orvix-auth subprotocol', async () => {
  resetFirebaseAuthForTesting();
  resetVoiceWebSocketStateForTesting();

  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const projectId = 'orvix-m03-proj';
  const kid = 'm03-kid';
  setTestFirebaseProjectId(projectId);
  setTestPublicKey(kid, publicKey.export({ type: 'spki', format: 'pem' }).toString());

  const validToken = buildSignedTestJwt('user-m03', projectId, privateKey, kid);

  const app = express();
  const server = http.createServer(app);
  setupVoiceWebSocketServer(server);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  const wsBaseUrl = `ws://127.0.0.1:${addr.port}/api/voice-stream`;

  try {
    // 1. Unauthenticated connection (no token, no headers) MUST be rejected with HTTP 401
    await assert.rejects(
      () =>
        new Promise((resolve, reject) => {
          const ws = new WebSocket(wsBaseUrl);
          ws.on('open', () => resolve(ws));
          ws.on('error', reject);
        }),
      /Unexpected server response: 401/
    );

    // 2. Query parameter authentication (?token=...) MUST BE REJECTED with HTTP 401
    await assert.rejects(
      () =>
        new Promise((resolve, reject) => {
          const ws = new WebSocket(`${wsBaseUrl}?token=${encodeURIComponent(validToken)}`);
          ws.on('open', () => resolve(ws));
          ws.on('error', reject);
        }),
      /Unexpected server response: 401/,
      'WebSocket connection providing authentication only via ?token= query parameter must be rejected with HTTP 401'
    );

    // 3. Client resolveWebSocketUrl() does not append ?token= to the URL
    const client = new VoiceStreamClient({ url: wsBaseUrl });
    const resolvedUrl = client.resolveWebSocketUrl();
    assert.equal(resolvedUrl.includes('token='), false);

    // 4. Connection with Sec-WebSocket-Protocol ['orvix-auth', encodeURIComponent(validToken)] succeeds
    const subprotoResult = await new Promise<{ authenticated: boolean; protocol?: string }>((resolve, reject) => {
      const ws = new WebSocket(wsBaseUrl, ['orvix-auth', encodeURIComponent(validToken)]);
      ws.on('open', () => {
        // ws.protocol should negotiate 'orvix-auth' and NOT echo the raw token
        assert.equal(ws.protocol, 'orvix-auth');
      });
      ws.on('message', (msg) => {
        try {
          const data = JSON.parse(msg.toString());
          if (data.type === 'authenticated' && data.userId === 'user-m03') {
            ws.close();
            resolve({ authenticated: true, protocol: ws.protocol });
          }
        } catch (_) {}
      });
      ws.on('error', reject);
    });
    assert.equal(subprotoResult.authenticated, true);
    assert.equal(subprotoResult.protocol, 'orvix-auth');

    // 5. Connection with Bearer token in Authorization header succeeds
    const headerResult = await new Promise<{ authenticated: boolean }>((resolve, reject) => {
      const ws = new WebSocket(wsBaseUrl, {
        headers: { Authorization: `Bearer ${validToken}` }
      });
      ws.on('message', (msg) => {
        try {
          const data = JSON.parse(msg.toString());
          if (data.type === 'authenticated' && data.userId === 'user-m03') {
            ws.close();
            resolve({ authenticated: true });
          }
        } catch (_) {}
      });
      ws.on('error', reject);
    });
    assert.equal(headerResult.authenticated, true);
  } finally {
    resetVoiceWebSocketStateForTesting();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test('ORVIX-M04 & ORVIX-CRIT-01 Frontend credential isolation: zero server secrets in client bundle or image OCR helpers', async () => {
  // 1. Verify /proc/environ scanning is absent from serverConfig.ts
  const serverConfigSrc = fs.readFileSync(path.join(process.cwd(), 'server', 'serverConfig.ts'), 'utf8');
  assert.equal(
    serverConfigSrc.includes('/proc') && serverConfigSrc.includes('environ'),
    false,
    'Unsafe /proc/PID/environ environment secret scanning must be completely removed'
  );

  const apiKey = getGeminiApiKey();
  assert.equal(typeof apiKey, 'string');

  // 2. Verify imageOcrService.js has zero direct process.env or import.meta.env.VITE_GEMINI_API_KEY reads
  const ocrServiceSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'imageOcrService.js'), 'utf8');
  assert.equal(
    ocrServiceSrc.includes('process.env.GEMINI_API_KEY'),
    false,
    'imageOcrService.js must not contain direct process.env.GEMINI_API_KEY reads'
  );
  assert.equal(
    ocrServiceSrc.includes('VITE_GEMINI_API_KEY'),
    false,
    'imageOcrService.js must not reference client-exposed VITE_GEMINI_API_KEY'
  );
  assert.equal(
    ocrServiceSrc.includes('import.meta.env'),
    false,
    'imageOcrService.js must not read secrets from client import.meta.env'
  );

  // 3. Verify runtime OCR key resolution strictly requires an explicit server-supplied key
  assert.equal(resolveImageOcrApiKey(), null);
  assert.equal(resolveImageOcrApiKey(null), null);
  assert.equal(resolveImageOcrApiKey(''), null);
  assert.equal(resolveImageOcrApiKey('MY_GEMINI_API_KEY'), null);
  assert.equal(resolveImageOcrApiKey('your_api_key_here'), null);
  assert.equal(resolveImageOcrApiKey('  server-supplied-key-123  '), 'server-supplied-key-123');

  // Without an explicit server key, extractImageTextWithGeminiVision must immediately return null without invoking cloud API
  const visionWithoutKey = await extractImageTextWithGeminiVision(Buffer.from('test'), 'image/png', null);
  assert.equal(visionWithoutKey, null);

  // 4. Verify production client bundle in dist/assets does not contain server API keys or VITE_* provider secrets,
  // while permitting only the configured public Firebase Web API key (VITE_FIREBASE_API_KEY) for the Firebase SDK.
  const GOOGLE_API_KEY_FORMAT = /^AIzaSy[A-Za-z0-9_-]{33}$/;
  const GOOGLE_API_KEY_GLOBAL = /AIzaSy[A-Za-z0-9_-]{33}/g;
  const SERVER_GOOGLE_SECRET_ENV_KEYS = [
    'GEMINI_API_KEY',
    'ORVIX_GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'GOOGLE_GENERATIVE_AI_API_KEY',
    'VITE_GEMINI_API_KEY',
    'NEXT_PUBLIC_GEMINI_API_KEY',
    'REACT_APP_GEMINI_API_KEY',
    'VITE_GOOGLE_API_KEY',
    'NEXT_PUBLIC_GOOGLE_API_KEY',
    'REACT_APP_GOOGLE_API_KEY',
    'VITE_ORVIX_GEMINI_API_KEY',
    'NEXT_PUBLIC_ORVIX_GEMINI_API_KEY',
    'REACT_APP_ORVIX_GEMINI_API_KEY'
  ] as const;
  const OTHER_SERVER_SECRET_ENV_KEYS = [
    'GROQ_API_KEY',
    'ORVIX_GROQ_API_KEY',
    'GROQ_KEY',
    'GROQ_API_TOKEN',
    'GROQ_API_SECRET',
    'VITE_GROQ_API_KEY',
    'OPENROUTER_API_KEY',
    'ORVIX_OPENROUTER_API_KEY',
    'OPEN_ROUTER_API_KEY',
    'OPENROUTER_KEY',
    'OPENROUTER_API_TOKEN',
    'OPENROUTER_API_SECRET',
    'VITE_OPENROUTER_API_KEY',
    'CLOUDFLARE_API_TOKEN',
    'ORVIX_CLOUDFLARE_API_TOKEN',
    'CLOUDFLARE_TOKEN',
    'CLOUDFLARE_API_KEY',
    'VITE_CLOUDFLARE_API_TOKEN',
    'VITE_CLOUDFLARE_API_KEY',
    'VITE_CLOUDFLARE_ACCOUNT_ID',
    'SUPABASE_SECRET_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'ORVIX_SUPABASE_SECRET_KEY',
    'ORVIX_SUPABASE_SERVICE_ROLE_KEY',
    'ORVIX_SIGNED_URL_SECRET',
    'SIGNED_DECODE_URL_SECRET',
    'SESSION_SECRET'
  ] as const;
  const DISALLOWED_CLIENT_BUNDLE_ENV_NAMES = [
    'VITE_GEMINI_API_KEY',
    'VITE_GOOGLE_API_KEY',
    'VITE_ORVIX_GEMINI_API_KEY',
    'VITE_GROQ_API_KEY',
    'VITE_OPENROUTER_API_KEY',
    'VITE_CLOUDFLARE_API_TOKEN',
    'VITE_CLOUDFLARE_API_KEY',
    'VITE_CLOUDFLARE_ACCOUNT_ID'
  ] as const;

  const readDotenvCandidates = (rootDir: string): Array<Record<string, string>> => {
    const parsedFiles: Array<Record<string, string>> = [];
    for (const envFile of ['.env', '.env.local', '.env.production', '.env.production.local']) {
      const fullPath = path.join(rootDir, envFile);
      if (!fs.existsSync(fullPath)) continue;
      try {
        parsedFiles.push(dotenv.parse(fs.readFileSync(fullPath, 'utf8')));
      } catch (_) {
        // Ignore unreadable local env files
      }
    }
    return parsedFiles;
  };

  const isUsableFirebaseWebApiKey = (val: unknown): val is string => {
    if (typeof val !== 'string') return false;
    const sanitized = sanitizeCredentialValue(val);
    return (
      GOOGLE_API_KEY_FORMAT.test(sanitized) &&
      isConfiguredCredential(sanitized) &&
      !sanitized.includes('YOUR_')
    );
  };

  const extractBundledFirebaseWebApiKeys = (bundleFiles: Array<{ file: string; content: string }>): Set<string> => {
    const extracted = new Set<string>();
    const viteEnvPropPattern = /(["'])VITE_FIREBASE_API_KEY\1\s*:\s*(["'])(AIzaSy[A-Za-z0-9_-]{33})\2/g;
    const firebaseConfigCallPattern =
      /\(\s*\)\s*=>\s*(["'])(AIzaSy[A-Za-z0-9_-]{33})\1\s*,\s*(["'])VITE_FIREBASE_API_KEY\3/g;

    for (const { content } of bundleFiles) {
      let match: RegExpExecArray | null;
      while ((match = viteEnvPropPattern.exec(content)) !== null) {
        if (isUsableFirebaseWebApiKey(match[3])) {
          extracted.add(match[3]);
        }
      }
      while ((match = firebaseConfigCallPattern.exec(content)) !== null) {
        if (isUsableFirebaseWebApiKey(match[2])) {
          extracted.add(match[2]);
        }
      }
    }
    return extracted;
  };

  const assertClientBundlesIsolateServerCredentials = (
    bundleFiles: Array<{ file: string; content: string }>,
    env: Record<string, string | undefined>,
    dotenvMaps: Array<Record<string, string>>,
    includeRuntimeServerGetters: boolean
  ) => {
    const serverGoogleKeys = new Set<string>();
    const otherServerSecrets = new Set<string>();

    const collectValues = (keyName: string): string[] => {
      const vals: string[] = [];
      if (typeof env[keyName] === 'string') vals.push(env[keyName] as string);
      for (const map of dotenvMaps) {
        if (typeof map[keyName] === 'string') vals.push(map[keyName]);
      }
      return vals;
    };

    for (const keyName of SERVER_GOOGLE_SECRET_ENV_KEYS) {
      for (const rawVal of collectValues(keyName)) {
        const sanitized = sanitizeCredentialValue(rawVal);
        if (isConfiguredCredential(sanitized) && sanitized.length >= 12) {
          serverGoogleKeys.add(sanitized);
        }
      }
    }

    for (const keyName of OTHER_SERVER_SECRET_ENV_KEYS) {
      for (const rawVal of collectValues(keyName)) {
        const sanitized = sanitizeCredentialValue(rawVal);
        if (isConfiguredCredential(sanitized) && sanitized.length >= 12) {
          otherServerSecrets.add(sanitized);
        }
      }
    }

    if (includeRuntimeServerGetters) {
      const activeGeminiKey = sanitizeCredentialValue(getGeminiApiKey());
      if (isConfiguredCredential(activeGeminiKey) && activeGeminiKey.length >= 12) {
        serverGoogleKeys.add(activeGeminiKey);
      }
      for (const runtimeSecret of [
        getGroqApiKey(),
        getOpenRouterApiKey(),
        getCloudflareCredentials().apiToken
      ]) {
        const sanitized = sanitizeCredentialValue(runtimeSecret);
        if (isConfiguredCredential(sanitized) && sanitized.length >= 12) {
          otherServerSecrets.add(sanitized);
        }
      }
    }

    const explicitFirebaseWebApiKeys = new Set<string>();
    for (const rawVal of collectValues('VITE_FIREBASE_API_KEY')) {
      const sanitized = sanitizeCredentialValue(rawVal);
      if (isUsableFirebaseWebApiKey(sanitized) && !serverGoogleKeys.has(sanitized)) {
        explicitFirebaseWebApiKeys.add(sanitized);
      }
    }

    let allowedFirebaseWebApiKeys = explicitFirebaseWebApiKeys;
    if (allowedFirebaseWebApiKeys.size === 0) {
      const bundledFirebaseKeys = new Set(
        Array.from(extractBundledFirebaseWebApiKeys(bundleFiles)).filter((key) => !serverGoogleKeys.has(key))
      );
      if (bundledFirebaseKeys.size === 1) {
        allowedFirebaseWebApiKeys = bundledFirebaseKeys;
      }
    }

    for (const { file, content } of bundleFiles) {
      for (const disallowedVar of DISALLOWED_CLIENT_BUNDLE_ENV_NAMES) {
        assert.equal(
          content.includes(disallowedVar),
          false,
          `Production client bundle (${file}) must not reference ${disallowedVar}`
        );
      }

      for (const secret of serverGoogleKeys) {
        assert.equal(
          content.includes(secret),
          false,
          `Production client bundle (${file}) must not embed configured server-side Google/Gemini credentials`
        );
      }

      for (const secret of otherServerSecrets) {
        assert.equal(
          content.includes(secret),
          false,
          `Production client bundle (${file}) must not embed configured server-side provider secrets`
        );
      }

      const googleKeyMatches = content.match(GOOGLE_API_KEY_GLOBAL) || [];
      for (const matchedKey of googleKeyMatches) {
        assert.equal(
          serverGoogleKeys.has(matchedKey),
          false,
          `Production client bundle (${file}) must not embed raw server-side Google/Gemini API keys`
        );
        assert.equal(
          allowedFirebaseWebApiKeys.has(matchedKey),
          true,
          `Production client bundle (${file}) must not embed non-Firebase Google API keys`
        );
      }
    }
  };

  // Verify synthetic isolation scenarios (allows configured VITE_FIREBASE_API_KEY, rejects server Google/Gemini keys and VITE_GEMINI_API_KEY)
  const syntheticFirebaseKey = `AIzaSy${'F'.repeat(33)}`;
  const syntheticGeminiKey = `AIzaSy${'G'.repeat(33)}`;
  assert.doesNotThrow(() =>
    assertClientBundlesIsolateServerCredentials(
      [
        {
          file: 'synthetic-auth.js',
          content: `var firebaseConfig = { apiKey: resolveFirebaseEnv(() => "${syntheticFirebaseKey}", "VITE_FIREBASE_API_KEY") };`
        }
      ],
      { VITE_FIREBASE_API_KEY: syntheticFirebaseKey, GEMINI_API_KEY: syntheticGeminiKey },
      [],
      false
    )
  );
  assert.throws(
    () =>
      assertClientBundlesIsolateServerCredentials(
        [{ file: 'synthetic-leak.js', content: `const k = "${syntheticGeminiKey}";` }],
        { VITE_FIREBASE_API_KEY: syntheticFirebaseKey, GEMINI_API_KEY: syntheticGeminiKey },
        [],
        false
      ),
    /must not embed/
  );
  assert.throws(
    () =>
      assertClientBundlesIsolateServerCredentials(
        [
          {
            file: 'synthetic-unconfigured.js',
            content: `const k = "${syntheticGeminiKey}";`
          }
        ],
        { VITE_FIREBASE_API_KEY: syntheticFirebaseKey },
        [],
        false
      ),
    /must not embed non-Firebase Google API keys/
  );
  assert.throws(
    () =>
      assertClientBundlesIsolateServerCredentials(
        [
          {
            file: 'synthetic-collision.js',
            content: `var firebaseConfig = { apiKey: resolveFirebaseEnv(() => "${syntheticFirebaseKey}", "VITE_FIREBASE_API_KEY") };`
          }
        ],
        { VITE_FIREBASE_API_KEY: syntheticFirebaseKey, GEMINI_API_KEY: syntheticFirebaseKey },
        [],
        false
      ),
    /must not embed/
  );
  assert.throws(
    () =>
      assertClientBundlesIsolateServerCredentials(
        [{ file: 'synthetic-vite-gemini.js', content: `const env = { VITE_GEMINI_API_KEY: "x" };` }],
        {},
        [],
        false
      ),
    /must not reference VITE_GEMINI_API_KEY/
  );

  const distAssetsDir = path.join(process.cwd(), 'dist', 'assets');
  if (fs.existsSync(distAssetsDir)) {
    const jsFiles = fs.readdirSync(distAssetsDir).filter((f) => f.endsWith('.js'));
    const bundleFiles = jsFiles.map((jsFile) => ({
      file: jsFile,
      content: fs.readFileSync(path.join(distAssetsDir, jsFile), 'utf8')
    }));
    const dotenvMaps = readDotenvCandidates(process.cwd());
    assertClientBundlesIsolateServerCredentials(bundleFiles, process.env, dotenvMaps, true);
  }
});

test('ORVIX-CRIT-01 Server secret isolation: rejects VITE_*, NEXT_PUBLIC_*, and REACT_APP_* secrets, preserves legitimate server keys, and logs safe startup warnings', () => {
  const trackedKeys = [
    'GEMINI_API_KEY',
    'ORVIX_GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'VITE_GEMINI_API_KEY',
    'NEXT_PUBLIC_GEMINI_API_KEY',
    'REACT_APP_GEMINI_API_KEY',
    'GROQ_API_KEY',
    'ORVIX_GROQ_API_KEY',
    'GROQ_KEY',
    'GROQ_API_TOKEN',
    'GROQ_API_SECRET',
    'VITE_GROQ_API_KEY',
    'NEXT_PUBLIC_GROQ_API_KEY',
    'REACT_APP_GROQ_API_KEY',
    'OPENROUTER_API_KEY',
    'ORVIX_OPENROUTER_API_KEY',
    'OPEN_ROUTER_API_KEY',
    'OPENROUTER_KEY',
    'OPENROUTER_API_TOKEN',
    'OPENROUTER_API_SECRET',
    'VITE_OPENROUTER_API_KEY',
    'NEXT_PUBLIC_OPENROUTER_API_KEY',
    'REACT_APP_OPENROUTER_API_KEY',
    'CLOUDFLARE_ACCOUNT_ID',
    'ORVIX_CLOUDFLARE_ACCOUNT_ID',
    'VITE_CLOUDFLARE_ACCOUNT_ID',
    'NEXT_PUBLIC_CLOUDFLARE_ACCOUNT_ID',
    'REACT_APP_CLOUDFLARE_ACCOUNT_ID',
    'CLOUDFLARE_API_TOKEN',
    'ORVIX_CLOUDFLARE_API_TOKEN',
    'CLOUDFLARE_TOKEN',
    'CLOUDFLARE_API_KEY',
    'VITE_CLOUDFLARE_API_TOKEN',
    'NEXT_PUBLIC_CLOUDFLARE_API_TOKEN',
    'REACT_APP_CLOUDFLARE_API_TOKEN'
  ];

  const savedEnv: Record<string, string | undefined> = {};
  for (const k of trackedKeys) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }

  try {
    resetPublicPrefixedSecretsWarningForTesting();

    // 1. Configure ONLY public-prefixed variables with sensitive values
    const sensitiveGeminiSecret = 'SUPER_SECRET_VITE_GEMINI_VALUE_999';
    const sensitiveGroqSecret = 'SUPER_SECRET_NEXT_GROQ_VALUE_888';
    const sensitiveOpenRouterSecret = 'SUPER_SECRET_REACT_OPENROUTER_VALUE_777';
    const sensitiveCfAccount = 'SUPER_SECRET_VITE_CF_ACCOUNT_666';
    const sensitiveCfToken = 'SUPER_SECRET_NEXT_CF_TOKEN_555';

    process.env.VITE_GEMINI_API_KEY = sensitiveGeminiSecret;
    process.env.NEXT_PUBLIC_GEMINI_API_KEY = sensitiveGeminiSecret;
    process.env.REACT_APP_GEMINI_API_KEY = sensitiveGeminiSecret;

    process.env.VITE_GROQ_API_KEY = sensitiveGroqSecret;
    process.env.NEXT_PUBLIC_GROQ_API_KEY = sensitiveGroqSecret;
    process.env.REACT_APP_GROQ_API_KEY = sensitiveGroqSecret;

    process.env.VITE_OPENROUTER_API_KEY = sensitiveOpenRouterSecret;
    process.env.NEXT_PUBLIC_OPENROUTER_API_KEY = sensitiveOpenRouterSecret;
    process.env.REACT_APP_OPENROUTER_API_KEY = sensitiveOpenRouterSecret;

    process.env.VITE_CLOUDFLARE_ACCOUNT_ID = sensitiveCfAccount;
    process.env.NEXT_PUBLIC_CLOUDFLARE_ACCOUNT_ID = sensitiveCfAccount;
    process.env.VITE_CLOUDFLARE_API_TOKEN = sensitiveCfToken;
    process.env.NEXT_PUBLIC_CLOUDFLARE_API_TOKEN = sensitiveCfToken;

    // Backend credential getters MUST reject all public-prefixed variables
    assert.equal(getGeminiApiKey(), '');
    assert.equal(getGroqApiKey(), '');
    assert.equal(getOpenRouterApiKey(), '');
    assert.deepEqual(getCloudflareCredentials(), { accountId: '', apiToken: '' });
    assert.equal(resolveEnvCredential('VITE_GEMINI_API_KEY', 'NEXT_PUBLIC_GROQ_API_KEY'), '');

    // 2. Verify startup warning detects public-prefixed secrets and NEVER logs secret values
    const warnings: string[] = [];
    const detected = warnIfPublicPrefixedSecretsConfigured(process.env, (msg: string) => warnings.push(msg));
    assert.equal(detected.includes('VITE_GEMINI_API_KEY'), true);
    assert.equal(detected.includes('NEXT_PUBLIC_GROQ_API_KEY'), true);
    assert.equal(detected.includes('REACT_APP_OPENROUTER_API_KEY'), true);
    assert.equal(detected.includes('VITE_CLOUDFLARE_API_TOKEN'), true);
    assert.equal(warnings.length, 1);

    const warningMessage = warnings[0];
    assert.equal(warningMessage.includes('VITE_GEMINI_API_KEY'), true);
    assert.equal(warningMessage.includes(sensitiveGeminiSecret), false, 'Warning must never print the Gemini secret value');
    assert.equal(warningMessage.includes(sensitiveGroqSecret), false, 'Warning must never print the Groq secret value');
    assert.equal(warningMessage.includes(sensitiveOpenRouterSecret), false, 'Warning must never print the OpenRouter secret value');
    assert.equal(warningMessage.includes(sensitiveCfAccount), false, 'Warning must never print the Cloudflare account value');
    assert.equal(warningMessage.includes(sensitiveCfToken), false, 'Warning must never print the Cloudflare token value');

    // 3. Verify legitimate server-only environment variable names continue to work properly
    process.env.GEMINI_API_KEY = 'server-gemini-secret-key';
    process.env.GROQ_API_KEY = 'server-groq-secret-key';
    process.env.OPENROUTER_API_KEY = 'server-openrouter-secret-key';
    process.env.CLOUDFLARE_ACCOUNT_ID = 'server-cf-account-id';
    process.env.CLOUDFLARE_API_TOKEN = 'server-cf-api-token';

    assert.equal(getGeminiApiKey(), 'server-gemini-secret-key');
    assert.equal(getGroqApiKey(), 'server-groq-secret-key');
    assert.equal(getOpenRouterApiKey(), 'server-openrouter-secret-key');
    assert.deepEqual(getCloudflareCredentials(), {
      accountId: 'server-cf-account-id',
      apiToken: 'server-cf-api-token'
    });

    // Verify ORVIX_* and fallback server-only aliases also work
    delete process.env.GEMINI_API_KEY;
    process.env.ORVIX_GEMINI_API_KEY = 'orvix-gemini-alias-key';
    assert.equal(getGeminiApiKey(), 'orvix-gemini-alias-key');

    delete process.env.ORVIX_GEMINI_API_KEY;
    process.env.GOOGLE_API_KEY = 'google-api-alias-key';
    assert.equal(getGeminiApiKey(), 'google-api-alias-key');
  } finally {
    for (const k of trackedKeys) {
      if (savedEnv[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = savedEnv[k];
      }
    }
    resetPublicPrefixedSecretsWarningForTesting();
  }
});

