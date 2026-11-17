import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import {
  LOCK_TIMEOUT_MS,
  acquireQuotaLock,
  reserveUploadSlot,
  commitUploadSlot,
  releaseUploadSlot,
  getQuotaStatus,
  setFirestoreForTesting,
  resetFirestoreForTesting,
  resetQuotaForTesting,
  setLockTimeoutMsForTesting,
  isQuotaLockHeldForTesting,
  getActiveQuotaLockCountForTesting
} from '../server/uploadQuotaService.ts';
// @ts-ignore
import { APP_CONFIG } from '../src/config/appConfig.js';
// @ts-ignore
import {
  readMigratedStorageItem,
  removeMigratedStorageItem,
  migrateLegacyStorage
} from '../src/utils/legacyStorageMigration.js';
// @ts-ignore
import { AuthProvider, useAuth } from '../src/context/AuthContext.jsx';

const REPO_ROOT = process.cwd();

function createMemoryStorage(
  initial: Record<string, string> = {},
  options?: { failSetItem?: boolean }
): Storage & { dump(): Record<string, string> } {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      if (options?.failSetItem) {
        const err: any = new Error('QuotaExceededError');
        err.name = 'QuotaExceededError';
        throw err;
      }
      store.set(String(key), String(value));
    },
    dump() {
      return Object.fromEntries(store.entries());
    }
  };
}

// ============================================================================
// ORVIX-LOW-01: Duplicate Service Worker Routes
// ============================================================================

test('ORVIX-LOW-01: server.ts registers single /sw.js and /manifest.webmanifest routes and serves dist/sw.js in production without cache', async () => {
  const prevTesting = process.env.TESTING;
  const prevNodeEnv = process.env.NODE_ENV;
  process.env.TESTING = '1';

  const { app } = await import('../server.ts');

  const routePaths: string[] = [];
  const stack = (app as any)?._router?.stack || [];
  for (const layer of stack) {
    if (layer?.route?.path) {
      const p = layer.route.path;
      if (Array.isArray(p)) {
        routePaths.push(...p);
      } else {
        routePaths.push(String(p));
      }
    }
  }

  assert.equal(
    routePaths.filter((p) => p === '/sw.js').length,
    1,
    'Express app must have exactly one /sw.js route registration'
  );
  assert.equal(
    routePaths.filter((p) => p === '/manifest.webmanifest').length,
    1,
    'Express app must have exactly one /manifest.webmanifest route registration'
  );

  // Also ensure startServer() does not define duplicate ['/sw.js', '/manifest.webmanifest'] route
  const serverSource = fs.readFileSync(path.join(REPO_ROOT, 'server.ts'), 'utf8');
  assert.equal(
    serverSource.includes("app.get(['/sw.js', '/manifest.webmanifest']"),
    false,
    'server.ts must not contain duplicate production /sw.js route middleware'
  );

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Development mode must not serve stale dist/sw.js
    process.env.NODE_ENV = 'development';
    const devSwRes = await fetch(`${baseUrl}/sw.js`);
    assert.equal(devSwRes.status, 200);
    assert.match(devSwRes.headers.get('cache-control') || '', /no-store/);
    const devSwBody = await devSwRes.text();
    assert.match(devSwBody, /development service worker stub/);

    // 2. Production mode serves built dist/sw.js if present (or 404 if not yet built)
    process.env.NODE_ENV = 'production';
    const distSwPath = path.join(REPO_ROOT, 'dist', 'sw.js');
    const prodSwRes = await fetch(`${baseUrl}/sw.js`);
    assert.match(prodSwRes.headers.get('cache-control') || '', /no-cache, no-store, must-revalidate/);
    assert.equal(prodSwRes.headers.get('pragma'), 'no-cache');
    assert.equal(prodSwRes.headers.get('expires'), '0');
    if (fs.existsSync(distSwPath)) {
      assert.equal(prodSwRes.status, 200);
      assert.match(prodSwRes.headers.get('content-type') || '', /javascript/);
      const prodSwBody = await prodSwRes.text();
      assert.equal(prodSwBody, fs.readFileSync(distSwPath, 'utf8'));
    } else {
      assert.equal(prodSwRes.status, 404);
    }

    // 3. Manifest serves with no-cache headers and valid JSON
    const manifestRes = await fetch(`${baseUrl}/manifest.webmanifest`);
    assert.equal(manifestRes.status, 200);
    assert.match(manifestRes.headers.get('cache-control') || '', /no-store/);
    const manifestJson = (await manifestRes.json()) as any;
    assert.equal(manifestJson.short_name, 'Orvix');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    if (prevTesting === undefined) delete process.env.TESTING;
    else process.env.TESTING = prevTesting;
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
  }
});

// ============================================================================
// ORVIX-LOW-02: Application Version Mismatch
// ============================================================================

test('ORVIX-LOW-02: package.json, APP_CONFIG.version, and README.md current version align on 0.4.3', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const readme = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');

  const readmeMatch = readme.match(/\*\*Version:\s*V\s*([0-9]+\.[0-9]+\.[0-9]+)\*\*/i);
  assert.ok(readmeMatch, 'README.md must declare current **Version: V X.Y.Z**');

  const changelogMatch = readme.match(/## Version History & Release Changelog[\s\S]*?###\s*V\s*([0-9]+\.[0-9]+\.[0-9]+)/i);
  assert.ok(changelogMatch, 'README.md changelog must list latest release header');

  assert.equal(pkg.version, '0.4.3');
  assert.equal(APP_CONFIG.version, '0.4.3');
  assert.equal(readmeMatch![1], pkg.version);
  assert.equal(changelogMatch![1], pkg.version);
});

// ============================================================================
// ORVIX-LOW-03: Legacy Chatora Storage Keys
// ============================================================================

test('ORVIX-LOW-03: legacy Chatora storage keys are migrated safely without scattered inline references or unnecessary deletion', async () => {
  // 1. Ensure no scattered chatora_ references remain in src/ outside legacyStorageMigration.js
  const srcRoot = path.join(REPO_ROOT, 'src');
  const legacyMatches: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (/\.(js|jsx|ts|tsx)$/.test(entry.name)) {
        const rel = path.relative(REPO_ROOT, fullPath);
        if (rel === path.join('src', 'utils', 'legacyStorageMigration.js')) continue;
        const content = fs.readFileSync(fullPath, 'utf8');
        if (/chatora/i.test(content)) {
          legacyMatches.push(rel);
        }
      }
    }
  };
  walk(srcRoot);
  assert.deepEqual(
    legacyMatches,
    [],
    `Legacy chatora references must be centralized in legacyStorageMigration.js; found in: ${legacyMatches.join(', ')}`
  );

  // 2. Test one-way migration preserves data, ignores unrelated keys, and protects existing orvix_* keys
  const sStorage = createMemoryStorage({
    chatora_active_chat: 'legacy-chat-42',
    chatora_guest_session: JSON.stringify({ uid: 'guest-legacy-1', displayName: 'Legacy Guest', isAnonymous: true }),
    unrelated_session_key: 'keep-me'
  });
  const lStorage = createMemoryStorage({
    chatora_selected_provider: 'gemini',
    chatora_guest_pins: JSON.stringify(['legacy-chat-42']),
    chatora_guest_chats: JSON.stringify([{ id: 'legacy-chat-42', title: 'Old Chat' }]),
    orvix_active_theme: 'dark',
    unrelated_local_key: 'keep-local'
  });

  const prevWindow = (globalThis as any).window;
  const prevDocument = (globalThis as any).document;
  const prevSession = (globalThis as any).sessionStorage;
  const prevLocal = (globalThis as any).localStorage;
  const prevAct = (globalThis as any).IS_REACT_ACT_ENVIRONMENT;

  (globalThis as any).sessionStorage = sStorage;
  (globalThis as any).localStorage = lStorage;

  try {
    migrateLegacyStorage();

    assert.equal(sStorage.getItem('orvix_active_chat'), 'legacy-chat-42');
    assert.equal(sStorage.getItem('chatora_active_chat'), null);
    assert.equal(sStorage.getItem('unrelated_session_key'), 'keep-me');

    assert.equal(lStorage.getItem('orvix_selected_provider'), 'gemini');
    assert.equal(lStorage.getItem('chatora_selected_provider'), null);
    assert.equal(lStorage.getItem('orvix_guest_pins'), JSON.stringify(['legacy-chat-42']));
    assert.equal(lStorage.getItem('orvix_guest_chats'), JSON.stringify([{ id: 'legacy-chat-42', title: 'Old Chat' }]));
    assert.equal(lStorage.getItem('orvix_active_theme'), 'dark');
    assert.equal(lStorage.getItem('unrelated_local_key'), 'keep-local');

    // Existing orvix_* key must NOT be overwritten if both legacy and current exist
    const dualStorage = createMemoryStorage({
      orvix_selected_provider: 'groq',
      chatora_selected_provider: 'gemini'
    });
    assert.equal(readMigratedStorageItem(dualStorage, 'orvix_selected_provider'), 'groq');
    assert.equal(dualStorage.getItem('orvix_selected_provider'), 'groq');

    // If write throws QuotaExceededError, legacy data MUST NOT be deleted
    const readOnlyOrFullStorage = createMemoryStorage(
      { chatora_guest_chats: JSON.stringify([{ id: 'precious-chat' }]) },
      { failSetItem: true }
    );
    const recovered = readMigratedStorageItem(readOnlyOrFullStorage, 'orvix_guest_chats');
    assert.equal(recovered, JSON.stringify([{ id: 'precious-chat' }]));
    assert.equal(
      readOnlyOrFullStorage.getItem('chatora_guest_chats'),
      JSON.stringify([{ id: 'precious-chat' }]),
      'Legacy key must stay intact if migration write fails'
    );

    // 3. Verify AuthProvider seamlessly restores a legacy chatora_guest_session and logs out cleanly
    const legacyGuestSStorage = createMemoryStorage({
      chatora_guest_session: JSON.stringify({
        uid: 'legacy-guest-99',
        email: 'guest@orvix.ai',
        displayName: 'Migrated Guest',
        username: 'Migrated Guest',
        isAnonymous: true
      })
    });
    const legacyGuestLStorage = createMemoryStorage();
    const makeEl = (tag: string, doc: any) => ({
      tagName: tag.toUpperCase(),
      nodeType: 1,
      ownerDocument: doc,
      childNodes: [] as any[],
      style: {},
      addEventListener() {},
      removeEventListener() {},
      appendChild(c: any) {
        this.childNodes.push(c);
        return c;
      },
      removeChild(c: any) {
        this.childNodes = this.childNodes.filter((x: any) => x !== c);
        return c;
      },
      insertBefore(c: any) {
        this.childNodes.push(c);
        return c;
      },
      hasChildNodes() {
        return this.childNodes.length > 0;
      },
      setAttribute() {},
      removeAttribute() {}
    });
    const doc: any = {
      nodeType: 9,
      createElement: (t: string) => makeEl(t, doc),
      createTextNode: (txt: string) => ({ nodeType: 3, nodeValue: txt, ownerDocument: doc }),
      addEventListener() {},
      removeEventListener() {}
    };
    const view: any = {
      HTMLIFrameElement: class {},
      sessionStorage: legacyGuestSStorage,
      localStorage: legacyGuestLStorage,
      addEventListener() {},
      removeEventListener() {}
    };
    doc.defaultView = view;
    doc.documentElement = makeEl('html', doc);
    doc.body = makeEl('body', doc);

    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    (globalThis as any).window = view;
    (globalThis as any).document = doc;
    (globalThis as any).sessionStorage = legacyGuestSStorage;
    (globalThis as any).localStorage = legacyGuestLStorage;

    let authState: any = null;
    function Reader() {
      authState = useAuth();
      return null;
    }
    const fakeAuthDeps = {
      isFirebaseConfigured: () => false,
      isBrowserOnline: () => true,
      onAuthChange: (cb: (u: any) => void) => {
        cb(null);
        return () => {};
      },
      loginWithEmail: async () => ({ user: null }),
      signupWithEmail: async () => ({ user: null }),
      logout: async () => {},
      getUserProfile: async () => null,
      saveUserProfile: async () => {}
    };

    const root: Root = createRoot(makeEl('div', doc) as any);
    await act(async () => {
      root.render(
        React.createElement(AuthProvider as any, { authDeps: fakeAuthDeps }, React.createElement(Reader))
      );
    });

    assert.equal(authState.currentUser?.uid, 'legacy-guest-99');
    assert.ok(legacyGuestSStorage.getItem('orvix_guest_session'));
    assert.equal(legacyGuestSStorage.getItem('chatora_guest_session'), null);

    await act(async () => {
      await authState.logout();
    });
    assert.equal(authState.currentUser, null);
    assert.equal(legacyGuestSStorage.getItem('orvix_guest_session'), null);
    assert.equal(legacyGuestSStorage.getItem('chatora_guest_session'), null);

    // removeMigratedStorageItem removes both keys cleanly if an alias remained
    const cleanTarget = createMemoryStorage({ orvix_active_chat: 'c1', chatora_active_chat: 'c0' });
    removeMigratedStorageItem(cleanTarget, 'orvix_active_chat');
    assert.equal(cleanTarget.getItem('orvix_active_chat'), null);
    assert.equal(cleanTarget.getItem('chatora_active_chat'), null);

    await act(async () => {
      root.unmount();
    });
  } finally {
    if (prevAct === undefined) delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
    else (globalThis as any).IS_REACT_ACT_ENVIRONMENT = prevAct;
    if (prevWindow === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = prevWindow;
    if (prevDocument === undefined) delete (globalThis as any).document;
    else (globalThis as any).document = prevDocument;
    if (prevSession === undefined) delete (globalThis as any).sessionStorage;
    else (globalThis as any).sessionStorage = prevSession;
    if (prevLocal === undefined) delete (globalThis as any).localStorage;
    else (globalThis as any).localStorage = prevLocal;
  }
});

// ============================================================================
// ORVIX-LOW-04: Upload Lock Timeout & Token-Safe Lock Cleanup
// ============================================================================

test('ORVIX-LOW-04: hanging Firestore transaction times out cleanly, cleans up lock, and prevents stale lock release', async () => {
  await resetQuotaForTesting();
  resetFirestoreForTesting();

  assert.equal(LOCK_TIMEOUT_MS, 15_000);

  const identity = {
    type: 'auth' as const,
    id: 'lock-timeout-user',
    key: 'auth_lock_timeout_user'
  };

  try {
    // 1. Token-guarded release: stale/failed Operation A cannot release Operation B's active lock
    const lockA = await acquireQuotaLock(identity.key, 35);
    assert.equal(isQuotaLockHeldForTesting(identity.key), true);

    await new Promise((r) => setTimeout(r, 55));

    // Operation B reclaims expired lock with its own distinct token
    const lockB = await acquireQuotaLock(identity.key, 500);
    assert.notEqual(lockA.token, lockB.token);
    assert.equal(isQuotaLockHeldForTesting(identity.key), true);

    // Stale/failed Operation A attempts to release -> MUST be rejected (no-op) and lock B stays held
    assert.equal(lockA.release(), false);
    assert.equal(isQuotaLockHeldForTesting(identity.key), true);

    // Lock B releases its own active lock cleanly
    assert.equal(lockB.release(), true);
    assert.equal(isQuotaLockHeldForTesting(identity.key), false);

    // 2. Waiter times out cleanly with UPLOAD_LOCK_TIMEOUT when active lock exceeds waiter's timeout
    const holder = await acquireQuotaLock(identity.key, 500);
    await assert.rejects(
      async () => {
        await acquireQuotaLock(identity.key, 40);
      },
      (err: any) => err?.code === 'UPLOAD_LOCK_TIMEOUT'
    );
    assert.equal(isQuotaLockHeldForTesting(identity.key), true);
    assert.equal(holder.release(), true);
    assert.equal(isQuotaLockHeldForTesting(identity.key), false);

    // 3. Hanging Firestore transaction aborts cleanly within lockTimeoutMs and releases lock for subsequent callers
    const hangingDb = {
      collection() {
        return { doc: () => ({ id: 'doc', path: 'uploadQuotas/doc' }) };
      },
      runTransaction() {
        return new Promise(() => {}); // Never settles
      }
    };
    setFirestoreForTesting(hangingDb);
    setLockTimeoutMsForTesting(50);

    const started = Date.now();
    await assert.rejects(
      async () => {
        await reserveUploadSlot(identity);
      },
      (err: any) => err?.code === 'FIRESTORE_TIMEOUT'
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1000, `Expected bounded timeout failure, took ${elapsed}ms`);
    assert.equal(isQuotaLockHeldForTesting(identity.key), false, 'Lock must be released after Firestore timeout');
    assert.equal(getActiveQuotaLockCountForTesting(), 0);

    // 4. Subsequent quota operations succeed normally once Firestore recovers
    resetFirestoreForTesting();
    const res = await reserveUploadSlot(identity);
    assert.equal(res.allowed, true);
    if (res.allowed) {
      const committed = await commitUploadSlot(res.reservation);
      assert.equal(committed.committed, 1);
      assert.equal(committed.remaining, 4);

      const second = await reserveUploadSlot(identity);
      assert.equal(second.allowed, true);
      if (second.allowed) {
        const afterRelease = await releaseUploadSlot(second.reservation);
        assert.equal(afterRelease.committed, 1);
        assert.equal(afterRelease.remaining, 4);
      }
    }
    const status = await getQuotaStatus(identity);
    assert.equal(status.committed, 1);
    assert.equal(status.remaining, 4);
    assert.equal(getActiveQuotaLockCountForTesting(), 0);
  } finally {
    await resetQuotaForTesting();
    resetFirestoreForTesting();
  }
});

// ============================================================================
// ORVIX-LOW-05: Wildcard Dependency Version & SpeechRecognition Type Compatibility
// ============================================================================

test('ORVIX-LOW-05: package.json contains zero wildcard dependency versions, bun.lock stays consistent, and SpeechRecognition types exist', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const bunLockRaw = fs.readFileSync(path.join(REPO_ROOT, 'bun.lock'), 'utf8');
  assert.equal(fs.existsSync(path.join(REPO_ROOT, 'package-lock.json')), false);

  const checkSection = (sectionName: string, record: Record<string, any> | undefined) => {
    if (!record) return;
    for (const [dep, spec] of Object.entries(record)) {
      if (typeof spec === 'string') {
        assert.notEqual(spec.trim(), '*', `${sectionName}.${dep} must not use "*" wildcard version`);
        assert.notEqual(spec.trim().toLowerCase(), 'latest', `${sectionName}.${dep} must not use "latest"`);
      }
    }
  };

  checkSection('dependencies', pkg.dependencies);
  checkSection('devDependencies', pkg.devDependencies);
  checkSection('overrides', pkg.overrides);

  // Confirm @types/dom-speech-recognition is not declared with a wildcard anywhere
  assert.notEqual(pkg.dependencies?.['@types/dom-speech-recognition'], '*');
  assert.notEqual(pkg.devDependencies?.['@types/dom-speech-recognition'], '*');

  // Confirm TypeScript DOM lib includes SpeechRecognition types used by voice dictation JSDoc/code
  const domLibCandidates = [
    path.join(REPO_ROOT, 'node_modules', '@typescript', 'typescript-linux-x64', 'lib', 'lib.dom.d.ts'),
    path.join(REPO_ROOT, 'node_modules', 'typescript', 'lib', 'lib.dom.d.ts')
  ];
  const domLibPath = domLibCandidates.find((p) => fs.existsSync(p));
  assert.ok(domLibPath, 'TypeScript lib.dom.d.ts must exist');
  const domLib = fs.readFileSync(domLibPath!, 'utf8');
  assert.match(domLib, /interface SpeechRecognitionResult/);
  assert.match(domLib, /interface SpeechRecognitionEvent/);
  assert.match(domLib, /interface SpeechRecognitionErrorEvent/);
  assert.ok(bunLockRaw.includes('"lockfileVersion": 3'));
});
