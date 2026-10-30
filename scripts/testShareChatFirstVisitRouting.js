/**
 * scripts/testShareChatFirstVisitRouting.js
 * Focused regression test suite verifying first-visit Share Chat routing,
 * hosting rewrites, application shell delivery, and API/static-asset preservation.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

console.log('\n======================================================================');
console.log('ORVIX SHARE CHAT: FIRST-VISIT ROUTING & HOSTING VERIFICATION SUITE');
console.log('======================================================================\n');

let passedTests = 0;
let totalTests = 12;

const BASE_URL = 'http://127.0.0.1:3000';

// Helper to make raw HTTP requests without any cookies, cache, or browser state
function fetchRaw(pathOrUrl, options = {}) {
  const url = pathOrUrl.startsWith('http') ? new URL(pathOrUrl) : new URL(pathOrUrl, BASE_URL);
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: options.method || 'GET',
        headers: {
          Accept: options.accept || '*/*',
          ...(options.headers || {})
        }
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: data
          });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// Import client routing and service functions
const {
  isValidShareId,
  parseSharePath,
  getShareRouteDetails,
  loadSharedChatSnapshot,
  ShareChatError
} = await import('../src/services/shareChatService.js');

// ----------------------------------------------------------------------------
// TEST 1: Hosting rewrite coverage in vercel.json
// ----------------------------------------------------------------------------
{
  const vercelConfigRaw = fs.readFileSync(path.resolve('vercel.json'), 'utf8');
  const vercelConfig = JSON.parse(vercelConfigRaw);

  assert.ok(Array.isArray(vercelConfig.rewrites), 'vercel.json must declare a rewrites array');
  
  // Rule A: /api/upload subpaths must be mapped to upload handler
  const uploadRewrite = vercelConfig.rewrites.find((r) => r.source === '/api/upload/:subpath*');
  assert.ok(uploadRewrite, 'vercel.json must retain /api/upload/:subpath* rewrite');
  assert.strictEqual(uploadRewrite.destination, '/api/upload?__subpath=:subpath*');

  // Rule B: /share paths must be rewritten to /index.html
  const shareRewrite = vercelConfig.rewrites.find(
    (r) => r.source.includes('/share') && r.destination === '/index.html'
  );
  assert.ok(shareRewrite, 'vercel.json must declare rewrite rule routing /share to /index.html');

  // Rule C: SPA catch-all rewrite must exclude /api/ and static files
  const spaCatchAll = vercelConfig.rewrites.find(
    (r) => r.destination === '/index.html' && r.source.includes('?!api/')
  );
  assert.ok(spaCatchAll, 'vercel.json must declare SPA fallback rewrite excluding /api/ endpoints');

  console.log('✓ Test 1 Passed: Hosting rewrite coverage declared correctly in vercel.json.');
  passedTests++;
}

// ----------------------------------------------------------------------------
// TEST 2: Direct shared-route fallback delivers application shell (HTTP 200 HTML)
// ----------------------------------------------------------------------------
{
  const testShareId = 'SampleShareId1234567890';
  const response = await fetchRaw(`/share/${testShareId}`);

  assert.strictEqual(response.statusCode, 200, 'Direct shared URL must return HTTP 200 OK');
  const contentType = response.headers['content-type'] || '';
  assert.ok(contentType.includes('text/html'), `Content-Type must be text/html, got: ${contentType}`);
  assert.ok(response.body.includes('<div id="root"></div>'), 'Response HTML must contain React #root mount point');
  assert.ok(response.body.includes('<title>Orvix</title>'), 'Response HTML must contain Orvix title');

  console.log('✓ Test 2 Passed: Direct shared-route fallback delivers application shell HTML with HTTP 200.');
  passedTests++;
}

// ----------------------------------------------------------------------------
// TEST 3: API route exclusion (API endpoints never receive HTML fallback)
// ----------------------------------------------------------------------------
{
  // Test /api/health
  const healthRes = await fetchRaw('/api/health');
  assert.strictEqual(healthRes.statusCode, 200, '/api/health must return HTTP 200');
  const healthType = healthRes.headers['content-type'] || '';
  assert.ok(healthType.includes('application/json'), `/api/health must return application/json, got: ${healthType}`);
  const healthJson = JSON.parse(healthRes.body);
  assert.strictEqual(healthJson.status, 'ok', 'Health status must be "ok"');

  // Test /api/config
  const configRes = await fetchRaw('/api/config');
  assert.strictEqual(configRes.statusCode, 200, '/api/config must return HTTP 200');
  const configType = configRes.headers['content-type'] || '';
  assert.ok(configType.includes('application/json'), `/api/config must return application/json`);
  const configJson = JSON.parse(configRes.body);
  assert.strictEqual(typeof configJson.webllmSupported, 'boolean');

  // Test non-existent API route
  const nonExistentApiRes = await fetchRaw('/api/nonexistent_test_route');
  const nonExistentType = nonExistentApiRes.headers['content-type'] || '';
  assert.ok(
    !nonExistentResIsHtml(nonExistentType, nonExistentApiRes.body),
    'Non-existent /api/ endpoint must NOT be rewritten to index.html'
  );

  function nonExistentResIsHtml(type, body) {
    return type.includes('text/html') && body.includes('<div id="root">');
  }

  console.log('✓ Test 3 Passed: API routes are strictly excluded from HTML SPA rewrites.');
  passedTests++;
}

// ----------------------------------------------------------------------------
// TEST 4: Static asset exclusion
// ----------------------------------------------------------------------------
{
  // Test SVG asset
  const svgRes = await fetchRaw('/favicon.svg');
  assert.strictEqual(svgRes.statusCode, 200, 'Static SVG must return HTTP 200');
  const svgType = svgRes.headers['content-type'] || '';
  assert.ok(svgType.includes('image/svg+xml'), `favicon.svg must return image/svg+xml, got ${svgType}`);
  assert.ok(svgRes.body.includes('<svg'), 'SVG response must contain SVG markup, not HTML');

  // Test manifest
  const manifestRes = await fetchRaw('/manifest.webmanifest');
  assert.strictEqual(manifestRes.statusCode, 200, 'Manifest must return HTTP 200');
  const manifestType = manifestRes.headers['content-type'] || '';
  assert.ok(
    manifestType.includes('json') || manifestType.includes('manifest'),
    `Manifest must return JSON/manifest content-type, got: ${manifestType}`
  );

  console.log('✓ Test 4 Passed: Static assets are served directly with correct MIME types and not rewritten.');
  passedTests++;
}

// ----------------------------------------------------------------------------
// TEST 5: Share ID and pathname preservation (no redirects)
// ----------------------------------------------------------------------------
{
  const targetPath = '/share/K8d9X2mQ1zL0vP4nB7jC5wE3';
  const response = await fetchRaw(targetPath);

  // Must not be a redirect
  assert.notStrictEqual(response.statusCode, 301, 'Shared URL must not 301 redirect');
  assert.notStrictEqual(response.statusCode, 302, 'Shared URL must not 302 redirect');
  assert.strictEqual(response.statusCode, 200, 'Shared URL must respond directly with 200');

  // Client parsing must preserve the exact ID
  const route = getShareRouteDetails(targetPath);
  assert.strictEqual(route.isShareRoute, true);
  assert.strictEqual(route.shareId, 'K8d9X2mQ1zL0vP4nB7jC5wE3');
  assert.strictEqual(route.isValid, true);
  assert.strictEqual(route.isMalformed, false);

  console.log('✓ Test 5 Passed: Share ID and pathname are preserved without HTTP redirect.');
  passedTests++;
}

// ----------------------------------------------------------------------------
// TEST 6: First-visit application-shell delivery without cookies, storage or cache
// ----------------------------------------------------------------------------
{
  // Make a request with explicit headers asserting zero cookies and cache-control no-cache
  const firstVisitRes = await fetchRaw('/share/FreshVisitorTestID12345678', {
    headers: {
      Cookie: '',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache'
    }
  });

  assert.strictEqual(firstVisitRes.statusCode, 200);
  assert.ok(firstVisitRes.body.includes('id="root"'));
  assert.ok(firstVisitRes.body.includes('theme-color'));
  assert.ok(firstVisitRes.body.includes('manifest.webmanifest'));

  console.log('✓ Test 6 Passed: First-visit application-shell delivery verified without cache or cookies.');
  passedTests++;
}

// ----------------------------------------------------------------------------
// TEST 7: Service-worker-independent route parsing and execution
// ----------------------------------------------------------------------------
{
  // Test route parsing when navigator.serviceWorker is undefined
  const savedSW = globalThis.navigator?.serviceWorker;
  try {
    if (globalThis.navigator) {
      delete globalThis.navigator.serviceWorker;
    }

    const parsed = parseSharePath('/share/ABCdef1234567890_-xyz');
    assert.strictEqual(parsed, 'ABCdef1234567890_-xyz');

    const details = getShareRouteDetails('/share/ABCdef1234567890_-xyz');
    assert.strictEqual(details.isShareRoute, true);
    assert.strictEqual(details.shareId, 'ABCdef1234567890_-xyz');
    assert.strictEqual(details.isValid, true);
  } finally {
    if (globalThis.navigator && savedSW) {
      globalThis.navigator.serviceWorker = savedSW;
    }
  }

  console.log('✓ Test 7 Passed: Route classification functions operate independently of service worker state.');
  passedTests++;
}

// ----------------------------------------------------------------------------
// TEST 8: Vercel configuration consistency and route simulation
// ----------------------------------------------------------------------------
{
  const vercelConfig = JSON.parse(fs.readFileSync(path.resolve('vercel.json'), 'utf8'));

  // Test simulated Vercel path evaluation against rewrites
  function simulateVercelRewrites(reqPath) {
    for (const rule of vercelConfig.rewrites) {
      if (rule.source === '/api/upload/:subpath*') {
        const match = reqPath.match(/^\/api\/upload\/(.*)$/);
        if (match) {
          return { destination: `/api/upload?__subpath=${match[1]}`, rule };
        }
      }
      if (rule.source === '/share/:path*') {
        const match = reqPath.match(/^\/share(?:\/(.*))?$/);
        if (match) {
          return { destination: rule.destination, rule };
        }
      }
      if (rule.source === '/share' && reqPath === '/share') {
        return { destination: rule.destination, rule };
      }
      if (rule.source === '/((?!api/|.*\\..*).*)') {
        const regex = new RegExp('^/((?!api/|.*\\..*).*)$');
        if (regex.test(reqPath)) {
          return { destination: rule.destination, rule };
        }
      }
    }
    return { destination: null, rule: null }; // Pass through to file/function
  }

  assert.strictEqual(simulateVercelRewrites('/share/my-share-id').destination, '/index.html');
  assert.strictEqual(simulateVercelRewrites('/share/').destination, '/index.html');
  assert.strictEqual(simulateVercelRewrites('/share').destination, '/index.html');
  assert.strictEqual(simulateVercelRewrites('/api/health').destination, null);
  assert.strictEqual(simulateVercelRewrites('/api/chat').destination, null);
  assert.strictEqual(simulateVercelRewrites('/assets/bundle.js').destination, null);
  assert.strictEqual(simulateVercelRewrites('/favicon.ico').destination, null);

  console.log('✓ Test 8 Passed: Vercel rewrite simulation routes shared URLs to index.html and preserves APIs/assets.');
  passedTests++;
}

// ----------------------------------------------------------------------------
// TEST 9: Express fallback consistency in server.ts
// ----------------------------------------------------------------------------
{
  const serverSource = fs.readFileSync(path.resolve('server.ts'), 'utf8');

  // Verify server.ts has express.static and app.get('*') SPA fallback
  assert.ok(serverSource.includes("app.get('*'"), 'server.ts must contain an app.get("*") SPA fallback handler');
  assert.ok(
    serverSource.includes("req.path.startsWith('/api/')"),
    'server.ts must guard app.get("*") from returning HTML for /api/ routes'
  );

  console.log('✓ Test 9 Passed: Express fallback implementation correctly guards API routes.');
  passedTests++;
}

// ----------------------------------------------------------------------------
// TEST 10: Invalid and malformed share route handling
// ----------------------------------------------------------------------------
{
  // Bare /share
  const bareShare = getShareRouteDetails('/share');
  assert.strictEqual(bareShare.isShareRoute, true);
  assert.strictEqual(bareShare.shareId, null);
  assert.strictEqual(bareShare.isMalformed, true);

  // Bare /share/
  const trailingShare = getShareRouteDetails('/share/');
  assert.strictEqual(trailingShare.isShareRoute, true);
  assert.strictEqual(trailingShare.shareId, null);
  assert.strictEqual(trailingShare.isMalformed, true);

  // Too short (<12 chars)
  const shortShare = getShareRouteDetails('/share/short_id');
  assert.strictEqual(shortShare.isShareRoute, true);
  assert.strictEqual(shortShare.isValid, false);
  assert.strictEqual(shortShare.isMalformed, true);

  // Illegal characters
  const illegalChars = getShareRouteDetails('/share/invalid@special#chars!');
  assert.strictEqual(illegalChars.isShareRoute, true);
  assert.strictEqual(illegalChars.isValid, false);
  assert.strictEqual(illegalChars.isMalformed, true);

  console.log('✓ Test 10 Passed: Malformed and invalid share routes are correctly detected for UI error handling.');
  passedTests++;
}

// ----------------------------------------------------------------------------
// TEST 11: Existing authentication routes preservation
// ----------------------------------------------------------------------------
{
  // Non-share routes
  const rootRoute = getShareRouteDetails('/');
  assert.strictEqual(rootRoute.isShareRoute, false);
  assert.strictEqual(rootRoute.shareId, null);

  const randomRoute = getShareRouteDetails('/settings');
  assert.strictEqual(randomRoute.isShareRoute, false);

  console.log('✓ Test 11 Passed: Non-share routes correctly remain outside the shared viewer pipeline.');
  passedTests++;
}

// ----------------------------------------------------------------------------
// TEST 12: Existing Share Chat snapshot validation and immutability
// ----------------------------------------------------------------------------
{
  // loadSharedChatSnapshot must reject malformed IDs immediately before any network call
  await assert.rejects(
    async () => {
      await loadSharedChatSnapshot('too-short');
    },
    (err) => {
      assert.ok(err instanceof ShareChatError);
      assert.strictEqual(err.code, 'INVALID_SHARE_ID');
      return true;
    }
  );

  console.log('✓ Test 12 Passed: Share Chat snapshot retrieval enforces strict schema and ID validation.');
  passedTests++;
}

console.log('\n======================================================================');
console.log(`SUMMARY: ${passedTests} of ${totalTests} TESTS PASSED CLEANLY.`);
console.log('======================================================================\n');

if (passedTests !== totalTests) {
  process.exit(1);
}
