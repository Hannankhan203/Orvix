import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';

process.env.TESTING = '1';

import {
  INDEX_HTML_THEME_SCRIPT_SHA256,
  PERMISSIONS_POLICY_VALUE,
  PRODUCTION_CONTENT_SECURITY_POLICY,
  REFERRER_POLICY_VALUE,
  STRICT_TRANSPORT_SECURITY_VALUE,
  X_CONTENT_TYPE_OPTIONS_VALUE,
  X_FRAME_OPTIONS_VALUE,
  applySecurityHeadersMiddleware,
  buildContentSecurityPolicy,
  resolveConfiguredExtraConnectOrigins
} from '../server/securityHeaders.ts';
import healthHandler from '../api/health.ts';
import configHandler from '../api/config.ts';
import chatHandler from '../api/chat.ts';
import shareHandler from '../api/share.ts';
import transcribeHandler from '../api/transcribe.ts';
import uploadHandler from '../api/upload.ts';

const REPO_ROOT = process.cwd();

function parseCspDirectives(csp: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const part of csp.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const tokens = trimmed.split(/\s+/);
    const name = tokens[0].toLowerCase();
    map.set(name, tokens.slice(1));
  }
  return map;
}

async function startServerForListener(
  listener: http.RequestListener
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer(listener);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      })
  };
}

test('vercel.json configures all six HTTP security headers consistently with zero duplicates or conflicts', () => {
  const vercelCfg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'vercel.json'), 'utf8'));
  assert.ok(Array.isArray(vercelCfg.headers), 'vercel.json must define a headers array');

  const globalRule = vercelCfg.headers.find((entry: any) => entry?.source === '/(.*)');
  assert.ok(globalRule, 'vercel.json must include a global /(.*) security header rule');

  const headerMap = new Map<string, string>();
  for (const h of globalRule.headers || []) {
    const lowerKey = String(h.key || '').toLowerCase();
    assert.equal(headerMap.has(lowerKey), false, `Duplicate header key '${h.key}' in /(.*) rule`);
    headerMap.set(lowerKey, String(h.value || ''));
  }

  assert.equal(headerMap.get('content-security-policy'), PRODUCTION_CONTENT_SECURITY_POLICY);
  assert.equal(headerMap.get('strict-transport-security'), STRICT_TRANSPORT_SECURITY_VALUE);
  assert.equal(headerMap.get('x-content-type-options'), X_CONTENT_TYPE_OPTIONS_VALUE);
  assert.equal(headerMap.get('x-frame-options'), X_FRAME_OPTIONS_VALUE);
  assert.equal(headerMap.get('referrer-policy'), REFERRER_POLICY_VALUE);
  assert.equal(headerMap.get('permissions-policy'), PERMISSIONS_POLICY_VALUE);

  // Ensure no other header block in vercel.json duplicates or conflicts with any of the 6 security headers
  const securityHeaderKeys = new Set([
    'content-security-policy',
    'strict-transport-security',
    'x-content-type-options',
    'x-frame-options',
    'referrer-policy',
    'permissions-policy'
  ]);
  for (const rule of vercelCfg.headers) {
    if (rule === globalRule) continue;
    for (const h of rule.headers || []) {
      const keyLower = String(h.key || '').toLowerCase();
      assert.equal(
        securityHeaderKeys.has(keyLower),
        false,
        `Rule '${rule.source}' must not duplicate/override security header '${h.key}'`
      );
    }
  }
});

test('CSP matches index.html inline theme script hash, permits required Orvix runtimes, and avoids unsafe script directives', () => {
  const html = fs.readFileSync(path.join(REPO_ROOT, 'index.html'), 'utf8');
  const inlineScripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => m[1])
    .filter((content) => content.trim().length > 0);
  assert.equal(inlineScripts.length, 1, 'Expected exactly one inline bootstrap script in index.html');

  const computedHash = `'sha256-${crypto.createHash('sha256').update(inlineScripts[0], 'utf8').digest('base64')}'`;
  assert.equal(
    INDEX_HTML_THEME_SCRIPT_SHA256,
    computedHash,
    'INDEX_HTML_THEME_SCRIPT_SHA256 must match index.html inline theme script SHA-256'
  );

  const directives = parseCspDirectives(PRODUCTION_CONTENT_SECURITY_POLICY);

  // Core hardening directives
  assert.deepEqual(directives.get('default-src'), ["'self'"]);
  assert.deepEqual(directives.get('base-uri'), ["'self'"]);
  assert.deepEqual(directives.get('form-action'), ["'self'"]);
  assert.deepEqual(directives.get('object-src'), ["'none'"]);
  assert.deepEqual(directives.get('frame-ancestors'), ["'none'"]);
  assert.ok(directives.has('upgrade-insecure-requests'));

  // script-src: allows self, pinned theme script hash, WebAssembly ('wasm-unsafe-eval'), and blob worklets;
  // strictly forbids 'unsafe-inline' and 'unsafe-eval' in production.
  const scriptSrc = directives.get('script-src') || [];
  assert.ok(scriptSrc.includes("'self'"));
  assert.ok(scriptSrc.includes(computedHash));
  assert.ok(scriptSrc.includes("'wasm-unsafe-eval'"));
  assert.ok(scriptSrc.includes('blob:'));
  assert.equal(scriptSrc.includes("'unsafe-inline'"), false, 'Production script-src must not include unsafe-inline');
  assert.equal(scriptSrc.includes("'unsafe-eval'"), false, 'Production script-src must not include unsafe-eval');

  // Workers and PDF blob iframe previews
  assert.deepEqual(directives.get('worker-src'), ["'self'", 'blob:']);
  assert.deepEqual(directives.get('frame-src'), ["'self'", 'blob:']);

  // connect-src covers Firebase, Supabase, WebLLM/HuggingFace/GitHub WASM, OCR packs, Sentry, and WSS
  const connectSrc = directives.get('connect-src') || [];
  for (const requiredOrigin of [
    "'self'",
    'wss:',
    'blob:',
    'data:',
    'https://*.googleapis.com',
    'https://*.firebaseio.com',
    'wss://*.firebaseio.com',
    'https://*.firebaseapp.com',
    'https://*.supabase.co',
    'https://huggingface.co',
    'https://*.huggingface.co',
    'https://*.hf.co',
    'https://raw.githubusercontent.com',
    'https://tessdata.projectnaptha.com',
    'https://*.ingest.sentry.io'
  ]) {
    assert.ok(connectSrc.includes(requiredOrigin), `connect-src must include ${requiredOrigin}`);
  }
  assert.equal(connectSrc.includes('https:'), false, 'connect-src must not allow arbitrary https: wildcard');
  assert.equal(connectSrc.includes('*'), false, 'connect-src must not allow * wildcard');

  // Permissions-Policy allows same-origin microphone for Voice Dictation and restricts unused sensors
  assert.match(PERMISSIONS_POLICY_VALUE, /\bmicrophone=\(self\)/);
  assert.match(PERMISSIONS_POLICY_VALUE, /\bcamera=\(\)/);
  assert.match(PERMISSIONS_POLICY_VALUE, /\bgeolocation=\(\)/);
  assert.match(PERMISSIONS_POLICY_VALUE, /\bpayment=\(\)/);
  assert.match(PERMISSIONS_POLICY_VALUE, /\busb=\(\)/);
});

test('resolveConfiguredExtraConnectOrigins safely extracts custom HTTPS Supabase/Sentry origins and rejects malformed inputs', () => {
  const origins = resolveConfiguredExtraConnectOrigins({
    SUPABASE_URL: 'https://storage.custom-orvix.example/v1',
    VITE_SENTRY_DSN: 'https://publicKey@sentry.custom-orvix.example/42',
    ORVIX_SUPABASE_URL: 'http://insecure.example',
    VITE_SUPABASE_URL: 'https://evil.example; script-src *'
  });

  assert.deepEqual(origins, [
    'https://storage.custom-orvix.example',
    'https://sentry.custom-orvix.example'
  ]);

  const customCsp = buildContentSecurityPolicy({
    isDev: false,
    isHttps: true,
    extraConnectOrigins: origins
  });
  const directives = parseCspDirectives(customCsp);
  assert.ok(directives.get('connect-src')?.includes('https://storage.custom-orvix.example'));
  assert.ok(directives.get('connect-src')?.includes('https://sentry.custom-orvix.example'));
});

test('Express server.ts emits security headers across app and API routes and enforces HTTPS-only HSTS', async () => {
  const prevTrustProxy = process.env.TRUST_PROXY;
  const prevOrvixTrustProxy = process.env.ORVIX_TRUST_PROXY;
  const prevVercel = process.env.VERCEL;
  const prevKService = process.env.K_SERVICE;
  process.env.TESTING = '1';
  delete process.env.TRUST_PROXY;
  delete process.env.ORVIX_TRUST_PROXY;
  delete process.env.VERCEL;
  delete process.env.K_SERVICE;

  const { app: mainExpressApp } = await import('../server.ts');
  const srv = await startServerForListener(mainExpressApp);

  try {
    // 1. Plain HTTP routes emit all non-HSTS security headers and omit HSTS & X-Powered-By
    for (const routePath of ['/api/health', '/api/config', '/manifest.webmanifest', '/sw.js', '/api/nonexistent']) {
      const res = await fetch(`${srv.baseUrl}${routePath}`);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff', `${routePath} nosniff`);
      assert.equal(res.headers.get('x-frame-options'), 'DENY', `${routePath} X-Frame-Options`);
      assert.equal(
        res.headers.get('referrer-policy'),
        'strict-origin-when-cross-origin',
        `${routePath} Referrer-Policy`
      );
      assert.equal(res.headers.get('permissions-policy'), PERMISSIONS_POLICY_VALUE, `${routePath} Permissions-Policy`);
      assert.equal(res.headers.get('x-powered-by'), null, `${routePath} must hide X-Powered-By`);
      assert.equal(
        res.headers.get('strict-transport-security'),
        null,
        `${routePath} must NOT emit HSTS over plain HTTP`
      );

      const csp = res.headers.get('content-security-policy') || '';
      assert.ok(csp.includes("frame-ancestors 'none'"), `${routePath} CSP must enforce frame-ancestors 'none'`);
      assert.equal(
        csp.includes('upgrade-insecure-requests'),
        false,
        `${routePath} plain HTTP CSP must not emit upgrade-insecure-requests`
      );
    }

    // 2. Spoofed X-Forwarded-Proto: https MUST NOT enable HSTS when proxy trust is disabled
    const spoofedRes = await fetch(`${srv.baseUrl}/api/health`, {
      headers: { 'X-Forwarded-Proto': 'https' }
    });
    assert.equal(
      spoofedRes.headers.get('strict-transport-security'),
      null,
      'Untrusted X-Forwarded-Proto: https must not trigger HSTS'
    );

    // 3. CORS behavior remains preserved alongside security headers
    const blockedCors = await fetch(`${srv.baseUrl}/api/config`, {
      headers: { Origin: 'https://evil-untrusted.example' }
    });
    assert.equal(blockedCors.status, 403);
    assert.equal(blockedCors.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(blockedCors.headers.get('x-frame-options'), 'DENY');

    // 4. Trusted HTTPS proxy emits HSTS and upgrade-insecure-requests
    process.env.TRUST_PROXY = '1';
    const trustedApp = express();
    applySecurityHeadersMiddleware(trustedApp, { isDev: false });
    trustedApp.get('/ping', (_req, res) => res.json({ ok: true }));
    const trustedSrv = await startServerForListener(trustedApp);
    try {
      const httpsRes = await fetch(`${trustedSrv.baseUrl}/ping`, {
        headers: { 'X-Forwarded-Proto': 'https' }
      });
      assert.equal(httpsRes.status, 200);
      assert.equal(httpsRes.headers.get('strict-transport-security'), STRICT_TRANSPORT_SECURITY_VALUE);
      assert.equal(httpsRes.headers.get('content-security-policy'), PRODUCTION_CONTENT_SECURITY_POLICY);

      const httpProxyRes = await fetch(`${trustedSrv.baseUrl}/ping`, {
        headers: { 'X-Forwarded-Proto': 'http' }
      });
      assert.equal(httpProxyRes.status, 200);
      assert.equal(httpProxyRes.headers.get('strict-transport-security'), null);
    } finally {
      await trustedSrv.close();
    }
  } finally {
    await srv.close();
    if (prevTrustProxy === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = prevTrustProxy;
    if (prevOrvixTrustProxy === undefined) delete process.env.ORVIX_TRUST_PROXY;
    else process.env.ORVIX_TRUST_PROXY = prevOrvixTrustProxy;
    if (prevVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = prevVercel;
    if (prevKService === undefined) delete process.env.K_SERVICE;
    else process.env.K_SERVICE = prevKService;
  }
});

test('Vercel serverless API handlers emit all six security headers over HTTPS and omit HSTS over plain HTTP', async () => {
  const prevVercel = process.env.VERCEL;
  process.env.VERCEL = '1';

  const endpoints: Array<{
    name: string;
    handler: (req: any, res: any) => any;
    method: string;
    path: string;
  }> = [
    { name: 'api/health', handler: healthHandler, method: 'GET', path: '/api/health' },
    { name: 'api/config', handler: configHandler, method: 'GET', path: '/api/config' },
    { name: 'api/chat', handler: chatHandler, method: 'POST', path: '/api/chat' },
    { name: 'api/share', handler: shareHandler, method: 'GET', path: '/api/share/bad' },
    { name: 'api/transcribe', handler: transcribeHandler, method: 'POST', path: '/api/transcribe' },
    { name: 'api/upload', handler: uploadHandler, method: 'GET', path: '/api/upload/nonexistent/file' }
  ];

  try {
    for (const ep of endpoints) {
      const srv = await startServerForListener((req, res) => ep.handler(req, res));
      try {
        const httpsRes = await fetch(`${srv.baseUrl}${ep.path}`, {
          method: ep.method,
          headers: { 'X-Forwarded-Proto': 'https' }
        });

        assert.equal(httpsRes.headers.get('content-security-policy'), PRODUCTION_CONTENT_SECURITY_POLICY, `${ep.name} CSP`);
        assert.equal(httpsRes.headers.get('strict-transport-security'), STRICT_TRANSPORT_SECURITY_VALUE, `${ep.name} HSTS`);
        assert.equal(httpsRes.headers.get('x-content-type-options'), 'nosniff', `${ep.name} nosniff`);
        assert.equal(httpsRes.headers.get('x-frame-options'), 'DENY', `${ep.name} X-Frame-Options`);
        assert.equal(httpsRes.headers.get('referrer-policy'), 'strict-origin-when-cross-origin', `${ep.name} Referrer-Policy`);
        assert.equal(httpsRes.headers.get('permissions-policy'), PERMISSIONS_POLICY_VALUE, `${ep.name} Permissions-Policy`);
        assert.equal(httpsRes.headers.get('x-powered-by'), null, `${ep.name} X-Powered-By`);

        const httpRes = await fetch(`${srv.baseUrl}${ep.path}`, {
          method: ep.method,
          headers: { 'X-Forwarded-Proto': 'http' }
        });
        assert.equal(
          httpRes.headers.get('strict-transport-security'),
          null,
          `${ep.name} must omit HSTS over plain HTTP`
        );
      } finally {
        await srv.close();
      }
    }
  } finally {
    if (prevVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = prevVercel;
  }
});
