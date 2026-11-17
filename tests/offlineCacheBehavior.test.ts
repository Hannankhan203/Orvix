import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ORVIX_PWA_OPTIONS } from '../vite.config.ts';

function getPwaWorkboxConfig() {
  return ORVIX_PWA_OPTIONS.workbox;
}

test('Workbox config preserves fresh-install precache parity for Browser AI, KaTeX math, and ZIP/PPTX assets', () => {
  const source = fs.readFileSync(path.resolve('vite.config.ts'), 'utf8');
  const wb = getPwaWorkboxConfig();

  const globIgnores: string[] = wb?.globIgnores || [];
  assert.ok(globIgnores.length > 0, 'workbox.globIgnores should exclude oversized on-demand assets');

  // Critical features that were precached before INFO-OPT-01 must NOT be excluded from precache
  assert.equal(
    globIgnores.some((pat) => pat.includes('webllmService')),
    false,
    'webllmService must stay precached so Browser AI readiness and model UI work offline on fresh installs'
  );
  assert.equal(
    globIgnores.some((pat) => pat.includes('jszip')),
    false,
    'jszip must stay precached so offline PPTX/ZIP document extraction works on fresh installs'
  );
  assert.equal(
    globIgnores.some((pat) => pat.includes('mathMarkdownPlugins')),
    false,
    'mathMarkdownPlugins JS/CSS must stay precached so offline LaTeX math rendering works on fresh installs'
  );
  assert.equal(
    globIgnores.some((pat) => pat === '**/assets/KaTeX_*'),
    false,
    'Modern KaTeX .woff2 fonts must NOT be excluded from precache'
  );

  // Heavy non-initial workers/parsers stay out of eager SW precache
  for (const expectedIgnore of [
    '**/assets/webllmWorker-*.js',
    '**/assets/pdfExtractorWorker-*.js',
    '**/assets/pdfjs-*.js',
    '**/assets/es-*.js',
    '**/assets/lib-*.js',
    '**/assets/xlsx-*.js',
    '**/assets/cfb-*.js',
    '**/assets/KaTeX_*.woff',
    '**/assets/KaTeX_*.ttf',
    '**/assets/*oxipng*',
    '**/assets/worker-*.js'
  ]) {
    assert.ok(
      globIgnores.includes(expectedIgnore),
      `Expected heavy asset pattern "${expectedIgnore}" to remain in globIgnores`
    );
  }

  // Verify Workbox SPA offline navigation and activation flags
  assert.equal(wb?.clientsClaim ?? source.includes('clientsClaim: true'), true);
  assert.equal(wb?.skipWaiting ?? source.includes('skipWaiting: true'), true);
  assert.equal(wb?.navigateFallback, '/index.html');
});

test('orvix-ondemand-assets CacheFirst matcher covers same-origin lazy chunks, workers, WASMs, CSS, and fonts only', () => {
  const wb = getPwaWorkboxConfig();
  const runtimeCaching: any[] = wb?.runtimeCaching || [];
  const onDemandRule = runtimeCaching.find((r) => r?.options?.cacheName === 'orvix-ondemand-assets');

  assert.ok(onDemandRule, 'orvix-ondemand-assets runtimeCaching rule must exist');
  assert.equal(onDemandRule.handler, 'CacheFirst');
  assert.equal(onDemandRule.options.expiration.maxEntries, 128);
  assert.deepEqual(onDemandRule.options.cacheableResponse.statuses, [0, 200]);

  const matchUrl = onDemandRule.urlPattern as (ctx: { sameOrigin: boolean; url: URL }) => boolean;
  assert.equal(typeof matchUrl, 'function');

  // Returning-user on-demand chunks & workers MUST match
  for (const pathname of [
    '/assets/xlsx-CAdriLZP.js',
    '/assets/cfb-Dob9bPfN.js',
    '/assets/es-DH1W5oQX.js',
    '/assets/lib-COvl4skP.js',
    '/assets/pdfjs-Dts6Jluq.js',
    '/assets/pdfExtractorWorker-CtljDtvf.js',
    '/assets/webllmWorker-XN9rXQug.js',
    '/assets/squoosh_oxipng_bg-OFMN1KwG.wasm',
    '/assets/mathMarkdownPlugins-Bv5fr4tV.css',
    '/assets/KaTeX_Main-Regular-Dr94JaBh.woff',
    '/assets/KaTeX_Main-Regular-ypZvNtVU.ttf',
    '/assets/KaTeX_Main-Regular-B22Nviop.woff2'
  ]) {
    assert.equal(
      matchUrl({ sameOrigin: true, url: new URL(`https://orvix.app${pathname}`) }),
      true,
      `Expected same-origin on-demand asset ${pathname} to match CacheFirst`
    );
  }

  // API endpoints & cross-origin weight CDNs MUST NOT match
  assert.equal(
    matchUrl({ sameOrigin: true, url: new URL('https://orvix.app/api/chat') }),
    false
  );
  assert.equal(
    matchUrl({ sameOrigin: true, url: new URL('https://orvix.app/sw.js') }),
    false
  );
  assert.equal(
    matchUrl({
      sameOrigin: false,
      url: new URL('https://huggingface.co/mlc-ai/Qwen2.5-1.5B-Instruct-q4f16_1-MLC/resolve/main/assets/shard.js')
    }),
    false
  );
});

test('Generated Service Worker (when dist exists) executes install/activate/precache/cleanup and includes core + restored offline routes', () => {
  const swPath = path.resolve('dist', 'sw.js');
  const htmlPath = path.resolve('dist', 'index.html');
  if (!fs.existsSync(swPath) || !fs.existsSync(htmlPath)) {
    // CI runs tests before `bun run build`; Vite config assertions above still execute unconditionally.
    return;
  }

  const swCode = fs.readFileSync(swPath, 'utf8');
  const indexHtml = fs.readFileSync(htmlPath, 'utf8');

  let capturedManifest: Array<{ url: string; revision: string | null }> = [];
  let cleanedOutdated = false;
  let skippedWaiting = false;
  let claimedClients = false;
  const registeredRoutes: Array<{ matcher: any; handler: any; method?: string }> = [];
  let navigationFallbackUrl: string | null = null;
  let navigationDenylist: RegExp[] = [];

  class FakeNavigationRoute {
    handler: any;
    denylist: RegExp[];
    constructor(handler: any, opts: { denylist?: RegExp[] } = {}) {
      this.handler = handler;
      this.denylist = opts.denylist || [];
      navigationDenylist = this.denylist;
    }
  }
  class FakeNetworkOnly {}
  class FakeCacheFirst {
    config: any;
    constructor(config: any) {
      this.config = config;
    }
  }
  class FakeExpirationPlugin {
    config: any;
    constructor(config: any) {
      this.config = config;
    }
  }
  class FakeCacheableResponsePlugin {
    config: any;
    constructor(config: any) {
      this.config = config;
    }
  }

  const workboxShim = {
    clientsClaim() {
      claimedClients = true;
    },
    precacheAndRoute(entries: Array<{ url: string; revision: string | null }>) {
      capturedManifest = entries;
    },
    cleanupOutdatedCaches() {
      cleanedOutdated = true;
    },
    NavigationRoute: FakeNavigationRoute,
    createHandlerBoundToURL(url: string) {
      navigationFallbackUrl = url;
      return { boundUrl: url };
    },
    registerRoute(matcher: any, handler: any, method?: string) {
      registeredRoutes.push({ matcher, handler, method });
    },
    NetworkOnly: FakeNetworkOnly,
    CacheFirst: FakeCacheFirst,
    ExpirationPlugin: FakeExpirationPlugin,
    CacheableResponsePlugin: FakeCacheableResponsePlugin
  };

  let amdFactory: ((wb: any) => void) | undefined;
  const sandbox = {
    self: {
      skipWaiting() {
        skippedWaiting = true;
      }
    },
    define(_deps: string[], factory: (wb: any) => void) {
      amdFactory = factory;
    }
  };
  vm.runInNewContext(swCode, sandbox);
  if (typeof amdFactory !== 'function') {
    assert.fail('dist/sw.js must register a Workbox AMD module');
  }
  (amdFactory as (wb: any) => void)(workboxShim);

  assert.equal(skippedWaiting, true);
  assert.equal(claimedClients, true);
  assert.equal(cleanedOutdated, true);
  assert.equal(navigationFallbackUrl, '/index.html');

  const urls = new Set(capturedManifest.map((e) => e.url));

  // Every script/preload/stylesheet referenced in dist/index.html must be precached
  const htmlRefs = Array.from(indexHtml.matchAll(/(?:src|href)="\/(assets\/[^"]+)"/g)).map((m) => m[1]);
  assert.ok(htmlRefs.length >= 2);
  for (const ref of htmlRefs) {
    assert.ok(urls.has(ref), `Initial HTML reference ${ref} must be in SW precache`);
  }

  // Fresh-install offline essentials must be precached
  const hasUrlMatching = (re: RegExp) => Array.from(urls).some((u) => re.test(u));
  assert.ok(urls.has('index.html'));
  assert.ok(urls.has('manifest.webmanifest'));
  assert.ok(hasUrlMatching(/^assets\/ChatPage-.*\.js$/));
  assert.ok(hasUrlMatching(/^assets\/AuthScreen-.*\.js$/));
  assert.ok(hasUrlMatching(/^assets\/SettingsModal-.*\.js$/));
  assert.ok(hasUrlMatching(/^assets\/ShareChatModal-.*\.js$/));
  assert.ok(hasUrlMatching(/^assets\/DocumentPreviewModal-.*\.js$/));
  assert.ok(hasUrlMatching(/^assets\/MarkdownContent-.*\.js$/));
  assert.ok(hasUrlMatching(/^assets\/mathMarkdownPlugins-.*\.js$/));
  assert.ok(hasUrlMatching(/^assets\/mathMarkdownPlugins-.*\.css$/));
  assert.ok(hasUrlMatching(/^assets\/KaTeX_Main-Regular-.*\.woff2$/));
  assert.ok(hasUrlMatching(/^assets\/webllmService-.*\.js$/));
  assert.ok(hasUrlMatching(/^assets\/jszip\.min-.*\.js$/));
  assert.ok(hasUrlMatching(/^assets\/exportConversation-.*\.js$/));
  assert.ok(hasUrlMatching(/^assets\/attachmentCompressionCoordinator-.*\.js$/));

  // Heavy on-demand workers/parsers & legacy fonts remain excluded from precache
  assert.equal(hasUrlMatching(/^assets\/webllmWorker-.*\.js$/), false);
  assert.equal(hasUrlMatching(/^assets\/pdfjs-.*\.js$/), false);
  assert.equal(hasUrlMatching(/^assets\/xlsx-.*\.js$/), false);
  assert.equal(hasUrlMatching(/^assets\/es-.*\.js$/), false);
  assert.equal(hasUrlMatching(/^assets\/lib-.*\.js$/), false);
  assert.equal(hasUrlMatching(/^assets\/KaTeX_.*\.(woff|ttf)$/), false);

  // Offline route navigation: / and /share/... are allowed while /api/... is denylisted
  assert.equal(navigationDenylist.some((re) => re.test('/share/abc12345')), false);
  assert.equal(navigationDenylist.some((re) => re.test('/api/chat')), true);
  assert.equal(navigationDenylist.some((re) => re.test('/health')), true);

  // Verify CacheFirst runtime handler registered for returning-user on-demand chunks
  const cacheFirstRoute = registeredRoutes.find((r) => r.handler instanceof FakeCacheFirst);
  assert.ok(cacheFirstRoute, 'Expected CacheFirst runtime route in dist/sw.js');
  assert.equal(cacheFirstRoute!.handler.config.cacheName, 'orvix-ondemand-assets');
});
